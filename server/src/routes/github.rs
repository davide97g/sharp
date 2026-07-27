//! GitHub → tasks sync (Phase 7C, per-project links in 7E). One HMAC-verified
//! webhook endpoint. Any task identifier (`KEY-123`) appearing in a branch name,
//! PR title, or PR body links that branch/PR to the task and drives state
//! automation:
//!
//!   - branch created / pushed / PR opened  → backlog|unstarted tasks move to
//!     the project's first `started` state
//!   - PR merged                            → first `completed` state
//!   - PR closed unmerged                   → link state updated, task untouched
//!
//! Two ways a delivery is trusted, checked in this order:
//!
//!   1. **Per-project links** (`project_github_repos`): each row owns a webhook
//!      secret generated here, so connecting a repo needs no env var and no
//!      restart. A delivery is matched against the secrets of every row naming
//!      that repository; matched rows also *scope* automation to their projects'
//!      keys, so a repo only moves tasks of the projects it is linked to.
//!   2. **Env fallback** (`GITHUB_WEBHOOK_SECRET` + optional `GITHUB_REPOS`):
//!      the original global path, kept for deploys already wired that way. It
//!      matches identifiers of *every* project key.
//!
//! Processing is idempotent: links upsert on `(task_id, url)` and state moves
//! no-op when the task is already at/past the target type. Automation writes
//! `task_activity` with a NULL actor and fans out `task.updated` as usual.
//!
//! Outbound calls (verify repo, install webhook) live in `crate::github_api` and
//! only happen for links that carry a PAT; the PAT is sealed at rest with the
//! same AES-256-GCM helper the calendar tokens use.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::Project;
use crate::routes::tasks::{apply_state_change, broadcast_all, load_task, record_activity};
use crate::state::SharedState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::Json;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

fn verify_signature(secret: &str, body: &[u8], signature_header: &str) -> bool {
    let Some(hex_sig) = signature_header.strip_prefix("sha256=") else {
        return false;
    };
    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(body);
    let expected = mac.finalize().into_bytes();
    let expected_hex: String = expected.iter().map(|b| format!("{b:02x}")).collect();
    // Constant-time-ish comparison; both sides are fixed-length hex.
    expected_hex.len() == hex_sig.len()
        && expected_hex
            .bytes()
            .zip(hex_sig.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b.to_ascii_lowercase()))
            == 0
}

/// Scan free text for `KEY-123` identifiers (case-insensitive, word-bounded),
/// keeping only keys that exist in `keys`. No regex crate in this repo — a
/// hand-rolled scanner keeps it that way.
fn extract_identifiers(text: &str, keys: &HashSet<String>) -> Vec<(String, i64)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Word boundary: previous char must not be alphanumeric.
        if i > 0 && bytes[i - 1].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        if !bytes[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && j - i < 6 && bytes[j].is_ascii_alphanumeric() {
            j += 1;
        }
        if j - i < 2 || j >= bytes.len() || bytes[j] != b'-' {
            i += 1;
            continue;
        }
        let mut k = j + 1;
        while k < bytes.len() && bytes[k].is_ascii_digit() {
            k += 1;
        }
        // Trailing boundary: digits must end the token.
        if k == j + 1 || (k < bytes.len() && bytes[k].is_ascii_alphanumeric()) {
            i = j + 1;
            continue;
        }
        let key = text[i..j].to_uppercase();
        if keys.contains(&key) {
            if let Ok(number) = text[j + 1..k].parse::<i64>() {
                out.push((key, number));
            }
        }
        i = k;
    }
    out
}

/// Keys of every project, or of `only` when the delivery came in on a per-project link.
async fn project_keys(pool: &PgPool, only: Option<&[Uuid]>) -> AppResult<HashSet<String>> {
    let rows = match only {
        Some(ids) => {
            sqlx::query("SELECT key FROM projects WHERE id = ANY($1)")
                .bind(ids)
                .fetch_all(pool)
                .await?
        }
        None => sqlx::query("SELECT key FROM projects").fetch_all(pool).await?,
    };
    let mut keys = HashSet::with_capacity(rows.len());
    for row in rows {
        keys.insert(row.try_get::<String, _>("key")?);
    }
    Ok(keys)
}

