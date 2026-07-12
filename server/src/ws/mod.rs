pub mod session;

use crate::auth::verify_token;
use crate::error::AppResult;
use crate::state::SharedState;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

pub type WsSender = UnboundedSender<Message>;

pub struct Conn {
    pub conn_id: Uuid,
    pub tx: WsSender,
}

pub struct Hub {
    sessions: Mutex<HashMap<Uuid, Vec<Conn>>>,
    origin_id: Uuid,
    redis: Option<redis::Client>,
}

impl Hub {
    pub fn new(redis: Option<redis::Client>) -> Self {
        Hub {
            sessions: Mutex::new(HashMap::new()),
            origin_id: Uuid::new_v4(),
            redis,
        }
    }

    pub fn has_redis(&self) -> bool {
        self.redis.is_some()
    }

    pub fn redis_client(&self) -> Option<redis::Client> {
        self.redis.clone()
    }

    /// Register a connection. Returns true if this is the user's first connection.
    pub fn add(&self, user_id: Uuid, conn_id: Uuid, tx: WsSender) -> bool {
        let mut guard = self.sessions.lock().unwrap();
        let entry = guard.entry(user_id).or_default();
        let first = entry.is_empty();
        entry.push(Conn { conn_id, tx });
        first
    }

    /// Remove a connection. Returns true if it was the user's last connection.
    pub fn remove(&self, user_id: Uuid, conn_id: Uuid) -> bool {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(entry) = guard.get_mut(&user_id) {
            entry.retain(|c| c.conn_id != conn_id);
            if entry.is_empty() {
                guard.remove(&user_id);
                return true;
            }
        }
        false
    }

    pub fn online_user_ids(&self) -> Vec<Uuid> {
        let guard = self.sessions.lock().unwrap();
        guard.keys().copied().collect()
    }

    /// Send a serialized envelope to all local connections of the target users.
    pub fn send_local(&self, targets: &[Uuid], text: &str) {
        let guard = self.sessions.lock().unwrap();
        for uid in targets {
            if let Some(conns) = guard.get(uid) {
                for conn in conns {
                    let _ = conn.tx.send(Message::Text(text.to_string()));
                }
            }
        }
    }

    /// Broadcast an event to the target users locally and, if configured, via Redis.
    pub async fn broadcast(&self, envelope: Value, targets: Vec<Uuid>) {
        let text = envelope.to_string();
        self.send_local(&targets, &text);

        if let Some(client) = &self.redis {
            let wrapper = json!({
                "origin": self.origin_id.to_string(),
                "targets": targets.iter().map(|u| u.to_string()).collect::<Vec<_>>(),
                "envelope": envelope,
            });
            if let Ok(mut conn) = client.get_multiplexed_async_connection().await {
                let _: Result<(), redis::RedisError> = redis::cmd("PUBLISH")
                    .arg("sharp:events")
                    .arg(wrapper.to_string())
                    .query_async(&mut conn)
                    .await;
            }
        }
    }
}

pub fn envelope(event_type: &str, payload: Value) -> Value {
    json!({ "type": event_type, "payload": payload })
}

/// Fetch the user ids that are members of a channel.
pub async fn channel_member_ids(pool: &PgPool, channel_id: Uuid) -> AppResult<Vec<Uuid>> {
    let rows = sqlx::query("SELECT user_id FROM channel_members WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_all(pool)
        .await?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        ids.push(row.try_get::<Uuid, _>("user_id")?);
    }
    Ok(ids)
}

/// Background task: subscribe to Redis and rebroadcast foreign events locally.
pub async fn run_redis_subscriber(hub: std::sync::Arc<Hub>, client: redis::Client) {
    loop {
        if let Err(e) = subscribe_once(&hub, &client).await {
            tracing::warn!("redis subscriber error: {}; retrying", e);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
}

async fn subscribe_once(hub: &Hub, client: &redis::Client) -> Result<(), redis::RedisError> {
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe("sharp:events").await?;
    let own_origin = hub.origin_id.to_string();
    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("origin").and_then(|o| o.as_str()) == Some(own_origin.as_str()) {
            continue;
        }
        let targets: Vec<Uuid> = value
            .get("targets")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter_map(|s| Uuid::parse_str(s).ok())
                    .collect()
            })
            .unwrap_or_default();
        if let Some(env) = value.get("envelope") {
            hub.send_local(&targets, &env.to_string());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: String,
}

pub async fn ws_handler(
    State(state): State<SharedState>,
    Query(params): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let user_id = match verify_token(&params.token, &state.config.jwt_secret) {
        Some(id) => id,
        None => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };
    ws.on_upgrade(move |socket| session::handle_socket(socket, state, user_id))
}
