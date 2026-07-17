use crate::routes::meetings::{self, LiveAttendee};
use crate::routes::member_role;
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope, GuestInfo, WsSender};
use axum::extract::ws::Message;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_PARTICIPANTS: usize = 8;
const MAX_CAMERAS: usize = 4;
const MAX_SCREENS: usize = 1;
const MAX_TRANSCRIPT_PHRASES: usize = 50;
const MAX_PHRASE_CHARS: usize = 500;
const PHRASE_STREAK_THRESHOLD: u32 = 3;
const PHRASE_STREAK_GAP: Duration = Duration::from_secs(20);

#[derive(Clone, Serialize)]
pub struct VoiceParticipant {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    pub display_name: String,
    pub guest: bool,
    pub muted: bool,
    pub transcribing: bool,
    pub camera_on: bool,
    pub screen_on: bool,
    pub screen_stream_id: Option<String>,
    pub hand_raised: bool,
    /// Unix epoch milliseconds when the hand was raised; `None` while lowered.
    pub hand_raised_at: Option<i64>,
    pub joined_at: DateTime<Utc>,
}

pub struct VoicePhrase {
    pub display_name: String,
    pub text: String,
    pub at: Instant,
}

/// Resolve the audience for a voice broadcast: the union of the channel's
/// members and the user-ids currently in the room (so guests, who are not
/// channel members, still receive participant events), plus any extra ids the
/// caller supplies (e.g. a just-removed participant for `participant_left`).
pub(crate) async fn voice_targets(
    state: &SharedState,
    channel_id: Uuid,
    extra: &[Uuid],
) -> Vec<Uuid> {
    let mut ids: HashSet<Uuid> = HashSet::new();
    match channel_member_ids(&state.pool, channel_id).await {
        Ok(members) => ids.extend(members),
        Err(error) => {
            // Still deliver to in-room users (incl. guests) even if the member
            // lookup fails, so live events aren't silently dropped.
            tracing::warn!("voice room {} member lookup failed: {}", channel_id, error);
        }
    }
    {
        let guard = state.voice_rooms.lock().unwrap();
        if let Some(room) = guard.get(&channel_id) {
            for participant in room.participants.values() {
                ids.insert(participant.user_id);
            }
        }
    }
    ids.extend(extra.iter().copied());
    ids.into_iter().collect()
}

/// Fetch a channel's current voice-link token (used to validate guest joins).
async fn current_voice_link_token(
    pool: &sqlx::PgPool,
    channel_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT voice_link_token FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(row) => row.try_get::<Option<String>, _>("voice_link_token"),
        None => Ok(None),
    }
}

#[derive(Default)]
pub struct VoiceRoom {
    pub participants: HashMap<Uuid, VoiceParticipant>,
    pub transcript: VecDeque<VoicePhrase>,
    pub phrase_count: u32,
    pub last_phrase_at: Option<Instant>,
    pub roast_armed: bool,
    pub active_meeting_id: Option<Uuid>,
    pub meeting_starting: bool,
    pub attendance_ids: HashMap<Uuid, Uuid>,
}

pub type VoiceRooms = Mutex<HashMap<Uuid, VoiceRoom>>;

pub fn snapshot_all(state: &SharedState) -> Value {
    let guard = state.voice_rooms.lock().unwrap();
    let mut rooms: Vec<(Uuid, Vec<VoiceParticipant>, Option<Uuid>)> = guard
        .iter()
        .map(|(channel_id, room)| {
            let mut participants: Vec<VoiceParticipant> =
                room.participants.values().cloned().collect();
            participants.sort_by_key(|participant| participant.conn_id);
            (*channel_id, participants, room.active_meeting_id)
        })
        .collect();
    rooms.sort_by_key(|(channel_id, _, _)| *channel_id);

    json!(rooms
        .into_iter()
        .map(|(channel_id, participants, active_meeting_id)| json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
            "active_meeting_id": active_meeting_id,
        }))
        .collect::<Vec<_>>())
}

