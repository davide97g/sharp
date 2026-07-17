use crate::auth::AuthUser;
use crate::deepseek;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::ws::envelope;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct LiveAttendee {
    pub connection_id: Uuid,
    pub user_id: Option<Uuid>,
    pub display_name: String,
    pub guest: bool,
    pub joined_at: DateTime<Utc>,
}

pub(crate) async fn start_live_meeting(
    state: &SharedState,
    room_id: Uuid,
    created_by: Option<Uuid>,
    attendees: &[LiveAttendee],
) -> AppResult<(Uuid, Vec<(Uuid, Uuid)>)> {
    let now = Utc::now();
    let context = load_room_context(state, room_id).await?;
    let title = if context.kind == "standalone" {
        context.name.clone()
    } else {
        format!("{} · {}", context.name, now.format("%b %-d, %Y · %H:%M"))
    };
    let summary_status = if state.config.deepseek.is_some() { "pending" } else { "unavailable" };
    let mut tx = state.pool.begin().await?;
    let meeting_id: Uuid = sqlx::query_scalar(
        "INSERT INTO meetings
            (channel_id, standalone_call_id, title, summary_status, started_at, last_activity_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id",
    )
    .bind(context.channel_id)
    .bind(context.standalone_call_id)
    .bind(title)
    .bind(summary_status)
    .bind(now)
    .bind(created_by)
    .fetch_one(&mut *tx)
    .await?;
    let mut ids = Vec::new();
    for attendee in attendees {
        let attendance_id: Uuid = sqlx::query_scalar(
            "INSERT INTO meeting_attendance
                (meeting_id, connection_id, user_id, display_name, guest, joined_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(meeting_id)
        .bind(attendee.connection_id)
        .bind(attendee.user_id)
        .bind(&attendee.display_name)
        .bind(attendee.guest)
        .bind(attendee.joined_at)
        .fetch_one(&mut *tx)
        .await?;
        ids.push((attendee.connection_id, attendance_id));
    }
    tx.commit().await?;
    Ok((meeting_id, ids))
}

struct RoomContext {
    channel_id: Option<Uuid>,
    standalone_call_id: Option<Uuid>,
    name: String,
    kind: String,
}

async fn load_room_context(state: &SharedState, room_id: Uuid) -> AppResult<RoomContext> {
    let row = sqlx::query(
        "SELECT channel_id, standalone_call_id, name, kind FROM (
             SELECT id AS room_id, id AS channel_id, NULL::uuid AS standalone_call_id,
                    name, kind
               FROM channels
             UNION ALL
             SELECT id AS room_id, NULL::uuid AS channel_id, id AS standalone_call_id,
                    title AS name, 'standalone'::text AS kind
               FROM standalone_calls
         ) contexts WHERE room_id = $1",
    )
    .bind(room_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("call room not found".into()))?;
    Ok(RoomContext {
        channel_id: row.try_get("channel_id")?,
        standalone_call_id: row.try_get("standalone_call_id")?,
        name: row.try_get("name")?,
        kind: row.try_get("kind")?,
    })
}

pub(crate) async fn add_live_attendee(
    state: &SharedState,
    meeting_id: Uuid,
    attendee: &LiveAttendee,
) -> AppResult<Uuid> {
    let id = sqlx::query_scalar(
        "INSERT INTO meeting_attendance
            (meeting_id, connection_id, user_id, display_name, guest, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (meeting_id, connection_id) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id",
    )
    .bind(meeting_id)
    .bind(attendee.connection_id)
    .bind(attendee.user_id)
    .bind(&attendee.display_name)
    .bind(attendee.guest)
    .bind(attendee.joined_at)
    .fetch_one(&state.pool)
    .await?;
    sqlx::query("UPDATE meetings SET last_activity_at = now() WHERE id = $1")
        .bind(meeting_id)
        .execute(&state.pool)
        .await?;
    Ok(id)
}

pub(crate) async fn close_live_attendee(
    state: &SharedState,
    meeting_id: Uuid,
    connection_id: Uuid,
    at: DateTime<Utc>,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE meeting_attendance SET left_at = COALESCE(left_at, $3)
          WHERE meeting_id = $1 AND connection_id = $2",
    )
    .bind(meeting_id)
    .bind(connection_id)
    .bind(at)
    .execute(&state.pool)
    .await?;
    sqlx::query("UPDATE meetings SET last_activity_at = $2 WHERE id = $1")
        .bind(meeting_id)
        .bind(at)
        .execute(&state.pool)
        .await?;
    Ok(())
}

pub(crate) async fn save_live_phrase(
    state: &SharedState,
    meeting_id: Uuid,
    attendance_id: Option<Uuid>,
    attendee: &LiveAttendee,
    text: &str,
    at: DateTime<Utc>,
) -> AppResult<i64> {
    let id = sqlx::query_scalar(
        "INSERT INTO meeting_transcript_phrases
            (meeting_id, attendance_id, user_id, display_name, guest, text, spoken_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(meeting_id)
    .bind(attendance_id)
    .bind(attendee.user_id)
    .bind(&attendee.display_name)
    .bind(attendee.guest)
    .bind(text)
    .bind(at)
    .fetch_one(&state.pool)
    .await?;
    sqlx::query("UPDATE meetings SET last_activity_at = $2 WHERE id = $1")
        .bind(meeting_id)
        .bind(at)
        .execute(&state.pool)
        .await?;
    Ok(id)
}

pub(crate) async fn finish_live_meeting(
    state: &SharedState,
    meeting_id: Uuid,
    at: DateTime<Utc>,
    interrupted: bool,
) -> AppResult<()> {
    let status = if interrupted { "interrupted" } else { "completed" };
    let result = sqlx::query(
        "UPDATE meetings SET status = $2, ended_at = $3, last_activity_at = $3, updated_at = now()
          WHERE id = $1 AND status = 'active'",
    )
    .bind(meeting_id)
    .bind(status)
    .bind(at)
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "UPDATE meeting_attendance SET left_at = COALESCE(left_at, $2) WHERE meeting_id = $1",
    )
    .bind(meeting_id)
    .bind(at)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() > 0 && state.config.deepseek.is_some() {
        queue_summary(state.clone(), meeting_id);
    }
    Ok(())
}

pub(crate) async fn recover_interrupted_meetings(state: &SharedState) -> AppResult<()> {
    let rows = sqlx::query(
        "UPDATE meetings SET status = 'interrupted', ended_at = last_activity_at,
                updated_at = now()
          WHERE status = 'active' AND last_activity_at < now() - interval '2 minutes'
          RETURNING id",
    )
    .fetch_all(&state.pool)
    .await?;
    for row in rows {
        let id: Uuid = row.get("id");
        sqlx::query(
            "UPDATE meeting_attendance SET left_at = COALESCE(left_at,
                (SELECT ended_at FROM meetings WHERE id = $1)) WHERE meeting_id = $1",
        )
        .bind(id)
        .execute(&state.pool)
        .await?;
        if state.config.deepseek.is_some() {
            queue_summary(state.clone(), id);
        }
    }
    Ok(())
}

pub(crate) async fn heartbeat_live_meetings(state: &SharedState) -> AppResult<()> {
    let ids = {
        let guard = state.voice_rooms.lock().unwrap();
        guard
            .values()
            .filter_map(|room| room.active_meeting_id)
            .collect::<Vec<_>>()
    };
    if !ids.is_empty() {
        sqlx::query("UPDATE meetings SET last_activity_at = now() WHERE id = ANY($1)")
            .bind(ids)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ListMeetingsQuery {
    channel_id: Option<Uuid>,
    q: Option<String>,
    before: Option<DateTime<Utc>>,
    limit: Option<i64>,
}

#[derive(Serialize)]
struct MeetingListItem {
    id: Uuid,
    channel_id: Uuid,
    channel_name: String,
    channel_kind: String,
    title: String,
    status: String,
    summary_status: String,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    participant_count: i64,
    transcript_count: i64,
}

#[derive(Deserialize)]
pub struct UpdateMeetingRequest {
    title: Option<String>,
    summary: Option<String>,
    decisions: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveActionsRequest {
    actions: Vec<ActionInput>,
}

#[derive(Deserialize)]
pub struct ActionInput {
    id: Option<Uuid>,
    text: String,
    assignee_user_id: Option<Uuid>,
    completed: bool,
}

pub async fn list_meetings(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(query): Query<ListMeetingsQuery>,
) -> AppResult<Json<Value>> {
    let search = query.q.unwrap_or_default().trim().to_string();
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let rows = sqlx::query(
        "SELECT m.id, COALESCE(m.channel_id, m.standalone_call_id) AS room_id,
                COALESCE(c.name, sc.title) AS channel_name,
                COALESCE(c.kind, 'standalone') AS channel_kind,
                m.title, m.status, m.summary_status, m.started_at, m.ended_at,
                (SELECT count(DISTINCT COALESCE(a.user_id::text, a.id::text))
                   FROM meeting_attendance a WHERE a.meeting_id = m.id) AS participant_count,
                (SELECT count(*) FROM meeting_transcript_phrases p
                   WHERE p.meeting_id = m.id) AS transcript_count
           FROM meetings m
           LEFT JOIN channels c ON c.id = m.channel_id
           LEFT JOIN standalone_calls sc ON sc.id = m.standalone_call_id
          WHERE (
                (m.channel_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = m.channel_id AND cm.user_id = $1
                ))
                OR (m.standalone_call_id IS NOT NULL AND (
                    sc.created_by = $1 OR EXISTS (
                        SELECT 1 FROM meeting_attendance ma
                         WHERE ma.meeting_id = m.id AND ma.user_id = $1
                    )
                ))
            )
            AND ($2::uuid IS NULL OR COALESCE(m.channel_id, m.standalone_call_id) = $2)
            AND ($3::timestamptz IS NULL OR m.started_at < $3)
            AND ($4 = '' OR m.title ILIKE '%' || $4 || '%'
                 OR m.summary ILIKE '%' || $4 || '%'
                 OR m.decisions ILIKE '%' || $4 || '%'
                 OR EXISTS (SELECT 1 FROM meeting_transcript_phrases p
                             WHERE p.meeting_id = m.id
                               AND p.search @@ websearch_to_tsquery('simple', $4)))
          ORDER BY m.started_at DESC, m.id
          LIMIT $5",
    )
    .bind(auth.id)
    .bind(query.channel_id)
    .bind(query.before)
    .bind(search)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let meetings = rows
        .into_iter()
        .map(|row| -> Result<MeetingListItem, sqlx::Error> {
            Ok(MeetingListItem {
                id: row.try_get("id")?,
                channel_id: row.try_get("room_id")?,
                channel_name: row.try_get("channel_name")?,
                channel_kind: row.try_get("channel_kind")?,
                title: row.try_get("title")?,
                status: row.try_get("status")?,
                summary_status: row.try_get("summary_status")?,
                started_at: row.try_get("started_at")?,
                ended_at: row.try_get("ended_at")?,
                participant_count: row.try_get("participant_count")?,
                transcript_count: row.try_get("transcript_count")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "meetings": meetings })))
}

pub async fn get_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_meeting_access(&state, id, auth.id).await?;
    Ok(Json(load_meeting_detail(&state, id).await?))
}

pub async fn update_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateMeetingRequest>,
) -> AppResult<Json<Value>> {
    ensure_meeting_access(&state, id, auth.id).await?;
    if body.title.is_none() && body.summary.is_none() && body.decisions.is_none() {
        return Err(AppError::BadRequest("no meeting fields supplied".into()));
    }
    let title = body.title.map(|value| value.trim().to_string());
    if title.as_ref().is_some_and(|value| value.is_empty() || value.chars().count() > 160) {
        return Err(AppError::Validation("title must be 1–160 characters".into()));
    }
    if body.summary.as_ref().is_some_and(|value| value.chars().count() > 20_000)
        || body.decisions.as_ref().is_some_and(|value| value.chars().count() > 20_000)
    {
        return Err(AppError::Validation("notes must be at most 20,000 characters".into()));
    }
    sqlx::query(
        "UPDATE meetings
            SET title = COALESCE($2, title), summary = COALESCE($3, summary),
                decisions = COALESCE($4, decisions), updated_at = now()
          WHERE id = $1",
    )
    .bind(id)
    .bind(title)
    .bind(body.summary)
    .bind(body.decisions)
    .execute(&state.pool)
    .await?;
    Ok(Json(load_meeting_detail(&state, id).await?))
}

pub async fn save_actions(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<SaveActionsRequest>,
) -> AppResult<Json<Value>> {
    ensure_meeting_access(&state, id, auth.id).await?;
    if body.actions.len() > 100 {
        return Err(AppError::Validation("a meeting can have at most 100 action items".into()));
    }
    for action in &body.actions {
        let len = action.text.trim().chars().count();
        if len == 0 || len > 500 {
            return Err(AppError::Validation("action text must be 1–500 characters".into()));
        }
        if let Some(user_id) = action.assignee_user_id {
            let attendee = sqlx::query(
                "SELECT 1 FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2 LIMIT 1",
            )
            .bind(id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
            if attendee.is_none() {
                return Err(AppError::Validation("action assignee must be a meeting attendee".into()));
            }
        }
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM meeting_action_items WHERE meeting_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (position, action) in body.actions.into_iter().enumerate() {
        sqlx::query(
            "INSERT INTO meeting_action_items
                (id, meeting_id, text, assignee_user_id, completed, position)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(action.id.unwrap_or_else(Uuid::new_v4))
        .bind(id)
        .bind(action.text.trim())
        .bind(action.assignee_user_id)
        .bind(action.completed)
        .bind(position as i32)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE meetings SET updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(load_meeting_detail(&state, id).await?))
}

pub async fn regenerate_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_meeting_access(&state, id, auth.id).await?;
    let status: String = sqlx::query_scalar("SELECT status FROM meetings WHERE id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if status == "active" {
        return Err(AppError::Conflict("meeting is still active".into()));
    }
    let summary_status = if state.config.deepseek.is_some() { "pending" } else { "unavailable" };
    sqlx::query("UPDATE meetings SET summary_status = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(summary_status)
        .execute(&state.pool)
        .await?;
    if state.config.deepseek.is_some() {
        queue_summary(state.clone(), id);
    }
    Ok((StatusCode::ACCEPTED, Json(json!({ "summary_status": summary_status }))))
}

pub async fn delete_meeting(
    State(state): State<SharedState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    ensure_meeting_access(&state, id, auth.id).await?;
    let status: String = sqlx::query_scalar("SELECT status FROM meetings WHERE id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if status == "active" {
        return Err(AppError::Conflict("meeting is still active".into()));
    }
    sqlx::query("DELETE FROM meetings WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ensure_meeting_access(state: &SharedState, id: Uuid, user_id: Uuid) -> AppResult<Uuid> {
    let room_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT COALESCE(m.channel_id, m.standalone_call_id)
           FROM meetings m
           LEFT JOIN standalone_calls sc ON sc.id = m.standalone_call_id
          WHERE m.id = $1 AND (
                (m.channel_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = m.channel_id AND cm.user_id = $2
                ))
                OR (m.standalone_call_id IS NOT NULL AND (
                    sc.created_by = $2 OR EXISTS (
                        SELECT 1 FROM meeting_attendance ma
                         WHERE ma.meeting_id = m.id AND ma.user_id = $2
                    )
                ))
          )",
    )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    room_id.ok_or_else(|| AppError::NotFound("meeting not found".into()))
}

async fn load_meeting_detail(state: &SharedState, id: Uuid) -> AppResult<Value> {
    let meeting = sqlx::query(
        "SELECT m.id, COALESCE(m.channel_id, m.standalone_call_id) AS room_id,
                COALESCE(c.name, sc.title) AS channel_name,
                COALESCE(c.kind, 'standalone') AS channel_kind,
                m.title, m.status, m.summary_status, m.summary, m.decisions,
                m.started_at, m.ended_at, m.created_at, m.updated_at
           FROM meetings m
           LEFT JOIN channels c ON c.id = m.channel_id
           LEFT JOIN standalone_calls sc ON sc.id = m.standalone_call_id
          WHERE m.id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    let attendance = sqlx::query(
        "SELECT id, user_id, display_name, guest, joined_at, left_at
           FROM meeting_attendance WHERE meeting_id = $1 ORDER BY joined_at, id",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| json!({
        "id": row.get::<Uuid, _>("id"), "user_id": row.get::<Option<Uuid>, _>("user_id"),
        "display_name": row.get::<String, _>("display_name"), "guest": row.get::<bool, _>("guest"),
        "joined_at": row.get::<DateTime<Utc>, _>("joined_at"),
        "left_at": row.get::<Option<DateTime<Utc>>, _>("left_at")
    }))
    .collect::<Vec<_>>();
    let transcript = sqlx::query(
        "SELECT id, attendance_id, user_id, display_name, guest, text, spoken_at
           FROM meeting_transcript_phrases WHERE meeting_id = $1 ORDER BY spoken_at, id",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| json!({
        "id": row.get::<i64, _>("id").to_string(),
        "attendance_id": row.get::<Option<Uuid>, _>("attendance_id"),
        "user_id": row.get::<Option<Uuid>, _>("user_id"),
        "display_name": row.get::<String, _>("display_name"), "guest": row.get::<bool, _>("guest"),
        "text": row.get::<String, _>("text"), "spoken_at": row.get::<DateTime<Utc>, _>("spoken_at")
    }))
    .collect::<Vec<_>>();
    let actions = sqlx::query(
        "SELECT a.id, a.text, a.assignee_user_id, u.display_name AS assignee_name,
                a.completed, a.position
           FROM meeting_action_items a LEFT JOIN users u ON u.id = a.assignee_user_id
          WHERE a.meeting_id = $1 ORDER BY a.position, a.created_at",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| json!({
        "id": row.get::<Uuid, _>("id"), "text": row.get::<String, _>("text"),
        "assignee_user_id": row.get::<Option<Uuid>, _>("assignee_user_id"),
        "assignee_name": row.get::<Option<String>, _>("assignee_name"),
        "completed": row.get::<bool, _>("completed"), "position": row.get::<i32, _>("position")
    }))
    .collect::<Vec<_>>();
    let participant_count = attendance
        .iter()
        .filter_map(|item| item.get("user_id").and_then(Value::as_str).or_else(|| item.get("id").and_then(Value::as_str)))
        .collect::<std::collections::HashSet<_>>()
        .len();
    let transcript_count = transcript.len();
    Ok(json!({
        "id": meeting.get::<Uuid, _>("id"), "channel_id": meeting.get::<Uuid, _>("room_id"),
        "channel_name": meeting.get::<String, _>("channel_name"),
        "channel_kind": meeting.get::<String, _>("channel_kind"),
        "title": meeting.get::<String, _>("title"), "status": meeting.get::<String, _>("status"),
        "summary_status": meeting.get::<String, _>("summary_status"),
        "summary": meeting.get::<String, _>("summary"), "decisions": meeting.get::<String, _>("decisions"),
        "started_at": meeting.get::<DateTime<Utc>, _>("started_at"),
        "ended_at": meeting.get::<Option<DateTime<Utc>>, _>("ended_at"),
        "created_at": meeting.get::<DateTime<Utc>, _>("created_at"),
        "updated_at": meeting.get::<DateTime<Utc>, _>("updated_at"),
        "participant_count": participant_count, "transcript_count": transcript_count,
        "attendance": attendance, "transcript": transcript, "actions": actions
    }))
}

