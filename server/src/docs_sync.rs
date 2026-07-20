//! Binary doc-sync WebSocket: `GET /api/v1/docs/{id}/sync?token=<jwt>`.
//!
//! Frame layout: first byte = type, remaining bytes = payload.
//!   0x00 update            (both)          Yjs v1 update
//!   0x01 awareness         (both)          y-protocols awareness bytes
//!   0x02 init state        (server->client) merged state as one v1 update
//!   0x03 server state vec  (server->client) yrs state vector (v1)
//!   0x04 role              (server->client) 1 byte: 0 = viewer, 1 = editor/owner
//!
//! Rooms are per-replica: live relay is in-process; every update also persists
//! to `doc_updates`, so replicas converge on reopen.

use crate::error::{AppError, AppResult};
use crate::routes::docs::{
    broadcast_doc_event, fetch_all_overrides, fetch_raw_doc, sync_decision, sync_decision_for,
    SyncDecision,
};
use crate::routes::channel_member_roles;
use crate::state::SharedState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::Sender;
use uuid::Uuid;
use yrs::merge_updates_v1;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

const FRAME_UPDATE: u8 = 0x00;
const FRAME_AWARENESS: u8 = 0x01;
const FRAME_INIT_STATE: u8 = 0x02;
const FRAME_STATE_VECTOR: u8 = 0x03;
const FRAME_ROLE: u8 = 0x04;

/// Maximum accepted size of a single update payload (bytes after the type byte).
const MAX_UPDATE_BYTES: usize = 512 * 1024;
/// Maximum accepted size of a single awareness payload; larger frames are dropped.
const MAX_AWARENESS_BYTES: usize = 64 * 1024;
/// Update-log length past which a room is compacted lazily on open.
const COMPACT_THRESHOLD: i64 = 200;
/// Persisted-update count within an open room that triggers a background compaction.
const MID_SESSION_COMPACT_THRESHOLD: u32 = 200;
/// Bound on a connection's outbound queue; a consumer that overflows it is evicted.
const SEND_QUEUE_CAP: usize = 1024;

/// The Yjs fragment name shared with the BlockNote client.
const FRAGMENT: &str = "blocknote";

// ---- room registry ----

