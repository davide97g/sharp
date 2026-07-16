use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub redis_url: Option<String>,
    pub web_dist: String,
    pub disable_signup: bool,
    /// S3-compatible object storage for file uploads. `None` = uploads disabled.
    pub s3: Option<S3Config>,
    pub ice: IceConfig,
    /// Max accepted upload size in bytes.
    pub max_upload_bytes: usize,
    /// VAPID keys supplied via env (public_b64, private_pem). If absent, the server
    /// auto-generates and persists a keypair on first startup.
    pub vapid_env: Option<VapidEnv>,
    /// `sub` claim for VAPID JWTs (a mailto: or https: URL).
    pub vapid_subject: String,
    /// GIPHY API key supplied via env. Persisted workspace settings take precedence.
    pub giphy_api_key: Option<String>,
    /// Tenor API key supplied via env. Persisted workspace settings take precedence.
    pub tenor_api_key: Option<String>,
    /// DeepSeek configuration. `None` when `DEEPSEEK_API_KEY` is unset.
    pub deepseek: Option<DeepSeekConfig>,
}

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub allow_http: bool,
}

#[derive(Clone)]
pub struct TurnConfig {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone)]
pub struct IceConfig {
    pub stun_urls: Vec<String>,
    pub turn: Option<TurnConfig>,
}

#[derive(Clone)]
pub struct VapidEnv {
    pub public_b64: String,
    /// URL-safe base64 of the raw 32-byte P-256 private scalar (the standard
    /// `web-push generate-vapid-keys` "Private Key" format).
    pub private_b64: String,
}

#[derive(Clone)]
pub struct DeepSeekConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

fn env_opt(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_bool(key: &str, default: bool) -> bool {
    match env_opt(key) {
        Some(v) => v == "true" || v == "1",
        None => default,
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required".to_string())?;
        let jwt_secret =
            env::var("JWT_SECRET").map_err(|_| "JWT_SECRET is required".to_string())?;
        let port = env_opt("PORT")
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3000);
        let redis_url = env_opt("REDIS_URL");
        let web_dist = env::var("WEB_DIST").unwrap_or_else(|_| "./web-dist".to_string());
        let disable_signup = env_bool("SHARP_DISABLE_SIGNUP", false);

        // S3 is enabled only when bucket + credentials are all present.
        let s3 = match (
            env_opt("S3_BUCKET"),
            env_opt("S3_ACCESS_KEY"),
            env_opt("S3_SECRET_KEY"),
        ) {
            (Some(bucket), Some(access_key), Some(secret_key)) => {
                let endpoint = env_opt("S3_ENDPOINT");
                let allow_http = env_bool(
                    "S3_ALLOW_HTTP",
                    endpoint
                        .as_deref()
                        .map(|e| e.starts_with("http://"))
                        .unwrap_or(false),
                );
                Some(S3Config {
                    endpoint,
                    region: env_opt("S3_REGION").unwrap_or_else(|| "us-east-1".to_string()),
                    bucket,
                    access_key,
                    secret_key,
                    allow_http,
                })
            }
            _ => None,
        };

        let stun_urls = env_opt("STUN_URLS")
            .map(|urls| {
                urls.split(',')
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|urls| !urls.is_empty())
            .unwrap_or_else(|| vec!["stun:stun.l.google.com:19302".into()]);
        let turn = match (
            env_opt("TURN_URL"),
            env_opt("TURN_USERNAME"),
            env_opt("TURN_PASSWORD"),
        ) {
            (Some(url), Some(username), Some(password)) => Some(TurnConfig {
                url,
                username,
                password,
            }),
            _ => None,
        };
        let ice = IceConfig { stun_urls, turn };

        let max_upload_bytes = env_opt("MAX_UPLOAD_MB")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(25)
            .saturating_mul(1024 * 1024);

        let vapid_env = match (env_opt("VAPID_PUBLIC_KEY"), env_opt("VAPID_PRIVATE_KEY")) {
            (Some(public_b64), Some(private_b64)) => Some(VapidEnv {
                public_b64,
                private_b64,
            }),
            _ => None,
        };
        let vapid_subject =
            env_opt("VAPID_SUBJECT").unwrap_or_else(|| "mailto:admin@sharp.app".to_string());
        let giphy_api_key = env_opt("GIPHY_API_KEY");
        let tenor_api_key = env_opt("TENOR_API_KEY");
        let deepseek = env_opt("DEEPSEEK_API_KEY").map(|api_key| DeepSeekConfig {
            api_key,
            model: env_opt("DEEPSEEK_MODEL").unwrap_or_else(|| "deepseek-chat".to_string()),
            base_url: env_opt("DEEPSEEK_BASE_URL")
                .unwrap_or_else(|| "https://api.deepseek.com".to_string()),
        });

        Ok(Config {
            database_url,
            jwt_secret,
            port,
            redis_url,
            web_dist,
            disable_signup,
            s3,
            ice,
            max_upload_bytes,
            vapid_env,
            vapid_subject,
            giphy_api_key,
            tenor_api_key,
            deepseek,
        })
    }
}
