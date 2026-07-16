use crate::config::Config;
use crate::docs_sync::DocRooms;
use crate::storage::Storage;
use crate::ws::Hub;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use uuid::Uuid;

/// Short-lived, single-use codes for desktop browser-login.
/// Maps code -> (user id, expiry). In-process, per-replica (see ARCHITECTURE).
pub type DesktopCodes = Arc<Mutex<HashMap<String, (Uuid, Instant)>>>;

/// Resolved VAPID keypair for web push (from env or auto-generated + persisted).
#[derive(Clone)]
pub struct Vapid {
    pub public_b64: String,
    /// URL-safe base64 of the raw 32-byte P-256 private scalar.
    pub private_b64: String,
    pub subject: String,
}

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub hub: Arc<Hub>,
    /// Ephemeral voice rooms, keyed by channel id. Per-replica.
    pub voice_rooms: crate::ws::voice::VoiceRooms,
    /// Live doc-sync rooms, keyed by doc id. Per-replica (see ARCHITECTURE Phase 2).
    pub doc_rooms: DocRooms,
    /// Object storage for uploads; `None` when S3 is not configured.
    pub storage: Option<Storage>,
    /// Web-push keys; `None` when push is disabled.
    pub vapid: Option<Vapid>,
    /// One-time codes for the desktop browser-login exchange. Per-replica.
    pub desktop_codes: DesktopCodes,
    /// Last automatic GIF suggestion attempt per channel. Per-replica.
    pub gif_suggest_cooldowns: Mutex<HashMap<Uuid, Instant>>,
    /// Shared per-channel duck streak (all members boost it). Per-replica.
    pub duck_streaks: crate::gif::DuckStreaks,
    /// Sliding-hour GIPHY search usage (self-enforced 100/h). Per-replica.
    pub giphy_usage: crate::gif::GiphyUsageTracker,
}

pub type SharedState = Arc<AppState>;
