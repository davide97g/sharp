//! Voice/video room registry and the `voice.*` WebSocket event surface.
//!
//! Contract: docs/arch/04-voice.md — the event list in `handle_voice_event` below and
//! the one in that document must stay in lockstep.
//!
//! Rooms are **ephemeral and per-replica**: `VoiceRooms` is an in-memory map keyed by
//! channel id (or standalone-call id), rebuilt from nothing on restart. LiveKit carries
//! the media; this module only authorizes joins, mints 60-second room tokens, and
//! coordinates who is in the room with what enabled.
//!
//! The limits — 25 participants, 16 cameras, 1 screen share — are **product policy, not
//! technical ceilings**. See `livekit.rs` for the constants.
//!
//! Guardrail: every mutation of a `VoiceRoom` must broadcast to the room's members. There
//! is no reconciliation poll, so a missed broadcast leaves clients showing a stale roster
//! until they rejoin. `broadcast_participant_updated` and `send_state` are the two ways.
//!
//! Guardrail: the room mutex is a `std::sync::Mutex`. Never hold the guard across an
//! `.await` — take what you need, drop the guard, then do the async work.
//!
//! Split across four files, all sharing this module's `VoiceRoom` state:
//!   - this file — membership (join/leave), mic/camera/screen/hand, room lifecycle,
//!     snapshots, and the event dispatch table
//!   - `polls.rs` — in-call polls, including the boundary where a call poll is persisted
//!   - `annotate.rs` — drawing over a shared screen
//!   - `meeting.rs` — transcript phrases, voice triggers, and meeting records

use crate::livekit::{self, MediaCredentials, MAX_CAMERAS, MAX_PARTICIPANTS};
use crate::routes::meetings;
use crate::state::SharedState;
use crate::ws::{envelope, GuestInfo, WsSender};
use axum::extract::ws::Message;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

mod annotate;
mod meeting;
mod polls;

// The submodules are implementation detail of `ws::voice`; everything the rest of the
// crate (and this file, and the tests below) uses is re-exported here, so `ws::voice::X`
// keeps working exactly as before the split.
pub(crate) use annotate::{
    broadcast_annotate_state, handle_annotate, handle_annotate_allow, handle_annotate_clear,
    pick_annotation_color, reset_annotations_if_screen_gone, update_screen_with_annotations,
};
pub(crate) use meeting::{
    ensure_meeting_started, finish_and_broadcast_meeting, handle_phrase, live_attendee,
};
pub use meeting::{broadcast_roast_armed, consume_roast_armed, snapshot_transcript, VoicePhrase};
pub(crate) use polls::{
    broadcast_null_poll, build_call_poll, handle_poll_close, handle_poll_create, handle_poll_vote,
    CallPoll,
};
pub use polls::{broadcast_for_persistent_poll, expire_call_polls};
const MAX_SCREENS: usize = 1;

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
    /// CSS hex color assigned at join for this participant's pen annotations.
    pub annotation_color: String,
    /// Audio-aura style this participant broadcasts to the room, so every viewer
    /// sees their chosen signature. `None` falls back to the viewer's local style.
    pub aura_style: Option<String>,
    /// Position in the spatial room, normalized to 0..1 on both axes (x = left to
    /// right, y = top to bottom of the floor plan). Assigned a spread-out spawn at
    /// join and moved by `voice.move`. Every client gets it even when the spatial
    /// view is off — switching views must not need a round trip.
    pub pos_x: f64,
    pub pos_y: f64,
    pub joined_at: DateTime<Utc>,
}

/// Spawn points walk a golden-angle spiral out from the middle of the floor, so
/// each new arrival lands clear of everyone already standing there. Deterministic
/// (no RNG) and collision-aware: the first point at least `SPAWN_MIN_GAP` from
/// every occupied spot wins, falling back to the center when the floor is packed.
const SPAWN_MIN_GAP: f64 = 0.11;
const SPAWN_GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;

