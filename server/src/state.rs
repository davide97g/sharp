use crate::config::Config;
use crate::docs_sync::DocRooms;
use crate::ws::Hub;
use sqlx::PgPool;
use std::sync::Arc;

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub hub: Arc<Hub>,
    /// Live doc-sync rooms, keyed by doc id. Per-replica (see ARCHITECTURE Phase 2).
    pub doc_rooms: DocRooms,
}

pub type SharedState = Arc<AppState>;
