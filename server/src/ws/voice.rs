use crate::routes::is_member;
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope, WsSender};
use axum::extract::ws::Message;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

const MAX_PARTICIPANTS: usize = 8;

#[derive(Clone, Serialize)]
pub struct VoiceParticipant {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    pub muted: bool,
}

#[derive(Default)]
pub struct VoiceRoom {
    pub participants: HashMap<Uuid, VoiceParticipant>,
}

pub type VoiceRooms = Mutex<HashMap<Uuid, VoiceRoom>>;

pub fn snapshot_all(state: &SharedState) -> Value {
    let guard = state.voice_rooms.lock().unwrap();
    let mut rooms: Vec<(Uuid, Vec<VoiceParticipant>)> = guard
        .iter()
        .map(|(channel_id, room)| {
            let mut participants: Vec<VoiceParticipant> =
                room.participants.values().cloned().collect();
            participants.sort_by_key(|participant| participant.conn_id);
            (*channel_id, participants)
        })
        .collect();
    rooms.sort_by_key(|(channel_id, _)| *channel_id);

    json!(rooms
        .into_iter()
        .map(|(channel_id, participants)| json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
        }))
        .collect::<Vec<_>>())
}

pub async fn handle_voice_event(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    event_type: &str,
    payload: Value,
    tx: &WsSender,
) {
    match event_type {
        "voice.join" => handle_join(state, user_id, conn_id, &payload, tx).await,
        "voice.leave" => handle_leave(state, user_id, conn_id, &payload, tx).await,
        "voice.mute" => handle_mute(state, conn_id, &payload, tx).await,
        "voice.signal" => handle_signal(state, user_id, conn_id, &payload, tx).await,
        _ => {}
    }
}

pub async fn cleanup_conn(state: &SharedState, user_id: Uuid, conn_id: Uuid) {
    let removed: Vec<(Uuid, VoiceParticipant)> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let mut removed = Vec::new();
        for (channel_id, room) in guard.iter_mut() {
            if let Some(participant) = room.participants.remove(&conn_id) {
                removed.push((*channel_id, participant));
            }
        }
        guard.retain(|_, room| !room.participants.is_empty());
        removed
    };

    for (channel_id, participant) in removed {
        debug_assert_eq!(participant.user_id, user_id);
        broadcast_participant_left(state, channel_id, conn_id, user_id).await;
    }
}

pub async fn remove_member_from_room(state: &SharedState, channel_id: Uuid, user_id: Uuid) {
    let mut removed: Vec<VoiceParticipant> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            return;
        };
        let conn_ids: Vec<Uuid> = room
            .participants
            .values()
            .filter(|participant| participant.user_id == user_id)
            .map(|participant| participant.conn_id)
            .collect();
        let removed: Vec<VoiceParticipant> = conn_ids
            .iter()
            .filter_map(|conn_id| room.participants.remove(conn_id))
            .collect();
        if room.participants.is_empty() {
            guard.remove(&channel_id);
        }
        removed
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let targets = match channel_member_ids(&state.pool, channel_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
            return;
        }
    };
    for participant in removed {
        let event = participant_left_event(channel_id, participant.conn_id, participant.user_id);
        state.hub.broadcast(event, targets.clone()).await;
    }
}

pub async fn close_room(state: &SharedState, channel_id: Uuid) {
    let mut removed: Vec<VoiceParticipant> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.remove(&channel_id) {
            Some(room) => room.participants.into_values().collect(),
            None => return,
        }
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let targets = match channel_member_ids(&state.pool, channel_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
            return;
        }
    };
    for participant in removed {
        let event = participant_left_event(channel_id, participant.conn_id, participant.user_id);
        state.hub.broadcast(event, targets.clone()).await;
    }
}

async fn handle_join(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    match is_member(&state.pool, channel_id, user_id).await {
        Ok(true) => {}
        Ok(false) => {
            send_error(tx, channel_id, "not_member");
            return;
        }
        Err(error) => {
            tracing::warn!(
                "voice room {} membership check failed: {}",
                channel_id,
                error
            );
            return;
        }
    }

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let room = guard.entry(channel_id).or_default();
        if room.participants.contains_key(&conn_id) {
            JoinResult::Existing(room_participants(room))
        } else if room.participants.len() >= MAX_PARTICIPANTS {
            JoinResult::Full
        } else {
            let participant = VoiceParticipant {
                conn_id,
                user_id,
                muted: false,
            };
            room.participants.insert(conn_id, participant.clone());
            JoinResult::Joined(participant, room_participants(room))
        }
    };

    let (participant, participants) = match result {
        JoinResult::Full => {
            send_error(tx, channel_id, "room_full");
            return;
        }
        JoinResult::Existing(participants) => {
            send_state(tx, channel_id, participants);
            return;
        }
        JoinResult::Joined(participant, participants) => (participant, participants),
    };

    send_state(tx, channel_id, participants);
    let targets = match channel_member_ids(&state.pool, channel_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
            return;
        }
    };
    let event = envelope(
        "voice.participant_joined",
        json!({
            "channel_id": channel_id.to_string(),
            "participant": participant,
        }),
    );
    state.hub.broadcast(event, targets).await;
}