fn spawn_position(room: &VoiceRoom) -> (f64, f64) {
    let taken: Vec<(f64, f64)> = room
        .participants
        .values()
        .map(|participant| (participant.pos_x, participant.pos_y))
        .collect();
    for step in 0..64 {
        let angle = step as f64 * SPAWN_GOLDEN_ANGLE;
        let radius = 0.055 * (step as f64).sqrt();
        let x = clamp_unit(0.5 + radius * angle.cos());
        let y = clamp_unit(0.5 + radius * angle.sin());
        if taken
            .iter()
            .all(|(ox, oy)| ((x - ox).powi(2) + (y - oy).powi(2)).sqrt() >= SPAWN_MIN_GAP)
        {
            return (x, y);
        }
    }
    (0.5, 0.5)
}

fn clamp_unit(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// The audio-aura styles a client may broadcast. Validated server-side so an
/// arbitrary value never reaches other clients' avatar class names.
const AURA_STYLES: [&str; 5] = ["helios", "mercury", "voiceprint", "kinetic-type", "eclipse"];

fn sanitize_aura_style(payload: &Value) -> Option<String> {
    let value = payload.get("aura_style").and_then(Value::as_str)?;
    AURA_STYLES
        .contains(&value)
        .then(|| value.to_string())
}

/// Resolve the audience for a voice broadcast: the union of the channel's
/// members and the user-ids currently in the room (so guests, who are not
/// channel members, still receive participant events), plus any extra ids the
/// caller supplies (e.g. a just-removed participant for `participant_left`).
pub(crate) async fn voice_targets(state: &SharedState, room_id: Uuid, extra: &[Uuid]) -> Vec<Uuid> {
    let mut ids: HashSet<Uuid> = HashSet::new();
    match sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM channel_members WHERE channel_id = $1
         UNION
         SELECT created_by AS user_id FROM standalone_calls WHERE id = $1
         UNION
         SELECT DISTINCT a.user_id
           FROM meetings m
           JOIN meeting_attendance a ON a.meeting_id = m.id
          WHERE m.standalone_call_id = $1 AND a.user_id IS NOT NULL",
    )
    .bind(room_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(members) => ids.extend(members),
        Err(error) => {
            // Still deliver to in-room users (incl. guests) even if the member
            // lookup fails, so live events aren't silently dropped.
            tracing::warn!("voice room {} audience lookup failed: {}", room_id, error);
        }
    }
    {
        let guard = state.voice_rooms.lock().unwrap();
        if let Some(room) = guard.get(&room_id) {
            for participant in room.participants.values() {
                ids.insert(participant.user_id);
            }
        }
    }
    ids.extend(extra.iter().copied());
    ids.into_iter().collect()
}

/// Fetch a room's current voice-link token (used to validate guest joins).
async fn current_voice_link_token(
    pool: &sqlx::PgPool,
    room_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT token FROM (
             SELECT id, voice_link_token AS token FROM channels
             UNION ALL
             SELECT id, link_token AS token FROM standalone_calls
         ) rooms WHERE id = $1",
    )
    .bind(room_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => row.try_get::<Option<String>, _>("token"),
        None => Ok(None),
    }
}

async fn can_registered_user_join(
    state: &SharedState,
    room_id: Uuid,
    user_id: Uuid,
    supplied_link: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if let Some(link) = supplied_link {
        if current_voice_link_token(&state.pool, room_id)
            .await?
            .as_deref()
            == Some(link)
        {
            return Ok(true);
        }
    }
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM channel_members
              WHERE channel_id = $1 AND user_id = $2 AND role IN ('owner', 'editor')
         ) OR EXISTS (
             SELECT 1 FROM standalone_calls WHERE id = $1 AND created_by = $2
         )",
    )
    .bind(room_id)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(allowed)
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
    pub poll: Option<CallPoll>,
    /// Whether the current sharer permits others to draw over the shared screen.
    pub annotations_allowed: bool,
}

pub type VoiceRooms = Mutex<HashMap<Uuid, VoiceRoom>>;