pub fn snapshot_transcript(
    state: &SharedState,
    channel_id: Uuid,
    minutes: i64,
) -> Vec<(String, String)> {
    let now = Instant::now();
    let seconds = u64::try_from(minutes).unwrap_or_default().saturating_mul(60);
    let cutoff = now
        .checked_sub(Duration::from_secs(seconds))
        .unwrap_or(now);
    let guard = state.voice_rooms.lock().unwrap();
    guard
        .get(&channel_id)
        .map(|room| {
            room.transcript
                .iter()
                .filter(|phrase| phrase.at >= cutoff)
                .map(|phrase| (phrase.display_name.clone(), phrase.text.clone()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn consume_roast_armed(state: &SharedState, channel_id: Uuid) -> bool {
    let mut guard = state.voice_rooms.lock().unwrap();
    let Some(room) = guard.get_mut(&channel_id) else {
        return false;
    };
    let was_armed = room.roast_armed;
    room.phrase_count = 0;
    room.roast_armed = false;
    was_armed
}

pub async fn broadcast_roast_armed(state: &SharedState, channel_id: Uuid, armed: bool) {
    let targets = voice_targets(state, channel_id, &[]).await;
    let event = envelope(
        "voice.roast_armed",
        json!({
            "channel_id": channel_id.to_string(),
            "armed": armed,
        }),
    );
    state.hub.broadcast(event, targets).await;
}

#[allow(clippy::too_many_arguments)]
pub async fn handle_voice_event(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    guest: Option<&GuestInfo>,
    event_type: &str,
    payload: Value,
    tx: &WsSender,
) {
    match event_type {
        "voice.join" => handle_join(state, user_id, conn_id, display_name, guest, &payload, tx).await,
        "voice.leave" => handle_leave(state, user_id, conn_id, &payload, tx).await,
        "voice.mute" => handle_mute(state, conn_id, &payload, tx).await,
        "voice.transcribe" => handle_transcribe(state, conn_id, &payload, tx).await,
        "voice.phrase" => handle_phrase(state, conn_id, &payload, tx).await,
        "voice.camera" => handle_camera(state, conn_id, &payload, tx).await,
        "voice.screen" => handle_screen(state, conn_id, &payload, tx).await,
        "voice.hand" => handle_hand(state, conn_id, &payload, tx).await,
        "voice.signal" => handle_signal(state, user_id, conn_id, &payload, tx).await,
        _ => {}
    }
}

pub async fn cleanup_conn(state: &SharedState, user_id: Uuid, conn_id: Uuid) {
    let removed: Vec<(Uuid, VoiceParticipant, Option<Uuid>, bool)> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let mut removed = Vec::new();
        for (channel_id, room) in guard.iter_mut() {
            if let Some(participant) = room.participants.remove(&conn_id) {
                room.attendance_ids.remove(&conn_id);
                removed.push((
                    *channel_id,
                    participant,
                    room.active_meeting_id,
                    room.participants.is_empty(),
                ));
            }
        }
        guard.retain(|_, room| !room.participants.is_empty());
        removed
    };

    for (channel_id, participant, meeting_id, room_ended) in removed {
        debug_assert_eq!(participant.user_id, user_id);
        let left_at = Utc::now();
        if let Some(meeting_id) = meeting_id {
            if let Err(error) =
                meetings::close_live_attendee(state, meeting_id, conn_id, left_at).await
            {
                tracing::warn!("meeting disconnect attendance failed: {}", error);
            }
            if room_ended {
                finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
            }
        }
        broadcast_participant_left(state, channel_id, conn_id, user_id).await;
    }
}

pub async fn remove_member_from_room(state: &SharedState, channel_id: Uuid, user_id: Uuid) {
    let (mut removed, meeting_id, room_ended): (Vec<VoiceParticipant>, Option<Uuid>, bool) = {
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
        for conn_id in &conn_ids {
            room.attendance_ids.remove(conn_id);
        }
        let meeting_id = room.active_meeting_id;
        let room_ended = room.participants.is_empty();
        if room_ended {
            guard.remove(&channel_id);
        }
        (removed, meeting_id, room_ended)
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let left_at = Utc::now();
    if let Some(meeting_id) = meeting_id {
        for participant in &removed {
            let _ = meetings::close_live_attendee(
                state,
                meeting_id,
                participant.conn_id,
                left_at,
            )
            .await;
        }
        if room_ended {
            finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
        }
    }

    // Include removed (possibly-guest) user-ids so they receive their leave event.
    let extra: Vec<Uuid> = removed.iter().map(|p| p.user_id).collect();
    let targets = voice_targets(state, channel_id, &extra).await;
    for participant in removed {
        let event = participant_left_event(channel_id, participant.conn_id, participant.user_id);
        state.hub.broadcast(event, targets.clone()).await;
    }
}

pub async fn close_room(state: &SharedState, channel_id: Uuid) {
    let (mut removed, meeting_id): (Vec<VoiceParticipant>, Option<Uuid>) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.remove(&channel_id) {
            Some(room) => (room.participants.into_values().collect(), room.active_meeting_id),
            None => return,
        }
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let left_at = Utc::now();
    if let Some(meeting_id) = meeting_id {
        for participant in &removed {
            let _ = meetings::close_live_attendee(
                state,
                meeting_id,
                participant.conn_id,
                left_at,
            )
            .await;
        }
        finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
    }

    // Room is gone from the map, so seed targets with all removed user-ids
    // (members + guests) to guarantee delivery of the leave events.
    let extra: Vec<Uuid> = removed.iter().map(|p| p.user_id).collect();
    let targets = voice_targets(state, channel_id, &extra).await;
    for participant in removed {
        let event = participant_left_event(channel_id, participant.conn_id, participant.user_id);
        state.hub.broadcast(event, targets.clone()).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_join(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    guest: Option<&GuestInfo>,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };

    // Access control: guests must present a link matching the channel's CURRENT
    // voice link (regenerating the link revokes them); registered users must be
    // channel members.
    match guest {
        Some(g) => match current_voice_link_token(&state.pool, channel_id).await {
            Ok(Some(current)) if current == g.link => {}
            Ok(_) => {
                send_error(tx, channel_id, "link_revoked");
                return;
            }
            Err(error) => {
                tracing::warn!(
                    "voice room {} link lookup failed: {}",
                    channel_id,
                    error
                );
                return;
            }
        },
        None => match member_role(&state.pool, channel_id, user_id).await {
            Ok(Some(role)) if role.can_post() => {}
            Ok(_) => {
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
        },
    }

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let room = guard.entry(channel_id).or_default();
        if room.participants.contains_key(&conn_id) {
            JoinResult::Existing(room_participants(room), room.active_meeting_id)
        } else if room.participants.len() >= MAX_PARTICIPANTS {
            JoinResult::Full
        } else {
            let participant = VoiceParticipant {
                conn_id,
                user_id,
                display_name: display_name.to_string(),
                guest: guest.is_some(),
                muted: false,
                transcribing: false,
                camera_on: false,
                screen_on: false,
                screen_stream_id: None,
                hand_raised: false,
                hand_raised_at: None,
                joined_at: Utc::now(),
            };
            room.participants.insert(conn_id, participant.clone());
            JoinResult::Joined(participant, room_participants(room), room.active_meeting_id)
        }
    };

    let participant = match result {
        JoinResult::Full => {
            send_error(tx, channel_id, "room_full");
            return;
        }
        JoinResult::Existing(participants, active_meeting_id) => {
            send_state(tx, channel_id, participants, active_meeting_id);
            return;
        }
        JoinResult::Joined(participant, participants, active_meeting_id) => {
            send_state(tx, channel_id, participants, active_meeting_id);
            participant
        }
    };


    let active_meeting_id = {
        let guard = state.voice_rooms.lock().unwrap();
        guard.get(&channel_id).and_then(|room| room.active_meeting_id)
    };
    if let Some(meeting_id) = active_meeting_id {
        let attendee = live_attendee(&participant);
        match meetings::add_live_attendee(state, meeting_id, &attendee).await {
            Ok(attendance_id) => {
                let mut guard = state.voice_rooms.lock().unwrap();
                if let Some(room) = guard.get_mut(&channel_id) {
                    room.attendance_ids.insert(conn_id, attendance_id);
                }
            }
            Err(error) => tracing::warn!("meeting attendance join failed: {}", error),
        }
    }
    let targets = voice_targets(state, channel_id, &[]).await;
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
    let (participant, meeting_id, room_ended) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            send_error(tx, channel_id, "not_in_room");
            return;
        };
        let removed = room.participants.remove(&conn_id);
        room.attendance_ids.remove(&conn_id);
        let meeting_id = room.active_meeting_id;
        let room_ended = room.participants.is_empty();
        if room_ended {
            guard.remove(&channel_id);
        }
        (removed, meeting_id, room_ended)
    };

    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };
    debug_assert_eq!(participant.user_id, user_id);
    let left_at = Utc::now();
    if let Some(meeting_id) = meeting_id {
        if let Err(error) = meetings::close_live_attendee(state, meeting_id, conn_id, left_at).await {
            tracing::warn!("meeting attendance leave failed: {}", error);
        }
        if room_ended {
            finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
        }
    }
    broadcast_participant_left(state, channel_id, conn_id, user_id).await;
}

async fn handle_mute(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(muted) = payload.get("muted").and_then(Value::as_bool) else {
        return;
    };
    let participant = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
            .map(|participant| {
                participant.muted = muted;
                // Unmuting lowers a raised hand: one combined update carries both
                // the mute and hand changes to the room.
                if !muted && participant.hand_raised {
                    participant.hand_raised = false;
                    participant.hand_raised_at = None;
                }
                participant.clone()
            })
    };
    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };

    broadcast_participant_updated(state, channel_id, participant).await;
}

async fn handle_hand(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(raised) = payload.get("raised").and_then(Value::as_bool) else {
        return;
    };

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
        {
            Some(participant) => {
                if participant.hand_raised == raised {
                    // Idempotent no-op: nothing to broadcast.
                    None
                } else {
                    participant.hand_raised = raised;
                    participant.hand_raised_at =
                        if raised { Some(Utc::now().timestamp_millis()) } else { None };
                    Some(participant.clone())
                }
            }
            None => return send_error(tx, channel_id, "not_in_room"),
        }
    };

    if let Some(participant) = result {
        broadcast_participant_updated(state, channel_id, participant).await;
    }
}

