use crate::auth::{self, AuthResponse, AuthUser};
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, SharedState};
use axum::async_trait;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;
use webauthn_rs::prelude::*;

const CEREMONY_TTL_MINUTES: i64 = 5;
const EXCHANGE_CODE_TTL_SECONDS: i64 = 60;
const MANAGEMENT_TOKEN_TTL_MINUTES: i64 = 10;
const MAX_ACTIVE_ANONYMOUS_CEREMONIES: i64 = 10_000;

pub fn build_webauthn(config: &Config) -> Result<Option<Arc<Webauthn>>, String> {
    let Some(cfg) = &config.webauthn else {
        return Ok(None);
    };

    let mut parsed = Vec::with_capacity(cfg.origins.len());
    for raw in &cfg.origins {
        let origin =
            Url::parse(raw).map_err(|error| format!("invalid WebAuthn origin '{raw}': {error}"))?;
        let host = origin
            .host_str()
            .ok_or_else(|| format!("WebAuthn origin '{raw}' has no host"))?;
        let secure =
            origin.scheme() == "https" || (origin.scheme() == "http" && host == "localhost");
        if !secure {
            return Err(format!(
                "WebAuthn origin '{raw}' must use HTTPS (HTTP is allowed only for localhost)"
            ));
        }
        if host != cfg.rp_id && !host.ends_with(&format!(".{}", cfg.rp_id)) {
            return Err(format!(
                "WEBAUTHN_RP_ID '{}' is not a suffix of origin host '{host}'",
                cfg.rp_id
            ));
        }
        parsed.push(origin);
    }

    let first = parsed
        .first()
        .ok_or_else(|| "WEBAUTHN_ORIGINS must contain at least one origin".to_string())?;
    let mut builder = WebauthnBuilder::new(&cfg.rp_id, first)
        .map_err(|error| format!("invalid WebAuthn configuration: {error}"))?
        .rp_name(&cfg.rp_name);
    for origin in parsed.iter().skip(1) {
        builder = builder.append_allowed_origin(origin);
    }
    let webauthn = builder
        .build()
        .map_err(|error| format!("invalid WebAuthn configuration: {error}"))?;
    Ok(Some(Arc::new(webauthn)))
}

