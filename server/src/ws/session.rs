use crate::state::SharedState;
use crate::ws::voice;
use crate::ws::{channel_member_ids, envelope, GuestInfo};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

pub async fn handle_socket(
    socket: WebSocket,
    state: SharedState,
    user_id: Uuid,
    guest: Option<GuestInfo>,
) {
    // Display name: guests carry it in the token (no users row); registered
    // users are looked up once for typing/voice events.
    let display_name = match &guest {
        Some(g) => g.name.clone(),
        None => match sqlx::query("SELECT display_name FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(Some(row)) => row.try_get::<String, _>("display_name").unwrap_or_default(),
            _ => String::new(),
        },
    };

    let conn_id = Uuid::new_v4();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let first = state.hub.add(user_id, conn_id, tx.clone());

    let (mut sink, mut stream) = socket.split();

    // Writer task: forward queued messages to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Greet with the current online set.
    let online: Vec<String> = state
        .hub
        .online_user_ids()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    let hello = envelope(
        "hello",
        json!({
            "user_id": user_id.to_string(),
            "conn_id": conn_id.to_string(),
            "online_user_ids": online,
            "voice_rooms": voice::snapshot_all(&state),
        }),
    );
    let _ = tx.send(Message::Text(hello.to_string()));

    // Announce presence if this is the user's first connection. Guests are
    // voice-only and invisible to the presence system.
    if first && guest.is_none() {
        let targets = state.hub.online_user_ids();
        let ev = envelope(
            "presence",
            json!({ "user_id": user_id.to_string(), "status": "online" }),
        );
        state.hub.broadcast(ev, targets).await;
    }

    // Read loop.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    handle_client_event(
                        &state,
                        user_id,
                        conn_id,
                        &display_name,
                        guest.as_ref(),
                        &tx,
                        &value,
                    )
                    .await;
                }
            }
            Message::Ping(data) => {
                let _ = tx.send(Message::Pong(data));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Cleanup.
    voice::cleanup_conn(&state, user_id, conn_id).await;
    let last = state.hub.remove(user_id, conn_id);
    if last && guest.is_none() {
        let targets = state.hub.online_user_ids();
        let ev = envelope(
            "presence",
            json!({ "user_id": user_id.to_string(), "status": "offline" }),
        );
        state.hub.broadcast(ev, targets).await;
    }
    writer.abort();
}

async fn handle_client_event(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    guest: Option<&GuestInfo>,
    tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    value: &Value,
) {
    let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let payload = value.get("payload").cloned().unwrap_or_else(|| json!({}));

    // Guests are voice-only: they may ping and send voice events, and only for
    // the single channel their token is bound to. Anything else is dropped.
    if let Some(g) = guest {
        let voice_event = matches!(
            event_type,
            "voice.join" | "voice.leave" | "voice.mute" | "voice.camera" | "voice.screen"
                | "voice.signal" | "voice.transcribe" | "voice.phrase" | "voice.hand"
        );
        if event_type != "ping" && !voice_event {
            return;
        }
        if voice_event {
            let bound = payload
                .get("channel_id")
                .and_then(|c| c.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                == Some(g.channel_id);
            if !bound {
                return;
            }
        }
    }

    match event_type {
        "ping" => {
            let _ = tx.send(Message::Text(envelope("pong", json!({})).to_string()));
        }
        "typing" => {
            let channel_id = payload
                .get("channel_id")
                .and_then(|c| c.as_str())
                .and_then(|s| Uuid::parse_str(s).ok());
            if let Some(channel_id) = channel_id {
                if let Ok(targets) = channel_member_ids(&state.pool, channel_id).await {
                    let ev = envelope(
                        "typing",
                        json!({
                            "channel_id": channel_id.to_string(),
                            "user_id": user_id.to_string(),
                            "display_name": display_name,
                        }),
                    );
                    state.hub.broadcast(ev, targets).await;
                }
            }
        }
        "voice.join" | "voice.leave" | "voice.mute" | "voice.transcribe" | "voice.phrase"
        | "voice.camera" | "voice.screen" | "voice.signal" | "voice.hand" => {
            voice::handle_voice_event(
                state,
                user_id,
                conn_id,
                display_name,
                guest,
                event_type,
                payload,
                tx,
            )
            .await;
        }
        _ => {}
    }
}
