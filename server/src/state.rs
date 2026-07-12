use crate::config::Config;
use crate::storage::Storage;
use crate::ws::Hub;
use sqlx::PgPool;
use std::sync::Arc;

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
    /// Object storage for uploads; `None` when S3 is not configured.
    pub storage: Option<Storage>,
    /// Web-push keys; `None` when push is disabled.
    pub vapid: Option<Vapid>,
}

pub type SharedState = Arc<AppState>;
