use crate::auth::{user_from_row, AuthUser};
use crate::docs_sync::refresh_room_access;
use crate::error::{AppError, AppResult};
use crate::models::{Doc, DocMention, DocMentionDoc, DocSearchResult, MessageUser};
use crate::routes::{
    channel_kind, channel_member_roles, is_member, member_role, ChannelRole,
};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

// Column list for a `docs` row, unqualified and `d.`-qualified (result names stay bare).
const DOC_COLS: &str =
    "id, channel_id, kind, title, icon, created_by, created_at, updated_at, deleted_at, everyone_role, content_text";
const DOC_COLS_D: &str =
    "d.id, d.channel_id, d.kind, d.title, d.icon, d.created_by, d.created_at, d.updated_at, d.deleted_at, d.everyone_role, d.content_text";

/// Effective role of a user relative to a doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocRole {
    Owner,
    Editor,
    Viewer,
    None,
}

impl DocRole {
    fn as_str(self) -> &'static str {
        match self {
            DocRole::Owner => "owner",
            DocRole::Editor => "editor",
            DocRole::Viewer => "viewer",
            DocRole::None => "none",
        }
    }

    fn from_role_str(s: &str) -> DocRole {
        match s {
            "owner" => DocRole::Owner,
            "editor" => DocRole::Editor,
            "viewer" => DocRole::Viewer,
            _ => DocRole::None,
        }
    }

    fn can_edit(self) -> bool {
        matches!(self, DocRole::Owner | DocRole::Editor)
    }

    fn is_owner(self) -> bool {
        matches!(self, DocRole::Owner)
    }
}

/// Raw `docs` row, before per-viewer role resolution.
pub(crate) struct RawDoc {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub kind: String,
    pub title: String,
    pub icon: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub everyone_role: String,
    pub content_text: String,
}

fn parse_raw_doc(row: &PgRow) -> AppResult<RawDoc> {
    Ok(RawDoc {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        kind: row.try_get("kind")?,
        title: row.try_get("title")?,
        icon: row.try_get("icon")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        deleted_at: row.try_get("deleted_at")?,
        everyone_role: row.try_get("everyone_role")?,
        content_text: row.try_get("content_text")?,
    })
}

/// Build the wire `Doc` for a viewer with an already-resolved role.
fn doc_view(raw: &RawDoc, my_role: &str) -> Doc {
    let preview: String = raw.content_text.chars().take(160).collect();
    Doc {
        id: raw.id,
        channel_id: raw.channel_id,
        kind: raw.kind.clone(),
        title: raw.title.clone(),
        icon: raw.icon.clone(),
        created_by: raw.created_by,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        deleted_at: raw.deleted_at,
        everyone_role: raw.everyone_role.clone(),
        my_role: my_role.to_string(),
        preview,
    }
}

/// Wire `Doc` for a member whose resolved role is `none`. The event is still delivered
/// (the client uses `my_role == "none"` to drop the doc from its UI) but the contents
/// are redacted so a revoked member never learns title/icon/preview.
fn redacted_doc_view(raw: &RawDoc) -> Doc {
    Doc {
        id: raw.id,
        channel_id: raw.channel_id,
        kind: raw.kind.clone(),
        title: String::new(),
        icon: String::new(),
        created_by: raw.created_by,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        deleted_at: raw.deleted_at,
        everyone_role: raw.everyone_role.clone(),
        my_role: DocRole::None.as_str().to_string(),
        preview: String::new(),
    }
}

fn compute_role(
    raw: &RawDoc,
    viewer: Uuid,
    channel_role: ChannelRole,
    override_role: Option<&str>,
) -> DocRole {
    if raw.created_by == Some(viewer) {
        return DocRole::Owner;
    }
    if channel_role.is_owner() {
        return DocRole::Owner;
    }
    if let Some(role) = override_role {
        return DocRole::from_role_str(role);
    }
    if raw.everyone_role != "inherit" {
        return DocRole::from_role_str(&raw.everyone_role);
    }
    match channel_role {
        ChannelRole::Owner => DocRole::Owner,
        ChannelRole::Editor => DocRole::Editor,
        ChannelRole::Viewer => DocRole::Viewer,
    }
}

