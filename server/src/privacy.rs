//! Server-enforced privacy preferences (migration 0031).
//!
//! These three live in real columns rather than the opaque `user_prefs.ui`
//! blob because the server is the thing that has to honour them: what presence
//! it discloses, whether it relays a typing indicator, and how much of a
//! message it puts in a push notification. A privacy switch the client alone
//! respects protects nobody.

use sqlx::{PgPool, Row};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushPreview {
    Full,
    Generic,
}

impl PushPreview {
    fn parse(raw: &str) -> Self {
        if raw == "generic" {
            Self::Generic
        } else {
            Self::Full
        }
    }
}

/// Missing row = defaults, matching the column defaults.
pub struct PrivacyPrefs {
    pub invisible: bool,
    pub share_typing: bool,
    pub push_preview: PushPreview,
}

impl Default for PrivacyPrefs {
    fn default() -> Self {
        Self {
            invisible: false,
            share_typing: true,
            push_preview: PushPreview::Full,
        }
    }
}

pub async fn load(pool: &PgPool, user_id: Uuid) -> PrivacyPrefs {
    let Some(row) =
        sqlx::query("SELECT invisible, share_typing, push_preview FROM user_prefs WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
    else {
        return PrivacyPrefs::default();
    };
    PrivacyPrefs {
        invisible: row.try_get("invisible").unwrap_or(false),
        share_typing: row.try_get("share_typing").unwrap_or(true),
        push_preview: row
            .try_get::<String, _>("push_preview")
            .map(|s| PushPreview::parse(&s))
            .unwrap_or(PushPreview::Full),
    }
}

pub async fn shares_typing(pool: &PgPool, user_id: Uuid) -> bool {
    load(pool, user_id).await.share_typing
}

/// Everyone currently appearing offline on purpose. Cheap: the row count is
/// bounded by users who have actually enabled it.
pub async fn invisible_user_ids(pool: &PgPool) -> HashSet<Uuid> {
    sqlx::query("SELECT user_id FROM user_prefs WHERE invisible = true")
        .fetch_all(pool)
        .await
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.try_get::<Uuid, _>("user_id").ok())
                .collect()
        })
        .unwrap_or_default()
}

pub async fn is_invisible(pool: &PgPool, user_id: Uuid) -> bool {
    load(pool, user_id).await.invisible
}

/// Content-free push text. The recipient learns that *something* arrived and
/// nothing else — no sender, no channel, no message body.
pub fn generic_push_text() -> (String, String) {
    ("sharp".to_string(), "New activity".to_string())
}
