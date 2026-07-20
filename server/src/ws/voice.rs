use crate::gif;
use crate::routes::gifs;
use crate::routes::meetings::{self, LiveAttendee};
use crate::routes::messages;
use crate::routes::polls::{self, CreatePollRequest};
use crate::state::SharedState;
use crate::ws::{envelope, GuestInfo, WsSender};
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
/// Distinct, saturated hues assigned to participants as their annotation
/// (pen) color; readable over arbitrary shared-screen content.
const ANNOTATION_PALETTE: [&str; 12] = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
    "#8b5cf6", "#d946ef", "#ec4899", "#f43f5e",
];
/// Wire caps for a relayed annotation stroke.
const MAX_ANNOTATION_STROKE_ID: usize = 64;
const MAX_ANNOTATION_POINTS: usize = 128;
const MAX_ANNOTATION_SIZE: f64 = 0.02;
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
    /// CSS hex color assigned at join for this participant's pen annotations.
    pub annotation_color: String,
    pub joined_at: DateTime<Utc>,
}

pub struct VoicePhrase {
    pub display_name: String,
    pub text: String,
    pub at: Instant,
}

#[derive(Clone)]
pub struct CallVote {
    pub display_name: String,
    pub guest: bool,
    pub option_ids: Vec<Uuid>,
}

#[derive(Clone)]
pub struct CallPollOption {
    pub id: Uuid,
    pub text: String,
}

#[derive(Clone)]
pub struct CallPoll {
    pub id: Uuid,
    pub room_id: Uuid,
    pub question: String,
    pub multi: bool,
    pub persistent_poll_id: Option<Uuid>,
    pub creator_id: Uuid,
    pub expires_at: Option<DateTime<Utc>>,
    pub closed: bool,
    pub options: Vec<CallPollOption>,
    pub votes: HashMap<Uuid, CallVote>,
}

#[derive(Serialize)]
struct CallVoterRef {
    id: Uuid,
    display_name: String,
    guest: bool,
}

#[derive(Serialize)]
struct CallPollOptionWire {
    id: Uuid,
    text: String,
    count: i64,
    voters: Vec<CallVoterRef>,
}

