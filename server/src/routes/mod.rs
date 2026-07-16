pub mod call_links;
pub mod channels;
pub mod docs;
pub mod files;
pub mod gifs;
pub mod messages;
pub mod notifications;
pub mod search;
pub mod users;
pub mod voice;

use crate::error::AppResult;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Returns the channel kind if the channel exists, otherwise None.
pub async fn channel_kind(pool: &PgPool, channel_id: Uuid) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT kind FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some(r) => Ok(Some(r.try_get::<String, _>("kind")?)),
        None => Ok(None),
    }
}

pub async fn is_member(pool: &PgPool, channel_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let row =
        sqlx::query("SELECT 1 AS x FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}
