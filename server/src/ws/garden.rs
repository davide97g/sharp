//! Garden presence and movement on the main WebSocket.
//!
//! The hub is a public scene. Channel interiors are separate scenes whose
//! audience is the channel membership. Private channel metadata never enters a
//! non-member payload.

use crate::routes::{channel_kind, is_member};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope, WsSender};
use axum::extract::ws::Message;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

pub const HUB_SPAWN_X: f64 = 52.0;
pub const HUB_SPAWN_Y: f64 = 64.0;
pub const TEMPLE_X: f64 = 52.0;
pub const TEMPLE_Y: f64 = 84.0;
const HUB_MIN_X: f64 = 2.0;
pub const HUB_MAX_X: f64 = 102.0;
const HUB_MIN_Y: f64 = 2.0;
// Four plots per row; vertical headroom lets the village grow with channels.
pub const HUB_MAX_Y: f64 = 398.0;
const ROOM_MIN_X: f64 = 2.0;
const ROOM_MAX_X: f64 = 30.0;
const ROOM_MIN_Y: f64 = 2.0;
const ROOM_MAX_Y: f64 = 22.0;
const ROOM_SPAWN_X: f64 = 16.0;
const ROOM_SPAWN_Y: f64 = 19.0;
const MAX_SPEED_TILES_PER_SECOND: f64 = 8.0;
const MOVE_SLACK: f64 = 1.5;

/// Character sheets a client may choose. Validated here so an arbitrary string
/// never reaches another client's texture lookup — the same contract as
/// `AURA_STYLES` in `ws::voice`. Mirrored by `AVATAR_IDS` in
/// `web/src/components/garden/gardenAvatars.ts`; keep the two in lockstep.
pub const GARDEN_AVATARS: [&str; 12] = [
    "samurai",
    "scout",
    "ninja",
    "monk",
    "knight",
    "hunter",
    "royal",
    "noble",
    "explorer",
    "villager",
    "florist",
    "mage",
];

/// Highlight-colour slots. The client owns the actual colours
/// (`web/src/lib/gardenColors.ts`); the server only hands out an index, so the
/// palette stays a single token-backed list in one language.
pub const GARDEN_COLOR_COUNT: u8 = 10;

pub fn is_garden_avatar(value: &str) -> bool {
    GARDEN_AVATARS.contains(&value)
}