fn verifier(state: &AppState) -> AppResult<&Webauthn> {
    state
        .webauthn
        .as_deref()
        .ok_or_else(|| AppError::ServiceUnavailable("passkeys are not configured".to_string()))
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

async fn cleanup(state: &AppState) -> AppResult<()> {
    sqlx::query("DELETE FROM webauthn_ceremonies WHERE expires_at <= now()")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM passkey_management_sessions WHERE expires_at <= now()")
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct PasskeyUser {
    pub id: Uuid,
}

#[async_trait]
impl FromRequestParts<SharedState> for PasskeyUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        let token = auth::bearer_from_parts(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".to_string()))?;
        if let Some((claims, id)) = auth::verify_claims(&token, &state.config.jwt_secret) {
            if !claims.guest {
                return Ok(Self { id });
            }
        }

        let row = sqlx::query(
            "SELECT user_id FROM passkey_management_sessions
             WHERE token_hash = $1 AND kind = 'management_token' AND expires_at > now()",
        )
        .bind(token_hash(&token))
        .fetch_optional(&state.pool)
        .await?;
        match row {
            Some(row) => Ok(Self {
                id: row.try_get("user_id")?,
            }),
            None => Err(AppError::Unauthorized("invalid token".to_string())),
        }
    }
}

#[derive(Serialize)]
pub struct PasskeyConfigResponse {
    pub enabled: bool,
    pub rp_name: Option<String>,
}

pub async fn config(State(state): State<SharedState>) -> Json<PasskeyConfigResponse> {
    Json(PasskeyConfigResponse {
        enabled: state.webauthn.is_some(),
        rp_name: state
            .config
            .webauthn
            .as_ref()
            .map(|cfg| cfg.rp_name.clone()),
    })
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub ceremony_id: Uuid,
    pub options: serde_json::Value,
}

#[derive(Deserialize)]
pub struct RegisterStartRequest {
    pub name: String,
    pub password: String,
}

async fn verify_current_password(state: &AppState, user_id: Uuid, password: &str) -> AppResult<()> {
    let row = sqlx::query("SELECT password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::Unauthorized("invalid credentials".to_string()))?;
    let hash: String = row.try_get("password_hash")?;
    if !auth::verify_password(password, &hash) {
        return Err(AppError::Unauthorized("invalid credentials".to_string()));
    }
    Ok(())
}

pub async fn register_start(
    State(state): State<SharedState>,
    user: PasskeyUser,
    Json(body): Json<RegisterStartRequest>,
) -> AppResult<Json<ChallengeResponse>> {
    let webauthn = verifier(&state)?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Validation(
            "passkey name must be between 1 and 80 characters".to_string(),
        ));
    }
    verify_current_password(&state, user.id, &body.password).await?;
    cleanup(&state).await?;

    let user_row = sqlx::query("SELECT email, display_name FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    let email: String = user_row.try_get("email")?;
    let display_name: String = user_row.try_get("display_name")?;
    let rows = sqlx::query("SELECT passkey FROM webauthn_credentials WHERE user_id = $1")
        .bind(user.id)
        .fetch_all(&state.pool)
        .await?;
    let mut existing = Vec::with_capacity(rows.len());
    for row in rows {
        let value: serde_json::Value = row.try_get("passkey")?;
        let passkey: Passkey = serde_json::from_value(value)
            .map_err(|error| AppError::Internal(format!("invalid stored passkey: {error}")))?;
        existing.push(passkey.cred_id().clone());
    }

    let (challenge, registration) = webauthn
        .start_passkey_registration(
            user.id,
            &email,
            &display_name,
            (!existing.is_empty()).then_some(existing),
        )
        .map_err(|_| AppError::Internal("could not start passkey registration".to_string()))?;
    let ceremony_id = Uuid::new_v4();
    let state_json = serde_json::to_value(registration)
        .map_err(|error| AppError::Internal(format!("could not store ceremony: {error}")))?;
    sqlx::query(
        "INSERT INTO webauthn_ceremonies (id, kind, user_id, state, pending_name, expires_at)
         VALUES ($1, 'register', $2, $3, $4, $5)",
    )
    .bind(ceremony_id)
    .bind(user.id)
    .bind(state_json)
    .bind(name)
    .bind(Utc::now() + Duration::minutes(CEREMONY_TTL_MINUTES))
    .execute(&state.pool)
    .await?;

    let mut options = serde_json::to_value(challenge)
        .map_err(|error| AppError::Internal(format!("could not encode challenge: {error}")))?;
    if let Some(selection) = options
        .get_mut("publicKey")
        .and_then(|value| value.get_mut("authenticatorSelection"))
        .and_then(serde_json::Value::as_object_mut)
    {
        selection.insert("residentKey".to_string(), serde_json::json!("required"));
        selection.insert("requireResidentKey".to_string(), serde_json::json!(true));
        selection.insert(
            "userVerification".to_string(),
            serde_json::json!("required"),
        );
    }
    Ok(Json(ChallengeResponse {
        ceremony_id,
        options,
    }))
}

#[derive(Deserialize)]
pub struct RegisterFinishRequest {
    pub ceremony_id: Uuid,
    pub credential: RegisterPublicKeyCredential,
}

pub async fn register_finish(
    State(state): State<SharedState>,
    user: PasskeyUser,
    Json(body): Json<RegisterFinishRequest>,
) -> AppResult<Json<PasskeyRecord>> {
    let webauthn = verifier(&state)?;
    let row = sqlx::query(
        "DELETE FROM webauthn_ceremonies
         WHERE id = $1 AND kind = 'register' AND user_id = $2 AND expires_at > now()
         RETURNING state, pending_name",
    )
    .bind(body.ceremony_id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::BadRequest("invalid or expired passkey ceremony".to_string()))?;
    let ceremony_value: serde_json::Value = row.try_get("state")?;
    let registration: PasskeyRegistration = serde_json::from_value(ceremony_value)
        .map_err(|error| AppError::Internal(format!("invalid stored ceremony: {error}")))?;
    let name: String = row.try_get("pending_name")?;
    let passkey = webauthn
        .finish_passkey_registration(&body.credential, &registration)
        .map_err(|_| AppError::Unauthorized("passkey registration failed".to_string()))?;
    let credential_id = passkey.cred_id().as_ref().to_vec();
    let passkey_json = serde_json::to_value(&passkey)
        .map_err(|error| AppError::Internal(format!("could not store passkey: {error}")))?;
    let row = sqlx::query(
        "INSERT INTO webauthn_credentials (user_id, credential_id, passkey, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING id, name, created_at, last_used_at",
    )
    .bind(user.id)
    .bind(credential_id)
    .bind(passkey_json)
    .bind(name)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Conflict("passkey is already registered".to_string()))?;
    Ok(Json(passkey_record_from_row(&row)?))
}

