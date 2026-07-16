use crate::config::Config;
use anyhow::anyhow;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

const TENOR_SEARCH_URL: &str = "https://tenor.googleapis.com/v2/search";
const GIPHY_SEARCH_URL: &str = "https://api.giphy.com/v1/gifs/search";
const META_PROVIDER: &str = "gif.provider";
const META_API_KEY: &str = "gif.api_key";
const META_DUCK_ENABLED: &str = "gif.duck_enabled";
const META_DUCK_COOLDOWN_SECS: &str = "gif.duck_cooldown_secs";
const META_DUCK_CONTEXT: &str = "gif.duck_context";

pub const DUCK_COOLDOWN_OPTIONS: &[u64] = &[30, 60, 120, 300];
pub const DEFAULT_DUCK_COOLDOWN_SECS: u64 = 120;
pub const DEFAULT_DUCK_CONTEXT: &str = "streak";
/// Max gap between consecutive messages that still counts as one fast streak.
pub const STREAK_GAP_SECS: i64 = 20;

#[derive(Clone, Copy)]
pub struct DuckStreakEntry {
    pub count: u32,
    pub last_at: Instant,
}

/// Per-channel shared duck streak. Per-replica in-memory (same as voice rooms).
pub type DuckStreaks = Mutex<HashMap<Uuid, DuckStreakEntry>>;

#[derive(Serialize, Clone)]
pub struct DuckStreakSnapshot {
    pub count: u32,
    pub last_at: DateTime<Utc>,
}

/// True when the message is only a GIF token (don't let roast GIFs re-boost the streak).
pub fn is_standalone_gif(content: &str) -> bool {
    let trimmed = content.trim();
    if !trimmed.starts_with("[[gif:") || !trimmed.ends_with("]]") {
        return false;
    }
    trimmed.matches("[[gif:").count() == 1
}

/// Bump the shared channel streak for a top-level chat message from any member.
pub fn bump_streak(streaks: &DuckStreaks, channel_id: Uuid) -> DuckStreakSnapshot {
    let now = Instant::now();
    let gap = Duration::from_secs(STREAK_GAP_SECS as u64);
    let mut map = streaks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = match map.get(&channel_id) {
        Some(entry) if now.duration_since(entry.last_at) <= gap => entry.count.saturating_add(1),
        _ => 1,
    };
    map.insert(
        channel_id,
        DuckStreakEntry {
            count,
            last_at: now,
        },
    );
    DuckStreakSnapshot {
        count,
        last_at: Utc::now(),
    }
}

pub fn reset_streak(streaks: &DuckStreaks, channel_id: Uuid) {
    let mut map = streaks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.remove(&channel_id);
}

pub fn empty_streak_snapshot() -> DuckStreakSnapshot {
    DuckStreakSnapshot {
        count: 0,
        last_at: Utc::now(),
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Serialize, Clone)]
pub struct GifResult {
    pub id: String,
    pub url: String,
    pub preview_url: String,
    pub width: i32,
    pub height: i32,
    pub title: String,
}

#[async_trait]
pub trait GifProvider: Send + Sync {
    async fn search(&self, q: &str, limit: u8) -> anyhow::Result<Vec<GifResult>>;
}

pub struct Tenor {
    api_key: String,
}

#[derive(Deserialize)]
struct TenorResponse {
    results: Vec<TenorResult>,
}

#[derive(Deserialize)]
struct TenorResult {
    id: String,
    #[serde(default)]
    content_description: String,
    media_formats: TenorMediaFormats,
}

#[derive(Deserialize)]
struct TenorMediaFormats {
    gif: Option<TenorMedia>,
    tinygif: Option<TenorMedia>,
}

#[derive(Deserialize)]
struct TenorMedia {
    url: String,
    dims: [i32; 2],
}

#[async_trait]
impl GifProvider for Tenor {
    async fn search(&self, q: &str, limit: u8) -> anyhow::Result<Vec<GifResult>> {
        let params = [
            ("q", q.to_string()),
            ("key", self.api_key.clone()),
            ("limit", limit.to_string()),
            ("media_filter", "gif,tinygif".to_string()),
            ("contentfilter", "medium".to_string()),
        ];
        let response = tokio::time::timeout(Duration::from_secs(10), async {
            client()
                .get(TENOR_SEARCH_URL)
                .query(&params)
                .send()
                .await?
                .error_for_status()?
                .json::<TenorResponse>()
                .await
        })
        .await
        .map_err(|_| anyhow!("tenor search timed out"))??;

        Ok(response
            .results
            .into_iter()
            .filter_map(|result| {
                let gif = result.media_formats.gif?;
                let preview_url = result
                    .media_formats
                    .tinygif
                    .map(|media| media.url)
                    .unwrap_or_else(|| gif.url.clone());
                Some(GifResult {
                    id: result.id,
                    url: gif.url,
                    preview_url,
                    width: gif.dims[0],
                    height: gif.dims[1],
                    title: result.content_description,
                })
            })
            .collect())
    }
}

pub struct Giphy {
    api_key: String,
}

#[derive(Deserialize)]
struct GiphyResponse {
    data: Vec<GiphyResult>,
}

#[derive(Deserialize)]
struct GiphyResult {
    id: String,
    #[serde(default)]
    title: String,
    images: Option<GiphyImages>,
}

#[derive(Deserialize)]
struct GiphyImages {
    original: Option<GiphyImage>,
    fixed_width: Option<GiphyImage>,
}

#[derive(Deserialize)]
struct GiphyImage {
    #[serde(default)]
    url: String,
    #[serde(default)]
    width: String,
    #[serde(default)]
    height: String,
}