async fn handle_transcribe(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
        return;
    };
    let participant = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
            .map(|participant| {
                participant.transcribing = enabled;
                participant.clone()
            })
    };
    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };

    broadcast_participant_updated(state, channel_id, participant).await;
    if enabled {
        ensure_meeting_started(state, channel_id, conn_id).await;
    }
}

async fn handle_phrase(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(text) = payload.get("text").and_then(Value::as_str) else {
        return;
    };
    let text: String = text.trim().chars().take(MAX_PHRASE_CHARS).collect();
    if text.is_empty() {
        return;
    }

    let at = Utc::now();
    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            return send_error(tx, channel_id, "not_in_room");
        };
        let Some(participant) = room.participants.get(&conn_id) else {
            return send_error(tx, channel_id, "not_in_room");
        };
        if !participant.transcribing {
            None
        } else {
            let participant = participant.clone();
            let attendance_id = room.attendance_ids.get(&conn_id).copied();
            let meeting_id = room.active_meeting_id;
            let armed = record_phrase(
                room,
                participant.display_name.clone(),
                text.clone(),
                Instant::now(),
            );
            Some((participant, attendance_id, meeting_id, armed))
        }
    };

    let Some((participant, attendance_id, meeting_id, armed)) = result else {
        return;
    };
    if let Some(meeting_id) = meeting_id {
        let attendee = live_attendee(&participant);
        match meetings::save_live_phrase(
            state,
            meeting_id,
            attendance_id,
            &attendee,
            &text,
            at,
        )
        .await
        {
            Ok(id) => {
                let targets = voice_targets(state, channel_id, &[]).await;
                state
                    .hub
                    .broadcast(
                        envelope(
                            "meeting.phrase",
                            json!({
                                "meeting_id": meeting_id,
                                "channel_id": channel_id,
                                "id": id.to_string(),
                                "user_id": participant.user_id,
                                "display_name": participant.display_name,
                                "guest": participant.guest,
                                "text": text,
                                "spoken_at": at,
                            }),
                        ),
                        targets,
                    )
                    .await;
            }
            Err(error) => tracing::warn!("meeting phrase persistence failed: {}", error),
        }
    }
    if armed {
        broadcast_roast_armed(state, channel_id, true).await;
    }
}

