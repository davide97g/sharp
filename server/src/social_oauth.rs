//! Social sign-in providers (Google, GitHub) — OAuth 2.0 authorization code flow,
//! confidential client.
//!
//! This module is pure protocol: build a consent URL, exchange a code, read back a
//! normalised [`Identity`]. It knows nothing about sharp's users table — the
//! signup / link / gating policy lives in `routes/social_auth.rs`, and the wire
//! contract in `docs/arch/01-core.md`.
//!
//! Sibling module `google_oauth` handles the *Calendar* grant. They are deliberately
//! separate: that flow is authenticated (it attaches a calendar to a known user),
//! long-lived (it stores refresh tokens encrypted at rest) and scoped to calendar
//! data, whereas this one is unauthenticated, single-shot, and throws the access
//! token away as soon as the identity is read.
//!
//! Two invariants worth keeping:
//!
//! 1. **The identity is the provider's subject id, never the email.** Emails change
//!    at the provider and can be re-assigned; `provider_user_id` cannot.
//! 2. **`email_verified` is carried through, never assumed.** Account linking keys
//!    off an existing sharp email only when the provider vouches for it, so an
//!    unverified provider address can't be used to take over an account.

use crate::config::OAuthProviderConfig;
use crate::google_oauth::OAuthError;
use base64::Engine;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The OAuth round trip must complete within this window.
const STATE_TTL_MINUTES: i64 = 10;
const STATE_PURPOSE: &str = "social_login";

/// GitHub's API rejects requests without a User-Agent.
const USER_AGENT: &str = "sharp-server";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Google,
    Github,
}

impl Provider {
    pub fn parse(slug: &str) -> Option<Self> {
        match slug {
            "google" => Some(Provider::Google),
            "github" => Some(Provider::Github),
            _ => None,
        }
    }

    /// Stable wire/database value.
    pub fn slug(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Github => "github",
        }
    }

    /// Human name, for error copy.
    pub fn label(self) -> &'static str {
        match self {
            Provider::Google => "Google",
            Provider::Github => "GitHub",
        }
    }
}

/// A provider account, normalised across providers.
#[derive(Debug)]
pub struct Identity {
    /// The provider's immutable subject id — the thing we key accounts on.
    pub provider_user_id: String,
    pub email: Option<String>,
    /// Whether the *provider* asserts the email is verified. Gates account linking.
    pub email_verified: bool,
    pub display_name: Option<String>,
}
// Deliberately no avatar: `users.avatar_url` is an internal authed API path that the
// web client fetches with a Bearer header, so a provider's picture URL cannot be
// stored there. Copying the image would need a storage round trip — out of scope.

// --- State token -------------------------------------------------------------

/// The OAuth `state`, as a short-lived HS256 JWT signed with `JWT_SECRET`, so the
/// callback can be verified statelessly (multi-replica safe) with no session store.
#[derive(Debug, Serialize, Deserialize)]
pub struct StateClaims {
    purpose: String,
    /// Which provider the flow was started for; checked against the callback path
    /// so a state minted for one provider can't be replayed at another.
    pub provider: String,
    /// Random value also written to an HttpOnly cookie, so an attacker who can
    /// make the victim's browser hit the callback with *their* code cannot get it
    /// accepted (login CSRF). Unused for the linking flow, which is bound to
    /// `link_user_id` instead.
    pub nonce: String,
    /// Set when an already-signed-in user is attaching a provider from Settings.
    /// `None` means this is a sign-in / signup flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_user_id: Option<Uuid>,
    /// Desktop browser-login bridge: the deep-link scheme and the native app's
    /// `state`, carried so the callback can hand off to `sharp://auth?...`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_state: Option<String>,
    exp: usize,
}

/// A URL-safe random token, used for the state nonce and the handoff code.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub struct StateInput {
    pub provider: Provider,
    pub nonce: String,
    pub link_user_id: Option<Uuid>,
    pub desktop_scheme: Option<String>,
    pub desktop_state: Option<String>,
}

pub fn make_state(input: &StateInput, jwt_secret: &str) -> Result<String, String> {
    let claims = StateClaims {
        purpose: STATE_PURPOSE.to_string(),
        provider: input.provider.slug().to_string(),
        nonce: input.nonce.clone(),
        link_user_id: input.link_user_id,
        desktop_scheme: input.desktop_scheme.clone(),
        desktop_state: input.desktop_state.clone(),
        exp: (Utc::now() + Duration::minutes(STATE_TTL_MINUTES)).timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|e| format!("state token: {e}"))
}