pub struct RoomConn {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    /// Shared read-only flag: true for viewers and for connections to trashed docs.
    /// The socket loop reads it per update frame, and `refresh_room_access` updates it
    /// in place so access changes take effect without a reconnect.
    pub read_only: Arc<AtomicBool>,
    pub tx: Sender<Message>,
    /// This connection's last awareness frame, replayed to new joiners.
    pub last_awareness: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Room {
    pub conns: HashMap<Uuid, RoomConn>,
    /// Persisted updates since the last compaction; drives mid-session compaction.
    pub updates_since_compact: u32,
}

pub type DocRooms = Mutex<HashMap<Uuid, Room>>;

fn room_exists(state: &SharedState, doc_id: Uuid) -> bool {
    state.doc_rooms.lock().unwrap().contains_key(&doc_id)
}

/// Register a connection in a room, returning any cached awareness frames to replay.
fn join_room(state: &SharedState, doc_id: Uuid, conn: RoomConn) -> Vec<Vec<u8>> {
    let mut guard = state.doc_rooms.lock().unwrap();
    let room = guard.entry(doc_id).or_default();
    let frames: Vec<Vec<u8>> = room
        .conns
        .values()
        .filter_map(|c| c.last_awareness.clone())
        .collect();
    room.conns.insert(conn.conn_id, conn);
    frames
}

/// Remove a connection; returns true if the room is now empty (and was dropped).
fn leave_room(state: &SharedState, doc_id: Uuid, conn_id: Uuid) -> bool {
    let mut guard = state.doc_rooms.lock().unwrap();
    if let Some(room) = guard.get_mut(&doc_id) {
        room.conns.remove(&conn_id);
        if room.conns.is_empty() {
            guard.remove(&doc_id);
            return true;
        }
    }
    false
}

/// True while the connection is still registered in its room. A cheap lock the read
/// loop checks per frame so an evicted / revoked connection stops itself.
fn conn_in_room(state: &SharedState, doc_id: Uuid, conn_id: Uuid) -> bool {
    let guard = state.doc_rooms.lock().unwrap();
    guard
        .get(&doc_id)
        .is_some_and(|room| room.conns.contains_key(&conn_id))
}

/// Count a persisted update against the room; returns true (and resets the counter)
/// when the mid-session compaction threshold is reached.
fn bump_and_check_compact(state: &SharedState, doc_id: Uuid) -> bool {
    let mut guard = state.doc_rooms.lock().unwrap();
    if let Some(room) = guard.get_mut(&doc_id) {
        room.updates_since_compact = room.updates_since_compact.saturating_add(1);
        if room.updates_since_compact >= MID_SESSION_COMPACT_THRESHOLD {
            room.updates_since_compact = 0;
            return true;
        }
    }
    false
}

/// Relay a frame to every connection in the room except the sender. For awareness
/// frames the sender's cached frame is updated first. A connection whose bounded queue
/// is full (or closed) is treated as a dead consumer and evicted from the room.
fn relay_frame(state: &SharedState, doc_id: Uuid, sender: Uuid, ty: u8, payload: &[u8]) {
    let mut guard = state.doc_rooms.lock().unwrap();
    if let Some(room) = guard.get_mut(&doc_id) {
        if ty == FRAME_AWARENESS {
            if let Some(conn) = room.conns.get_mut(&sender) {
                conn.last_awareness = Some(payload.to_vec());
            }
        }
        let frame = build_frame(ty, payload);
        let mut dead: Vec<Uuid> = Vec::new();
        for (cid, conn) in room.conns.iter() {
            if *cid != sender && conn.tx.try_send(Message::Binary(frame.clone())).is_err() {
                dead.push(*cid);
            }
        }
        for cid in dead {
            room.conns.remove(&cid);
        }
        if room.conns.is_empty() {
            guard.remove(&doc_id);
        }
    }
}

fn build_frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 1);
    v.push(ty);
    v.extend_from_slice(payload);
    v
}

/// Close every connection in a room and drop it. Used when the doc no longer exists.
/// Each socket's own read loop then ends and runs its normal leave/cleanup path.
fn close_room(state: &SharedState, doc_id: Uuid) {
    let mut guard = state.doc_rooms.lock().unwrap();
    if let Some(room) = guard.remove(&doc_id) {
        for conn in room.conns.values() {
            let _ = conn.tx.try_send(Message::Close(None));
        }
    }
}

/// Re-evaluate every open connection's access after an access change (role/everyone_role
/// change, trash, restore, permanent delete). Connections that lost access are sent a
/// `Close` and removed from the room immediately (so they receive no further relays);
/// the rest get a fresh `0x04` role frame and their shared read-only flag updated. If the
/// doc no longer exists the whole room is closed and dropped.
///
/// Sockets closed here still run their normal leave/compaction path: sending `Close`
/// makes the client disconnect, ending the read loop, which aborts the writer task.
pub async fn refresh_room_access(state: &SharedState, doc_id: Uuid) {
    // Snapshot connected (conn_id, user_id) pairs; bail if no room is open.
    let conns: Vec<(Uuid, Uuid)> = {
        let guard = state.doc_rooms.lock().unwrap();
        match guard.get(&doc_id) {
            Some(room) => room.conns.values().map(|c| (c.conn_id, c.user_id)).collect(),
            None => return,
        }
    };
    if conns.is_empty() {
        return;
    }

    // Doc gone → close and drop the whole room.
    let raw = match fetch_raw_doc(&state.pool, doc_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            close_room(state, doc_id);
            return;
        }
        Err(e) => {
            tracing::warn!("doc {} access refresh: fetch failed: {}", doc_id, e);
            return;
        }
    };
    let member_roles = match channel_member_roles(&state.pool, raw.channel_id).await {
        Ok(roles) => roles,
        Err(e) => {
            tracing::warn!("doc {} access refresh: members failed: {}", doc_id, e);
            return;
        }
    };
    let overrides = match fetch_all_overrides(&state.pool, doc_id).await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("doc {} access refresh: overrides failed: {}", doc_id, e);
            return;
        }
    };

    // Apply the decisions under one lock (no awaits inside).
    let mut guard = state.doc_rooms.lock().unwrap();
    let room = match guard.get_mut(&doc_id) {
        Some(r) => r,
        None => return,
    };
    let mut dropped: Vec<Uuid> = Vec::new();
    for (conn_id, user_id) in conns {
        let conn = match room.conns.get(&conn_id) {
            Some(c) => c,
            None => continue, // left meanwhile
        };
        match sync_decision_for(
            &raw,
            member_roles.get(&user_id).copied(),
            overrides.get(&user_id).map(|s| s.as_str()),
            user_id,
        ) {
            SyncDecision::Ok { read_only } => {
                conn.read_only.store(read_only, Ordering::Relaxed);
                let role_byte = if read_only { 0u8 } else { 1u8 };
                let _ = conn.tx.try_send(Message::Binary(vec![FRAME_ROLE, role_byte]));
            }
            SyncDecision::NotFound | SyncDecision::Forbidden => {
                let _ = conn.tx.try_send(Message::Close(None));
                dropped.push(conn_id);
            }
        }
    }
    for cid in dropped {
        room.conns.remove(&cid);
    }
    if room.conns.is_empty() {
        guard.remove(&doc_id);
    }
}

