//! GitHub → tasks sync (Phase 7C). One HMAC-verified webhook endpoint; inert
//! unless `GITHUB_WEBHOOK_SECRET` is set. Any task identifier (`KEY-123`)
//! appearing in a branch name, PR title, or PR body links that branch/PR to the
//! task and drives state automation:
//!
//!   - branch created / pushed / PR opened  → backlog|unstarted tasks move to
//!     the project's first `started` state
//!   - PR merged                            → first `completed` state
//!   - PR closed unmerged                   → link state updated, task untouched
//!
//! Processing is idempotent: links upsert on `(task_id, url)` and state moves
//! no-op when the task is already at/past the target type. Automation writes
//! `task_activity` with a NULL actor and fans out `task.updated` as usual.

use crate::error::{AppError, AppResult};
use crate::routes::tasks::{apply_state_change, broadcast_all, load_task, record_activity};
use crate::state::SharedState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use hmac::{Hmac, Mac};
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

async fn project_keys(pool: &PgPool) -> AppResult<HashSet<String>> {
    let rows = sqlx::query("SELECT key FROM projects").fetch_all(pool).await?;
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

pub async fn webhook(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let Some(github) = &state.config.github else {
        return Err(AppError::NotFound("github sync not configured".to_string()));
    };
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_signature(&github.webhook_secret, &body, signature) {
        return Err(AppError::Unauthorized("bad webhook signature".to_string()));
    }
    let event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("malformed payload".to_string()))?;

    let repo = text(&payload, "/repository/full_name").to_string();
    if !github.repos.is_empty() && !github.repos.contains(&repo.to_lowercase()) {
        return Ok(StatusCode::ACCEPTED); // signed but not allowlisted: ignore quietly
    }

    if let Err(error) = handle_event(&state, &event, &repo, &payload).await {
        // GitHub retries on 5xx; our failures are data-shaped, not transient.
        tracing::warn!("github webhook processing failed: {}", error);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn handle_event(
    state: &SharedState,
    event: &str,
    repo: &str,
    payload: &Value,
) -> AppResult<()> {
    let keys = project_keys(&state.pool).await?;
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

#[cfg(test)]
mod tests {
    use super::extract_identifiers;
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
}
