use crate::auth::AuthUser;
use crate::deepseek;
use crate::error::{AppError, AppResult};
use crate::gif::{self, GifResult, GifSettings};
use crate::routes::{channel_kind, is_member};
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope, voice};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use std::time::{Duration, Instant};
use uuid::Uuid;

const COOLDOWN_RETENTION: Duration = Duration::from_secs(900);

pub(crate) fn try_acquire_suggestion_cooldown(
    state: &SharedState,
    channel_id: Uuid,
    cooldown_secs: u64,
) -> AppResult<bool> {
    let cooldown = Duration::from_secs(cooldown_secs);
    let now = Instant::now();
    let mut cooldowns = state
        .gif_suggest_cooldowns
        .lock()
        .map_err(|_| AppError::Internal("gif_suggest_cooldowns lock poisoned".to_string()))?;
    cooldowns.retain(|_, last_attempt| now.duration_since(*last_attempt) < COOLDOWN_RETENTION);
    if cooldowns
        .get(&channel_id)
        .is_some_and(|last_attempt| now.duration_since(*last_attempt) < cooldown)
    {
        return Ok(false);
    }
    cooldowns.insert(channel_id, now);
    Ok(true)
}

#[derive(Serialize)]
pub struct GifConfigResponse {
    enabled: bool,
    duck: bool,
    provider: String,
    duck_cooldown_secs: u64,
    duck_context: String,
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
        duck_cooldown_secs: settings.duck_cooldown_secs,
        duck_context: settings.duck_context,
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
    maybe_acquire_giphy(&state, &settings.provider)?;
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
    duck_cooldown_secs: u64,
    duck_context: String,
    deepseek_configured: bool,
    /// Sliding-hour self-enforced GIPHY search usage (100/h).
    giphy_usage: gif::GiphyUsageSnapshot,
}

fn settings_response(state: &SharedState, settings: GifSettings) -> GifSettingsResponse {
    GifSettingsResponse {
        provider: settings.provider,
        has_api_key: settings.api_key.is_some(),
        duck_enabled: settings.duck_enabled,
        duck_cooldown_secs: settings.duck_cooldown_secs,
        duck_context: settings.duck_context,
        deepseek_configured: state.config.deepseek.is_some(),
        giphy_usage: giphy_usage_snapshot(state),
    }
}

fn giphy_usage_snapshot(state: &SharedState) -> gif::GiphyUsageSnapshot {
    match state.giphy_usage.lock() {
        Ok(mut usage) => usage.snapshot(),
        Err(_) => gif::GiphyUsageSnapshot {
            used: 0,
            limit: gif::GIPHY_HOURLY_LIMIT,
            resets_at: None,
        },
    }
}

fn acquire_giphy_slot(state: &SharedState) -> AppResult<()> {
    let mut usage = state
        .giphy_usage
        .lock()
        .map_err(|_| AppError::Internal("giphy_usage lock poisoned".to_string()))?;
    usage.try_acquire().map(|_| ()).map_err(|snapshot| {
        AppError::RateLimited(format!(
            "GIPHY hourly limit reached ({}/{}). Try again after the window resets.",
            snapshot.used, snapshot.limit
        ))
    })
}

