use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::Attachment;
use crate::routes::{channel_kind, is_member, member_role};
use crate::state::SharedState;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use sqlx::Row;
use uuid::Uuid;

fn attachment_url(id: Uuid) -> String {
    format!("/api/v1/files/{id}")
}

/// Strip characters that would break a Content-Disposition header.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| *c != '"' && *c != '\\' && !c.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.chars().take(255).collect()
    }
}

/// A conservative allowlist of content types safe to render inline. Everything
/// else (notably `image/svg+xml` and `text/html`, which can carry script) is
/// served as an opaque download so it cannot execute in the app's origin.
fn is_safe_inline(content_type: &str) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if ct == "image/svg+xml" {
        return false;
    }
    ct.starts_with("image/")
        || ct.starts_with("video/")
        || ct.starts_with("audio/")
        || ct == "application/pdf"
        || ct == "text/plain"
}

async fn require_member(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !is_member(&state.pool, channel_id, user_id).await? {
        return Err(AppError::Forbidden("not a member of this channel".to_string()));
    }
    Ok(())
}

async fn require_can_post(state: &SharedState, channel_id: Uuid, user_id: Uuid) -> AppResult<()> {
    if channel_kind(&state.pool, channel_id).await?.is_none() {
        return Err(AppError::NotFound("channel not found".to_string()));
    }
    if !member_role(&state.pool, channel_id, user_id)
        .await?
        .is_some_and(|role| role.can_post())
    {
        return Err(AppError::Forbidden(
            "uploading requires owner or editor role".to_string(),
        ));
    }
    Ok(())
}

pub async fn upload(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Attachment>)> {
    require_can_post(&state, channel_id, auth.id).await?;
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("file uploads are not configured".to_string()))?;
    // Find the "file" field (accept the first file-bearing field otherwise).
    let mut chosen: Option<(String, String, bytes::Bytes)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid upload: {e}")))?
    {
        let is_file = field.name() == Some("file") || field.file_name().is_some();
        if !is_file {
            continue;
        }
        let filename = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "file".to_string());
        let declared_type = field.content_type().map(|s| s.to_string());
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("upload too large or malformed: {e}")))?;
        let content_type = declared_type.unwrap_or_else(|| {
            mime_guess::from_path(&filename)
                .first_or_octet_stream()
                .essence_str()
                .to_string()
        });
        chosen = Some((filename, content_type, data));
        break;
    }

    let (filename, content_type, data) =
        chosen.ok_or_else(|| AppError::BadRequest("no file field in upload".to_string()))?;

    if data.is_empty() {
        return Err(AppError::Validation("file is empty".to_string()));
    }
    if data.len() > state.config.max_upload_bytes {
        return Err(AppError::Validation(format!(
            "file exceeds the {} MB limit",
            state.config.max_upload_bytes / (1024 * 1024)
        )));
    }

    let file_id = Uuid::new_v4();
    let key = format!("channels/{channel_id}/{file_id}");
    let size = data.len() as i64;

    storage
        .put(&key, data)
        .await
        .map_err(|e| AppError::Internal(format!("storage put: {e}")))?;

    sqlx::query(
        "INSERT INTO files (id, channel_id, user_id, key, filename, content_type, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(file_id)
    .bind(channel_id)
    .bind(auth.id)
    .bind(&key)
    .bind(&filename)
    .bind(&content_type)
    .bind(size)
    .execute(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(Attachment {
            id: file_id,
            filename,
            content_type,
            size,
            url: attachment_url(file_id),
        }),
    ))
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    pub download: Option<String>,
}

pub async fn download(
    State(state): State<SharedState>,
    Path(file_id): Path<Uuid>,
    auth: AuthUser,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Response> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| AppError::NotFound("file not found".to_string()))?;

    let row = sqlx::query(
        "SELECT channel_id, key, filename, content_type, size FROM files WHERE id = $1",
    )
    .bind(file_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("file not found".to_string()))?;

    let channel_id: Uuid = row.try_get("channel_id")?;
    require_member(&state, channel_id, auth.id).await?;

    let key: String = row.try_get("key")?;
    let filename: String = row.try_get("filename")?;
    let content_type: String = row.try_get("content_type")?;
    let size: i64 = row.try_get("size")?;

    let result = storage
        .get(&key)
        .await
        .map_err(|e| AppError::Internal(format!("storage get: {e}")))?;

    // Render inline only for a safe allowlist and only when not forced to download.
    // Anything else is served as an opaque octet-stream attachment so it cannot run
    // script in the app's origin (stored-XSS defense; e.g. uploaded SVG/HTML).
    let inline = q.download.is_none() && is_safe_inline(&content_type);
    let (serve_type, disposition_kind) = if inline {
        (content_type.as_str(), "inline")
    } else {
        ("application/octet-stream", "attachment")
    };
    let disposition = format!(
        "{}; filename=\"{}\"",
        disposition_kind,
        sanitize_filename(&filename)
    );

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(serve_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        )
        .header(header::CONTENT_LENGTH, size)
        .header(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        )
        .header(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=86400"),
        )
        .body(Body::from_stream(result.into_stream()))
        .map_err(|e| AppError::Internal(format!("response build: {e}")))?;

    if let Ok(v) = HeaderValue::from_str(&disposition) {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }

    Ok(response)
}
