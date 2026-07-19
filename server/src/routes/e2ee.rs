use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::ws::envelope;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const MAX_BACKUP_BYTES: usize = 200 * 1024;

#[derive(Serialize)]
pub struct E2eeDevice {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x25519_pub: String,
    pub ed25519_pub: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct DeviceQuery {
    pub user_id: Uuid,
}

#[derive(Deserialize)]
pub struct PutDeviceRequest {
    pub id: Uuid,
    pub name: String,
    pub x25519_pub: String,
    pub ed25519_pub: String,
}

#[derive(Deserialize)]
pub struct PutBackupRequest {
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Serialize)]
pub struct E2eeBackup {
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    pub updated_at: DateTime<Utc>,
}

fn valid_public_key(value: &str) -> bool {
    if !(43..=44).contains(&value.len()) {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .is_ok_and(|decoded| decoded.len() == 32)
}

fn validate_device(body: &PutDeviceRequest) -> AppResult<()> {
    if body.name.chars().count() > 100 {
        return Err(AppError::Validation(
            "name must be at most 100 characters".to_string(),
        ));
    }
    if !valid_public_key(&body.x25519_pub) {
        return Err(AppError::Validation(
            "x25519_pub must be a base64url-encoded 32-byte key".to_string(),
        ));
    }
    if !valid_public_key(&body.ed25519_pub) {
        return Err(AppError::Validation(
            "ed25519_pub must be a base64url-encoded 32-byte key".to_string(),
        ));
    }
    Ok(())
}

fn validate_backup(body: &PutBackupRequest) -> AppResult<()> {
    let total = body
        .salt
        .len()
        .saturating_add(body.nonce.len())
        .saturating_add(body.ciphertext.len());
    if total > MAX_BACKUP_BYTES {
        return Err(AppError::Validation(
            "backup must be at most 200 KB".to_string(),
        ));
    }
    Ok(())
}

async fn broadcast_devices_changed(state: &SharedState, user_id: Uuid) {
    state
        .hub
        .broadcast(
            envelope("e2ee.devices_changed", json!({ "user_id": user_id })),
            state.hub.online_user_ids(),
        )
        .await;
}

pub async fn list_devices(
    State(state): State<SharedState>,
    _auth: AuthUser,
    Query(query): Query<DeviceQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT id, user_id, name, x25519_pub, ed25519_pub, created_at
           FROM e2ee_devices WHERE user_id = $1 ORDER BY created_at, id",
    )
    .bind(query.user_id)
    .fetch_all(&state.pool)
    .await?;
    let devices = rows
        .iter()
        .map(|row| {
            Ok(E2eeDevice {
                id: row.try_get("id")?,
                user_id: row.try_get("user_id")?,
                name: row.try_get("name")?,
                x25519_pub: row.try_get("x25519_pub")?,
                ed25519_pub: row.try_get("ed25519_pub")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "devices": devices })))
}

pub async fn put_device(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<PutDeviceRequest>,
) -> AppResult<StatusCode> {
    validate_device(&body)?;
    let result = sqlx::query(
        "INSERT INTO e2ee_devices (id, user_id, name, x25519_pub, ed25519_pub)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             x25519_pub = EXCLUDED.x25519_pub,
             ed25519_pub = EXCLUDED.ed25519_pub,
             last_seen_at = now()
         WHERE e2ee_devices.user_id = EXCLUDED.user_id",
    )
    .bind(body.id)
    .bind(auth.id)
    .bind(&body.name)
    .bind(&body.x25519_pub)
    .bind(&body.ed25519_pub)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Forbidden(
            "device belongs to another user".to_string(),
        ));
    }
    broadcast_devices_changed(&state, auth.id).await;
    Ok(StatusCode::CREATED)
}

pub async fn delete_device(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
    auth: AuthUser,
) -> AppResult<StatusCode> {
    let result = sqlx::query("DELETE FROM e2ee_devices WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        let exists = sqlx::query("SELECT 1 FROM e2ee_devices WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?
            .is_some();
        return Err(if exists {
            AppError::Forbidden("device belongs to another user".to_string())
        } else {
            AppError::NotFound("device not found".to_string())
        });
    }
    broadcast_devices_changed(&state, auth.id).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn put_backup(
    State(state): State<SharedState>,
    auth: AuthUser,
    Json(body): Json<PutBackupRequest>,
) -> AppResult<StatusCode> {
    validate_backup(&body)?;
    sqlx::query(
        "INSERT INTO e2ee_backups (user_id, salt, nonce, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
             salt = EXCLUDED.salt,
             nonce = EXCLUDED.nonce,
             ciphertext = EXCLUDED.ciphertext,
             updated_at = now()",
    )
    .bind(auth.id)
    .bind(&body.salt)
    .bind(&body.nonce)
    .bind(&body.ciphertext)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_backup(
    State(state): State<SharedState>,
    auth: AuthUser,
) -> AppResult<Json<E2eeBackup>> {
    let row = sqlx::query(
        "SELECT salt, nonce, ciphertext, updated_at FROM e2ee_backups WHERE user_id = $1",
    )
    .bind(auth.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("E2EE backup not found".to_string()))?;
    Ok(Json(E2eeBackup {
        salt: row.try_get("salt")?,
        nonce: row.try_get("nonce")?,
        ciphertext: row.try_get("ciphertext")?,
        updated_at: row.try_get("updated_at")?,
    }))
}

pub async fn dm_is_encrypted(pool: &PgPool, channel_id: Uuid) -> AppResult<bool> {
    let row = sqlx::query(
        "SELECT c.kind = 'dm'
                AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id)
                AND NOT EXISTS (
                    SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = c.id
                       AND NOT EXISTS (
                           SELECT 1 FROM e2ee_devices d WHERE d.user_id = cm.user_id
                       )
                ) AS encrypted
           FROM channels c WHERE c.id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(row.try_get("encrypted")?),
        None => Ok(false),
    }
}