/// Reserve a GIPHY quota slot when the active provider is GIPHY.
fn maybe_acquire_giphy(state: &SharedState, provider: &str) -> AppResult<()> {
    if provider == "giphy" {
        acquire_giphy_slot(state)?;
    }
    Ok(())
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
    duck_cooldown_secs: Option<u64>,
    duck_context: Option<String>,
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
    if let Some(secs) = body.duck_cooldown_secs {
        if gif::parse_duck_cooldown_secs(Some(&secs.to_string())).is_none() {
            return Err(AppError::BadRequest(
                "duck_cooldown_secs must be 30, 60, 120, or 300".to_string(),
            ));
        }
    }
    let duck_context = body.duck_context.as_deref();
    if duck_context.is_some_and(|context| !matches!(context, "1m" | "2m" | "3m")) {
        return Err(AppError::BadRequest(
            "duck_context must be 1m, 2m, or 3m".to_string(),
        ));
    }
    gif::save_settings(
        &state.pool,
        body.provider.as_deref(),
        body.api_key.as_deref(),
        body.duck_enabled,
        body.duck_cooldown_secs,
        duck_context,
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

    if !try_acquire_suggestion_cooldown(&state, channel_id, settings.duck_cooldown_secs)? {
        return Ok(empty_suggestion());
    }

    let transcript = load_transcript(&state, channel_id, &settings.duck_context).await?;
    if transcript.len() < 2 {
        return Ok(empty_suggestion());
    }

    let (query, results) =
        suggest_best_gif(&state, &settings.provider, deepseek_config, provider.as_ref(), &transcript)
            .await?;

    // Someone pulled the trigger — clear the shared streak for every member.
    gif::reset_streak(&state.duck_streaks, channel_id);
    let targets = channel_member_ids(&state.pool, channel_id).await?;
    let reset = envelope(
        "duck.streak",
        json!({
            "channel_id": channel_id,
            "duck_streak": gif::empty_streak_snapshot(),
        }),
    );
    state.hub.broadcast(reset, targets).await;

    Ok(Json(json!({ "query": query, "results": results })))
}

pub async fn suggest_voice(
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
    let deepseek_config = state
        .config
        .deepseek
        .as_ref()
        .ok_or_else(|| AppError::ServiceUnavailable("gif suggestion not configured".to_string()))?;

    if !try_acquire_suggestion_cooldown(&state, channel_id, settings.duck_cooldown_secs)? {
        return Ok(empty_suggestion());
    }

    let minutes = gif::duck_context_minutes(&settings.duck_context);
    let transcript = voice::snapshot_transcript(&state, channel_id, minutes);
    if transcript.len() < 2 {
        return Ok(empty_suggestion());
    }

    let (query, results) =
        suggest_best_gif(&state, &settings.provider, deepseek_config, provider.as_ref(), &transcript)
            .await?;

    voice::consume_roast_armed(&state, channel_id);
    voice::broadcast_roast_armed(&state, channel_id, false).await;

    Ok(Json(json!({ "query": query, "results": results })))
}

/// Query → multi-search → soft-rank → LLM pick (with one retry on junk-heavy results).
pub(crate) async fn suggest_best_gif(
    state: &SharedState,
    provider_name: &str,
    deepseek_config: &crate::config::DeepSeekConfig,
    provider: &dyn gif::GifProvider,
    transcript: &[(String, String)],
) -> AppResult<(String, Vec<GifResult>)> {
    let mut query = deepseek::suggest_query(deepseek_config, transcript)
        .await
        .map_err(|error| {
            tracing::warn!("GIF suggestion failed: {}", error);
            AppError::ServiceUnavailable("suggestion failed".to_string())
        })?;

    let mut ranked = search_and_rank(state, provider_name, provider, &query, transcript).await?;
    if gif::needs_query_retry(&ranked) {
        // One retry when the top hit looks like watermark/spam junk.
        if let Ok(retry_query) = deepseek::suggest_query(deepseek_config, transcript).await {
            if retry_query != query {
                if let Ok(retry_ranked) =
                    search_and_rank(state, provider_name, provider, &retry_query, transcript).await
                {
                    if !retry_ranked.is_empty() {
                        query = retry_query;
                        ranked = retry_ranked;
                    }
                }
            }
        }
    }

    if ranked.is_empty() {
        return Err(AppError::ServiceUnavailable("gif search failed".to_string()));
    }

    let pick_n = ranked.len().min(gif::SUGGEST_PICK_CANDIDATES);
    let candidates = &ranked[..pick_n];
    let best = match deepseek::pick_gif(deepseek_config, transcript, &query, candidates).await {
        Ok(Some(id)) => candidates
            .iter()
            .find(|gif| gif.id == id)
            .cloned()
            .unwrap_or_else(|| candidates[0].clone()),
        Ok(None) => {
            tracing::info!("GIF pick returned unknown id; using local rank #1");
            candidates[0].clone()
        }
        Err(error) => {
            tracing::warn!("GIF pick failed, using local rank #1: {}", error);
            candidates[0].clone()
        }
    };

    Ok((query, vec![best]))
}

async fn search_and_rank(
    state: &SharedState,
    provider_name: &str,
    provider: &dyn gif::GifProvider,
    query: &str,
    transcript: &[(String, String)],
) -> AppResult<Vec<GifResult>> {
    maybe_acquire_giphy(state, provider_name)?;
    let results = provider
        .search(query, gif::SUGGEST_SEARCH_LIMIT)
        .await
        .map_err(|error| {
            tracing::warn!("GIF suggestion search failed: {}", error);
            AppError::ServiceUnavailable("gif search failed".to_string())
        })?;
    Ok(gif::rank_suggest_candidates(results, query, transcript))
}

async fn load_transcript(
    state: &SharedState,
    channel_id: Uuid,
    duck_context: &str,
) -> AppResult<Vec<(String, String)>> {
    let minutes = gif::duck_context_minutes(duck_context);
    let rows = sqlx::query(
        "SELECT u.display_name, m.content
         FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1
           AND m.parent_id IS NULL
           AND m.deleted_at IS NULL
           AND m.content <> ''
           AND m.created_at >= NOW() - ($2 * INTERVAL '1 minute')
         ORDER BY m.id DESC
         LIMIT 40",
    )
    .bind(channel_id)
    .bind(minutes)
    .fetch_all(&state.pool)
    .await?;

    let mut messages: Vec<(String, String)> = rows
        .into_iter()
        .filter_map(|row| {
            let display_name: String = row.try_get("display_name").ok()?;
            let content: String = row.try_get("content").ok()?;
            if content.trim().is_empty() || gif::is_duck_roast_gif(&content) {
                // Skip duck-automation roasts so they aren't fed back into the next pick.
                None
            } else {
                Some((display_name, content))
            }
        })
        .collect();

    messages.reverse();
    Ok(messages)
}

pub(crate) async fn load_recent_messages(
    state: &SharedState,
    channel_id: Uuid,
    limit: i64,
) -> AppResult<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT u.display_name, m.content
         FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1
           AND m.parent_id IS NULL
           AND m.deleted_at IS NULL
           AND m.content <> ''
         ORDER BY m.id DESC
         LIMIT $2",
    )
    .bind(channel_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let mut messages: Vec<(String, String)> = rows
        .into_iter()
        .filter_map(|row| {
            let display_name: String = row.try_get("display_name").ok()?;
            let content: String = row.try_get("content").ok()?;
            if content.trim().is_empty() || gif::is_duck_roast_gif(&content) {
                None
            } else {
                Some((display_name, content))
            }
        })
        .collect();
    messages.reverse();
    Ok(messages)
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