/// Verify a state token for `provider`. `None` on any failure — expired, wrong
/// signature, wrong purpose (so an ordinary auth token can't pass as state), or
/// minted for a different provider.
pub fn verify_state(state: &str, provider: Provider, jwt_secret: &str) -> Option<StateClaims> {
    let data = decode::<StateClaims>(
        state,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()?;
    if data.claims.purpose != STATE_PURPOSE || data.claims.provider != provider.slug() {
        return None;
    }
    Some(data.claims)
}

// --- Authorization URL -------------------------------------------------------

/// Build the consent-screen URL.
///
/// Scopes are the minimum that yields a stable id plus a verified email:
/// `openid email profile` for Google, `read:user user:email` for GitHub. Google
/// gets `prompt=select_account` so a user with several Google accounts isn't
/// silently signed in as the wrong one.
pub fn authorize_url(provider: Provider, cfg: &OAuthProviderConfig, state_jwt: &str) -> String {
    match provider {
        Provider::Google => {
            let params = [
                ("client_id", cfg.client_id.as_str()),
                ("redirect_uri", cfg.redirect_uri.as_str()),
                ("response_type", "code"),
                ("scope", "openid email profile"),
                ("prompt", "select_account"),
                ("state", state_jwt),
            ];
            format!(
                "https://accounts.google.com/o/oauth2/v2/auth?{}",
                serde_urlencoded::to_string(params).unwrap_or_default()
            )
        }
        Provider::Github => {
            let params = [
                ("client_id", cfg.client_id.as_str()),
                ("redirect_uri", cfg.redirect_uri.as_str()),
                ("scope", "read:user user:email"),
                ("state", state_jwt),
            ];
            format!(
                "https://github.com/login/oauth/authorize?{}",
                serde_urlencoded::to_string(params).unwrap_or_default()
            )
        }
    }
}

// --- Token exchange ----------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    // Both providers report failures in the 200 body as well as by status.
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

/// Exchange the authorization code for an access token. The token is used once,
/// to read the identity, and never stored.
pub async fn exchange_code(
    provider: Provider,
    cfg: &OAuthProviderConfig,
    code: &str,
) -> Result<String, OAuthError> {
    let endpoint = match provider {
        Provider::Google => "https://oauth2.googleapis.com/token",
        Provider::Github => "https://github.com/login/oauth/access_token",
    };

    let resp = crate::http::client()
        .post(endpoint)
        // GitHub defaults to form-encoded responses without this.
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .form(&[
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", cfg.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| OAuthError::Response(format!("parse token ({status}): {e}")))?;

    if let Some(err) = parsed.error {
        if err == "invalid_grant" {
            return Err(OAuthError::InvalidGrant);
        }
        return Err(OAuthError::Response(format!(
            "{err}: {}",
            parsed.error_description.unwrap_or_default()
        )));
    }

    parsed
        .access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| OAuthError::Response(format!("token endpoint {status}: no access_token")))
}

// --- Identity ----------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubUser {
    id: i64,
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

/// Read the signed-in account's identity from the provider.
pub async fn fetch_identity(
    provider: Provider,
    access_token: &str,
) -> Result<Identity, OAuthError> {
    match provider {
        Provider::Google => {
            let info: GoogleUserInfo =
                get_json(access_token, "https://www.googleapis.com/oauth2/v3/userinfo").await?;
            Ok(Identity {
                provider_user_id: info.sub,
                email: info.email.filter(|e| !e.is_empty()),
                email_verified: info.email_verified,
                display_name: info.name.filter(|n| !n.trim().is_empty()),
            })
        }
        Provider::Github => {
            let user: GithubUser = get_json(access_token, "https://api.github.com/user").await?;

            // `user.email` is the *public profile* email — often null, and never
            // carries a verified flag. The authoritative answer is /user/emails:
            // prefer the primary verified address, else any verified one. An
            // unverified address is still reported, with email_verified = false,
            // so signup can use it while linking refuses it.
            let emails: Vec<GithubEmail> = get_json(access_token, "https://api.github.com/user/emails")
                .await
                .unwrap_or_default();
            let chosen = emails
                .iter()
                .find(|e| e.primary && e.verified)
                .or_else(|| emails.iter().find(|e| e.verified))
                .or_else(|| emails.iter().find(|e| e.primary))
                .or_else(|| emails.first());

            let (email, email_verified) = match chosen {
                Some(e) => (Some(e.email.clone()), e.verified),
                None => (user.email.filter(|e| !e.is_empty()), false),
            };

            Ok(Identity {
                provider_user_id: user.id.to_string(),
                email,
                email_verified,
                display_name: user
                    .name
                    .filter(|n| !n.trim().is_empty())
                    .or(Some(user.login)),
            })
        }
    }
}

async fn get_json<T: serde::de::DeserializeOwned>(
    access_token: &str,
    url: &str,
) -> Result<T, OAuthError> {
    let resp = crate::http::client()
        .get(url)
        .bearer_auth(access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| OAuthError::Http(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(OAuthError::Response(format!("{url} → {}", resp.status())));
    }
    resp.json::<T>()
        .await
        .map_err(|e| OAuthError::Response(format!("parse {url}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "dev-only-secret";

    fn input(provider: Provider, nonce: &str) -> StateInput {
        StateInput {
            provider,
            nonce: nonce.to_string(),
            link_user_id: None,
            desktop_scheme: None,
            desktop_state: None,
        }
    }

    #[test]
    fn state_round_trips_with_nonce() {
        let state = make_state(&input(Provider::Google, "n1"), SECRET).unwrap();
        let claims = verify_state(&state, Provider::Google, SECRET).expect("should verify");
        assert_eq!(claims.nonce, "n1");
        assert_eq!(claims.provider, "google");
        assert!(claims.link_user_id.is_none());
    }

    #[test]
    fn state_is_bound_to_its_provider() {
        // A state minted for Google must not be accepted at the GitHub callback.
        let state = make_state(&input(Provider::Google, "n1"), SECRET).unwrap();
        assert!(verify_state(&state, Provider::Github, SECRET).is_none());
    }

    #[test]
    fn state_rejects_wrong_secret_and_foreign_tokens() {
        let state = make_state(&input(Provider::Github, "n1"), SECRET).unwrap();
        assert!(verify_state(&state, Provider::Github, "other-secret").is_none());

        // An ordinary session token has no `purpose`, so it can't pass as state.
        let session = crate::auth::create_token(Uuid::new_v4(), SECRET).unwrap();
        assert!(verify_state(&session, Provider::Github, SECRET).is_none());
    }

    #[test]
    fn state_carries_link_and_desktop_context() {
        let user_id = Uuid::new_v4();
        let state = make_state(
            &StateInput {
                provider: Provider::Github,
                nonce: "n".into(),
                link_user_id: Some(user_id),
                desktop_scheme: Some("sharp".into()),
                desktop_state: Some("abc".into()),
            },
            SECRET,
        )
        .unwrap();
        let claims = verify_state(&state, Provider::Github, SECRET).unwrap();
        assert_eq!(claims.link_user_id, Some(user_id));
        assert_eq!(claims.desktop_scheme.as_deref(), Some("sharp"));
        assert_eq!(claims.desktop_state.as_deref(), Some("abc"));
    }

    #[test]
    fn provider_slugs_round_trip() {
        for slug in ["google", "github"] {
            assert_eq!(Provider::parse(slug).unwrap().slug(), slug);
        }
        assert!(Provider::parse("facebook").is_none());
    }

    #[test]
    fn authorize_urls_carry_minimum_scopes_and_state() {
        let cfg = OAuthProviderConfig {
            client_id: "cid".into(),
            client_secret: "secret".into(),
            redirect_uri: "https://app.example/api/v1/auth/oauth/google/callback".into(),
        };

        let google = authorize_url(Provider::Google, &cfg, "st");
        assert!(google.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(google.contains("response_type=code"));
        assert!(google.contains("prompt=select_account"));
        assert!(google.contains("state=st"));
        // openid email profile, url-encoded.
        assert!(google.contains("scope=openid+email+profile"));

        let github = authorize_url(Provider::Github, &cfg, "st");
        assert!(github.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(github.contains("scope=read%3Auser+user%3Aemail"));
        assert!(github.contains("state=st"));
    }

    #[test]
    fn random_tokens_are_unique_and_url_safe() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