/// Highlight colour for a joining peer.
///
/// Keyed by `user_id`, not `conn_id`: two tabs are two peers but one person, and
/// they must not wear different colours. Otherwise take the lowest slot nobody
/// holds, so a slot freed by someone leaving is reused rather than the palette
/// drifting upward forever. Past ten concurrent people the slot wraps
/// deterministically from the user id, so collisions are stable rather than
/// flickering. Index 0 is the product accent (purple), so the first person in
/// always looks "default".
fn assign_color_index(peers: &HashMap<Uuid, GardenPeer>, user_id: Uuid) -> u8 {
    if let Some(existing) = peers.values().find(|peer| peer.user_id == user_id) {
        return existing.color_index;
    }
    let used: std::collections::HashSet<u8> =
        peers.values().map(|peer| peer.color_index).collect();
    if let Some(free) = (0..GARDEN_COLOR_COUNT).find(|slot| !used.contains(slot)) {
        return free;
    }
    let hash = user_id
        .as_bytes()
        .iter()
        .fold(0usize, |acc, byte| acc.wrapping_add(*byte as usize));
    (hash % GARDEN_COLOR_COUNT as usize) as u8
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GardenSpace {
    Hub,
    Room(Uuid),
}

#[derive(Clone, Debug, Serialize)]
pub struct GardenPeer {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    pub display_name: String,
    pub space: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,
    pub x: f64,
    pub y: f64,
    pub facing: String,
    pub moving: bool,
    pub zen_mode: bool,
    pub seq: u64,
    /// Chosen character, or `None` when this person never picked one — the client
    /// then falls back deterministically from `user_id`.
    pub avatar: Option<String>,
    /// Join-order highlight slot. Ephemeral, like the rest of this struct.
    pub color_index: u8,
    #[serde(skip)]
    pub last_move_at: Instant,
}

impl GardenPeer {
    fn new(
        conn_id: Uuid,
        user_id: Uuid,
        display_name: &str,
        avatar: Option<String>,
        color_index: u8,
    ) -> Self {
        Self {
            conn_id,
            user_id,
            display_name: display_name.to_string(),
            space: "hub",
            channel_id: None,
            x: HUB_SPAWN_X,
            y: HUB_SPAWN_Y,
            facing: "down".to_string(),
            moving: false,
            zen_mode: false,
            seq: 0,
            avatar,
            color_index,
            last_move_at: Instant::now(),
        }
    }

    fn garden_space(&self) -> GardenSpace {
        self.channel_id
            .map(GardenSpace::Room)
            .unwrap_or(GardenSpace::Hub)
    }

    fn set_space(&mut self, space: GardenSpace, x: f64, y: f64) {
        match space {
            GardenSpace::Hub => {
                self.space = "hub";
                self.channel_id = None;
            }
            GardenSpace::Room(channel_id) => {
                self.space = "room";
                self.channel_id = Some(channel_id);
            }
        }
        self.x = x;
        self.y = y;
        self.moving = false;
        self.zen_mode = false;
        self.last_move_at = Instant::now();
    }
}

#[derive(Default)]
pub struct GardenState {
    peers: Mutex<HashMap<Uuid, GardenPeer>>,
}

impl GardenState {
    pub fn occupancy(&self) -> HashMap<Uuid, usize> {
        let guard = self.peers.lock().unwrap();
        let mut counts = HashMap::new();
        for peer in guard.values() {
            if let Some(channel_id) = peer.channel_id {
                *counts.entry(channel_id).or_insert(0) += 1;
            }
        }
        counts
    }
}

fn send(tx: &WsSender, event_type: &str, payload: Value) {
    let _ = tx.send(Message::Text(envelope(event_type, payload).to_string()));
}

async fn targets_for_space(state: &SharedState, space: &GardenSpace) -> Vec<Uuid> {
    match space {
        GardenSpace::Hub => state.hub.online_user_ids(),
        GardenSpace::Room(channel_id) => channel_member_ids(&state.pool, *channel_id)
            .await
            .unwrap_or_default(),
    }
}

async fn broadcast_left(state: &SharedState, peer: &GardenPeer, space: &GardenSpace) {
    let targets = targets_for_space(state, space).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_left",
                json!({ "conn_id": peer.conn_id.to_string() }),
            ),
            targets,
        )
        .await;
}

async fn broadcast_joined(state: &SharedState, peer: &GardenPeer) {
    let targets = targets_for_space(state, &peer.garden_space()).await;
    state
        .hub
        .broadcast(
            envelope("garden.peer_joined", json!({ "peer": peer })),
            targets,
        )
        .await;
}

async fn peers_visible_to(
    state: &SharedState,
    user_id: Uuid,
    space: &GardenSpace,
) -> Vec<GardenPeer> {
    if let GardenSpace::Room(channel_id) = space {
        if !is_member(&state.pool, *channel_id, user_id)
            .await
            .unwrap_or(false)
        {
            return Vec::new();
        }
    }
    let guard = state.garden.peers.lock().unwrap();
    guard
        .values()
        .filter(|peer| &peer.garden_space() == space)
        .cloned()
        .collect()
}

pub async fn handle_event(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    event_type: &str,
    payload: Value,
    tx: &WsSender,
) {
    // Everything except entering the Garden needs a registered peer for this
    // connection. Without one these handlers used to `return` silently, so a lost
    // `garden.enter` left a client whose map and prompts looked fine but whose
    // every doorway press did nothing. Answer instead, and let the client
    // re-announce itself. `garden.move` is excluded: it arrives many times a
    // second, and re-registering repairs it anyway.
    if !matches!(event_type, "garden.enter" | "garden.leave" | "garden.move")
        && !state.garden.peers.lock().unwrap().contains_key(&conn_id)
    {
        send(tx, "garden.error", json!({ "code": "no_peer" }));
        return;
    }
    match event_type {
        "garden.enter" => handle_enter(state, user_id, conn_id, display_name, tx).await,
        "garden.leave" => cleanup_conn(state, conn_id).await,
        "garden.move" => handle_move(state, conn_id, &payload, tx).await,
        "garden.room_enter" => handle_room_enter(state, user_id, conn_id, &payload, tx).await,
        "garden.room_teleport" => handle_room_teleport(state, user_id, conn_id, &payload, tx).await,
        "garden.temple_teleport" => handle_temple_teleport(state, conn_id, tx).await,
        "garden.room_exit" => handle_room_exit(state, conn_id, tx).await,
        "garden.zen" => handle_zen(state, conn_id, &payload, tx).await,
        "garden.avatar" => handle_avatar(state, user_id, &payload, tx).await,
        _ => {}
    }
}