fn record_phrase(
    room: &mut VoiceRoom,
    display_name: String,
    text: String,
    now: Instant,
) -> bool {
    room.transcript.push_back(VoicePhrase {
        display_name,
        text,
        at: now,
    });
    if room.transcript.len() > MAX_TRANSCRIPT_PHRASES {
        room.transcript.pop_front();
    }

    if room
        .last_phrase_at
        .is_some_and(|last| now.duration_since(last) <= PHRASE_STREAK_GAP)
    {
        room.phrase_count = room.phrase_count.saturating_add(1);
    } else {
        room.phrase_count = 1;
    }
    room.last_phrase_at = Some(now);

    if room.phrase_count >= PHRASE_STREAK_THRESHOLD && !room.roast_armed {
        room.roast_armed = true;
        true
    } else {
        false
    }
}

fn live_attendee(participant: &VoiceParticipant) -> LiveAttendee {
    LiveAttendee {
        connection_id: participant.conn_id,
        user_id: if participant.guest { None } else { Some(participant.user_id) },
        display_name: participant.display_name.clone(),
        guest: participant.guest,
        joined_at: participant.joined_at,
    }
}

async fn ensure_meeting_started(state: &SharedState, channel_id: Uuid, conn_id: Uuid) {
    let (creator, attendees) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            return;
        };
        if room.active_meeting_id.is_some() || room.meeting_starting {
            return;
        }
        room.meeting_starting = true;
        let creator = room
            .participants
            .get(&conn_id)
            .filter(|participant| !participant.guest)
            .map(|participant| participant.user_id);
        let attendees = room.participants.values().map(live_attendee).collect::<Vec<_>>();
        (creator, attendees)
    };

    match meetings::start_live_meeting(state, channel_id, creator, &attendees).await {
        Ok((meeting_id, attendance_ids)) => {
            let (room_still_active, missing, departed) = {
                let mut guard = state.voice_rooms.lock().unwrap();
                if let Some(room) = guard.get_mut(&channel_id) {
                    room.active_meeting_id = Some(meeting_id);
                    room.meeting_starting = false;
                    room.attendance_ids.extend(attendance_ids);
                    let missing = room
                        .participants
                        .values()
                        .filter(|participant| !room.attendance_ids.contains_key(&participant.conn_id))
                        .map(live_attendee)
                        .collect::<Vec<_>>();
                    let departed = room
                        .attendance_ids
                        .keys()
                        .filter(|conn_id| !room.participants.contains_key(conn_id))
                        .copied()
                        .collect::<Vec<_>>();
                    (!room.participants.is_empty(), missing, departed)
                } else {
                    (false, Vec::new(), Vec::new())
                }
            };
            if !room_still_active {
                let _ = meetings::finish_live_meeting(state, meeting_id, Utc::now(), false).await;
                return;
            }
            for attendee in missing {
                if let Ok(attendance_id) =
                    meetings::add_live_attendee(state, meeting_id, &attendee).await
                {
                    let mut guard = state.voice_rooms.lock().unwrap();
                    if let Some(room) = guard.get_mut(&channel_id) {
                        room.attendance_ids
                            .insert(attendee.connection_id, attendance_id);
                    }
                }
            }
            for connection_id in departed {
                let _ = meetings::close_live_attendee(
                    state,
                    meeting_id,
                    connection_id,
                    Utc::now(),
                )
                .await;
            }
            let targets = voice_targets(state, channel_id, &[]).await;
            state
                .hub
                .broadcast(
                    envelope(
                        "meeting.started",
                        json!({ "meeting_id": meeting_id, "channel_id": channel_id, "started_at": Utc::now() }),
                    ),
                    targets,
                )
                .await;
        }
        Err(error) => {
            tracing::warn!("meeting start failed: {}", error);
            let mut guard = state.voice_rooms.lock().unwrap();
            if let Some(room) = guard.get_mut(&channel_id) {
                room.meeting_starting = false;
            }
        }
    }
}