async fn handle_leave(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let participant = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let removed = guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.remove(&conn_id));
        if guard
            .get(&channel_id)
            .is_some_and(|room| room.participants.is_empty())
        {
            guard.remove(&channel_id);
        }
        removed
    };

    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };
    debug_assert_eq!(participant.user_id, user_id);
    broadcast_participant_left(state, channel_id, conn_id, user_id).await;
}

async fn handle_mute(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(muted) = payload.get("muted").and_then(Value::as_bool) else {
        return;
    };
    let updated = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
            .map(|participant| participant.muted = muted)
            .is_some()
    };
    if !updated {
        send_error(tx, channel_id, "not_in_room");
        return;
    }

    let targets = match channel_member_ids(&state.pool, channel_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
            return;
        }
    };
    let event = envelope(
        "voice.participant_updated",
        json!({
            "channel_id": channel_id.to_string(),
            "conn_id": conn_id.to_string(),
            "muted": muted,
        }),
    );
    state.hub.broadcast(event, targets).await;
}

async fn handle_signal(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let in_room = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .get(&channel_id)
            .is_some_and(|room| room.participants.contains_key(&conn_id))
    };
    if !in_room {
        send_error(tx, channel_id, "not_in_room");
        return;
    }

    let Some(to_user) = uuid_field(payload, "to_user") else {
        return;
    };
    let Some(to_conn) = uuid_field(payload, "to_conn") else {
        return;
    };
    let Some(kind) = payload.get("kind").and_then(Value::as_str) else {
        return;
    };
    if !matches!(kind, "offer" | "answer" | "candidate") {
        return;
    }
    let Some(data) = payload.get("data").filter(|data| data.is_object()).cloned() else {
        return;
    };

    let event = envelope(
        "voice.signal",
        json!({
            "channel_id": channel_id.to_string(),
            "from_user": user_id.to_string(),
            "from_conn": conn_id.to_string(),
            "to_user": to_user.to_string(),
            "to_conn": to_conn.to_string(),
            "kind": kind,
            "data": data,
        }),
    );
    state.hub.broadcast(event, vec![to_user]).await;
}

enum JoinResult {
    Full,
    Existing(Vec<VoiceParticipant>),
    Joined(VoiceParticipant, Vec<VoiceParticipant>),
}

fn room_participants(room: &VoiceRoom) -> Vec<VoiceParticipant> {
    let mut participants: Vec<VoiceParticipant> = room.participants.values().cloned().collect();
    participants.sort_by_key(|participant| participant.conn_id);
    participants
}

fn channel_id(payload: &Value) -> Option<Uuid> {
    uuid_field(payload, "channel_id")
}

fn uuid_field(payload: &Value, field: &str) -> Option<Uuid> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
}

fn send_state(tx: &WsSender, channel_id: Uuid, participants: Vec<VoiceParticipant>) {
    let event = envelope(
        "voice.state",
        json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
        }),
    );
    let _ = tx.send(Message::Text(event.to_string()));
}

fn send_error(tx: &WsSender, channel_id: Uuid, code: &str) {
    let event = envelope(
        "voice.error",
        json!({ "channel_id": channel_id.to_string(), "code": code }),
    );
    let _ = tx.send(Message::Text(event.to_string()));
}

fn participant_left_event(channel_id: Uuid, conn_id: Uuid, user_id: Uuid) -> Value {
    envelope(
        "voice.participant_left",
        json!({
            "channel_id": channel_id.to_string(),
            "conn_id": conn_id.to_string(),
            "user_id": user_id.to_string(),
        }),
    )
}

async fn broadcast_participant_left(
    state: &SharedState,
    channel_id: Uuid,
    conn_id: Uuid,
    user_id: Uuid,
) {
    let targets = match channel_member_ids(&state.pool, channel_id).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
            return;
        }
    };
    let event = participant_left_event(channel_id, conn_id, user_id);
    state.hub.broadcast(event, targets).await;
}
