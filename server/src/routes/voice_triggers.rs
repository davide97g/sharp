use crate::auth::VoiceConfigAuth;
use crate::error::{AppError, AppResult};
use crate::models::VoiceTrigger;
use crate::routes::{channel_kind, member_role, ChannelRole};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct CreateVoiceTriggerRequest {
    phrase: String,
}

pub(crate) fn normalize_trigger_phrase(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn validate_phrase(phrase: &str) -> AppResult<String> {
    let phrase = normalize_trigger_phrase(phrase);
    if !(2..=80).contains(&phrase.chars().count()) {
        return Err(AppError::Validation(
            "phrase must be between 2 and 80 characters".to_string(),
        ));
    }
    Ok(phrase)
}

fn registered_user(auth: VoiceConfigAuth) -> AppResult<Uuid> {
    if auth.guest {
        return Err(AppError::Forbidden(
            "guest users cannot manage voice triggers".to_string(),
        ));
    }
    Ok(auth.id)
}

pub(crate) fn map_voice_trigger_row(row: &PgRow) -> AppResult<VoiceTrigger> {
    Ok(VoiceTrigger {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        user_id: row.try_get("user_id")?,
        phrase: row.try_get("phrase")?,
        action: row.try_get("action")?,
        created_at: row.try_get("created_at")?,
    })
}

fn duplicate_error(error: sqlx::Error) -> AppError {
    if error
        .as_database_error()
        .and_then(|database_error| database_error.code())
        .as_deref()
        == Some("23505")
    {
        AppError::Conflict("voice trigger phrase already exists".to_string())
    } else {
        AppError::from(error)
    }
}

async fn require_channel_member(
    state: &SharedState,
    channel_id: Uuid,
    user_id: Uuid,
) -> AppResult<ChannelRole> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    member_role(&state.pool, channel_id, user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("not a member of this channel".to_string()))
}

async fn require_channel_editor(
    state: &SharedState,
    channel_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    if !require_channel_member(state, channel_id, user_id)
        .await?
        .can_post()
    {
        return Err(AppError::Forbidden(
            "editing voice triggers requires owner or editor role".to_string(),
        ));
    }
    Ok(())
}

pub async fn list_personal(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
) -> AppResult<Json<serde_json::Value>> {
    let user_id = registered_user(auth)?;
    let rows = sqlx::query(
        "SELECT id, channel_id, user_id, phrase, action, created_at
         FROM voice_triggers
         WHERE user_id = $1 AND channel_id IS NULL
         ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let triggers = rows
        .iter()
        .map(map_voice_trigger_row)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "triggers": triggers })))
}

pub async fn create_personal(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
    Json(body): Json<CreateVoiceTriggerRequest>,
) -> AppResult<(StatusCode, Json<VoiceTrigger>)> {
    let user_id = registered_user(auth)?;
    let phrase = validate_phrase(&body.phrase)?;
    let row = sqlx::query(
        "INSERT INTO voice_triggers (user_id, phrase)
         VALUES ($1, $2)
         RETURNING id, channel_id, user_id, phrase, action, created_at",
    )
    .bind(user_id)
    .bind(phrase)
    .fetch_one(&state.pool)
    .await
    .map_err(duplicate_error)?;
    Ok((StatusCode::CREATED, Json(map_voice_trigger_row(&row)?)))
}

pub async fn delete_personal(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
    Path(trigger_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id = registered_user(auth)?;
    let result = sqlx::query(
        "DELETE FROM voice_triggers
         WHERE id = $1 AND user_id = $2 AND channel_id IS NULL",
    )
    .bind(trigger_id)
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("voice trigger not found".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_channel(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
    Path(channel_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id = registered_user(auth)?;
    require_channel_member(&state, channel_id, user_id).await?;
    let rows = sqlx::query(
        "SELECT id, channel_id, user_id, phrase, action, created_at
         FROM voice_triggers
         WHERE channel_id = $1
         ORDER BY created_at, id",
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?;
    let triggers = rows
        .iter()
        .map(map_voice_trigger_row)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "triggers": triggers })))
}

pub async fn create_channel(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<CreateVoiceTriggerRequest>,
) -> AppResult<(StatusCode, Json<VoiceTrigger>)> {
    let user_id = registered_user(auth)?;
    require_channel_editor(&state, channel_id, user_id).await?;
    let phrase = validate_phrase(&body.phrase)?;
    let row = sqlx::query(
        "INSERT INTO voice_triggers (channel_id, user_id, phrase)
         VALUES ($1, $2, $3)
         RETURNING id, channel_id, user_id, phrase, action, created_at",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(phrase)
    .fetch_one(&state.pool)
    .await
    .map_err(duplicate_error)?;
    let trigger = map_voice_trigger_row(&row)?;
    let targets = channel_member_ids(&state.pool, channel_id).await?;
    state
        .hub
        .broadcast(
            envelope(
                "voice_trigger.created",
                json!({ "channel_id": channel_id, "trigger": &trigger }),
            ),
            targets,
        )
        .await;
    Ok((StatusCode::CREATED, Json(trigger)))
}

pub async fn delete_channel(
    State(state): State<SharedState>,
    auth: VoiceConfigAuth,
    Path((channel_id, trigger_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = registered_user(auth)?;
    require_channel_editor(&state, channel_id, user_id).await?;
    let result = sqlx::query("DELETE FROM voice_triggers WHERE id = $1 AND channel_id = $2")
        .bind(trigger_id)
        .bind(channel_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("voice trigger not found".to_string()));
    }
    let targets = channel_member_ids(&state.pool, channel_id).await?;
    state
        .hub
        .broadcast(
            envelope(
                "voice_trigger.deleted",
                json!({ "channel_id": channel_id, "trigger_id": trigger_id }),
            ),
            targets,
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
