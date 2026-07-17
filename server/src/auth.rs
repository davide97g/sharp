use crate::error::{AppError, AppResult};
use crate::models::User;
use crate::state::SharedState;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::async_trait;
use axum::extract::{FromRequestParts, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::Json;
use base64::Engine;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::{Duration as StdDuration, Instant};
use uuid::Uuid;

/// Time a desktop browser-login code stays valid before it must be exchanged.
const DESKTOP_CODE_TTL: StdDuration = StdDuration::from_secs(60);

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    /// True for limited guest tokens (public voice-link joiners). Defaults to
    /// false so existing user tokens (which omit the field) keep decoding.
    #[serde(default)]
    pub guest: bool,
    /// Guest display name, carried in the token so guests never need /users.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The single voice room a guest token is bound to (legacy wire name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Uuid>,
    /// The voice-link token the guest joined with; checked against the room's
    /// current link at join time so revocation invalidates guests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// Authenticated user identity, extracted from the Bearer JWT.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub id: Uuid,
}

/// Auth that accepts either a full user token or a limited guest token. Used by
/// `GET /voice/config` and endpoints that must distinguish guests explicitly.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // Fields are part of the extractor's contract; not all callers read them.
pub struct VoiceConfigAuth {
    pub id: Uuid,
    pub guest: bool,
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("hash error: {}", e)))?
        .to_string();
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

pub fn create_token(user_id: Uuid, secret: &str) -> AppResult<String> {
    let exp = (Utc::now() + Duration::days(30)).timestamp() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        exp,
        guest: false,
        name: None,
        channel_id: None,
        link: None,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("token error: {}", e)))
}

/// Mint a limited guest token bound to a single voice room. The
/// subject is a fresh random UUID (the guest's identity for the session);
/// tokens are stateless and expire after 12 hours. Revocation is achieved by
/// regenerating the channel's voice link (checked at `voice.join`).
pub fn create_guest_token(
    name: &str,
    channel_id: Uuid,
    link_token: &str,
    secret: &str,
) -> AppResult<String> {
    let exp = (Utc::now() + Duration::hours(12)).timestamp() as usize;
    let claims = Claims {
        sub: Uuid::new_v4().to_string(),
        exp,
        guest: true,
        name: Some(name.to_string()),
        channel_id: Some(channel_id),
        link: Some(link_token.to_string()),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("token error: {}", e)))
}

/// Verify a JWT and return the full parsed claims alongside the parsed subject
/// UUID. Works for both user and guest tokens.
pub fn verify_claims(token: &str, secret: &str) -> Option<(Claims, Uuid)> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()?;
    let id = Uuid::parse_str(&data.claims.sub).ok()?;
    Some((data.claims, id))
}

/// Thin helper for call sites that only need the subject UUID. Accepts any valid
/// token (user or guest) — callers that must exclude guests should inspect the
/// full claims via `verify_claims`.
pub fn verify_token(token: &str, secret: &str) -> Option<Uuid> {
    verify_claims(token, secret).map(|(_, id)| id)
}

fn bearer_from_parts(parts: &Parts) -> Option<String> {
    let header = parts.headers.get(AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    let token = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?;
    Some(token.trim().to_string())
}

#[async_trait]
impl FromRequestParts<SharedState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_from_parts(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".to_string()))?;
        let (claims, id) = verify_claims(&token, &state.config.jwt_secret)
            .ok_or_else(|| AppError::Unauthorized("invalid token".to_string()))?;
        // Guest tokens are voice-only and must never reach a REST endpoint.
        if claims.guest {
            return Err(AppError::Unauthorized("invalid token".to_string()));
        }
        Ok(AuthUser { id })
    }
}

#[async_trait]
impl FromRequestParts<SharedState> for VoiceConfigAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_from_parts(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".to_string()))?;
        let (claims, id) = verify_claims(&token, &state.config.jwt_secret)
            .ok_or_else(|| AppError::Unauthorized("invalid token".to_string()))?;
        Ok(VoiceConfigAuth {
            id,
            guest: claims.guest,
        })
    }
}

pub fn user_from_row(row: &sqlx::postgres::PgRow) -> AppResult<User> {
    Ok(User {
        id: row.try_get("id")?,
        email: Some(row.try_get("email")?),
        display_name: row.try_get("display_name")?,
        avatar_url: row.try_get("avatar_url")?,
        created_at: row.try_get("created_at")?,
    })
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

pub async fn register(
    State(state): State<SharedState>,
    Json(body): Json<RegisterRequest>,
) -> AppResult<(axum::http::StatusCode, Json<AuthResponse>)> {
    let email = body.email.trim().to_lowercase();
    let display_name = body.display_name.trim().to_string();

    if email.is_empty() || !email.contains('@') {
        return Err(AppError::Validation("invalid email".to_string()));
    }
    if body.password.len() < 8 {
        return Err(AppError::Validation(
            "password must be at least 8 characters".to_string(),
        ));
    }
    if display_name.is_empty() {
        return Err(AppError::Validation("display_name is required".to_string()));
    }

    // Signup gating: first user is always allowed; later ones blocked if disabled.
    if state.config.disable_signup {
        let count: i64 = sqlx::query("SELECT count(*) AS c FROM users")
            .fetch_one(&state.pool)
            .await?
            .try_get("c")?;
        if count > 0 {
            return Err(AppError::Forbidden("signups are disabled".to_string()));
        }
    }

    let existing = sqlx::query("SELECT 1 AS x FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;
    if existing.is_some() {
        return Err(AppError::Conflict("email already registered".to_string()));
    }

    let password_hash = hash_password(&body.password)?;

    let row = sqlx::query(
        "INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, avatar_url, created_at",
    )
    .bind(&email)
    .bind(&password_hash)
    .bind(&display_name)
    .fetch_one(&state.pool)
    .await?;

    let user = user_from_row(&row)?;
    let token = create_token(user.id, &state.config.jwt_secret)?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(AuthResponse { token, user }),
    ))
}

