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

/// A file attached to a message. `url` is the proxied download path.
#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub url: String,
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
    pub attachments: Vec<Attachment>,
    pub reply_count: i64,
    pub last_reply_at: Option<DateTime<Utc>>,
}

/// An inbox notification (mention / dm / reply).
#[derive(Debug, Clone, Serialize)]
pub struct Notification {
    #[serde(serialize_with = "ser_i64_string")]
    pub id: i64,
    pub kind: String,
    pub actor: MessageUser,
    pub channel_id: Uuid,
    pub channel_kind: String,
    pub channel_name: String,
    #[serde(serialize_with = "ser_opt_i64_string")]
    pub message_id: Option<i64>,
    pub preview: String,
    pub created_at: DateTime<Utc>,
    pub read_at: Option<DateTime<Utc>>,
}

/// Search result: a message plus the channel name it belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    #[serde(flatten)]
    pub message: Message,
    pub channel_name: String,
}

/// A collaborative doc, serialized with the requesting/receiving user's resolved role.
#[derive(Debug, Clone, Serialize)]
pub struct Doc {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub kind: String,
    pub title: String,
    pub icon: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub everyone_role: String,
    pub my_role: String,
    pub preview: String,
}

/// The compact doc shape embedded in a mention.
#[derive(Debug, Clone, Serialize)]
pub struct DocMentionDoc {
    pub id: Uuid,
    pub kind: String,
    pub title: String,
    pub icon: String,
    pub channel_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocMention {
    #[serde(serialize_with = "ser_i64_string")]
    pub id: i64,
    pub doc: DocMentionDoc,
    pub from_user: MessageUser,
    pub created_at: DateTime<Utc>,
    pub read_at: Option<DateTime<Utc>>,
}

/// Doc-search result: a doc plus the channel name it belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct DocSearchResult {
    #[serde(flatten)]
    pub doc: Doc,
    pub channel_name: String,
}
