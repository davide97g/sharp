//! Best-effort Apple Push Notification service delivery (token-based / `.p8`
//! auth) for the native macOS desktop app, so it receives push while closed.
//!
//! Inert unless `APNS_*` is configured (`state.config.apns` is `None`). Like the
//! Expo and web-push channels, every failure is logged and swallowed — it never
//! reaches notification-dispatch callers.

use crate::config::ApnsConfig;
use crate::state::AppState;
use serde::Serialize;
use serde_json::json;
use sqlx::Row;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // reqwest negotiates HTTP/2 with APNs via ALPN; a plain client is enough.
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Serialize)]
struct Claims {
    iss: String,
    iat: i64,
}

/// A signed provider JWT is reused across sends. Apple rejects tokens that are
/// refreshed too often (`TooManyProviderTokenUpdates`) and treats tokens older
/// than an hour as expired, so we cache and rotate at ~50 minutes.
fn provider_jwt(config: &ApnsConfig) -> Option<String> {
    static CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().ok()?;
    if let Some((jwt, minted)) = guard.as_ref() {
        if minted.elapsed() < Duration::from_secs(50 * 60) {
            return Some(jwt.clone());
        }
    }

    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    let key = match jsonwebtoken::EncodingKey::from_ec_pem(config.private_key.as_bytes()) {
        Ok(key) => key,
        Err(e) => {
            tracing::warn!("apns: invalid .p8 private key: {}", e);
            return None;
        }
    };
    let claims = Claims {
        iss: config.team_id.clone(),
        iat: chrono::Utc::now().timestamp(),
    };
    match jsonwebtoken::encode(&header, &claims, &key) {
        Ok(jwt) => {
            *guard = Some((jwt.clone(), Instant::now()));
            Some(jwt)
        }
        Err(e) => {
            tracing::warn!("apns: sign provider token: {}", e);
            None
        }
    }
}

/// Send an alert to every APNs device registered for `user_id`. `path` is the
/// in-app deep link a tap should open; `tag` collapses repeats (APNs `thread-id`).
pub async fn send_to_user(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    path: &str,
    tag: &str,
) {
    if tokio::time::timeout(
        Duration::from_secs(10),
        send_inner(state, user_id, title, body, path, tag),
    )
    .await
    .is_err()
    {
        tracing::warn!("apns: send timed out for user {}", user_id);
    }
}

async fn send_inner(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    path: &str,
    tag: &str,
) {
    let Some(config) = &state.config.apns else {
        return;
    };
    let Some(jwt) = provider_jwt(config) else {
        return;
    };

    let rows = match sqlx::query("SELECT token FROM apns_tokens WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("apns: load tokens: {}", e);
            return;
        }
    };
    let tokens: Vec<String> = rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("token").ok())
        .collect();
    if tokens.is_empty() {
        return;
    }

    let host = if config.production {
        "https://api.push.apple.com"
    } else {
        "https://api.sandbox.push.apple.com"
    };
    let payload = json!({
        "aps": {
            "alert": { "title": title, "body": body },
            "sound": "default",
            "thread-id": tag,
        },
        "path": path,
    })
    .to_string();

    for token in &tokens {
        let response = client()
            .post(format!("{host}/3/device/{token}"))
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &config.bundle_id)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("content-type", "application/json")
            .body(payload.clone())
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(e) => {
                tracing::warn!("apns: send: {}", e);
                continue;
            }
        };
        let status = response.status();
        if status.is_success() {
            continue;
        }
        let reason = response.text().await.unwrap_or_default();
        // 410 = the device token is no longer active; 400/BadDeviceToken = invalid.
        // Either way the token is dead — prune it.
        if status.as_u16() == 410 || reason.contains("BadDeviceToken") || reason.contains("Unregistered")
        {
            if let Err(e) = sqlx::query("DELETE FROM apns_tokens WHERE token = $1")
                .bind(token)
                .execute(&state.pool)
                .await
            {
                tracing::warn!("apns: prune token: {}", e);
            }
        } else {
            tracing::warn!("apns: {} returned {}: {}", token, status, reason);
        }
    }
}