pub async fn login(
    State(state): State<SharedState>,
    Json(body): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let email = body.email.trim().to_lowercase();

    let row = sqlx::query(
        "SELECT id, email, display_name, avatar_url, created_at, password_hash
         FROM users WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or_else(|| AppError::Unauthorized("invalid credentials".to_string()))?;
    let password_hash: String = row.try_get("password_hash")?;

    if !verify_password(&body.password, &password_hash) {
        return Err(AppError::Unauthorized("invalid credentials".to_string()));
    }

    let user = user_from_row(&row)?;
    let token = create_token(user.id, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";

    #[test]
    fn guest_token_round_trips_with_bound_channel_and_link() {
        let channel_id = Uuid::new_v4();
        let token = create_guest_token("Ada Lovelace", channel_id, "link-abc", SECRET).unwrap();

        let (claims, sub) = verify_claims(&token, SECRET).expect("guest token should verify");
        assert!(claims.guest);
        assert_eq!(claims.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(claims.channel_id, Some(channel_id));
        assert_eq!(claims.link.as_deref(), Some("link-abc"));
        // Subject is a fresh random UUID and matches the parsed uuid.
        assert_eq!(claims.sub, sub.to_string());
    }

    #[test]
    fn user_token_is_not_a_guest() {
        let user_id = Uuid::new_v4();
        let token = create_token(user_id, SECRET).unwrap();

        let (claims, id) = verify_claims(&token, SECRET).expect("user token should verify");
        assert!(!claims.guest);
        assert_eq!(id, user_id);
        assert!(claims.channel_id.is_none());
        assert!(claims.link.is_none());
    }

    #[test]
    fn guest_flag_gates_rest_access() {
        // AuthUser rejects guests; this is the claims-level invariant it relies on.
        let token = create_guest_token("Guest", Uuid::new_v4(), "link", SECRET).unwrap();
        let (claims, _) = verify_claims(&token, SECRET).unwrap();
        assert!(claims.guest, "AuthUser must reject tokens where guest == true");

        let user = create_token(Uuid::new_v4(), SECRET).unwrap();
        let (user_claims, _) = verify_claims(&user, SECRET).unwrap();
        assert!(!user_claims.guest, "AuthUser must accept non-guest tokens");
    }
}

#[derive(Serialize)]
pub struct DesktopCodeResponse {
    pub code: String,
    pub expires_in: u64,
}

/// Mint a short-lived, single-use code bound to the authenticated user. The
/// desktop app opens the browser here (already-signed-in web session) and hands
/// the code back to the native app via a deep link, which then exchanges it for
/// a real JWT (see `desktop_exchange`). Keeps the long-lived token out of the
/// browser history / OS deep-link launch args.
pub async fn desktop_code(
    State(state): State<SharedState>,
    user: AuthUser,
) -> AppResult<Json<DesktopCodeResponse>> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);

    let now = Instant::now();
    {
        let mut codes = state
            .desktop_codes
            .lock()
            .map_err(|_| AppError::Internal("desktop_codes lock poisoned".to_string()))?;
        // Opportunistically drop expired codes so the map can't grow unbounded.
        codes.retain(|_, (_, exp)| *exp > now);
        codes.insert(code.clone(), (user.id, now + DESKTOP_CODE_TTL));
    }

    Ok(Json(DesktopCodeResponse {
        code,
        expires_in: DESKTOP_CODE_TTL.as_secs(),
    }))
}

#[derive(Deserialize)]
pub struct DesktopExchangeRequest {
    pub code: String,
}

/// Exchange a one-time desktop-login code for a JWT. Unauthenticated: the code
/// itself is the credential. The code is consumed (single use) and must not be
/// expired.
pub async fn desktop_exchange(
    State(state): State<SharedState>,
    Json(body): Json<DesktopExchangeRequest>,
) -> AppResult<Json<AuthResponse>> {
    let now = Instant::now();
    let entry = {
        let mut codes = state
            .desktop_codes
            .lock()
            .map_err(|_| AppError::Internal("desktop_codes lock poisoned".to_string()))?;
        codes.remove(&body.code)
    };

    let user_id = match entry {
        Some((id, exp)) if exp > now => id,
        _ => return Err(AppError::Unauthorized("invalid or expired code".to_string())),
    };

    let row = sqlx::query(
        "SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid or expired code".to_string()))?;

    let user = user_from_row(&row)?;
    let token = create_token(user.id, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}
