mod auth;
mod config;
mod error;
mod models;
mod notify;
mod routes;
mod state;
mod storage;
mod vapid;
mod ws;

use axum::extract::DefaultBodyLimit;
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

    // File storage (optional S3-compatible backend).
    let storage = match &config.s3 {
        Some(s3) => match storage::Storage::from_config(s3) {
            Ok(s) => {
                tracing::info!("file uploads enabled (bucket '{}')", s3.bucket);
                Some(s)
            }
            Err(e) => {
                tracing::warn!("file uploads disabled: {}", e);
                None
            }
        },
        None => {
            tracing::info!("file uploads disabled (S3 not configured)");
            None
        }
    };

    // Web-push keys (env → persisted → auto-generated).
    let vapid = vapid::resolve(&config, &pool).await;
    tracing::info!(
        "web push {}",
        if vapid.is_some() { "enabled" } else { "disabled" }
    );

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
    let upload_limit = config.max_upload_bytes + 1024 * 1024;

    let app_state: state::SharedState = Arc::new(AppState {
        pool,
        config,
        hub,
        storage,
        vapid,
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
        // files
        .route(
            "/channels/:id/uploads",
            post(routes::files::upload).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/files/:id", get(routes::files::download))
        // notifications + preferences
        .route(
            "/notifications",
            get(routes::notifications::list_notifications),
        )
        .route("/notifications/read", post(routes::notifications::mark_read))
        .route("/prefs", get(routes::notifications::get_prefs))
        .route("/prefs/dnd", put(routes::notifications::set_dnd))
        .route(
            "/channels/:id/prefs",
            put(routes::notifications::set_channel_pref),
        )
        // web push
        .route("/push/vapid", get(routes::notifications::vapid_public))
        .route("/push/subscribe", post(routes::notifications::subscribe))
        .route(
            "/push/unsubscribe",
            post(routes::notifications::unsubscribe),
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
