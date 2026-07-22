//! Notification dispatch: turns a freshly-created message into inbox rows +
//! realtime `notification.created` events + web-push to offline recipients.
//!
//! Triggers (per the product contract):
//!   - `dm`      — any message in a DM channel notifies the other member(s)
//!   - `mention` — `@Display Name` (or the author's personal nickname for that
//!     member) matching a channel member notifies them; `@all` notifies every
//!     other channel member
//!   - `reply`   — a thread reply notifies the parent message's author
//!
//! Muted channels produce no notification at all. Do-Not-Disturb keeps the inbox
//! row + realtime event (so the bell updates) but suppresses web push; the client
//! additionally suppresses toasts/desktop popups while DND is on.

use crate::error::AppResult;
use crate::expo_push;
use crate::models::{MessageUser, Notification};
use crate::state::SharedState;
use crate::ws::envelope;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

const NOTIFICATION_SELECT: &str = "
    SELECT n.id, n.kind, n.actor_id,
        COALESCE(nn.nickname, a.display_name) AS actor_name,
        a.avatar_url AS actor_avatar,
        n.channel_id, c.kind AS channel_kind, c.name AS channel_name,
        n.message_id, n.preview, n.created_at, n.read_at,
        n.task_id, (tp.key || '-' || t.number) AS task_identifier
    FROM notifications n
    JOIN users a ON a.id = n.actor_id
    LEFT JOIN user_nicknames nn
        ON nn.viewer_id = n.user_id AND nn.target_user_id = n.actor_id
    LEFT JOIN channels c ON c.id = n.channel_id
    LEFT JOIN tasks t ON t.id = n.task_id
    LEFT JOIN projects tp ON tp.id = t.project_id
";

pub fn map_notification_row(row: &PgRow) -> AppResult<Notification> {
    Ok(Notification {
        id: row.try_get("id")?,
        kind: row.try_get("kind")?,
        actor: MessageUser {
            id: row.try_get("actor_id")?,
            display_name: row.try_get("actor_name")?,
            avatar_url: row.try_get("actor_avatar")?,
        },
        channel_id: row.try_get("channel_id")?,
        channel_kind: row.try_get("channel_kind")?,
        channel_name: row.try_get("channel_name")?,
        message_id: row.try_get("message_id")?,
        task_id: row.try_get("task_id")?,
        task_identifier: row.try_get("task_identifier")?,
        preview: row.try_get("preview")?,
        created_at: row.try_get("created_at")?,
        read_at: row.try_get("read_at")?,
    })
}

/// Deep-link path for a notification: task page for task kinds, channel otherwise.
pub fn notification_path(notif: &Notification) -> String {
    if let Some(identifier) = &notif.task_identifier {
        if let Some((key, number)) = identifier.rsplit_once('-') {
            return format!("/t/{}/{}", key.to_lowercase(), number);
        }
    }
    match notif.channel_id {
        Some(channel_id) => format!("/c/{channel_id}"),
        None => "/".to_string(),
    }
}

pub async fn load_notification(pool: &PgPool, id: i64) -> AppResult<Notification> {
    let sql = format!("{} WHERE n.id = $1", NOTIFICATION_SELECT);
    let row = sqlx::query(&sql).bind(id).fetch_one(pool).await?;
    map_notification_row(&row)
}

/// Newest-first page of a user's notifications (`before` = exclusive id cursor).
pub async fn list_for_user(
    pool: &PgPool,
    user_id: Uuid,
    before: Option<i64>,
    limit: i64,
) -> AppResult<Vec<Notification>> {
    let sql = format!(
        "{} WHERE n.user_id = $1 AND ($2::bigint IS NULL OR n.id < $2) \
         ORDER BY n.id DESC LIMIT $3",
        NOTIFICATION_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(map_notification_row(row)?);
    }
    Ok(out)
}

