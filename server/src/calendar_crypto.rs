//! Calendar OAuth token encryption at rest.
//!
//! Google access/refresh tokens are secrets: leaking them grants read access to
//! a user's calendar. We never store them in plaintext. The encryption key is
//! derived from the server's existing `JWT_SECRET` via HKDF-SHA256 (no new secret
//! to configure), and each token is sealed with AES-256-GCM using a fresh random
//! 12-byte nonce prepended to the ciphertext, the whole blob base64-encoded.
//!
//! Wire/storage format of an encrypted token: `base64( nonce[12] || ciphertext )`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

const HKDF_INFO: &[u8] = b"sharp-calendar-token-v1";
const NONCE_LEN: usize = 12;

/// Derive the 32-byte AES key from the server's JWT secret. Deterministic, so any
/// replica sharing `JWT_SECRET` can decrypt what another sealed.
pub fn key(jwt_secret: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, jwt_secret.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO, &mut out)
        .expect("32 is a valid HKDF-SHA256 output length");
    out
}

/// Seal `plaintext` with AES-256-GCM under a key derived from `jwt_secret`.
/// Returns `base64(nonce || ciphertext)`.
#[allow(deprecated)] // GenericArray::from_slice deprecation is upstream (generic-array 0.x).
pub fn encrypt(jwt_secret: &str, plaintext: &str) -> Result<String, String> {
    let key_bytes = key(jwt_secret);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("calendar token encrypt: {e}"))?;

    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(blob))
}

/// Reverse of [`encrypt`]. Fails on tamper, wrong key, or malformed input.
#[allow(deprecated)] // GenericArray::from_slice deprecation is upstream (generic-array 0.x).
pub fn decrypt(jwt_secret: &str, encoded: &str) -> Result<String, String> {
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("calendar token base64: {e}"))?;
    if blob.len() <= NONCE_LEN {
        return Err("calendar token ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);

    let key_bytes = key(jwt_secret);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("calendar token decrypt: {e}"))?;
    String::from_utf8(plaintext).map_err(|e| format!("calendar token utf8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "dev-only-secret";

    #[test]
    fn round_trip() {
        let token = "ya29.a0ArrDeadBeef-Refresh_Token.value";
        let sealed = encrypt(SECRET, token).unwrap();
        assert_ne!(sealed, token, "ciphertext must not be plaintext");
        let opened = decrypt(SECRET, &sealed).unwrap();
        assert_eq!(opened, token);
    }

    #[test]
    fn nonce_is_random_so_ciphertexts_differ() {
        let a = encrypt(SECRET, "same").unwrap();
        let b = encrypt(SECRET, "same").unwrap();
        assert_ne!(a, b, "fresh nonce should make each ciphertext unique");
        assert_eq!(decrypt(SECRET, &a).unwrap(), "same");
        assert_eq!(decrypt(SECRET, &b).unwrap(), "same");
    }

    #[test]
    fn wrong_secret_fails() {
        let sealed = encrypt(SECRET, "secret-token").unwrap();
        assert!(decrypt("a-different-secret", &sealed).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let sealed = encrypt(SECRET, "secret-token").unwrap();
        let mut raw = base64::engine::general_purpose::STANDARD
            .decode(sealed.as_bytes())
            .unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        let tampered = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert!(decrypt(SECRET, &tampered).is_err());
    }
}