/// Re-evaluate every open doc room belonging to a channel after channel membership or
/// role changes.
pub async fn refresh_channel_rooms(state: &SharedState, channel_id: Uuid) {
    let open_doc_ids: Vec<Uuid> = {
        let guard = state.doc_rooms.lock().unwrap();
        guard.keys().copied().collect()
    };
    if open_doc_ids.is_empty() {
        return;
    }

    let rows = match sqlx::query("SELECT id FROM docs WHERE channel_id = $1 AND id = ANY($2)")
        .bind(channel_id)
        .bind(open_doc_ids)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                "channel {} doc-room refresh lookup failed: {}",
                channel_id,
                error
            );
            return;
        }
    };

    for row in rows {
        match row.try_get::<Uuid, _>("id") {
            Ok(doc_id) => refresh_room_access(state, doc_id).await,
            Err(error) => tracing::warn!(
                "channel {} doc-room refresh row failed: {}",
                channel_id,
                error
            ),
        }
    }
}

// ---- yrs helpers ----

fn apply_blobs(doc: &Doc, blobs: &[Vec<u8>]) {
    let mut txn = doc.transact_mut();
    match merge_updates_v1(blobs.iter().map(|b| b.as_slice())) {
        Ok(merged) => {
            if let Ok(update) = Update::decode_v1(&merged) {
                let _ = txn.apply_update(update);
            }
        }
        Err(_) => {
            // A row failed to decode: apply each individually, skipping bad ones.
            for b in blobs {
                if let Ok(update) = Update::decode_v1(b) {
                    let _ = txn.apply_update(update);
                }
            }
        }
    }
}

/// Merged full-state update + its state vector, both v1-encoded. The yrs work is
/// CPU-bound, so it runs on the blocking pool to keep the async runtime responsive.
async fn build_state(blobs: Vec<Vec<u8>>) -> AppResult<(Vec<u8>, Vec<u8>)> {
    tokio::task::spawn_blocking(move || {
        let doc = Doc::new();
        apply_blobs(&doc, &blobs);
        let txn = doc.transact();
        let merged = txn.encode_state_as_update_v1(&StateVector::default());
        let sv = txn.state_vector().encode_v1();
        (merged, sv)
    })
    .await
    .map_err(|e| AppError::Internal(format!("build_state join error: {}", e)))
}

/// Merge the update log into a single v1 update, WITHOUT any content extraction.
/// Used to compact a canvas doc, whose Yjs store is a tldraw store (a `Y.Map`), not
/// a blocknote XML fragment — so there is no plain text / doc-links to extract.
async fn merge_state(blobs: Vec<Vec<u8>>) -> AppResult<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        let doc = Doc::new();
        apply_blobs(&doc, &blobs);
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    })
    .await
    .map_err(|e| AppError::Internal(format!("merge_state join error: {}", e)))
}

