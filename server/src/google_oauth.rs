//! Google OAuth 2.0 (authorization-code, confidential client) for Calendar sync.
//!
//! Hand-rolled reqwest + serde against Google's token/userinfo endpoints — no
//! generated binding. The self-hoster supplies their own Google Cloud OAuth
//! client via `GOOGLE_*` env (see `config::GoogleConfig`). Scope is read-only
//! calendar access. The OAuth `state` is a short-lived HS256 JWT signed with the
//! server's `JWT_SECRET`, so the callback verifies the flow's origin statelessly
//! (multi-replica safe) without a server-side session store.

use crate::config::GoogleConfig;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use uuid::Uuid;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
// `openid email` are non-sensitive and required for the userinfo email lookup.
pub const CALENDAR_SCOPE: &str =
    "openid email https://www.googleapis.com/auth/calendar.readonly";
const STATE_PURPOSE: &str = "cal_oauth";
/// The OAuth flow must complete within this window.
const STATE_TTL_MINUTES: i64 = 10;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Errors from a token exchange/refresh. `InvalidGrant` is called out because the
/// caller must flip the connection to `status='invalid'` (expired/revoked refresh
/// token — user must reconnect).
#[derive(Debug)]
pub enum OAuthError {
    InvalidGrant,
    Http(String),
    Response(String),
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthError::InvalidGrant => write!(f, "invalid_grant"),
            OAuthError::Http(m) => write!(f, "http error: {m}"),
            OAuthError::Response(m) => write!(f, "oauth error: {m}"),
        }
    }
}

// --- State JWT ---------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct StateClaims {
    sub: String,
    purpose: String,
    exp: usize,
}

/// Mint the short-lived state token carrying the initiating user's id.
pub fn make_state(user_id: Uuid, jwt_secret: &str) -> Result<String, String> {
    let exp = (Utc::now() + Duration::minutes(STATE_TTL_MINUTES)).timestamp() as usize;
    let claims = StateClaims {
        sub: user_id.to_string(),
        purpose: STATE_PURPOSE.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|e| format!("state token: {e}"))
}

/// Verify a state token and return the initiating user's id. `None` on any
/// failure (expired, wrong purpose, bad signature).
pub fn verify_state(state: &str, jwt_secret: &str) -> Option<Uuid> {
    let data = decode::<StateClaims>(
        state,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()?;
    if data.claims.purpose != STATE_PURPOSE {
        return None;
    }
    Uuid::parse_str(&data.claims.sub).ok()
}

// --- Authorization URL -------------------------------------------------------

/// Build the consent-screen URL. `access_type=offline` + `prompt=consent`
/// requests a refresh token; `include_granted_scopes` keeps prior grants.
pub fn authorize_url(cfg: &GoogleConfig, state_jwt: &str) -> String {
    let params = [
        ("client_id", cfg.client_id.as_str()),
        ("redirect_uri", cfg.redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", CALENDAR_SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "true"),
        ("state", state_jwt),
    ];
    let query = serde_urlencoded::to_string(params).unwrap_or_default();
    format!("{AUTH_ENDPOINT}?{query}")
}

// --- Token exchange / refresh ------------------------------------------------

/// Google's token endpoint success shape. `refresh_token` is present only on the
/// first consent (or when `prompt=consent` re-issues one).
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

async fn post_token(params: &[(&str, &str)]) -> Result<TokenResponse, OAuthError> {
    let resp = client()
        .post(TOKEN_ENDPOINT)
        .form(params)
        .send()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    if status.is_success() {
        serde_json::from_str::<TokenResponse>(&body)
            .map_err(|e| OAuthError::Response(format!("parse token: {e}")))
    } else {
        // Distinguish invalid_grant (revoked/expired refresh token) from the rest.
        match serde_json::from_str::<TokenErrorResponse>(&body) {
            Ok(err) if err.error == "invalid_grant" => Err(OAuthError::InvalidGrant),
            Ok(err) => Err(OAuthError::Response(format!(
                "{}: {}",
                err.error,
                err.error_description.unwrap_or_default()
            ))),
            Err(_) => Err(OAuthError::Response(format!("token endpoint {status}"))),
        }
    }
}

/// Exchange an authorization code for tokens (initial connect).
pub async fn exchange_code(cfg: &GoogleConfig, code: &str) -> Result<TokenResponse, OAuthError> {
    post_token(&[
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", cfg.client_secret.as_str()),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", cfg.redirect_uri.as_str()),
    ])
    .await
}

/// Refresh an access token. `invalid_grant` here means the refresh token is dead.
pub async fn refresh(
    cfg: &GoogleConfig,
    refresh_token: &str,
) -> Result<TokenResponse, OAuthError> {
    post_token(&[
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", cfg.client_secret.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ])
    .await
}

// --- Userinfo ----------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct UserInfo {
    #[serde(default)]
    email: Option<String>,
}

/// Fetch the connected account's email via the OpenID userinfo endpoint.
pub async fn fetch_email(access_token: &str) -> Result<String, OAuthError> {
    let resp = client()
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(OAuthError::Response(format!(
            "userinfo endpoint {}",
            resp.status()
        )));
    }
    let info: UserInfo = resp
        .json()
        .await
        .map_err(|e| OAuthError::Response(format!("parse userinfo: {e}")))?;
    info.email
        .filter(|e| !e.is_empty())
        .ok_or_else(|| OAuthError::Response("userinfo missing email".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "dev-only-secret";

    #[test]
    fn state_round_trips() {
        let uid = Uuid::new_v4();
        let state = make_state(uid, SECRET).unwrap();
        assert_eq!(verify_state(&state, SECRET), Some(uid));
    }

    #[test]
    fn state_rejects_wrong_secret() {
        let state = make_state(Uuid::new_v4(), SECRET).unwrap();
        assert!(verify_state(&state, "other-secret").is_none());
    }

    #[test]
    fn state_rejects_wrong_purpose() {
        // A normal auth token (no cal_oauth purpose) must not pass as OAuth state.
        let token = crate::auth::create_token(Uuid::new_v4(), SECRET).unwrap();
        assert!(verify_state(&token, SECRET).is_none());
    }

    #[test]
    fn authorize_url_has_expected_params() {
        let cfg = GoogleConfig {
            client_id: "cid".into(),
            client_secret: "secret".into(),
            redirect_uri: "https://app.example/api/v1/calendar/google/callback".into(),
        };
        let url = authorize_url(&cfg, "state-token");
        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("include_granted_scopes=true"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("state=state-token"));
        assert!(url.contains("calendar.readonly"));
    }
}