pub async fn snapshot_for(state: &SharedState, user_id: Uuid, guest: Option<&GuestInfo>) -> Value {
    let visible: HashSet<Uuid> = match guest {
        Some(info) => HashSet::from([info.channel_id]),
        None => sqlx::query_scalar::<_, Uuid>(
            "SELECT channel_id AS room_id FROM channel_members
              WHERE user_id = $1 AND role IN ('owner', 'editor')
             UNION
             SELECT id AS room_id FROM standalone_calls WHERE created_by = $1
             UNION
             SELECT DISTINCT m.standalone_call_id AS room_id
               FROM meetings m
               JOIN meeting_attendance a ON a.meeting_id = m.id
              WHERE a.user_id = $1 AND m.standalone_call_id IS NOT NULL",
        )
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect(),
    };
    let mut rooms: Vec<(Uuid, Vec<VoiceParticipant>, Option<Uuid>, Option<CallPoll>, bool)> = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .iter()
            .filter(|(room_id, room)| {
                visible.contains(room_id)
                    || room
                        .participants
                        .values()
                        .any(|participant| participant.user_id == user_id)
            })
            .map(|(channel_id, room)| {
                let mut participants: Vec<VoiceParticipant> =
                    room.participants.values().cloned().collect();
                participants.sort_by_key(|participant| participant.conn_id);
                (
                    *channel_id,
                    participants,
                    room.active_meeting_id,
                    room.poll.clone(),
                    room.annotations_allowed,
                )
            })
            .collect()
    };
    rooms.sort_by_key(|(channel_id, _, _, _, _)| *channel_id);
    let mut snapshots = Vec::with_capacity(rooms.len());
    for (channel_id, participants, active_meeting_id, poll, annotations_allowed) in rooms {
        let poll = match poll {
            Some(poll) => build_call_poll(state, &poll).await.ok(),
            None => None,
        };
        snapshots.push(json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
            "active_meeting_id": active_meeting_id,
            "poll": poll,
            "annotations_allowed": annotations_allowed,
        }));
    }
    json!(snapshots)
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
        "voice.join" => {
            handle_join(state, user_id, conn_id, display_name, guest, &payload, tx).await
        }
        "voice.leave" => handle_leave(state, user_id, conn_id, &payload, tx).await,
        "voice.mute" => handle_mute(state, conn_id, &payload, tx).await,
        "voice.transcribe" => handle_transcribe(state, conn_id, &payload, tx).await,
        "voice.aura" => handle_aura(state, conn_id, &payload, tx).await,
        "voice.move" => handle_move(state, conn_id, &payload).await,
        "voice.phrase" => handle_phrase(state, conn_id, &payload, tx).await,
        "voice.camera" => handle_camera(state, conn_id, &payload, tx).await,
        "voice.screen" => handle_screen(state, conn_id, &payload, tx).await,
        "voice.hand" => handle_hand(state, conn_id, &payload, tx).await,
        "voice.poll_create" => {
            handle_poll_create(state, user_id, conn_id, display_name, guest, &payload, tx).await
        }
        "voice.poll_vote" => {
            handle_poll_vote(state, user_id, conn_id, display_name, guest, &payload, tx).await
        }
        "voice.poll_close" => handle_poll_close(state, user_id, conn_id, &payload, tx).await,
        "voice.annotate_allow" => handle_annotate_allow(state, conn_id, &payload, tx).await,
        "voice.annotate" => handle_annotate(state, user_id, conn_id, &payload, tx).await,
        "voice.annotate_clear" => handle_annotate_clear(state, conn_id, &payload, tx).await,
        _ => {}
    }
}

pub async fn cleanup_conn(state: &SharedState, user_id: Uuid, conn_id: Uuid) {
    let removed: Vec<(Uuid, VoiceParticipant, Option<Uuid>, bool, bool, bool)> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let mut removed = Vec::new();
        for (channel_id, room) in guard.iter_mut() {
            if let Some(participant) = room.participants.remove(&conn_id) {
                room.attendance_ids.remove(&conn_id);
                // Losing the sharer's conn ends the share, so revoke annotations.
                let annotations_reset = reset_annotations_if_screen_gone(room);
                removed.push((
                    *channel_id,
                    participant,
                    room.active_meeting_id,
                    room.participants.is_empty(),
                    room.participants.is_empty() && room.poll.is_some(),
                    annotations_reset,
                ));
            }
        }
        guard.retain(|_, room| !room.participants.is_empty());
        removed
    };

    for (channel_id, participant, meeting_id, room_ended, poll_ended, annotations_reset) in removed {
        debug_assert_eq!(participant.user_id, user_id);
        if let Some(config) = state.config.livekit.as_ref() {
            livekit::remove_participant(config, channel_id, participant.conn_id).await;
        }
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
        if poll_ended {
            broadcast_null_poll(state, channel_id, &[participant.user_id]).await;
        }
        if annotations_reset {
            broadcast_annotate_state(state, channel_id, false, &[participant.user_id]).await;
        }
        broadcast_participant_left(state, channel_id, conn_id, user_id).await;
    }
}

