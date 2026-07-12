use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::{Attachment, Message, MessageUser, Reaction};
use crate::notify;
use crate::routes::{channel_kind, is_member};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

const MESSAGE_SELECT: &str = "
    SELECT
        m.id, m.channel_id, m.parent_id, m.user_id, u.display_name AS author_name,
        m.content, m.created_at, m.edited_at, m.deleted_at,
        (SELECT count(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS reply_count,
        (SELECT max(r.created_at) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS last_reply_at
    FROM messages m
    JOIN users u ON u.id = m.user_id
";

pub(crate) fn map_message_row(row: &PgRow) -> AppResult<Message> {
    let deleted_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("deleted_at")?;
    let content: String = if deleted_at.is_some() {
        String::new()
    } else {
        row.try_get("content")?
    };
    Ok(Message {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        parent_id: row.try_get("parent_id")?,
        user: MessageUser {
            id: row.try_get("user_id")?,
            display_name: row.try_get("author_name")?,
        },
        content,
        created_at: row.try_get("created_at")?,
        edited_at: row.try_get("edited_at")?,
        deleted_at,
        reactions: Vec::new(),
        attachments: Vec::new(),
        reply_count: row.try_get("reply_count")?,
        last_reply_at: row.try_get("last_reply_at")?,
    })
}

pub(crate) async fn fetch_reactions_map(
    pool: &PgPool,
    ids: &[i64],
    viewer: Uuid,
) -> AppResult<HashMap<i64, Vec<Reaction>>> {
    let mut map: HashMap<i64, Vec<Reaction>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT message_id, emoji, count(*) AS cnt, bool_or(user_id = $2) AS me
         FROM reactions
         WHERE message_id = ANY($1)
         GROUP BY message_id, emoji
         ORDER BY message_id, min(created_at)",
    )
    .bind(ids.to_vec())
    .bind(viewer)
    .fetch_all(pool)
    .await?;

    for row in &rows {
        let message_id: i64 = row.try_get("message_id")?;
        let reaction = Reaction {
            emoji: row.try_get("emoji")?,
            count: row.try_get("cnt")?,
            me: row.try_get::<Option<bool>, _>("me")?.unwrap_or(false),
        };
        map.entry(message_id).or_default().push(reaction);
    }
    Ok(map)
}

pub(crate) async fn fetch_attachments_map(
    pool: &PgPool,
    ids: &[i64],
) -> AppResult<HashMap<i64, Vec<Attachment>>> {
    let mut map: HashMap<i64, Vec<Attachment>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT id, message_id, filename, content_type, size FROM files
         WHERE message_id = ANY($1)
         ORDER BY message_id, created_at, id",
    )
    .bind(ids.to_vec())
    .fetch_all(pool)
    .await?;

    for row in &rows {
        let message_id: i64 = row.try_get("message_id")?;
        let id: Uuid = row.try_get("id")?;
        let attachment = Attachment {
            id,
            filename: row.try_get("filename")?,
            content_type: row.try_get("content_type")?,
            size: row.try_get("size")?,
            url: format!("/api/v1/files/{id}"),
        };
        map.entry(message_id).or_default().push(attachment);
    }
    Ok(map)
}

async fn assemble(pool: &PgPool, rows: Vec<PgRow>, viewer: Uuid) -> AppResult<Vec<Message>> {
    let mut msgs = Vec::with_capacity(rows.len());
    for row in &rows {
        msgs.push(map_message_row(row)?);
    }
    let ids: Vec<i64> = msgs.iter().map(|m| m.id).collect();
    let mut rmap = fetch_reactions_map(pool, &ids, viewer).await?;
    let mut amap = fetch_attachments_map(pool, &ids).await?;
    for m in &mut msgs {
        if let Some(rs) = rmap.remove(&m.id) {
            m.reactions = rs;
        }
        if let Some(atts) = amap.remove(&m.id) {
            m.attachments = atts;
        }
    }
    Ok(msgs)
}

/// Load a single message (with reactions) by id.
pub async fn load_message(pool: &PgPool, id: i64, viewer: Uuid) -> AppResult<Message> {
    let sql = format!("{} WHERE m.id = $1", MESSAGE_SELECT);
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("message not found".to_string()))?;
    let mut msgs = assemble(pool, vec![row], viewer).await?;
    msgs.pop()
        .ok_or_else(|| AppError::NotFound("message not found".to_string()))
}

struct MessageMeta {
    channel_id: Uuid,
    parent_id: Option<i64>,
    user_id: Uuid,
    deleted: bool,
}

