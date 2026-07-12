use crate::auth::{user_from_row, AuthUser};
use crate::error::{AppError, AppResult};
use crate::models::User;
use crate::state::SharedState;
use axum::extract::State;
use axum::Json;
use serde_json::json;

pub async fn me(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<User>> {
    let row = sqlx::query("SELECT id, email, display_name, created_at FROM users WHERE id = $1")
        .bind(auth.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("user not found".to_string()))?;
    Ok(Json(user_from_row(&row)?))
}

pub async fn list_users(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let rows =
        sqlx::query("SELECT id, email, display_name, created_at FROM users ORDER BY display_name")
            .fetch_all(&state.pool)
            .await?;
    let mut users = Vec::with_capacity(rows.len());
    for row in &rows {
        users.push(user_from_row(row)?);
    }

    let online: Vec<String> = state
        .hub
        .online_user_ids()
        .into_iter()
        .map(|u| u.to_string())
        .collect();

    Ok(Json(json!({ "users": users, "online_user_ids": online })))
}