#[derive(Serialize)]
struct CallPollWire {
    id: Uuid,
    room_id: Uuid,
    question: String,
    multi: bool,
    persistent_poll_id: Option<Uuid>,
    creator_id: Uuid,
    expires_at: Option<DateTime<Utc>>,
    closed: bool,
    options: Vec<CallPollOptionWire>,
    my_votes: Option<Vec<Uuid>>,
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

pub fn snapshot_transcript(
    state: &SharedState,
    channel_id: Uuid,
    minutes: i64,
) -> Vec<(String, String)> {
    let now = Instant::now();
    let seconds = u64::try_from(minutes)
        .unwrap_or_default()
        .saturating_mul(60);
    let cutoff = now.checked_sub(Duration::from_secs(seconds)).unwrap_or(now);
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
        "voice.join" => {
            handle_join(state, user_id, conn_id, display_name, guest, &payload, tx).await
        }
        "voice.leave" => handle_leave(state, user_id, conn_id, &payload, tx).await,
        "voice.mute" => handle_mute(state, conn_id, &payload, tx).await,
        "voice.transcribe" => handle_transcribe(state, conn_id, &payload, tx).await,
        "voice.phrase" => handle_phrase(state, conn_id, &payload, tx).await,
        "voice.camera" => handle_camera(state, conn_id, &payload, tx).await,
        "voice.screen" => handle_screen(state, conn_id, &payload, tx).await,
        "voice.hand" => handle_hand(state, conn_id, &payload, tx).await,
        "voice.signal" => handle_signal(state, user_id, conn_id, &payload, tx).await,
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

async fn build_call_poll(
    state: &SharedState,
    call_poll: &CallPoll,
) -> crate::error::AppResult<CallPollWire> {
    let (mut options, closed) = if let Some(persistent_id) = call_poll.persistent_poll_id {
        let persistent = polls::load_poll(&state.pool, persistent_id, None).await?;
        let options = persistent
            .options
            .into_iter()
            .map(|option| CallPollOptionWire {
                id: option.id,
                text: option.text,
                count: option.count,
                voters: option
                    .voters
                    .into_iter()
                    .map(|voter| CallVoterRef {
                        id: voter.id,
                        display_name: voter.display_name,
                        guest: false,
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        (options, call_poll.closed || persistent.closed_at.is_some())
    } else {
        (
            call_poll
                .options
                .iter()
                .map(|option| CallPollOptionWire {
                    id: option.id,
                    text: option.text.clone(),
                    count: 0,
                    voters: Vec::new(),
                })
                .collect(),
            call_poll.closed,
        )
    };

    let indexes: HashMap<Uuid, usize> = options
        .iter()
        .enumerate()
        .map(|(index, option)| (option.id, index))
        .collect();
    let mut votes: Vec<(Uuid, &CallVote)> = call_poll
        .votes
        .iter()
        .map(|(id, vote)| (*id, vote))
        .collect();
    votes.sort_by_key(|(id, _)| *id);
    for (voter_id, vote) in votes {
        for option_id in &vote.option_ids {
            if let Some(index) = indexes.get(option_id) {
                options[*index].count += 1;
                options[*index].voters.push(CallVoterRef {
                    id: voter_id,
                    display_name: vote.display_name.clone(),
                    guest: vote.guest,
                });
            }
        }
    }

    Ok(CallPollWire {
        id: call_poll.id,
        room_id: call_poll.room_id,
        question: call_poll.question.clone(),
        multi: call_poll.multi,
        persistent_poll_id: call_poll.persistent_poll_id,
        creator_id: call_poll.creator_id,
        expires_at: call_poll.expires_at,
        closed,
        options,
        my_votes: None,
    })
}

async fn broadcast_poll_state(state: &SharedState, room_id: Uuid) {
    let poll = {
        let guard = state.voice_rooms.lock().unwrap();
        guard.get(&room_id).and_then(|room| room.poll.clone())
    };
    let poll = match poll {
        Some(poll) => match build_call_poll(state, &poll).await {
            Ok(poll) => Some(poll),
            Err(error) => {
                tracing::warn!("voice poll state build failed: {}", error);
                return;
            }
        },
        None => None,
    };
    let targets = voice_targets(state, room_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "voice.poll_state",
                json!({ "room_id": room_id, "poll": poll }),
            ),
            targets,
        )
        .await;
}

pub async fn broadcast_for_persistent_poll(state: &SharedState, poll_id: Uuid) {
    let room_ids: Vec<Uuid> = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .iter()
            .filter_map(|(room_id, room)| {
                room.poll
                    .as_ref()
                    .is_some_and(|poll| poll.persistent_poll_id == Some(poll_id))
                    .then_some(*room_id)
            })
            .collect()
    };
    for room_id in room_ids {
        broadcast_poll_state(state, room_id).await;
    }
}

pub async fn expire_call_polls(state: &SharedState) {
    let room_ids: Vec<Uuid> = {
        let mut guard = state.voice_rooms.lock().unwrap();
        guard
            .iter_mut()
            .filter_map(|(room_id, room)| {
                let poll = room.poll.as_mut()?;
                if poll.persistent_poll_id.is_none()
                    && !poll.closed
                    && poll.expires_at.is_some_and(|at| at <= Utc::now())
                {
                    poll.closed = true;
                    Some(*room_id)
                } else {
                    None
                }
            })
            .collect()
    };
    for room_id in room_ids {
        broadcast_poll_state(state, room_id).await;
    }
}

async fn broadcast_null_poll(state: &SharedState, room_id: Uuid, extra: &[Uuid]) {
    let targets = voice_targets(state, room_id, extra).await;
    state
        .hub
        .broadcast(
            envelope(
                "voice.poll_state",
                json!({ "room_id": room_id, "poll": Value::Null }),
            ),
            targets,
        )
        .await;
}

fn poll_room_id(payload: &Value) -> Option<Uuid> {
    uuid_field(payload, "room_id")
}

fn poll_option_ids(payload: &Value) -> Option<Vec<Uuid>> {
    payload
        .get("option_ids")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().and_then(|value| Uuid::parse_str(value).ok()))
        .collect()
}

async fn handle_poll_create(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    _display_name: &str,
    guest: Option<&GuestInfo>,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(room_id) = poll_room_id(payload) else {
        return;
    };
    if guest.is_some() {
        send_error(tx, room_id, "guests_cannot_create_polls");
        return;
    }
    let in_room = {
        let guard = state.voice_rooms.lock().unwrap();
        guard.get(&room_id).is_some_and(|room| {
            room.participants
                .get(&conn_id)
                .is_some_and(|participant| participant.user_id == user_id)
                && room.poll.is_none()
        })
    };
    if !in_room {
        send_error(tx, room_id, "not_in_room_or_poll_exists");
        return;
    }
    let Some(question) = payload.get("question").and_then(Value::as_str) else {
        return;
    };
    let Some(option_values) = payload.get("options").and_then(Value::as_array) else {
        return;
    };
    let Some(options) = option_values
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()
    else {
        return;
    };
    let Some(multi) = payload.get("multi").and_then(Value::as_bool) else {
        return;
    };
    let expires_at = match payload.get("expires_at") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => match DateTime::parse_from_rfc3339(value) {
            Ok(value) => Some(value.with_timezone(&Utc)),
            Err(_) => {
                send_error(tx, room_id, "invalid_expires_at");
                return;
            }
        },
        _ => return,
    };
    let request = CreatePollRequest {
        question: question.to_string(),
        options,
        multi,
        pinned: false,
        expires_at,
    };
    let (question, option_texts) = match polls::validate_create(&request) {
        Ok(validated) => validated,
        Err(_) => {
            send_error(tx, room_id, "invalid_poll");
            return;
        }
    };

    let channel_attached = sqlx::query("SELECT 1 AS x FROM channels WHERE id = $1")
        .bind(room_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .is_some();
    let (persistent_poll_id, call_options) = if channel_attached {
        match polls::create_poll_shared(state, room_id, user_id, &request).await {
            Ok(poll) => {
                let options = poll
                    .options
                    .into_iter()
                    .map(|option| CallPollOption {
                        id: option.id,
                        text: option.text,
                    })
                    .collect();
                (Some(poll.id), options)
            }
            Err(error) => {
                tracing::warn!("voice persistent poll create failed: {}", error);
                send_error(tx, room_id, "poll_create_failed");
                return;
            }
        }
    } else {
        let standalone = sqlx::query("SELECT 1 AS x FROM standalone_calls WHERE id = $1")
            .bind(room_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .is_some();
        if !standalone {
            send_error(tx, room_id, "room_not_found");
            return;
        }
        (
            None,
            option_texts
                .into_iter()
                .map(|text| CallPollOption {
                    id: Uuid::new_v4(),
                    text,
                })
                .collect(),
        )
    };

    let call_poll = CallPoll {
        id: Uuid::new_v4(),
        room_id,
        question,
        multi,
        persistent_poll_id,
        creator_id: user_id,
        expires_at,
        closed: false,
        options: call_options,
        votes: HashMap::new(),
    };
    {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&room_id) else {
            return;
        };
        if room.poll.is_some() {
            send_error(tx, room_id, "poll_exists");
            return;
        }
        room.poll = Some(call_poll);
    }
    broadcast_poll_state(state, room_id).await;
}

async fn handle_poll_vote(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    display_name: &str,
    guest: Option<&GuestInfo>,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(room_id) = poll_room_id(payload) else {
        return;
    };
    let Some(call_poll_id) = uuid_field(payload, "poll_id") else {
        return;
    };
    let Some(option_ids) = poll_option_ids(payload) else {
        return;
    };
    let poll = {
        let guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get(&room_id) else {
            send_error(tx, room_id, "not_in_room");
            return;
        };
        if !room.participants.contains_key(&conn_id) {
            send_error(tx, room_id, "not_in_room");
            return;
        }
        let Some(poll) = room.poll.clone().filter(|poll| poll.id == call_poll_id) else {
            send_error(tx, room_id, "poll_not_found");
            return;
        };
        poll
    };
    if poll.closed || poll.expires_at.is_some_and(|at| at <= Utc::now()) {
        send_error(tx, room_id, "poll_closed");
        return;
    }
    let unique: HashSet<Uuid> = option_ids.iter().copied().collect();
    let valid_options: HashSet<Uuid> = poll.options.iter().map(|option| option.id).collect();
    if unique.len() != option_ids.len()
        || (!poll.multi && option_ids.len() > 1)
        || !unique.is_subset(&valid_options)
    {
        send_error(tx, room_id, "invalid_vote");
        return;
    }

    if guest.is_none() {
        if let Some(persistent_id) = poll.persistent_poll_id {
            if let Err(error) =
                polls::replace_votes(state, persistent_id, user_id, &option_ids, true).await
            {
                tracing::warn!("voice persistent poll vote failed: {}", error);
                send_error(tx, room_id, "vote_failed");
                return;
            }
            return;
        }
    }

    {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(active_poll) = guard.get_mut(&room_id).and_then(|room| room.poll.as_mut()) else {
            return;
        };
        if active_poll.id != call_poll_id || active_poll.closed {
            send_error(tx, room_id, "poll_closed");
            return;
        }
        if option_ids.is_empty() {
            active_poll.votes.remove(&user_id);
        } else {
            active_poll.votes.insert(
                user_id,
                CallVote {
                    display_name: display_name.to_string(),
                    guest: guest.is_some(),
                    option_ids,
                },
            );
        }
    }
    broadcast_poll_state(state, room_id).await;
}

async fn handle_poll_close(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(room_id) = poll_room_id(payload) else {
        return;
    };
    let Some(call_poll_id) = uuid_field(payload, "poll_id") else {
        return;
    };
    let persistent_id = {
        let guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get(&room_id) else {
            send_error(tx, room_id, "not_in_room");
            return;
        };
        if !room.participants.contains_key(&conn_id) {
            send_error(tx, room_id, "not_in_room");
            return;
        }
        let Some(poll) = room.poll.as_ref().filter(|poll| poll.id == call_poll_id) else {
            send_error(tx, room_id, "poll_not_found");
            return;
        };
        if poll.creator_id != user_id {
            send_error(tx, room_id, "not_poll_creator");
            return;
        }
        poll.persistent_poll_id
    };
    if let Some(persistent_id) = persistent_id {
        if let Err(error) = polls::finalize_poll_and_notify(state, persistent_id, "manual").await {
            tracing::warn!("voice persistent poll close failed: {}", error);
            send_error(tx, room_id, "poll_close_failed");
            return;
        }
    }
    {
        let mut guard = state.voice_rooms.lock().unwrap();
        if let Some(poll) = guard
            .get_mut(&room_id)
            .and_then(|room| room.poll.as_mut())
            .filter(|poll| poll.id == call_poll_id)
        {
            poll.closed = true;
        }
    }
    if persistent_id.is_none() {
        broadcast_poll_state(state, room_id).await;
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
        match meetings::save_live_phrase(state, meeting_id, attendance_id, &attendee, &text, at)
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
    if !participant.guest {
        let trigger_state = state.clone();
        tokio::spawn(async move {
            maybe_fire_voice_trigger(trigger_state, channel_id, participant, text).await;
        });
    }
}

fn phrase_words(value: &str) -> Vec<String> {
    let normalized: String = value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect();
    normalized.split_whitespace().map(str::to_string).collect()
}

fn phrase_match_start(spoken: &str, trigger: &str) -> Option<usize> {
    let spoken = phrase_words(spoken);
    let trigger = phrase_words(trigger);
    if trigger.is_empty() || trigger.len() > spoken.len() {
        return None;
    }
    spoken
        .windows(trigger.len())
        .position(|window| window == trigger.as_slice())
}

fn sanitize_gif_token_field(value: &str) -> String {
    value.replace(['|', ']'], "").trim().to_string()
}

async fn maybe_fire_voice_trigger(
    state: SharedState,
    channel_id: Uuid,
    participant: VoiceParticipant,
    spoken: String,
) {
    let settings = gif::load_settings(&state.pool, &state.config).await;
    if !settings.duck_enabled || state.config.deepseek.is_none() {
        return;
    }
    let Some(provider) = gif::resolve_provider(&settings) else {
        return;
    };
    let Some(deepseek_config) = state.config.deepseek.as_ref() else {
        return;
    };

    let rows = match sqlx::query(
        "SELECT channel_id, phrase
         FROM voice_triggers
         WHERE action = 'gif'
           AND (channel_id = $1 OR (user_id = $2 AND channel_id IS NULL))
         ORDER BY created_at, id",
    )
    .bind(channel_id)
    .bind(participant.user_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!("voice trigger lookup failed: {}", error);
            return;
        }
    };

    let mut matched: Option<(usize, bool, String)> = None;
    for row in rows {
        let Ok(trigger_channel) = row.try_get::<Option<Uuid>, _>("channel_id") else {
            continue;
        };
        let Ok(phrase) = row.try_get::<String, _>("phrase") else {
            continue;
        };
        let Some(start) = phrase_match_start(&spoken, &phrase) else {
            continue;
        };
        let personal = trigger_channel.is_none();
        let replace = matched
            .as_ref()
            .is_none_or(|(best_start, best_personal, _)| {
                start < *best_start || (start == *best_start && !personal && *best_personal)
            });
        if replace {
            matched = Some((start, personal, phrase));
        }
    }
    let Some((_, _, trigger_phrase)) = matched else {
        return;
    };

    match gifs::try_acquire_suggestion_cooldown(&state, channel_id, settings.duck_cooldown_secs) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::warn!("voice trigger cooldown failed: {}", error);
            return;
        }
    }

    let transcript = match gifs::load_recent_messages(&state, channel_id, 5).await {
        Ok(transcript) if transcript.len() >= 2 => transcript,
        Ok(_) => return,
        Err(error) => {
            tracing::warn!("voice trigger context failed: {}", error);
            return;
        }
    };
    let (query, results) = match gifs::suggest_best_gif(
        &state,
        &settings.provider,
        deepseek_config,
        provider.as_ref(),
        &transcript,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!("voice trigger GIF suggestion failed: {}", error);
            return;
        }
    };
    let Some(result) = results.first() else {
        tracing::warn!("voice trigger GIF suggestion returned no results");
        return;
    };
    let alt = sanitize_gif_token_field(&result.title);
    let alt = if alt.is_empty() { "gif" } else { &alt };
    let query = sanitize_gif_token_field(&query);
    let content = format!("[[gif:{}|{}|duck|{}]]", result.url, alt, query);
    if let Err(error) =
        messages::post_message_as(&state, channel_id, participant.user_id, &content).await
    {
        tracing::warn!("voice trigger message post failed: {}", error);
        return;
    }