#[async_trait]
impl GifProvider for Giphy {
    async fn search(&self, q: &str, limit: u8) -> anyhow::Result<Vec<GifResult>> {
        let params = [
            ("api_key", self.api_key.clone()),
            ("q", q.to_string()),
            ("limit", limit.to_string()),
            ("rating", "pg-13".to_string()),
            ("lang", "en".to_string()),
        ];
        let response = tokio::time::timeout(Duration::from_secs(10), async {
            client()
                .get(GIPHY_SEARCH_URL)
                .query(&params)
                .send()
                .await?
                .error_for_status()?
                .json::<GiphyResponse>()
                .await
        })
        .await
        .map_err(|_| anyhow!("giphy search timed out"))??;

        Ok(response
            .data
            .into_iter()
            .filter_map(|result| {
                let images = result.images?;
                let original = images.original?;
                if original.url.is_empty() {
                    return None;
                }
                let preview_url = images
                    .fixed_width
                    .map(|image| image.url)
                    .filter(|url| !url.is_empty())
                    .unwrap_or_else(|| original.url.clone());
                Some(GifResult {
                    id: result.id,
                    url: original.url,
                    preview_url,
                    width: original.width.parse().unwrap_or_default(),
                    height: original.height.parse().unwrap_or_default(),
                    title: result.title,
                })
            })
            .collect())
    }
}

pub struct GifSettings {
    pub provider: String,
    pub api_key: Option<String>,
    pub duck_enabled: bool,
    pub duck_cooldown_secs: u64,
    pub duck_context: String,
}

pub fn parse_duck_cooldown_secs(raw: Option<&str>) -> Option<u64> {
    let secs = raw?.trim().parse::<u64>().ok()?;
    DUCK_COOLDOWN_OPTIONS.contains(&secs).then_some(secs)
}

pub fn parse_duck_context(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    match value {
        "streak" | "1m" | "2m" | "3m" => Some(value.to_string()),
        _ => None,
    }
}

pub async fn load_settings(pool: &PgPool, config: &Config) -> GifSettings {
    let keys = vec![
        META_PROVIDER.to_string(),
        META_API_KEY.to_string(),
        META_DUCK_ENABLED.to_string(),
        META_DUCK_COOLDOWN_SECS.to_string(),
        META_DUCK_CONTEXT.to_string(),
    ];
    let rows = match sqlx::query("SELECT key, value FROM app_meta WHERE key = ANY($1)")
        .bind(keys)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!("GIF settings: load failed: {}", error);
            Vec::new()
        }
    };
    let values: HashMap<String, String> = rows
        .into_iter()
        .filter_map(|row| Some((row.try_get("key").ok()?, row.try_get("value").ok()?)))
        .collect();

    let provider = values
        .get(META_PROVIDER)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "giphy".to_string());
    let api_key = values
        .get(META_API_KEY)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| match provider.as_str() {
            "giphy" => config.giphy_api_key.clone(),
            "tenor" => config.tenor_api_key.clone(),
            _ => None,
        });
    let duck_enabled = values
        .get(META_DUCK_ENABLED)
        .map(|value| value == "true")
        .unwrap_or(true);
    let duck_cooldown_secs = parse_duck_cooldown_secs(
        values.get(META_DUCK_COOLDOWN_SECS).map(String::as_str),
    )
    .unwrap_or(DEFAULT_DUCK_COOLDOWN_SECS);
    let duck_context = parse_duck_context(values.get(META_DUCK_CONTEXT).map(String::as_str))
        .unwrap_or_else(|| DEFAULT_DUCK_CONTEXT.to_string());

    GifSettings {
        provider,
        api_key,
        duck_enabled,
        duck_cooldown_secs,
        duck_context,
    }
}

pub async fn save_settings(
    pool: &PgPool,
    provider: Option<&str>,
    api_key: Option<&str>,
    duck_enabled: Option<bool>,
    duck_cooldown_secs: Option<u64>,
    duck_context: Option<&str>,
) -> Result<(), sqlx::Error> {
    if let Some(provider) = provider {
        set_meta(pool, META_PROVIDER, provider).await?;
    }
    if let Some(api_key) = api_key {
        if api_key.trim().is_empty() {
            sqlx::query("DELETE FROM app_meta WHERE key = $1")
                .bind(META_API_KEY)
                .execute(pool)
                .await?;
        } else {
            set_meta(pool, META_API_KEY, api_key.trim()).await?;
        }
    }
    if let Some(duck_enabled) = duck_enabled {
        set_meta(
            pool,
            META_DUCK_ENABLED,
            if duck_enabled { "true" } else { "false" },
        )
        .await?;
    }
    if let Some(duck_cooldown_secs) = duck_cooldown_secs {
        set_meta(
            pool,
            META_DUCK_COOLDOWN_SECS,
            &duck_cooldown_secs.to_string(),
        )
        .await?;
    }
    if let Some(duck_context) = duck_context {
        set_meta(pool, META_DUCK_CONTEXT, duck_context).await?;
    }
    Ok(())
}

async fn set_meta(pool: &PgPool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO app_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

pub fn resolve_provider(settings: &GifSettings) -> Option<Box<dyn GifProvider>> {
    match (settings.provider.as_str(), settings.api_key.as_ref()) {
        ("giphy", Some(api_key)) => Some(Box::new(Giphy {
            api_key: api_key.clone(),
        })),
        ("tenor", Some(api_key)) => Some(Box::new(Tenor {
            api_key: api_key.clone(),
        })),
        _ => None,
    }
}
