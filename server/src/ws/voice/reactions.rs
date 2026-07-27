//! Live emoji reactions during a call (`voice.react`).
//!
//! Contract: docs/arch/04-voice.md.
//!
//! A pure relay like `annotate.rs`: nothing is persisted, so late joiners see only
//! reactions sent after they arrive. Two guards exist because the emoji is echoed
//! verbatim into every participant's stage overlay:
//!
//!   - `sanitize_reaction` keeps the payload pictographic. Without it a "reaction"
//!     is an unmoderated text banner on everyone's screen.
//!   - `allow_reaction` is a per-connection sliding window, so one held-down key
//!     cannot paper the room.
//!
//! Both refusals are **silent**. A tap routinely races a leave, and a dropped
//! reaction is not worth an error toast.

use super::{channel_id, voice_targets};
use crate::state::SharedState;
use crate::ws::envelope;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// A reaction is one emoji, which may still be several code points (skin tone,
/// ZWJ sequences, variation selectors) — hence a char budget rather than 1.
pub(crate) const MAX_REACTION_CHARS: usize = 8;

/// Sliding-window rate limit per connection.
const REACTION_WINDOW: Duration = Duration::from_secs(2);
const MAX_REACTIONS_PER_WINDOW: usize = 5;

/// Accept a short pictographic string, or nothing. ASCII and whitespace are
/// rejected outright: they are what turns a reaction into text.
pub(crate) fn sanitize_reaction(payload: &Value) -> Option<String> {
    let raw = payload.get("emoji").and_then(Value::as_str)?.trim();
    if raw.is_empty() || raw.chars().count() > MAX_REACTION_CHARS {
        return None;
    }
    if raw
        .chars()
        .any(|c| c.is_ascii() || c.is_whitespace() || c.is_control())
    {
        return None;
    }
    Some(raw.to_string())
}

/// Whether one more reaction fits in this connection's window, consuming a slot
/// when it does. Expired timestamps are dropped as a side effect, so the deque
/// stays bounded by `MAX_REACTIONS_PER_WINDOW`.
pub(crate) fn allow_reaction(window: &mut VecDeque<Instant>, now: Instant) -> bool {
    while window
        .front()
        .is_some_and(|at| now.duration_since(*at) >= REACTION_WINDOW)
    {
        window.pop_front();
    }
    if window.len() >= MAX_REACTIONS_PER_WINDOW {
        return false;
    }
    window.push_back(now);
    true
}

pub(crate) async fn handle_react(
    state: &SharedState,
    user_id: Uuid,
    conn_id: Uuid,
    payload: &Value,
) {
    let Some(channel_id) = channel_id(payload) else {
        return;
    };
    let Some(emoji) = sanitize_reaction(payload) else {
        return;
    };
    // The name comes from the room, never the payload: a reaction is attributed.
    let display_name = {
        let mut guard = state.voice_rooms.lock().unwrap();
        let Some(room) = guard.get_mut(&channel_id) else {
            return;
        };
        let Some(display_name) = room
            .participants
            .get(&conn_id)
            .map(|participant| participant.display_name.clone())
        else {
            return;
        };
        let window = room.reaction_windows.entry(conn_id).or_default();
        if !allow_reaction(window, Instant::now()) {
            return;
        }
        display_name
    };

    let targets = voice_targets(state, channel_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "voice.reaction",
                json!({
                    "channel_id": channel_id.to_string(),
                    "conn_id": conn_id.to_string(),
                    "user_id": user_id.to_string(),
                    "display_name": display_name,
                    "emoji": emoji,
                }),
            ),
            targets,
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_emoji_including_multi_codepoint_sequences() {
        for emoji in ["👍", "❤️", "🎉", "👏🏽", "🧑‍🚀"] {
            assert_eq!(
                sanitize_reaction(&json!({ "emoji": emoji })).as_deref(),
                Some(emoji),
                "expected {emoji} to be accepted",
            );
        }
    }

    #[test]
    fn rejects_text_and_oversized_payloads() {
        for emoji in [
            "",
            "   ",
            "lgtm",
            "👍 nice",
            "a👍",
            "👍!",
            "👍👍👍👍👍👍👍👍👍",
        ] {
            assert!(
                sanitize_reaction(&json!({ "emoji": emoji })).is_none(),
                "expected {emoji:?} to be rejected",
            );
        }
        assert!(sanitize_reaction(&json!({})).is_none());
        assert!(sanitize_reaction(&json!({ "emoji": 7 })).is_none());
    }

    #[test]
    fn rate_limit_caps_a_burst_then_refills() {
        let mut window = VecDeque::new();
        let start = Instant::now();
        for _ in 0..MAX_REACTIONS_PER_WINDOW {
            assert!(allow_reaction(&mut window, start));
        }
        assert!(!allow_reaction(&mut window, start));
        // Still inside the window: the burst is spent.
        assert!(!allow_reaction(
            &mut window,
            start + REACTION_WINDOW - Duration::from_millis(1)
        ));
        // Past it: the oldest timestamps expire and the budget returns.
        assert!(allow_reaction(&mut window, start + REACTION_WINDOW));
        assert_eq!(window.len(), 1);
    }
}
