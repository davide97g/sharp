use crate::auth::{user_from_row, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::{Channel, User};
use crate::routes::is_member;
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const CHANNEL_SELECT: &str = "
    SELECT c.id, c.name, c.kind, c.topic, c.created_by, c.created_at,
        (cm.user_id IS NOT NULL) AS is_member,
        (SELECT max(created_at) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
        CASE WHEN cm.user_id IS NULL THEN 0::bigint ELSE
            (SELECT count(*) FROM messages m
             WHERE m.channel_id = c.id AND m.deleted_at IS NULL
               AND m.parent_id IS NULL
               AND m.user_id <> $1 AND m.id > cm.last_read_message_id)
        END AS unread_count
    FROM channels c
    LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
";

fn map_channel_row(row: &PgRow) -> AppResult<Channel> {
    Ok(Channel {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        kind: row.try_get("kind")?,
        topic: row.try_get("topic")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        is_member: row.try_get("is_member")?,
        unread_count: row.try_get("unread_count")?,
        last_message_at: row.try_get("last_message_at")?,
        dm_user: None,
    })
}

async fn dm_other_user(pool: &PgPool, channel_id: Uuid, viewer: Uuid) -> AppResult<Option<User>> {
    let row = sqlx::query(
        "SELECT u.id, u.email, u.display_name, u.created_at
         FROM channel_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1 AND cm.user_id <> $2
         LIMIT 1",
    )
    .bind(channel_id)
    .bind(viewer)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => Ok(Some(user_from_row(&r)?)),
        None => Ok(None),
    }
}

async fn hydrate_dm(pool: &PgPool, channel: &mut Channel, viewer: Uuid) -> AppResult<()> {
    if channel.kind == "dm" {
        channel.dm_user = dm_other_user(pool, channel.id, viewer).await?;
    }
    Ok(())
}

/// Load a single channel serialized for the given viewer.
pub async fn load_channel(pool: &PgPool, channel_id: Uuid, viewer: Uuid) -> AppResult<Channel> {
    let sql = format!("{} WHERE c.id = $2", CHANNEL_SELECT);
    let row = sqlx::query(&sql)
        .bind(viewer)
        .bind(channel_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("channel not found".to_string()))?;
    let mut channel = map_channel_row(&row)?;
    hydrate_dm(pool, &mut channel, viewer).await?;
    Ok(channel)
}

pub async fn list_channels(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let sql = format!(
        "{} WHERE c.kind = 'public' OR cm.user_id IS NOT NULL \
         ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC",
        CHANNEL_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(auth.id)
        .fetch_all(&state.pool)
        .await?;

    let mut channels = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut ch = map_channel_row(row)?;
        hydrate_dm(&state.pool, &mut ch, auth.id).await?;
        channels.push(ch);
    }

    Ok(Json(json!({ "channels": channels })))
}

fn valid_channel_name(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > 50 {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    pub kind: String,
    pub topic: Option<String>,
    pub member_ids: Option<Vec<Uuid>>,
}

pub async fn create_channel(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<CreateChannelRequest>,
) -> AppResult<(StatusCode, Json<Channel>)> {
    if body.kind != "public" && body.kind != "private" {
        return Err(AppError::Validation(
            "kind must be 'public' or 'private'".to_string(),
        ));
    }
    let name = body.name.trim().to_string();
    if !valid_channel_name(&name) {
        return Err(AppError::Validation(
            "name must match [a-z0-9-]{1,50}".to_string(),
        ));
    }
    let topic = body.topic.unwrap_or_default();

    let existing = sqlx::query("SELECT 1 AS x FROM channels WHERE kind <> 'dm' AND lower(name) = lower($1)")
        .bind(&name)
        .fetch_optional(&state.pool)
        .await?;
    if existing.is_some() {
        return Err(AppError::Conflict("channel name already taken".to_string()));
    }

    let row = sqlx::query(
        "INSERT INTO channels (name, kind, topic, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(&name)
    .bind(&body.kind)
    .bind(&topic)
    .bind(auth.id)
    .fetch_one(&state.pool)
    .await?;
    let channel_id: Uuid = row.try_get("id")?;

    // Membership: creator plus any requested members.
    let mut members: Vec<Uuid> = vec![auth.id];
    if let Some(ids) = body.member_ids {
        for id in ids {
            if !members.contains(&id) {
                members.push(id);
            }
        }
    }
    for uid in &members {
        sqlx::query(
            "INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
             ON CONFLICT (channel_id, user_id) DO NOTHING",
        )
        .bind(channel_id)
        .bind(uid)
        .execute(&state.pool)
        .await?;
    }

    let channel = load_channel(&state.pool, channel_id, auth.id).await?;

    // Members get the member view (is_member=true). Public channels are also
    // announced to everyone else connected, but with a non-member view so their
    // sidebar does not show the channel as already-joined.
    let member_ev = envelope("channel.created", json!({ "channel": &channel }));
    state.hub.broadcast(member_ev, members.clone()).await;

    if body.kind == "public" {
        let mut public_view = channel.clone();
        public_view.is_member = false;
        public_view.unread_count = 0;
        let others: Vec<Uuid> = state
            .hub
            .online_user_ids()
            .into_iter()
            .filter(|u| !members.contains(u))
            .collect();
        let public_ev = envelope("channel.created", json!({ "channel": &public_view }));
        state.hub.broadcast(public_ev, others).await;
    }

    Ok((StatusCode::CREATED, Json(channel)))
}

#[derive(Deserialize)]
pub struct CreateDmRequest {
    pub user_id: Uuid,
}

pub async fn create_dm(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<CreateDmRequest>,
) -> AppResult<Json<Channel>> {
    if body.user_id == auth.id {
        return Err(AppError::BadRequest(
            "cannot create a DM with yourself".to_string(),
        ));
    }

    let other = sqlx::query("SELECT 1 AS x FROM users WHERE id = $1")
        .bind(body.user_id)
        .fetch_optional(&state.pool)
        .await?;
    if other.is_none() {
        return Err(AppError::NotFound("user not found".to_string()));
    }

    // Find an existing DM with exactly these two members.
    let existing = sqlx::query(
        "SELECT c.id FROM channels c
         WHERE c.kind = 'dm'
           AND (SELECT count(*) FROM channel_members cm WHERE cm.channel_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $1)
           AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2)
         LIMIT 1",
    )
    .bind(auth.id)
    .bind(body.user_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(row) = existing {
        let id: Uuid = row.try_get("id")?;
        let channel = load_channel(&state.pool, id, auth.id).await?;
        return Ok(Json(channel));
    }

    // Canonical name from the ordered pair of ids.
    let (a, b) = if auth.id <= body.user_id {
        (auth.id, body.user_id)
    } else {
        (body.user_id, auth.id)
    };
    let name = format!("dm:{}:{}", a, b);

    let row = sqlx::query(
        "INSERT INTO channels (name, kind, topic, created_by) VALUES ($1, 'dm', '', $2) RETURNING id",
    )
    .bind(&name)
    .bind(auth.id)
    .fetch_one(&state.pool)
    .await?;
    let channel_id: Uuid = row.try_get("id")?;

    for uid in [auth.id, body.user_id] {
        sqlx::query(
            "INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
             ON CONFLICT (channel_id, user_id) DO NOTHING",
        )
        .bind(channel_id)
        .bind(uid)
        .execute(&state.pool)
        .await?;
    }

    let channel = load_channel(&state.pool, channel_id, auth.id).await?;

    // channel.created must be hydrated per-viewer: dm_user is the *other* member
    // relative to the recipient, so each side gets its own view of the channel.
    let ev_self = envelope("channel.created", json!({ "channel": &channel }));
    state.hub.broadcast(ev_self, vec![auth.id]).await;

    let other_view = load_channel(&state.pool, channel_id, body.user_id).await?;
    let ev_other = envelope("channel.created", json!({ "channel": &other_view }));
    state.hub.broadcast(ev_other, vec![body.user_id]).await;

    Ok(Json(channel))
}

async fn fetch_user(pool: &PgPool, user_id: Uuid) -> AppResult<User> {
    let row = sqlx::query("SELECT id, email, display_name, created_at FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("user not found".to_string()))?;
    user_from_row(&row)
}

pub async fn join_channel(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let kind = crate::routes::channel_kind(&state.pool, channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("channel not found".to_string()))?;
    if kind != "public" {
        return Err(AppError::Forbidden(
            "can only join public channels".to_string(),
        ));
    }

    let already = is_member(&state.pool, channel_id, auth.id).await?;
    sqlx::query(
        "INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
         ON CONFLICT (channel_id, user_id) DO NOTHING",
    )
    .bind(channel_id)
    .bind(auth.id)
    .execute(&state.pool)
    .await?;

    if !already {
        let user = fetch_user(&state.pool, auth.id).await?;
        let targets = channel_member_ids(&state.pool, channel_id).await?;
        let ev = envelope(
            "channel.member_joined",
            json!({ "channel_id": channel_id.to_string(), "user": user }),
        );
        state.hub.broadcast(ev, targets).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_channel(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    if crate::routes::channel_kind(&state.pool, channel_id)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound("channel not found".to_string()));
    }

    let was_member = is_member(&state.pool, channel_id, auth.id).await?;
    // Target set computed before removal so the leaver is also notified.
    let targets = channel_member_ids(&state.pool, channel_id).await?;

    sqlx::query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;

    if was_member {
        let user = fetch_user(&state.pool, auth.id).await?;
        let ev = envelope(
            "channel.member_left",
            json!({ "channel_id": channel_id.to_string(), "user": user }),
        );
        state.hub.broadcast(ev, targets).await;
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_members(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let kind = crate::routes::channel_kind(&state.pool, channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("channel not found".to_string()))?;
    if kind != "public" && !is_member(&state.pool, channel_id, auth.id).await? {
        return Err(AppError::Forbidden("not a member of this channel".to_string()));
    }

    let rows = sqlx::query(
        "SELECT u.id, u.email, u.display_name, u.created_at
         FROM channel_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = $1
         ORDER BY u.display_name",
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?;

    let mut members = Vec::with_capacity(rows.len());
    for row in &rows {
        members.push(user_from_row(row)?);
    }

    Ok(Json(json!({ "members": members })))
}

#[derive(Deserialize)]
pub struct ReadRequest {
    pub message_id: String,
}

pub async fn mark_read(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<ReadRequest>,
) -> AppResult<StatusCode> {
    if !is_member(&state.pool, channel_id, auth.id).await? {
        return Err(AppError::Forbidden("not a member of this channel".to_string()));
    }
    let message_id = body
        .message_id
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid message_id".to_string()))?;

    sqlx::query(
        "UPDATE channel_members
         SET last_read_message_id = GREATEST(last_read_message_id, $1)
         WHERE channel_id = $2 AND user_id = $3",
    )
    .bind(message_id)
    .bind(channel_id)
    .bind(auth.id)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}
