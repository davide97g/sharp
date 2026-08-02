//! User preferences: notification types, per-channel modes, Do-Not-Disturb, appearance.
//!
//! Contract: docs/arch/05-files-notifications.md ("Appearance", "Notification semantics").
//!
//! These handlers used to live in `routes/notifications.rs`, which meant `PATCH /prefs/ui`
//! — the appearance blob — was in a module named after the inbox. The URLs are unchanged.
//!
//! Two storage shapes on purpose:
//!   - **Real columns** in `user_prefs` for anything the *server* must honour: the
//!     `notify_*` type switches, DND and its schedule, and the privacy flags in
//!     `crate::privacy`. A preference only the client respects protects nobody.
//!   - **The opaque `user_prefs.ui` JSON blob** for pure client presentation (theme,
//!     density, motion, chat style). The server stores and echoes it without
//!     interpretation, so adding a UI preference needs no migration — only a size cap.
//!
//! Every write here broadcasts `prefs.updated` to the user's own connections so their
//! other devices follow along.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::routes::channel_kind;
use crate::state::SharedState;
use crate::ws::envelope;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

pub async fn get_prefs(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let prefs_row = sqlx::query(
        "SELECT dnd, chat_layout, notify_dm, notify_mention, notify_reply,
                notify_poll, dnd_scheduled, dnd_start, dnd_end, tz_offset, ui,
                invisible, share_typing, push_preview
         FROM user_prefs WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_optional(&state.pool)
    .await?;
    // Absent row = defaults (matching the column defaults in migration 0004/0026).
    let flag = |name: &str, default: bool| -> bool {
        prefs_row
            .as_ref()
            .and_then(|r| r.try_get::<bool, _>(name).ok())
            .unwrap_or(default)
    };
    let chat_layout: Option<String> = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("chat_layout").ok())
        .flatten();
    let dnd_start: Option<i32> = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<Option<i32>, _>("dnd_start").ok())
        .flatten();
    let dnd_end: Option<i32> = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<Option<i32>, _>("dnd_end").ok())
        .flatten();
    let tz_offset: i32 = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<i32, _>("tz_offset").ok())
        .unwrap_or(0);
    // Opaque client-owned appearance blob; absent row = `{}` and the client
    // falls back to its own defaults (web/src/lib/uiPrefs.ts).
    let ui: serde_json::Value = prefs_row
        .as_ref()
        .and_then(|r| r.try_get::<serde_json::Value, _>("ui").ok())
        .unwrap_or_else(|| json!({}));

    // Per-channel modes; also derive the legacy muted-id list for older clients.
    let rows =
        sqlx::query("SELECT channel_id, mode, wallpaper FROM channel_prefs WHERE user_id = $1")
            .bind(auth.id)
            .fetch_all(&state.pool)
            .await?;
    let mut channel_modes = serde_json::Map::new();
    let mut wallpapers = serde_json::Map::new();
    let mut muted: Vec<String> = Vec::new();
    for row in &rows {
        let id = row.try_get::<Uuid, _>("channel_id")?.to_string();
        let mode: String = row.try_get("mode")?;
        if mode == "muted" {
            muted.push(id.clone());
        }
        if let Ok(Some(paper)) = row.try_get::<Option<serde_json::Value>, _>("wallpaper") {
            wallpapers.insert(id.clone(), paper);
        }
        channel_modes.insert(id, json!(mode));
    }

    Ok(Json(json!({
        "dnd": flag("dnd", false),
        "muted_channel_ids": muted,
        "channel_modes": channel_modes,
        "channel_wallpapers": wallpapers,
        "chat_layout": chat_layout,
        "notify_dm": flag("notify_dm", true),
        "notify_mention": flag("notify_mention", true),
        "notify_reply": flag("notify_reply", true),
        "notify_poll": flag("notify_poll", true),
        "dnd_scheduled": flag("dnd_scheduled", false),
        "dnd_start": dnd_start,
        "dnd_end": dnd_end,
        "tz_offset": tz_offset,
        "ui": ui,
        "invisible": flag("invisible", false),
        "share_typing": flag("share_typing", true),
        "push_preview": prefs_row
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("push_preview").ok())
            .unwrap_or_else(|| "full".to_string()),
    })))
}

