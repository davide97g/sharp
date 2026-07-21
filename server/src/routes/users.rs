use crate::auth::{user_from_row, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::User;
use crate::state::SharedState;
use crate::ws::envelope;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

const USER_SELECT: &str = "SELECT id, email, display_name, avatar_url, created_at FROM users";

async fn load_user(state: &SharedState, id: Uuid) -> AppResult<User> {
    let sql = format!("{USER_SELECT} WHERE id = $1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("user not found".to_string()))?;
    user_from_row(&row)
}

/// Broadcast a profile change to every online user so avatars/names update live.
async fn broadcast_user_updated(state: &SharedState, user: &User) {
    let targets = state.hub.online_user_ids();
    // Fanned out to every viewer, so the email must be redacted; recipients
    // merge only the name/avatar and keep any email they already hold (their own).
    let user = user.clone().redacted();
    state
        .hub
        .broadcast(envelope("user.updated", json!({ "user": user })), targets)
        .await;
}

pub async fn me(State(state): State<SharedState>, auth: AuthUser) -> AppResult<Json<User>> {
    Ok(Json(load_user(&state, auth.id).await?))
}

pub async fn list_users(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let sql = format!("{USER_SELECT} ORDER BY display_name");
    let rows = sqlx::query(&sql).fetch_all(&state.pool).await?;
    let mut users = Vec::with_capacity(rows.len());
    for row in &rows {
        users.push(user_from_row(row)?.redact_email_for(auth.id));
    }

    let online: Vec<String> = state
        .hub
        .online_user_ids()
        .into_iter()
        .map(|u| u.to_string())
        .collect();

    Ok(Json(json!({ "users": users, "online_user_ids": online })))
}

#[derive(Deserialize)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
}

pub async fn update_me(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<UpdateMeRequest>,
) -> AppResult<Json<User>> {
    if let Some(name) = body.display_name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::Validation("display_name is required".to_string()));
        }
        if name.chars().count() > 80 {
            return Err(AppError::Validation(
                "display_name is too long (max 80 characters)".to_string(),
            ));
        }
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2")
            .bind(&name)
            .bind(auth.id)
            .execute(&state.pool)
            .await?;
    }

    let user = load_user(&state, auth.id).await?;
    broadcast_user_updated(&state, &user).await;
    Ok(Json(user))
}

/// Upload/replace the current user's avatar. The client sends an already-cropped
/// square image; we just store the bytes at a stable key and bump the URL version.
pub async fn upload_avatar(
    State(state): State<SharedState>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<Json<User>> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("file uploads are not configured".to_string()))?;

    let mut chosen: Option<(String, bytes::Bytes)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid upload: {e}")))?
    {
        let is_file = field.name() == Some("file") || field.file_name().is_some();
        if !is_file {
            continue;
        }
        let declared_type = field.content_type().map(|s| s.to_string());
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("upload too large or malformed: {e}")))?;
        let content_type = declared_type.unwrap_or_else(|| "image/png".to_string());
        chosen = Some((content_type, data));
        break;
    }

    let (content_type, data) =
        chosen.ok_or_else(|| AppError::BadRequest("no file field in upload".to_string()))?;

    if !content_type.starts_with("image/") || content_type == "image/svg+xml" {
        return Err(AppError::Validation(
            "avatar must be a raster image (png/jpeg/webp/gif)".to_string(),
        ));
    }
    if data.is_empty() {
        return Err(AppError::Validation("image is empty".to_string()));
    }
    if data.len() > state.config.max_upload_bytes {
        return Err(AppError::Validation(format!(
            "image exceeds the {} MB limit",
            state.config.max_upload_bytes / (1024 * 1024)
        )));
    }

    let key = format!("avatars/{}", auth.id);
    storage
        .put(&key, data)
        .await
        .map_err(|e| AppError::Internal(format!("storage put: {e}")))?;

    // Version token busts client caches for the stable proxy URL.
    let version = Uuid::new_v4().simple().to_string();
    let url = format!("/api/v1/users/{}/avatar?v={}", auth.id, version);
    sqlx::query("UPDATE users SET avatar_url = $1, avatar_content_type = $2 WHERE id = $3")
        .bind(&url)
        .bind(&content_type)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;

    let user = load_user(&state, auth.id).await?;
    broadcast_user_updated(&state, &user).await;
    Ok(Json(user))
}

