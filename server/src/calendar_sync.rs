//! Google Calendar rolling-window pull sync.
//!
//! v1 uses no syncToken: on each sync we re-list the calendar's events in a fixed
//! window (now-30d … now+90d), upsert them, and delete anything that vanished or
//! was cancelled. Upserts deliberately never touch the `reminded_*` columns, so a
//! resync can't re-arm a reminder that already fired. Runs both on-demand (tab
//! open / connect) and on the 5-minute background poller.

use crate::config::GoogleConfig;
use crate::google_oauth::{self, OAuthError};
use crate::state::SharedState;
use crate::ws::envelope;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::sync::OnceLock;
use uuid::Uuid;

const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Percent-encode a path segment (calendar ids are emails / contain `@`, `#`).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListResponse {
    #[serde(default)]
    items: Vec<CalendarListEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListEntry {
    id: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    background_color: Option<String>,
    #[serde(default)]
    primary: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsResponse {
    #[serde(default)]
    items: Vec<Value>,
    #[serde(default)]
    next_page_token: Option<String>,
}

/// A parsed calendar-event time: instant + whether it was an all-day (date-only) value.
fn parse_time(obj: &Value) -> Option<(DateTime<Utc>, bool)> {
    if let Some(dt) = obj.get("dateTime").and_then(|v| v.as_str()) {
        return DateTime::parse_from_rfc3339(dt)
            .ok()
            .map(|d| (d.with_timezone(&Utc), false));
    }
    if let Some(date) = obj.get("date").and_then(|v| v.as_str()) {
        return NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|naive| (naive.and_utc(), true));
    }
    None
}

/// Ensure the stored access token is fresh; refresh + persist when near expiry.
/// Returns a usable access token. On `invalid_grant` the account is flipped to
/// `status='invalid'` and an error is returned.
async fn ensure_access_token(
    state: &SharedState,
    cfg: &GoogleConfig,
    account_id: Uuid,
    access_token_enc: &str,
    refresh_token_enc: Option<&str>,
    token_expires_at: Option<DateTime<Utc>>,
) -> Result<String, String> {
    let jwt_secret = &state.config.jwt_secret;

    let near_expiry = token_expires_at
        .map(|exp| exp <= Utc::now() + Duration::minutes(2))
        .unwrap_or(false);

    if !near_expiry {
        return crate::calendar_crypto::decrypt(jwt_secret, access_token_enc);
    }

    let Some(refresh_enc) = refresh_token_enc else {
        // Nothing to refresh with — try the existing (possibly stale) token.
        return crate::calendar_crypto::decrypt(jwt_secret, access_token_enc);
    };
    let refresh_token = crate::calendar_crypto::decrypt(jwt_secret, refresh_enc)?;

    match google_oauth::refresh(cfg, &refresh_token).await {
        Ok(tokens) => {
            let new_access = tokens.access_token.clone();
            let access_enc = crate::calendar_crypto::encrypt(jwt_secret, &new_access)?;
            let expires_at =
                tokens.expires_in.map(|secs| Utc::now() + Duration::seconds(secs));
            // Google usually omits the refresh token on refresh; keep the stored one.
            let new_refresh_enc = match tokens.refresh_token {
                Some(rt) => Some(crate::calendar_crypto::encrypt(jwt_secret, &rt)?),
                None => None,
            };
            if let Some(rt_enc) = new_refresh_enc {
                sqlx::query(
                    "UPDATE calendar_accounts
                     SET access_token_enc = $1, refresh_token_enc = $2,
                         token_expires_at = $3, updated_at = now()
                     WHERE id = $4",
                )
                .bind(&access_enc)
                .bind(&rt_enc)
                .bind(expires_at)
                .bind(account_id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            } else {
                sqlx::query(
                    "UPDATE calendar_accounts
                     SET access_token_enc = $1, token_expires_at = $2, updated_at = now()
                     WHERE id = $3",
                )
                .bind(&access_enc)
                .bind(expires_at)
                .bind(account_id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            }
            Ok(new_access)
        }
        Err(OAuthError::InvalidGrant) => {
            let _ = sqlx::query(
                "UPDATE calendar_accounts SET status = 'invalid', updated_at = now() WHERE id = $1",
            )
            .bind(account_id)
            .execute(&state.pool)
            .await;
            Err("invalid_grant".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Sync a single connected account: refresh token if needed, upsert the calendar
/// list, then rolling-window upsert each selected calendar's events. Broadcasts
/// `calendar.synced` to the owner on success.
pub async fn sync_account(state: &SharedState, account_id: Uuid) -> Result<(), String> {
    let Some(cfg) = state.config.google.clone() else {
        return Err("google oauth not configured".to_string());
    };

    let row = sqlx::query(
        "SELECT user_id, access_token_enc, refresh_token_enc, token_expires_at
         FROM calendar_accounts WHERE id = $1 AND provider = 'google'",
    )
    .bind(account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "calendar account not found".to_string())?;

    let user_id: Uuid = row.try_get("user_id").map_err(|e| e.to_string())?;
    let access_token_enc: String = row.try_get("access_token_enc").map_err(|e| e.to_string())?;
    let refresh_token_enc: Option<String> =
        row.try_get("refresh_token_enc").map_err(|e| e.to_string())?;
    let token_expires_at: Option<DateTime<Utc>> =
        row.try_get("token_expires_at").map_err(|e| e.to_string())?;

    let access_token = ensure_access_token(
        state,
        &cfg,
        account_id,
        &access_token_enc,
        refresh_token_enc.as_deref(),
        token_expires_at,
    )
    .await?;

    // 1) Calendar list.
    let list_resp = client()
        .get(format!("{CALENDAR_API}/users/me/calendarList"))
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("calendarList request: {e}"))?;
    if !list_resp.status().is_success() {
        return Err(format!("calendarList endpoint {}", list_resp.status()));
    }
    let list: CalendarListResponse = list_resp
        .json()
        .await
        .map_err(|e| format!("parse calendarList: {e}"))?;

    for cal in &list.items {
        sqlx::query(
            "INSERT INTO calendar_calendars
               (account_id, external_id, summary, color, is_primary, selected, last_synced_at)
             VALUES ($1, $2, $3, $4, $5, true, now())
             ON CONFLICT (account_id, external_id) DO UPDATE SET
               summary = EXCLUDED.summary, color = EXCLUDED.color,
               is_primary = EXCLUDED.is_primary, last_synced_at = now()",
        )
        .bind(account_id)
        .bind(&cal.id)
        .bind(cal.summary.clone().unwrap_or_default())
        .bind(&cal.background_color)
        .bind(cal.primary)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    // 2) Events per selected calendar.
    let selected = sqlx::query(
        "SELECT id, external_id FROM calendar_calendars
         WHERE account_id = $1 AND selected = true",
    )
    .bind(account_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let time_min = (Utc::now() - Duration::days(30)).to_rfc3339();
    let time_max = (Utc::now() + Duration::days(90)).to_rfc3339();

    for cal_row in &selected {
        let calendar_id: Uuid = cal_row.try_get("id").map_err(|e| e.to_string())?;
        let external_id: String = cal_row.try_get("external_id").map_err(|e| e.to_string())?;

        let mut seen: Vec<String> = Vec::new();
        let mut page_token: Option<String> = None;
        let url = format!("{CALENDAR_API}/calendars/{}/events", pct(&external_id));

        loop {
            let mut req = client()
                .get(&url)
                .bearer_auth(&access_token)
                .query(&[
                    ("singleEvents", "true"),
                    ("orderBy", "startTime"),
                    ("timeMin", time_min.as_str()),
                    ("timeMax", time_max.as_str()),
                    ("maxResults", "250"),
                ]);
            if let Some(pt) = &page_token {
                req = req.query(&[("pageToken", pt.as_str())]);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("events request: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("events endpoint {}", resp.status()));
            }
            let events: EventsResponse =
                resp.json().await.map_err(|e| format!("parse events: {e}"))?;

            for ev in &events.items {
                let Some(ext_id) = ev.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let status = ev
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("confirmed");
                // Cancelled instances are dropped (not in `seen` -> deleted below).
                if status == "cancelled" {
                    continue;
                }
                let (Some((start_at, start_all_day)), Some((end_at, _))) = (
                    ev.get("start").and_then(parse_time),
                    ev.get("end").and_then(parse_time),
                ) else {
                    continue;
                };

                let title = ev.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                let description = ev.get("description").and_then(|v| v.as_str());
                let location = ev.get("location").and_then(|v| v.as_str());
                let html_link = ev.get("htmlLink").and_then(|v| v.as_str());

                sqlx::query(
                    "INSERT INTO calendar_events
                       (calendar_id, external_id, title, description, location,
                        start_at, end_at, all_day, status, html_link, raw, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
                     ON CONFLICT (calendar_id, external_id) DO UPDATE SET
                       title = EXCLUDED.title, description = EXCLUDED.description,
                       location = EXCLUDED.location, start_at = EXCLUDED.start_at,
                       end_at = EXCLUDED.end_at, all_day = EXCLUDED.all_day,
                       status = EXCLUDED.status, html_link = EXCLUDED.html_link,
                       raw = EXCLUDED.raw, updated_at = now()",
                )
                .bind(calendar_id)
                .bind(ext_id)
                .bind(title)
                .bind(description)
                .bind(location)
                .bind(start_at)
                .bind(end_at)
                .bind(start_all_day)
                .bind(status)
                .bind(html_link)
                .bind(ev)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;

                seen.push(ext_id.to_string());
            }

            page_token = events.next_page_token;
            if page_token.is_none() {
                break;
            }
        }

        // Remove rows for this calendar that no longer appear in the window
        // (deleted, cancelled, or moved out of range).
        sqlx::query(
            "DELETE FROM calendar_events WHERE calendar_id = $1 AND external_id <> ALL($2)",
        )
        .bind(calendar_id)
        .bind(&seen)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query("UPDATE calendar_calendars SET last_synced_at = now() WHERE id = $1")
            .bind(calendar_id)
            .execute(&state.pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 3) Mark synced + notify owner.
    let synced_at: DateTime<Utc> = sqlx::query_scalar(
        "UPDATE calendar_accounts SET last_synced_at = now(), updated_at = now()
         WHERE id = $1 RETURNING last_synced_at",
    )
    .bind(account_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let ev = envelope(
        "calendar.synced",
        json!({
            "account_id": account_id.to_string(),
            "last_synced_at": synced_at,
        }),
    );
    state.hub.broadcast(ev, vec![user_id]).await;

    Ok(())
}

// --- Background loops --------------------------------------------------------

/// One-line body for the reminder push, by kind.
fn reminder_body(kind: &str) -> &'static str {
    match kind {
        "lead" => "Starts soon",
        _ => "Starting now",
    }
}

/// Deliver one reminder to a single recipient: WS envelope (online toast + OS
/// notification) + best-effort web push (offline, self-guards DND/online).
async fn deliver_reminder(
    state: &SharedState,
    user_id: Uuid,
    kind: &str,
    title: &str,
    start_at: DateTime<Utc>,
    join_path: Option<String>,
    source: &str,
    ref_id: Uuid,
    channel_id: Option<Uuid>,
) {
    let ev = envelope(
        "calendar.reminder",
        json!({
            "kind": kind,
            "title": title,
            "start_at": start_at,
            "join_path": join_path,
            "source": source,
            "ref_id": ref_id.to_string(),
        }),
    );
    state.hub.broadcast(ev, vec![user_id]).await;

    let path = join_path.unwrap_or_else(|| "/calendar".to_string());
    let tag = format!("sharp-cal-{ref_id}");
    crate::notify::push_event(
        state,
        user_id,
        title,
        reminder_body(kind),
        &tag,
        &path,
        channel_id,
        "calendar",
    )
    .await;
}

/// Resolve a native meeting's join deep-link (mirrors `routes::calendar`).
async fn native_join_path(
    state: &SharedState,
    channel_id: Option<Uuid>,
    standalone_call_id: Option<Uuid>,
) -> Option<String> {
    if let Some(cid) = channel_id {
        return Some(format!("/c/{cid}"));
    }
    if let Some(sid) = standalone_call_id {
        let token: Option<String> =
            sqlx::query_scalar("SELECT link_token FROM standalone_calls WHERE id = $1")
                .bind(sid)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
        return token.map(|t| format!("/call/{t}"));
    }
    None
}

/// Fan a claimed native-meeting reminder out to its attendees.
async fn deliver_native_meeting(
    state: &SharedState,
    meeting_id: Uuid,
    title: &str,
    start_at: DateTime<Utc>,
    channel_id: Option<Uuid>,
    standalone_call_id: Option<Uuid>,
    kind: &str,
) {
    let join_path = native_join_path(state, channel_id, standalone_call_id).await;
    let attendees =
        sqlx::query("SELECT user_id FROM scheduled_meeting_attendees WHERE meeting_id = $1")
            .bind(meeting_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    for row in &attendees {
        let Ok(uid) = row.try_get::<Uuid, _>("user_id") else {
            continue;
        };
        deliver_reminder(
            state,
            uid,
            kind,
            title,
            start_at,
            join_path.clone(),
            "native",
            meeting_id,
            channel_id,
        )
        .await;
    }
}

/// 30-second reminder scheduler. Four atomic claim queries (lead/start ×
/// native/google) mark rows reminded via `RETURNING`, so concurrent replicas
/// never double-send. A lower time bound on the "start" claims prevents the
/// −30d Google sync window from back-filling a blast of stale reminders.
pub async fn reminder_tick(state: &SharedState) -> Result<(), String> {
    // Native — lead (upcoming within 10 minutes).
    let rows = sqlx::query(
        "UPDATE scheduled_meetings SET reminded_lead_at = now()
         WHERE status = 'scheduled' AND reminded_lead_at IS NULL
           AND start_at > now() AND start_at <= now() + interval '10 minutes'
         RETURNING id, title, start_at, channel_id, standalone_call_id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    for row in &rows {
        deliver_native_meeting(
            state,
            row.try_get("id").map_err(|e| e.to_string())?,
            &row.try_get::<String, _>("title").map_err(|e| e.to_string())?,
            row.try_get("start_at").map_err(|e| e.to_string())?,
            row.try_get("channel_id").map_err(|e| e.to_string())?,
            row.try_get("standalone_call_id").map_err(|e| e.to_string())?,
            "lead",
        )
        .await;
    }

    // Native — start (just started).
    let rows = sqlx::query(
        "UPDATE scheduled_meetings SET reminded_start_at = now()
         WHERE status = 'scheduled' AND reminded_start_at IS NULL
           AND start_at <= now() AND start_at > now() - interval '10 minutes'
         RETURNING id, title, start_at, channel_id, standalone_call_id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    for row in &rows {
        deliver_native_meeting(
            state,
            row.try_get("id").map_err(|e| e.to_string())?,
            &row.try_get::<String, _>("title").map_err(|e| e.to_string())?,
            row.try_get("start_at").map_err(|e| e.to_string())?,
            row.try_get("channel_id").map_err(|e| e.to_string())?,
            row.try_get("standalone_call_id").map_err(|e| e.to_string())?,
            "start",
        )
        .await;
    }

    // Google — lead.
    let rows = sqlx::query(
        "UPDATE calendar_events e SET reminded_lead_at = now()
         FROM calendar_calendars c, calendar_accounts a
         WHERE e.calendar_id = c.id AND c.account_id = a.id
           AND c.selected = true AND a.status = 'active' AND e.status = 'confirmed'
           AND e.reminded_lead_at IS NULL
           AND e.start_at > now() AND e.start_at <= now() + interval '10 minutes'
         RETURNING e.id, e.title, e.start_at, a.user_id AS owner_id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    for row in &rows {
        deliver_reminder(
            state,
            row.try_get("owner_id").map_err(|e| e.to_string())?,
            "lead",
            &row.try_get::<String, _>("title").map_err(|e| e.to_string())?,
            row.try_get("start_at").map_err(|e| e.to_string())?,
            None,
            "google",
            row.try_get("id").map_err(|e| e.to_string())?,
            None,
        )
        .await;
    }

    // Google — start.
    let rows = sqlx::query(
        "UPDATE calendar_events e SET reminded_start_at = now()
         FROM calendar_calendars c, calendar_accounts a
         WHERE e.calendar_id = c.id AND c.account_id = a.id
           AND c.selected = true AND a.status = 'active' AND e.status = 'confirmed'
           AND e.reminded_start_at IS NULL
           AND e.start_at <= now() AND e.start_at > now() - interval '10 minutes'
         RETURNING e.id, e.title, e.start_at, a.user_id AS owner_id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    for row in &rows {
        deliver_reminder(
            state,
            row.try_get("owner_id").map_err(|e| e.to_string())?,
            "start",
            &row.try_get::<String, _>("title").map_err(|e| e.to_string())?,
            row.try_get("start_at").map_err(|e| e.to_string())?,
            None,
            "google",
            row.try_get("id").map_err(|e| e.to_string())?,
            None,
        )
        .await;
    }

    Ok(())
}

/// 5-minute Google sync poller. Idempotent upserts make per-replica polling safe.
/// `sync_account` flips a connection to `status='invalid'` on `invalid_grant`.
pub async fn poll_active_accounts(state: &SharedState) {
    let rows = match sqlx::query("SELECT id FROM calendar_accounts WHERE status = 'active'")
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("calendar poller: load accounts: {}", e);
            return;
        }
    };
    for row in &rows {
        let Ok(account_id) = row.try_get::<Uuid, _>("id") else {
            continue;
        };
        if let Err(e) = sync_account(state, account_id).await {
            tracing::warn!("calendar poller: sync {}: {}", account_id, e);
        }
    }
}