async fn message_meta(pool: &PgPool, id: i64) -> AppResult<MessageMeta> {
    let row = sqlx::query(
        "SELECT channel_id, parent_id, user_id, deleted_at FROM messages WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("message not found".to_string()))?;
    let deleted_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("deleted_at")?;
    Ok(MessageMeta {
        channel_id: row.try_get("channel_id")?,
        parent_id: row.try_get("parent_id")?,
        user_id: row.try_get("user_id")?,
        deleted: deleted_at.is_some(),
    })
}

async fn require_member(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(&state.pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden("not a member of this channel".to_string()));
    }
    Ok(())
}

fn validate_content(content: &str) -> AppResult<()> {
    let len = content.chars().count();
    if content.trim().is_empty() {
        return Err(AppError::Validation("content must not be empty".to_string()));
    }
    if len > 8000 {
        return Err(AppError::Validation(
            "content must be at most 8000 characters".to_string(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_messages(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    require_member(&state, channel_id, auth.id).await?;

    let before: Option<i64> = match q.before {
        Some(ref s) if !s.is_empty() => Some(
            s.parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid before cursor".to_string()))?,
        ),
        _ => None,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 100);

    let sql = format!(
        "{} WHERE m.channel_id = $1 AND m.parent_id IS NULL \
         AND ($2::bigint IS NULL OR m.id < $2) \
         ORDER BY m.id DESC LIMIT $3",
        MESSAGE_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(channel_id)
        .bind(before)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;

    let mut msgs = assemble(&state.pool, rows, auth.id).await?;
    msgs.reverse(); // newest-first query -> return ascending

    Ok(Json(json!({ "messages": msgs })))
}

#[derive(Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
    pub parent_id: Option<String>,
    /// Ids of the caller's pending uploads to attach to this message.
    pub attachment_ids: Option<Vec<Uuid>>,
}

pub async fn create_message(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CreateMessageRequest>,
) -> AppResult<(StatusCode, Json<Message>)> {
    require_member(&state, channel_id, auth.id).await?;

    let attachment_ids: Vec<Uuid> = body.attachment_ids.clone().unwrap_or_default();
    // Content may be empty only when the message carries at least one attachment —
    // and only if the ids actually resolve to the caller's own unattached uploads in
    // this channel (otherwise bogus ids would persist a permanently blank message).
    if body.content.trim().is_empty() {
        if attachment_ids.is_empty() {
            return Err(AppError::Validation("content must not be empty".to_string()));
        }
        let row = sqlx::query(
            "SELECT count(*) AS c FROM files
             WHERE id = ANY($1) AND channel_id = $2 AND user_id = $3 AND message_id IS NULL",
        )
        .bind(&attachment_ids)
        .bind(channel_id)
        .bind(auth.id)
        .fetch_one(&state.pool)
        .await?;
        if row.try_get::<i64, _>("c")? == 0 {
            return Err(AppError::Validation("content must not be empty".to_string()));
        }
    } else if body.content.chars().count() > 8000 {
        return Err(AppError::Validation(
            "content must be at most 8000 characters".to_string(),
        ));
    }

    let parent_id: Option<i64> = match body.parent_id {
        Some(ref s) if !s.is_empty() => {
            let pid = s
                .parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid parent_id".to_string()))?;
            let meta = message_meta(&state.pool, pid).await?;
            if meta.channel_id != channel_id {
                return Err(AppError::BadRequest(
                    "parent is in a different channel".to_string(),
                ));
            }
            if meta.parent_id.is_some() {
                return Err(AppError::BadRequest(
                    "cannot reply to a reply".to_string(),
                ));
            }
            Some(pid)
        }
        _ => None,
    };

    let row = sqlx::query(
        "INSERT INTO messages (channel_id, user_id, parent_id, content)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(channel_id)
    .bind(auth.id)
    .bind(parent_id)
    .bind(&body.content)
    .fetch_one(&state.pool)
    .await?;
    let new_id: i64 = row.try_get("id")?;

    // Attach the caller's pending uploads (their own, in this channel, unattached).
    if !attachment_ids.is_empty() {
        sqlx::query(
            "UPDATE files SET message_id = $1
             WHERE id = ANY($2) AND channel_id = $3 AND user_id = $4 AND message_id IS NULL",
        )
        .bind(new_id)
        .bind(&attachment_ids)
        .bind(channel_id)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    }

    let message = load_message(&state.pool, new_id, auth.id).await?;

    let targets = channel_member_ids(&state.pool, channel_id).await?;
    let ev = envelope("message.created", json!({ "message": &message }));
    state.hub.broadcast(ev, targets).await;

    // Fan out notifications (mentions / dm / reply) — best-effort, OFF the request
    // path: web push does outbound HTTP, so never let it delay this response.
    let kind = channel_kind(&state.pool, channel_id)
        .await?
        .unwrap_or_default();
    let notify_state = state.clone();
    let content = message.content.clone();
    let first_attachment = message.attachments.first().map(|a| a.filename.clone());
    let msg_id = message.id;
    let parent = message.parent_id;
    let author = auth.id;
    tokio::spawn(async move {
        notify::dispatch_message(
            &notify_state,
            msg_id,
            channel_id,
            &kind,
            parent,
            author,
            &content,
            first_attachment.as_deref(),
        )
        .await;
    });

    Ok((StatusCode::CREATED, Json(message)))
}

pub async fn get_thread(
    State(state): State<SharedState>,
    Path(id): Path<i64>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let meta = message_meta(&state.pool, id).await?;
    require_member(&state, meta.channel_id, auth.id).await?;

    // Resolve to the top-level parent id.
    let parent_id = meta.parent_id.unwrap_or(id);
    let parent = load_message(&state.pool, parent_id, auth.id).await?;

    let sql = format!(
        "{} WHERE m.parent_id = $1 ORDER BY m.id ASC",
        MESSAGE_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(parent_id)
        .fetch_all(&state.pool)
        .await?;
    let replies = assemble(&state.pool, rows, auth.id).await?;

    Ok(Json(json!({ "parent": parent, "replies": replies })))
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

pub async fn edit_message(
    State(state): State<SharedState>,
    Path(id): Path<i64>,
    auth: AuthUser,
    Json(body): Json<EditMessageRequest>,
) -> AppResult<Json<Message>> {
    let meta = message_meta(&state.pool, id).await?;
    if meta.user_id != auth.id {
        return Err(AppError::Forbidden("not the author".to_string()));
    }
    if meta.deleted {
        return Err(AppError::BadRequest(
            "cannot edit a deleted message".to_string(),
        ));
    }
    validate_content(&body.content)?;

    sqlx::query("UPDATE messages SET content = $1, edited_at = now() WHERE id = $2")
        .bind(&body.content)
        .bind(id)
        .execute(&state.pool)
        .await?;

    let message = load_message(&state.pool, id, auth.id).await?;

    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    let ev = envelope("message.updated", json!({ "message": &message }));
    state.hub.broadcast(ev, targets).await;

    Ok(Json(message))
}

pub async fn delete_message(
    State(state): State<SharedState>,
    Path(id): Path<i64>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = message_meta(&state.pool, id).await?;
    if meta.user_id != auth.id {
        return Err(AppError::Forbidden("not the author".to_string()));
    }

    if !meta.deleted {
        sqlx::query("UPDATE messages SET deleted_at = now(), content = '' WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await?;
    }

    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    let ev = envelope(
        "message.deleted",
        json!({
            "message_id": id.to_string(),
            "channel_id": meta.channel_id.to_string(),
            "parent_id": meta.parent_id.map(|p| p.to_string()),
        }),
    );
    state.hub.broadcast(ev, targets).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn add_reaction(
    State(state): State<SharedState>,
    Path((id, emoji)): Path<(i64, String)>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = message_meta(&state.pool, id).await?;
    require_member(&state, meta.channel_id, auth.id).await?;
    if emoji.trim().is_empty() || emoji.chars().count() > 64 {
        return Err(AppError::Validation("invalid emoji".to_string()));
    }

    sqlx::query(
        "INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING",
    )
    .bind(id)
    .bind(auth.id)
    .bind(&emoji)
    .execute(&state.pool)
    .await?;

    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    let ev = envelope(
        "reaction.added",
        json!({
            "message_id": id.to_string(),
            "channel_id": meta.channel_id.to_string(),
            "emoji": emoji,
            "user_id": auth.id.to_string(),
        }),
    );
    state.hub.broadcast(ev, targets).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_reaction(
    State(state): State<SharedState>,
    Path((id, emoji)): Path<(i64, String)>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = message_meta(&state.pool, id).await?;
    require_member(&state, meta.channel_id, auth.id).await?;

    sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3")
        .bind(id)
        .bind(auth.id)
        .bind(&emoji)
        .execute(&state.pool)
        .await?;

    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    let ev = envelope(
        "reaction.removed",
        json!({
            "message_id": id.to_string(),
            "channel_id": meta.channel_id.to_string(),
            "emoji": emoji,
            "user_id": auth.id.to_string(),
        }),
    );
    state.hub.broadcast(ev, targets).await;

    Ok(StatusCode::NO_CONTENT)
}