pub(crate) async fn fetch_raw_doc(pool: &PgPool, doc_id: Uuid) -> AppResult<Option<RawDoc>> {
    let sql = format!("SELECT {} FROM docs WHERE id = $1", DOC_COLS);
    let row = sqlx::query(&sql).bind(doc_id).fetch_optional(pool).await?;
    match row {
        Some(r) => Ok(Some(parse_raw_doc(&r)?)),
        None => Ok(None),
    }
}

async fn single_override(pool: &PgPool, doc_id: Uuid, user_id: Uuid) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT role FROM doc_roles WHERE doc_id = $1 AND user_id = $2")
        .bind(doc_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(r) => Ok(Some(r.try_get("role")?)),
        None => Ok(None),
    }
}

pub(crate) async fn fetch_all_overrides(
    pool: &PgPool,
    doc_id: Uuid,
) -> AppResult<HashMap<Uuid, String>> {
    let rows = sqlx::query("SELECT user_id, role FROM doc_roles WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_all(pool)
        .await?;
    let mut map = HashMap::new();
    for r in &rows {
        map.insert(r.try_get::<Uuid, _>("user_id")?, r.try_get::<String, _>("role")?);
    }
    Ok(map)
}

async fn fetch_viewer_overrides(
    pool: &PgPool,
    doc_ids: &[Uuid],
    viewer: Uuid,
) -> AppResult<HashMap<Uuid, String>> {
    let mut map = HashMap::new();
    if doc_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query("SELECT doc_id, role FROM doc_roles WHERE user_id = $1 AND doc_id = ANY($2)")
        .bind(viewer)
        .bind(doc_ids.to_vec())
        .fetch_all(pool)
        .await?;
    for r in &rows {
        map.insert(r.try_get::<Uuid, _>("doc_id")?, r.try_get::<String, _>("role")?);
    }
    Ok(map)
}

/// Resolve access to a doc for a user. Missing doc or non-member => 404.
/// A resolved role of `none` is returned as-is (caller decides 403).
async fn access(pool: &PgPool, doc_id: Uuid, user_id: Uuid) -> AppResult<(RawDoc, DocRole)> {
    let raw = fetch_raw_doc(pool, doc_id)
        .await?
        .ok_or_else(|| AppError::NotFound("doc not found".to_string()))?;
    let channel_role = member_role(pool, raw.channel_id, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("doc not found".to_string()))?;
    let override_role = single_override(pool, doc_id, user_id).await?;
    let role = compute_role(&raw, user_id, channel_role, override_role.as_deref());
    Ok((raw, role))
}

fn require_visible(role: DocRole) -> AppResult<()> {
    if role == DocRole::None {
        return Err(AppError::Forbidden("no access to this doc".to_string()));
    }
    Ok(())
}

async fn require_channel(pool: &PgPool, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden("not a member of this channel".to_string()));
    }
    Ok(())
}

