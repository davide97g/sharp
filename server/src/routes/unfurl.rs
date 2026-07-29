//! The two client-facing link-preview endpoints: the image proxy, and the
//! on-demand resolve that encrypted DMs need.
//!
//! Contract: docs/arch/01-core.md — "Link previews".
//!
//! ## The image proxy
//!
//! Card thumbnails and favicons are served through here rather than hot-linked
//! by the browser, for the same reason mail clients proxy images: a message can
//! otherwise make every reader's IP, user-agent and read-time visible to
//! whoever the link points at.
//!
//! Two properties keep this from being an open forward proxy:
//!
//!   1. The caller must be authenticated, and
//!   2. the URL must already appear as an `image_url`/`favicon_url` in
//!      `link_previews` — i.e. it is an asset the *server* discovered while
//!      unfurling, not an arbitrary address a client asked it to fetch.
//!
//! The fetch itself reuses `unfurl::fetch_guarded`, so it inherits the same
//! per-hop SSRF checks and body cap.

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::unfurl;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::Json;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use reqwest::Url;
use serde::Deserialize;

/// Cap for a proxied asset. Card images are thumbnails; anything larger is not
/// something we want to hold in memory or hand to a chat client.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Content types we are willing to hand back. SVG is excluded — it can carry
/// script, and it would be served from sharp's own origin.
const ALLOWED: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

#[derive(Deserialize)]
pub struct ImageQuery {
    pub url: String,
}

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub url: String,
}

/// Unfurl one URL on behalf of a client — the encrypted-DM path.
///
/// The server cannot read an E2EE message, so the client decrypts, extracts the
/// URLs itself and asks for them here. It sends only the URL, and the result is
/// not attached to any message: these cards are per-viewer, not part of the
/// conversation. Rate-limited per user so nobody can drive the server as a
/// crawler; the URL still goes through the same SSRF guards and cache.
pub async fn resolve(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<ResolveRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if !state.config.unfurl.enabled {
        return Err(AppError::NotFound("link previews are disabled".to_string()));
    }
    if !unfurl::allow_resolve(auth.id) {
        return Err(AppError::RateLimited(
            "too many link previews, slow down".to_string(),
        ));
    }
    let preview = unfurl::resolve_one(&state, &body.url).await?;
    Ok(Json(serde_json::json!({ "preview": preview })))
}

pub async fn image(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Query(q): Query<ImageQuery>,
) -> AppResult<Response> {
    if !state.config.unfurl.enabled {
        return Err(AppError::NotFound("link previews are disabled".to_string()));
    }
    if !unfurl::is_known_asset(&state.pool, &q.url).await? {
        return Err(AppError::NotFound("unknown preview asset".to_string()));
    }
    let url = Url::parse(&q.url).map_err(|_| AppError::BadRequest("invalid url".to_string()))?;

    let fetched = unfurl::fetch_guarded(
        &url,
        state.config.unfurl.allow_private,
        MAX_IMAGE_BYTES,
        "image/*",
    )
    .await
    .map_err(|reason| {
        tracing::debug!(url = %q.url, reason, "preview image fetch failed");
        AppError::NotFound("preview image unavailable".to_string())
    })?;

    let mime = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !ALLOWED.contains(&mime.as_str()) {
        return Err(AppError::NotFound("unsupported image type".to_string()));
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&mime)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        )
        .header(header::CONTENT_LENGTH, fetched.body.len())
        .header(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        )
        .header(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; sandbox"),
        )
        .header(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=86400"),
        )
        .body(Body::from(fetched.body))
        .map_err(|e| AppError::Internal(format!("response build: {e}")))
}