pub async fn unread_count(pool: &PgPool, user_id: Uuid) -> AppResult<i64> {
    let row = sqlx::query(
        "SELECT count(*) AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("c")?)
}

/// Truncate to at most `max` chars, appending an ellipsis when cut.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Replace resource chips with a readable icon + title so notification previews
/// don't leak raw tokens: `[[doc:<uuid>|Title]]` → "📄 Title",
/// `[[canvas:<uuid>|Title]]` → "🎨 Title", `[[board:<uuid>|Title]]` → "🗂️ Title",
/// and the scheduled-meeting card
/// `[[meet:<uuid>|Title|<start_iso>]]` → "📅 Title" and
/// `[[poll:<uuid>|Question]]` → "📊 Question".
fn strip_resource_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let icon = if after.starts_with("canvas:") {
            Some("🎨")
        } else if after.starts_with("board:") {
            Some("🗂️")
        } else if after.starts_with("doc:") {
            Some("📄")
        } else if after.starts_with("meet:") {
            Some("📅")
        } else if after.starts_with("poll:") {
            Some("📊")
        } else {
            None
        };
        match (icon, after.find("]]")) {
            (Some(icon), Some(end)) => {
                let inner = &after[..end];
                // Fields are `<id>|<title>[|…]`; the title is the second field.
                let mut fields = inner.split('|');
                let _id = fields.next();
                let title = fields.next().unwrap_or(inner);
                out.push_str(icon);
                out.push(' ');
                out.push_str(title);
                rest = &after[end + 2..];
            }
            _ => {
                // Not a resource token: emit the literal "[[" and continue past it.
                out.push_str("[[");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Replace GIF message tokens with readable text for non-chat preview surfaces.
/// A message containing one GIF token and only whitespace reads naturally after
/// the actor name; GIFs embedded in other text become compact inline markers.
pub(crate) fn preview_text(content: &str) -> String {
    let trimmed = content.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut rest = trimmed;
    let mut replacements = 0;

    while let Some(start) = rest.find("[[gif:") {
        out.push_str(&rest[..start]);
        let token_body = &rest[start + "[[gif:".len()..];
        let Some(end) = token_body.find("]]") else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        out.push_str("[GIF]");
        replacements += 1;
        rest = &token_body[end + 2..];
    }
    out.push_str(rest);

    if replacements == 1 && out == "[GIF]" {
        "sent a GIF".to_string()
    } else {
        out
    }
}

/// Build a one-line inbox preview from a message (falls back to its attachment).
fn build_preview(content: &str, first_attachment: Option<&str>) -> String {
    let gif_preview = preview_text(content);
    let text = strip_resource_tokens(&gif_preview);
    let text = text.trim();
    if !text.is_empty() {
        truncate_chars(&text.replace('\n', " "), 140)
    } else if let Some(name) = first_attachment {
        format!("📎 {name}")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{contains_all_mention, preview_text, strip_resource_tokens};

    #[test]
    fn humanizes_standalone_gif_token() {
        assert_eq!(
            preview_text(" \n[[gif:https://media.example/cat.gif|Cat wave]]\t"),
            "sent a GIF"
        );
    }

    #[test]
    fn humanizes_gif_tokens_inside_text() {
        assert_eq!(
            preview_text(
                "Look [[gif:https://media.example/one.gif|One]] and [[gif:https://media.example/two.gif|Two]]"
            ),
            "Look [GIF] and [GIF]"
        );
    }

    #[test]
    fn detects_all_mention_at_boundaries() {
        assert!(contains_all_mention("@all"));
        assert!(contains_all_mention("hey @all, standup time"));
        assert!(contains_all_mention("(@ALL)"));
        assert!(contains_all_mention("@all!"));
    }

    #[test]
    fn rejects_non_broadcast_at_tokens() {
        assert!(!contains_all_mention("no mention here"));
        assert!(!contains_all_mention("@allison hi")); // longer word
        assert!(!contains_all_mention("mail@all.com is fine")); // '@' after alnum
        assert!(!contains_all_mention("ball@all")); // ditto
        assert!(!contains_all_mention("@al"));
    }

    #[test]
    fn humanizes_standalone_duck_roast_gif_token() {
        assert_eq!(
            preview_text("[[gif:https://media.example/roast.gif|Gotcha|duck]]"),
            "sent a GIF"
        );
        assert_eq!(
            preview_text("[[gif:https://media.example/roast.gif|Gotcha|duck|gemini ai sucks]]"),
            "sent a GIF"
        );
    }

    #[test]
    fn humanizes_poll_token() {
        assert_eq!(
            strip_resource_tokens("[[poll:00000000-0000-0000-0000-000000000000|Lunch?]]"),
            "📊 Lunch?"
        );
    }
}

/// Does `content` contain an `@all` broadcast mention? Same boundary rules as
/// name mentions: the `@` must not follow an alphanumeric (emails), and `all`
/// must end at a non-alphanumeric boundary (so "@allison" doesn't match).
fn contains_all_mention(content: &str) -> bool {
    let lower = content.to_lowercase();
    for (i, ch) in lower.char_indices() {
        if ch != '@' {
            continue;
        }
        if i > 0 {
            if let Some(prev) = lower[..i].chars().last() {
                if prev.is_alphanumeric() {
                    continue;
                }
            }
        }
        let after = &lower[i + 1..];
        if let Some(rest) = after.strip_prefix("all") {
            let boundary = rest
                .chars()
                .next()
                .map(|c| !c.is_alphanumeric())
                .unwrap_or(true);
            if boundary {
                return true;
            }
        }
    }
    false
}

/// Channel members mentioned by `@Display Name` (or the author's personal
/// nickname for that member) in `content`, excluding `author`.
/// Longest name wins so "@Ann Marie" beats "@Ann".
async fn mentioned_ids(
    pool: &PgPool,
    channel_id: Uuid,
    content: &str,
    author: Uuid,
) -> AppResult<Vec<Uuid>> {
    if !content.contains('@') {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT cm.user_id, u.display_name, nn.nickname
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN user_nicknames nn
           ON nn.viewer_id = $2 AND nn.target_user_id = cm.user_id
         WHERE cm.channel_id = $1 AND cm.user_id <> $2",
    )
    .bind(channel_id)
    .bind(author)
    .fetch_all(pool)
    .await?;

    // One entry per alias (canonical display_name + author's nickname).
    let mut members: Vec<(Uuid, String)> = Vec::with_capacity(rows.len() * 2);
    for row in &rows {
        let id: Uuid = row.try_get("user_id")?;
        let name: String = row.try_get("display_name")?;
        if !name.trim().is_empty() {
            members.push((id, name.to_lowercase()));
        }
        let nickname: Option<String> = row.try_get("nickname")?;
        if let Some(nick) = nickname {
            let nick = nick.trim();
            if !nick.is_empty() {
                let lower = nick.to_lowercase();
                if !members.iter().any(|(uid, n)| *uid == id && *n == lower) {
                    members.push((id, lower));
                }
            }
        }
    }
    // Longest first for greedy longest-match.
    members.sort_by_key(|(_, n)| std::cmp::Reverse(n.chars().count()));

    let lower = content.to_lowercase();
    let mut found: HashSet<Uuid> = HashSet::new();
    for (i, ch) in lower.char_indices() {
        if ch != '@' {
            continue;
        }
        // Skip when '@' follows an alphanumeric (e.g. inside an email address).
        if i > 0 {
            if let Some(prev) = lower[..i].chars().last() {
                if prev.is_alphanumeric() {
                    continue;
                }
            }
        }
        let after = &lower[i + 1..];
        // Members are sorted longest-name-first, so the first match at this '@'
        // is the greedy longest match; `found` is a set so re-inserts are no-ops.
        for (uid, name) in &members {
            if after.starts_with(name.as_str()) {
                let rest = &after[name.len()..];
                let boundary = rest
                    .chars()
                    .next()
                    .map(|c| !c.is_alphanumeric())
                    .unwrap_or(true);
                if boundary {
                    found.insert(*uid);
                    break;
                }
            }
        }
    }
    Ok(found.into_iter().collect())
}

async fn other_member_ids(pool: &PgPool, channel_id: Uuid, exclude: Uuid) -> AppResult<Vec<Uuid>> {
    let rows =
        sqlx::query("SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id <> $2")
            .bind(channel_id)
            .bind(exclude)
            .fetch_all(pool)
            .await?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in &rows {
        ids.push(row.try_get::<Uuid, _>("user_id")?);
    }
    Ok(ids)
}

async fn parent_author(pool: &PgPool, message_id: i64) -> AppResult<Option<Uuid>> {
    let row = sqlx::query("SELECT user_id FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(r) => Some(r.try_get("user_id")?),
        None => None,
    })
}

/// Whether a channel's per-user notification `mode` lets `kind` through.
/// Absent row = `all`. `muted` blocks everything; `mentions` blocks all but
/// mention/reply. This subsumes the legacy per-channel mute.
async fn channel_allows(pool: &PgPool, user_id: Uuid, channel_id: Uuid, kind: &str) -> bool {
    let mode: String = sqlx::query("SELECT mode FROM channel_prefs WHERE user_id = $1 AND channel_id = $2")
        .bind(user_id)
        .bind(channel_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("mode").ok())
        .unwrap_or_else(|| "all".to_string());
    match mode.as_str() {
        "muted" => false,
        "mentions" => kind == "mention" || kind == "reply",
        _ => true,
    }
}

/// Whether the user has this notification *type* enabled at all. A disabled type
/// produces no notification whatsoever (no inbox row, no push). Absent row =
/// every type enabled (the column defaults).
async fn kind_enabled(pool: &PgPool, user_id: Uuid, kind: &str) -> bool {
    let column = match kind {
        "dm" => "notify_dm",
        "mention" => "notify_mention",
        "reply" => "notify_reply",
        "task_assigned" | "task_comment" => "notify_task",
        "poll_ended" => "notify_poll",
        _ => return true,
    };
    let sql = format!("SELECT {column} AS enabled FROM user_prefs WHERE user_id = $1");
    sqlx::query(&sql)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<bool, _>("enabled").ok())
        .unwrap_or(true)
}

/// Minutes-of-day `cur` inside a quiet-hours window `[start, end)`, wrap-aware
/// (a window like 22:00→08:00 spans midnight). Equal bounds = empty window.
fn within_window(start: i32, end: i32, cur: i32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        cur >= start && cur < end
    } else {
        cur >= start || cur < end
    }
}

/// Do-Not-Disturb: the manual toggle, or an active scheduled quiet-hours window.
/// Quiet hours are evaluated against the user's local clock via the stored
/// `tz_offset` (minutes east of UTC).
async fn is_dnd(pool: &PgPool, user_id: Uuid) -> bool {
    let Some(row) = sqlx::query(
        "SELECT dnd, dnd_scheduled, dnd_start, dnd_end, tz_offset
         FROM user_prefs WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten() else {
        return false;
    };
    if row.try_get::<bool, _>("dnd").unwrap_or(false) {
        return true;
    }
    if !row.try_get::<bool, _>("dnd_scheduled").unwrap_or(false) {
        return false;
    }
    let (Ok(Some(start)), Ok(Some(end))) = (
        row.try_get::<Option<i32>, _>("dnd_start"),
        row.try_get::<Option<i32>, _>("dnd_end"),
    ) else {
        return false;
    };
    let offset = row.try_get::<i32, _>("tz_offset").unwrap_or(0);
    let local_min = ((chrono::Utc::now().timestamp() / 60 + offset as i64) % 1440 + 1440) % 1440;
    within_window(start, end, local_min as i32)
}

/// Best-effort push for a non-message event (e.g. a doc/canvas mention).
/// Web push is suppressed only by a visible web session. Expo keeps its
/// existing offline-only behavior and is otherwise outside the PWA lifecycle.
pub async fn push_event(
    state: &SharedState,
    user_id: Uuid,
    title: &str,
    body: &str,
    tag: &str,
    path: &str,
    channel_id: Option<Uuid>,
    kind: &str,
) {
    if is_dnd(&state.pool, user_id).await {
        return;
    }
    let web_allowed = !state.hub.has_visible_session(user_id).await;
    let expo_allowed = !state.hub.is_online(user_id);
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "tag": tag,
        "path": path,
        "timestamp": chrono::Utc::now().timestamp_millis(),
    })
    .to_string();
    // Events without a channel context (Google reminders, standalone calls) carry
    // a nil uuid to the native payload; the deep-link `path` is the real target.
    let expo_channel = channel_id.unwrap_or_else(Uuid::nil);
    let web = async {
        if web_allowed {
            push::send_payload(state, user_id, &payload).await;
        }
    };
    let expo = async {
        if expo_allowed {
            expo_push::send_to_user(state, user_id, title, body, expo_channel, kind).await;
        }
    };
    let apns = async {
        if web_allowed {
            crate::apns::send_to_user(state, user_id, title, body, path, tag).await;
        }
    };
    tokio::join!(web, expo, apns);
}

