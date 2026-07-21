use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::{
    MessageUser, Project, Task, TaskActivity, TaskComment, TaskDetail, TaskGithubLink, TaskLabel,
    TaskState,
};
use crate::state::SharedState;
use crate::ws::envelope;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

pub const PALETTE_KEYS: [&str; 8] = [
    "gray", "blue", "green", "yellow", "orange", "red", "purple", "pink",
];

/// Default workflow seeded into every new project. Types are fixed; names/colors cosmetic.
const SEED_STATES: [(&str, &str, &str); 6] = [
    ("Backlog", "gray", "backlog"),
    ("Todo", "gray", "unstarted"),
    ("In Progress", "blue", "started"),
    ("In Review", "purple", "started"),
    ("Done", "green", "completed"),
    ("Canceled", "red", "canceled"),
];

// ---------- fanout ----------

/// Tasks are workspace-visible: every registered user receives task events.
async fn all_user_ids(pool: &PgPool) -> AppResult<Vec<Uuid>> {
    let rows = sqlx::query("SELECT id FROM users").fetch_all(pool).await?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        ids.push(row.try_get::<Uuid, _>("id")?);
    }
    Ok(ids)
}

pub async fn broadcast_all(
    state: &SharedState,
    event_type: &str,
    payload: serde_json::Value,
) -> AppResult<()> {
    let targets = all_user_ids(&state.pool).await?;
    state
        .hub
        .broadcast(envelope(event_type, payload), targets)
        .await;
    Ok(())
}

// ---------- fractional index (mirror of web/src/lib/fracIndex.ts, upper end open) ----------

const FRAC_DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn frac_val(c: u8) -> usize {
    FRAC_DIGITS.iter().position(|d| *d == c).unwrap_or(0)
}

/// A key sorting strictly after `last` — `between(last, null)` from the web helper.
fn append_index(last: Option<&str>) -> String {
    let lo = last.unwrap_or("").as_bytes();
    let mut out = String::new();
    let mut i = 0;
    loop {
        let x = if i < lo.len() { frac_val(lo[i]) } else { 0 };
        if 62 - x > 1 {
            out.push(FRAC_DIGITS[x + (62 - x) / 2] as char);
            return out;
        }
        out.push(FRAC_DIGITS[x] as char);
        i += 1;
    }
}

// ---------- loading ----------

async fn project_states(pool: &PgPool, project_ids: &[Uuid]) -> AppResult<Vec<TaskState>> {
    let rows = sqlx::query(
        "SELECT id, project_id, name, color, type, position FROM task_states
         WHERE project_id = ANY($1) ORDER BY position",
    )
    .bind(project_ids)
    .fetch_all(pool)
    .await?;
    let mut states = Vec::with_capacity(rows.len());
    for row in rows {
        states.push(TaskState {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            name: row.try_get("name")?,
            color: row.try_get("color")?,
            state_type: row.try_get("type")?,
            position: row.try_get("position")?,
        });
    }
    Ok(states)
}

async fn load_projects_where(pool: &PgPool, ids: Option<&[Uuid]>) -> AppResult<Vec<Project>> {
    let base = "SELECT p.id, p.key, p.name, p.icon, p.channel_id, p.created_by, p.archived_at,
                p.created_at,
                (SELECT count(*) FROM tasks t JOIN task_states s ON s.id = t.state_id
                 WHERE t.project_id = p.id AND t.deleted_at IS NULL
                   AND s.type NOT IN ('completed','canceled')) AS open_count
                FROM projects p";
    let rows = match ids {
        Some(ids) => {
            sqlx::query(&format!("{base} WHERE p.id = ANY($1) ORDER BY p.created_at"))
                .bind(ids)
                .fetch_all(pool)
                .await?
        }
        None => {
            sqlx::query(&format!("{base} ORDER BY p.created_at"))
                .fetch_all(pool)
                .await?
        }
    };
    let mut projects = Vec::with_capacity(rows.len());
    let mut project_ids = Vec::with_capacity(rows.len());
    for row in &rows {
        project_ids.push(row.try_get::<Uuid, _>("id")?);
    }
    let mut states_by_project: HashMap<Uuid, Vec<TaskState>> = HashMap::new();
    for state in project_states(pool, &project_ids).await? {
        states_by_project
            .entry(state.project_id)
            .or_default()
            .push(state);
    }
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        projects.push(Project {
            id,
            key: row.try_get("key")?,
            name: row.try_get("name")?,
            icon: row.try_get("icon")?,
            channel_id: row.try_get("channel_id")?,
            created_by: row.try_get("created_by")?,
            archived_at: row.try_get("archived_at")?,
            created_at: row.try_get("created_at")?,
            states: states_by_project.remove(&id).unwrap_or_default(),
            open_count: row.try_get("open_count")?,
        });
    }
    Ok(projects)
}