async fn resolve_task(pool: &PgPool, key: &str, number: i64) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.key = $1 AND t.number = $2 AND t.deleted_at IS NULL",
    )
    .bind(key)
    .bind(number)
    .fetch_optional(pool)
    .await?)
}

/// First state of the given type in the task's project, by position.
async fn first_state_of_type(
    pool: &PgPool,
    project_id: Uuid,
    state_type: &str,
) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM task_states WHERE project_id = $1 AND type = $2
         ORDER BY position LIMIT 1",
    )
    .bind(project_id)
    .bind(state_type)
    .fetch_one(pool)
    .await
    .ok())
}

struct LinkUpsert<'a> {
    repo: &'a str,
    kind: &'a str,  // 'branch' | 'pr'
    git_ref: &'a str,
    url: &'a str,
    title: &'a str,
    state: &'a str, // '' | 'open' | 'draft' | 'merged' | 'closed'
}

/// Upsert the link, run state automation, record activity, broadcast.
async fn link_and_automate(
    state: &SharedState,
    task_id: Uuid,
    link: LinkUpsert<'_>,
    target_type: Option<&str>, // 'started' | 'completed' | None (link only)
) -> AppResult<()> {
    let inserted = sqlx::query(
        "INSERT INTO task_github_links (task_id, repo, kind, ref, url, title, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (task_id, url)
         DO UPDATE SET title = EXCLUDED.title, state = EXCLUDED.state
         RETURNING (xmax = 0) AS inserted",
    )
    .bind(task_id)
    .bind(link.repo)
    .bind(link.kind)
    .bind(link.git_ref)
    .bind(link.url)
    .bind(link.title)
    .bind(link.state)
    .fetch_one(&state.pool)
    .await?;
    if inserted.try_get::<bool, _>("inserted")? {
        record_activity(
            &state.pool,
            task_id,
            None,
            "github_link",
            json!({ "kind": link.kind, "ref": link.git_ref, "repo": link.repo, "url": link.url }),
        )
        .await?;
    }

    let task = load_task(&state.pool, task_id).await?;
    match target_type {
        Some("started") => {
            // Only pull forward: never demote a task that's already in review/done.
            let current_type: String =
                sqlx::query_scalar("SELECT type FROM task_states WHERE id = $1")
                    .bind(task.state_id)
                    .fetch_one(&state.pool)
                    .await?;
            if current_type == "backlog" || current_type == "unstarted" {
                if let Some(target) = first_state_of_type(&state.pool, task.project_id, "started").await? {
                    apply_state_change(state, &task, target, None).await?;
                }
            }
        }
        Some("completed") => {
            let current_type: String =
                sqlx::query_scalar("SELECT type FROM task_states WHERE id = $1")
                    .bind(task.state_id)
                    .fetch_one(&state.pool)
                    .await?;
            if current_type != "completed" && current_type != "canceled" {
                if let Some(target) =
                    first_state_of_type(&state.pool, task.project_id, "completed").await?
                {
                    apply_state_change(state, &task, target, None).await?;
                }
            }
        }
        _ => {}
    }

    let task = load_task(&state.pool, task_id).await?;
    broadcast_all(state, "task.updated", json!({ "task": task })).await?;
    Ok(())
}

fn text<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

/// One `project_github_repos` row, as the webhook path needs it.
struct RepoLink {
    id: Uuid,
    project_id: Uuid,
    secret: String,
    hook_active: bool,
}

async fn links_for_repo(pool: &PgPool, repo: &str) -> AppResult<Vec<RepoLink>> {
    let rows = sqlx::query(
        "SELECT id, project_id, secret, hook_active FROM project_github_repos
         WHERE lower(repo) = lower($1)",
    )
    .bind(repo)
    .fetch_all(pool)
    .await?;
    let mut links = Vec::with_capacity(rows.len());
    for row in rows {
        links.push(RepoLink {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            secret: row.try_get("secret")?,
            hook_active: row.try_get("hook_active")?,
        });
    }
    Ok(links)
}

