use chrono::{DateTime, Utc};
use serde::{Serialize, Serializer};
use uuid::Uuid;

/// Serialize an i64 as a JSON string (JS bigint safety).
pub fn ser_i64_string<S>(id: &i64, s: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    s.serialize_str(&id.to_string())
}

/// Serialize an Option<i64> as an optional JSON string.
pub fn ser_opt_i64_string<S>(id: &Option<i64>, s: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match id {
        Some(v) => s.serialize_str(&v.to_string()),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub created_at: DateTime<Utc>,
}

/// The compact author shape embedded in messages.
#[derive(Debug, Clone, Serialize)]
pub struct MessageUser {
    pub id: Uuid,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub topic: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub is_member: bool,
    pub unread_count: i64,
    pub last_message_at: Option<DateTime<Utc>>,
    pub dm_user: Option<User>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: i64,
    pub me: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    #[serde(serialize_with = "ser_i64_string")]
    pub id: i64,
    pub channel_id: Uuid,
    #[serde(serialize_with = "ser_opt_i64_string")]
    pub parent_id: Option<i64>,
    pub user: MessageUser,
    pub content: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub reactions: Vec<Reaction>,
    pub reply_count: i64,
    pub last_reply_at: Option<DateTime<Utc>>,
}

/// Search result: a message plus the channel name it belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    #[serde(flatten)]
    pub message: Message,
    pub channel_name: String,
}