pub async fn load_project(pool: &PgPool, id: Uuid) -> AppResult<Project> {
    load_projects_where(pool, Some(&[id]))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("project not found".to_string()))
}

/// Batch-load tasks (labels + github links included) preserving no particular order;
/// callers sort. Soft-deleted tasks are included only when explicitly listed by id.
pub async fn load_tasks(pool: &PgPool, ids: &[Uuid]) -> AppResult<Vec<Task>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT t.id, t.project_id, t.number, p.key, t.title, t.description, t.state_id,
                t.priority, t.assignee_id, t.creator_id, t.parent_id, t.due_date, t.sort_order,
                t.source_message_id, t.created_at, t.updated_at, t.completed_at,
                (SELECT count(*) FROM task_comments c
                 WHERE c.task_id = t.id AND c.deleted_at IS NULL) AS comment_count,
                (SELECT count(*) FROM tasks s
                 WHERE s.parent_id = t.id AND s.deleted_at IS NULL) AS sub_count
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;

    let mut labels_by_task: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let label_rows = sqlx::query(
        "SELECT task_id, label_id FROM task_label_assignments WHERE task_id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    for row in label_rows {
        labels_by_task
            .entry(row.try_get("task_id")?)
            .or_default()
            .push(row.try_get("label_id")?);
    }

    let mut links_by_task: HashMap<Uuid, Vec<TaskGithubLink>> = HashMap::new();
    let link_rows = sqlx::query(
        "SELECT id, task_id, kind, repo, ref, url, title, state, created_at
         FROM task_github_links WHERE task_id = ANY($1) ORDER BY created_at",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    for row in link_rows {
        let task_id: Uuid = row.try_get("task_id")?;
        links_by_task.entry(task_id).or_default().push(TaskGithubLink {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            repo: row.try_get("repo")?,
            git_ref: row.try_get("ref")?,
            url: row.try_get("url")?,
            title: row.try_get("title")?,
            state: row.try_get("state")?,
            created_at: row.try_get("created_at")?,
        });
    }

    let mut tasks = Vec::with_capacity(rows.len());
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let key: String = row.try_get("key")?;
        let number: i64 = row.try_get("number")?;
        tasks.push(Task {
            id,
            project_id: row.try_get("project_id")?,
            number,
            identifier: format!("{key}-{number}"),
            title: row.try_get("title")?,
            description: row.try_get("description")?,
            state_id: row.try_get("state_id")?,
            priority: row.try_get("priority")?,
            assignee_id: row.try_get("assignee_id")?,
            creator_id: row.try_get("creator_id")?,
            parent_id: row.try_get("parent_id")?,
            due_date: row.try_get("due_date")?,
            sort_order: row.try_get("sort_order")?,
            source_message_id: row.try_get("source_message_id")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            completed_at: row.try_get("completed_at")?,
            label_ids: labels_by_task.remove(&id).unwrap_or_default(),
            github_links: links_by_task.remove(&id).unwrap_or_default(),
            comment_count: row.try_get("comment_count")?,
            sub_count: row.try_get("sub_count")?,
        });
    }
    Ok(tasks)
}

pub async fn load_task(pool: &PgPool, id: Uuid) -> AppResult<Task> {
    load_tasks(pool, &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("task not found".to_string()))
}

async fn load_comment(pool: &PgPool, id: Uuid) -> AppResult<TaskComment> {
    let row = sqlx::query(
        "SELECT c.id, c.task_id, c.body, c.created_at, c.updated_at, c.deleted_at,
                u.id AS author_id, u.display_name, u.avatar_url
         FROM task_comments c JOIN users u ON u.id = c.author_id WHERE c.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("comment not found".to_string()))?;
    comment_from_row(&row)
}

fn comment_from_row(row: &sqlx::postgres::PgRow) -> AppResult<TaskComment> {
    let deleted = row
        .try_get::<Option<DateTime<Utc>>, _>("deleted_at")?
        .is_some();
    Ok(TaskComment {
        id: row.try_get("id")?,
        task_id: row.try_get("task_id")?,
        author: MessageUser {
            id: row.try_get("author_id")?,
            display_name: row.try_get("display_name")?,
            avatar_url: row.try_get("avatar_url")?,
        },
        body: if deleted {
            String::new()
        } else {
            row.try_get("body")?
        },
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        deleted,
    })
}

// ---------- activity ----------