pub async fn login_start(State(state): State<SharedState>) -> AppResult<Json<ChallengeResponse>> {
    let webauthn = verifier(&state)?;
    cleanup(&state).await?;
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM webauthn_ceremonies WHERE kind = 'authenticate' AND expires_at > now()",
    )
    .fetch_one(&state.pool)
    .await?;
    if active >= MAX_ACTIVE_ANONYMOUS_CEREMONIES {
        return Err(AppError::RateLimited(
            "too many passkey attempts; try again later".to_string(),
        ));
    }
    let (challenge, authentication) = webauthn
        .start_discoverable_authentication()
        .map_err(|_| AppError::Internal("could not start passkey authentication".to_string()))?;
    let ceremony_id = Uuid::new_v4();
    let state_json = serde_json::to_value(authentication)
        .map_err(|error| AppError::Internal(format!("could not store ceremony: {error}")))?;
    sqlx::query(
        "INSERT INTO webauthn_ceremonies (id, kind, state, expires_at)
         VALUES ($1, 'authenticate', $2, $3)",
    )
    .bind(ceremony_id)
    .bind(state_json)
    .bind(Utc::now() + Duration::minutes(CEREMONY_TTL_MINUTES))
    .execute(&state.pool)
    .await?;
    let options = serde_json::to_value(challenge)
        .map_err(|error| AppError::Internal(format!("could not encode challenge: {error}")))?;
    Ok(Json(ChallengeResponse {
        ceremony_id,
        options,
    }))
}

#[derive(Deserialize)]
pub struct LoginFinishRequest {
    pub ceremony_id: Uuid,
    pub credential: PublicKeyCredential,
}