/// Stamp the delivery on matched links. The first signed delivery flips
/// `hook_active`, which is the "Connected" light in the project panel — so that
/// transition (and only that one) fans out `project.updated`.
async fn record_delivery(state: &SharedState, links: &[RepoLink], event: &str) -> AppResult<()> {
    for link in links {
        sqlx::query(
            "UPDATE project_github_repos
             SET hook_active = true, last_event_at = now(), last_event_kind = $2, last_error = ''
             WHERE id = $1",
        )
        .bind(link.id)
        .bind(event)
        .execute(&state.pool)
        .await?;
        if !link.hook_active {
            let project = crate::routes::tasks::load_project(&state.pool, link.project_id).await?;
            broadcast_all(state, "project.updated", json!({ "project": project })).await?;
        }
    }
    Ok(())
}

pub async fn webhook(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("malformed payload".to_string()))?;
    let repo = text(&payload, "/repository/full_name").to_string();

    // 1. Per-project links: the ones whose own secret signs this body.
    let matched: Vec<RepoLink> = links_for_repo(&state.pool, &repo)
        .await?
        .into_iter()
        .filter(|link| verify_signature(&link.secret, &body, signature))
        .collect();

    let scope: Option<Vec<Uuid>> = if matched.is_empty() {
        // 2. Env fallback, with its allowlist and workspace-wide key scope.
        let Some(github) = &state.config.github else {
            return Err(AppError::Unauthorized("bad webhook signature".to_string()));
        };
        if !verify_signature(&github.webhook_secret, &body, signature) {
            return Err(AppError::Unauthorized("bad webhook signature".to_string()));
        }
        if !github.repos.is_empty() && !github.repos.contains(&repo.to_lowercase()) {
            return Ok(StatusCode::ACCEPTED); // signed but not allowlisted: ignore quietly
        }
        None
    } else {
        record_delivery(&state, &matched, &event).await?;
        Some(matched.iter().map(|link| link.project_id).collect())
    };

    // GitHub sends `ping` when a webhook is created: a signed delivery is all we
    // wanted from it.
    if event == "ping" {
        return Ok(StatusCode::NO_CONTENT);
    }
    if event == "repository" {
        update_visibility(&state, &matched, &payload).await?;
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Err(error) = handle_event(&state, &event, &repo, &payload, scope.as_deref()).await {
        // GitHub retries on 5xx; our failures are data-shaped, not transient.
        tracing::warn!("github webhook processing failed: {}", error);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `repository` events carry visibility flips (privatized / publicized) and renames.
async fn update_visibility(
    state: &SharedState,
    links: &[RepoLink],
    payload: &Value,
) -> AppResult<()> {
    let visibility = match text(payload, "/action") {
        "privatized" => "private",
        "publicized" => "public",
        _ => return Ok(()),
    };
    for link in links {
        sqlx::query("UPDATE project_github_repos SET visibility = $2 WHERE id = $1")
            .bind(link.id)
            .bind(visibility)
            .execute(&state.pool)
            .await?;
        let project = crate::routes::tasks::load_project(&state.pool, link.project_id).await?;
        broadcast_all(state, "project.updated", json!({ "project": project })).await?;
    }
    Ok(())
}

async fn handle_event(
    state: &SharedState,
    event: &str,
    repo: &str,
    payload: &Value,
    scope: Option<&[Uuid]>,
) -> AppResult<()> {
    let keys = project_keys(&state.pool, scope).await?;
    if keys.is_empty() {
        return Ok(());
    }

    match event {
        // Branch created or pushed to: link by branch name.
        "create" | "push" => {
            let branch = if event == "create" {
                if text(payload, "/ref_type") != "branch" {
                    return Ok(());
                }
                text(payload, "/ref").to_string()
            } else {
                if payload.pointer("/deleted").and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
                match text(payload, "/ref").strip_prefix("refs/heads/") {
                    Some(branch) => branch.to_string(),
                    None => return Ok(()),
                }
            };
            let url = format!("https://github.com/{repo}/tree/{branch}");
            for (key, number) in extract_identifiers(&branch, &keys) {
                if let Some(task_id) = resolve_task(&state.pool, &key, number).await? {
                    link_and_automate(
                        state,
                        task_id,
                        LinkUpsert {
                            repo,
                            kind: "branch",
                            git_ref: &branch,
                            url: &url,
                            title: &branch,
                            state: "",
                        },
                        Some("started"),
                    )
                    .await?;
                }
            }
        }
        "pull_request" => {
            let action = text(payload, "/action");
            let branch = text(payload, "/pull_request/head/ref");
            let title = text(payload, "/pull_request/title");
            let body_text = text(payload, "/pull_request/body");
            let url = text(payload, "/pull_request/html_url");
            let number = payload
                .pointer("/pull_request/number")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let draft = payload
                .pointer("/pull_request/draft")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let merged = payload
                .pointer("/pull_request/merged")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let (link_state, target_type) = match action {
                "opened" | "edited" | "reopened" | "ready_for_review" => {
                    (if draft { "draft" } else { "open" }, Some("started"))
                }
                "closed" if merged => ("merged", Some("completed")),
                "closed" => ("closed", None),
                _ => return Ok(()),
            };

            // Identifiers can appear in the branch name, the PR title, or the body.
            let mut seen: HashSet<(String, i64)> = HashSet::new();
            for source in [branch, title, body_text] {
                for identifier in extract_identifiers(source, &keys) {
                    seen.insert(identifier);
                }
            }
            let git_ref = number.to_string();
            for (key, task_number) in seen {
                if let Some(task_id) = resolve_task(&state.pool, &key, task_number).await? {
                    link_and_automate(
                        state,
                        task_id,
                        LinkUpsert {
                            repo,
                            kind: "pr",
                            git_ref: &git_ref,
                            url,
                            title,
                            state: link_state,
                        },
                        target_type,
                    )
                    .await?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

// ---------- per-project repository links (Phase 7E) ----------

/// Accept what people actually paste: `owner/name`, a browser URL, or an SSH remote.
/// Returns the canonical `owner/name`.
pub fn normalize_repo(input: &str) -> AppResult<String> {
    let mut repo = input.trim().to_string();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "git@github.com:",
        "ssh://git@github.com/",
        "github.com/",
    ] {
        if let Some(rest) = repo.strip_prefix(prefix) {
            repo = rest.to_string();
            break;
        }
    }
    repo = repo
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/')
        .to_string();
    // Drop anything after the repo segment (/tree/main, ?tab=…, #readme).
    let mut parts = repo.splitn(3, '/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    let name = name
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".git");
    let valid = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 100
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !valid(owner) || !valid(name) {
        return Err(AppError::Validation(
            "expected a repository like owner/name or a github.com URL".to_string(),
        ));
    }
    Ok(format!("{owner}/{name}"))
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Public URL GitHub must POST to. Mirrors the password-reset link resolution:
/// explicit `APP_URL`, else the caller's Origin/Host.
fn webhook_url(state: &SharedState, headers: &HeaderMap) -> AppResult<String> {
    let base = crate::auth::resolve_app_url(state, headers).ok_or_else(|| {
        AppError::BadRequest(
            "cannot determine this server's public URL — set APP_URL to enable GitHub setup"
                .to_string(),
        )
    })?;
    Ok(format!("{base}/api/v1/integrations/github/webhook"))
}

async fn project_or_404(pool: &PgPool, project_id: Uuid) -> AppResult<()> {
    crate::routes::tasks::load_project(pool, project_id).await.map(|_| ())
}

/// The secret + token of one link, for the paths that need them.
struct LinkSecrets {
    repo: String,
    secret: String,
    token: Option<String>,
    hook_id: Option<i64>,
}

async fn link_secrets(state: &SharedState, link_id: Uuid, project_id: Uuid) -> AppResult<LinkSecrets> {
    let row = sqlx::query(
        "SELECT repo, secret, token_enc, hook_id FROM project_github_repos
         WHERE id = $1 AND project_id = $2",
    )
    .bind(link_id)
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("repository link not found".to_string()))?;
    let token_enc: Option<String> = row.try_get("token_enc")?;
    let token = match token_enc {
        Some(sealed) => Some(
            crate::calendar_crypto::decrypt(&state.config.jwt_secret, &sealed)
                .map_err(|_| AppError::BadRequest("stored token could not be read".to_string()))?,
        ),
        None => None,
    };
    Ok(LinkSecrets {
        repo: row.try_get("repo")?,
        secret: row.try_get("secret")?,
        token,
        hook_id: row.try_get("hook_id")?,
    })
}

/// Verify the repo and install/refresh the webhook, recording what we learned.
/// Never fails the request: a token problem is a *status* on the link, so the panel
/// can show it and offer a retry.
async fn sync_link(
    state: &SharedState,
    link_id: Uuid,
    secrets: &LinkSecrets,
    hook_url: &str,
) -> AppResult<()> {
    let Some(token) = &secrets.token else {
        return Ok(());
    };
    let info = match crate::github_api::get_repo(token, &secrets.repo).await {
        Ok(info) => info,
        Err(error) => {
            sqlx::query("UPDATE project_github_repos SET last_error = $2 WHERE id = $1")
                .bind(link_id)
                .bind(error)
                .execute(&state.pool)
                .await?;
            return Ok(());
        }
    };
    let hook = crate::github_api::install_hook(
        token,
        &info.full_name,
        hook_url,
        &secrets.secret,
        secrets.hook_id,
    )
    .await;
    let (hook_id, error) = match hook {
        Ok(id) => (Some(id), String::new()),
        Err(error) if !info.can_admin => (
            None,
            format!(
                "{error} This token cannot manage webhooks on {} — add the `admin:repo_hook` \
                 scope, or add the webhook by hand with the URL and secret below.",
                info.full_name
            ),
        ),
        Err(error) => (None, error),
    };
    sqlx::query(
        "UPDATE project_github_repos
         SET repo = $2, visibility = $3, default_branch = $4,
             hook_id = COALESCE($5, hook_id), last_error = $6
         WHERE id = $1",
    )
    .bind(link_id)
    .bind(&info.full_name)
    .bind(&info.visibility)
    .bind(&info.default_branch)
    .bind(hook_id)
    .bind(error)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Project payload + everything the setup panel needs, including each link's
/// webhook secret — the user must paste it into GitHub when there is no token.
async fn github_response(
    state: &SharedState,
    project_id: Uuid,
    headers: &HeaderMap,
) -> AppResult<Json<Value>> {
    let project = crate::routes::tasks::load_project(&state.pool, project_id).await?;
    let rows = sqlx::query(
        "SELECT id, secret FROM project_github_repos WHERE project_id = $1 ORDER BY created_at",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    let mut secrets = serde_json::Map::new();
    for row in rows {
        secrets.insert(
            row.try_get::<Uuid, _>("id")?.to_string(),
            Value::String(row.try_get::<String, _>("secret")?),
        );
    }
    Ok(Json(json!({
        "project": project,
        "webhook_url": webhook_url(state, headers).unwrap_or_default(),
        "events": crate::github_api::HOOK_EVENTS,
        "secrets": secrets,
        "env_fallback": state.config.github.is_some(),
    })))
}

async fn broadcast_project(state: &SharedState, project_id: Uuid) -> AppResult<Project> {
    let project = crate::routes::tasks::load_project(&state.pool, project_id).await?;
    broadcast_all(state, "project.updated", json!({ "project": project })).await?;
    Ok(project)
}

pub async fn get_project_github(
    State(state): State<SharedState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    _auth: AuthUser,
) -> AppResult<Json<Value>> {
    project_or_404(&state.pool, project_id).await?;
    github_response(&state, project_id, &headers).await
}

#[derive(Deserialize)]
pub struct ConnectRepoRequest {
    pub repo: String,
    /// Optional PAT. With it we verify the repo and install the webhook ourselves;
    /// without it the panel shows manual setup instructions.
    pub token: Option<String>,
}

pub async fn connect_repo(
    State(state): State<SharedState>,
    Path(project_id): Path<Uuid>,
    headers: HeaderMap,
    auth: AuthUser,
    Json(body): Json<ConnectRepoRequest>,
) -> AppResult<Json<Value>> {
    project_or_404(&state.pool, project_id).await?;
    let repo = normalize_repo(&body.repo)?;
    let token = body.token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let token_enc = match &token {
        Some(token) => Some(
            crate::calendar_crypto::encrypt(&state.config.jwt_secret, token)
                .map_err(|_| AppError::BadRequest("could not store the token".to_string()))?,
        ),
        None => None,
    };
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM project_github_repos WHERE project_id = $1 AND lower(repo) = lower($2)",
    )
    .bind(project_id)
    .bind(&repo)
    .fetch_optional(&state.pool)
    .await?;
    if existing.is_some() {
        return Err(AppError::Validation(
            "this repository is already linked to the project".to_string(),
        ));
    }
    let link_id: Uuid = sqlx::query_scalar(
        "INSERT INTO project_github_repos (project_id, repo, secret, token_enc, connected_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(project_id)
    .bind(&repo)
    .bind(new_secret())
    .bind(&token_enc)
    .bind(auth.id)
    .fetch_one(&state.pool)
    .await?;

    if token.is_some() {
        let hook_url = webhook_url(&state, &headers)?;
        let secrets = link_secrets(&state, link_id, project_id).await?;
        sync_link(&state, link_id, &secrets, &hook_url).await?;
    }
    broadcast_project(&state, project_id).await?;
    github_response(&state, project_id, &headers).await
}

#[derive(Deserialize)]
pub struct UpdateRepoRequest {
    /// `Some(Some(pat))` sets/replaces the token, `Some(None)` clears it back to
    /// manual mode, absent leaves it alone.
    #[serde(default, deserialize_with = "crate::routes::github::de_opt_opt_string")]
    pub token: Option<Option<String>>,
    /// Generate a fresh webhook secret (and re-point the hook if we own it).
    #[serde(default)]
    pub rotate_secret: bool,
}

/// `{"token": null}` must mean "clear", not "absent" — serde needs the nudge.
pub fn de_opt_opt_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub async fn update_repo(
    State(state): State<SharedState>,
    Path((project_id, link_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    _auth: AuthUser,
    Json(body): Json<UpdateRepoRequest>,
) -> AppResult<Json<Value>> {
    project_or_404(&state.pool, project_id).await?;
    link_secrets(&state, link_id, project_id).await?; // 404s on a foreign link
    if let Some(token) = body.token {
        let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let token_enc = match &token {
            Some(token) => Some(
                crate::calendar_crypto::encrypt(&state.config.jwt_secret, token)
                    .map_err(|_| AppError::BadRequest("could not store the token".to_string()))?,
            ),
            None => None,
        };
        sqlx::query(
            "UPDATE project_github_repos SET token_enc = $2, last_error = '' WHERE id = $1",
        )
        .bind(link_id)
        .bind(&token_enc)
        .execute(&state.pool)
        .await?;
    }
    if body.rotate_secret {
        sqlx::query("UPDATE project_github_repos SET secret = $2, hook_active = false WHERE id = $1")
            .bind(link_id)
            .bind(new_secret())
            .execute(&state.pool)
            .await?;
    }
    let hook_url = webhook_url(&state, &headers)?;
    let secrets = link_secrets(&state, link_id, project_id).await?;
    sync_link(&state, link_id, &secrets, &hook_url).await?;
    broadcast_project(&state, project_id).await?;
    github_response(&state, project_id, &headers).await
}

/// Re-check the repo and webhook now (the panel's "Re-check" button).
pub async fn verify_repo(
    State(state): State<SharedState>,
    Path((project_id, link_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    _auth: AuthUser,
) -> AppResult<Json<Value>> {
    project_or_404(&state.pool, project_id).await?;
    let secrets = link_secrets(&state, link_id, project_id).await?;
    let hook_url = webhook_url(&state, &headers)?;
    sync_link(&state, link_id, &secrets, &hook_url).await?;
    broadcast_project(&state, project_id).await?;
    github_response(&state, project_id, &headers).await
}

pub async fn disconnect_repo(
    State(state): State<SharedState>,
    Path((project_id, link_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    _auth: AuthUser,
) -> AppResult<Json<Value>> {
    project_or_404(&state.pool, project_id).await?;
    let secrets = link_secrets(&state, link_id, project_id).await?;
    // Best effort: leaving a dead hook behind is noisy but not fatal.
    if let (Some(token), Some(hook_id)) = (&secrets.token, secrets.hook_id) {
        if let Err(error) = crate::github_api::delete_hook(token, &secrets.repo, hook_id).await {
            tracing::warn!("github hook delete failed for {}: {}", secrets.repo, error);
        }
    }
    sqlx::query("DELETE FROM project_github_repos WHERE id = $1 AND project_id = $2")
        .bind(link_id)
        .bind(project_id)
        .execute(&state.pool)
        .await?;
    broadcast_project(&state, project_id).await?;
    github_response(&state, project_id, &headers).await
}

#[cfg(test)]
mod tests {
    use super::{extract_identifiers, normalize_repo, verify_signature};
    use std::collections::HashSet;

    fn keys(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_identifiers_in_branch_names_and_text() {
        let ks = keys(&["SHARP", "WEB"]);
        assert_eq!(
            extract_identifiers("sharp-12-fix-login", &ks),
            vec![("SHARP".to_string(), 12)]
        );
        assert_eq!(
            extract_identifiers("Fixes SHARP-3 and web-44.", &ks),
            vec![("SHARP".to_string(), 3), ("WEB".to_string(), 44)]
        );
        assert_eq!(
            extract_identifiers("davide/SHARP-7-thing", &ks),
            vec![("SHARP".to_string(), 7)]
        );
    }

    #[test]
    fn respects_boundaries_and_unknown_keys() {
        let ks = keys(&["SHARP"]);
        assert!(extract_identifiers("resharp-12", &ks).is_empty()); // key not word-start
        assert!(extract_identifiers("sharp-12a", &ks).is_empty()); // digits not word-end
        assert!(extract_identifiers("other-9", &ks).is_empty()); // unknown key
        assert!(extract_identifiers("sharp-", &ks).is_empty()); // no number
    }

    #[test]
    fn normalizes_the_shapes_people_paste() {
        for input in [
            "fortitudex/sharp",
            " fortitudex/sharp ",
            "https://github.com/fortitudex/sharp",
            "https://github.com/fortitudex/sharp.git",
            "https://github.com/fortitudex/sharp/tree/main",
            "git@github.com:fortitudex/sharp.git",
            "github.com/fortitudex/sharp",
        ] {
            assert_eq!(normalize_repo(input).unwrap(), "fortitudex/sharp", "{input}");
        }
    }

    #[test]
    fn rejects_non_repositories() {
        for input in ["", "sharp", "owner/", "/name", "owner/na me", "owner/na*me"] {
            assert!(normalize_repo(input).is_err(), "{input:?} should be rejected");
        }
    }

    #[test]
    fn signature_check_is_secret_specific() {
        // Fixture: GitHub's documented example (secret "It's a Secret to Everybody",
        // body "Hello, World!").
        let body = b"Hello, World!";
        let signature =
            "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(verify_signature("It's a Secret to Everybody", body, signature));
        assert!(!verify_signature("another project's secret", body, signature));
        assert!(!verify_signature("It's a Secret to Everybody", b"tampered", signature));
        assert!(!verify_signature("It's a Secret to Everybody", body, "nope"));
    }
}