pub async fn record_activity(
    pool: &PgPool,
    task_id: Uuid,
    actor_id: Option<Uuid>,
    kind: &str,
    payload: serde_json::Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO task_activity (task_id, actor_id, kind, payload) VALUES ($1, $2, $3, $4)",
    )
    .bind(task_id)
    .bind(actor_id)
    .bind(kind)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

// ---------- projects ----------

#[derive(Deserialize)]
pub struct CreateProjectRequest {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    pub channel_id: Option<Uuid>,
}

fn validate_key(key: &str) -> AppResult<String> {
    let key = key.trim().to_uppercase();
    let valid = (2..=6).contains(&key.len())
        && key.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !valid {
        return Err(AppError::Validation(
            "key must be 2-6 characters A-Z0-9 starting with a letter".to_string(),
        ));
    }
    Ok(key)
}

fn validate_name(name: &str, what: &str, max: usize) -> AppResult<String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{what} must be between 1 and {max} characters"
        )));
    }
    Ok(name)
}

pub async fn list_projects(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let projects = load_projects_where(&state.pool, None).await?;
    Ok(Json(json!({ "projects": projects })))
}

pub async fn create_project(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<CreateProjectRequest>,
) -> AppResult<(StatusCode, Json<Project>)> {
    let key = validate_key(&body.key)?;
    let name = validate_name(&body.name, "name", 100)?;
    if body.icon.chars().count() > 16 {
        return Err(AppError::Validation("icon too long".to_string()));
    }
    let mut tx = state.pool.begin().await?;
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM projects WHERE key = $1")
        .bind(&key)
        .fetch_optional(&mut *tx)
        .await?;
    if existing.is_some() {
        return Err(AppError::Validation("key already in use".to_string()));
    }
    let project_id: Uuid = sqlx::query_scalar(
        "INSERT INTO projects (key, name, icon, channel_id, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(&key)
    .bind(&name)
    .bind(&body.icon)
    .bind(body.channel_id)
    .bind(auth.id)
    .fetch_one(&mut *tx)
    .await?;
    for (position, (state_name, color, state_type)) in SEED_STATES.iter().enumerate() {
        sqlx::query(
            "INSERT INTO task_states (project_id, name, color, type, position)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(project_id)
        .bind(state_name)
        .bind(color)
        .bind(state_type)
        .bind(position as i32)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let project = load_project(&state.pool, project_id).await?;
    broadcast_all(&state, "project.created", json!({ "project": project })).await?;
    Ok((StatusCode::CREATED, Json(project)))
}

#[derive(Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub channel_id: Option<Option<Uuid>>,
    pub archived: Option<bool>,
}

pub async fn update_project(
    State(state): State<SharedState>,
    Path(project_id): Path<Uuid>,
    _auth: AuthUser,
    Json(body): Json<UpdateProjectRequest>,
) -> AppResult<Json<Project>> {
    load_project(&state.pool, project_id).await?;
    if let Some(name) = &body.name {
        let name = validate_name(name, "name", 100)?;
        sqlx::query("UPDATE projects SET name = $2 WHERE id = $1")
            .bind(project_id)
            .bind(name)
            .execute(&state.pool)
            .await?;
    }
    if let Some(icon) = &body.icon {
        if icon.chars().count() > 16 {
            return Err(AppError::Validation("icon too long".to_string()));
        }
        sqlx::query("UPDATE projects SET icon = $2 WHERE id = $1")
            .bind(project_id)
            .bind(icon)
            .execute(&state.pool)
            .await?;
    }
    if let Some(channel_id) = body.channel_id {
        sqlx::query("UPDATE projects SET channel_id = $2 WHERE id = $1")
            .bind(project_id)
            .bind(channel_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(archived) = body.archived {
        sqlx::query(
            "UPDATE projects SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now())
             ELSE NULL END WHERE id = $1",
        )
        .bind(project_id)
        .bind(archived)
        .execute(&state.pool)
        .await?;
    }
    let project = load_project(&state.pool, project_id).await?;
    broadcast_all(&state, "project.updated", json!({ "project": project })).await?;
    Ok(Json(project))
}

// ---------- tasks ----------

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub state_id: Option<Uuid>,
    pub priority: Option<i16>,
    pub assignee_id: Option<Uuid>,
    #[serde(default)]
    pub label_ids: Vec<Uuid>,
    pub due_date: Option<NaiveDate>,
    pub parent_id: Option<Uuid>,
    /// String-bigint (message ids are serialized as strings on the wire).
    pub source_message_id: Option<String>,
}

fn validate_priority(priority: i16) -> AppResult<i16> {
    if !(0..=4).contains(&priority) {
        return Err(AppError::Validation("priority must be 0-4".to_string()));
    }
    Ok(priority)
}

fn validate_description(description: &str) -> AppResult<()> {
    if description.chars().count() > 20_000 {
        return Err(AppError::Validation("description too long".to_string()));
    }
    Ok(())
}

/// The state a new task lands in: first `unstarted`, else first by position.
async fn default_state(pool: &PgPool, project_id: Uuid) -> AppResult<Uuid> {
    let row = sqlx::query(
        "SELECT id FROM task_states WHERE project_id = $1
         ORDER BY (type <> 'unstarted'), position LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("project has no states".to_string()))?;
    Ok(row.try_get("id")?)
}

async fn state_in_project(pool: &PgPool, state_id: Uuid, project_id: Uuid) -> AppResult<String> {
    let row = sqlx::query("SELECT type FROM task_states WHERE id = $1 AND project_id = $2")
        .bind(state_id)
        .bind(project_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::BadRequest("state does not belong to project".to_string()))?;
    Ok(row.try_get("type")?)
}

async fn last_sort_order(pool: &PgPool, state_id: Uuid) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT max(sort_order) FROM tasks WHERE state_id = $1 AND deleted_at IS NULL",
    )
    .bind(state_id)
    .fetch_one(pool)
    .await?)
}

