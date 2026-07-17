use crate::auth::{create_guest_token, verify_claims, AuthUser};
use crate::error::{AppError, AppResult};
use crate::routes::{is_member, member_role};
use crate::state::SharedState;
use axum::extract::{Path, State};
use axum::Json;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// Generate a fresh 32-byte URL-safe random voice-link token.
fn generate_link_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// GET /channels/{id}/voice-link — current public voice link (member only).
pub async fn get_voice_link(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    if !is_member(&state.pool, channel_id, auth.id).await? {
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
    }

    let row = sqlx::query("SELECT voice_link_token FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("channel not found".to_string()))?;
    let token: Option<String> = row.try_get("voice_link_token")?;

    Ok(Json(json!({ "token": token })))
}

/// POST /channels/{id}/voice-link — generate a fresh link, replacing (revoking)
/// any previous value (owner/editor only).
pub async fn create_voice_link(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(channel_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    if !member_role(&state.pool, channel_id, auth.id)
        .await?
        .is_some_and(|role| role.can_post())
    {
        return Err(AppError::Forbidden(
            "creating call links requires owner or editor role".to_string(),
        ));
    }

    let token = generate_link_token();
    let result = sqlx::query("UPDATE channels SET voice_link_token = $1 WHERE id = $2")
        .bind(&token)
        .bind(channel_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("channel not found".to_string()));
    }

    Ok(Json(json!({ "token": token })))
}

/// GET /call-links/{token} — public metadata for a voice link (no auth).
pub async fn get_call_link(
    State(state): State<SharedState>,
    Path(token): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let row = sqlx::query("SELECT name, kind FROM channels WHERE voice_link_token = $1")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("call link not found".to_string()))?;

    let kind: String = row.try_get("kind")?;
    // DM channels carry a hidden generated name; never expose it publicly.
    let channel_name = if kind == "dm" {
        "Call".to_string()
    } else {
        row.try_get::<String, _>("name")?
    };

    Ok(Json(json!({ "channel_name": channel_name })))
}

#[derive(Deserialize)]
pub struct JoinCallLinkRequest {
    pub name: String,
}

/// POST /call-links/{token}/join — mint a limited guest token for the bound
/// channel's voice room (no auth).
pub async fn join_call_link(
    State(state): State<SharedState>,
    Path(token): Path<String>,
    Json(body): Json<JoinCallLinkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let name = body.name.trim().to_string();
    let len = name.chars().count();
    if len < 1 || len > 80 {
        return Err(AppError::Validation(
            "name must be between 1 and 80 characters".to_string(),
        ));
    }

    let row = sqlx::query("SELECT id FROM channels WHERE voice_link_token = $1")
        .bind(&token)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("call link not found".to_string()))?;
    let channel_id: Uuid = row.try_get("id")?;

    let guest_token = create_guest_token(&name, channel_id, &token, &state.config.jwt_secret)?;
    // Surface the minted guest subject so the client knows its own user_id.
    let (_, user_id) = verify_claims(&guest_token, &state.config.jwt_secret)
        .ok_or_else(|| AppError::Internal("failed to mint guest token".to_string()))?;

    Ok(Json(json!({
        "token": guest_token,
        "channel_id": channel_id.to_string(),
        "user_id": user_id.to_string(),
        "name": name,
    })))
}