async fn handle_camera(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
        return;
    };

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.get_mut(&channel_id) {
            Some(room) => update_camera(room, conn_id, enabled),
            None => CameraUpdateResult::Missing,
        }
    };

    let participant = match result {
        CameraUpdateResult::Missing => {
            send_error(tx, channel_id, "not_in_room");
            return;
        }
        CameraUpdateResult::Full => {
            send_error(tx, channel_id, "camera_full");
            return;
        }
        CameraUpdateResult::Updated(participant) => participant,
    };

    broadcast_participant_updated(state, channel_id, participant).await;
}

enum CameraUpdateResult {
    Missing,
    Full,
    Updated(VoiceParticipant),
}

fn update_camera(room: &mut VoiceRoom, conn_id: Uuid, enabled: bool) -> CameraUpdateResult {
    let Some(current) = room.participants.get(&conn_id) else {
        return CameraUpdateResult::Missing;
    };
    if current.camera_on == enabled {
        return CameraUpdateResult::Updated(current.clone());
    }
    if enabled
        && room
            .participants
            .values()
            .filter(|participant| participant.camera_on)
            .count()
            >= MAX_CAMERAS
    {
        return CameraUpdateResult::Full;
    }

    let participant = room.participants.get_mut(&conn_id).unwrap();
    participant.camera_on = enabled;
    CameraUpdateResult::Updated(participant.clone())
}

