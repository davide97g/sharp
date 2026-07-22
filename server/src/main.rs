mod ai;
mod apns;
mod auth;
mod calendar_crypto;
mod calendar_sync;
mod config;
mod deepseek;
mod docs_sync;
mod error;
mod expo_push;
mod gif;
mod google_oauth;
mod livekit;
mod models;
mod notify;
mod passkeys;
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
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Cache policy for the built-in SPA (mirrors deploy/nginx.web.conf in the
/// split deploy): hashed `/assets/*` are immutable and cached hard; everything
/// else (index.html, sw.js, manifest, icons) must revalidate so a fresh deploy
/// is picked up immediately instead of a browser-cached previous version.
/// API responses are left untouched.
async fn spa_cache_control(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header::CACHE_CONTROL, HeaderValue};
    let path = req.uri().path();
    let skip = path.starts_with("/api/");
    let immutable = path.starts_with("/assets/");
    let mut res = next.run(req).await;
    if !skip && !res.headers().contains_key(CACHE_CONTROL) {
        res.headers_mut().insert(
            CACHE_CONTROL,
            HeaderValue::from_static(if immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            }),
        );
    }
    res
}

/// Self-contained desktop browser-login bridge page. Served by the API host
/// itself (not the SPA) so it works in every deploy topology — including the
/// split deploy where the SPA lives on a different subdomain. The desktop app
/// opens `<server-url>/desktop-auth?state=&scheme=`; this page logs the user in,
/// mints a one-time code, and redirects to `sharp://auth?code=&state=`.
async fn desktop_auth_page() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("desktop_auth.html"))
}

