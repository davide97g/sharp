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
    /// Optional scope: restrict results to a single channel (ACL still enforced).
    pub channel_id: Option<uuid::Uuid>,
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

    // Optional single-channel scope. When present it binds as $3 and shifts LIMIT to $4.
    let scope_clause = if params.channel_id.is_some() {
        "AND m.channel_id = $3"
    } else {
        ""
    };
    let limit_placeholder = if params.channel_id.is_some() {
        "$4"
    } else {
        "$3"
    };
    let sql = format!(
        "SELECT
            m.id, m.channel_id, m.parent_id, m.user_id, u.display_name AS author_name,
            u.avatar_url AS author_avatar,
            m.content, m.created_at, m.edited_at, m.deleted_at,
            rm.id AS reply_id, rm.content AS reply_content, rm.deleted_at AS reply_deleted_at,
            ru.id AS reply_user_id, ru.display_name AS reply_user_name, ru.avatar_url AS reply_user_avatar,
            (SELECT count(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS reply_count,
            (SELECT max(r.created_at) FROM messages r WHERE r.parent_id = m.id AND r.deleted_at IS NULL) AS last_reply_at,
            c.name AS channel_name,
            ts_headline('simple', m.content, websearch_to_tsquery('simple', $2),
                'StartSel=<<,StopSel=>>,MaxWords=18,MinWords=6,MaxFragments=1') AS snippet,
            ts_rank(m.search, websearch_to_tsquery('simple', $2)) AS rank
         FROM messages m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN messages rm ON rm.id = m.reply_to_id
         LEFT JOIN users ru ON ru.id = rm.user_id
         JOIN channels c ON c.id = m.channel_id
         JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
         WHERE m.deleted_at IS NULL
           AND m.search @@ websearch_to_tsquery('simple', $2)
           {scope_clause}
         ORDER BY rank DESC, m.id DESC
         LIMIT {limit_placeholder}"
    );
    let mut query = sqlx::query(&sql).bind(auth.id).bind(&q);
    if let Some(cid) = params.channel_id {
        query = query.bind(cid);
    }
    let rows = query.bind(limit).fetch_all(&state.pool).await?;

    let mut results = Vec::with_capacity(rows.len());
    for row in &rows {
        let message = map_message_row(row)?;
        let channel_name: String = row.try_get("channel_name")?;
        let snippet: String = row.try_get("snippet").unwrap_or_default();
        results.push(SearchResult {
            message,
            channel_name,
            snippet,
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