/// Merged full-state update, extracted plain text and doc-link targets. Runs on the
/// blocking pool for the same reason as [`build_state`].
async fn compact_state(blobs: Vec<Vec<u8>>) -> AppResult<(Vec<u8>, String, Vec<Uuid>)> {
    tokio::task::spawn_blocking(move || {
        let doc = Doc::new();
        apply_blobs(&doc, &blobs);
        let fragment = doc.get_or_insert_xml_fragment(FRAGMENT);
        let txn = doc.transact();
        let merged = txn.encode_state_as_update_v1(&StateVector::default());
        let xml = fragment.get_string(&txn);
        drop(txn);
        (merged, xml_to_text(&xml), extract_doc_links(&xml))
    })
    .await
    .map_err(|e| AppError::Internal(format!("compact_state join error: {}", e)))
}

/// Strip XML tags and decode basic entities into search/preview text.
fn xml_to_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut in_tag = false;
    for c in xml.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract `docId` attribute values from `<doclink ...>` elements in the XML string.
fn extract_doc_links(xml: &str) -> Vec<Uuid> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(pos) = rest.find("<doclink") {
        let after = &rest[pos..];
        let tag_end = after.find('>').map(|e| e + 1).unwrap_or(after.len());
        let tag = &after[..tag_end];
        if let Some(id) = attr_value(tag, "docId") {
            if let Ok(u) = Uuid::parse_str(&id) {
                if !out.contains(&u) {
                    out.push(u);
                }
            }
        }
        rest = &after[tag_end..];
    }
    out
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{}=\"", name);
    let start = tag.find(&needle)? + needle.len();
    let value = &tag[start..];
    let end = value.find('"')?;
    Some(value[..end].to_string())
}

// ---- persistence ----

async fn fetch_update_blobs(pool: &PgPool, doc_id: Uuid) -> AppResult<Vec<Vec<u8>>> {
    let rows = sqlx::query("SELECT data FROM doc_updates WHERE doc_id = $1 ORDER BY id")
        .bind(doc_id)
        .fetch_all(pool)
        .await?;
    let mut blobs = Vec::with_capacity(rows.len());
    for r in &rows {
        blobs.push(r.try_get::<Vec<u8>, _>("data")?);
    }
    Ok(blobs)
}

