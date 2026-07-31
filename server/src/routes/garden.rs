//! Garden — a private focus space.
//!
//! Garden used to be a shared spatial hub over channels. It is now single
//! player: one fixed default world per person, walked alone, with an optional
//! focus timer. There are no peers, no rooms, no calls and no positions, so
//! there is no WebSocket surface left — the whole feature is these four
//! endpoints plus a Phaser scene the client renders on its own.
//!
//! The server owns exactly two things:
//!
//! - the character roster (`GARDEN_AVATARS`), because the client must not be
//!   able to store an id that would later fail to render, and
//! - the running focus session, because elapsed time has to be derived from a
//!   clock the client cannot move.
//!
//! Everything else about the world — terrain, scenery, collision — is generated
//! client-side from a constant seed (`web/src/lib/garden/terrain.ts`).

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// Character sheets a client may choose. Mirrored by `AVATAR_IDS` in
/// `web/src/components/garden/gardenAvatars.ts` — keep the two in lockstep.
///
/// Validated on write and tolerated-then-ignored on read, so adding or removing
/// a sheet is a code change and never a migration.
pub const GARDEN_AVATARS: [&str; 12] = [
    "samurai",
    "scout",
    "ninja",
    "monk",
    "knight",
    "hunter",
    "royal",
    "noble",
    "explorer",
    "villager",
    "florist",
    "mage",
];

pub fn is_garden_avatar(value: &str) -> bool {
    GARDEN_AVATARS.contains(&value)
}

/// Countdown lengths the picker offers, in minutes. Sent to the client so the
/// two cannot drift; the server still accepts any duration inside
/// `MAX_DURATION_SECS`, because a preset list is a UI affordance, not a rule.
const PRESET_MINUTES: [i32; 6] = [10, 20, 30, 45, 60, 120];

/// Hard ceiling on a countdown, matching the column's own CHECK. A day is far
/// past any focus session and keeps a typo from parking a timer for a month.
const MAX_DURATION_SECS: i32 = 86_400;

#[derive(Serialize)]
pub struct FocusSession {
    id: Uuid,
    mode: String,
    /// Countdown length, or `null` for a stopwatch.
    duration_secs: Option<i32>,
    started_at: DateTime<Utc>,
    /// Seconds since `started_at`, measured by the server. The client ticks
    /// locally from this instead of trusting its own clock against `started_at`,
    /// so a device an hour out of sync still shows the right remaining time.
    elapsed_secs: i64,
}

#[derive(Serialize)]
pub struct GardenState {
    /// The caller's chosen character, or `null` when they have never picked —
    /// which is what the first-visit picker keys off.
    avatar: Option<String>,
    /// The server's roster, so the picker cannot offer an id it would reject.
    avatars: Vec<&'static str>,
    /// The running focus session, if a timer survived a reload.
    session: Option<FocusSession>,
    preset_minutes: Vec<i32>,
}

/// Everything the Garden route needs on entry: who you look like, and whether a
/// timer is still running from a previous visit.
pub async fn state(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<GardenState>> {
    let avatar: Option<String> =
        sqlx::query("SELECT garden_avatar FROM user_prefs WHERE user_id = $1")
            .bind(auth.id)
            .fetch_optional(&state.pool)
            .await?
            .and_then(|row| row.try_get::<Option<String>, _>("garden_avatar").ok())
            .flatten()
            .filter(|value| is_garden_avatar(value));
    Ok(Json(GardenState {
        avatar,
        avatars: GARDEN_AVATARS.to_vec(),
        session: active_session(&state, auth.id).await?,
        preset_minutes: PRESET_MINUTES.to_vec(),
    }))
}

#[derive(Deserialize)]
pub struct AvatarRequest {
    avatar: String,
}

pub async fn set_avatar(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<AvatarRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if !is_garden_avatar(&body.avatar) {
        return Err(AppError::Validation("unknown character".to_string()));
    }
    sqlx::query(
        "INSERT INTO user_prefs (user_id, garden_avatar) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET garden_avatar = $2",
    )
    .bind(auth.id)
    .bind(&body.avatar)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "avatar": body.avatar })))
}

// --- Focus sessions --------------------------------------------------------

