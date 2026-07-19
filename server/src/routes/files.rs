use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::Attachment;
use crate::routes::docs::{editable_doc_channel, require_doc_visible};
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
        return Err(AppError::Forbidden(
            "not a member of this channel".to_string(),
        ));
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

fn normalized_content_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Validate both MIME type and signature. Doc uploads are rendered inline, so
/// trusting the browser-declared MIME alone would not enforce image-only input.
fn is_supported_doc_image(content_type: &str, data: &[u8]) -> bool {
    let content_type = normalized_content_type(content_type);
    match content_type.as_str() {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        "image/avif" => {
            data.len() >= 12
                && &data[4..8] == b"ftyp"
                && data[8..data.len().min(32)]
                    .chunks_exact(4)
                    .any(|brand| brand == b"avif" || brand == b"avis")
        }
        _ => false,
    }
}

pub async fn upload(
    State(state): State<SharedState>,
    Path(channel_id): Path<Uuid>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Attachment>)> {
    require_can_post(&state, channel_id, auth.id).await?;
    upload_inner(&state, channel_id, auth.id, None, &mut multipart).await
}

pub async fn upload_doc_image(
    State(state): State<SharedState>,
    Path(doc_id): Path<Uuid>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Attachment>)> {
    let channel_id = editable_doc_channel(&state.pool, doc_id, auth.id).await?;
    upload_inner(&state, channel_id, auth.id, Some(doc_id), &mut multipart).await
}

async fn upload_inner(
    state: &SharedState,
    channel_id: Uuid,
    user_id: Uuid,
    doc_id: Option<Uuid>,
    multipart: &mut Multipart,
) -> AppResult<(StatusCode, Json<Attachment>)> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("file uploads are not configured".to_string()))?;
    // Find the "file" field (accept the first file-bearing field otherwise) and
    // retain the optional encrypted marker regardless of multipart field order.
    let mut chosen: Option<(String, String, bytes::Bytes)> = None;
    let mut encrypted = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid upload: {e}")))?
    {
        if field.name() == Some("encrypted") && field.file_name().is_none() {
            let value = field
                .text()
                .await
                .map_err(|e| AppError::BadRequest(format!("invalid encrypted field: {e}")))?;
            encrypted = match value.trim() {
                "true" | "1" => true,
                "false" | "0" | "" => false,
                _ => {
                    return Err(AppError::BadRequest(
                        "encrypted must be true, false, 1, or 0".to_string(),
                    ))
                }
            };
            continue;
        }
        let is_file = field.name() == Some("file") || field.file_name().is_some();
        if !is_file || chosen.is_some() {
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
    if doc_id.is_some() {
        if encrypted {
            return Err(AppError::Validation(
                "doc images cannot be encrypted attachments".to_string(),
            ));
        }
        if !is_supported_doc_image(&content_type, &data) {
            return Err(AppError::Validation(
                "doc attachments must be PNG, JPEG, GIF, WebP, or AVIF images".to_string(),
            ));
        }
    }

    let file_id = Uuid::new_v4();
    let key = match doc_id {
        Some(doc_id) => format!("docs/{doc_id}/{file_id}"),
        None => format!("channels/{channel_id}/{file_id}"),
    };
    let size = data.len() as i64;

    storage
        .put(&key, data)
        .await
        .map_err(|e| AppError::Internal(format!("storage put: {e}")))?;

    sqlx::query(
        "INSERT INTO files
            (id, channel_id, doc_id, user_id, key, filename, content_type, size, encrypted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(file_id)
    .bind(channel_id)
    .bind(doc_id)
    .bind(user_id)
    .bind(&key)
    .bind(&filename)
    .bind(&content_type)
    .bind(size)
    .bind(encrypted)
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
            encrypted,
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
        "SELECT channel_id, doc_id, key, filename, content_type, size FROM files WHERE id = $1",
    )
    .bind(file_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("file not found".to_string()))?;

    let channel_id: Uuid = row.try_get("channel_id")?;
    let doc_id: Option<Uuid> = row.try_get("doc_id")?;
    match doc_id {
        Some(doc_id) => require_doc_visible(&state.pool, doc_id, auth.id).await?,
        None => require_member(&state, channel_id, auth.id).await?,
    }

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
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, v);
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::is_supported_doc_image;

    #[test]
    fn doc_images_require_matching_raster_signatures() {
        assert!(is_supported_doc_image(
            "image/png",
            b"\x89PNG\r\n\x1a\nrest"
        ));
        assert!(is_supported_doc_image(
            "image/jpeg; charset=binary",
            &[0xff, 0xd8, 0xff, 0xe0]
        ));
        assert!(is_supported_doc_image(
            "image/webp",
            b"RIFF\x04\x00\x00\x00WEBP"
        ));
        assert!(!is_supported_doc_image(
            "image/png",
            b"<script>alert(1)</script>"
        ));
        assert!(!is_supported_doc_image("image/svg+xml", b"<svg></svg>"));
    }
}