async fn passkey_settings_page() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("passkey_settings.html"))
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
        if vapid.is_some() {
            "enabled"
        } else {
            "disabled"
        }
    );

    tracing::info!(
        "apns push {}",
        if config.apns.is_some() {
            "enabled"
        } else {
            "disabled"
        }
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
    let webauthn = passkeys::build_webauthn(&config)?;

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
        webauthn,
    });

    // Heartbeats distinguish quiet live calls from records orphaned by a process
    // crash. Delay recovery so other replicas have time to refresh their rooms.
    let meeting_state = app_state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        loop {
            if let Err(error) = routes::meetings::heartbeat_live_meetings(&meeting_state).await {
                tracing::warn!("meeting heartbeat failed: {}", error);
            }
            if let Err(error) = routes::meetings::recover_interrupted_meetings(&meeting_state).await
            {
                tracing::warn!("meeting recovery failed: {}", error);
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    // Calendar reminder scheduler: 30s tick fires lead/start reminders for both
    // native scheduled meetings and Google events via atomic claim queries.
    let reminder_state = app_state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = calendar_sync::reminder_tick(&reminder_state).await {
                tracing::warn!("calendar reminder tick failed: {}", error);
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    let poll_expiry_state = app_state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = routes::polls::expire_tick(&poll_expiry_state).await {
                tracing::warn!("poll expiry tick failed: {}", error);
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    // Sharpy embedder: 15s tick that backfills message embeddings and re-embeds
    // changed docs. Only runs when the AI assistant is configured.
    if app_state.config.ai.is_some() {
        let embed_state = app_state.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = routes::sharpy::embed_tick(&embed_state).await {
                    tracing::warn!("sharpy embed tick failed: {}", error);
                }
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
        });
    }

    // Google Calendar sync poller: 5-minute rolling-window refresh of every active
    // connection. Only runs when Google OAuth is configured.
    if app_state.config.google.is_some() {
        let poller_state = app_state.clone();
        tokio::spawn(async move {
            loop {
                calendar_sync::poll_active_accounts(&poller_state).await;
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            }
        });
    }

    let api = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/desktop/code", post(auth::desktop_code))
        .route("/auth/desktop/exchange", post(auth::desktop_exchange))
        .route("/auth/passkeys/config", get(passkeys::config))
        .route("/auth/passkeys/login/start", post(passkeys::login_start))
        .route("/auth/passkeys/login/finish", post(passkeys::login_finish))
        .route(
            "/auth/passkeys",
            get(passkeys::list).post(passkeys::register_start),
        )
        .route(
            "/auth/passkeys/register/finish",
            post(passkeys::register_finish),
        )
        .route(
            "/auth/passkeys/:id",
            patch(passkeys::rename).delete(passkeys::remove),
        )
        .route(
            "/auth/passkeys/prompt/dismiss",
            post(passkeys::dismiss_prompt),
        )
        .route("/auth/passkeys/manage/start", post(passkeys::manage_start))
        .route(
            "/auth/passkeys/manage/exchange",
            post(passkeys::manage_exchange),
        )
        .route(
            "/me",
            get(routes::users::me).patch(routes::users::update_me),
        )
        .route(
            "/me/avatar",
            post(routes::users::upload_avatar)
                .layer(DefaultBodyLimit::max(upload_limit))
                .delete(routes::users::delete_avatar),
        )
        .route("/users", get(routes::users::list_users))
        .route("/users/:id/avatar", get(routes::users::get_avatar))
        .route("/me/nicknames", get(routes::users::list_nicknames))
        .route(
            "/users/:id/nickname",
            put(routes::users::set_nickname).delete(routes::users::delete_nickname),
        )
        .route(
            "/e2ee/devices",
            get(routes::e2ee::list_devices).post(routes::e2ee::put_device),
        )
        .route("/e2ee/devices/:id", delete(routes::e2ee::delete_device))
        .route(
            "/e2ee/backup",
            get(routes::e2ee::get_backup).put(routes::e2ee::put_backup),
        )
        .route("/gifs/config", get(routes::gifs::get_config))
        .route("/gifs/search", get(routes::gifs::search))
        .route(
            "/gifs/settings",
            get(routes::gifs::get_settings).put(routes::gifs::put_settings),
        )
        .route("/voice/config", get(routes::voice::voice_config))
        .route(
            "/voice/transcriptions",
            post(routes::voice::transcribe_audio).layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route(
            "/voice/triggers",
            get(routes::voice_triggers::list_personal)
                .post(routes::voice_triggers::create_personal),
        )
        .route(
            "/voice/triggers/:id",
            delete(routes::voice_triggers::delete_personal),
        )
        .route("/calls", post(routes::call_links::create_standalone_call))
        .route("/meetings", get(routes::meetings::list_meetings))
        .route(
            "/meetings/:id",
            get(routes::meetings::get_meeting)
                .patch(routes::meetings::update_meeting)
                .delete(routes::meetings::delete_meeting),
        )
        .route("/meetings/:id/actions", put(routes::meetings::save_actions))
        .route(
            "/meetings/:id/regenerate",
            post(routes::meetings::regenerate_meeting),
        )
        // --- Phase 5: calendar ---
        .route(
            "/calendar/connections",
            get(routes::calendar::list_connections),
        )
        .route(
            "/calendar/connections/:id",
            delete(routes::calendar::disconnect),
        )
        .route(
            "/calendar/google/connect",
            get(routes::calendar::google_connect),
        )
        .route(
            "/calendar/google/callback",
            get(routes::calendar::google_callback),
        )
        .route(
            "/calendar/calendars/:id",
            patch(routes::calendar::set_calendar_selected),
        )
        .route("/calendar/sync", post(routes::calendar::sync_now))
        .route("/calendar/events", get(routes::calendar::list_events))
        .route("/calendar/meetings", post(routes::calendar::create_meeting))
        .route(
            "/calendar/meetings/:id",
            get(routes::calendar::get_meeting)
                .patch(routes::calendar::update_meeting)
                .delete(routes::calendar::cancel_meeting),
        )
        .route("/calendar/meetings/:id/rsvp", post(routes::calendar::rsvp))
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
        .route(
            "/channels/:id/voice-triggers",
            get(routes::voice_triggers::list_channel).post(routes::voice_triggers::create_channel),
        )
        .route(
            "/channels/:id/voice-triggers/:trigger_id",
            delete(routes::voice_triggers::delete_channel),
        )
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
        .route(
            "/channels/:id/polls",
            get(routes::polls::list_polls).post(routes::polls::create_poll),
        )
        .route(
            "/polls/:id",
            get(routes::polls::get_poll).delete(routes::polls::delete_poll),
        )
        .route(
            "/polls/:id/vote",
            post(routes::polls::vote).delete(routes::polls::retract_vote),
        )
        .route("/polls/:id/close", post(routes::polls::close_poll))
        .route("/polls/:id/pin", post(routes::polls::pin_poll))
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
        .route(
            "/notifications/read",
            post(routes::notifications::mark_read),
        )
        .route(
            "/prefs",
            get(routes::notifications::get_prefs).put(routes::notifications::set_prefs),
        )
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
        .route(
            "/push/apns/register",
            post(routes::notifications::apns_register),
        )
        .route(
            "/push/apns/unregister",
            post(routes::notifications::apns_unregister),
        )
        .route("/search", get(routes::search::search))
        // --- Tasks (Linear-lite planner) ---
        .route(
            "/projects",
            get(routes::tasks::list_projects).post(routes::tasks::create_project),
        )
        .route("/projects/:id", patch(routes::tasks::update_project))
        .route(
            "/projects/:id/tasks",
            get(routes::tasks::list_tasks).post(routes::tasks::create_task),
        )
        .route("/tasks/search", get(routes::tasks::search_tasks))
        .route(
            "/tasks/by-key/:identifier",
            get(routes::tasks::get_task_by_key),
        )
        .route(
            "/tasks/:id",
            get(routes::tasks::get_task)
                .patch(routes::tasks::update_task)
                .delete(routes::tasks::delete_task),
        )
        .route(
            "/tasks/:id/comments",
            post(routes::tasks::create_comment),
        )
        .route(
            "/task-comments/:id",
            patch(routes::tasks::update_comment).delete(routes::tasks::delete_comment),
        )
        .route("/me/tasks", get(routes::tasks::my_tasks))
        .route(
            "/task-labels",
            get(routes::tasks::list_labels).post(routes::tasks::create_label),
        )
        .route(
            "/task-labels/:id",
            patch(routes::tasks::update_label).delete(routes::tasks::delete_label),
        )
        .route(
            "/integrations/github/webhook",
            post(routes::github::webhook),
        )
        // --- Sharpy AI assistant ---
        .route("/sharpy/status", get(routes::sharpy::status))
        .route(
            "/sharpy/conversations",
            get(routes::sharpy::list_conversations).post(routes::sharpy::create_conversation),
        )
        .route(
            "/sharpy/conversations/:id",
            get(routes::sharpy::get_conversation).delete(routes::sharpy::delete_conversation),
        )
        .route(
            "/sharpy/conversations/:id/messages",
            post(routes::sharpy::send_message),
        )
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
        .route(
            "/docs/:id/uploads",
            post(routes::files::upload_doc_image).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/docs/:id/sync", get(docs_sync::doc_sync_handler))
        .route("/mentions", get(routes::docs::list_mentions))
        .route("/mentions/read", post(routes::docs::read_mentions))
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler));

    let mut app: Router<state::SharedState> = Router::new()
        .nest("/api/v1", api)
        // Desktop browser-login bridge — served on the API host, SPA-independent.
        .route("/desktop-auth", get(desktop_auth_page))
        .route("/passkey-settings", get(passkey_settings_page));

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
        .layer(axum::middleware::from_fn(spa_cache_control))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("sharp-server listening on {}", addr);

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