#[derive(Deserialize)]
pub struct DndRequest {
    pub dnd: bool,
}

/// Bulk update of granular notification preferences. Every field is optional;
/// omitted fields keep their current value (COALESCE), and the row is created
/// with column defaults if it does not yet exist.
#[derive(Deserialize)]
pub struct PrefsUpdate {
    pub notify_dm: Option<bool>,
    pub notify_mention: Option<bool>,
    pub notify_reply: Option<bool>,
    pub notify_poll: Option<bool>,
    pub dnd_scheduled: Option<bool>,
    pub dnd_start: Option<i32>,
    pub dnd_end: Option<i32>,
    pub tz_offset: Option<i32>,
    // Server-enforced privacy switches (migration 0031).
    pub invisible: Option<bool>,
    pub share_typing: Option<bool>,
    pub push_preview: Option<String>,
}

fn valid_minute(value: Option<i32>) -> AppResult<()> {
    if let Some(m) = value {
        if !(0..1440).contains(&m) {
            return Err(AppError::Validation(
                "dnd_start/dnd_end must be minutes-of-day in [0, 1440)".to_string(),
            ));
        }
    }
    Ok(())
}

pub async fn set_prefs(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<PrefsUpdate>,
) -> AppResult<StatusCode> {
    valid_minute(body.dnd_start)?;
    valid_minute(body.dnd_end)?;
    if let Some(ref preview) = body.push_preview {
        if preview != "full" && preview != "generic" {
            return Err(AppError::Validation(
                "push_preview must be 'full' or 'generic'".to_string(),
            ));
        }
    }
    sqlx::query(
        "INSERT INTO user_prefs
            (user_id, notify_dm, notify_mention, notify_reply, notify_poll,
             dnd_scheduled, dnd_start, dnd_end, tz_offset,
             invisible, share_typing, push_preview)
         VALUES ($1,
             COALESCE($2, true), COALESCE($3, true), COALESCE($4, true),
             COALESCE($5, true), COALESCE($6, false),
             $7, $8, COALESCE($9, 0),
             COALESCE($10, false), COALESCE($11, true), COALESCE($12, 'full'))
         ON CONFLICT (user_id) DO UPDATE SET
             notify_dm      = COALESCE($2, user_prefs.notify_dm),
             notify_mention = COALESCE($3, user_prefs.notify_mention),
             notify_reply   = COALESCE($4, user_prefs.notify_reply),
             notify_poll    = COALESCE($5, user_prefs.notify_poll),
             dnd_scheduled  = COALESCE($6, user_prefs.dnd_scheduled),
             dnd_start      = COALESCE($7, user_prefs.dnd_start),
             dnd_end        = COALESCE($8, user_prefs.dnd_end),
             tz_offset      = COALESCE($9, user_prefs.tz_offset),
             invisible      = COALESCE($10, user_prefs.invisible),
             share_typing   = COALESCE($11, user_prefs.share_typing),
             push_preview   = COALESCE($12, user_prefs.push_preview)",
    )
    .bind(auth.id)
    .bind(body.notify_dm)
    .bind(body.notify_mention)
    .bind(body.notify_reply)
    .bind(body.notify_poll)
    .bind(body.dnd_scheduled)
    .bind(body.dnd_start)
    .bind(body.dnd_end)
    .bind(body.tz_offset)
    .bind(body.invisible)
    .bind(body.share_typing)
    .bind(body.push_preview.as_deref())
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Upper bound on the stored appearance blob. It is client-owned and never
/// interpreted by the server, so it needs a hard ceiling.
const UI_PREFS_MAX_BYTES: usize = 8 * 1024;

/// Shallow-merge a patch into `user_prefs.ui` and fan the result out to the
/// caller's other sessions.
///
/// The merge is **top-level only** (`jsonb ||`): a nested object in the patch
/// replaces the stored one wholesale, so clients always send a complete
/// sub-object rather than a partial one.
pub async fn patch_ui_prefs(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    if !body.is_object() {
        return Err(AppError::Validation(
            "ui prefs patch must be a JSON object".to_string(),
        ));
    }
    if serde_json::to_string(&body)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
        > UI_PREFS_MAX_BYTES
    {
        return Err(AppError::Validation(format!(
            "ui prefs patch exceeds {UI_PREFS_MAX_BYTES} bytes"
        )));
    }

    let row = sqlx::query(
        "INSERT INTO user_prefs (user_id, ui) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET ui = user_prefs.ui || $2::jsonb
         RETURNING ui",
    )
    .bind(auth.id)
    .bind(&body)
    .fetch_one(&state.pool)
    .await?;
    let ui: serde_json::Value = row.try_get("ui")?;

    // Live cross-device sync: the same user's other tabs/devices apply the
    // merged blob as-is (idempotent, so the originating tab can re-apply too).
    let ev = envelope("prefs.updated", json!({ "ui": ui }));
    state.hub.broadcast(ev, vec![auth.id]).await;

    Ok(Json(ui))
}

#[derive(Deserialize)]
pub struct ChatLayoutRequest {
    pub chat_layout: String,
}

pub async fn set_chat_layout(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ChatLayoutRequest>,
) -> AppResult<StatusCode> {
    if body.chat_layout != "bubble" && body.chat_layout != "classic" {
        return Err(AppError::Validation(
            "chat_layout must be 'bubble' or 'classic'".to_string(),
        ));
    }
    sqlx::query(
        "INSERT INTO user_prefs (user_id, chat_layout) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET chat_layout = EXCLUDED.chat_layout",
    )
    .bind(auth.id)
    .bind(&body.chat_layout)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_dnd(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<DndRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        "INSERT INTO user_prefs (user_id, dnd) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET dnd = EXCLUDED.dnd",
    )
    .bind(auth.id)
    .bind(body.dnd)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Either a `mode` (all/mentions/muted) or the legacy `muted` boolean. `mode`
/// wins when both are present; `muted` maps to `muted`/`all`.
#[derive(Deserialize)]
pub struct MuteRequest {
    pub muted: Option<bool>,
    pub mode: Option<String>,
    /// Chat wallpaper descriptor, opaque to the server (shape owned by
    /// web/src/lib/wallpaper.ts). `null` clears it; omitted leaves it alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallpaper: Option<Option<serde_json::Value>>,
}

/// Same reasoning as the ui blob: client-owned JSON needs a hard size ceiling.
const WALLPAPER_MAX_BYTES: usize = 2 * 1024;

pub async fn set_channel_pref(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<MuteRequest>,
) -> AppResult<StatusCode> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    let mode = match body.mode.clone() {
        Some(m) => {
            if !matches!(m.as_str(), "all" | "mentions" | "muted") {
                return Err(AppError::Validation(
                    "mode must be 'all', 'mentions', or 'muted'".to_string(),
                ));
            }
            m
        }
        None => match body.muted {
            Some(true) => "muted".to_string(),
            _ => "all".to_string(),
        },
    };
    let muted = mode == "muted";
    // The wallpaper is a separate concern from the notification mode, and a
    // caller setting one must not reset the other: only touch the column when
    // the field is present in the body.
    if let Some(wallpaper) = body.wallpaper {
        if let Some(ref value) = wallpaper {
            if !value.is_object() {
                return Err(AppError::Validation(
                    "wallpaper must be a JSON object or null".to_string(),
                ));
            }
            if serde_json::to_string(value).map(|s| s.len()).unwrap_or(usize::MAX)
                > WALLPAPER_MAX_BYTES
            {
                return Err(AppError::Validation(format!(
                    "wallpaper exceeds {WALLPAPER_MAX_BYTES} bytes"
                )));
            }
        }
        sqlx::query(
            "INSERT INTO channel_prefs (user_id, channel_id, wallpaper) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, channel_id)
             DO UPDATE SET wallpaper = EXCLUDED.wallpaper",
        )
        .bind(auth.id)
        .bind(channel_id)
        .bind(&wallpaper)
        .execute(&state.pool)
        .await?;
        // A wallpaper-only request carries no mode; do not clobber it.
        if body.mode.is_none() && body.muted.is_none() {
            return Ok(StatusCode::NO_CONTENT);
        }
    }
    sqlx::query(
        "INSERT INTO channel_prefs (user_id, channel_id, muted, mode) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, channel_id)
         DO UPDATE SET muted = EXCLUDED.muted, mode = EXCLUDED.mode",
    )
    .bind(auth.id)
    .bind(channel_id)
    .bind(muted)
    .bind(&mode)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- web push ----