async fn handle_screen(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
        return;
    };
    let stream_id = payload
        .get("stream_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.get_mut(&channel_id) {
            Some(room) => update_screen(room, conn_id, enabled, stream_id),
            None => ScreenUpdateResult::Missing,
        }
    };

    let participant = match result {
        ScreenUpdateResult::Missing => {
            send_error(tx, channel_id, "not_in_room");
            return;
        }
        ScreenUpdateResult::Full => {
            send_error(tx, channel_id, "screen_taken");
            return;
        }
        ScreenUpdateResult::Updated(participant) => participant,
    };

    broadcast_participant_updated(state, channel_id, participant).await;
}

enum ScreenUpdateResult {
    Missing,
    Full,
    Updated(VoiceParticipant),
}

fn update_screen(
    room: &mut VoiceRoom,
    conn_id: Uuid,
    enabled: bool,
    stream_id: Option<String>,
) -> ScreenUpdateResult {
    let Some(current) = room.participants.get(&conn_id) else {
        return ScreenUpdateResult::Missing;
    };
    if current.screen_on == enabled {
        return ScreenUpdateResult::Updated(current.clone());
    }
    if enabled
        && room
            .participants
            .values()
            .filter(|participant| participant.screen_on)
            .count()
            >= MAX_SCREENS
    {
        return ScreenUpdateResult::Full;
    }

    let participant = room.participants.get_mut(&conn_id).unwrap();
    participant.screen_on = enabled;
    participant.screen_stream_id = if enabled { stream_id } else { None };
    ScreenUpdateResult::Updated(participant.clone())
}

