//! Drawing over a shared screen (`voice.annotate*`).
//!
//! Contract: docs/arch/04-voice.md.
//!
//! Only one screen share exists at a time, and the **sharer owns the permission**: they
//! flip `annotations_allowed`, and everyone else may only draw while it is true. Strokes
//! are relative coordinates so they land correctly on every viewer's layout, and each
//! participant is assigned a stable colour from `ANNOTATION_PALETTE` on join.
//!
//! The size caps below exist because strokes arrive over the socket and are relayed
//! verbatim: they bound what one client can make every other client render.
//!
//! Annotations are cleared whenever the share ends — see
//! `reset_annotations_if_screen_gone`, which every room-departure path must call.

use super::{channel_id, send_error, update_screen, voice_targets, ScreenUpdateResult, VoiceRoom};
use crate::state::SharedState;
use crate::ws::{envelope, WsSender};
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

/// Distinct, saturated hues assigned to participants as their annotation
/// (pen) color; readable over arbitrary shared-screen content.
pub(crate) const ANNOTATION_PALETTE: [&str; 12] = [
    "#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
    "#8b5cf6", "#d946ef", "#ec4899", "#f43f5e",
];

/// Wire caps for a relayed annotation stroke.
pub(crate) const MAX_ANNOTATION_STROKE_ID: usize = 64;

pub(crate) const MAX_ANNOTATION_POINTS: usize = 128;

pub(crate) const MAX_ANNOTATION_SIZE: f64 = 0.02;

/// Apply a screen update and keep collaborative drawing permission in sync with
/// the share lifecycle. A new share starts open so every participant can draw;
/// the sharer may still disable drawing afterward. Repeated enable events must
/// not undo that explicit choice.
pub(crate) fn update_screen_with_annotations(
    room: &mut VoiceRoom,
    conn_id: Uuid,
    enabled: bool,
    stream_id: Option<String>,
) -> (ScreenUpdateResult, Option<bool>) {
    let was_screen_on = room
        .participants
        .get(&conn_id)
        .is_some_and(|participant| participant.screen_on);
    let result = update_screen(room, conn_id, enabled, stream_id);
    if !matches!(result, ScreenUpdateResult::Updated(_)) {
        return (result, None);
    }

    let annotation_state_changed = if enabled && !was_screen_on {
        if room.annotations_allowed {
            None
        } else {
            room.annotations_allowed = true;
            Some(true)
        }
    } else if !enabled && reset_annotations_if_screen_gone(room) {
        Some(false)
    } else {
        None
    };
    (result, annotation_state_changed)
}

/// Pick a pen color for a joining participant: prefer a palette hue not already
/// used in the room, else derive a stable index from the conn_id bytes (avoids
/// pulling in a rand crate for the fallback).
pub(crate) fn pick_annotation_color(room: &VoiceRoom, conn_id: Uuid) -> String {
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
pub(crate) fn reset_annotations_if_screen_gone(room: &mut VoiceRoom) -> bool {
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

pub(crate) async fn broadcast_annotate_state(
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

pub(crate) async fn handle_annotate_allow(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
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

pub(crate) async fn handle_annotate(
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

pub(crate) async fn handle_annotate_clear(state: &SharedState, conn_id: Uuid, payload: &Value, tx: &WsSender) {
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
