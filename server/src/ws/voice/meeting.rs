//! Live transcript phrases, voice triggers, and the durable meeting record.
//!
//! Contract: docs/arch/04-voice.md (transcription, huddle ring) and docs/arch/06-gifs.md
//! (duck roast, durable meeting notes).
//!
//! Three related jobs share this file because they all key off one thing — a recognized
//! phrase arriving from a participant's client:
//!   1. the rolling in-memory transcript (`MAX_TRANSCRIPT_PHRASES` newest, per room)
//!   2. the "roast armed" streak — `PHRASE_STREAK_THRESHOLD` phrases inside
//!      `PHRASE_STREAK_GAP` of each other arms one duck GIF suggestion
//!   3. voice triggers, which fire a GIF when a phrase matches on word boundaries
//!
//! A meeting row is created lazily on the first real activity (`ensure_meeting_started`)
//! and finished when the room empties, so an empty or accidental join leaves no record.
//!
//! Guardrail: transcript text is untrusted user content. It reaches an LLM in
//! `deepseek::summarize_meeting` and a message body via GIF tokens — keep it sanitized
//! (`sanitize_gif_token_field`) and keep the prompt framing that says so.

use super::{channel_id, send_error, voice_targets, VoiceParticipant, VoiceRoom};
use crate::gif;
use crate::routes::gifs;
use crate::routes::meetings::{self, LiveAttendee};
use crate::routes::messages;
use crate::state::SharedState;
use crate::ws::{envelope, WsSender};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(crate) const MAX_TRANSCRIPT_PHRASES: usize = 50;

pub(crate) const MAX_PHRASE_CHARS: usize = 500;

pub(crate) const PHRASE_STREAK_THRESHOLD: u32 = 3;

pub(crate) const PHRASE_STREAK_GAP: Duration = Duration::from_secs(20);

pub struct VoicePhrase {
    pub display_name: String,
    pub text: String,
    pub at: Instant,
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

pub(crate) async fn handle_phrase(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
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

pub(crate) fn phrase_words(value: &str) -> Vec<String> {
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

pub(crate) fn phrase_match_start(spoken: &str, trigger: &str) -> Option<usize> {
    let spoken = phrase_words(spoken);
    let trigger = phrase_words(trigger);
    if trigger.is_empty() || trigger.len() > spoken.len() {
        return None;
    }
    spoken
        .windows(trigger.len())
        .position(|window| window == trigger.as_slice())
}

pub(crate) fn sanitize_gif_token_field(value: &str) -> String {
    value.replace(['|', ']'], "").trim().to_string()
}

pub(crate) async fn maybe_fire_voice_trigger(
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

pub(crate) fn record_phrase(room: &mut VoiceRoom, display_name: String, text: String, now: Instant) -> bool {
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

pub(crate) fn live_attendee(participant: &VoiceParticipant) -> LiveAttendee {
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

pub(crate) async fn ensure_meeting_started(state: &SharedState, channel_id: Uuid, conn_id: Uuid) {
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

pub(crate) async fn finish_and_broadcast_meeting(
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
