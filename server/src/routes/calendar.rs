//! Phase 5 — Calendar.
//!
//! Read-only Google Calendar pull-sync connections plus native "scheduled
//! meetings" tied to a channel/DM, a standalone call, or nothing (pure calendar
//! entries). Serves a merged agenda (`GET /calendar/events`) of Google events on
//! selected calendars ∪ native meetings the caller attends. All mutations that
//! change visible state emit a `calendar.*` WS event.
//!
//! Namespacing note: this is entirely separate from the transcript `meetings`
//! feature (`routes::meetings`, `meeting.*` events) — never conflate them.

use crate::auth::AuthUser;
use crate::calendar_sync;
use crate::error::{AppError, AppResult};
use crate::google_oauth;
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};
use std::path::Path as FsPath;
use uuid::Uuid;

// --- Wire types --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CalendarCalendar {
    pub id: Uuid,
    pub external_id: String,
    pub summary: String,
    pub color: Option<String>,
    pub is_primary: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarConnection {
    pub id: Uuid,
    pub provider: String,
    pub provider_email: String,
    pub status: String,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub calendars: Vec<CalendarCalendar>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingCreator {
    pub id: Uuid,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingAttendee {
    pub user_id: Uuid,
    pub display_name: String,
    pub response: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledMeeting {
    pub id: Uuid,
    pub channel_id: Option<Uuid>,
    pub standalone_call_id: Option<Uuid>,
    pub creator: MeetingCreator,
    pub title: String,
    pub description: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub all_day: bool,
    pub status: String,
    pub join_path: Option<String>,
    pub attendees: Vec<MeetingAttendee>,
    pub my_response: Option<String>,
}

/// A merged agenda item: either a Google-synced event or a native meeting.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "source")]
enum CalendarItem {
    #[serde(rename = "google")]
    Google {
        id: Uuid,
        calendar_id: Uuid,
        title: String,
        description: Option<String>,
        location: Option<String>,
        start_at: DateTime<Utc>,
        end_at: DateTime<Utc>,
        all_day: bool,
        html_link: Option<String>,
        color: Option<String>,
    },
    #[serde(rename = "native")]
    Native {
        id: Uuid,
        title: String,
        start_at: DateTime<Utc>,
        end_at: DateTime<Utc>,
        all_day: bool,
        join_path: Option<String>,
        meeting: ScheduledMeeting,
    },
}

// --- Loaders -----------------------------------------------------------------

async fn load_connections(pool: &PgPool, user_id: Uuid) -> AppResult<Vec<CalendarConnection>> {
    let account_rows = sqlx::query(
        "SELECT id, provider, provider_email, status, last_synced_at
         FROM calendar_accounts WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(account_rows.len());
    for row in &account_rows {
        let account_id: Uuid = row.try_get("id")?;
        let cal_rows = sqlx::query(
            "SELECT id, external_id, summary, color, is_primary, selected
             FROM calendar_calendars WHERE account_id = $1
             ORDER BY is_primary DESC, summary",
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?;
        let mut calendars = Vec::with_capacity(cal_rows.len());
        for c in &cal_rows {
            calendars.push(CalendarCalendar {
                id: c.try_get("id")?,
                external_id: c.try_get("external_id")?,
                summary: c.try_get("summary")?,
                color: c.try_get("color")?,
                is_primary: c.try_get("is_primary")?,
                selected: c.try_get("selected")?,
            });
        }
        out.push(CalendarConnection {
            id: account_id,
            provider: row.try_get("provider")?,
            provider_email: row.try_get("provider_email")?,
            status: row.try_get("status")?,
            last_synced_at: row.try_get("last_synced_at")?,
            calendars,
        });
    }
    Ok(out)
}

/// The join deep-link for a meeting's context (channel → `/c/{id}`, standalone →
/// `/call/{link_token}`, pure calendar entry → `None`).
async fn resolve_join_path(
    pool: &PgPool,
    channel_id: Option<Uuid>,
    standalone_call_id: Option<Uuid>,
) -> AppResult<Option<String>> {
    if let Some(cid) = channel_id {
        return Ok(Some(format!("/c/{cid}")));
    }
    if let Some(sid) = standalone_call_id {
        let row = sqlx::query("SELECT link_token FROM standalone_calls WHERE id = $1")
            .bind(sid)
            .fetch_optional(pool)
            .await?;
        return Ok(row
            .and_then(|r| r.try_get::<String, _>("link_token").ok())
            .map(|token| format!("/call/{token}")));
    }
    Ok(None)
}

async fn load_meeting(pool: &PgPool, id: Uuid, viewer: Uuid) -> AppResult<ScheduledMeeting> {
    let row = sqlx::query(
        "SELECT sm.id, sm.channel_id, sm.standalone_call_id, sm.title, sm.description,
                sm.start_at, sm.end_at, sm.all_day, sm.status,
                sm.creator_id, u.display_name AS creator_name, u.avatar_url AS creator_avatar
         FROM scheduled_meetings sm
         JOIN users u ON u.id = sm.creator_id
         WHERE sm.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("meeting not found".to_string()))?;

    let channel_id: Option<Uuid> = row.try_get("channel_id")?;
    let standalone_call_id: Option<Uuid> = row.try_get("standalone_call_id")?;

    let attendee_rows = sqlx::query(
        "SELECT a.user_id, u.display_name, a.response
         FROM scheduled_meeting_attendees a
         JOIN users u ON u.id = a.user_id
         WHERE a.meeting_id = $1
         ORDER BY u.display_name",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let mut attendees = Vec::with_capacity(attendee_rows.len());
    let mut my_response: Option<String> = None;
    for a in &attendee_rows {
        let uid: Uuid = a.try_get("user_id")?;
        let response: String = a.try_get("response")?;
        if uid == viewer {
            my_response = Some(response.clone());
        }
        attendees.push(MeetingAttendee {
            user_id: uid,
            display_name: a.try_get("display_name")?,
            response,
        });
    }

    let join_path = resolve_join_path(pool, channel_id, standalone_call_id).await?;

    Ok(ScheduledMeeting {
        id: row.try_get("id")?,
        channel_id,
        standalone_call_id,
        creator: MeetingCreator {
            id: row.try_get("creator_id")?,
            display_name: row.try_get("creator_name")?,
            avatar_url: row.try_get("creator_avatar")?,
        },
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        start_at: row.try_get("start_at")?,
        end_at: row.try_get("end_at")?,
        all_day: row.try_get("all_day")?,
        status: row.try_get("status")?,
        join_path,
        attendees,
        my_response,
    })
}

/// Fan a meeting event out to every attendee, with each recipient's own
/// `my_response` filled in from the attendee list (single-payload broadcast can't
/// carry a per-viewer field correctly).
async fn broadcast_meeting(state: &SharedState, meeting: &ScheduledMeeting, event_type: &str) {
    for att in &meeting.attendees {
        let mut m = meeting.clone();
        m.my_response = Some(att.response.clone());
        let ev = envelope(event_type, json!({ "meeting": m }));
        state.hub.broadcast(ev, vec![att.user_id]).await;
    }
}

// --- Connections -------------------------------------------------------------

pub async fn list_connections(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let connections = load_connections(&state.pool, auth.id).await?;
    Ok(Json(json!({ "connections": connections })))
}

pub async fn google_connect(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let cfg = state
        .config
        .google
        .as_ref()
        .ok_or_else(|| AppError::ServiceUnavailable("google calendar not configured".to_string()))?;
    let state_jwt = google_oauth::make_state(auth.id, &state.config.jwt_secret)
        .map_err(AppError::Internal)?;
    let url = google_oauth::authorize_url(cfg, &state_jwt);
    Ok(Json(json!({ "url": url })))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Minimal self-contained HTML page (SPA-independent, like `desktop_auth.html`)
/// so the callback works even in a split deploy where the SPA lives elsewhere.
fn callback_page(heading: &str, message: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"/>\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\
<title>sharp — calendar</title>\
<style>body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#0f1115;color:#e6e8eb;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;}}\
.card{{max-width:380px;text-align:center;}}h1{{font-size:20px;margin:0 0 8px;}}\
p{{color:#9aa3af;margin:0;}}</style></head>\
<body><div class=\"card\"><h1>{heading}</h1><p>{message}</p></div></body></html>"
    ))
}

fn redirect_302(location: &str) -> Response {
    (
        StatusCode::FOUND,
        [(header::LOCATION, location.to_string())],
    )
        .into_response()
}

/// GET /calendar/google/callback — unauthenticated; the signed `state` JWT proves
/// which user began the flow. Exchanges the code, stores encrypted tokens, kicks
/// an initial sync, then returns the user to the app.
pub async fn google_callback(
    State(state): State<SharedState>,
    Query(q): Query<CallbackQuery>,
) -> Response {
    if let Some(err) = q.error {
        return callback_page("Connection cancelled", &format!("Google returned: {err}"))
            .into_response();
    }

    let Some(cfg) = state.config.google.clone() else {
        return callback_page(
            "Calendar unavailable",
            "Google Calendar is not configured on this server.",
        )
        .into_response();
    };

    let (Some(code), Some(state_jwt)) = (q.code, q.state) else {
        return callback_page("Connection failed", "Missing authorization code or state.")
            .into_response();
    };

    let Some(user_id) = google_oauth::verify_state(&state_jwt, &state.config.jwt_secret) else {
        return callback_page(
            "Connection failed",
            "This sign-in link expired or was invalid. Please try again.",
        )
        .into_response();
    };

    // Exchange the code for tokens.
    let tokens = match google_oauth::exchange_code(&cfg, &code).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("calendar oauth exchange failed: {}", e);
            return callback_page("Connection failed", "Could not complete Google sign-in.")
                .into_response();
        }
    };

    let email = match google_oauth::fetch_email(&tokens.access_token).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("calendar userinfo failed: {}", e);
            return callback_page("Connection failed", "Could not read your Google account.")
                .into_response();
        }
    };

    // Encrypt tokens at rest.
    let secret = &state.config.jwt_secret;
    let access_enc = match crate::calendar_crypto::encrypt(secret, &tokens.access_token) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("calendar token encrypt: {}", e);
            return callback_page("Connection failed", "Internal error storing credentials.")
                .into_response();
        }
    };
    let refresh_enc = match &tokens.refresh_token {
        Some(rt) => match crate::calendar_crypto::encrypt(secret, rt) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("calendar refresh encrypt: {}", e);
                return callback_page("Connection failed", "Internal error storing credentials.")
                    .into_response();
            }
        },
        None => None,
    };
    let expires_at = tokens.expires_in.map(|s| Utc::now() + Duration::seconds(s));
    let scopes = tokens.scope.unwrap_or_default();

    // Upsert the account. On reconnect (same email) refresh tokens + reactivate;
    // keep the stored refresh token if this exchange omitted one.
    let insert = sqlx::query(
        "INSERT INTO calendar_accounts
           (user_id, provider, provider_email, access_token_enc, refresh_token_enc,
            token_expires_at, scopes, status)
         VALUES ($1, 'google', $2, $3, $4, $5, $6, 'active')
         ON CONFLICT (user_id, provider, provider_email) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, calendar_accounts.refresh_token_enc),
           token_expires_at = EXCLUDED.token_expires_at,
           scopes = EXCLUDED.scopes, status = 'active', updated_at = now()
         RETURNING id",
    )
    .bind(user_id)
    .bind(&email)
    .bind(&access_enc)
    .bind(&refresh_enc)
    .bind(expires_at)
    .bind(&scopes)
    .fetch_one(&state.pool)
    .await;

    let account_id: Uuid = match insert {
        Ok(row) => match row.try_get("id") {
            Ok(id) => id,
            Err(e) => {
                tracing::error!("calendar account id: {}", e);
                return callback_page("Connection failed", "Internal error.").into_response();
            }
        },
        Err(e) => {
            tracing::error!("calendar account upsert: {}", e);
            return callback_page("Connection failed", "Internal error.").into_response();
        }
    };

    // Kick the initial sync in the background.
    let sync_state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = calendar_sync::sync_account(&sync_state, account_id).await {
            tracing::warn!("calendar initial sync failed: {}", e);
        }
    });

    // Return to the app. When the SPA is served from this binary, redirect there;
    // otherwise (split deploy / API-only) show a self-contained "connected" page.
    let spa_present = FsPath::new(&state.config.web_dist)
        .join("index.html")
        .is_file();
    if spa_present {
        redirect_302("/calendar?connected=1")
    } else {
        callback_page(
            "Google Calendar connected",
            "You can close this tab and return to sharp.",
        )
        .into_response()
    }
}