pub async fn remove_member_from_room(state: &SharedState, channel_id: Uuid, user_id: Uuid) {
    let (mut removed, meeting_id, room_ended, poll_ended, annotations_reset): (
        Vec<VoiceParticipant>,
        Option<Uuid>,
        bool,
        bool,
        bool,
    ) = {
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
        // Evicting the sharer ends the share, so revoke annotations.
        let annotations_reset = reset_annotations_if_screen_gone(room);
        let meeting_id = room.active_meeting_id;
        let room_ended = room.participants.is_empty();
        let poll_ended = room_ended && room.poll.is_some();
        if room_ended {
            guard.remove(&channel_id);
        }
        (removed, meeting_id, room_ended, poll_ended, annotations_reset)
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let left_at = Utc::now();
    if let Some(config) = state.config.livekit.as_ref() {
        for participant in &removed {
            livekit::remove_participant(config, channel_id, participant.conn_id).await;
        }
    }
    if let Some(meeting_id) = meeting_id {
        for participant in &removed {
            let _ = meetings::close_live_attendee(state, meeting_id, participant.conn_id, left_at)
                .await;
        }
        if room_ended {
            finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
        }
    }

    // Include removed (possibly-guest) user-ids so they receive their leave event.
    let extra: Vec<Uuid> = removed.iter().map(|p| p.user_id).collect();
    if poll_ended {
        broadcast_null_poll(state, channel_id, &extra).await;
    }
    if annotations_reset {
        broadcast_annotate_state(state, channel_id, false, &extra).await;
    }
    let targets = voice_targets(state, channel_id, &extra).await;
    for participant in removed {
        let event = participant_left_event(channel_id, participant.conn_id, participant.user_id);
        state.hub.broadcast(event, targets.clone()).await;
    }
}

pub async fn close_room(state: &SharedState, channel_id: Uuid) {
    let (mut removed, meeting_id, had_poll, had_annotations): (
        Vec<VoiceParticipant>,
        Option<Uuid>,
        bool,
        bool,
    ) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.remove(&channel_id) {
            Some(room) => {
                let had_poll = room.poll.is_some();
                let had_annotations = room.annotations_allowed;
                (
                    room.participants.into_values().collect(),
                    room.active_meeting_id,
                    had_poll,
                    had_annotations,
                )
            }
            None => return,
        }
    };
    removed.sort_by_key(|participant| participant.conn_id);

    let left_at = Utc::now();
    if let Some(config) = state.config.livekit.as_ref() {
        for participant in &removed {
            livekit::remove_participant(config, channel_id, participant.conn_id).await;
        }
    }
    if let Some(meeting_id) = meeting_id {
        for participant in &removed {
            let _ = meetings::close_live_attendee(state, meeting_id, participant.conn_id, left_at)
                .await;
        }
        finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
    }

    // Room is gone from the map, so seed targets with all removed user-ids
    // (members + guests) to guarantee delivery of the leave events.
    let extra: Vec<Uuid> = removed.iter().map(|p| p.user_id).collect();
    if had_poll {
        broadcast_null_poll(state, channel_id, &extra).await;
    }
    if had_annotations {
        broadcast_annotate_state(state, channel_id, false, &extra).await;
    }
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
                tracing::warn!("voice room {} link lookup failed: {}", channel_id, error);
                return;
            }
        },
        None => match can_registered_user_join(
            state,
            channel_id,
            user_id,
            payload.get("link_token").and_then(Value::as_str),
        )
        .await
        {
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
        },
    }

    let Some(livekit_config) = state.config.livekit.as_ref() else {
        send_error(tx, channel_id, "media_unavailable");
        return;
    };
    let media = match livekit::join_credentials(
        livekit_config,
        channel_id,
        conn_id,
        user_id,
        display_name,
        guest.is_some(),
    ) {
        Ok(media) => media,
        Err(error) => {
            tracing::error!("LiveKit join token generation failed: {}", error);
            send_error(tx, channel_id, "media_unavailable");
            return;
        }
    };

    let result = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let room = guard.entry(channel_id).or_default();
        if room.participants.contains_key(&conn_id) {
            JoinResult::Existing(
                room_participants(room),
                room.active_meeting_id,
                room.poll.clone(),
                room.annotations_allowed,
            )
        } else if room.participants.len() >= MAX_PARTICIPANTS {
            JoinResult::Full
        } else {
            let annotation_color = pick_annotation_color(room, conn_id);
            let (pos_x, pos_y) = spawn_position(room);
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
                annotation_color,
                aura_style: sanitize_aura_style(payload),
                pos_x,
                pos_y,
                joined_at: Utc::now(),
            };
            room.participants.insert(conn_id, participant.clone());
            JoinResult::Joined(
                participant,
                room_participants(room),
                room.active_meeting_id,
                room.poll.clone(),
                room.annotations_allowed,
            )
        }
    };

    let participant = match result {
        JoinResult::Full => {
            send_error(tx, channel_id, "room_full");
            return;
        }
        JoinResult::Existing(participants, active_meeting_id, poll, annotations_allowed) => {
            send_state(
                state,
                tx,
                channel_id,
                participants,
                active_meeting_id,
                poll,
                annotations_allowed,
                &media,
            )
            .await;
            return;
        }
        JoinResult::Joined(participant, participants, active_meeting_id, poll, annotations_allowed) => {
            send_state(
                state,
                tx,
                channel_id,
                participants,
                active_meeting_id,
                poll,
                annotations_allowed,
                &media,
            )
            .await;
            participant
        }
    };

    let active_meeting_id = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .get(&channel_id)
            .and_then(|room| room.active_meeting_id)
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
    let (participant, meeting_id, room_ended, poll_ended, annotations_reset) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            send_error(tx, channel_id, "not_in_room");
            return;
        };
        let removed = room.participants.remove(&conn_id);
        room.attendance_ids.remove(&conn_id);
        // A departing sharer ends the share, so revoke annotations.
        let annotations_reset = removed.is_some() && reset_annotations_if_screen_gone(room);
        let meeting_id = room.active_meeting_id;
        let room_ended = room.participants.is_empty();
        let poll_ended = room_ended && room.poll.is_some();
        if room_ended {
            guard.remove(&channel_id);
        }
        (removed, meeting_id, room_ended, poll_ended, annotations_reset)
    };

    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };
    debug_assert_eq!(participant.user_id, user_id);
    if let Some(config) = state.config.livekit.as_ref() {
        livekit::remove_participant(config, channel_id, conn_id).await;
    }
    let left_at = Utc::now();
    if let Some(meeting_id) = meeting_id {
        if let Err(error) = meetings::close_live_attendee(state, meeting_id, conn_id, left_at).await
        {
            tracing::warn!("meeting attendance leave failed: {}", error);
        }
        if room_ended {
            finish_and_broadcast_meeting(state, channel_id, meeting_id, left_at, false).await;
        }
    }
    if poll_ended {
        broadcast_null_poll(state, channel_id, &[user_id]).await;
    }
    if annotations_reset {
        broadcast_annotate_state(state, channel_id, false, &[user_id]).await;
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

async fn handle_aura(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    // An absent/unknown style clears the broadcast, reverting viewers to their
    // own local fallback style for this participant.
    let aura_style = sanitize_aura_style(payload);
    let participant = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
            .map(|participant| {
                participant.aura_style = aura_style;
                participant.clone()
            })
    };
    let Some(participant) = participant else {
        send_error(tx, channel_id, "not_in_room");
        return;
    };

    broadcast_participant_updated(state, channel_id, participant).await;
}

