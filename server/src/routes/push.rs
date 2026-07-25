//! Push-subscription registration for the three transports.
//!
//! Contract: docs/arch/05-files-notifications.md ("Storage & push implementation").
//!
//! Registration only — *delivery* lives in `crate::notify` (`deliver_push`), and the
//! per-transport visibility rules live there too. Never send a push from this module.
//!
//! The three transports and their gating:
//!   - **Web push** (VAPID/RFC 8291). Keys resolve env -> persisted in `app_meta` ->
//!     auto-generated, so it is zero-config; `crate::vapid` owns that. Dead
//!     subscriptions (404/410) are pruned on send.
//!   - **APNs** for the signed macOS desktop build. Inert unless every `APNS_*` variable
//!     is set. Unsigned builds silently never register, which is expected.
//!   - **Expo** for the native mobile app in `mobile/`.
//!
//! `endpoint_allowed` is a security control, not a convenience: the endpoint URL arrives
//! from the client and the server then makes requests to it, so it must stay restricted to
//! known push services or it becomes an SSRF primitive. Its unit tests are at the bottom.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

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

#[cfg(test)]
mod push_endpoint_tests {
    use super::endpoint_allowed;

    #[test]
    fn accepts_public_https_push_endpoints() {
        assert!(endpoint_allowed("https://fcm.googleapis.com/fcm/send/example"));
        assert!(endpoint_allowed("https://updates.push.services.mozilla.com/wpush/v2/example"));
    }

    #[test]
    fn rejects_non_https_and_private_push_endpoints() {
        for endpoint in [
            "http://push.example.com/send",
            "https://localhost/send",
            "https://127.0.0.1/send",
            "https://10.0.0.1/send",
            "https://172.16.0.1/send",
            "https://192.168.1.10/send",
            "https://169.254.169.254/latest/meta-data",
            "https://service.internal/send",
        ] {
            assert!(!endpoint_allowed(endpoint), "accepted {endpoint}");
        }
    }
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

// ---- APNs (native macOS desktop) push ----

#[derive(Deserialize)]
pub struct ApnsRegisterRequest {
    /// Hex APNs device token from the macOS shell's remote-notification callback.
    pub token: String,
}

pub async fn apns_register(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ApnsRegisterRequest>,
) -> AppResult<StatusCode> {
    let token = body.token.trim();
    // APNs device tokens are lowercase hex, historically 64 chars but not fixed.
    if token.is_empty() || token.len() > 200 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("invalid APNs device token".to_string()));
    }
    sqlx::query(
        "INSERT INTO apns_tokens (user_id, token) VALUES ($1, $2)
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id",
    )
    .bind(auth.id)
    .bind(token)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ApnsUnregisterRequest {
    pub token: String,
}

pub async fn apns_unregister(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ApnsUnregisterRequest>,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM apns_tokens WHERE token = $1 AND user_id = $2")
        .bind(body.token.trim())
        .bind(auth.id)
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