async fn handle_enter(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    tx: &WsSender,
) {
    // Resolve the stored choice before locking: the mutex must never be held
    // across an await. One PK lookup, once per Garden entry.
    let avatar = load_garden_avatar(state, user_id).await;
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        match guard.get(&conn_id) {
            // Resume: this connection is already in Garden, so keep its position
            // and its colour.
            Some(existing) => existing.clone(),
            None => {
                let color_index = assign_color_index(&guard, user_id);
                let peer =
                    GardenPeer::new(conn_id, user_id, display_name, avatar, color_index);
                guard.insert(conn_id, peer.clone());
                peer
            }
        }
    };
    let peers = peers_visible_to(state, user_id, &peer.garden_space()).await;
    send(tx, "garden.state", json!({ "self": peer, "peers": peers }));
    broadcast_joined(state, &peer).await;
}

/// Stored character choice, or `None` when unset or no longer in the roster.
/// Tolerating an unknown value on read is what lets a sheet be removed without
/// stranding rows.
async fn load_garden_avatar(state: &SharedState, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("SELECT garden_avatar FROM user_prefs WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()??;
    let stored: Option<String> = row.try_get("garden_avatar").ok()?;
    stored.filter(|value| is_garden_avatar(value))
}

#[derive(Deserialize)]
struct AvatarPayload {
    avatar: String,
}

/// Persist and publish a character choice.
///
/// Applies to every connection of this user, so a change made in one tab shows
/// up for peers watching any of them.
async fn handle_avatar(
    state: &SharedState,
    user_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Ok(body) = serde_json::from_value::<AvatarPayload>(payload.clone()) else {
        send(tx, "garden.error", json!({ "code": "bad_avatar" }));
        return;
    };
    if !is_garden_avatar(&body.avatar) {
        send(tx, "garden.error", json!({ "code": "bad_avatar" }));
        return;
    }
    let stored = sqlx::query(
        "INSERT INTO user_prefs (user_id, garden_avatar) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET garden_avatar = $2",
    )
    .bind(user_id)
    .bind(&body.avatar)
    .execute(&state.pool)
    .await;
    if stored.is_err() {
        send(tx, "garden.error", json!({ "code": "bad_avatar" }));
        return;
    }
    // Update every live peer for this user, collecting who to announce and where.
    let affected: Vec<(Uuid, GardenSpace)> = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .values_mut()
            .filter(|peer| peer.user_id == user_id)
            .map(|peer| {
                peer.avatar = Some(body.avatar.clone());
                (peer.conn_id, peer.garden_space())
            })
            .collect()
    };
    for (peer_conn_id, space) in affected {
        let targets = targets_for_space(state, &space).await;
        state
            .hub
            .broadcast(
                envelope(
                    "garden.peer_avatar",
                    json!({
                        "conn_id": peer_conn_id,
                        "user_id": user_id,
                        "avatar": body.avatar,
                    }),
                ),
                targets,
            )
            .await;
    }
}

#[derive(Deserialize)]
struct MovePayload {
    seq: u64,
    x: f64,
    y: f64,
    facing: String,
}

fn valid_facing(value: &str) -> bool {
    matches!(value, "up" | "down" | "left" | "right")
}

fn clamped_for_space(space: &GardenSpace, x: f64, y: f64) -> (f64, f64) {
    match space {
        GardenSpace::Hub => (x.clamp(HUB_MIN_X, HUB_MAX_X), y.clamp(HUB_MIN_Y, HUB_MAX_Y)),
        GardenSpace::Room(_) => (
            x.clamp(ROOM_MIN_X, ROOM_MAX_X),
            y.clamp(ROOM_MIN_Y, ROOM_MAX_Y),
        ),
    }
}