pub async fn login_finish(
    State(state): State<SharedState>,
    Json(body): Json<LoginFinishRequest>,
) -> AppResult<Json<AuthResponse>> {
    let webauthn = verifier(&state)?;
    let (user_id, credential_id) = webauthn
        .identify_discoverable_authentication(&body.credential)
        .map_err(|_| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    let credential_id = credential_id.to_vec();
    let ceremony_row = sqlx::query(
        "DELETE FROM webauthn_ceremonies
         WHERE id = $1 AND kind = 'authenticate' AND expires_at > now()
         RETURNING state",
    )
    .bind(body.ceremony_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    let ceremony_value: serde_json::Value = ceremony_row.try_get("state")?;
    let authentication: DiscoverableAuthentication = serde_json::from_value(ceremony_value)
        .map_err(|error| AppError::Internal(format!("invalid stored ceremony: {error}")))?;

    let credential_row = sqlx::query(
        "SELECT id, passkey FROM webauthn_credentials
         WHERE user_id = $1 AND credential_id = $2",
    )
    .bind(user_id)
    .bind(&credential_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    let credential_row_id: Uuid = credential_row.try_get("id")?;
    let passkey_value: serde_json::Value = credential_row.try_get("passkey")?;
    let mut passkey: Passkey = serde_json::from_value(passkey_value)
        .map_err(|error| AppError::Internal(format!("invalid stored passkey: {error}")))?;
    let discoverable: DiscoverableKey = passkey.clone().into();
    let result = webauthn
        .finish_discoverable_authentication(&body.credential, authentication, &[discoverable])
        .map_err(|_| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    passkey
        .update_credential(&result)
        .ok_or_else(|| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    let passkey_json = serde_json::to_value(&passkey)
        .map_err(|error| AppError::Internal(format!("could not update passkey: {error}")))?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE webauthn_credentials SET passkey = $1, last_used_at = now()
         WHERE id = $2 AND user_id = $3 AND credential_id = $4",
    )
    .bind(passkey_json)
    .bind(credential_row_id)
    .bind(user_id)
    .bind(credential_id)
    .execute(&mut *tx)
    .await?;
    let user_row = sqlx::query(
        "SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("passkey authentication failed".to_string()))?;
    tx.commit().await?;
    let user = auth::user_from_row(&user_row)?;
    let token = auth::create_token(user.id, &state.config.jwt_secret)?;
    Ok(Json(AuthResponse { token, user }))
}

#[derive(Debug, Serialize)]
pub struct PasskeyRecord {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

fn passkey_record_from_row(row: &sqlx::postgres::PgRow) -> AppResult<PasskeyRecord> {
    Ok(PasskeyRecord {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        created_at: row.try_get("created_at")?,
        last_used_at: row.try_get("last_used_at")?,
    })
}

#[derive(Serialize)]
pub struct PasskeyListResponse {
    pub enabled: bool,
    pub prompt_dismissed: bool,
    pub passkeys: Vec<PasskeyRecord>,
}

pub async fn list(
    State(state): State<SharedState>,
    user: PasskeyUser,
) -> AppResult<Json<PasskeyListResponse>> {
    let prompt_dismissed: bool = sqlx::query_scalar(
        "SELECT passkey_prompt_dismissed_at IS NOT NULL FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_one(&state.pool)
    .await?;
    let rows = sqlx::query(
        "SELECT id, name, created_at, last_used_at FROM webauthn_credentials
         WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    let passkeys = rows
        .iter()
        .map(passkey_record_from_row)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(PasskeyListResponse {
        enabled: state.webauthn.is_some(),
        prompt_dismissed,
        passkeys,
    }))
}

#[derive(Deserialize)]
pub struct RenameRequest {
    pub name: String,
}

pub async fn rename(
    State(state): State<SharedState>,
    user: PasskeyUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameRequest>,
) -> AppResult<Json<PasskeyRecord>> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Validation(
            "passkey name must be between 1 and 80 characters".to_string(),
        ));
    }
    let row = sqlx::query(
        "UPDATE webauthn_credentials SET name = $1 WHERE id = $2 AND user_id = $3
         RETURNING id, name, created_at, last_used_at",
    )
    .bind(name)
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("passkey not found".to_string()))?;
    Ok(Json(passkey_record_from_row(&row)?))
}

#[derive(Deserialize)]
pub struct RemoveRequest {
    pub password: String,
}

pub async fn remove(
    State(state): State<SharedState>,
    user: PasskeyUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RemoveRequest>,
) -> AppResult<axum::http::StatusCode> {
    verify_current_password(&state, user.id, &body.password).await?;
    let result = sqlx::query("DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("passkey not found".to_string()));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn dismiss_prompt(
    State(state): State<SharedState>,
    user: PasskeyUser,
) -> AppResult<axum::http::StatusCode> {
    sqlx::query("UPDATE users SET passkey_prompt_dismissed_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct ManageStartResponse {
    pub code: String,
    pub expires_in: i64,
}

pub async fn manage_start(
    State(state): State<SharedState>,
    user: AuthUser,
) -> AppResult<Json<ManageStartResponse>> {
    verifier(&state)?;
    cleanup(&state).await?;
    let code = random_secret();
    sqlx::query(
        "INSERT INTO passkey_management_sessions (token_hash, kind, user_id, expires_at)
         VALUES ($1, 'exchange_code', $2, $3)",
    )
    .bind(token_hash(&code))
    .bind(user.id)
    .bind(Utc::now() + Duration::seconds(EXCHANGE_CODE_TTL_SECONDS))
    .execute(&state.pool)
    .await?;
    Ok(Json(ManageStartResponse {
        code,
        expires_in: EXCHANGE_CODE_TTL_SECONDS,
    }))
}

#[derive(Deserialize)]
pub struct ManageExchangeRequest {
    pub code: String,
}

#[derive(Serialize)]
pub struct ManageExchangeResponse {
    pub token: String,
    pub expires_in: i64,
}

pub async fn manage_exchange(
    State(state): State<SharedState>,
    Json(body): Json<ManageExchangeRequest>,
) -> AppResult<Json<ManageExchangeResponse>> {
    verifier(&state)?;
    let row = sqlx::query(
        "DELETE FROM passkey_management_sessions
         WHERE token_hash = $1 AND kind = 'exchange_code' AND expires_at > now()
         RETURNING user_id",
    )
    .bind(token_hash(&body.code))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid or expired code".to_string()))?;
    let user_id: Uuid = row.try_get("user_id")?;
    let token = random_secret();
    sqlx::query(
        "INSERT INTO passkey_management_sessions (token_hash, kind, user_id, expires_at)
         VALUES ($1, 'management_token', $2, $3)",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(Utc::now() + Duration::minutes(MANAGEMENT_TOKEN_TTL_MINUTES))
    .execute(&state.pool)
    .await?;
    Ok(Json(ManageExchangeResponse {
        token,
        expires_in: MANAGEMENT_TOKEN_TTL_MINUTES * 60,
    }))
}
