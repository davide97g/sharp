//! The notification **inbox**: list and mark-read. Nothing else.
//!
//! Contract: docs/arch/05-files-notifications.md.
//!
//! Rows are created by `crate::notify`, never here. Sibling modules own the adjacent
//! concerns that used to live in this file: `routes/prefs.rs` for notification /
//! appearance / DND preferences, `routes/push.rs` for push-subscription registration.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::notify;
use crate::state::SharedState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct ListQuery {
    pub before: Option<String>,
    pub limit: Option<i64>,
}

pub async fn list_notifications(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let before: Option<i64> = match q.before {
        Some(ref s) if !s.is_empty() => Some(
            s.parse::<i64>()
                .map_err(|_| AppError::BadRequest("invalid before cursor".to_string()))?,
        ),
        _ => None,
    };
    let limit = q.limit.unwrap_or(30).clamp(1, 100);

    let notifications = notify::list_for_user(&state.pool, auth.id, before, limit).await?;
    let unread_count = notify::unread_count(&state.pool, auth.id).await?;

    Ok(Json(json!({
        "notifications": notifications,
        "unread_count": unread_count,
    })))
}

#[derive(Deserialize)]
pub struct ReadRequest {
    pub ids: Option<Vec<String>>,
    pub all: Option<bool>,
}

pub async fn mark_read(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ReadRequest>,
) -> AppResult<StatusCode> {
    if body.all.unwrap_or(false) {
        sqlx::query(
            "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
        )
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(ids) = body.ids {
        let parsed: Vec<i64> = ids.iter().filter_map(|s| s.parse::<i64>().ok()).collect();
        if !parsed.is_empty() {
            sqlx::query(
                "UPDATE notifications SET read_at = now()
                 WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL",
            )
            .bind(auth.id)
            .bind(&parsed)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- preferences ----

