use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::ser_opt_i64_string;
use crate::notify;
use crate::routes::{channel_kind, is_member, member_role};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct VoterRef {
    pub id: Uuid,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PollOption {
    pub id: Uuid,
    pub position: i16,
    pub text: String,
    pub count: i64,
    pub voters: Vec<VoterRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Poll {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub creator_id: Uuid,
    #[serde(serialize_with = "ser_opt_i64_string")]
    pub card_message_id: Option<i64>,
    pub question: String,
    pub multi: bool,
    pub pinned: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub closed_reason: Option<String>,
    pub deleted: bool,
    pub created_at: DateTime<Utc>,
    pub options: Vec<PollOption>,
    pub my_votes: Vec<Uuid>,
    pub total_voters: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreatePollRequest {
    pub question: String,
    pub options: Vec<String>,
    pub multi: bool,
    pub pinned: bool,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct VoteRequest {
    pub option_ids: Vec<Uuid>,
}

#[derive(Deserialize)]
pub struct PinRequest {
    pub pinned: bool,
}

#[derive(Deserialize)]
pub struct ListPollsQuery {
    pub active: Option<String>,
}

struct PollMeta {
    channel_id: Uuid,
    creator_id: Uuid,
    card_message_id: Option<i64>,
    closed_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    deleted: bool,
}

async fn poll_meta(pool: &PgPool, poll_id: Uuid) -> AppResult<PollMeta> {
    let row = sqlx::query(
        "SELECT channel_id, creator_id, card_message_id, closed_at, expires_at, deleted_at
         FROM polls WHERE id = $1",
    )
    .bind(poll_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("poll not found".to_string()))?;
    Ok(PollMeta {
        channel_id: row.try_get("channel_id")?,
        creator_id: row.try_get("creator_id")?,
        card_message_id: row.try_get("card_message_id")?,
        closed_at: row.try_get("closed_at")?,
        expires_at: row.try_get("expires_at")?,
        deleted: row
            .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
            .is_some(),
    })
}

pub async fn load_poll(pool: &PgPool, poll_id: Uuid, viewer: Option<Uuid>) -> AppResult<Poll> {
    let row = sqlx::query(
        "SELECT id, channel_id, creator_id, card_message_id, question, multi, pinned,
                expires_at, closed_at, closed_reason, deleted_at, created_at,
                (SELECT count(DISTINCT user_id) FROM poll_votes WHERE poll_id = p.id) AS total_voters
         FROM polls p WHERE id = $1",
    )
    .bind(poll_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("poll not found".to_string()))?;

    let option_rows = sqlx::query(
        "SELECT o.id, o.position, o.text, v.user_id, u.display_name
         FROM poll_options o
         LEFT JOIN poll_votes v ON v.poll_id = o.poll_id AND v.option_id = o.id
         LEFT JOIN users u ON u.id = v.user_id
         WHERE o.poll_id = $1
         ORDER BY o.position, v.voted_at, v.user_id",
    )
    .bind(poll_id)
    .fetch_all(pool)
    .await?;

    let mut options: Vec<PollOption> = Vec::new();
    let mut indexes: HashMap<Uuid, usize> = HashMap::new();
    for option_row in option_rows {
        let option_id: Uuid = option_row.try_get("id")?;
        let index = match indexes.get(&option_id) {
            Some(index) => *index,
            None => {
                let index = options.len();
                options.push(PollOption {
                    id: option_id,
                    position: option_row.try_get("position")?,
                    text: option_row.try_get("text")?,
                    count: 0,
                    voters: Vec::new(),
                });
                indexes.insert(option_id, index);
                index
            }
        };
        if let Some(user_id) = option_row.try_get::<Option<Uuid>, _>("user_id")? {
            options[index].voters.push(VoterRef {
                id: user_id,
                display_name: option_row
                    .try_get::<Option<String>, _>("display_name")?
                    .unwrap_or_default(),
            });
            options[index].count += 1;
        }
    }

    let my_votes = if let Some(viewer) = viewer {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2 ORDER BY option_id",
        )
        .bind(poll_id)
        .bind(viewer)
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };
    let deleted_at: Option<DateTime<Utc>> = row.try_get("deleted_at")?;
    Ok(Poll {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        creator_id: row.try_get("creator_id")?,
        card_message_id: row.try_get("card_message_id")?,
        question: row.try_get("question")?,
        multi: row.try_get("multi")?,
        pinned: row.try_get("pinned")?,
        expires_at: row.try_get("expires_at")?,
        closed_at: row.try_get("closed_at")?,
        closed_reason: row.try_get("closed_reason")?,
        deleted: deleted_at.is_some(),
        created_at: row.try_get("created_at")?,
        options,
        my_votes,
        total_voters: row.try_get("total_voters")?,
    })
}

pub(crate) fn validate_create(body: &CreatePollRequest) -> AppResult<(String, Vec<String>)> {
    let question = body.question.trim().to_string();
    if question.is_empty() || question.chars().count() > 500 {
        return Err(AppError::Validation(
            "question must be between 1 and 500 characters".to_string(),
        ));
    }
    if !(2..=10).contains(&body.options.len()) {
        return Err(AppError::Validation(
            "options must contain 2 to 10 items".to_string(),
        ));
    }
    let mut seen = HashSet::new();
    let mut options = Vec::with_capacity(body.options.len());
    for raw in &body.options {
        let text = raw.trim().to_string();
        if text.is_empty() || text.chars().count() > 100 {
            return Err(AppError::Validation(
                "each option must be between 1 and 100 characters".to_string(),
            ));
        }
        if !seen.insert(text.clone()) {
            return Err(AppError::Validation("options must be unique".to_string()));
        }
        options.push(text);
    }
    if body
        .expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now())
    {
        return Err(AppError::Validation(
            "expires_at must be in the future".to_string(),
        ));
    }
    Ok((question, options))
}

async fn require_member(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(&state.pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
    }
    Ok(())
}

async fn require_can_post(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let kind = channel_kind(&state.pool, channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("channel not found".to_string()))?;
    if kind == "dm" {
        return Err(AppError::BadRequest(
            "polls are not allowed in DMs".to_string(),
        ));
    }
    if !member_role(&state.pool, channel_id, user_id)
        .await?
        .is_some_and(|role| role.can_post())
    {
        return Err(AppError::Forbidden(
            "posting requires owner or editor role".to_string(),
        ));
    }
    Ok(())
}

fn token_field(value: &str) -> String {
    value.replace(['|', ']', '\n'], " ").trim().to_string()
}

pub async fn create_poll_shared(
    state: &SharedState,
    channel_id: Uuid,
    creator_id: Uuid,
    body: &CreatePollRequest,
) -> AppResult<Poll> {
    require_can_post(state, channel_id, creator_id).await?;
    let (question, options) = validate_create(body)?;
    let mut tx = state.pool.begin().await?;
    let poll_id: Uuid = sqlx::query_scalar(
        "INSERT INTO polls (channel_id, creator_id, question, multi, pinned, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(channel_id)
    .bind(creator_id)
    .bind(&question)
    .bind(body.multi)
    .bind(body.pinned)
    .bind(body.expires_at)
    .fetch_one(&mut *tx)
    .await?;
    for (position, text) in options.iter().enumerate() {
        sqlx::query("INSERT INTO poll_options (poll_id, position, text) VALUES ($1, $2, $3)")
            .bind(poll_id)
            .bind(position as i16)
            .bind(text)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let token = format!("[[poll:{}|{}]]", poll_id, token_field(&question));
    let message =
        match crate::routes::messages::post_message_as(state, channel_id, creator_id, &token).await
        {
            Ok(message) => message,
            Err(error) => {
                let _ = sqlx::query("DELETE FROM polls WHERE id = $1")
                    .bind(poll_id)
                    .execute(&state.pool)
                    .await;
                return Err(error);
            }
        };
    sqlx::query("UPDATE polls SET card_message_id = $1 WHERE id = $2")
        .bind(message.id)
        .bind(poll_id)
        .execute(&state.pool)
        .await?;
    let poll = load_poll(&state.pool, poll_id, Some(creator_id)).await?;
    broadcast_poll(state, "poll.created", &poll).await?;
    Ok(poll)
}

async fn broadcast_poll(state: &SharedState, event_type: &str, poll: &Poll) -> AppResult<()> {
    let targets = channel_member_ids(&state.pool, poll.channel_id).await?;
    for target in targets {
        let personalized = load_poll(&state.pool, poll.id, Some(target)).await?;
        state
            .hub
            .broadcast(
                envelope(event_type, json!({ "poll": personalized })),
                vec![target],
            )
            .await;
    }
    Ok(())
}

pub async fn create_poll(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CreatePollRequest>,
) -> AppResult<(StatusCode, Json<Poll>)> {
    let poll = create_poll_shared(&state, channel_id, auth.id, &body).await?;
    Ok((StatusCode::CREATED, Json(poll)))
}

pub async fn replace_votes(
    state: &SharedState,
    poll_id: Uuid,
    user_id: Uuid,
    option_ids: &[Uuid],
    emit: bool,
) -> AppResult<Poll> {
    let unique: HashSet<Uuid> = option_ids.iter().copied().collect();
    if unique.len() != option_ids.len() {
        return Err(AppError::Validation(
            "option_ids must be unique".to_string(),
        ));
    }
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT channel_id, multi, closed_at, expires_at, deleted_at
         FROM polls WHERE id = $1 FOR UPDATE",
    )
    .bind(poll_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("poll not found".to_string()))?;
    let channel_id: Uuid = row.try_get("channel_id")?;
    let member =
        sqlx::query("SELECT 1 AS x FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if member.is_none() {
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
    }
    let deleted_at: Option<DateTime<Utc>> = row.try_get("deleted_at")?;
    let closed_at: Option<DateTime<Utc>> = row.try_get("closed_at")?;
    let expires_at: Option<DateTime<Utc>> = row.try_get("expires_at")?;
    if deleted_at.is_some() || closed_at.is_some() || expires_at.is_some_and(|at| at <= Utc::now())
    {
        return Err(AppError::BadRequest("poll is closed".to_string()));
    }
    if !row.try_get::<bool, _>("multi")? && option_ids.len() > 1 {
        return Err(AppError::Validation(
            "single-choice poll accepts at most one option".to_string(),
        ));
    }
    if !option_ids.is_empty() {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM poll_options WHERE poll_id = $1 AND id = ANY($2)",
        )
        .bind(poll_id)
        .bind(option_ids)
        .fetch_one(&mut *tx)
        .await?;
        if count != option_ids.len() as i64 {
            return Err(AppError::BadRequest(
                "option does not belong to poll".to_string(),
            ));
        }
    }
    sqlx::query("DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2")
        .bind(poll_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    for option_id in option_ids {
        sqlx::query("INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)")
            .bind(poll_id)
            .bind(option_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let poll = load_poll(&state.pool, poll_id, Some(user_id)).await?;
    if emit {
        broadcast_poll(state, "poll.updated", &poll).await?;
    }
    crate::ws::voice::broadcast_for_persistent_poll(state, poll_id).await;
    Ok(poll)
}

pub async fn vote(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<VoteRequest>,
) -> AppResult<Json<Poll>> {
    Ok(Json(
        replace_votes(&state, poll_id, auth.id, &body.option_ids, true).await?,
    ))
}

pub async fn retract_vote(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<Poll>> {
    Ok(Json(
        replace_votes(&state, poll_id, auth.id, &[], true).await?,
    ))
}

async fn require_creator_or_owner(
    state: &SharedState,
    meta: &PollMeta,
    user_id: Uuid,
) -> AppResult<()> {
    if meta.creator_id == user_id
        || member_role(&state.pool, meta.channel_id, user_id)
            .await?
            .is_some_and(|role| role.is_owner())
    {
        return Ok(());
    }
    Err(AppError::Forbidden(
        "poll creator or channel owner required".to_string(),
    ))
}

pub async fn finalize_poll_and_notify(
    state: &SharedState,
    poll_id: Uuid,
    reason: &str,
) -> AppResult<Option<Poll>> {
    let claimed = sqlx::query(
        "UPDATE polls
         SET closed_at = COALESCE(closed_at, now()), closed_reason = $2, closed_notified_at = now()
         WHERE id = $1 AND closed_notified_at IS NULL
         RETURNING id",
    )
    .bind(poll_id)
    .bind(reason)
    .fetch_optional(&state.pool)
    .await?;
    if claimed.is_none() {
        return Ok(None);
    }
    let poll = load_poll(&state.pool, poll_id, None).await?;
    broadcast_poll(state, "poll.updated", &poll).await?;
    notify::dispatch_poll_ended(state, &poll).await;
    crate::ws::voice::broadcast_for_persistent_poll(state, poll_id).await;
    Ok(Some(poll))
}

pub async fn close_poll(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<Poll>> {
    let meta = poll_meta(&state.pool, poll_id).await?;
    require_creator_or_owner(&state, &meta, auth.id).await?;
    if meta.deleted {
        return Err(AppError::BadRequest("poll is deleted".to_string()));
    }
    if let Some(poll) = finalize_poll_and_notify(&state, poll_id, "manual").await? {
        return Ok(Json(load_poll(&state.pool, poll.id, Some(auth.id)).await?));
    }
    Ok(Json(load_poll(&state.pool, poll_id, Some(auth.id)).await?))
}

pub async fn pin_poll(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<PinRequest>,
) -> AppResult<Json<Poll>> {
    let meta = poll_meta(&state.pool, poll_id).await?;
    require_creator_or_owner(&state, &meta, auth.id).await?;
    if meta.deleted
        || meta.closed_at.is_some()
        || meta.expires_at.is_some_and(|at| at <= Utc::now())
    {
        return Err(AppError::BadRequest("poll is closed".to_string()));
    }
    let result = sqlx::query(
        "UPDATE polls SET pinned = $2 WHERE id = $1 AND closed_at IS NULL
         AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(poll_id)
    .bind(body.pinned)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::BadRequest("poll is closed".to_string()));
    }
    let poll = load_poll(&state.pool, poll_id, Some(auth.id)).await?;
    broadcast_poll(&state, "poll.updated", &poll).await?;
    Ok(Json(poll))
}

pub async fn delete_poll(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let meta = poll_meta(&state.pool, poll_id).await?;
    if meta.creator_id != auth.id {
        return Err(AppError::Forbidden("poll creator required".to_string()));
    }
    sqlx::query("UPDATE polls SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1")
        .bind(poll_id)
        .execute(&state.pool)
        .await?;
    if let Some(message_id) = meta.card_message_id {
        crate::routes::messages::soft_delete_card_message(&state, message_id, auth.id).await?;
    }
    let targets = channel_member_ids(&state.pool, meta.channel_id).await?;
    state
        .hub
        .broadcast(
            envelope(
                "poll.deleted",
                json!({
                    "poll_id": poll_id,
                    "channel_id": meta.channel_id,
                    "message_id": meta.card_message_id.map(|id| id.to_string()),
                }),
            ),
            targets,
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_poll(
    State(state): State<SharedState>,
    Path(poll_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<Poll>> {
    let meta = poll_meta(&state.pool, poll_id).await?;
    require_member(&state, meta.channel_id, auth.id).await?;
    Ok(Json(load_poll(&state.pool, poll_id, Some(auth.id)).await?))
}

pub async fn list_polls(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Query(query): Query<ListPollsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    require_member(&state, channel_id, auth.id).await?;
    let active = query.active.as_deref() == Some("1");
    let ids = if active {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM polls WHERE channel_id = $1 AND closed_at IS NULL
             AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
             ORDER BY created_at DESC",
        )
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM polls WHERE channel_id = $1 ORDER BY created_at DESC",
        )
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await?
    };
    let mut polls = Vec::with_capacity(ids.len());
    for id in ids {
        polls.push(load_poll(&state.pool, id, Some(auth.id)).await?);
    }
    Ok(Json(json!({ "polls": polls })))
}

pub async fn expire_tick(state: &SharedState) -> AppResult<()> {
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM polls WHERE expires_at <= now() AND closed_at IS NULL
         AND deleted_at IS NULL AND closed_notified_at IS NULL",
    )
    .fetch_all(&state.pool)
    .await?;
    for id in ids {
        finalize_poll_and_notify(state, id, "expired").await?;
    }
    crate::ws::voice::expire_call_polls(state).await;
    Ok(())
}
