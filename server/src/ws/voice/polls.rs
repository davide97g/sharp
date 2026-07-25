//! In-call polls (`voice.poll_*`).
//!
//! Contract: docs/arch/08-polls.md — see "Call-poll persistence boundary", which is the
//! one subtle rule here: a poll created *inside a call* lives in the room's memory
//! (`VoiceRoom::poll`) and evaporates with the room, unless it is a persistent channel
//! poll being mirrored into the call. Guests may vote in a call poll but never create one.
//!
//! Registered-user votes are attributed by user id, guest votes by connection, so a guest
//! who reconnects gets a fresh vote and a user who rejoins does not.

use super::{send_error, uuid_field, voice_targets};
use crate::routes::polls::{self, CreatePollRequest};
use crate::state::SharedState;
use crate::ws::{envelope, GuestInfo, WsSender};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

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
pub(crate) struct CallVoterRef {
    id: Uuid,
    display_name: String,
    guest: bool,
}

#[derive(Serialize)]
pub(crate) struct CallPollOptionWire {
    id: Uuid,
    text: String,
    count: i64,
    voters: Vec<CallVoterRef>,
}

#[derive(Serialize)]
pub(crate) struct CallPollWire {
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

pub(crate) async fn build_call_poll(
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

pub(crate) async fn broadcast_poll_state(state: &SharedState, room_id: Uuid) {
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

pub(crate) async fn broadcast_null_poll(state: &SharedState, room_id: Uuid, extra: &[Uuid]) {
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

pub(crate) fn poll_room_id(payload: &Value) -> Option<Uuid> {
    uuid_field(payload, "room_id")
}

pub(crate) fn poll_option_ids(payload: &Value) -> Option<Vec<Uuid>> {
    payload
        .get("option_ids")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().and_then(|value| Uuid::parse_str(value).ok()))
        .collect()
}

pub(crate) async fn handle_poll_create(
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

pub(crate) async fn handle_poll_vote(
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

pub(crate) async fn handle_poll_close(
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