async fn handle_move(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Ok(payload) = serde_json::from_value::<MovePayload>(payload.clone()) else {
        return;
    };
    if !payload.x.is_finite() || !payload.y.is_finite() || !valid_facing(&payload.facing) {
        return;
    }
    let result = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        if payload.seq <= peer.seq {
            return;
        }
        let now = Instant::now();
        let elapsed = now
            .duration_since(peer.last_move_at)
            .as_secs_f64()
            .max(0.016);
        let allowed = MAX_SPEED_TILES_PER_SECOND * elapsed + MOVE_SLACK;
        let (x, y) = clamped_for_space(&peer.garden_space(), payload.x, payload.y);
        let distance = ((x - peer.x).powi(2) + (y - peer.y).powi(2)).sqrt();
        if distance > allowed {
            Err((peer.seq, peer.x, peer.y))
        } else {
            peer.seq = payload.seq;
            peer.x = x;
            peer.y = y;
            peer.facing = payload.facing;
            peer.moving = distance > 0.01;
            peer.last_move_at = now;
            Ok((peer.clone(), peer.garden_space()))
        }
    };
    let (peer, space) = match result {
        Ok(value) => value,
        Err((seq, x, y)) => {
            send(
                tx,
                "garden.corrected",
                json!({ "seq": seq, "x": x, "y": y }),
            );
            return;
        }
    };
    let targets = targets_for_space(state, &space).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_moved",
                json!({
                    "conn_id": peer.conn_id.to_string(),
                    "seq": peer.seq,
                    "x": peer.x,
                    "y": peer.y,
                    "facing": peer.facing,
                    "moving": peer.moving,
                }),
            ),
            targets,
        )
        .await;
    if let GardenSpace::Room(channel_id) = space {
        let room_x = ((peer.x - ROOM_MIN_X) / (ROOM_MAX_X - ROOM_MIN_X)).clamp(0.0, 1.0);
        let room_y = ((peer.y - ROOM_MIN_Y) / (ROOM_MAX_Y - ROOM_MIN_Y)).clamp(0.0, 1.0);
        crate::ws::voice::move_garden_participant(state, channel_id, conn_id, room_x, room_y).await;
    }
}

pub fn plot_door(plot_index: i32) -> (f64, f64) {
    let column = (plot_index.rem_euclid(4)) as f64;
    let row = (plot_index.div_euclid(4)) as f64;
    (14.0 + column * 24.0, 19.0 + row * 19.0)
}

async fn handle_room_enter(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = payload
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return;
    };
    let kind = channel_kind(&state.pool, channel_id).await.ok().flatten();
    if !matches!(kind.as_deref(), Some("public" | "private"))
        || !is_member(&state.pool, channel_id, user_id)
            .await
            .unwrap_or(false)
    {
        send(
            tx,
            "garden.error",
            json!({ "code": "not_member", "channel_id": channel_id }),
        );
        return;
    }
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let Some(plot_index) = plot_index else {
        return;
    };
    let old_peer = {
        let guard = state.garden.peers.lock().unwrap();
        guard.get(&conn_id).cloned()
    };
    let Some(old_peer) = old_peer else {
        return;
    };
    if old_peer.channel_id.is_some() {
        return;
    }
    let (door_x, door_y) = plot_door(plot_index);
    if ((old_peer.x - door_x).powi(2) + (old_peer.y - door_y).powi(2)).sqrt() > 4.5 {
        send(
            tx,
            "garden.error",
            json!({ "code": "not_at_door", "channel_id": channel_id }),
        );
        return;
    }
    broadcast_left(state, &old_peer, &GardenSpace::Hub).await;
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        peer.set_space(GardenSpace::Room(channel_id), ROOM_SPAWN_X, ROOM_SPAWN_Y);
        peer.clone()
    };
    send(
        tx,
        "garden.space_changed",
        json!({ "space": "room", "channel_id": channel_id, "peer": peer }),
    );
    broadcast_joined(state, &peer).await;
}

async fn handle_room_exit(state: &SharedState, conn_id: Uuid, tx: &WsSender) {
    let old_peer = {
        let guard = state.garden.peers.lock().unwrap();
        guard.get(&conn_id).cloned()
    };
    let Some(old_peer) = old_peer else {
        return;
    };
    let Some(channel_id) = old_peer.channel_id else {
        return;
    };
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
    broadcast_left(state, &old_peer, &GardenSpace::Room(channel_id)).await;
    let (door_x, door_y) = plot_door(plot_index);
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        peer.set_space(GardenSpace::Hub, door_x, door_y + 2.0);
        peer.clone()
    };
    send(
        tx,
        "garden.space_changed",
        json!({ "space": "hub", "peer": peer }),
    );
    broadcast_joined(state, &peer).await;
}

