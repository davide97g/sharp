//! Route modules, plus the channel-authorization primitives every one of them shares.
//!
//! Contract: docs/arch/01-core.md — "Channel management" and the viewer gates.
//!
//! Guardrail: `channel_members.role` is the *only* source of channel authorization.
//! `channels.created_by` is historical and must never be consulted for authz. Reach for
//! the guards below (`require_member`, `require_member_role`, `require_can_post`,
//! `require_owner`) instead of re-deriving membership inside a route module — five
//! modules used to carry byte-identical copies of them, which is how error bodies drift
//! apart between surfaces.

pub mod calendar;
pub mod call_links;
pub mod channels;
pub mod docs;
pub mod e2ee;
pub mod files;
pub mod gifs;
pub mod garden;
pub mod github;
pub mod meetings;
pub mod messages;
pub mod notifications;
pub mod polls;
pub mod prefs;
pub mod push;
pub mod search;
pub mod sharpy;
pub mod social_auth;
pub mod tasks;
pub mod unfurl;
pub mod users;
pub mod voice;
pub mod voice_triggers;

use crate::error::{AppError, AppResult};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelRole {
    Owner,
    Editor,
    Viewer,
}

impl ChannelRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelRole::Owner => "owner",
            ChannelRole::Editor => "editor",
            ChannelRole::Viewer => "viewer",
        }
    }

    pub fn from_str(role: &str) -> Self {
        match role {
            "owner" => ChannelRole::Owner,
            "viewer" => ChannelRole::Viewer,
            _ => ChannelRole::Editor,
        }
    }

    pub fn can_post(self) -> bool {
        !matches!(self, ChannelRole::Viewer)
    }

    pub fn is_owner(self) -> bool {
        matches!(self, ChannelRole::Owner)
    }
}

/// Returns the channel kind if the channel exists, otherwise None.
pub async fn channel_kind(pool: &PgPool, channel_id: Uuid) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT kind FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(r) => Ok(Some(r.try_get::<String, _>("kind")?)),
        None => Ok(None),
    }
}

pub async fn is_member(pool: &PgPool, channel_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let row =
        sqlx::query("SELECT 1 AS x FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

pub async fn member_role(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<ChannelRole>> {
    let row =
        sqlx::query("SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    match row {
        Some(row) => Ok(Some(ChannelRole::from_str(
            row.try_get::<String, _>("role")?.as_str(),
        ))),
        None => Ok(None),
    }
}

pub async fn channel_member_roles(
    pool: &PgPool,
    channel_id: Uuid,
) -> AppResult<HashMap<Uuid, ChannelRole>> {
    let rows = sqlx::query("SELECT user_id, role FROM channel_members WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_all(pool)
        .await?;
    let mut roles = HashMap::with_capacity(rows.len());
    for row in rows {
        roles.insert(
            row.try_get("user_id")?,
            ChannelRole::from_str(row.try_get::<String, _>("role")?.as_str()),
        );
    }
    Ok(roles)
}

pub async fn count_owners(pool: &PgPool, channel_id: Uuid) -> AppResult<i64> {
    let row = sqlx::query(
        "SELECT count(*) AS count FROM channel_members WHERE channel_id = $1 AND role = 'owner'",
    )
    .bind(channel_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("count")?)
}

// ── Authorization guards ─────────────────────────────────────────────────────────────
//
// Each returns `Err` with the exact status + message the API already promised, so these
// are drop-in for the per-module copies they replaced. Existence is always checked before
// membership: a missing channel is 404, never 403.

/// Read gate: the channel exists and `user_id` is a member. A `viewer` passes — this is
/// the gate for reading, not for writing.
pub async fn require_member(pool: &PgPool, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
    }
    Ok(())
}

/// Read gate that also hands back the caller's role, for routes that branch on it.
/// Note the non-member response here is "not a member of this channel", whereas
/// [`require_can_post`] reports its own denial message for non-members too.
pub async fn require_member_role(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> AppResult<ChannelRole> {
    if channel_kind(pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    member_role(pool, channel_id, user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("not a member of this channel".to_string()))
}

/// Write gate: the channel exists and `user_id` may post to it (owner or editor).
///
/// `denied` is the 403 body, passed in because each surface words it differently
/// ("posting requires owner or editor role", "uploading requires…") and those strings are
/// part of the response contract — see docs/arch/01-core.md. Non-members land on `denied`
/// as well, not on "not a member of this channel"; that is the long-standing behavior of
/// every posting route and is preserved on purpose.
pub async fn require_can_post(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
    denied: &str,
) -> AppResult<()> {
    if channel_kind(pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !member_role(pool, channel_id, user_id)
        .await?
        .is_some_and(ChannelRole::can_post)
    {
        return Err(AppError::Forbidden(denied.to_string()));
    }
    Ok(())
}

/// Owner gate for channel management: rename, topic, visibility, membership, roles,
/// deletion. Every non-DM channel must retain at least one owner; DMs cannot be managed
/// at all (both members are editors).
pub async fn require_owner(pool: &PgPool, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if !member_role(pool, channel_id, user_id)
        .await?
        .is_some_and(ChannelRole::is_owner)
    {
        return Err(AppError::Forbidden("channel owner required".to_string()));
    }
    Ok(())
}

/// Workspace-level gate, as opposed to the channel-scoped `ChannelRole` above.
///
/// v1 is a single workspace with no roles table, so this is one boolean column
/// seeded to the founding account (migration `0038`). Every workspace-wide
/// mutation must go through this rather than reading `is_admin` itself, so
/// introducing a real roles model later is a one-function change and no call site
/// moves.
pub async fn is_workspace_admin(pool: &PgPool, user_id: Uuid) -> AppResult<bool> {
    let row = sqlx::query("SELECT is_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(r) => Ok(r.try_get::<bool, _>("is_admin")?),
        None => Ok(false),
    }
}

pub async fn require_workspace_admin(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
    if !is_workspace_admin(pool, user_id).await? {
        return Err(AppError::Forbidden("workspace admin required".to_string()));
    }
    Ok(())
}

// --- Browser-redirect helpers (OAuth callbacks) -------------------------------
//
// An OAuth callback lands in a browser tab, not in `fetch`, so it can't answer with
// the usual JSON error envelope. `calendar` (Google Calendar connect) and
// `social_auth` (social sign-in) both need the same two shapes, and both are
// reached by URLs an attacker can craft, so the escaping below is load-bearing.

/// Escape text destined for an HTML text node. Callback messages quote provider
/// error strings straight out of the query string — never interpolate those raw.
fn escape_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// A self-contained status page for a callback that has no SPA behind it.
pub fn callback_page(heading: &str, message: &str) -> Html<String> {
    let heading = escape_html(heading);
    let message = escape_html(message);
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"/>\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\
<title>sharp</title>\
<style>body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#0f1115;color:#e6e8eb;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;}}\
.card{{max-width:380px;text-align:center;}}h1{{font-size:20px;margin:0 0 8px;}}\
p{{color:#9aa3af;margin:0;}}</style></head>\
<body><div class=\"card\"><h1>{heading}</h1><p>{message}</p></div></body></html>"
    ))
}

pub fn redirect_302(location: &str) -> Response {
    (
        StatusCode::FOUND,
        [(header::LOCATION, location.to_string())],
    )
        .into_response()
}