/// Spatial-room movement. Deliberately quiet and light: coordinates arrive at
/// pointer/keyboard rate, so a move broadcasts a 4-field `voice.participant_moved`
/// rather than the whole participant, and a move from a connection that already
/// left is dropped without an error (the client throttles, the leave races it).
async fn handle_move(state: &SharedState, conn_id: Uuid, payload: &Value) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let (Some(x), Some(y)) = (
        payload.get("x").and_then(Value::as_f64),
        payload.get("y").and_then(Value::as_f64),
    ) else {
        return;
    };
    if !x.is_finite() || !y.is_finite() {
        return;
    }
    let (x, y) = (clamp_unit(x), clamp_unit(y));

    let moved = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .get_mut(&channel_id)
            .and_then(|room| room.participants.get_mut(&conn_id))
            .map(|participant| {
                participant.pos_x = x;
                participant.pos_y = y;
            })
            .is_some()
    };
    if !moved {
        return;
    }

    let targets = voice_targets(state, channel_id, &[]).await;
    let event = envelope(
        "voice.participant_moved",
        json!({
            "channel_id": channel_id.to_string(),
            "conn_id": conn_id.to_string(),
            "x": x,
            "y": y,
        }),
    );
    state.hub.broadcast(event, targets).await;
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
                    participant.hand_raised_at = if raised {
                        Some(Utc::now().timestamp_millis())
                    } else {
                        None
                    };
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

    if let Some(config) = state.config.livekit.as_ref() {
        if let Err(error) = livekit::set_publish_permissions(
            config,
            channel_id,
            conn_id,
            participant.camera_on,
            participant.screen_on,
        )
        .await
        {
            tracing::warn!("LiveKit camera permission update failed: {}", error);
            if enabled {
                let mut guard = state.voice_rooms.lock().unwrap();
                if let Some(room) = guard.get_mut(&channel_id) {
                    let _ = update_camera(room, conn_id, false);
                }
                send_error(tx, channel_id, "media_unavailable");
                return;
            }
            send_error(tx, channel_id, "media_unavailable");
        }
    }

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

    let (result, annotation_state_changed) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.get_mut(&channel_id) {
            Some(room) => update_screen_with_annotations(room, conn_id, enabled, stream_id),
            None => (ScreenUpdateResult::Missing, None),
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

    if let Some(config) = state.config.livekit.as_ref() {
        if let Err(error) = livekit::set_publish_permissions(
            config,
            channel_id,
            conn_id,
            participant.camera_on,
            participant.screen_on,
        )
        .await
        {
            tracing::warn!("LiveKit screen permission update failed: {}", error);
            if enabled {
                let mut guard = state.voice_rooms.lock().unwrap();
                if let Some(room) = guard.get_mut(&channel_id) {
                    let _ = update_screen_with_annotations(room, conn_id, false, None);
                }
                send_error(tx, channel_id, "media_unavailable");
                return;
            }
            send_error(tx, channel_id, "media_unavailable");
        }
    }

    broadcast_participant_updated(state, channel_id, participant).await;
    if let Some(allowed) = annotation_state_changed {
        broadcast_annotate_state(state, channel_id, allowed, &[]).await;
    }
}

