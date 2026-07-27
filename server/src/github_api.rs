//! Outbound GitHub REST calls for per-project repository links.
//!
//! Only used when a link carries a PAT: we verify the repository exists and is
//! reachable, read its visibility/default branch, and install (or re-point) the
//! webhook that drives task automation. Manual links never reach this module.
//!
//! Errors come back as human-readable strings — they are surfaced verbatim in the
//! project's GitHub panel, so they must read like advice ("token can't see this
//! repository"), never like a stack trace. The pooled client is `crate::http`.

use serde_json::{json, Value};

const API: &str = "https://api.github.com";
/// The three events task automation reacts to, plus `repository` for visibility flips.
pub const HOOK_EVENTS: [&str; 4] = ["push", "create", "pull_request", "repository"];

pub struct RepoInfo {
    pub full_name: String,
    /// `public` | `private` | `internal`.
    pub visibility: String,
    pub default_branch: String,
    /// Whether the token holder can manage webhooks on the repo.
    pub can_admin: bool,
}

fn request(method: reqwest::Method, url: &str, token: &str) -> reqwest::RequestBuilder {
    crate::http::client()
        .request(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "sharp")
}

/// Map a GitHub status onto advice the connect panel can show as-is.
fn explain(status: reqwest::StatusCode, body: &str, what: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    match status.as_u16() {
        401 => "GitHub rejected the token (expired or revoked).".to_string(),
        403 => format!("GitHub refused the request: {detail}"),
        404 => {
            "Repository not found — check the owner/name, and that the token can see it \
             (private repos need the `repo` scope)."
                .to_string()
        }
        _ => format!("GitHub {what} failed ({status}): {detail}"),
    }
}

async fn send(builder: reqwest::RequestBuilder, what: &str) -> Result<(Value, u16), String> {
    let response = builder
        .send()
        .await
        .map_err(|e| format!("GitHub {what} request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(explain(status, &body, what));
    }
    let value = if body.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&body).unwrap_or(Value::Null)
    };
    Ok((value, status.as_u16()))
}

pub async fn get_repo(token: &str, repo: &str) -> Result<RepoInfo, String> {
    let (value, _) = send(
        request(reqwest::Method::GET, &format!("{API}/repos/{repo}"), token),
        "repository lookup",
    )
    .await?;
    Ok(RepoInfo {
        full_name: value
            .get("full_name")
            .and_then(Value::as_str)
            .unwrap_or(repo)
            .to_string(),
        visibility: value
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or(match value.get("private").and_then(Value::as_bool) {
                Some(true) => "private",
                _ => "public",
            })
            .to_string(),
        default_branch: value
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        can_admin: value
            .pointer("/permissions/admin")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn hook_config(url: &str, secret: &str) -> Value {
    json!({
        "name": "web",
        "active": true,
        "events": HOOK_EVENTS,
        "config": { "url": url, "content_type": "json", "secret": secret, "insecure_ssl": "0" },
    })
}

/// Our hook on this repo, if one already points at `url`. Lets a re-connect adopt
/// (and re-secret) the existing hook instead of duplicating it.
pub async fn find_hook(token: &str, repo: &str, url: &str) -> Result<Option<i64>, String> {
    let (value, _) = send(
        request(
            reqwest::Method::GET,
            &format!("{API}/repos/{repo}/hooks?per_page=100"),
            token,
        ),
        "webhook list",
    )
    .await?;
    let found = value.as_array().into_iter().flatten().find_map(|hook| {
        (hook.pointer("/config/url").and_then(Value::as_str) == Some(url))
            .then(|| hook.get("id").and_then(Value::as_i64))
            .flatten()
    });
    Ok(found)
}

pub async fn create_hook(token: &str, repo: &str, url: &str, secret: &str) -> Result<i64, String> {
    let (value, _) = send(
        request(
            reqwest::Method::POST,
            &format!("{API}/repos/{repo}/hooks"),
            token,
        )
        .json(&hook_config(url, secret)),
        "webhook create",
    )
    .await?;
    value
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "GitHub created the webhook but returned no id.".to_string())
}

pub async fn update_hook(
    token: &str,
    repo: &str,
    hook_id: i64,
    url: &str,
    secret: &str,
) -> Result<(), String> {
    send(
        request(
            reqwest::Method::PATCH,
            &format!("{API}/repos/{repo}/hooks/{hook_id}"),
            token,
        )
        .json(&hook_config(url, secret)),
        "webhook update",
    )
    .await?;
    Ok(())
}

/// Best-effort: a hook deleted by hand in GitHub 404s, which is success for us.
pub async fn delete_hook(token: &str, repo: &str, hook_id: i64) -> Result<(), String> {
    match send(
        request(
            reqwest::Method::DELETE,
            &format!("{API}/repos/{repo}/hooks/{hook_id}"),
            token,
        ),
        "webhook delete",
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.contains("not found") || error.contains("404") => Ok(()),
        Err(error) => Err(error),
    }
}

/// Install our webhook, adopting an existing one with the same URL. Returns its id.
pub async fn install_hook(
    token: &str,
    repo: &str,
    url: &str,
    secret: &str,
    known_id: Option<i64>,
) -> Result<i64, String> {
    if let Some(id) = known_id {
        if update_hook(token, repo, id, url, secret).await.is_ok() {
            return Ok(id);
        }
    }
    if let Some(id) = find_hook(token, repo, url).await? {
        update_hook(token, repo, id, url, secret).await?;
        return Ok(id);
    }
    create_hook(token, repo, url, secret).await
}
