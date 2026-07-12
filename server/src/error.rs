use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    Validation(String),
    Internal(String),
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str, &str) {
        match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m),
            AppError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, "unauthorized", m),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", m),
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, "not_found", m),
            AppError::Conflict(m) => (StatusCode::CONFLICT, "conflict", m),
            AppError::Validation(m) => (StatusCode::UNPROCESSABLE_ENTITY, "validation", m),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", m),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (_, code, message) = self.parts();
        write!(f, "{}: {}", code, message)
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        let body = Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        }));
        (status, body).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => AppError::NotFound("not found".to_string()),
            other => AppError::Internal(format!("database error: {}", other)),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