pub async fn delete_avatar(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<User>> {
    if let Some(storage) = state.storage.as_ref() {
        let key = format!("avatars/{}", auth.id);
        let _ = storage.delete(&key).await; // best-effort; ignore missing
    }
    sqlx::query("UPDATE users SET avatar_url = NULL, avatar_content_type = NULL WHERE id = $1")
        .bind(auth.id)
        .execute(&state.pool)
        .await?;

    let user = load_user(&state, auth.id).await?;
    broadcast_user_updated(&state, &user).await;
    Ok(Json(user))
}

#[derive(Deserialize)]
pub struct AvatarQuery {
    #[allow(dead_code)]
    pub v: Option<String>,
}

/// Stream a user's avatar. Any authenticated user may fetch any avatar (they are
/// not channel-scoped); the `?v=` version is only a cache-buster.
pub async fn get_avatar(
    State(state): State<SharedState>,
    Path(user_id): Path<Uuid>,
    _auth: AuthUser,
    Query(_q): Query<AvatarQuery>,
) -> AppResult<Response> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| AppError::NotFound("avatar not found".to_string()))?;

    let row = sqlx::query("SELECT avatar_content_type FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("avatar not found".to_string()))?;
    let content_type: Option<String> = row.try_get("avatar_content_type")?;
    let content_type = content_type.ok_or_else(|| AppError::NotFound("avatar not found".to_string()))?;

    let key = format!("avatars/{user_id}");
    let result = storage
        .get(&key)
        .await
        .map_err(|_| AppError::NotFound("avatar not found".to_string()))?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&content_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        )
        .header(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        )
        // Immutable: the URL carries a version token, so a hit is always current.
        .header(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=31536000, immutable"),
        )
        .body(Body::from_stream(result.into_stream()))
        .map_err(|e| AppError::Internal(format!("response build: {e}")))?;

    Ok(response)
}

/// All personal nicknames the caller has set for other users.
pub async fn list_nicknames(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT target_user_id, nickname FROM user_nicknames WHERE viewer_id = $1",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;

    let mut nicknames = serde_json::Map::new();
    for row in &rows {
        let target: Uuid = row.try_get("target_user_id")?;
        let nickname: String = row.try_get("nickname")?;
        nicknames.insert(target.to_string(), json!(nickname));
    }
    Ok(Json(json!({ "nicknames": nicknames })))
}

#[derive(Deserialize)]
pub struct SetNicknameRequest {
    pub nickname: String,
}

/// Set or clear a personal nickname for another user. Empty/whitespace clears.
pub async fn set_nickname(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(target_id): Path<Uuid>,
    Json(body): Json<SetNicknameRequest>,
) -> AppResult<StatusCode> {
    if target_id == auth.id {
        return Err(AppError::Validation(
            "cannot set a nickname for yourself".to_string(),
        ));
    }
    let nickname = body.nickname.trim().to_string();
    if nickname.is_empty() {
        sqlx::query("DELETE FROM user_nicknames WHERE viewer_id = $1 AND target_user_id = $2")
            .bind(auth.id)
            .bind(target_id)
            .execute(&state.pool)
            .await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if nickname.chars().count() > 80 {
        return Err(AppError::Validation(
            "nickname is too long (max 80 characters)".to_string(),
        ));
    }
    // Ensure the target exists.
    let exists = sqlx::query("SELECT 1 AS x FROM users WHERE id = $1")
        .bind(target_id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("user not found".to_string()));
    }
    sqlx::query(
        "INSERT INTO user_nicknames (viewer_id, target_user_id, nickname, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (viewer_id, target_user_id)
         DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = now()",
    )
    .bind(auth.id)
    .bind(target_id)
    .bind(&nickname)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_nickname(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(target_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM user_nicknames WHERE viewer_id = $1 AND target_user_id = $2")
        .bind(auth.id)
        .bind(target_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