async fn validate_parent(pool: &PgPool, parent_id: Uuid, project_id: Uuid) -> AppResult<()> {
    let row = sqlx::query(
        "SELECT project_id, parent_id FROM tasks WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::BadRequest("parent task not found".to_string()))?;
    if row.try_get::<Uuid, _>("project_id")? != project_id {
        return Err(AppError::BadRequest(
            "parent must be in the same project".to_string(),
        ));
    }
    if row.try_get::<Option<Uuid>, _>("parent_id")?.is_some() {
        // Same rule as message threads: replies to replies are not allowed.
        return Err(AppError::BadRequest(
            "sub-tasks are one level deep".to_string(),
        ));
    }
    Ok(())
}

async fn replace_labels(pool: &PgPool, task_id: Uuid, label_ids: &[Uuid]) -> AppResult<()> {
    if !label_ids.is_empty() {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM task_labels WHERE id = ANY($1)")
                .bind(label_ids)
                .fetch_one(pool)
                .await?;
        if count != label_ids.len() as i64 {
            return Err(AppError::BadRequest("unknown label".to_string()));
        }
    }
    sqlx::query("DELETE FROM task_label_assignments WHERE task_id = $1")
        .bind(task_id)
        .execute(pool)
        .await?;
    for label_id in label_ids {
        sqlx::query(
            "INSERT INTO task_label_assignments (task_id, label_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(task_id)
        .bind(label_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn create_task_shared(
    state: &SharedState,
    project_id: Uuid,
    creator_id: Uuid,
    body: &CreateTaskRequest,
) -> AppResult<Task> {
    load_project(&state.pool, project_id).await?;
    let title = validate_name(&body.title, "title", 500)?;
    validate_description(&body.description)?;
    let priority = validate_priority(body.priority.unwrap_or(0))?;
    let state_id = match body.state_id {
        Some(id) => {
            state_in_project(&state.pool, id, project_id).await?;
            id
        }
        None => default_state(&state.pool, project_id).await?,
    };
    if let Some(parent_id) = body.parent_id {
        validate_parent(&state.pool, parent_id, project_id).await?;
    }
    let state_type = state_in_project(&state.pool, state_id, project_id).await?;
    let source_message_id: Option<i64> = match &body.source_message_id {
        Some(raw) => Some(
            raw.parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid source_message_id".to_string()))?,
        ),
        None => None,
    };
    let last = last_sort_order(&state.pool, state_id).await?;
    let sort_order = append_index(last.as_deref());

    let mut tx = state.pool.begin().await?;
    let number: i64 = sqlx::query_scalar(
        "UPDATE projects SET next_number = next_number + 1 WHERE id = $1
         RETURNING next_number - 1",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;
    let task_id: Uuid = sqlx::query_scalar(
        "INSERT INTO tasks (project_id, number, title, description, state_id, priority,
                            assignee_id, creator_id, parent_id, due_date, sort_order,
                            source_message_id, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $13 THEN now() END)
         RETURNING id",
    )
    .bind(project_id)
    .bind(number)
    .bind(&title)
    .bind(&body.description)
    .bind(state_id)
    .bind(priority)
    .bind(body.assignee_id)
    .bind(creator_id)
    .bind(body.parent_id)
    .bind(body.due_date)
    .bind(&sort_order)
    .bind(source_message_id)
    .bind(state_type == "completed")
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    replace_labels(&state.pool, task_id, &body.label_ids).await?;
    record_activity(&state.pool, task_id, Some(creator_id), "created", json!({})).await?;
    let task = load_task(&state.pool, task_id).await?;
    broadcast_all(state, "task.created", json!({ "task": task })).await?;
    crate::notify::dispatch_task_assigned(state, &task, creator_id).await;
    Ok(task)
}

pub async fn create_task(
    State(state): State<SharedState>,
    Path(project_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CreateTaskRequest>,
) -> AppResult<(StatusCode, Json<Task>)> {
    let task = create_task_shared(&state, project_id, auth.id, &body).await?;
    Ok((StatusCode::CREATED, Json(task)))
}

#[derive(Deserialize)]
pub struct ListTasksQuery {
    pub state_type: Option<String>,
    pub assignee: Option<Uuid>,
    pub label: Option<Uuid>,
    pub priority: Option<i16>,
    pub q: Option<String>,
}

pub async fn list_tasks(
    State(state): State<SharedState>,
    Path(project_id): Path<Uuid>,
    _auth: AuthUser,
    Query(query): Query<ListTasksQuery>,
) -> AppResult<Json<serde_json::Value>> {
    load_project(&state.pool, project_id).await?;
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT t.id FROM tasks t
         JOIN task_states s ON s.id = t.state_id
         WHERE t.project_id = $1 AND t.deleted_at IS NULL
           AND ($2::text IS NULL OR s.type = $2)
           AND ($3::uuid IS NULL OR t.assignee_id = $3)
           AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM task_label_assignments a
                WHERE a.task_id = t.id AND a.label_id = $4))
           AND ($5::smallint IS NULL OR t.priority = $5)
           AND ($6::text IS NULL OR t.title ILIKE '%' || $6 || '%')
         ORDER BY t.sort_order, t.id",
    )
    .bind(project_id)
    .bind(query.state_type)
    .bind(query.assignee)
    .bind(query.label)
    .bind(query.priority)
    .bind(query.q)
    .fetch_all(&state.pool)
    .await?;
    let mut tasks = load_tasks(&state.pool, &ids).await?;
    let order: HashMap<Uuid, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    tasks.sort_by_key(|task| order.get(&task.id).copied().unwrap_or(usize::MAX));
    Ok(Json(json!({ "tasks": tasks })))
}

async fn task_detail(pool: &PgPool, task_id: Uuid) -> AppResult<TaskDetail> {
    let task = load_task(pool, task_id).await?;
    let comment_rows = sqlx::query(
        "SELECT c.id, c.task_id, c.body, c.created_at, c.updated_at, c.deleted_at,
                u.id AS author_id, u.display_name, u.avatar_url
         FROM task_comments c JOIN users u ON u.id = c.author_id
         WHERE c.task_id = $1 ORDER BY c.created_at",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    let mut comments = Vec::with_capacity(comment_rows.len());
    for row in &comment_rows {
        comments.push(comment_from_row(row)?);
    }
    let activity_rows = sqlx::query(
        "SELECT a.id, a.task_id, a.kind, a.payload, a.created_at,
                u.id AS actor_id, u.display_name, u.avatar_url
         FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.task_id = $1 ORDER BY a.id",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    let mut activity = Vec::with_capacity(activity_rows.len());
    for row in activity_rows {
        let actor = match row.try_get::<Option<Uuid>, _>("actor_id")? {
            Some(id) => Some(MessageUser {
                id,
                display_name: row.try_get("display_name")?,
                avatar_url: row.try_get("avatar_url")?,
            }),
            None => None,
        };
        activity.push(TaskActivity {
            id: row.try_get("id")?,
            task_id: row.try_get("task_id")?,
            actor,
            kind: row.try_get("kind")?,
            payload: row.try_get("payload")?,
            created_at: row.try_get("created_at")?,
        });
    }
    let sub_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM tasks WHERE parent_id = $1 AND deleted_at IS NULL
         ORDER BY sort_order, id",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    let sub_tasks = load_tasks(pool, &sub_ids).await?;
    Ok(TaskDetail {
        task,
        comments,
        activity,
        sub_tasks,
    })
}

pub async fn get_task(
    State(state): State<SharedState>,
    Path(task_id): Path<Uuid>,
    _auth: AuthUser,
) -> AppResult<Json<TaskDetail>> {
    Ok(Json(task_detail(&state.pool, task_id).await?))
}

pub async fn get_task_by_key(
    State(state): State<SharedState>,
    Path(identifier): Path<String>,
    _auth: AuthUser,
) -> AppResult<Json<Task>> {
    let (key, number) = identifier
        .rsplit_once('-')
        .and_then(|(key, num)| num.parse::<i64>().ok().map(|n| (key.to_uppercase(), n)))
        .ok_or_else(|| AppError::BadRequest("malformed identifier".to_string()))?;
    let task_id: Uuid = sqlx::query_scalar(
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.key = $1 AND t.number = $2 AND t.deleted_at IS NULL",
    )
    .bind(&key)
    .bind(number)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("task not found".to_string()))?;
    Ok(Json(load_task(&state.pool, task_id).await?))
}

#[derive(Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub state_id: Option<Uuid>,
    pub priority: Option<i16>,
    #[serde(default)]
    pub assignee_id: Option<Option<Uuid>>,
    pub label_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub due_date: Option<Option<NaiveDate>>,
    #[serde(default)]
    pub parent_id: Option<Option<Uuid>>,
    pub sort_order: Option<String>,
}

/// Move a task to a state, stamping/clearing completed_at from the state's type and
/// recording activity. Shared by PATCH and GitHub automation.
pub async fn apply_state_change(
    state: &SharedState,
    task: &Task,
    new_state_id: Uuid,
    actor_id: Option<Uuid>,
) -> AppResult<()> {
    if task.state_id == new_state_id {
        return Ok(());
    }
    let state_type = state_in_project(&state.pool, new_state_id, task.project_id).await?;
    let last = last_sort_order(&state.pool, new_state_id).await?;
    sqlx::query(
        "UPDATE tasks SET state_id = $2, sort_order = $3, updated_at = now(),
                completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) END
         WHERE id = $1",
    )
    .bind(task.id)
    .bind(new_state_id)
    .bind(append_index(last.as_deref()))
    .bind(state_type == "completed")
    .execute(&state.pool)
    .await?;
    record_activity(
        &state.pool,
        task.id,
        actor_id,
        "state",
        json!({ "from": task.state_id, "to": new_state_id }),
    )
    .await?;
    Ok(())
}

pub async fn update_task(
    State(state): State<SharedState>,
    Path(task_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<UpdateTaskRequest>,
) -> AppResult<Json<Task>> {
    let current = load_task(&state.pool, task_id).await?;
    let pool = &state.pool;

    if let Some(title) = &body.title {
        let title = validate_name(title, "title", 500)?;
        if title != current.title {
            sqlx::query("UPDATE tasks SET title = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(&title)
                .execute(pool)
                .await?;
            record_activity(
                pool,
                task_id,
                Some(auth.id),
                "title",
                json!({ "from": current.title, "to": title }),
            )
            .await?;
        }
    }
    if let Some(description) = &body.description {
        validate_description(description)?;
        if *description != current.description {
            sqlx::query("UPDATE tasks SET description = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(description)
                .execute(pool)
                .await?;
            record_activity(pool, task_id, Some(auth.id), "description", json!({})).await?;
        }
    }
    // State first, sort_order after: a drag that changes column sends both, and the
    // explicit drop position must override the state change's append-to-bottom default.
    if let Some(state_id) = body.state_id {
        apply_state_change(&state, &current, state_id, Some(auth.id)).await?;
    }
    if let Some(sort_order) = &body.sort_order {
        if sort_order.is_empty() || sort_order.len() > 128 {
            return Err(AppError::Validation("bad sort_order".to_string()));
        }
        sqlx::query("UPDATE tasks SET sort_order = $2, updated_at = now() WHERE id = $1")
            .bind(task_id)
            .bind(sort_order)
            .execute(pool)
            .await?;
    }
    if let Some(priority) = body.priority {
        let priority = validate_priority(priority)?;
        if priority != current.priority {
            sqlx::query("UPDATE tasks SET priority = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(priority)
                .execute(pool)
                .await?;
            record_activity(
                pool,
                task_id,
                Some(auth.id),
                "priority",
                json!({ "from": current.priority, "to": priority }),
            )
            .await?;
        }
    }
    let mut assignee_changed = false;
    if let Some(assignee_id) = body.assignee_id {
        if assignee_id != current.assignee_id {
            assignee_changed = true;
            if let Some(user_id) = assignee_id {
                let exists: Option<Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                        .bind(user_id)
                        .fetch_optional(pool)
                        .await?;
                if exists.is_none() {
                    return Err(AppError::BadRequest("unknown assignee".to_string()));
                }
            }
            sqlx::query("UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(assignee_id)
                .execute(pool)
                .await?;
            record_activity(
                pool,
                task_id,
                Some(auth.id),
                "assignee",
                json!({ "from": current.assignee_id, "to": assignee_id }),
            )
            .await?;
        }
    }
    if let Some(label_ids) = &body.label_ids {
        if *label_ids != current.label_ids {
            replace_labels(pool, task_id, label_ids).await?;
            record_activity(
                pool,
                task_id,
                Some(auth.id),
                "labels",
                json!({ "from": current.label_ids, "to": label_ids }),
            )
            .await?;
            sqlx::query("UPDATE tasks SET updated_at = now() WHERE id = $1")
                .bind(task_id)
                .execute(pool)
                .await?;
        }
    }
    if let Some(due_date) = body.due_date {
        if due_date != current.due_date {
            sqlx::query("UPDATE tasks SET due_date = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(due_date)
                .execute(pool)
                .await?;
            record_activity(
                pool,
                task_id,
                Some(auth.id),
                "due",
                json!({ "from": current.due_date, "to": due_date }),
            )
            .await?;
        }
    }
    if let Some(parent_id) = body.parent_id {
        if parent_id != current.parent_id {
            if let Some(parent) = parent_id {
                if parent == task_id {
                    return Err(AppError::BadRequest(
                        "task cannot be its own parent".to_string(),
                    ));
                }
                if current.sub_count > 0 {
                    return Err(AppError::BadRequest(
                        "sub-tasks are one level deep".to_string(),
                    ));
                }
                validate_parent(pool, parent, current.project_id).await?;
            }
            sqlx::query("UPDATE tasks SET parent_id = $2, updated_at = now() WHERE id = $1")
                .bind(task_id)
                .bind(parent_id)
                .execute(pool)
                .await?;
        }
    }

    let task = load_task(pool, task_id).await?;
    broadcast_all(&state, "task.updated", json!({ "task": task })).await?;
    if assignee_changed {
        crate::notify::dispatch_task_assigned(&state, &task, auth.id).await;
    }
    Ok(Json(task))
}

pub async fn delete_task(
    State(state): State<SharedState>,
    Path(task_id): Path<Uuid>,
    _auth: AuthUser,
) -> AppResult<StatusCode> {
    let task = load_task(&state.pool, task_id).await?;
    sqlx::query("UPDATE tasks SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1")
        .bind(task_id)
        .execute(&state.pool)
        .await?;
    // Soft delete keeps the row, so the Sharpy embedding must go explicitly.
    sqlx::query("DELETE FROM task_embeddings WHERE task_id = $1")
        .bind(task_id)
        .execute(&state.pool)
        .await?;
    broadcast_all(
        &state,
        "task.deleted",
        json!({ "task_id": task_id, "project_id": task.project_id }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn my_tasks(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT t.id FROM tasks t JOIN task_states s ON s.id = t.state_id
         WHERE t.assignee_id = $1 AND t.deleted_at IS NULL
           AND s.type NOT IN ('completed','canceled')
         ORDER BY (t.priority = 0), t.priority, t.updated_at DESC",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;
    let mut tasks = load_tasks(&state.pool, &ids).await?;
    let order: HashMap<Uuid, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    tasks.sort_by_key(|task| order.get(&task.id).copied().unwrap_or(usize::MAX));
    Ok(Json(json!({ "tasks": tasks })))
}

#[derive(Deserialize)]
pub struct SearchTasksQuery {
    pub q: String,
    pub limit: Option<i64>,
}

pub async fn search_tasks(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Query(query): Query<SearchTasksQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let q = query.q.trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!({ "tasks": [] })));
    }
    let limit = query.limit.unwrap_or(10).clamp(1, 50);
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL
           AND ((p.key || '-' || t.number) ILIKE $1 || '%' OR t.title ILIKE '%' || $1 || '%')
         ORDER BY t.updated_at DESC LIMIT $2",
    )
    .bind(&q)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    let mut tasks = load_tasks(&state.pool, &ids).await?;
    let order: HashMap<Uuid, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    tasks.sort_by_key(|task| order.get(&task.id).copied().unwrap_or(usize::MAX));
    Ok(Json(json!({ "tasks": tasks })))
}

// ---------- comments ----------

#[derive(Deserialize)]
pub struct CommentRequest {
    pub body: String,
}

fn validate_comment(body: &str) -> AppResult<String> {
    let body = body.trim().to_string();
    if body.is_empty() || body.chars().count() > 10_000 {
        return Err(AppError::Validation(
            "comment must be between 1 and 10000 characters".to_string(),
        ));
    }
    Ok(body)
}

pub async fn create_comment(
    State(state): State<SharedState>,
    Path(task_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CommentRequest>,
) -> AppResult<(StatusCode, Json<TaskComment>)> {
    load_task(&state.pool, task_id).await?;
    let text = validate_comment(&body.body)?;
    let comment_id: Uuid = sqlx::query_scalar(
        "INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(task_id)
    .bind(auth.id)
    .bind(&text)
    .fetch_one(&state.pool)
    .await?;
    let comment = load_comment(&state.pool, comment_id).await?;
    broadcast_all(&state, "task.comment.created", json!({ "comment": comment })).await?;
    let task = load_task(&state.pool, task_id).await?;
    crate::notify::dispatch_task_comment(&state, &task, auth.id, &text).await;
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn require_comment_author(pool: &PgPool, comment_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let author: Option<Uuid> =
        sqlx::query_scalar("SELECT author_id FROM task_comments WHERE id = $1")
            .bind(comment_id)
            .fetch_optional(pool)
            .await?;
    match author {
        None => Err(AppError::NotFound("comment not found".to_string())),
        Some(author) if author != user_id => {
            Err(AppError::Forbidden("comment author required".to_string()))
        }
        _ => Ok(()),
    }
}

pub async fn update_comment(
    State(state): State<SharedState>,
    Path(comment_id): Path<Uuid>,
    auth: AuthUser,
    Json(body): Json<CommentRequest>,
) -> AppResult<Json<TaskComment>> {
    require_comment_author(&state.pool, comment_id, auth.id).await?;
    let text = validate_comment(&body.body)?;
    sqlx::query(
        "UPDATE task_comments SET body = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(comment_id)
    .bind(&text)
    .execute(&state.pool)
    .await?;
    let comment = load_comment(&state.pool, comment_id).await?;
    broadcast_all(&state, "task.comment.updated", json!({ "comment": comment })).await?;
    Ok(Json(comment))
}

pub async fn delete_comment(
    State(state): State<SharedState>,
    Path(comment_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    require_comment_author(&state.pool, comment_id, auth.id).await?;
    sqlx::query(
        "UPDATE task_comments SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1",
    )
    .bind(comment_id)
    .execute(&state.pool)
    .await?;
    let comment = load_comment(&state.pool, comment_id).await?;
    broadcast_all(&state, "task.comment.deleted", json!({ "comment": comment })).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- labels ----------

#[derive(Deserialize)]
pub struct LabelRequest {
    pub name: String,
    pub color: String,
}

fn validate_color(color: &str) -> AppResult<String> {
    if !PALETTE_KEYS.contains(&color) {
        return Err(AppError::Validation("unknown color".to_string()));
    }
    Ok(color.to_string())
}

async fn load_labels(pool: &PgPool) -> AppResult<Vec<TaskLabel>> {
    let rows = sqlx::query("SELECT id, name, color FROM task_labels ORDER BY name")
        .fetch_all(pool)
        .await?;
    let mut labels = Vec::with_capacity(rows.len());
    for row in rows {
        labels.push(TaskLabel {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            color: row.try_get("color")?,
        });
    }
    Ok(labels)
}

pub async fn list_labels(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({ "labels": load_labels(&state.pool).await? })))
}

pub async fn create_label(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Json(body): Json<LabelRequest>,
) -> AppResult<(StatusCode, Json<TaskLabel>)> {
    let name = validate_name(&body.name, "name", 50)?;
    let color = validate_color(&body.color)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO task_labels (name, color) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color RETURNING id",
    )
    .bind(&name)
    .bind(&color)
    .fetch_one(&state.pool)
    .await?;
    let label = TaskLabel { id, name, color };
    broadcast_all(&state, "task.labels.changed", json!({})).await?;
    Ok((StatusCode::CREATED, Json(label)))
}

pub async fn update_label(
    State(state): State<SharedState>,
    Path(label_id): Path<Uuid>,
    _auth: AuthUser,
    Json(body): Json<LabelRequest>,
) -> AppResult<Json<TaskLabel>> {
    let name = validate_name(&body.name, "name", 50)?;
    let color = validate_color(&body.color)?;
    let updated = sqlx::query("UPDATE task_labels SET name = $2, color = $3 WHERE id = $1")
        .bind(label_id)
        .bind(&name)
        .bind(&color)
        .execute(&state.pool)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound("label not found".to_string()));
    }
    broadcast_all(&state, "task.labels.changed", json!({})).await?;
    Ok(Json(TaskLabel {
        id: label_id,
        name,
        color,
    }))
}

pub async fn delete_label(
    State(state): State<SharedState>,
    Path(label_id): Path<Uuid>,
    _auth: AuthUser,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM task_labels WHERE id = $1")
        .bind(label_id)
        .execute(&state.pool)
        .await?;
    broadcast_all(&state, "task.labels.changed", json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}
