pub mod calendar;
pub mod call_links;
pub mod channels;
pub mod docs;
pub mod e2ee;
pub mod files;
pub mod gifs;
pub mod github;
pub mod meetings;
pub mod messages;
pub mod notifications;
pub mod polls;
pub mod search;
pub mod sharpy;
pub mod tasks;
pub mod users;
pub mod voice;
pub mod voice_triggers;

use crate::error::AppResult;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelRole {
    Owner,
    Editor,
    Viewer,
}

impl ChannelRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelRole::Owner => "owner",
            ChannelRole::Editor => "editor",
            ChannelRole::Viewer => "viewer",
        }
    }

    pub fn from_str(role: &str) -> Self {
        match role {
            "owner" => ChannelRole::Owner,
            "viewer" => ChannelRole::Viewer,
            _ => ChannelRole::Editor,
        }
    }

    pub fn can_post(self) -> bool {
        !matches!(self, ChannelRole::Viewer)
    }

    pub fn is_owner(self) -> bool {
        matches!(self, ChannelRole::Owner)
    }
}

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

pub async fn member_role(
    pool: &PgPool,
    channel_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<ChannelRole>> {
    let row =
        sqlx::query("SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    match row {
        Some(row) => Ok(Some(ChannelRole::from_str(
            row.try_get::<String, _>("role")?.as_str(),
        ))),
        None => Ok(None),
    }
}

pub async fn channel_member_roles(
    pool: &PgPool,
    channel_id: Uuid,
) -> AppResult<HashMap<Uuid, ChannelRole>> {
    let rows = sqlx::query("SELECT user_id, role FROM channel_members WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_all(pool)
        .await?;
    let mut roles = HashMap::with_capacity(rows.len());
    for row in rows {
        roles.insert(
            row.try_get("user_id")?,
            ChannelRole::from_str(row.try_get::<String, _>("role")?.as_str()),
        );
    }
    Ok(roles)
}

pub async fn count_owners(pool: &PgPool, channel_id: Uuid) -> AppResult<i64> {
    let row = sqlx::query(
        "SELECT count(*) AS count FROM channel_members WHERE channel_id = $1 AND role = 'owner'",
    )
    .bind(channel_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("count")?)
}
