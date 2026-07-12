mod auth;
mod config;
mod error;
mod models;
mod routes;
mod state;
mod ws;

use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use config::Config;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use state::AppState;
use std::path::Path;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use ws::Hub;

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env().map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    // Optional Redis client for cross-replica fanout.
    let redis_client = match &config.redis_url {
        Some(url) => Some(redis::Client::open(url.clone())?),
        None => None,
    };

    let hub = Arc::new(Hub::new(redis_client));

    if hub.has_redis() {
        if let Some(client) = hub.redis_client() {
            let hub_for_sub = hub.clone();
            tokio::spawn(async move {
                ws::run_redis_subscriber(hub_for_sub, client).await;
            });
        }
    }

    let port = config.port;
    let web_dist = config.web_dist.clone();

    let app_state: state::SharedState = Arc::new(AppState {
        pool,
        config,
        hub,
    });

    let api = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/me", get(routes::users::me))
        .route("/users", get(routes::users::list_users))
        .route(
            "/channels",
            get(routes::channels::list_channels).post(routes::channels::create_channel),
        )
        .route("/channels/dm", post(routes::channels::create_dm))
        .route("/channels/:id/join", post(routes::channels::join_channel))
        .route("/channels/:id/leave", post(routes::channels::leave_channel))
        .route("/channels/:id/members", get(routes::channels::list_members))
        .route("/channels/:id/read", post(routes::channels::mark_read))
        .route(
            "/channels/:id/messages",
            get(routes::messages::list_messages).post(routes::messages::create_message),
        )
        .route("/messages/:id/thread", get(routes::messages::get_thread))
        .route(
            "/messages/:id",
            patch(routes::messages::edit_message).delete(routes::messages::delete_message),
        )
        .route(
            "/messages/:id/reactions/:emoji",
            put(routes::messages::add_reaction).delete(routes::messages::remove_reaction),
        )
        .route("/search", get(routes::search::search))
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler));

    let mut app: Router<state::SharedState> = Router::new().nest("/api/v1", api);

    // Serve the built SPA (if present) with fallback to index.html.
    let dist_path = Path::new(&web_dist);
    if dist_path.is_dir() {
        let index = dist_path.join("index.html");
        let serve_dir = ServeDir::new(dist_path).not_found_service(ServeFile::new(index));
        app = app.fallback_service(serve_dir);
        tracing::info!("serving SPA from {}", web_dist);
    } else {
        tracing::info!("WEB_DIST '{}' not found; running API-only", web_dist);
    }

    let app = app
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("sharp-server listening on {}", addr);

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