async fn handle_room_teleport(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = payload
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return;
    };
    let kind = channel_kind(&state.pool, channel_id).await.ok().flatten();
    if !matches!(kind.as_deref(), Some("public" | "private"))
        || !is_member(&state.pool, channel_id, user_id)
            .await
            .unwrap_or(false)
    {
        send(
            tx,
            "garden.error",
            json!({ "code": "not_member", "channel_id": channel_id }),
        );
        return;
    }
    let old_peer = {
        let guard = state.garden.peers.lock().unwrap();
        guard.get(&conn_id).cloned()
    };
    let Some(old_peer) = old_peer else {
        return;
    };
    let old_space = old_peer.garden_space();
    broadcast_left(state, &old_peer, &old_space).await;

    // Keep arrivals away from the wall and shared table. A server-selected spot
    // prevents clients from teleporting through scene bounds or onto furniture.
    let (arrival_x, arrival_y) = {
        let mut rng = rand::thread_rng();
        (rng.gen_range(5.0..=27.0), rng.gen_range(6.0..=20.0))
    };
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        peer.set_space(GardenSpace::Room(channel_id), arrival_x, arrival_y);
        peer.clone()
    };
    send(
        tx,
        "garden.space_changed",
        json!({ "space": "room", "channel_id": channel_id, "peer": peer }),
    );
    broadcast_joined(state, &peer).await;
}

async fn handle_temple_teleport(state: &SharedState, conn_id: Uuid, tx: &WsSender) {
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        if peer.channel_id.is_some() {
            return;
        }
        peer.x = TEMPLE_X;
        peer.y = TEMPLE_Y + 3.0;
        peer.moving = false;
        peer.zen_mode = false;
        peer.clone()
    };
    send(tx, "garden.temple_arrived", json!({ "peer": peer }));
    let targets = targets_for_space(state, &GardenSpace::Hub).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_moved",
                json!({
                    "conn_id": peer.conn_id.to_string(),
                    "seq": peer.seq,
                    "x": peer.x,
                    "y": peer.y,
                    "facing": peer.facing,
                    "moving": false,
                }),
            ),
            targets,
        )
        .await;
}

async fn handle_zen(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
        return;
    };
    let result = {
        let mut guard = state.garden.peers.lock().unwrap();
        let Some(peer) = guard.get_mut(&conn_id) else {
            return;
        };
        if enabled
            && (peer.channel_id.is_some()
                || ((peer.x - TEMPLE_X).powi(2) + (peer.y - TEMPLE_Y).powi(2)).sqrt() > 4.5)
        {
            Err(())
        } else {
            peer.zen_mode = enabled;
            peer.moving = false;
            Ok((peer.clone(), peer.garden_space()))
        }
    };
    let (peer, space) = match result {
        Ok(value) => value,
        Err(()) => {
            send(tx, "garden.error", json!({ "code": "not_at_temple" }));
            return;
        }
    };
    let targets = targets_for_space(state, &space).await;
    state
        .hub
        .broadcast(
            envelope(
                "garden.peer_zen",
                json!({
                    "conn_id": peer.conn_id.to_string(),
                    "zen_mode": peer.zen_mode,
                }),
            ),
            targets,
        )
        .await;
}

pub async fn cleanup_conn(state: &SharedState, conn_id: Uuid) {
    let peer = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard.remove(&conn_id)
    };
    if let Some(peer) = peer {
        let space = peer.garden_space();
        broadcast_left(state, &peer, &space).await;
    }
}

pub async fn remove_member_from_room(state: &SharedState, channel_id: Uuid, user_id: Uuid) {
    let peers: Vec<(GardenPeer, GardenPeer)> = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .values_mut()
            .filter(|peer| peer.user_id == user_id && peer.channel_id == Some(channel_id))
            .map(|peer| {
                let old = peer.clone();
                peer.set_space(GardenSpace::Hub, HUB_SPAWN_X, HUB_SPAWN_Y);
                (old, peer.clone())
            })
            .collect()
    };
    for (old, current) in peers {
        broadcast_left(state, &old, &GardenSpace::Room(channel_id)).await;
        state
            .hub
            .broadcast(
                envelope(
                    "garden.space_changed",
                    json!({ "space": "hub", "peer": current }),
                ),
                vec![user_id],
            )
            .await;
        broadcast_joined(state, &current).await;
    }
}

