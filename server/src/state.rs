use crate::config::Config;
use crate::ws::Hub;
use sqlx::PgPool;
use std::sync::Arc;

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub hub: Arc<Hub>,
}

pub type SharedState = Arc<AppState>;