/// The caller's running session, if any. Elapsed time comes from the database
/// clock in the same query, so it is consistent with `started_at`.
async fn active_session(state: &SharedState, user_id: Uuid) -> AppResult<Option<FocusSession>> {
    let row = sqlx::query(
        "SELECT id, mode, duration_secs, started_at,
                GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - started_at))))::bigint AS elapsed
           FROM garden_focus_sessions
          WHERE user_id = $1 AND ended_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(FocusSession {
        id: row.try_get("id")?,
        mode: row.try_get("mode")?,
        duration_secs: row.try_get("duration_secs")?,
        started_at: row.try_get("started_at")?,
        elapsed_secs: row.try_get("elapsed")?,
    }))
}

#[derive(Deserialize)]
pub struct StartSessionRequest {
    /// `countdown` or `stopwatch`.
    mode: String,
    /// Required for a countdown, refused for a stopwatch.
    duration_secs: Option<i32>,
}

/// Validate a start request into the pair the row wants.
///
/// Split out so the mode/duration agreement is testable without a database, and
/// so it states the same rule as the `garden_focus_mode_duration` constraint.
fn parse_start(mode: &str, duration_secs: Option<i32>) -> Result<(&str, Option<i32>), String> {
    match (mode, duration_secs) {
        ("countdown", Some(secs)) if secs > 0 && secs <= MAX_DURATION_SECS => {
            Ok(("countdown", Some(secs)))
        }
        ("countdown", Some(_)) => {
            Err(format!("duration_secs must be 1..={MAX_DURATION_SECS}"))
        }
        ("countdown", None) => Err("a countdown needs duration_secs".to_string()),
        ("stopwatch", None) => Ok(("stopwatch", None)),
        ("stopwatch", Some(_)) => Err("a stopwatch has no duration".to_string()),
        _ => Err("mode must be 'countdown' or 'stopwatch'".to_string()),
    }
}

/// Start a timer, replacing whatever was running.
///
/// Replacing rather than refusing: the user pressing "30 minutes" while a
/// stopwatch runs means they want 30 minutes, and the partial unique index would
/// otherwise turn that into an error the UI has nothing useful to do with. Both
/// statements share one transaction, so the index can never see two live rows.
pub async fn start_session(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<StartSessionRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let (mode, duration_secs) =
        parse_start(&body.mode, body.duration_secs).map_err(AppError::Validation)?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE garden_focus_sessions SET ended_at = now()
          WHERE user_id = $1 AND ended_at IS NULL",
    )
    .bind(auth.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO garden_focus_sessions (user_id, mode, duration_secs)
         VALUES ($1, $2, $3)",
    )
    .bind(auth.id)
    .bind(mode)
    .bind(duration_secs)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({ "session": active_session(&state, auth.id).await? })))
}

/// Stop the running timer. Idempotent: stopping nothing is a success with a null
/// session, because a countdown that finished can be reported by two tabs at
/// once and neither should see an error.
pub async fn stop_session(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let row = sqlx::query(
        "UPDATE garden_focus_sessions SET ended_at = now()
          WHERE user_id = $1 AND ended_at IS NULL
      RETURNING mode, duration_secs,
                GREATEST(0, floor(EXTRACT(EPOCH FROM (ended_at - started_at))))::bigint AS elapsed",
    )
    .bind(auth.id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Ok(Json(json!({ "stopped": null })));
    };
    Ok(Json(json!({
        "stopped": {
            "mode": row.try_get::<String, _>("mode")?,
            "duration_secs": row.try_get::<Option<i32>, _>("duration_secs")?,
            "elapsed_secs": row.try_get::<i64, _>("elapsed")?,
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::{is_garden_avatar, parse_start, MAX_DURATION_SECS};

    #[test]
    fn characters_are_allowlisted() {
        assert!(is_garden_avatar("monk"));
        assert!(!is_garden_avatar("../../etc/passwd"));
        assert!(!is_garden_avatar(""));
    }

    #[test]
    fn a_countdown_needs_a_sane_duration() {
        assert_eq!(parse_start("countdown", Some(600)), Ok(("countdown", Some(600))));
        assert!(parse_start("countdown", None).is_err());
        assert!(parse_start("countdown", Some(0)).is_err());
        assert!(parse_start("countdown", Some(-60)).is_err());
        assert!(parse_start("countdown", Some(MAX_DURATION_SECS + 1)).is_err());
    }

    #[test]
    fn a_stopwatch_has_no_duration() {
        assert_eq!(parse_start("stopwatch", None), Ok(("stopwatch", None)));
        assert!(parse_start("stopwatch", Some(600)).is_err());
    }

    #[test]
    fn unknown_modes_are_refused() {
        assert!(parse_start("pomodoro", Some(600)).is_err());
        assert!(parse_start("", None).is_err());
    }
}
