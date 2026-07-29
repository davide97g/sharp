use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::gif;
use crate::models::{Attachment, Message, MessageUser, Reaction, ReplyPreview};
use crate::notify;
use crate::routes::{channel_kind, require_can_post, require_member};
use crate::state::SharedState;
use crate::unfurl;
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
        u.avatar_url AS author_avatar,
        m.content, m.encrypted, m.created_at, m.edited_at, m.deleted_at,
        rm.id AS reply_id, rm.content AS reply_content, rm.encrypted AS reply_encrypted,
        rm.deleted_at AS reply_deleted_at,
        ru.id AS reply_user_id, ru.display_name AS reply_user_name, ru.avatar_url AS reply_user_avatar,
        (SELECT count(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS reply_count,
        (SELECT max(r.created_at) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS last_reply_at
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.user_id
";

/// A short single-line preview of quoted content (newlines collapsed, truncated).
fn preview_text(s: &str) -> String {
    let humanized = notify::preview_text(s);
    let flat: String = humanized.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 140 {
        flat.chars().take(140).collect::<String>() + "…"
    } else {
        flat
    }
}

pub(crate) fn map_message_row(row: &PgRow) -> AppResult<Message> {
    let deleted_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("deleted_at")?;
    let content: String = if deleted_at.is_some() {
        String::new()
    } else {
        row.try_get("content")?
    };

    let reply_id: Option<i64> = row.try_get("reply_id")?;
    let reply_to = match reply_id {
        Some(rid) => {
            let rdel: Option<chrono::DateTime<chrono::Utc>> = row.try_get("reply_deleted_at")?;
            let rcontent: String = row.try_get("reply_content")?;
            let encrypted: bool = row.try_get("reply_encrypted")?;
            Some(ReplyPreview {
                id: rid,
                user: MessageUser {
                    id: row.try_get("reply_user_id")?,
                    display_name: row.try_get("reply_user_name")?,
                    avatar_url: row.try_get("reply_user_avatar")?,
                },
                content: if rdel.is_some() || encrypted {
                    String::new()
                } else {
                    preview_text(&rcontent)
                },
                deleted: rdel.is_some(),
                encrypted,
            })
        }
        None => None,
    };

    Ok(Message {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        parent_id: row.try_get("parent_id")?,
        user: MessageUser {
            id: row.try_get("user_id")?,
            display_name: row.try_get("author_name")?,
            avatar_url: row.try_get("author_avatar")?,
        },
        content,
        encrypted: row.try_get("encrypted")?,
        created_at: row.try_get("created_at")?,
        edited_at: row.try_get("edited_at")?,
        deleted_at,
        reactions: Vec::new(),
        attachments: Vec::new(),
        reply_count: row.try_get("reply_count")?,
        last_reply_at: row.try_get("last_reply_at")?,
        reply_to,
        link_previews: Vec::new(),
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
        "SELECT id, message_id, filename, content_type, size, encrypted FROM files
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
            encrypted: row.try_get("encrypted")?,
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
    let mut pmap = unfurl::load_previews_map(pool, &ids).await?;
    for m in &mut msgs {
        if let Some(rs) = rmap.remove(&m.id) {
            m.reactions = rs;
        }
        if let Some(atts) = amap.remove(&m.id) {
            m.attachments = atts;
        }
        if let Some(previews) = pmap.remove(&m.id) {
            m.link_previews = previews;
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
    encrypted: bool,
}

async fn message_meta(pool: &PgPool, id: i64) -> AppResult<MessageMeta> {
    let row = sqlx::query(
        "SELECT channel_id, parent_id, user_id, deleted_at, encrypted FROM messages WHERE id = $1",
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
        encrypted: row.try_get("encrypted")?,
    })
}

/// 403 body for a viewer (or non-member) trying to write in a channel.
const POST_DENIED: &str = "posting requires owner or editor role";

fn validate_content(content: &str, encrypted: bool) -> AppResult<()> {
    let len = content.chars().count();
    if content.trim().is_empty() {
        return Err(AppError::Validation(
            "content must not be empty".to_string(),
        ));
    }
    let max = if encrypted { 65_536 } else { 8_000 };
    if len > max {
        return Err(AppError::Validation(format!(
            "content must be at most {max} characters"
        )));
    }
    Ok(())
}

async fn insert_message(
    state: &SharedState,
    channel_id: Uuid,
    user_id: Uuid,
    parent_id: Option<i64>,
    content: &str,
    reply_to_id: Option<i64>,
    encrypted: bool,
) -> AppResult<i64> {
    // Stamp the expiry from the channel's TTL at write time. Doing it here
    // rather than deriving it on read means later TTL changes never reach back
    // and delete history posted under the previous rule.
    let row = sqlx::query(
        "INSERT INTO messages (channel_id, user_id, parent_id, content, reply_to_id, encrypted,
                               expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT now() + make_interval(mins => message_ttl_minutes)
              FROM channels WHERE id = $1 AND message_ttl_minutes IS NOT NULL))
         RETURNING id",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(parent_id)
    .bind(content)
    .bind(reply_to_id)
    .bind(encrypted)
    .fetch_one(&state.pool)
    .await?;
    Ok(row.try_get("id")?)
}

/// Soft-delete messages whose TTL has elapsed and tell every member.
///
/// Same shape as a manual delete — `deleted_at` set, content blanked, embedding
/// dropped, `message.deleted` broadcast — so every client already knows how to
/// render the result and no new wire event is needed. Batched so one long-idle
/// period cannot produce an unbounded burst of broadcasts.
pub async fn expire_tick(state: &SharedState) -> AppResult<()> {
    let rows = sqlx::query(
        "UPDATE messages SET deleted_at = now(), content = ''
         WHERE id IN (
             SELECT id FROM messages
             WHERE expires_at IS NOT NULL AND expires_at <= now() AND deleted_at IS NULL
             ORDER BY expires_at
             LIMIT 200
         )
         RETURNING id, channel_id, parent_id",
    )
    .fetch_all(&state.pool)
    .await?;

    for row in &rows {
        let id: i64 = row.try_get("id")?;
        let channel_id: Uuid = row.try_get("channel_id")?;
        let parent_id: Option<i64> = row.try_get("parent_id")?;
        crate::routes::sharpy::drop_message_embedding(state, id).await;
        let targets = channel_member_ids(&state.pool, channel_id).await?;
        let ev = envelope(
            "message.deleted",
            json!({
                "message_id": id.to_string(),
                "channel_id": channel_id.to_string(),
                "parent_id": parent_id.map(|p| p.to_string()),
            }),
        );
        state.hub.broadcast(ev, targets).await;
    }
    Ok(())
}

async fn publish_message(
    state: &SharedState,
    channel_id: Uuid,
    author: Uuid,
    message: &Message,
) -> AppResult<()> {
    let targets = channel_member_ids(&state.pool, channel_id).await?;
    let duck_streak = if !message.encrypted
        && message.parent_id.is_none()
        && !gif::is_standalone_gif(&message.content)
    {
        Some(gif::bump_streak(&state.duck_streaks, channel_id))
    } else {
        None
    };
    let event = match &duck_streak {
        Some(streak) => envelope(
            "message.created",
            json!({ "message": message, "duck_streak": streak }),
        ),
        None => envelope("message.created", json!({ "message": message })),
    };
    state.hub.broadcast(event, targets).await;

    let kind = channel_kind(&state.pool, channel_id)
        .await?
        .unwrap_or_default();
    let notify_state = state.clone();
    let content = message.content.clone();
    let first_attachment = message
        .attachments
        .first()
        .map(|attachment| attachment.filename.clone());
    let message_id = message.id;
    let parent_id = message.parent_id;
    let encrypted = message.encrypted;
    tokio::spawn(async move {
        notify::dispatch_message(
            &notify_state,
            message_id,
            channel_id,
            &kind,
            parent_id,
            author,
            &content,
            first_attachment.as_deref(),
            encrypted,
        )
        .await;
    });

    // Link previews: unfurl in the background and follow up with
    // `message.previews`. Encrypted content is ciphertext — there is nothing to
    // read, and fetching what we could read would leak it to a third party.
    if !message.encrypted {
        unfurl::spawn_unfurl(state, message.id, channel_id, message.content.clone());
    }

    // Sharpy: embed the new message immediately (no-op when disabled/encrypted).
    if state.config.ai.is_some() && !message.encrypted {
        let embed_state = state.clone();
        let embed_content = message.content.clone();
        let embed_id = message.id;
        tokio::spawn(async move {
            crate::routes::sharpy::embed_message(
                &embed_state,
                embed_id,
                channel_id,
                embed_content,
            )
            .await;
        });
    }
    Ok(())
}

/// Post a top-level message as an existing user, including normal realtime,
/// unread, and notification behavior. Internal automations use this instead of
/// bypassing the message pipeline.
pub(crate) async fn post_message_as(
    state: &SharedState,
    channel_id: Uuid,
    user_id: Uuid,
    content: &str,
) -> AppResult<Message> {
    validate_content(content, false)?;
    let id = insert_message(state, channel_id, user_id, None, content, None, false).await?;
    let message = load_message(&state.pool, id, user_id).await?;
    publish_message(state, channel_id, user_id, &message).await?;
    Ok(message)
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
    require_member(&state.pool, channel_id, auth.id).await?;

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
    pub encrypted: Option<bool>,
    pub parent_id: Option<String>,
    /// Id of a message in the same channel this one quote-replies to (WhatsApp-style).
    pub reply_to_id: Option<String>,
    /// Ids of the caller's pending uploads to attach to this message.
    pub attachment_ids: Option<Vec<Uuid>>,
}

pub async fn create_message(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CreateMessageRequest>,
) -> AppResult<(StatusCode, Json<Message>)> {
    require_can_post(&state.pool, channel_id, auth.id, POST_DENIED).await?;
    let encrypted = body.encrypted.unwrap_or(false);
    if encrypted && channel_kind(&state.pool, channel_id).await?.as_deref() != Some("dm") {
        return Err(AppError::BadRequest(
            "encrypted messages are only allowed in DMs".to_string(),
        ));
    }

    let attachment_ids: Vec<Uuid> = body.attachment_ids.clone().unwrap_or_default();
    // Content may be empty only when the message carries at least one attachment —
    // and only if the ids actually resolve to the caller's own unattached uploads in
    // this channel (otherwise bogus ids would persist a permanently blank message).
    if encrypted {
        validate_content(&body.content, true)?;
    } else if body.content.trim().is_empty() {
        if attachment_ids.is_empty() {
            return Err(AppError::Validation(
                "content must not be empty".to_string(),
            ));
        }
        let row = sqlx::query(
            "SELECT count(*) AS c FROM files
             WHERE id = ANY($1) AND channel_id = $2 AND user_id = $3
               AND message_id IS NULL AND doc_id IS NULL",
        )
        .bind(&attachment_ids)
        .bind(channel_id)
        .bind(auth.id)
        .fetch_one(&state.pool)
        .await?;
        if row.try_get::<i64, _>("c")? == 0 {
            return Err(AppError::Validation(
                "content must not be empty".to_string(),
            ));
        }
    } else {
        validate_content(&body.content, false)?;
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
                return Err(AppError::BadRequest("cannot reply to a reply".to_string()));
            }
            Some(pid)
        }
        _ => None,
    };

    // Quote-reply target: any (non-deleted) message in this same channel.
    let reply_to_id: Option<i64> = match body.reply_to_id {
        Some(ref s) if !s.is_empty() => {
            let rid = s
                .parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid reply_to_id".to_string()))?;
            let meta = message_meta(&state.pool, rid).await?;
            if meta.channel_id != channel_id {
                return Err(AppError::BadRequest(
                    "quoted message is in a different channel".to_string(),
                ));
            }
            if meta.deleted {
                return Err(AppError::BadRequest(
                    "cannot quote a deleted message".to_string(),
                ));
            }
            Some(rid)
        }
        _ => None,
    };

    let new_id = insert_message(
        &state,
        channel_id,
        auth.id,
        parent_id,
        &body.content,
        reply_to_id,
        encrypted,
    )
    .await?;

    // Attach the caller's pending uploads (their own, in this channel, unattached).
    if !attachment_ids.is_empty() {
        sqlx::query(
            "UPDATE files SET message_id = $1
             WHERE id = ANY($2) AND channel_id = $3 AND user_id = $4
               AND message_id IS NULL AND doc_id IS NULL",
        )
        .bind(new_id)
        .bind(&attachment_ids)
        .bind(channel_id)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    }

    let message = load_message(&state.pool, new_id, auth.id).await?;
    publish_message(&state, channel_id, auth.id, &message).await?;

    Ok((StatusCode::CREATED, Json(message)))
}

pub async fn get_thread(
    State(state): State<SharedState>,
    Path(id): Path<i64>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let meta = message_meta(&state.pool, id).await?;
    require_member(&state.pool, meta.channel_id, auth.id).await?;

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
    pub encrypted: Option<bool>,
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
    require_can_post(&state.pool, meta.channel_id, auth.id, POST_DENIED).await?;
    if meta.deleted {
        return Err(AppError::BadRequest(
            "cannot edit a deleted message".to_string(),
        ));
    }
    let encrypted = body.encrypted.unwrap_or(false);
    if encrypted != meta.encrypted {
        return Err(AppError::BadRequest(
            "message encryption flag cannot be changed".to_string(),
        ));
    }
    if encrypted && channel_kind(&state.pool, meta.channel_id).await?.as_deref() != Some("dm") {
        return Err(AppError::BadRequest(
            "encrypted messages are only allowed in DMs".to_string(),
        ));
    }
    validate_content(&body.content, encrypted)?;

    sqlx::query(
        "UPDATE messages SET content = $1, encrypted = $2, edited_at = now() WHERE id = $3",
    )
    .bind(&body.content)
    .bind(encrypted)
    .bind(id)
    .execute(&state.pool)
    .await?;

    // Sharpy: drop the stale embedding so the worker re-embeds the new content.
    crate::routes::sharpy::drop_message_embedding(&state, id).await;

    let message = load_message(&state.pool, id, auth.id).await?;

    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    let ev = envelope("message.updated", json!({ "message": &message }));
    state.hub.broadcast(ev, targets).await;

    // An edit can add, change or remove links, so the cards are re-derived from
    // the new text. `message.updated` carries the old set; `message.previews`
    // corrects it a moment later.
    if !encrypted {
        unfurl::spawn_reunfurl(&state, id, meta.channel_id, body.content.clone());
    }

    Ok(Json(message))
}

/// Author-only: drop this message's link cards and keep them off, including
/// across later edits. The message text is untouched — the link still reads as a
/// link, it just stops taking up a card's worth of the channel.
pub async fn hide_previews(
    State(state): State<SharedState>,
    Path(id): Path<i64>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = message_meta(&state.pool, id).await?;
    if meta.user_id != auth.id {
        return Err(AppError::Forbidden("not the author".to_string()));
    }
    require_member(&state.pool, meta.channel_id, auth.id).await?;

    sqlx::query("UPDATE messages SET previews_hidden = true WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    unfurl::broadcast_previews(&state, id, meta.channel_id, &[]).await?;

    Ok(StatusCode::NO_CONTENT)
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
    require_member(&state.pool, meta.channel_id, auth.id).await?;

    if !meta.deleted {
        sqlx::query("UPDATE messages SET deleted_at = now(), content = '' WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await?;
    }

    // Sharpy: forget the deleted message.
    crate::routes::sharpy::drop_message_embedding(&state, id).await;

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

/// Soft-delete an internal card message and publish its full updated shape.
pub(crate) async fn soft_delete_card_message(
    state: &SharedState,
    id: i64,
    viewer: Uuid,
) -> AppResult<()> {
    let meta = message_meta(&state.pool, id).await?;
    if !meta.deleted {
        sqlx::query("UPDATE messages SET deleted_at = now(), content = '' WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    // Sharpy: forget the soft-deleted card message.
    crate::routes::sharpy::drop_message_embedding(&state, id).await;

    let message = load_message(&state.pool, id, viewer).await?;
    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    state
        .hub
        .broadcast(
            envelope("message.updated", json!({ "message": message })),
            targets,
        )
        .await;
    Ok(())
}

pub async fn add_reaction(
    State(state): State<SharedState>,
    Path((id, emoji)): Path<(i64, String)>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = message_meta(&state.pool, id).await?;
    require_can_post(&state.pool, meta.channel_id, auth.id, POST_DENIED).await?;
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
    require_member(&state.pool, meta.channel_id, auth.id).await?;

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