    let targets = voice_targets(&state, channel_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "voice.trigger_fired",
                json!({
                    "channel_id": channel_id,
                    "user_id": participant.user_id,
                    "display_name": participant.display_name,
                    "phrase": trigger_phrase,
                }),
            ),
            targets,
        )
        .await;
}

fn record_phrase(room: &mut VoiceRoom, display_name: String, text: String, now: Instant) -> bool {
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
        user_id: if participant.guest {
            None
        } else {
            Some(participant.user_id)
        },
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
        let attendees = room
            .participants
            .values()
            .map(live_attendee)
            .collect::<Vec<_>>();
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
                        .filter(|participant| {
                            !room.attendance_ids.contains_key(&participant.conn_id)
                        })
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
                let _ = meetings::close_live_attendee(state, meeting_id, connection_id, Utc::now())
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

    let (result, annotations_reset) = {
        let mut guard = state.voice_rooms.lock().unwrap();
        match guard.get_mut(&channel_id) {
            Some(room) => {
                let result = update_screen(room, conn_id, enabled, stream_id);
                // Ending the share revokes any annotation permission it granted.
                let reset = matches!(result, ScreenUpdateResult::Updated(_))
                    && reset_annotations_if_screen_gone(room);
                (result, reset)
            }
            None => (ScreenUpdateResult::Missing, false),
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
    if annotations_reset {
        broadcast_annotate_state(state, channel_id, false, &[]).await;
    }
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

/// Pick a pen color for a joining participant: prefer a palette hue not already
/// used in the room, else derive a stable index from the conn_id bytes (avoids
/// pulling in a rand crate for the fallback).
fn pick_annotation_color(room: &VoiceRoom, conn_id: Uuid) -> String {
    let used: HashSet<&str> = room
        .participants
        .values()
        .map(|participant| participant.annotation_color.as_str())
        .collect();
    if let Some(color) = ANNOTATION_PALETTE
        .iter()
        .find(|color| !used.contains(**color))
    {
        return (*color).to_string();
    }
    let index = conn_id
        .as_bytes()
        .iter()
        .fold(0usize, |acc, byte| acc.wrapping_add(*byte as usize));
    ANNOTATION_PALETTE[index % ANNOTATION_PALETTE.len()].to_string()
}

/// When a room has no active screen share but still permits annotations, revoke
/// the permission. Returns `true` when it flipped from allowed to denied (the
/// caller must broadcast the reset). Callable while holding the rooms lock.
fn reset_annotations_if_screen_gone(room: &mut VoiceRoom) -> bool {
    if room.annotations_allowed
        && !room
            .participants
            .values()
            .any(|participant| participant.screen_on)
    {
        room.annotations_allowed = false;
        true
    } else {
        false
    }
}

async fn broadcast_annotate_state(
    state: &SharedState,
    channel_id: Uuid,
    allowed: bool,
    extra: &[Uuid],
) {
    let targets = voice_targets(state, channel_id, extra).await;
    let event = envelope(
        "voice.annotate_state",
        json!({
            "channel_id": channel_id.to_string(),
            "allowed": allowed,
        }),
    );
    state.hub.broadcast(event, targets).await;
}

async fn handle_annotate_allow(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(allowed) = payload.get("allowed").and_then(Value::as_bool) else {
        return;
    };
    let changed = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            send_error(tx, channel_id, "annotate_denied");
            return;
        };
        // Only the participant holding the single screen-share slot may toggle.
        let is_sharer = room
            .participants
            .get(&conn_id)
            .is_some_and(|participant| participant.screen_on);
        if !is_sharer {
            send_error(tx, channel_id, "annotate_denied");
            return;
        }
        if room.annotations_allowed == allowed {
            // Idempotent: no state change, no broadcast.
            None
        } else {
            room.annotations_allowed = allowed;
            Some(allowed)
        }
    };
    if let Some(allowed) = changed {
        broadcast_annotate_state(state, channel_id, allowed, &[]).await;
    }
}

async fn handle_annotate(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
    tx: &WsSender,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(stroke_id) = payload.get("stroke_id").and_then(Value::as_str) else {
        return;
    };
    if stroke_id.chars().count() > MAX_ANNOTATION_STROKE_ID {
        return;
    }
    let Some(kind) = payload.get("kind").and_then(Value::as_str) else {
        return;
    };
    if !matches!(kind, "start" | "points" | "end") {
        return;
    }
    let Some(raw_points) = payload.get("points").and_then(Value::as_array) else {
        return;
    };
    if raw_points.len() > MAX_ANNOTATION_POINTS {
        return;
    }
    let mut points: Vec<[f64; 2]> = Vec::with_capacity(raw_points.len());
    for pair in raw_points {
        let Some(pair) = pair.as_array().filter(|pair| pair.len() == 2) else {
            return;
        };
        let (Some(x), Some(y)) = (pair[0].as_f64(), pair[1].as_f64()) else {
            return;
        };
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        points.push([x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)]);
    }
    let size = match payload.get("size") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let Some(size) = value.as_f64() else {
                return;
            };
            if !size.is_finite() || size <= 0.0 {
                return;
            }
            Some(size.min(MAX_ANNOTATION_SIZE))
        }
    };

    let color = {
        let guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get(&channel_id) else {
            send_error(tx, channel_id, "not_in_room");
            return;
        };
        let Some(participant) = room.participants.get(&conn_id) else {
            send_error(tx, channel_id, "not_in_room");
            return;
        };
        let has_screen = room
            .participants
            .values()
            .any(|participant| participant.screen_on);
        // Drawing needs an active share, and either open permission or that the
        // sender is the sharer (who may always draw on their own screen).
        if !has_screen || (!room.annotations_allowed && !participant.screen_on) {
            send_error(tx, channel_id, "annotate_denied");
            return;
        }
        participant.annotation_color.clone()
    };

    let mut body = json!({
        "channel_id": channel_id.to_string(),
        "conn_id": conn_id.to_string(),
        "user_id": user_id.to_string(),
        "color": color,
        "stroke_id": stroke_id,
        "kind": kind,
        "points": points,
    });
    if let Some(size) = size {
        body["size"] = json!(size);
    }
    let targets = voice_targets(state, channel_id, &[]).await;
    state
        .hub
        .broadcast(envelope("voice.annotate", body), targets)
        .await;
}

async fn handle_annotate_clear(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let is_sharer = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .get(&channel_id)
            .and_then(|room| room.participants.get(&conn_id))
            .is_some_and(|participant| participant.screen_on)
    };
    if !is_sharer {
        send_error(tx, channel_id, "annotate_denied");
        return;
    }
    let targets = voice_targets(state, channel_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "voice.annotate_clear",
                json!({ "channel_id": channel_id.to_string() }),
            ),
            targets,
        )
        .await;
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
            annotation_color: ANNOTATION_PALETTE[0].to_string(),
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