pub(crate) fn queue_summary(state: SharedState, meeting_id: Uuid) {
    tokio::spawn(async move {
        // Different participant sockets are handled concurrently. Give any phrase
        // accepted immediately before the final leave time to finish its DB write.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Err(error) = generate_summary(&state, meeting_id).await {
            tracing::warn!("meeting {} summary failed: {}", meeting_id, error);
            let _ = sqlx::query(
                "UPDATE meetings SET summary_status = 'failed', updated_at = now()
                  WHERE id = $1 AND summary_status = 'pending'",
            )
            .bind(meeting_id)
            .execute(&state.pool)
            .await;
        }
    });
}

async fn generate_summary(state: &SharedState, meeting_id: Uuid) -> anyhow::Result<()> {
    let config = state.config.deepseek.as_ref().ok_or_else(|| anyhow::anyhow!("AI unavailable"))?;
    let rows = sqlx::query(
        "SELECT display_name, text, spoken_at FROM meeting_transcript_phrases
          WHERE meeting_id = $1 ORDER BY spoken_at, id",
    )
    .bind(meeting_id)
    .fetch_all(&state.pool)
    .await?;
    let transcript = rows
        .iter()
        .map(|row| {
            let at: DateTime<Utc> = row.get("spoken_at");
            format!("[{}] {}: {}", at.format("%H:%M:%S"), row.get::<String, _>("display_name"), row.get::<String, _>("text"))
        })
        .collect::<Vec<_>>();
    let notes = deepseek::summarize_meeting(config, &transcript).await?;
    let attendees = sqlx::query(
        "SELECT DISTINCT user_id, display_name FROM meeting_attendance
          WHERE meeting_id = $1 AND user_id IS NOT NULL",
    )
    .bind(meeting_id)
    .fetch_all(&state.pool)
    .await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM meeting_action_items WHERE meeting_id = $1")
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;
    for (position, action) in notes.actions.iter().enumerate() {
        let assignee = action.assignee.as_ref().and_then(|name| {
            attendees.iter().find(|row| row.get::<String, _>("display_name").eq_ignore_ascii_case(name)).map(|row| row.get::<Uuid, _>("user_id"))
        });
        sqlx::query(
            "INSERT INTO meeting_action_items
                (meeting_id, text, assignee_user_id, completed, position)
             VALUES ($1, $2, $3, false, $4)",
        )
        .bind(meeting_id)
        .bind(action.text.trim())
        .bind(assignee)
        .bind(position as i32)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE meetings SET summary = $2, decisions = $3, summary_status = 'ready',
                updated_at = now() WHERE id = $1",
    )
    .bind(meeting_id)
    .bind(notes.summary)
    .bind(notes.decisions.join("\n"))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let room_id: Uuid = sqlx::query_scalar(
        "SELECT COALESCE(channel_id, standalone_call_id) FROM meetings WHERE id = $1",
    )
        .bind(meeting_id)
        .fetch_one(&state.pool)
        .await?;
    let targets = crate::ws::voice::voice_targets(state, room_id, &[]).await;
    state
        .hub
        .broadcast(
            envelope(
                "meeting.summary_ready",
                json!({ "meeting_id": meeting_id, "channel_id": room_id }),
            ),
            targets,
        )
        .await;
    Ok(())
}
