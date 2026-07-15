use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::notify;
use crate::routes::channel_kind;
use crate::state::SharedState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

// ---- inbox ----

#[derive(Deserialize)]
pub struct ListQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_notifications(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let before: Option<i64> = match q.before {
        Some(ref s) if !s.is_empty() => Some(
            s.parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid before cursor".to_string()))?,
        ),
        _ => None,
    };
    let limit = q.limit.unwrap_or(30).clamp(1, 100);

    let notifications = notify::list_for_user(&state.pool, auth.id, before, limit).await?;
    let unread_count = notify::unread_count(&state.pool, auth.id).await?;

    Ok(Json(json!({
        "notifications": notifications,
        "unread_count": unread_count,
    })))
}

#[derive(Deserialize)]
pub struct ReadRequest {
    pub ids: Option<Vec<String>>,
    pub all: Option<bool>,
}

pub async fn mark_read(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ReadRequest>,
) -> AppResult<StatusCode> {
    if body.all.unwrap_or(false) {
        sqlx::query(
            "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
        )
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(ids) = body.ids {
        let parsed: Vec<i64> = ids.iter().filter_map(|s| s.parse::<i64>().ok()).collect();
        if !parsed.is_empty() {
            sqlx::query(
                "UPDATE notifications SET read_at = now()
                 WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL",
            )
            .bind(auth.id)
            .bind(&parsed)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- preferences ----

pub async fn get_prefs(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let prefs_row = sqlx::query("SELECT dnd, chat_layout FROM user_prefs WHERE user_id = $1")
        .bind(auth.id)
        .fetch_optional(&state.pool)
        .await?;
    let dnd: bool = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<bool, _>("dnd").ok())
        .unwrap_or(false);
    let chat_layout: Option<String> = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("chat_layout").ok())
        .flatten();

    let rows = sqlx::query(
        "SELECT channel_id FROM channel_prefs WHERE user_id = $1 AND muted = true",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;
    let mut muted: Vec<String> = Vec::with_capacity(rows.len());
    for row in &rows {
        muted.push(row.try_get::<Uuid, _>("channel_id")?.to_string());
    }

    Ok(Json(
        json!({ "dnd": dnd, "muted_channel_ids": muted, "chat_layout": chat_layout }),
    ))
}

#[derive(Deserialize)]
pub struct DndRequest {
    pub dnd: bool,
}

#[derive(Deserialize)]
pub struct ChatLayoutRequest {
    pub chat_layout: String,
}

pub async fn set_chat_layout(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ChatLayoutRequest>,
) -> AppResult<StatusCode> {
    if body.chat_layout != "bubble" && body.chat_layout != "classic" {
        return Err(AppError::Validation(
            "chat_layout must be 'bubble' or 'classic'".to_string(),
        ));
    }
    sqlx::query(
        "INSERT INTO user_prefs (user_id, chat_layout) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET chat_layout = EXCLUDED.chat_layout",
    )
    .bind(auth.id)
    .bind(&body.chat_layout)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_dnd(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<DndRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        "INSERT INTO user_prefs (user_id, dnd) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET dnd = EXCLUDED.dnd",
    )
    .bind(auth.id)
    .bind(body.dnd)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct MuteRequest {
    pub muted: bool,
}

pub async fn set_channel_pref(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<MuteRequest>,
) -> AppResult<StatusCode> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    sqlx::query(
        "INSERT INTO channel_prefs (user_id, channel_id, muted) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET muted = EXCLUDED.muted",
    )
    .bind(auth.id)
    .bind(channel_id)
    .bind(body.muted)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- web push ----

pub async fn vapid_public(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> Json<serde_json::Value> {
    let key = state.vapid.as_ref().map(|v| v.public_b64.clone());
    Json(json!({ "public_key": key }))
}

#[derive(Deserialize)]
pub struct SubscribeKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub keys: SubscribeKeys,
}

/// The server later POSTs to this endpoint, so reject non-https and any host that
/// looks internal (loopback / link-local / private ranges) to prevent SSRF.
fn endpoint_allowed(endpoint: &str) -> bool {
    let rest = match endpoint.strip_prefix("https://") {
        Some(r) => r,
        None => return false,
    };
    // host = up to the first '/', '?' or '#'; strip any userinfo and port.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let h = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if h.is_empty()
        || h == "localhost"
        || h.ends_with(".local")
        || h.ends_with(".internal")
    {
        return false;
    }
    // IPv6 literals: block loopback / unique-local (fc00::/7) / link-local.
    // Guarded by ':' so hostnames like "fcm.googleapis.com" are NOT caught.
    if h.contains(':')
        && (h == "::1" || h.starts_with("fc") || h.starts_with("fd") || h.starts_with("fe80"))
    {
        return false;
    }
    // IPv4 loopback / private / link-local.
    if h.starts_with("127.")
        || h.starts_with("10.")
        || h.starts_with("192.168.")
        || h.starts_with("169.254.")
    {
        return false;
    }
    // 172.16.0.0 – 172.31.255.255
    if h.starts_with("172.") {
        if let Some(second) = h.split('.').nth(1) {
            if let Ok(n) = second.parse::<u8>() {
                if (16..=31).contains(&n) {
                    return false;
                }
            }
        }
    }
    true
}

pub async fn subscribe(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<SubscribeRequest>,
) -> AppResult<StatusCode> {
    if body.endpoint.trim().is_empty() {
        return Err(AppError::BadRequest("missing endpoint".to_string()));
    }
    if !endpoint_allowed(body.endpoint.trim()) {
        return Err(AppError::BadRequest(
            "push endpoint must be an https URL on a public host".to_string(),
        ));
    }
    sqlx::query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint)
         DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth",
    )
    .bind(auth.id)
    .bind(&body.endpoint)
    .bind(&body.keys.p256dh)
    .bind(&body.keys.auth)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct UnsubscribeRequest {
    pub endpoint: String,
}

pub async fn unsubscribe(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<UnsubscribeRequest>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(&body.endpoint)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- Expo mobile push ----

#[derive(Deserialize)]
pub struct ExpoRegisterRequest {
    pub token: String,
    pub platform: Option<String>,
}

pub async fn expo_register(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ExpoRegisterRequest>,
) -> AppResult<StatusCode> {
    let token = body.token.trim();
    if token.is_empty()
        || token.len() >= 512
        || !(token.starts_with("ExponentPushToken[") || token.starts_with("ExpoPushToken["))
    {
        return Err(AppError::BadRequest("invalid Expo push token".to_string()));
    }
    let platform = body.platform.unwrap_or_else(|| "ios".to_string());
    sqlx::query(
        "INSERT INTO expo_push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform",
    )
    .bind(auth.id)
    .bind(token)
    .bind(platform)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ExpoUnregisterRequest {
    pub token: String,
}

pub async fn expo_unregister(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ExpoUnregisterRequest>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM expo_push_tokens WHERE token = $1 AND user_id = $2")
        .bind(body.token.trim())
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
