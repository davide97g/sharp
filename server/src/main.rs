mod auth;
mod config;
mod docs_sync;
mod deepseek;
mod error;
mod expo_push;
mod gif;
mod models;
mod notify;
mod routes;
mod state;
mod storage;
mod vapid;
mod ws;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};
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

/// Self-contained desktop browser-login bridge page. Served by the API host
/// itself (not the SPA) so it works in every deploy topology — including the
/// split deploy where the SPA lives on a different subdomain. The desktop app
/// opens `<server-url>/desktop-auth?state=&scheme=`; this page logs the user in,
/// mints a one-time code, and redirects to `sharp://auth?code=&state=`.
async fn desktop_auth_page() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("desktop_auth.html"))
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
        voice_rooms: Default::default(),
        doc_rooms: Default::default(),
        storage,
        vapid,
        desktop_codes: Default::default(),
        gif_suggest_cooldowns: Default::default(),
        duck_streaks: Default::default(),
        giphy_usage: Default::default(),
    });

    let api = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/desktop/code", post(auth::desktop_code))
        .route("/auth/desktop/exchange", post(auth::desktop_exchange))
        .route("/me", get(routes::users::me).patch(routes::users::update_me))
        .route(
            "/me/avatar",
            post(routes::users::upload_avatar)
                .layer(DefaultBodyLimit::max(upload_limit))
                .delete(routes::users::delete_avatar),
        )
        .route("/users", get(routes::users::list_users))
        .route("/users/:id/avatar", get(routes::users::get_avatar))
        .route("/gifs/config", get(routes::gifs::get_config))
        .route("/gifs/search", get(routes::gifs::search))
        .route(
            "/gifs/settings",
            get(routes::gifs::get_settings).put(routes::gifs::put_settings),
        )
        .route("/voice/config", get(routes::voice::voice_config))
        .route(
            "/channels",
            get(routes::channels::list_channels).post(routes::channels::create_channel),
        )
        .route("/channels/dm", post(routes::channels::create_dm))
        .route(
            "/channels/:id",
            patch(routes::channels::update_channel).delete(routes::channels::delete_channel),
        )
        .route("/channels/:id/join", post(routes::channels::join_channel))
        .route("/channels/:id/leave", post(routes::channels::leave_channel))
        .route(
            "/channels/:id/members",
            get(routes::channels::list_members).post(routes::channels::add_members),
        )
        .route(
            "/channels/:id/members/:user_id",
            delete(routes::channels::remove_member),
        )
        .route(
            "/channels/:id/members/:user_id/role",
            put(routes::channels::set_member_role),
        )
        .route("/channels/:id/read", post(routes::channels::mark_read))
        .route("/channels/:id/gif-suggest", post(routes::gifs::suggest))
        .route(
            "/channels/:id/gifs/suggest-voice",
            get(routes::gifs::suggest_voice),
        )
        .route(
            "/channels/:id/voice-link",
            get(routes::call_links::get_voice_link).post(routes::call_links::create_voice_link),
        )
        .route("/call-links/:token", get(routes::call_links::get_call_link))
        .route(
            "/call-links/:token/join",
            post(routes::call_links::join_call_link),
        )
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
            "/prefs/chat-layout",
            put(routes::notifications::set_chat_layout),
        )
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
        .route(
            "/push/expo/register",
            post(routes::notifications::expo_register),
        )
        .route(
            "/push/expo/unregister",
            post(routes::notifications::expo_unregister),
        )
        .route("/search", get(routes::search::search))
        // --- Phase 2: docs ---
        .route(
            "/channels/:id/docs",
            get(routes::docs::list_channel_docs).post(routes::docs::create_doc),
        )
        .route(
            "/channels/:id/docs/trash",
            get(routes::docs::list_channel_trash),
        )
        .route("/docs/search", get(routes::docs::search_docs))
        .route(
            "/docs/:id",
            get(routes::docs::get_doc)
                .patch(routes::docs::update_doc)
                .delete(routes::docs::delete_doc),
        )
        .route("/docs/:id/restore", post(routes::docs::restore_doc))
        .route(
            "/docs/:id/permanent",
            delete(routes::docs::permanent_delete_doc),
        )
        .route("/docs/:id/roles", get(routes::docs::list_roles))
        .route(
            "/docs/:id/roles/:user_id",
            put(routes::docs::set_role).delete(routes::docs::delete_role),
        )
        .route("/docs/:id/backlinks", get(routes::docs::backlinks))
        .route("/docs/:id/mentions", post(routes::docs::create_mention))
        .route("/docs/:id/sync", get(docs_sync::doc_sync_handler))
        .route(
            "/mentions",
            get(routes::docs::list_mentions),
        )
        .route("/mentions/read", post(routes::docs::read_mentions))
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler));

    let mut app: Router<state::SharedState> = Router::new()
        .nest("/api/v1", api)
        // Desktop browser-login bridge — served on the API host, SPA-independent.
        .route("/desktop-auth", get(desktop_auth_page));

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
