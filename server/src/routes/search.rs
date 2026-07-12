use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::models::SearchResult;
use crate::routes::messages::{fetch_reactions_map, map_message_row};
use crate::state::SharedState;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
}

pub async fn search(
    State(state): State<SharedState>,
    auth: AuthUser,
    Query(params): Query<SearchQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let q = params.q.unwrap_or_default();
    let q = q.trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!({ "results": Vec::<SearchResult>::new() })));
    }
    let limit = params.limit.unwrap_or(20).clamp(1, 50);

    let rows = sqlx::query(
        "SELECT
            m.id, m.channel_id, m.parent_id, m.user_id, u.display_name AS author_name,
            m.content, m.created_at, m.edited_at, m.deleted_at,
            (SELECT count(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS reply_count,
            (SELECT max(r.created_at) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS last_reply_at,
            c.name AS channel_name,
            ts_rank(m.search, websearch_to_tsquery('simple', $2)) AS rank
         FROM messages m
         JOIN users u ON u.id = m.user_id
         JOIN channels c ON c.id = m.channel_id
         JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
         WHERE m.deleted_at IS NULL
           AND m.search @@ websearch_to_tsquery('simple', $2)
         ORDER BY rank DESC, m.id DESC
         LIMIT $3",
    )
    .bind(auth.id)
    .bind(&q)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let mut results = Vec::with_capacity(rows.len());
    for row in &rows {
        let message = map_message_row(row)?;
        let channel_name: String = row.try_get("channel_name")?;
        results.push(SearchResult {
            message,
            channel_name,
        });
    }

    // Attach reactions.
    let ids: Vec<i64> = results.iter().map(|r| r.message.id).collect();
    let mut rmap = fetch_reactions_map(&state.pool, &ids, auth.id).await?;
    for r in &mut results {
        if let Some(rs) = rmap.remove(&r.message.id) {
            r.message.reactions = rs;
        }
    }

    Ok(Json(json!({ "results": results })))
}