pub(crate) enum ScreenUpdateResult {
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

enum JoinResult {
    Full,
    Existing(Vec<VoiceParticipant>, Option<Uuid>, Option<CallPoll>, bool),
    Joined(
        VoiceParticipant,
        Vec<VoiceParticipant>,
        Option<Uuid>,
        Option<CallPoll>,
        bool,
    ),
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

async fn send_state(
    state: &SharedState,
    tx: &WsSender,
    channel_id: Uuid,
    participants: Vec<VoiceParticipant>,
    active_meeting_id: Option<Uuid>,
    poll: Option<CallPoll>,
    annotations_allowed: bool,
    media: &MediaCredentials,
) {
    let poll = match poll {
        Some(poll) => build_call_poll(state, &poll).await.ok(),
        None => None,
    };
    let event = envelope(
        "voice.state",
        json!({
            "channel_id": channel_id.to_string(),
            "participants": participants,
            "active_meeting_id": active_meeting_id,
            "poll": poll,
            "annotations_allowed": annotations_allowed,
            "media": media,
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

#[cfg(test)]
mod tests {
    use super::annotate::ANNOTATION_PALETTE;
    use super::meeting::{phrase_match_start, record_phrase};
    use super::*;
    use std::time::Duration;

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
            annotation_color: ANNOTATION_PALETTE[0].to_string(),
            aura_style: None,
            pos_x: 0.5,
            pos_y: 0.5,
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
            annotation_color: ANNOTATION_PALETTE[0].to_string(),
            aura_style: None,
            pos_x: 0.5,
            pos_y: 0.5,
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
        record_phrase(&mut expired, "Tester".to_string(), "one".to_string(), start);
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
    fn voice_trigger_matching_uses_word_boundaries() {
        assert_eq!(phrase_match_start("time to roast this", "roast"), Some(2));
        assert_eq!(phrase_match_start("the roasted duck", "roast"), None);
        assert_eq!(phrase_match_start("roast-beef now", "roast beef"), Some(0));
    }

    #[test]
    fn voice_trigger_matching_normalizes_case_spacing_and_punctuation() {
        assert_eq!(
            phrase_match_start("  LET'S... drop   A roast! ", "let's drop a roast"),
            Some(0)
        );
        assert_eq!(
            phrase_match_start("hello, sharp world", "sharp world"),
            Some(1)
        );
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
    fn seventeenth_camera_is_rejected_until_slot_is_released() {
        let mut camera_states = vec![true; MAX_CAMERAS];
        camera_states.push(false);
        let mut room = room_with(&camera_states);
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
        let mut camera_states = vec![true; MAX_CAMERAS];
        camera_states.push(false);
        let mut room = room_with(&camera_states);
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
    fn starting_screen_enables_drawing_for_everyone() {
        let mut room = room_with_screens(&[false, false]);
        let conn_id = *room.participants.keys().next().unwrap();

        let (result, annotation_state_changed) =
            update_screen_with_annotations(&mut room, conn_id, true, Some("stream-a".to_string()));

        assert!(matches!(
            result,
            ScreenUpdateResult::Updated(participant) if participant.screen_on
        ));
        assert!(room.annotations_allowed);
        assert_eq!(annotation_state_changed, Some(true));
    }

    #[test]
    fn repeated_screen_enable_preserves_sharer_drawing_choice() {
        let mut room = room_with_screens(&[true, false]);
        let conn_id = room
            .participants
            .values()
            .find(|participant| participant.screen_on)
            .unwrap()
            .conn_id;
        room.annotations_allowed = false;

        let (_, annotation_state_changed) = update_screen_with_annotations(
            &mut room,
            conn_id,
            true,
            Some("stream-repeated".to_string()),
        );

        assert!(!room.annotations_allowed);
        assert_eq!(annotation_state_changed, None);
    }

    #[test]
    fn ending_screen_disables_drawing_for_everyone() {
        let mut room = room_with_screens(&[true, false]);
        let conn_id = room
            .participants
            .values()
            .find(|participant| participant.screen_on)
            .unwrap()
            .conn_id;
        room.annotations_allowed = true;

        let (_, annotation_state_changed) =
            update_screen_with_annotations(&mut room, conn_id, false, None);

        assert!(!room.annotations_allowed);
        assert_eq!(annotation_state_changed, Some(false));
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

    #[test]
    fn first_spawn_is_the_center_of_the_floor() {
        assert_eq!(spawn_position(&VoiceRoom::default()), (0.5, 0.5));
    }

    #[test]
    fn spawns_stay_apart_and_inside_the_floor() {
        let mut room = VoiceRoom::default();
        let mut placed: Vec<(f64, f64)> = Vec::new();
        for _ in 0..MAX_PARTICIPANTS {
            let (x, y) = spawn_position(&room);
            assert!((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y));
            for (ox, oy) in &placed {
                let distance = ((x - ox).powi(2) + (y - oy).powi(2)).sqrt();
                assert!(distance >= SPAWN_MIN_GAP, "spawned on top of a neighbour");
            }
            placed.push((x, y));
            let mut participant = participant(false);
            participant.pos_x = x;
            participant.pos_y = y;
            room.participants.insert(participant.conn_id, participant);
        }
    }

    #[test]
    fn positions_clamp_into_the_unit_square() {
        assert_eq!(clamp_unit(-0.4), 0.0);
        assert_eq!(clamp_unit(1.7), 1.0);
        assert_eq!(clamp_unit(0.25), 0.25);
    }
}
