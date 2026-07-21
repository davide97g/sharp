use crate::auth::VoiceConfigAuth;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header::CONTENT_TYPE, HeaderMap};
use axum::Json;
use serde_json::json;

pub async fn voice_config(
    State(state): State<SharedState>,
    _auth: VoiceConfigAuth,
) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "provider": "livekit",
        "available": state.config.livekit.is_some(),
        "server_url": state.config.livekit.as_ref().map(|config| config.url.as_str()),
        "transcription": state.config.transcribe.is_some(),
    })))
}

/// Accepts one encoded audio segment as the raw request body. The browser sends
/// its MediaRecorder content type (`audio/webm;codecs=opus` or `audio/mp4`).
pub async fn transcribe_audio(
    State(state): State<SharedState>,
    _auth: VoiceConfigAuth,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<serde_json::Value>> {
    let cfg = state.config.transcribe.as_ref().ok_or_else(|| {
        AppError::NotImplemented("live call transcription is not configured".to_string())
    })?;
    let mime = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::BadRequest("audio content type is required".to_string()))?;
    if !mime.to_ascii_lowercase().starts_with("audio/") {
        return Err(AppError::BadRequest(
            "content type must be encoded audio".to_string(),
        ));
    }
    if body.is_empty() {
        return Ok(Json(json!({ "text": "" })));
    }

    let filename = if mime.to_ascii_lowercase().starts_with("audio/mp4") {
        "segment.m4a"
    } else {
        "segment.webm"
    };
    let text = crate::ai::transcribe(cfg, body.to_vec(), mime, filename)
        .await
        .map_err(|error| {
            tracing::warn!("audio transcription failed: {}", error);
            AppError::ServiceUnavailable("transcription provider request failed".to_string())
        })?;

    Ok(Json(json!({ "text": text })))
}