async fn broadcast_participant_updated(
    state: &SharedState,
    channel_id: Uuid,
    participant: VoiceParticipant,
) {
    let targets = voice_targets(state, channel_id, &[]).await;
    let event = envelope(
        "voice.participant_updated",
        json!({
            "channel_id": channel_id.to_string(),
            "participant": participant,
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
    Existing(Vec<VoiceParticipant>, Option<Uuid>),
    Joined(VoiceParticipant, Vec<VoiceParticipant>, Option<Uuid>),
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

fn send_state(
    tx: &WsSender,
    channel_id: Uuid,
    participants: Vec<VoiceParticipant>,
    active_meeting_id: Option<Uuid>,
) {
    let event = envelope(
        "voice.state",
        json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
            "active_meeting_id": active_meeting_id,
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
    // The participant is already removed from the room map, so include their id
    // explicitly to guarantee they receive their own leave event.
    let targets = voice_targets(state, channel_id, &[user_id]).await;
    let event = participant_left_event(channel_id, conn_id, user_id);
    state.hub.broadcast(event, targets).await;
}

async fn finish_and_broadcast_meeting(
    state: &SharedState,
    channel_id: Uuid,
    meeting_id: Uuid,
    ended_at: DateTime<Utc>,
    interrupted: bool,
) {
    if let Err(error) =
        meetings::finish_live_meeting(state, meeting_id, ended_at, interrupted).await
    {
        tracing::warn!("meeting finish failed: {}", error);
        return;
    }
    let targets = voice_targets(state, channel_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "meeting.ended",
                json!({
                    "meeting_id": meeting_id,
                    "channel_id": channel_id,
                    "ended_at": ended_at,
                    "status": if interrupted { "interrupted" } else { "completed" },
                }),
            ),
            targets,
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(camera_on: bool) -> VoiceParticipant {
        VoiceParticipant {
            conn_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            display_name: "Tester".to_string(),
            guest: false,
            muted: false,
            transcribing: false,
            camera_on,
            screen_on: false,
            screen_stream_id: None,
            hand_raised: false,
            hand_raised_at: None,
            joined_at: Utc::now(),
        }
    }

    fn room_with(camera_states: &[bool]) -> VoiceRoom {
        let participants = camera_states
            .iter()
            .map(|camera_on| participant(*camera_on))
            .map(|participant| (participant.conn_id, participant))
            .collect();
        VoiceRoom {
            participants,
            ..Default::default()
        }
    }

    fn screen_participant(screen_on: bool) -> VoiceParticipant {
        VoiceParticipant {
            conn_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            display_name: "Tester".to_string(),
            guest: false,
            muted: false,
            transcribing: false,
            camera_on: false,
            screen_on,
            screen_stream_id: if screen_on {
                Some("stream-existing".to_string())
            } else {
                None
            },
            hand_raised: false,
            hand_raised_at: None,
            joined_at: Utc::now(),
        }
    }

    fn room_with_screens(screen_states: &[bool]) -> VoiceRoom {
        let participants = screen_states
            .iter()
            .map(|screen_on| screen_participant(*screen_on))
            .map(|participant| (participant.conn_id, participant))
            .collect();
        VoiceRoom {
            participants,
            ..Default::default()
        }
    }

    #[test]
    fn phrase_streak_arms_once_and_resets_after_gap() {
        let start = Instant::now();
        let mut room = VoiceRoom::default();

        assert!(!record_phrase(
            &mut room,
            "Tester".to_string(),
            "one".to_string(),
            start,
        ));
        assert!(!record_phrase(
            &mut room,
            "Tester".to_string(),
            "two".to_string(),
            start + Duration::from_secs(20),
        ));
        assert!(record_phrase(
            &mut room,
            "Tester".to_string(),
            "three".to_string(),
            start + Duration::from_secs(40),
        ));
        assert!(!record_phrase(
            &mut room,
            "Tester".to_string(),
            "four".to_string(),
            start + Duration::from_secs(41),
        ));

        let mut expired = VoiceRoom::default();
        record_phrase(
            &mut expired,
            "Tester".to_string(),
            "one".to_string(),
            start,
        );
        record_phrase(
            &mut expired,
            "Tester".to_string(),
            "two".to_string(),
            start + Duration::from_secs(21),
        );
        assert_eq!(expired.phrase_count, 1);
        assert!(!expired.roast_armed);
    }

    #[test]
    fn camera_toggle_is_idempotent() {
        let mut room = room_with(&[false]);
        let conn_id = *room.participants.keys().next().unwrap();

        assert!(matches!(
            update_camera(&mut room, conn_id, false),
            CameraUpdateResult::Updated(participant) if !participant.camera_on
        ));
        assert!(matches!(
            update_camera(&mut room, conn_id, true),
            CameraUpdateResult::Updated(participant) if participant.camera_on
        ));
        assert!(matches!(
            update_camera(&mut room, conn_id, true),
            CameraUpdateResult::Updated(participant) if participant.camera_on
        ));
    }

    #[test]
    fn fifth_camera_is_rejected_until_slot_is_released() {
        let mut room = room_with(&[true, true, true, true, false]);
        let waiting = room
            .participants
            .values()
            .find(|participant| !participant.camera_on)
            .unwrap()
            .conn_id;
        assert!(matches!(
            update_camera(&mut room, waiting, true),
            CameraUpdateResult::Full
        ));

        let active = room
            .participants
            .values()
            .find(|participant| participant.camera_on)
            .unwrap()
            .conn_id;
        assert!(matches!(
            update_camera(&mut room, active, false),
            CameraUpdateResult::Updated(participant) if !participant.camera_on
        ));
        assert!(matches!(
            update_camera(&mut room, waiting, true),
            CameraUpdateResult::Updated(participant) if participant.camera_on
        ));
    }

    #[test]
    fn camera_toggle_requires_room_participant() {
        let mut room = room_with(&[false]);
        assert!(matches!(
            update_camera(&mut room, Uuid::new_v4(), true),
            CameraUpdateResult::Missing
        ));
    }

    #[test]
    fn removing_participant_releases_camera_slot() {
        let mut room = room_with(&[true, true, true, true, false]);
        let active = room
            .participants
            .values()
            .find(|participant| participant.camera_on)
            .unwrap()
            .conn_id;
        let waiting = room
            .participants
            .values()
            .find(|participant| !participant.camera_on)
            .unwrap()
            .conn_id;

        room.participants.remove(&active);
        assert!(matches!(
            update_camera(&mut room, waiting, true),
            CameraUpdateResult::Updated(participant) if participant.camera_on
        ));
    }

    #[test]
    fn screen_toggle_is_idempotent() {
        let mut room = room_with_screens(&[false]);
        let conn_id = *room.participants.keys().next().unwrap();

        assert!(matches!(
            update_screen(&mut room, conn_id, false, None),
            ScreenUpdateResult::Updated(participant)
                if !participant.screen_on && participant.screen_stream_id.is_none()
        ));
        assert!(matches!(
            update_screen(&mut room, conn_id, true, Some("stream-a".to_string())),
            ScreenUpdateResult::Updated(participant)
                if participant.screen_on
                    && participant.screen_stream_id.as_deref() == Some("stream-a")
        ));
        // Enabling again while already on is a no-op that preserves existing state.
        assert!(matches!(
            update_screen(&mut room, conn_id, true, Some("stream-b".to_string())),
            ScreenUpdateResult::Updated(participant)
                if participant.screen_on
                    && participant.screen_stream_id.as_deref() == Some("stream-a")
        ));
    }

    #[test]
    fn second_screen_is_rejected_until_slot_is_released() {
        let mut room = room_with_screens(&[true, false]);
        let waiting = room
            .participants
            .values()
            .find(|participant| !participant.screen_on)
            .unwrap()
            .conn_id;
        assert!(matches!(
            update_screen(&mut room, waiting, true, Some("stream-new".to_string())),
            ScreenUpdateResult::Full
        ));

        let active = room
            .participants
            .values()
            .find(|participant| participant.screen_on)
            .unwrap()
            .conn_id;
        assert!(matches!(
            update_screen(&mut room, active, false, None),
            ScreenUpdateResult::Updated(participant)
                if !participant.screen_on && participant.screen_stream_id.is_none()
        ));
        assert!(matches!(
            update_screen(&mut room, waiting, true, Some("stream-new".to_string())),
            ScreenUpdateResult::Updated(participant)
                if participant.screen_on
                    && participant.screen_stream_id.as_deref() == Some("stream-new")
        ));
    }

    #[test]
    fn removing_participant_releases_screen_slot() {
        let mut room = room_with_screens(&[true, false]);
        let active = room
            .participants
            .values()
            .find(|participant| participant.screen_on)
            .unwrap()
            .conn_id;
        let waiting = room
            .participants
            .values()
            .find(|participant| !participant.screen_on)
            .unwrap()
            .conn_id;

        room.participants.remove(&active);
        assert!(matches!(
            update_screen(&mut room, waiting, true, Some("stream-new".to_string())),
            ScreenUpdateResult::Updated(participant)
                if participant.screen_on
                    && participant.screen_stream_id.as_deref() == Some("stream-new")
        ));
    }
}