async fn update_count(pool: &PgPool, doc_id: Uuid) -> AppResult<i64> {
    let row = sqlx::query("SELECT count(*) AS c FROM doc_updates WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>("c")?)
}

async fn persist_update(pool: &PgPool, doc_id: Uuid, data: &[u8]) -> AppResult<()> {
    sqlx::query("INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)")
        .bind(doc_id)
        .bind(data)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE docs SET updated_at = now() WHERE id = $1")
        .bind(doc_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Merge the update log into a single row and refresh content_text + doc_links.
/// Only the fetched row ids are deleted, so updates inserted concurrently survive.
/// If every fetched row is already `compacted` there is nothing new to merge: returns
/// `Ok(false)` without touching the DB, so mere open/close does no work and cannot
/// reorder doc lists (persist_update, not compaction, owns the `updated_at` bump).
/// Returns true only when a fresh compaction was written.
async fn compact_doc(state: &SharedState, doc_id: Uuid) -> AppResult<bool> {
    let rows =
        sqlx::query("SELECT id, data, compacted FROM doc_updates WHERE doc_id = $1 ORDER BY id")
            .bind(doc_id)
            .fetch_all(&state.pool)
            .await?;
    if rows.is_empty() {
        return Ok(false);
    }

    let mut ids = Vec::with_capacity(rows.len());
    let mut blobs = Vec::with_capacity(rows.len());
    let mut has_uncompacted = false;
    for r in &rows {
        ids.push(r.try_get::<i64, _>("id")?);
        blobs.push(r.try_get::<Vec<u8>, _>("data")?);
        if !r.try_get::<bool, _>("compacted")? {
            has_uncompacted = true;
        }
    }
    if !has_uncompacted {
        return Ok(false);
    }

    // Canvas and board docs store non-blocknote Yjs state (a tldraw / kanban Y.Map),
    // so merge the update log but skip content_text / doc_link extraction (blocknote-only).
    let skip_extraction = sqlx::query("SELECT kind FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?
        .map(|r| r.try_get::<String, _>("kind"))
        .transpose()?
        .map(|k| k == "canvas" || k == "board")
        .unwrap_or(false);

    let (merged, extracted) = if skip_extraction {
        (merge_state(blobs).await?, None)
    } else {
        let (merged, text, links) = compact_state(blobs).await?;
        let valid_links = filter_existing_docs(&state.pool, &links).await?;
        (merged, Some((text, valid_links)))
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM doc_updates WHERE id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO doc_updates (doc_id, data, compacted) VALUES ($1, $2, true)")
        .bind(doc_id)
        .bind(merged.as_slice())
        .execute(&mut *tx)
        .await?;
    if let Some((text, valid_links)) = extracted {
        sqlx::query("UPDATE docs SET content_text = $1 WHERE id = $2")
            .bind(&text)
            .bind(doc_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM doc_links WHERE doc_id = $1")
            .bind(doc_id)
            .execute(&mut *tx)
            .await?;
        for target in valid_links {
            sqlx::query(
                "INSERT INTO doc_links (doc_id, target_doc_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(doc_id)
            .bind(target)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;

    Ok(true)
}

async fn filter_existing_docs(pool: &PgPool, links: &[Uuid]) -> AppResult<Vec<Uuid>> {
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query("SELECT id FROM docs WHERE id = ANY($1)")
        .bind(links.to_vec())
        .fetch_all(pool)
        .await?;
    let mut existing = Vec::with_capacity(rows.len());
    for r in &rows {
        existing.push(r.try_get::<Uuid, _>("id")?);
    }
    Ok(existing)
}

// ---- handler ----

#[derive(Deserialize)]
pub struct SyncQuery {
    pub token: String,
}

pub async fn doc_sync_handler(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    Query(params): Query<SyncQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let user_id = match crate::auth::verify_token(&params.token, &state.config.jwt_secret) {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    match sync_decision(&state.pool, doc_id, user_id).await {
        Ok(SyncDecision::Ok { read_only }) => {
            ws.on_upgrade(move |socket| handle_doc_socket(socket, state, doc_id, user_id, read_only))
        }
        Ok(SyncDecision::Forbidden) => (StatusCode::FORBIDDEN, "no access to this doc").into_response(),
        Ok(SyncDecision::NotFound) => (StatusCode::NOT_FOUND, "doc not found").into_response(),
        Err(e) => e.into_response(),
    }
}

async fn handle_doc_socket(
    socket: WebSocket,
    state: SharedState,
    doc_id: Uuid,
    user_id: Uuid,
    read_only: bool,
) {
    let conn_id = Uuid::new_v4();
    // Bounded queue: a consumer that can't keep up is evicted rather than buffered
    // without limit (see relay_frame). Shared read-only flag lets live access changes
    // flip this connection without a reconnect.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(SEND_QUEUE_CAP);
    let read_only = Arc::new(AtomicBool::new(read_only));
    let (mut sink, mut stream) = socket.split();

    // Writer task: drain queued frames to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Lazily compact an over-long update log when a room first opens.
    if !room_exists(&state, doc_id) {
        match update_count(&state.pool, doc_id).await {
            Ok(count) if count > COMPACT_THRESHOLD => match compact_doc(&state, doc_id).await {
                Ok(true) => {
                    let _ = broadcast_doc_event(&state, doc_id, "doc.updated").await;
                }
                Ok(false) => {}
                Err(e) => tracing::warn!("doc {} lazy compaction failed: {}", doc_id, e),
            },
            Ok(_) => {}
            Err(e) => tracing::warn!("doc {} update count failed: {}", doc_id, e),
        }
    }

    // Register first so any concurrent updates are relayed to us; init state below is
    // idempotent when applied alongside relayed updates (Yjs updates commute).
    let awareness_frames = join_room(
        &state,
        doc_id,
        RoomConn {
            conn_id,
            user_id,
            read_only: read_only.clone(),
            tx: tx.clone(),
            last_awareness: None,
        },
    );

    // Handshake sends use try_send: capacity is ample here, so a failure means the
    // consumer is already gone — log and let the read loop end naturally.
    let handshake = |tx: &Sender<Message>, msg: Message| {
        if tx.try_send(msg).is_err() {
            tracing::warn!("doc {} handshake send failed", doc_id);
        }
    };

    // Role frame.
    let role_byte = if read_only.load(Ordering::Relaxed) { 0u8 } else { 1u8 };
    handshake(&tx, Message::Binary(vec![FRAME_ROLE, role_byte]));

    // Init state + server state vector.
    match fetch_update_blobs(&state.pool, doc_id).await {
        Ok(blobs) => match build_state(blobs).await {
            Ok((merged, sv)) => {
                handshake(&tx, Message::Binary(build_frame(FRAME_INIT_STATE, &merged)));
                handshake(&tx, Message::Binary(build_frame(FRAME_STATE_VECTOR, &sv)));
            }
            Err(e) => tracing::warn!("doc {} build state failed: {}", doc_id, e),
        },
        Err(e) => tracing::warn!("doc {} init state failed: {}", doc_id, e),
    }

    // Replay peers' cached awareness so the new joiner sees existing cursors.
    for aw in awareness_frames {
        handshake(&tx, Message::Binary(build_frame(FRAME_AWARENESS, &aw)));
    }

    // Read loop.
    while let Some(Ok(msg)) = stream.next().await {
        // If we were evicted (slow consumer) or lost access (refresh_room_access),
        // stop: our Close is already queued and further frames must not be processed.
        if !conn_in_room(&state, doc_id, conn_id) {
            break;
        }
        match msg {
            Message::Binary(data) => {
                if data.is_empty() {
                    continue;
                }
                let ty = data[0];
                let payload = &data[1..];
                match ty {
                    FRAME_UPDATE => {
                        if read_only.load(Ordering::Relaxed) {
                            continue; // viewer / trashed: drop silently
                        }
                        if payload.len() > MAX_UPDATE_BYTES {
                            break; // oversized frame: close the socket
                        }
                        if let Err(e) = persist_update(&state.pool, doc_id, payload).await {
                            // Don't relay an update we failed to persist: close so the
                            // client reconnects and resyncs from the persisted state.
                            tracing::warn!("doc {} persist failed, closing socket: {}", doc_id, e);
                            break;
                        }
                        relay_frame(&state, doc_id, conn_id, FRAME_UPDATE, payload);
                        // Mid-session compaction so a long-lived room's log stays bounded.
                        if bump_and_check_compact(&state, doc_id) {
                            let st = state.clone();
                            tokio::spawn(async move {
                                match compact_doc(&st, doc_id).await {
                                    Ok(true) => {
                                        let _ = broadcast_doc_event(&st, doc_id, "doc.updated").await;
                                    }
                                    Ok(false) => {}
                                    Err(e) => tracing::warn!(
                                        "doc {} mid-session compaction failed: {}",
                                        doc_id,
                                        e
                                    ),
                                }
                            });
                        }
                    }
                    FRAME_AWARENESS => {
                        if payload.len() > MAX_AWARENESS_BYTES {
                            continue; // oversized awareness: silently drop
                        }
                        relay_frame(&state, doc_id, conn_id, FRAME_AWARENESS, payload);
                    }
                    _ => {}
                }
            }
            Message::Ping(p) => {
                let _ = tx.try_send(Message::Pong(p));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup: compact when the last connection leaves the room.
    let empty = leave_room(&state, doc_id, conn_id);
    if empty {
        match compact_doc(&state, doc_id).await {
            Ok(true) => {
                let _ = broadcast_doc_event(&state, doc_id, "doc.updated").await;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("doc {} compaction failed: {}", doc_id, e),
        }
    }
    writer.abort();
}
