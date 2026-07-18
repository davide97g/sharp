pub mod session;
pub mod voice;

use crate::auth::verify_claims;
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
    pub visible: bool,
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
        // Treat a fresh connection as visible until the client reports its
        // actual Page Visibility state. This avoids a push during handshake.
        entry.push(Conn {
            conn_id,
            tx,
            visible: true,
        });
        first
    }

    fn set_visible_local(&self, user_id: Uuid, conn_id: Uuid, visible: bool) {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(conns) = guard.get_mut(&user_id) {
            if let Some(conn) = conns.iter_mut().find(|conn| conn.conn_id == conn_id) {
                conn.visible = visible;
            }
        }
    }

    fn is_visible_local(&self, user_id: Uuid) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(&user_id)
            .map(|conns| conns.iter().any(|conn| conn.visible))
            .unwrap_or(false)
    }

    fn visibility_key(user_id: Uuid) -> String {
        format!("sharp:visible:{user_id}")
    }

    fn unix_seconds() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    /// Update page visibility locally and in Redis. Redis scores are expiry
    /// timestamps, refreshed by normal client heartbeats.
    pub async fn set_visibility(&self, user_id: Uuid, conn_id: Uuid, visible: bool) {
        self.set_visible_local(user_id, conn_id, visible);
        let Some(client) = &self.redis else { return };
        let Ok(mut conn) = client.get_multiplexed_async_connection().await else {
            return;
        };
        let key = Self::visibility_key(user_id);
        if visible {
            let expires_at = Self::unix_seconds() + 60;
            let _: Result<i64, redis::RedisError> = redis::cmd("ZADD")
                .arg(&key)
                .arg(expires_at)
                .arg(conn_id.to_string())
                .query_async(&mut conn)
                .await;
            let _: Result<bool, redis::RedisError> = redis::cmd("EXPIRE")
                .arg(&key)
                .arg(120)
                .query_async(&mut conn)
                .await;
        } else {
            let _: Result<i64, redis::RedisError> = redis::cmd("ZREM")
                .arg(&key)
                .arg(conn_id.to_string())
                .query_async(&mut conn)
                .await;
        }
    }

    /// Refresh Redis TTL only when this connection remains visible locally.
    pub async fn refresh_visibility(&self, user_id: Uuid, conn_id: Uuid) {
        let visible = self
            .sessions
            .lock()
            .unwrap()
            .get(&user_id)
            .and_then(|conns| conns.iter().find(|conn| conn.conn_id == conn_id))
            .map(|conn| conn.visible)
            .unwrap_or(false);
        if visible {
            self.set_visibility(user_id, conn_id, true).await;
        }
    }

    pub async fn remove_visibility(&self, user_id: Uuid, conn_id: Uuid) {
        let Some(client) = &self.redis else { return };
        let Ok(mut conn) = client.get_multiplexed_async_connection().await else {
            return;
        };
        let _: Result<i64, redis::RedisError> = redis::cmd("ZREM")
            .arg(Self::visibility_key(user_id))
            .arg(conn_id.to_string())
            .query_async(&mut conn)
            .await;
    }

    /// True when any live browser session is visible on any replica.
    pub async fn has_visible_session(&self, user_id: Uuid) -> bool {
        if self.is_visible_local(user_id) {
            return true;
        }
        let Some(client) = &self.redis else { return false };
        let Ok(mut conn) = client.get_multiplexed_async_connection().await else {
            return false;
        };
        let key = Self::visibility_key(user_id);
        let now = Self::unix_seconds();
        let _: Result<i64, redis::RedisError> = redis::cmd("ZREMRANGEBYSCORE")
            .arg(&key)
            .arg(0)
            .arg(now)
            .query_async(&mut conn)
            .await;
        redis::cmd("ZCARD")
            .arg(&key)
            .query_async::<i64>(&mut conn)
            .await
            .map(|count| count > 0)
            .unwrap_or(false)
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

    /// Whether the user has at least one live connection on this replica.
    pub fn is_online(&self, user_id: Uuid) -> bool {
        self.sessions.lock().unwrap().contains_key(&user_id)
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

#[cfg(test)]
mod tests {
    use super::Hub;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    #[tokio::test]
    async fn visibility_tracks_each_connection() {
        let hub = Hub::new(None);
        let user_id = Uuid::new_v4();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let (first_tx, _) = mpsc::unbounded_channel();
        let (second_tx, _) = mpsc::unbounded_channel();
        hub.add(user_id, first, first_tx);
        hub.add(user_id, second, second_tx);

        assert!(hub.has_visible_session(user_id).await);
        hub.set_visibility(user_id, first, false).await;
        assert!(hub.has_visible_session(user_id).await);
        hub.set_visibility(user_id, second, false).await;
        assert!(!hub.has_visible_session(user_id).await);
        hub.set_visibility(user_id, first, true).await;
        assert!(hub.has_visible_session(user_id).await);
        hub.remove(user_id, first);
        assert!(!hub.has_visible_session(user_id).await);
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

/// Session context for a public voice-link guest. A guest is scoped to exactly
/// one voice room and carries its display name in the token.
pub struct GuestInfo {
    pub name: String,
    pub channel_id: Uuid,
    pub link: String,
}

pub async fn ws_handler(
    State(state): State<SharedState>,
    Query(params): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let (claims, user_id) = match verify_claims(&params.token, &state.config.jwt_secret) {
        Some(parsed) => parsed,
        None => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    let guest = if claims.guest {
        match (claims.channel_id, claims.link) {
            (Some(channel_id), Some(link)) => Some(GuestInfo {
                name: claims.name.unwrap_or_default(),
                channel_id,
                link,
            }),
            // A guest token missing its binding is malformed — reject it.
            _ => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
        }
    } else {
        None
    };

    ws.on_upgrade(move |socket| session::handle_socket(socket, state, user_id, guest))
}
