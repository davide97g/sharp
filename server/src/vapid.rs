//! VAPID key resolution for web push.
//!
//! Priority: env vars → keys persisted in `app_meta` → freshly generated (and
//! persisted). Auto-generation means self-hosters get working web push with zero
//! configuration; set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` to pin your own.

use crate::config::Config;
use crate::state::Vapid;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use sqlx::{PgPool, Row};

const META_PUBLIC: &str = "vapid_public_b64";
const META_PRIVATE: &str = "vapid_private_b64";

pub async fn resolve(config: &Config, pool: &PgPool) -> Option<Vapid> {
    let subject = config.vapid_subject.clone();

    // 1. Explicit env override.
    if let Some(env) = &config.vapid_env {
        return Some(Vapid {
            public_b64: env.public_b64.clone(),
            private_b64: env.private_b64.clone(),
            subject,
        });
    }

    // 2. Previously persisted keypair.
    if let (Some(public_b64), Some(private_b64)) = (
        get_meta(pool, META_PUBLIC).await,
        get_meta(pool, META_PRIVATE).await,
    ) {
        return Some(Vapid {
            public_b64,
            private_b64,
            subject,
        });
    }

    // 3. Generate + persist.
    match generate() {
        Ok((public_b64, private_b64)) => {
            let _ = set_meta(pool, META_PUBLIC, &public_b64).await;
            let _ = set_meta(pool, META_PRIVATE, &private_b64).await;
            tracing::info!("generated a new VAPID keypair for web push");
            Some(Vapid {
                public_b64,
                private_b64,
                subject,
            })
        }
        Err(e) => {
            tracing::warn!("web push disabled (VAPID key generation failed): {}", e);
            None
        }
    }
}

/// Returns (public_key_b64url, private_scalar_b64url).
fn generate() -> Result<(String, String), String> {
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let public_point = secret.public_key().to_encoded_point(false); // uncompressed (65 bytes)
    let public_b64 = URL_SAFE_NO_PAD.encode(public_point.as_bytes());
    let private_b64 = URL_SAFE_NO_PAD.encode(secret.to_bytes());
    Ok((public_b64, private_b64))
}

async fn get_meta(pool: &PgPool, key: &str) -> Option<String> {
    sqlx::query("SELECT value FROM app_meta WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("value").ok())
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