pub async fn close_room(state: &SharedState, channel_id: Uuid) {
    let plot_index =
        sqlx::query_scalar::<_, i32>("SELECT plot_index FROM garden_rooms WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
    let (door_x, door_y) = plot_door(plot_index);
    let peers: Vec<(GardenPeer, GardenPeer)> = {
        let mut guard = state.garden.peers.lock().unwrap();
        guard
            .values_mut()
            .filter(|peer| peer.channel_id == Some(channel_id))
            .map(|peer| {
                let old = peer.clone();
                peer.set_space(GardenSpace::Hub, door_x, door_y + 2.0);
                (old, peer.clone())
            })
            .collect()
    };
    for (old, current) in peers {
        broadcast_left(state, &old, &GardenSpace::Room(channel_id)).await;
        state
            .hub
            .broadcast(
                envelope(
                    "garden.space_changed",
                    json!({ "space": "hub", "peer": current }),
                ),
                vec![old.user_id],
            )
            .await;
        broadcast_joined(state, &current).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assign_color_index, clamped_for_space, is_garden_avatar, plot_door, valid_facing,
        GardenPeer, GardenSpace, GARDEN_COLOR_COUNT,
    };
    use std::collections::HashMap;
    use uuid::Uuid;

    /// Builds a peer map the way `handle_enter` would, one peer per user.
    fn peers_with(colors: &[(Uuid, u8)]) -> HashMap<Uuid, GardenPeer> {
        colors
            .iter()
            .map(|(user_id, color_index)| {
                let conn_id = Uuid::new_v4();
                let mut peer = GardenPeer::new(conn_id, *user_id, "Peer", None, *color_index);
                peer.color_index = *color_index;
                (conn_id, peer)
            })
            .collect()
    }

    #[test]
    fn first_peer_gets_the_accent_slot() {
        let peers = HashMap::new();
        assert_eq!(assign_color_index(&peers, Uuid::new_v4()), 0);
    }

    #[test]
    fn colors_are_handed_out_in_order() {
        let peers = peers_with(&[(Uuid::new_v4(), 0), (Uuid::new_v4(), 1)]);
        assert_eq!(assign_color_index(&peers, Uuid::new_v4()), 2);
    }

    #[test]
    fn a_second_tab_reuses_the_same_color() {
        let user_id = Uuid::new_v4();
        let peers = peers_with(&[(user_id, 3), (Uuid::new_v4(), 0)]);
        assert_eq!(assign_color_index(&peers, user_id), 3);
    }

    #[test]
    fn a_freed_slot_is_reused_rather_than_drifting_up() {
        // Slot 1 was vacated by someone leaving; the next arrival takes it back
        // instead of climbing to 3.
        let peers = peers_with(&[(Uuid::new_v4(), 0), (Uuid::new_v4(), 2)]);
        assert_eq!(assign_color_index(&peers, Uuid::new_v4()), 1);
    }

    #[test]
    fn the_eleventh_peer_wraps_deterministically() {
        let taken: Vec<(Uuid, u8)> = (0..GARDEN_COLOR_COUNT)
            .map(|slot| (Uuid::new_v4(), slot))
            .collect();
        let peers = peers_with(&taken);
        let newcomer = Uuid::new_v4();
        let first = assign_color_index(&peers, newcomer);
        assert!(first < GARDEN_COLOR_COUNT);
        // Same person, same slot: a collision must be stable, not flickering.
        assert_eq!(first, assign_color_index(&peers, newcomer));
    }

    #[test]
    fn avatars_are_allowlisted() {
        assert!(is_garden_avatar("samurai"));
        assert!(!is_garden_avatar("../../etc/passwd"));
        assert!(!is_garden_avatar(""));
    }

    #[test]
    fn plot_doors_are_stable_and_expand_in_rows() {
        assert_eq!(plot_door(0), (14.0, 19.0));
        assert_eq!(plot_door(3), (86.0, 19.0));
        assert_eq!(plot_door(4), (14.0, 38.0));
    }

    #[test]
    fn movement_clamps_to_each_scene() {
        assert_eq!(
            clamped_for_space(&GardenSpace::Hub, -10.0, 200.0),
            (2.0, 200.0)
        );
        assert_eq!(
            clamped_for_space(&GardenSpace::Room(Uuid::nil()), -4.0, 99.0),
            (2.0, 22.0)
        );
    }

    #[test]
    fn facing_is_allowlisted() {
        assert!(valid_facing("left"));
        assert!(!valid_facing("north-west"));
    }
}
