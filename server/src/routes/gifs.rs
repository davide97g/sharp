use crate::auth::AuthUser;
use crate::deepseek;
use crate::error::{AppError, AppResult};
use crate::gif::{self, GifResult, GifSettings};
use crate::routes::{channel_kind, is_member};
use crate::state::SharedState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use std::time::{Duration, Instant};
use uuid::Uuid;

const SUGGEST_COOLDOWN: Duration = Duration::from_secs(120);
const COOLDOWN_RETENTION: Duration = Duration::from_secs(600);

#[derive(Serialize)]
pub struct GifConfigResponse {
    enabled: bool,
    duck: bool,
    provider: String,
}

pub async fn get_config(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<GifConfigResponse>> {
    let settings = gif::load_settings(&state.pool, &state.config).await;
    let enabled = gif::resolve_provider(&settings).is_some();
    Ok(Json(GifConfigResponse {
        enabled,
        duck: duck_enabled(&state, &settings, enabled),
        provider: settings.provider,
    }))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    limit: Option<i64>,
}

pub async fn search(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Query(params): Query<SearchQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let query = params.q.as_deref().map(str::trim).unwrap_or_default();
    if query.is_empty() {
        return Err(AppError::BadRequest("q must not be empty".to_string()));
    }
    let limit = params.limit.unwrap_or(24).clamp(1, 30) as u8;
    let settings = gif::load_settings(&state.pool, &state.config).await;
    let provider = gif::resolve_provider(&settings)
        .ok_or_else(|| AppError::ServiceUnavailable("gif provider not configured".to_string()))?;
    let results = provider.search(query, limit).await.map_err(|error| {
        tracing::warn!("GIF search failed: {}", error);
        AppError::ServiceUnavailable("gif search failed".to_string())
    })?;
    Ok(Json(json!({ "results": results })))
}

#[derive(Serialize)]
pub struct GifSettingsResponse {
    provider: String,
    has_api_key: bool,
    duck_enabled: bool,
    deepseek_configured: bool,
}

fn settings_response(state: &SharedState, settings: GifSettings) -> GifSettingsResponse {
    GifSettingsResponse {
        provider: settings.provider,
        has_api_key: settings.api_key.is_some(),
        duck_enabled: settings.duck_enabled,
        deepseek_configured: state.config.deepseek.is_some(),
    }
}

pub async fn get_settings(
    State(state): State<SharedState>,
    _auth: AuthUser,
) -> AppResult<Json<GifSettingsResponse>> {
    let settings = gif::load_settings(&state.pool, &state.config).await;
    Ok(Json(settings_response(&state, settings)))
}

#[derive(Deserialize)]
pub struct PutSettingsRequest {
    provider: Option<String>,
    api_key: Option<String>,
    duck_enabled: Option<bool>,
}

pub async fn put_settings(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Json(body): Json<PutSettingsRequest>,
) -> AppResult<Json<GifSettingsResponse>> {
    if body
        .provider
        .as_deref()
        .is_some_and(|provider| !matches!(provider, "tenor" | "giphy"))
    {
        return Err(AppError::BadRequest(
            "provider must be tenor or giphy".to_string(),
        ));
    }
    gif::save_settings(
        &state.pool,
        body.provider.as_deref(),
        body.api_key.as_deref(),
        body.duck_enabled,
    )
    .await?;
    let settings = gif::load_settings(&state.pool, &state.config).await;
    Ok(Json(settings_response(&state, settings)))
}

pub async fn suggest(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    require_member(&state, channel_id, auth.id).await?;

    let settings = gif::load_settings(&state.pool, &state.config).await;
    let enabled = gif::resolve_provider(&settings).is_some();
    if !duck_enabled(&state, &settings, enabled) {
        return Err(AppError::ServiceUnavailable(
            "gif suggestion not configured".to_string(),
        ));
    }
    let provider = gif::resolve_provider(&settings)
        .ok_or_else(|| AppError::ServiceUnavailable("gif suggestion not configured".to_string()))?;
    let deepseek_config =
        state.config.deepseek.as_ref().ok_or_else(|| {
            AppError::ServiceUnavailable("gif suggestion not configured".to_string())
        })?;

    let rows = sqlx::query(
        "SELECT u.display_name, m.content
         FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1
           AND m.parent_id IS NULL
           AND m.deleted_at IS NULL
           AND m.content <> ''
         ORDER BY m.id DESC
         LIMIT 15",
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?;
    let mut transcript: Vec<(String, String)> = rows
        .into_iter()
        .filter_map(|row| {
            let display_name: String = row.try_get("display_name").ok()?;
            let content: String = row.try_get("content").ok()?;
            if content.trim().is_empty() {
                None
            } else {
                Some((display_name, content))
            }
        })
        .collect();
    if transcript.len() < 2 {
        return Ok(empty_suggestion());
    }
    transcript.reverse();

    let now = Instant::now();
    {
        let mut cooldowns = state
            .gif_suggest_cooldowns
            .lock()
            .map_err(|_| AppError::Internal("gif_suggest_cooldowns lock poisoned".to_string()))?;
        cooldowns.retain(|_, last_attempt| now.duration_since(*last_attempt) < COOLDOWN_RETENTION);
        if cooldowns
            .get(&channel_id)
            .is_some_and(|last_attempt| now.duration_since(*last_attempt) < SUGGEST_COOLDOWN)
        {
            return Ok(empty_suggestion());
        }
        cooldowns.insert(channel_id, now);
    }

    let query = deepseek::suggest_query(deepseek_config, &transcript)
        .await
        .map_err(|error| {
            tracing::warn!("GIF suggestion failed: {}", error);
            AppError::ServiceUnavailable("suggestion failed".to_string())
        })?;
    let results = provider.search(&query, 12).await.map_err(|error| {
        tracing::warn!("GIF suggestion search failed: {}", error);
        AppError::ServiceUnavailable("gif search failed".to_string())
    })?;
    Ok(Json(json!({ "query": query, "results": results })))
}

fn duck_enabled(state: &SharedState, settings: &GifSettings, provider_enabled: bool) -> bool {
    provider_enabled && state.config.deepseek.is_some() && settings.duck_enabled
}

fn empty_suggestion() -> Json<serde_json::Value> {
    Json(json!({
        "query": Option::<String>::None,
        "results": Vec::<GifResult>::new(),
    }))
}

async fn require_member(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(&state.pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
    }
    Ok(())
}