fn validate_title(title: &str) -> AppResult<()> {
    if title.chars().count() > 200 {
        return Err(AppError::Validation(
            "title must be at most 200 characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_icon(icon: &str) -> AppResult<()> {
    if icon.chars().count() > 16 {
        return Err(AppError::Validation(
            "icon must be at most 16 characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_everyone_role(role: &str) -> AppResult<()> {
    if !matches!(role, "editor" | "viewer" | "none" | "inherit") {
        return Err(AppError::Validation(
            "everyone_role must be 'editor', 'viewer', 'none' or 'inherit'".to_string(),
        ));
    }
    Ok(())
}

fn validate_override_role(role: &str) -> AppResult<()> {
    if !matches!(role, "editor" | "viewer" | "none") {
        return Err(AppError::Validation(
            "role must be 'editor', 'viewer' or 'none'".to_string(),
        ));
    }
    Ok(())
}

fn validate_kind(kind: &str) -> AppResult<()> {
    if !matches!(kind, "doc" | "canvas") {
        return Err(AppError::Validation(
            "kind must be 'doc' or 'canvas'".to_string(),
        ));
    }
    Ok(())
}

/// Build wire docs for a viewer from raw rows, dropping any with role `none`.
async fn docs_for_viewer(pool: &PgPool, rows: Vec<PgRow>, viewer: Uuid) -> AppResult<Vec<Doc>> {
    let mut raws = Vec::with_capacity(rows.len());
    for r in &rows {
        raws.push(parse_raw_doc(r)?);
    }
    let ids: Vec<Uuid> = raws.iter().map(|r| r.id).collect();
    let overrides = fetch_viewer_overrides(pool, &ids, viewer).await?;
    let mut channel_roles = HashMap::new();
    for raw in &raws {
        if !channel_roles.contains_key(&raw.channel_id) {
            let role = member_role(pool, raw.channel_id, viewer).await?;
            channel_roles.insert(raw.channel_id, role);
        }
    }
    let mut out = Vec::new();
    for raw in raws {
        let Some(channel_role) = channel_roles.get(&raw.channel_id).copied().flatten() else {
            continue;
        };
        let role = compute_role(
            &raw,
            viewer,
            channel_role,
            overrides.get(&raw.id).map(|s| s.as_str()),
        );
        if role == DocRole::None {
            continue;
        }
        out.push(doc_view(&raw, role.as_str()));
    }
    Ok(out)
}

// ---- doc.created / doc.updated fanout (per-viewer my_role) ----

/// Broadcast a doc meta event to every channel member with their own resolved role.
/// Members are grouped by role so at most four envelopes are emitted.
pub(crate) async fn broadcast_doc_event(
    state: &SharedState,
    doc_id: Uuid,
    event_type: &str,
) -> AppResult<()> {
    let raw = match fetch_raw_doc(&state.pool, doc_id).await? {
        Some(r) => r,
        None => return Ok(()),
    };
    let members = channel_member_roles(&state.pool, raw.channel_id).await?;
    if members.is_empty() {
        return Ok(());
    }
    let overrides = fetch_all_overrides(&state.pool, doc_id).await?;

    let mut groups: HashMap<&'static str, Vec<Uuid>> = HashMap::new();
    for (uid, channel_role) in members {
        let role = compute_role(
            &raw,
            uid,
            channel_role,
            overrides.get(&uid).map(|s| s.as_str()),
        );
        groups.entry(role.as_str()).or_default().push(uid);
    }
    for (role_str, uids) in groups {
        // Members resolved to `none` get a redacted payload so they can drop the doc
        // from their UI without learning its contents.
        let doc = if role_str == DocRole::None.as_str() {
            redacted_doc_view(&raw)
        } else {
            doc_view(&raw, role_str)
        };
        let ev = envelope(event_type, json!({ "doc": doc }));
        state.hub.broadcast(ev, uids).await;
    }
    Ok(())
}

// ---- doc-sync access decision (used by the binary sync socket) ----

pub(crate) enum SyncDecision {
    NotFound,
    Forbidden,
    Ok { read_only: bool },
}

pub(crate) async fn sync_decision(
    pool: &PgPool,
    doc_id: Uuid,
    user_id: Uuid,
) -> AppResult<SyncDecision> {
    let raw = match fetch_raw_doc(pool, doc_id).await? {
        Some(r) => r,
        None => return Ok(SyncDecision::NotFound),
    };
    let channel_role = member_role(pool, raw.channel_id, user_id).await?;
    let ov = if raw.created_by == Some(user_id) {
        None
    } else {
        single_override(pool, doc_id, user_id).await?
    };
    Ok(sync_decision_for(
        &raw,
        channel_role,
        ov.as_deref(),
        user_id,
    ))
}

/// Pure form of [`sync_decision`] over already-fetched data. Used to re-evaluate every
/// open connection after an access change without a query per connection.
pub(crate) fn sync_decision_for(
    raw: &RawDoc,
    channel_role: Option<ChannelRole>,
    override_role: Option<&str>,
    user_id: Uuid,
) -> SyncDecision {
    let Some(channel_role) = channel_role else {
        return SyncDecision::NotFound;
    };
    let role = compute_role(raw, user_id, channel_role, override_role);
    if role == DocRole::None {
        return SyncDecision::Forbidden;
    }
    // Viewers and trashed docs are read-only; drops enforced in the socket loop.
    let read_only = matches!(role, DocRole::Viewer) || raw.deleted_at.is_some();
    SyncDecision::Ok { read_only }
}

// ---- endpoints ----

pub async fn list_channel_docs(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    require_channel(&state.pool, channel_id, auth.id).await?;
    let sql = format!(
        "SELECT {} FROM docs WHERE channel_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
        DOC_COLS
    );
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await?;
    let docs = docs_for_viewer(&state.pool, rows, auth.id).await?;
    Ok(Json(json!({ "docs": docs })))
}

pub async fn list_channel_trash(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    require_channel(&state.pool, channel_id, auth.id).await?;
    let sql = format!(
        "SELECT {} FROM docs WHERE channel_id = $1 AND deleted_at IS NOT NULL ORDER BY updated_at DESC",
        DOC_COLS
    );
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await?;
    let docs = docs_for_viewer(&state.pool, rows, auth.id).await?;
    Ok(Json(json!({ "docs": docs })))
}

#[derive(Deserialize)]
pub struct CreateDocRequest {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub kind: Option<String>,
}

pub async fn create_doc(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CreateDocRequest>,
) -> AppResult<(StatusCode, Json<Doc>)> {
    require_channel(&state.pool, channel_id, auth.id).await?;
    if !member_role(&state.pool, channel_id, auth.id)
        .await?
        .is_some_and(ChannelRole::can_post)
    {
        return Err(AppError::Forbidden(
            "creating docs requires owner or editor role".to_string(),
        ));
    }
    let title = body.title.unwrap_or_default();
    let icon = body.icon.unwrap_or_default();
    let kind = body.kind.unwrap_or_else(|| "doc".to_string());
    validate_title(&title)?;
    validate_icon(&icon)?;
    validate_kind(&kind)?;

    let sql = format!(
        "INSERT INTO docs (channel_id, kind, title, icon, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING {}",
        DOC_COLS
    );
    let row = sqlx::query(&sql)
        .bind(channel_id)
        .bind(&kind)
        .bind(&title)
        .bind(&icon)
        .bind(auth.id)
        .fetch_one(&state.pool)
        .await?;
    let raw = parse_raw_doc(&row)?;
    let doc = doc_view(&raw, DocRole::Owner.as_str());

    broadcast_doc_event(&state, doc.id, "doc.created").await?;

    Ok((StatusCode::CREATED, Json(doc)))
}

pub async fn get_doc(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<Doc>> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    require_visible(role)?;
    Ok(Json(doc_view(&raw, role.as_str())))
}

#[derive(Deserialize)]
pub struct UpdateDocRequest {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub everyone_role: Option<String>,
}

pub async fn update_doc(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<UpdateDocRequest>,
) -> AppResult<Json<Doc>> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    require_visible(role)?;

    if body.title.is_none() && body.icon.is_none() && body.everyone_role.is_none() {
        return Err(AppError::Validation("nothing to update".to_string()));
    }

    let wants_meta = body.title.is_some() || body.icon.is_some();
    let wants_role = body.everyone_role.is_some();
    if wants_meta && !role.can_edit() {
        return Err(AppError::Forbidden("editor role required".to_string()));
    }
    if wants_role && !role.is_owner() {
        return Err(AppError::Forbidden("owner role required".to_string()));
    }
    if let Some(t) = &body.title {
        validate_title(t)?;
    }
    if let Some(i) = &body.icon {
        validate_icon(i)?;
    }
    if let Some(er) = &body.everyone_role {
        validate_everyone_role(er)?;
    }

    let sql = format!(
        "UPDATE docs SET title = COALESCE($2, title), icon = COALESCE($3, icon), \
         everyone_role = COALESCE($4, everyone_role), updated_at = now() \
         WHERE id = $1 RETURNING {}",
        DOC_COLS
    );
    let row = sqlx::query(&sql)
        .bind(doc_id)
        .bind(body.title.as_deref())
        .bind(body.icon.as_deref())
        .bind(body.everyone_role.as_deref())
        .fetch_one(&state.pool)
        .await?;
    let new_raw = parse_raw_doc(&row)?;

    // Recompute the requester's role against the (possibly changed) everyone_role.
    let ov = single_override(&state.pool, doc_id, auth.id).await?;
    let channel_role = member_role(&state.pool, raw.channel_id, auth.id)
        .await?
        .ok_or_else(|| AppError::NotFound("doc not found".to_string()))?;
    let my_role = compute_role(&new_raw, auth.id, channel_role, ov.as_deref());
    let doc = doc_view(&new_raw, my_role.as_str());

    broadcast_doc_event(&state, doc_id, "doc.updated").await?;
    // An everyone_role change can revoke access; push it to open sync sessions.
    if wants_role {
        refresh_room_access(&state, doc_id).await;
    }

    Ok(Json(doc))
}

pub async fn delete_doc(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.can_edit() {
        return Err(AppError::Forbidden("editor role required".to_string()));
    }

    if raw.deleted_at.is_none() {
        sqlx::query("UPDATE docs SET deleted_at = now(), updated_at = now() WHERE id = $1")
            .bind(doc_id)
            .execute(&state.pool)
            .await?;
    }

    let members = channel_member_ids(&state.pool, raw.channel_id).await?;
    let ev = envelope(
        "doc.deleted",
        json!({
            "doc_id": doc_id.to_string(),
            "channel_id": raw.channel_id.to_string(),
            "permanent": false,
        }),
    );
    state.hub.broadcast(ev, members).await;
    // Trashing flips open editors to read-only; push fresh role frames.
    refresh_room_access(&state, doc_id).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_doc(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<Doc>> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.can_edit() {
        return Err(AppError::Forbidden("editor role required".to_string()));
    }

    let sql = format!(
        "UPDATE docs SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING {}",
        DOC_COLS
    );
    let row = sqlx::query(&sql)
        .bind(doc_id)
        .fetch_one(&state.pool)
        .await?;
    let new_raw = parse_raw_doc(&row)?;
    let ov = single_override(&state.pool, doc_id, auth.id).await?;
    let channel_role = member_role(&state.pool, raw.channel_id, auth.id)
        .await?
        .ok_or_else(|| AppError::NotFound("doc not found".to_string()))?;
    let my_role = compute_role(&new_raw, auth.id, channel_role, ov.as_deref());
    let doc = doc_view(&new_raw, my_role.as_str());

    broadcast_doc_event(&state, doc_id, "doc.updated").await?;
    // Restoring lifts read-only from open sessions; push fresh role frames.
    refresh_room_access(&state, doc_id).await;

    Ok(Json(doc))
}

pub async fn permanent_delete_doc(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.is_owner() {
        return Err(AppError::Forbidden("owner role required".to_string()));
    }

    // Capture members before the row (and its cascade) disappears.
    let members = channel_member_ids(&state.pool, raw.channel_id).await?;

    sqlx::query("DELETE FROM docs WHERE id = $1")
        .bind(doc_id)
        .execute(&state.pool)
        .await?;

    // The doc is gone: tear down any open sync room (closes every connection).
    refresh_room_access(&state, doc_id).await;

    let ev = envelope(
        "doc.deleted",
        json!({
            "doc_id": doc_id.to_string(),
            "channel_id": raw.channel_id.to_string(),
            "permanent": true,
        }),
    );
    state.hub.broadcast(ev, members).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_roles(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let (_raw, role) = access(&state.pool, doc_id, auth.id).await?;
    require_visible(role)?;

    let rows = sqlx::query(
        "SELECT u.id, u.email, u.display_name, u.avatar_url, u.created_at, dr.role
         FROM doc_roles dr JOIN users u ON u.id = dr.user_id
         WHERE dr.doc_id = $1
         ORDER BY u.display_name",
    )
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;

    let mut roles = Vec::with_capacity(rows.len());
    for r in &rows {
        let user = user_from_row(r)?.redact_email_for(auth.id);
        let role_str: String = r.try_get("role")?;
        roles.push(json!({ "user": user, "role": role_str }));
    }

    Ok(Json(json!({ "roles": roles })))
}

#[derive(Deserialize)]
pub struct SetRoleRequest {
    pub role: String,
}

pub async fn set_role(
    State(state): State<SharedState>,
    Path((doc_id, target_user)): Path<(Uuid, Uuid)>,
    auth: AuthUser,
    Json(body): Json<SetRoleRequest>,
) -> AppResult<StatusCode> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.is_owner() {
        return Err(AppError::Forbidden("owner role required".to_string()));
    }
    validate_override_role(&body.role)?;
    if raw.created_by == Some(target_user) {
        return Err(AppError::BadRequest(
            "cannot change the creator's role".to_string(),
        ));
    }
    if !is_member(&state.pool, raw.channel_id, target_user).await? {
        return Err(AppError::Validation(
            "target must be a channel member".to_string(),
        ));
    }

    sqlx::query(
        "INSERT INTO doc_roles (doc_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(doc_id)
    .bind(target_user)
    .bind(&body.role)
    .execute(&state.pool)
    .await?;

    broadcast_doc_event(&state, doc_id, "doc.updated").await?;
    // A role override can grant or revoke access; push it to open sync sessions.
    refresh_room_access(&state, doc_id).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_role(
    State(state): State<SharedState>,
    Path((doc_id, target_user)): Path<(Uuid, Uuid)>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let (_raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.is_owner() {
        return Err(AppError::Forbidden("owner role required".to_string()));
    }

    sqlx::query("DELETE FROM doc_roles WHERE doc_id = $1 AND user_id = $2")
        .bind(doc_id)
        .bind(target_user)
        .execute(&state.pool)
        .await?;

    broadcast_doc_event(&state, doc_id, "doc.updated").await?;
    // Removing an override falls the user back to everyone_role; re-evaluate sessions.
    refresh_room_access(&state, doc_id).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn backlinks(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let (_raw, role) = access(&state.pool, doc_id, auth.id).await?;
    require_visible(role)?;

    let sql = format!(
        "SELECT {} FROM docs d JOIN doc_links dl ON dl.doc_id = d.id
         JOIN channel_members cm ON cm.channel_id = d.channel_id AND cm.user_id = $2
         WHERE dl.target_doc_id = $1 AND d.deleted_at IS NULL
         ORDER BY d.updated_at DESC",
        DOC_COLS_D
    );
    let rows = sqlx::query(&sql)
        .bind(doc_id)
        .bind(auth.id)
        .fetch_all(&state.pool)
        .await?;
    let docs = docs_for_viewer(&state.pool, rows, auth.id).await?;
    Ok(Json(json!({ "docs": docs })))
}

#[derive(Deserialize)]
pub struct MentionRequest {
    pub user_id: Uuid,
}

pub async fn create_mention(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<MentionRequest>,
) -> AppResult<StatusCode> {
    let (raw, role) = access(&state.pool, doc_id, auth.id).await?;
    if !role.can_edit() {
        return Err(AppError::Forbidden("editor role required".to_string()));
    }

    let target = body.user_id;
    if target == auth.id {
        return Err(AppError::Validation("cannot mention yourself".to_string()));
    }
    if raw.deleted_at.is_some() {
        return Err(AppError::Validation(
            "cannot mention in a trashed doc".to_string(),
        ));
    }
    // The target must be able to see the doc: channel member + role != none.
    let target_channel_role = member_role(&state.pool, raw.channel_id, target).await?;
    if target_channel_role.is_none() {
        return Err(AppError::Validation(
            "target user cannot access this doc".to_string(),
        ));
    }
    let target_override = single_override(&state.pool, doc_id, target).await?;
    let target_role = compute_role(
        &raw,
        target,
        target_channel_role.expect("checked above"),
        target_override.as_deref(),
    );
    if target_role == DocRole::None {
        return Err(AppError::Validation(
            "target user cannot access this doc".to_string(),
        ));
    }

    // Dedup: skip if an unread mention of the same user in the same doc exists.
    let existing =
        sqlx::query("SELECT 1 AS x FROM doc_mentions WHERE doc_id = $1 AND to_user = $2 AND read_at IS NULL")
            .bind(doc_id)
            .bind(target)
            .fetch_optional(&state.pool)
            .await?;
    if existing.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }

    let row = sqlx::query(
        "INSERT INTO doc_mentions (doc_id, from_user, to_user) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(doc_id)
    .bind(auth.id)
    .bind(target)
    .fetch_one(&state.pool)
    .await?;
    let mention_id: i64 = row.try_get("id")?;

    let mention = load_mention(&state.pool, mention_id).await?;
    let ev = envelope("doc.mention", json!({ "mention": mention }));
    state.hub.broadcast(ev, vec![target]).await;

    // Web push for offline recipients (canvases live under /x/, docs under /d/).
    let prefix = if mention.doc.kind == "canvas" { "x" } else { "d" };
    let title = format!("{} mentioned you", mention.from_user.display_name);
    let doc_title = if mention.doc.title.is_empty() {
        "Untitled".to_string()
    } else {
        mention.doc.title.clone()
    };
    crate::notify::push_event(
        &state,
        target,
        &title,
        &doc_title,
        &format!("sharp-doc-{}", mention.doc.id),
        &format!("/{}/{}", prefix, mention.doc.id),
        mention.doc.channel_id,
        "doc_mention",
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

const MENTION_SELECT: &str = "
    SELECT dm.id, dm.created_at, dm.read_at,
        d.id AS doc_id, d.kind AS doc_kind, d.title AS doc_title, d.icon AS doc_icon, d.channel_id AS doc_channel_id,
        fu.id AS from_id, fu.display_name AS from_name, fu.avatar_url AS from_avatar
    FROM doc_mentions dm
    JOIN docs d ON d.id = dm.doc_id
    JOIN users fu ON fu.id = dm.from_user
";

fn map_mention_row(row: &PgRow) -> AppResult<DocMention> {
    Ok(DocMention {
        id: row.try_get("id")?,
        doc: DocMentionDoc {
            id: row.try_get("doc_id")?,
            kind: row.try_get("doc_kind")?,
            title: row.try_get("doc_title")?,
            icon: row.try_get("doc_icon")?,
            channel_id: row.try_get("doc_channel_id")?,
        },
        from_user: MessageUser {
            id: row.try_get("from_id")?,
            display_name: row.try_get("from_name")?,
            avatar_url: row.try_get("from_avatar")?,
        },
        created_at: row.try_get("created_at")?,
        read_at: row.try_get("read_at")?,
    })
}

async fn load_mention(pool: &PgPool, id: i64) -> AppResult<DocMention> {
    let sql = format!("{} WHERE dm.id = $1", MENTION_SELECT);
    let row = sqlx::query(&sql).bind(id).fetch_one(pool).await?;
    map_mention_row(&row)
}

pub async fn list_mentions(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let sql = format!(
        "{} WHERE dm.to_user = $1 ORDER BY (dm.read_at IS NOT NULL), dm.id DESC LIMIT 50",
        MENTION_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(auth.id)
        .fetch_all(&state.pool)
        .await?;
    let mut mentions = Vec::with_capacity(rows.len());
    for r in &rows {
        mentions.push(map_mention_row(r)?);
    }
    Ok(Json(json!({ "mentions": mentions })))
}

#[derive(Deserialize)]
pub struct ReadMentionsRequest {
    pub ids: Vec<String>,
}

pub async fn read_mentions(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ReadMentionsRequest>,
) -> AppResult<StatusCode> {
    let mut ids = Vec::with_capacity(body.ids.len());
    for s in &body.ids {
        let id = s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("invalid mention id".to_string()))?;
        ids.push(id);
    }
    if !ids.is_empty() {
        sqlx::query(
            "UPDATE doc_mentions SET read_at = now() WHERE to_user = $1 AND id = ANY($2) AND read_at IS NULL",
        )
        .bind(auth.id)
        .bind(ids)
        .execute(&state.pool)
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DocSearchQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    /// Optional scope: restrict results to a single doc/canvas (ACL still enforced).
    pub doc_id: Option<Uuid>,
}

pub async fn search_docs(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(params): Query<DocSearchQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!({ "results": Vec::<DocSearchResult>::new() })));
    }
    let limit = params.limit.unwrap_or(20).clamp(1, 50);
    let like = format!("%{}%", q);

    // Optional single-doc scope. When present it binds as $4 and shifts LIMIT to $5.
    let scope_clause = if params.doc_id.is_some() {
        "AND d.id = $4"
    } else {
        ""
    };
    let limit_placeholder = if params.doc_id.is_some() { "$5" } else { "$4" };
    let sql = format!(
        "SELECT {cols}, c.name AS channel_name,
            ts_headline('simple', d.content_text, websearch_to_tsquery('simple', $2),
                'StartSel=<<,StopSel=>>,MaxWords=18,MinWords=6,MaxFragments=1') AS snippet,
            ts_rank(d.search, websearch_to_tsquery('simple', $2)) AS rank
         FROM docs d
         JOIN channels c ON c.id = d.channel_id
         JOIN channel_members cm ON cm.channel_id = d.channel_id AND cm.user_id = $1
         WHERE d.deleted_at IS NULL
           AND (d.search @@ websearch_to_tsquery('simple', $2) OR d.title ILIKE $3)
           {scope_clause}
         ORDER BY rank DESC, d.updated_at DESC
         LIMIT {limit_placeholder}",
        cols = DOC_COLS_D
    );
    let mut query = sqlx::query(&sql).bind(auth.id).bind(&q).bind(&like);
    if let Some(did) = params.doc_id {
        query = query.bind(did);
    }
    let rows = query.bind(limit).fetch_all(&state.pool).await?;

    let mut raws = Vec::with_capacity(rows.len());
    for r in &rows {
        let raw = parse_raw_doc(r)?;
        let channel_name: String = r.try_get("channel_name")?;
        let snippet: String = r.try_get("snippet").unwrap_or_default();
        raws.push((raw, channel_name, snippet));
    }
    let ids: Vec<Uuid> = raws.iter().map(|(r, _, _)| r.id).collect();
    let overrides = fetch_viewer_overrides(&state.pool, &ids, auth.id).await?;
    let mut channel_roles = HashMap::new();
    for (raw, _, _) in &raws {
        if !channel_roles.contains_key(&raw.channel_id) {
            let role = member_role(&state.pool, raw.channel_id, auth.id).await?;
            channel_roles.insert(raw.channel_id, role);
        }
    }

    let mut results = Vec::new();
    for (raw, channel_name, snippet) in raws {
        let Some(channel_role) = channel_roles.get(&raw.channel_id).copied().flatten() else {
            continue;
        };
        let role = compute_role(
            &raw,
            auth.id,
            channel_role,
            overrides.get(&raw.id).map(|s| s.as_str()),
        );
        if role == DocRole::None {
            continue;
        }
        results.push(DocSearchResult {
            doc: doc_view(&raw, role.as_str()),
            channel_name,
            snippet,
        });
    }

    Ok(Json(json!({ "results": results })))
}
