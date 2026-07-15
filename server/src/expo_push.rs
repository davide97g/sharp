//! Best-effort Expo Push API delivery for native mobile clients.

use crate::state::AppState;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Deserialize)]
struct ExpoResponse {
    data: Vec<ExpoTicket>,
}

#[derive(Deserialize)]
struct ExpoTicket {
    status: String,
    message: Option<String>,
    details: Option<ExpoErrorDetails>,
}

#[derive(Deserialize)]
struct ExpoErrorDetails {
    error: Option<String>,
}

/// Sends one Expo ticket per registered device. This is best-effort: all failures are
/// logged and never reach notification dispatch callers.
pub async fn send_to_user(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    channel_id: Uuid,
    kind: &str,
) {
    if tokio::time::timeout(
        Duration::from_secs(10),
        send_inner(state, user_id, title, body, channel_id, kind),
    )
    .await
    .is_err()
    {
        tracing::warn!("expo push: send timed out for user {}", user_id);
    }
}

async fn send_inner(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    channel_id: Uuid,
    kind: &str,
) {
    let rows = match sqlx::query("SELECT token FROM expo_push_tokens WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("expo push: load tokens: {}", e);
            return;
        }
    };

    let tokens: Vec<String> = rows
        .iter()
        .filter_map(|row| match row.try_get("token") {
            Ok(token) => Some(token),
            Err(e) => {
                tracing::warn!("expo push: read token: {}", e);
                None
            }
        })
        .collect();
    if tokens.is_empty() {
        return;
    }

    let messages: Vec<_> = tokens
        .iter()
        .map(|token| {
            json!({
                "to": token,
                "title": title,
                "body": body,
                "sound": "default",
                "data": { "channel_id": channel_id.to_string(), "kind": kind },
            })
        })
        .collect();
    let mut request = client()
        .post(EXPO_PUSH_URL)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .json(&messages);
    if let Ok(access_token) = std::env::var("EXPO_ACCESS_TOKEN") {
        if !access_token.is_empty() {
            request = request.header(AUTHORIZATION, format!("Bearer {access_token}"));
        }
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!("expo push: send: {}", e);
            return;
        }
    };
    if !response.status().is_success() {
        tracing::warn!("expo push: API returned {}", response.status());
        return;
    }
    let tickets: ExpoResponse = match response.json().await {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!("expo push: parse response: {}", e);
            return;
        }
    };

    for (token, ticket) in tokens.iter().zip(tickets.data) {
        if ticket.status == "error" {
            tracing::warn!(
                "expo push: ticket error for {}: {}",
                token,
                ticket.message.unwrap_or_default()
            );
            if ticket.details.and_then(|details| details.error).as_deref()
                == Some("DeviceNotRegistered")
            {
                if let Err(e) = sqlx::query("DELETE FROM expo_push_tokens WHERE token = $1")
                    .bind(token)
                    .execute(&state.pool)
                    .await
                {
                    tracing::warn!("expo push: prune token: {}", e);
                }
            }
        }
    }
}