pub async fn disconnect(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let result = sqlx::query("DELETE FROM calendar_accounts WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("connection not found".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SetCalendarSelectedRequest {
    pub selected: bool,
}

pub async fn set_calendar_selected(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<SetCalendarSelectedRequest>,
) -> AppResult<StatusCode> {
    // Owner check: the calendar must belong to one of the caller's accounts.
    let result = sqlx::query(
        "UPDATE calendar_calendars SET selected = $1
         WHERE id = $2 AND account_id IN (
             SELECT id FROM calendar_accounts WHERE user_id = $3
         )",
    )
    .bind(body.selected)
    .bind(id)
    .bind(auth.id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("calendar not found".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// POST /calendar/sync — fire-and-forget refresh of all the caller's active
/// accounts. Returns 202 immediately.
pub async fn sync_now(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let rows = sqlx::query(
        "SELECT id FROM calendar_accounts WHERE user_id = $1 AND status = 'active'",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;
    for row in &rows {
        let account_id: Uuid = row.try_get("id")?;
        let sync_state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = calendar_sync::sync_account(&sync_state, account_id).await {
                tracing::warn!("calendar on-demand sync failed: {}", e);
            }
        });
    }
    Ok(StatusCode::ACCEPTED)
}

// --- Merged agenda -----------------------------------------------------------

#[derive(Deserialize)]
pub struct EventsQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

pub async fn list_events(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(q): Query<EventsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let from = q.from.unwrap_or_else(|| Utc::now() - Duration::days(30));
    let to = q.to.unwrap_or_else(|| Utc::now() + Duration::days(90));

    let mut items: Vec<CalendarItem> = Vec::new();

    // Google events on the caller's selected calendars, overlapping [from, to].
    let event_rows = sqlx::query(
        "SELECT e.id, e.calendar_id, e.title, e.description, e.location,
                e.start_at, e.end_at, e.all_day, e.html_link, c.color
         FROM calendar_events e
         JOIN calendar_calendars c ON c.id = e.calendar_id
         JOIN calendar_accounts a ON a.id = c.account_id
         WHERE a.user_id = $1 AND c.selected = true
           AND e.status <> 'cancelled'
           AND e.end_at >= $2 AND e.start_at <= $3
         ORDER BY e.start_at",
    )
    .bind(auth.id)
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;
    for row in &event_rows {
        items.push(CalendarItem::Google {
            id: row.try_get("id")?,
            calendar_id: row.try_get("calendar_id")?,
            title: row.try_get("title")?,
            description: row.try_get("description")?,
            location: row.try_get("location")?,
            start_at: row.try_get("start_at")?,
            end_at: row.try_get("end_at")?,
            all_day: row.try_get("all_day")?,
            html_link: row.try_get("html_link")?,
            color: row.try_get("color")?,
        });
    }

    // Native scheduled meetings the caller attends, overlapping [from, to].
    let meeting_rows = sqlx::query(
        "SELECT sm.id FROM scheduled_meetings sm
         JOIN scheduled_meeting_attendees a ON a.meeting_id = sm.id
         WHERE a.user_id = $1 AND sm.status = 'scheduled'
           AND sm.end_at >= $2 AND sm.start_at <= $3
         ORDER BY sm.start_at",
    )
    .bind(auth.id)
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;
    for row in &meeting_rows {
        let id: Uuid = row.try_get("id")?;
        let meeting = load_meeting(&state.pool, id, auth.id).await?;
        items.push(CalendarItem::Native {
            id: meeting.id,
            title: meeting.title.clone(),
            start_at: meeting.start_at,
            end_at: meeting.end_at,
            all_day: meeting.all_day,
            join_path: meeting.join_path.clone(),
            meeting,
        });
    }

    items.sort_by_key(item_start);

    Ok(Json(json!({ "events": items })))
}

fn item_start(item: &CalendarItem) -> DateTime<Utc> {
    match item {
        CalendarItem::Google { start_at, .. } => *start_at,
        CalendarItem::Native { start_at, .. } => *start_at,
    }
}

// --- Scheduled meetings ------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateMeetingRequest {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub channel_id: Option<Uuid>,
    #[serde(default)]
    pub standalone_call_id: Option<Uuid>,
    #[serde(default)]
    pub attendee_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub post_card: bool,
}

/// Strip token delimiters so a title can't break the `[[meet:…]]` chip.
fn sanitize_token_field(s: &str) -> String {
    s.replace(['|', ']', '\n'], " ").trim().to_string()
}

pub async fn create_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<CreateMeetingRequest>,
) -> AppResult<(StatusCode, Json<ScheduledMeeting>)> {
    let title = body.title.trim().to_string();
    let title_len = title.chars().count();
    if title_len < 1 || title_len > 200 {
        return Err(AppError::Validation(
            "title must be between 1 and 200 characters".to_string(),
        ));
    }
    if body.channel_id.is_some() && body.standalone_call_id.is_some() {
        return Err(AppError::BadRequest(
            "a meeting cannot bind both a channel and a standalone call".to_string(),
        ));
    }
    if !body.all_day && body.end_at < body.start_at {
        return Err(AppError::Validation(
            "end_at must not be before start_at".to_string(),
        ));
    }

    // Context validation + default attendees.
    let mut attendee_set: Vec<Uuid> = Vec::new();
    if let Some(channel_id) = body.channel_id {
        if !crate::routes::is_member(&state.pool, channel_id, auth.id).await? {
            return Err(AppError::Forbidden(
                "not a member of this channel".to_string(),
            ));
        }
        match &body.attendee_ids {
            Some(ids) => attendee_set.extend(ids.iter().copied()),
            None => attendee_set.extend(channel_member_ids(&state.pool, channel_id).await?),
        }
    } else if let Some(standalone_call_id) = body.standalone_call_id {
        let exists = sqlx::query("SELECT 1 AS x FROM standalone_calls WHERE id = $1")
            .bind(standalone_call_id)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(AppError::NotFound("standalone call not found".to_string()));
        }
        if let Some(ids) = &body.attendee_ids {
            attendee_set.extend(ids.iter().copied());
        }
    } else if let Some(ids) = &body.attendee_ids {
        attendee_set.extend(ids.iter().copied());
    }
    // The creator always attends.
    if !attendee_set.contains(&auth.id) {
        attendee_set.push(auth.id);
    }
    attendee_set.sort();
    attendee_set.dedup();

    let description = body.description.unwrap_or_default();

    let meeting_id: Uuid = sqlx::query_scalar(
        "INSERT INTO scheduled_meetings
           (channel_id, standalone_call_id, creator_id, title, description,
            start_at, end_at, all_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(body.channel_id)
    .bind(body.standalone_call_id)
    .bind(auth.id)
    .bind(&title)
    .bind(&description)
    .bind(body.start_at)
    .bind(body.end_at)
    .bind(body.all_day)
    .fetch_one(&state.pool)
    .await?;

    for uid in &attendee_set {
        // Creator auto-accepts; everyone else starts at needs_action.
        let response = if *uid == auth.id { "accepted" } else { "needs_action" };
        sqlx::query(
            "INSERT INTO scheduled_meeting_attendees (meeting_id, user_id, response)
             VALUES ($1, $2, $3) ON CONFLICT (meeting_id, user_id) DO NOTHING",
        )
        .bind(meeting_id)
        .bind(uid)
        .bind(response)
        .execute(&state.pool)
        .await?;
    }

    // Optional chat card (channel context only).
    if body.post_card {
        if let Some(channel_id) = body.channel_id {
            let token = format!(
                "[[meet:{}|{}|{}]]",
                meeting_id,
                sanitize_token_field(&title),
                body.start_at.to_rfc3339()
            );
            match crate::routes::messages::post_message_as(&state, channel_id, auth.id, &token)
                .await
            {
                Ok(message) => {
                    sqlx::query(
                        "UPDATE scheduled_meetings SET card_message_id = $1 WHERE id = $2",
                    )
                    .bind(message.id)
                    .bind(meeting_id)
                    .execute(&state.pool)
                    .await?;
                }
                Err(e) => tracing::warn!("meeting card post failed: {}", e),
            }
        }
    }

    let meeting = load_meeting(&state.pool, meeting_id, auth.id).await?;
    broadcast_meeting(&state, &meeting, "calendar.meeting_created").await;

    Ok((StatusCode::CREATED, Json(meeting)))
}

/// Whether `user` may view a meeting (creator or an attendee).
async fn is_participant(pool: &PgPool, meeting_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let row = sqlx::query(
        "SELECT 1 AS x FROM scheduled_meetings sm
         WHERE sm.id = $1 AND (
             sm.creator_id = $2
             OR EXISTS (SELECT 1 FROM scheduled_meeting_attendees a
                        WHERE a.meeting_id = sm.id AND a.user_id = $2)
         )",
    )
    .bind(meeting_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

async fn require_creator(pool: &PgPool, meeting_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let row = sqlx::query("SELECT creator_id FROM scheduled_meetings WHERE id = $1")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("meeting not found".to_string()))?;
    let creator_id: Uuid = row.try_get("creator_id")?;
    if creator_id != user_id {
        return Err(AppError::Forbidden("not the meeting creator".to_string()));
    }
    Ok(())
}

pub async fn get_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ScheduledMeeting>> {
    if !is_participant(&state.pool, id, auth.id).await? {
        return Err(AppError::NotFound("meeting not found".to_string()));
    }
    let meeting = load_meeting(&state.pool, id, auth.id).await?;
    Ok(Json(meeting))
}

#[derive(Deserialize)]
pub struct UpdateMeetingRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub start_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub end_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub all_day: Option<bool>,
}

pub async fn update_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateMeetingRequest>,
) -> AppResult<Json<ScheduledMeeting>> {
    require_creator(&state.pool, id, auth.id).await?;

    if let Some(title) = &body.title {
        let len = title.trim().chars().count();
        if len < 1 || len > 200 {
            return Err(AppError::Validation(
                "title must be between 1 and 200 characters".to_string(),
            ));
        }
    }

    // A time change re-arms reminders (reset the claim flags to NULL).
    let reschedules = body.start_at.is_some() || body.end_at.is_some();

    sqlx::query(
        "UPDATE scheduled_meetings SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           start_at = COALESCE($4, start_at),
           end_at = COALESCE($5, end_at),
           all_day = COALESCE($6, all_day),
           reminded_lead_at = CASE WHEN $7 THEN NULL ELSE reminded_lead_at END,
           reminded_start_at = CASE WHEN $7 THEN NULL ELSE reminded_start_at END,
           updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.title.as_ref().map(|t| t.trim().to_string()))
    .bind(&body.description)
    .bind(body.start_at)
    .bind(body.end_at)
    .bind(body.all_day)
    .bind(reschedules)
    .execute(&state.pool)
    .await?;

    let meeting = load_meeting(&state.pool, id, auth.id).await?;
    broadcast_meeting(&state, &meeting, "calendar.meeting_updated").await;
    Ok(Json(meeting))
}

pub async fn cancel_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_creator(&state.pool, id, auth.id).await?;

    // Capture attendees before flipping status (so we can still notify them).
    let meeting = load_meeting(&state.pool, id, auth.id).await?;

    sqlx::query(
        "UPDATE scheduled_meetings SET status = 'cancelled', updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;

    let ev = envelope("calendar.meeting_cancelled", json!({ "meeting_id": id.to_string() }));
    let targets: Vec<Uuid> = meeting.attendees.iter().map(|a| a.user_id).collect();
    state.hub.broadcast(ev, targets).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RsvpRequest {
    pub response: String,
}

pub async fn rsvp(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RsvpRequest>,
) -> AppResult<StatusCode> {
    if !matches!(
        body.response.as_str(),
        "needs_action" | "accepted" | "declined" | "tentative"
    ) {
        return Err(AppError::Validation("invalid rsvp response".to_string()));
    }
    let result = sqlx::query(
        "UPDATE scheduled_meeting_attendees SET response = $1
         WHERE meeting_id = $2 AND user_id = $3",
    )
    .bind(&body.response)
    .bind(id)
    .bind(auth.id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Forbidden("not an attendee of this meeting".to_string()));
    }

    // Reflect the updated RSVP to attendees.
    let meeting = load_meeting(&state.pool, id, auth.id).await?;
    broadcast_meeting(&state, &meeting, "calendar.meeting_updated").await;

    Ok(StatusCode::NO_CONTENT)
}