/// Public entry point: best-effort, never fails message creation.
pub async fn dispatch_message(
    state: &SharedState,
    message_id: i64,
    channel_id: Uuid,
    channel_kind: &str,
    parent_id: Option<i64>,
    author: Uuid,
    content: &str,
    first_attachment: Option<&str>,
    encrypted: bool,
) {
    if let Err(e) = dispatch_inner(
        state,
        message_id,
        channel_id,
        channel_kind,
        parent_id,
        author,
        content,
        first_attachment,
        encrypted,
    )
    .await
    {
        tracing::warn!("notification dispatch failed: {}", e);
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_inner(
    state: &SharedState,
    message_id: i64,
    channel_id: Uuid,
    channel_kind: &str,
    parent_id: Option<i64>,
    author: Uuid,
    content: &str,
    first_attachment: Option<&str>,
    encrypted: bool,
) -> AppResult<()> {
    let pool = &state.pool;

    // (recipient, kind) with dedup; mention > reply within a normal channel.
    let mut targets: Vec<(Uuid, &'static str)> = Vec::new();
    let mut seen: HashSet<Uuid> = HashSet::new();

    if encrypted || channel_kind == "dm" {
        for uid in other_member_ids(pool, channel_id, author).await? {
            if seen.insert(uid) {
                targets.push((uid, "dm"));
            }
        }
    } else {
        // `@all` broadcasts a mention to every other channel member (Slack's
        // @channel); individual name mentions below then dedup via `seen`.
        if contains_all_mention(content) {
            for uid in other_member_ids(pool, channel_id, author).await? {
                if seen.insert(uid) {
                    targets.push((uid, "mention"));
                }
            }
        }
        for uid in mentioned_ids(pool, channel_id, content, author).await? {
            if seen.insert(uid) {
                targets.push((uid, "mention"));
            }
        }
        if let Some(pid) = parent_id {
            if let Some(pa) = parent_author(pool, pid).await? {
                if pa != author && seen.insert(pa) {
                    targets.push((pa, "reply"));
                }
            }
        }
    }

    if targets.is_empty() {
        return Ok(());
    }

    let preview = if encrypted {
        "🔒 Encrypted message".to_string()
    } else {
        build_preview(content, first_attachment)
    };

    for (uid, kind) in targets {
        if !channel_allows(pool, uid, channel_id, kind).await || !kind_enabled(pool, uid, kind).await
        {
            continue;
        }
        let row = sqlx::query(
            "INSERT INTO notifications (user_id, kind, actor_id, channel_id, message_id, preview)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(uid)
        .bind(kind)
        .bind(author)
        .bind(channel_id)
        .bind(message_id)
        .bind(&preview)
        .fetch_one(pool)
        .await?;
        let new_id: i64 = row.try_get("id")?;
        let notif = load_notification(pool, new_id).await?;

        let ev = envelope("notification.created", json!({ "notification": &notif }));
        state.hub.broadcast(ev, vec![uid]).await;

        // Background/closed web sessions receive VAPID push even if their
        // WebSocket remains connected. A visible session gets realtime UI only.
        if !is_dnd(pool, uid).await {
            let web_allowed = !state.hub.has_visible_session(uid).await;
            let expo_allowed = !state.hub.is_online(uid);
            let (title, body) = push::title_and_body(&notif);
            let web = async {
                if web_allowed {
                    push::send_to_user(state, uid, &notif).await;
                }
            };
            let expo = async {
                if expo_allowed {
                    expo_push::send_to_user(
                        state,
                        uid,
                        &title,
                        &body,
                        notif.channel_id.unwrap_or_else(Uuid::nil),
                        &notif.kind,
                    )
                    .await;
                }
            };
            // Native macOS (Tauri) push shares the web-push visibility gate: a
            // closed/backgrounded desktop app has no visible session.
            let apns = async {
                if web_allowed {
                    crate::apns::send_to_user(
                        state,
                        uid,
                        &title,
                        &body,
                        &notification_path(&notif),
                        &push::tag_for(&notif),
                    )
                    .await;
                }
            };
            tokio::join!(web, expo, apns);
        }
    }

    Ok(())
}

/// Best-effort poll completion notification dispatch. Atomic poll finalization
/// owns deduplication; this function owns recipient/inbox/push delivery.
pub async fn dispatch_poll_ended(state: &SharedState, poll: &crate::routes::polls::Poll) {
    if let Err(error) = dispatch_poll_ended_inner(state, poll).await {
        tracing::warn!("poll-ended notification dispatch failed: {}", error);
    }
}

async fn dispatch_poll_ended_inner(
    state: &SharedState,
    poll: &crate::routes::polls::Poll,
) -> AppResult<()> {
    let mut recipients: HashSet<Uuid> = HashSet::from([poll.creator_id]);
    let voter_rows = sqlx::query("SELECT DISTINCT user_id FROM poll_votes WHERE poll_id = $1")
        .bind(poll.id)
        .fetch_all(&state.pool)
        .await?;
    for row in voter_rows {
        recipients.insert(row.try_get("user_id")?);
    }

    let winning_count = poll
        .options
        .iter()
        .map(|option| option.count)
        .max()
        .unwrap_or(0);
    let winner = poll
        .options
        .iter()
        .find(|option| option.count == winning_count);
    let preview = match winner.filter(|option| option.count > 0) {
        Some(option) => format!("📊 {} — {} ({})", poll.question, option.text, option.count),
        None => format!("📊 {} — no votes", poll.question),
    };

    for uid in recipients {
        if !channel_allows(&state.pool, uid, poll.channel_id, "poll_ended").await
            || !kind_enabled(&state.pool, uid, "poll_ended").await
        {
            continue;
        }
        let row = sqlx::query(
            "INSERT INTO notifications (user_id, kind, actor_id, channel_id, message_id, preview)
             VALUES ($1, 'poll_ended', $2, $3, $4, $5) RETURNING id",
        )
        .bind(uid)
        .bind(poll.creator_id)
        .bind(poll.channel_id)
        .bind(poll.card_message_id)
        .bind(&preview)
        .fetch_one(&state.pool)
        .await?;
        let notification = load_notification(&state.pool, row.try_get("id")?).await?;
        state
            .hub
            .broadcast(
                envelope(
                    "notification.created",
                    json!({ "notification": &notification }),
                ),
                vec![uid],
            )
            .await;

        if !is_dnd(&state.pool, uid).await {
            let web_allowed = !state.hub.has_visible_session(uid).await;
            let expo_allowed = !state.hub.is_online(uid);
            let (title, body) = push::title_and_body(&notification);
            let web = async {
                if web_allowed {
                    push::send_to_user(state, uid, &notification).await;
                }
            };
            let expo = async {
                if expo_allowed {
                    expo_push::send_to_user(
                        state,
                        uid,
                        &title,
                        &body,
                        notification.channel_id.unwrap_or_else(Uuid::nil),
                        &notification.kind,
                    )
                    .await;
                }
            };
            let apns = async {
                if web_allowed {
                    crate::apns::send_to_user(
                        state,
                        uid,
                        &title,
                        &body,
                        &notification_path(&notification),
                        &push::tag_for(&notification),
                    )
                    .await;
                }
            };
            tokio::join!(web, expo, apns);
        }
    }
    Ok(())
}

/// Best-effort task-assignment notification (skips self-assign upstream).
pub async fn dispatch_task_assigned(
    state: &SharedState,
    task: &crate::models::Task,
    actor_id: Uuid,
) {
    let Some(assignee) = task.assignee_id else { return };
    if assignee == actor_id {
        return;
    }
    let preview = format!("🎯 {} {}", task.identifier, task.title);
    if let Err(error) =
        dispatch_task_event(state, assignee, actor_id, task.id, "task_assigned", &preview).await
    {
        tracing::warn!("task-assigned notification dispatch failed: {}", error);
    }
}

/// Best-effort task-comment notification to the task's creator + assignee.
pub async fn dispatch_task_comment(
    state: &SharedState,
    task: &crate::models::Task,
    actor_id: Uuid,
    body: &str,
) {
    let mut recipients: HashSet<Uuid> = HashSet::from([task.creator_id]);
    if let Some(assignee) = task.assignee_id {
        recipients.insert(assignee);
    }
    recipients.remove(&actor_id);
    let preview = truncate_chars(&body.replace('\n', " "), 140);
    for uid in recipients {
        if let Err(error) =
            dispatch_task_event(state, uid, actor_id, task.id, "task_comment", &preview).await
        {
            tracing::warn!("task-comment notification dispatch failed: {}", error);
        }
    }
}

/// Insert + fan out one task notification: inbox row (channel-less, task-bound),
/// `notification.created`, and push under the standard DND/visibility rules.
async fn dispatch_task_event(
    state: &SharedState,
    recipient: Uuid,
    actor_id: Uuid,
    task_id: Uuid,
    kind: &str,
    preview: &str,
) -> AppResult<()> {
    if !kind_enabled(&state.pool, recipient, kind).await {
        return Ok(());
    }
    let row = sqlx::query(
        "INSERT INTO notifications (user_id, kind, actor_id, task_id, preview)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(recipient)
    .bind(kind)
    .bind(actor_id)
    .bind(task_id)
    .bind(preview)
    .fetch_one(&state.pool)
    .await?;
    let notif = load_notification(&state.pool, row.try_get("id")?).await?;

    let ev = envelope("notification.created", json!({ "notification": &notif }));
    state.hub.broadcast(ev, vec![recipient]).await;

    if !is_dnd(&state.pool, recipient).await {
        let web_allowed = !state.hub.has_visible_session(recipient).await;
        let expo_allowed = !state.hub.is_online(recipient);
        let (title, body) = push::title_and_body(&notif);
        let web = async {
            if web_allowed {
                push::send_to_user(state, recipient, &notif).await;
            }
        };
        let expo = async {
            if expo_allowed {
                expo_push::send_to_user(state, recipient, &title, &body, Uuid::nil(), &notif.kind)
                    .await;
            }
        };
        let apns = async {
            if web_allowed {
                crate::apns::send_to_user(
                    state,
                    recipient,
                    &title,
                    &body,
                    &notification_path(&notif),
                    &push::tag_for(&notif),
                )
                .await;
            }
        };
        tokio::join!(web, expo, apns);
    }
    Ok(())
}

/// Web push (RFC 8291 / VAPID) delivery.
mod push {
    use crate::models::Notification;
    use crate::state::SharedState;
    use serde_json::json;
    use sqlx::Row;
    use uuid::Uuid;
    use web_push::{
        ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushClient, WebPushError,
        WebPushMessageBuilder, URL_SAFE_NO_PAD,
    };

    pub fn title_and_body(notif: &Notification) -> (String, String) {
        let channel = notif.channel_name.as_deref().unwrap_or("channel");
        let task = notif.task_identifier.as_deref().unwrap_or("a task");
        // Title/body shaped for the service worker.
        let title = match notif.kind.as_str() {
            "dm" => notif.actor.display_name.clone(),
            "poll_ended" => format!("Poll ended in #{channel}"),
            "task_assigned" => format!("{} assigned you {task}", notif.actor.display_name),
            "task_comment" => format!("{} commented on {task}", notif.actor.display_name),
            _ => format!("{} in #{channel}", notif.actor.display_name),
        };
        (title, notif.preview.clone())
    }

    /// Collapse-tag for a notification (APNs `thread-id` / web-push `tag`).
    pub fn tag_for(notif: &Notification) -> String {
        match (&notif.task_id, &notif.channel_id) {
            (Some(task_id), _) => format!("sharp-task-{task_id}"),
            (None, Some(channel_id)) => format!("sharp-{channel_id}"),
            (None, None) => "sharp".to_string(),
        }
    }

    pub async fn send_to_user(state: &SharedState, user_id: Uuid, notif: &Notification) {
        let (title, body) = title_and_body(notif);
        let tag = tag_for(notif);
        let payload = json!({
            "title": title,
            "body": body,
            "channel_id": notif.channel_id.map(|id| id.to_string()),
            "message_id": notif.message_id.map(|id| id.to_string()),
            "notification_id": notif.id.to_string(),
            "kind": notif.kind,
            "tag": tag,
            "path": crate::notify::notification_path(notif),
            "timestamp": notif.created_at.timestamp_millis(),
        })
        .to_string();
        send_payload(state, user_id, &payload).await;
    }

    /// Deliver a ready-made JSON payload to every push subscription of a user.
    pub async fn send_payload(state: &SharedState, user_id: Uuid, payload: &str) {
        let Some(vapid) = &state.vapid else { return };

        let rows = match sqlx::query(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("push: load subscriptions: {}", e);
                return;
            }
        };
        if rows.is_empty() {
            return;
        }

        let client = web_push::HyperWebPushClient::new();

        for row in &rows {
            let endpoint: String = match row.try_get("endpoint") {
                Ok(v) => v,
                Err(_) => continue,
            };
            let p256dh: String = row.try_get("p256dh").unwrap_or_default();
            let auth: String = row.try_get("auth").unwrap_or_default();
            let subscription = SubscriptionInfo::new(endpoint.clone(), p256dh, auth);

            let mut sig = match VapidSignatureBuilder::from_base64(
                vapid.private_b64.as_str(),
                URL_SAFE_NO_PAD,
                &subscription,
            ) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("push: vapid signature: {}", e);
                    continue;
                }
            };
            sig.add_claim("sub", vapid.subject.as_str());
            let signature = match sig.build() {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("push: build signature: {}", e);
                    continue;
                }
            };

            let mut builder = WebPushMessageBuilder::new(&subscription);
            builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
            builder.set_vapid_signature(signature);
            let message = match builder.build() {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("push: build message: {}", e);
                    continue;
                }
            };

            // Bound each send so one stalled endpoint can't tie up the task.
            match tokio::time::timeout(std::time::Duration::from_secs(10), client.send(message))
                .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(WebPushError::EndpointNotValid))
                | Ok(Err(WebPushError::EndpointNotFound)) => {
                    // Subscription is gone — drop it.
                    let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1")
                        .bind(&endpoint)
                        .execute(&state.pool)
                        .await;
                }
                Ok(Err(e)) => tracing::warn!("push: send: {}", e),
                Err(_) => tracing::warn!("push: send timed out for {}", endpoint),
            }
        }
    }
}
