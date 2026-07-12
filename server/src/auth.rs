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
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

/// Authenticated user identity, extracted from the Bearer JWT.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub id: Uuid,
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
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("token error: {}", e)))
}

pub fn verify_token(token: &str, secret: &str) -> Option<Uuid> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()?;
    Uuid::parse_str(&data.claims.sub).ok()
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
        let id = verify_token(&token, &state.config.jwt_secret)
            .ok_or_else(|| AppError::Unauthorized("invalid token".to_string()))?;
        Ok(AuthUser { id })
    }
}

pub fn user_from_row(row: &sqlx::postgres::PgRow) -> AppResult<User> {
    Ok(User {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
        display_name: row.try_get("display_name")?,
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
         RETURNING id, email, display_name, created_at",
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
        "SELECT id, email, display_name, created_at, password_hash
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
