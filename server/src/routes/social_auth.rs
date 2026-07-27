//! Social sign-in — Google and GitHub.
//!
//! Contract: docs/arch/01-core.md, "Social sign-in".
//!
//! Protocol lives in `crate::social_oauth`; this module owns policy, and there are
//! exactly four rules it enforces. Change them here, nowhere else:
//!
//! 1. **Identity is `(provider, provider_user_id)`.** A returning user is found by
//!    that pair. Emails are display data.
//! 2. **Linking to an existing sharp account requires a provider-verified email.**
//!    An unverified provider address that happens to match a sharp user is refused,
//!    with instructions to sign in and link from Settings — otherwise any provider
//!    that lets you type an arbitrary address becomes an account-takeover path.
//! 3. **A first-time provider identity is a signup**, so it obeys
//!    `SHARP_DISABLE_SIGNUP` exactly as `POST /auth/register` does, including the
//!    first-user-always-allowed exception.
//! 4. **The callback never puts a session JWT in a URL.** It mints a single-use,
//!    60-second handoff code (`auth_handoff_codes`) and the SPA exchanges it.
//!
//! The `state` JWT is signed with `JWT_SECRET` and pinned to its provider; for
//! sign-in flows it is additionally bound to an HttpOnly nonce cookie, so a
//! callback replayed into someone else's browser is rejected (login CSRF).

use crate::auth::{create_token, user_from_row, AuthResponse, AuthUser};
use crate::error::{AppError, AppResult};
use crate::social_oauth::{self, Identity, Provider, StateInput};
use crate::state::SharedState;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use super::{callback_page, redirect_302};

/// How long the SPA has to exchange a handoff code. Only has to survive one
/// redirect, so it is deliberately tiny.
const HANDOFF_TTL: Duration = Duration::seconds(60);

/// Name of the HttpOnly cookie holding the sign-in flow's nonce.
const STATE_COOKIE: &str = "sharp_oauth_state";

// --- Wire types --------------------------------------------------------------

#[derive(Serialize)]
pub struct OAuthConfig {
    pub google: bool,
    pub github: bool,
}

#[derive(Serialize)]
pub struct LinkedAccount {
    pub provider: String,
    pub email: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct LinkedAccounts {
    /// Whether the caller also has a password. The UI needs it to explain why the
    /// last remaining sign-in method can't be removed.
    pub has_password: bool,
    pub accounts: Vec<LinkedAccount>,
}

#[derive(Serialize)]
pub struct StartUrl {
    pub url: String,
}

#[derive(Deserialize)]
pub struct StartQuery {
    /// Desktop bridge: deep-link scheme to return through (e.g. `sharp`).
    pub scheme: Option<String>,
    /// Desktop bridge: the native app's own state value, echoed back untouched.
    pub state: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct ExchangeRequest {
    pub code: String,
}

// --- Config ------------------------------------------------------------------

/// GET /auth/oauth/config — which providers this server offers. Unauthenticated:
/// the login screen calls it before anyone is signed in.
pub async fn config(State(state): State<SharedState>) -> Json<OAuthConfig> {
    Json(OAuthConfig {
        google: state.config.oauth.google.is_some(),
        github: state.config.oauth.github.is_some(),
    })
}

fn provider_config(
    state: &SharedState,
    provider: Provider,
) -> AppResult<crate::config::OAuthProviderConfig> {
    let cfg = match provider {
        Provider::Google => state.config.oauth.google.clone(),
        Provider::Github => state.config.oauth.github.clone(),
    };
    cfg.ok_or_else(|| {
        AppError::NotImplemented(format!(
            "{} sign-in is not configured on this server",
            provider.label()
        ))
    })
}

fn parse_provider(slug: &str) -> AppResult<Provider> {
    Provider::parse(slug).ok_or_else(|| AppError::NotFound("unknown provider".to_string()))
}

// --- Notices -----------------------------------------------------------------

/// An HTML notice with an honest status code. These paths are browser navigations,
/// so the body is a page rather than the JSON error envelope — but a failure must
/// still not answer 200, or monitoring reads a broken sign-in as a healthy one.
fn notice(status: StatusCode, heading: &str, message: &str) -> Response {
    (status, callback_page(heading, message)).into_response()
}

/// Same, deriving the status from the error that produced it.
fn error_notice(heading: &str, err: &AppError) -> Response {
    let status = match err {
        AppError::NotFound(_) => StatusCode::NOT_FOUND,
        AppError::NotImplemented(_) => StatusCode::NOT_IMPLEMENTED,
        AppError::Forbidden(_) => StatusCode::FORBIDDEN,
        AppError::Conflict(_) => StatusCode::CONFLICT,
        AppError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
        AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
        AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    notice(status, heading, &user_message(err))
}

// --- Start -------------------------------------------------------------------

/// Deep-link schemes the desktop bridge may return through. Anything outside this
/// shape is refused so the `scheme` parameter can't be turned into an open
/// redirect to a web origin.
fn valid_scheme(scheme: &str) -> bool {
    !matches!(
        scheme,
        "http" | "https" | "javascript" | "data" | "file" | "vbscript" | "about" | "blob"
    ) && scheme.len() <= 32
        && scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase())
        && scheme
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
}

/// GET /auth/oauth/:provider/start — begin a sign-in. Unauthenticated: this *is*
/// the sign-in. Sets the nonce cookie and redirects to the provider's consent
/// screen. Called by a browser navigation, so it answers with a redirect (or an
/// HTML notice) rather than JSON.
pub async fn start(
    State(state): State<SharedState>,
    Path(provider): Path<String>,
    Query(q): Query<StartQuery>,
) -> Response {
    let (provider, cfg) = match parse_provider(&provider).and_then(|p| {
        let cfg = provider_config(&state, p)?;
        Ok((p, cfg))
    }) {
        Ok(v) => v,
        Err(e) => return error_notice("Sign-in unavailable", &e),
    };

    let desktop_scheme = q.scheme.filter(|s| valid_scheme(s));
    // A desktop handoff needs both halves; a scheme we refused means the caller is
    // not a bridge we recognise, so drop its state too.
    let desktop_state = desktop_scheme.as_ref().and(q.state);

    let nonce = social_oauth::random_token();
    let state_jwt = match social_oauth::make_state(
        &StateInput {
            provider,
            nonce: nonce.clone(),
            link_user_id: None,
            desktop_scheme,
            desktop_state,
        },
        &state.config.jwt_secret,
    ) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("oauth state mint failed: {}", e);
            return notice(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Sign-in failed",
                "Could not start sign-in.",
            );
        }
    };

    let url = social_oauth::authorize_url(provider, &cfg, &state_jwt);
    // SameSite=Lax is required, not incidental: the provider returns via a
    // top-level GET redirect, which Lax allows and Strict would strip.
    let secure = if cfg.redirect_uri.starts_with("https://") {
        " Secure;"
    } else {
        ""
    };
    let cookie = format!(
        "{STATE_COOKIE}={nonce}; Path=/api/v1/auth/oauth; Max-Age=600; HttpOnly; SameSite=Lax;{secure}"
    );

    (
        StatusCode::FOUND,
        [
            (header::LOCATION, url),
            (header::SET_COOKIE, cookie),
        ],
    )
        .into_response()
}

/// POST /auth/oauth/:provider/link — authenticated: attach a provider to the
/// signed-in account. Returns the consent URL for the client to open, matching
/// the calendar-connect shape. No nonce cookie is involved; the flow is bound to
/// the caller through `link_user_id` inside the signed state.
pub async fn link_start(
    State(state): State<SharedState>,
    user: AuthUser,
    Path(provider): Path<String>,
) -> AppResult<Json<StartUrl>> {
    let provider = parse_provider(&provider)?;
    let cfg = provider_config(&state, provider)?;

    let state_jwt = social_oauth::make_state(
        &StateInput {
            provider,
            nonce: social_oauth::random_token(),
            link_user_id: Some(user.id),
            desktop_scheme: None,
            desktop_state: None,
        },
        &state.config.jwt_secret,
    )
    .map_err(AppError::Internal)?;

    Ok(Json(StartUrl {
        url: social_oauth::authorize_url(provider, &cfg, &state_jwt),
    }))
}

// --- Callback ----------------------------------------------------------------

/// Where a failed *sign-in* should land: back on the SPA's login screen with the
/// reason, so the user sees it where they started rather than on a dead-end page.
fn login_error_redirect(state: &SharedState, headers: &HeaderMap, message: &str) -> Response {
    match crate::auth::resolve_app_url(state, headers) {
        Some(base) => {
            let query =
                serde_urlencoded::to_string([("oauth_error", message)]).unwrap_or_default();
            redirect_302(&format!("{base}/login?{query}"))
        }
        None => notice(StatusCode::BAD_REQUEST, "Sign-in failed", message),
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// GET /auth/oauth/:provider/callback — unauthenticated; the signed `state` proves
/// the flow's origin. Completes the exchange, resolves the sharp user, and hands
/// off: a redirect carrying a one-time code (web), a `<scheme>://auth` deep link
/// (desktop), or an HTML notice (account linking, which runs in its own tab).
pub async fn callback(
    State(state): State<SharedState>,
    Path(provider_slug): Path<String>,
    Query(q): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let provider = match parse_provider(&provider_slug) {
        Ok(p) => p,
        Err(_) => return notice(StatusCode::NOT_FOUND, "Sign-in failed", "Unknown provider."),
    };

    // The state has to be read before anything else can be decided — it says
    // whether this is a sign-in, a link, or a desktop handoff.
    let claims = q
        .state
        .as_deref()
        .and_then(|s| social_oauth::verify_state(s, provider, &state.config.jwt_secret));

    let Some(claims) = claims else {
        return notice(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            "This sign-in link expired or was invalid. Please try again.",
        );
    };
    let linking = claims.link_user_id;

    // From here on, failures are reported in the style that matches the flow.
    macro_rules! fail {
        ($msg:expr) => {{
            let msg: &str = $msg;
            return if linking.is_some() || claims.desktop_scheme.is_some() {
                notice(StatusCode::BAD_REQUEST, "Sign-in failed", msg)
            } else {
                login_error_redirect(&state, &headers, msg)
            };
        }};
    }

    if let Some(err) = q.error {
        // The provider's own error string; escaped by `callback_page` and
        // percent-encoded into the redirect, never interpolated raw.
        fail!(&format!("{} reported: {err}", provider.label()));
    }

    let Some(cfg) = (match provider {
        Provider::Google => state.config.oauth.google.clone(),
        Provider::Github => state.config.oauth.github.clone(),
    }) else {
        fail!("This sign-in method is not configured on this server.");
    };

    // Login CSRF guard. Only the sign-in flow needs it — the linking flow is
    // already bound to an authenticated user id inside the state.
    if linking.is_none() && cookie_value(&headers, STATE_COOKIE).as_deref() != Some(&claims.nonce) {
        fail!("This sign-in could not be verified. Start again from the login screen.");
    }

    let Some(code) = q.code else {
        fail!("Missing authorization code.");
    };

    let access_token = match social_oauth::exchange_code(provider, &cfg, &code).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("{} oauth exchange failed: {}", provider.slug(), e);
            fail!("Could not complete sign-in with the provider.");
        }
    };

    let identity = match social_oauth::fetch_identity(provider, &access_token).await {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("{} identity fetch failed: {}", provider.slug(), e);
            fail!("Could not read your account details from the provider.");
        }
    };

    // ── Linking an already-signed-in account ────────────────────────────────
    if let Some(user_id) = linking {
        return match link_identity(&state, user_id, provider, &identity).await {
            Ok(()) => notice(
                StatusCode::OK,
                &format!("{} connected", provider.label()),
                "You can close this tab and return to sharp.",
            ),
            Err(e) => error_notice("Could not connect", &e),
        };
    }

    // ── Sign-in / signup ────────────────────────────────────────────────────
    let user_id = match resolve_sign_in(&state, provider, &identity).await {
        Ok(id) => id,
        Err(e) => fail!(&user_message(&e)),
    };

    // Desktop bridge: reuse the existing one-time desktop code + deep link, so the
    // native app's exchange path is unchanged.
    if let (Some(scheme), Some(native_state)) = (&claims.desktop_scheme, &claims.desktop_state) {
        let code = crate::auth::mint_desktop_code(&state, user_id);
        let code = match code {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("desktop code mint failed: {}", e);
                return notice(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Sign-in failed",
                    "Could not complete sign-in.",
                );
            }
        };
        let query = serde_urlencoded::to_string([("code", code.as_str()), ("state", native_state)])
            .unwrap_or_default();
        return redirect_302(&format!("{scheme}://auth?{query}"));
    }

    // Web: hand the SPA a single-use code instead of the token itself.
    let handoff = match mint_handoff_code(&state, user_id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("oauth handoff mint failed: {}", e);
            fail!("Could not complete sign-in.");
        }
    };

    let base = crate::auth::resolve_app_url(&state, &headers);
    let Some(base) = base else {
        return notice(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            "Could not determine where to return you.",
        );
    };
    let query = serde_urlencoded::to_string([("code", handoff.as_str())]).unwrap_or_default();
    // Clear the nonce cookie on the way out — it has done its job.
    (
        StatusCode::FOUND,
        [
            (header::LOCATION, format!("{base}/oauth?{query}")),
            (
                header::SET_COOKIE,
                format!("{STATE_COOKIE}=; Path=/api/v1/auth/oauth; Max-Age=0; HttpOnly"),
            ),
        ],
    )
        .into_response()
}

/// Error text safe to show a signed-out visitor. Internal failures are logged with
/// detail and reported generically.
fn user_message(err: &AppError) -> String {
    match err {
        AppError::Internal(m) => {
            tracing::error!("social sign-in internal error: {}", m);
            "Something went wrong completing sign-in.".to_string()
        }
        other => {
            let text = other.to_string();
            // AppError::Display is "code: message"; only the message is useful here.
            text.split_once(": ")
                .map(|(_, m)| m.to_string())
                .unwrap_or(text)
        }
    }
}

// --- Identity resolution -----------------------------------------------------

/// Find or create the sharp user behind a provider identity. See the four policy
/// rules in the module header.
async fn resolve_sign_in(
    state: &SharedState,
    provider: Provider,
    identity: &Identity,
) -> AppResult<Uuid> {
    // 1. Returning user: matched on the provider's subject id.
    let existing = sqlx::query(
        "SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2",
    )
    .bind(provider.slug())
    .bind(&identity.provider_user_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(row) = existing {
        let user_id: Uuid = row.try_get("user_id")?;
        // Keep the displayed email current; identity is the subject id, so a
        // changed provider email is not a new account.
        if let Some(email) = normalized_email(identity) {
            sqlx::query(
                "UPDATE oauth_accounts SET email = $1
                 WHERE provider = $2 AND provider_user_id = $3",
            )
            .bind(&email)
            .bind(provider.slug())
            .bind(&identity.provider_user_id)
            .execute(&state.pool)
            .await?;
        }
        return Ok(user_id);
    }

    let Some(email) = normalized_email(identity) else {
        return Err(AppError::Validation(format!(
            "{} did not share an email address. Add one to your {} account, or sign in with a password.",
            provider.label(),
            provider.label()
        )));
    };

    // 2. An existing sharp account with the same email: link only if the provider
    //    vouches for the address.
    let by_email = sqlx::query("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;

    if let Some(row) = by_email {
        if !identity.email_verified {
            return Err(AppError::Forbidden(format!(
                "{email} already has a sharp account, and {} hasn't verified that address. \
                 Sign in with your password, then connect {} from Settings → Accounts.",
                provider.label(),
                provider.label()
            )));
        }
        let user_id: Uuid = row.try_get("id")?;
        insert_account(state, user_id, provider, &identity.provider_user_id, &email).await?;
        return Ok(user_id);
    }

    // 3. First-time identity — this is a signup, and obeys the same gate as
    //    POST /auth/register (first user always allowed).
    if state.config.disable_signup {
        let count: i64 = sqlx::query("SELECT count(*) AS c FROM users")
            .fetch_one(&state.pool)
            .await?
            .try_get("c")?;
        if count > 0 {
            return Err(AppError::Forbidden("signups are disabled".to_string()));
        }
    }

    let display_name = identity
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(64).collect::<String>())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("member").to_string());

    let mut tx = state.pool.begin().await?;
    // password_hash stays NULL: there is no password, and "Forgot password?" is how
    // such an account adds one. avatar_url stays NULL too — it is an internal authed
    // API path in this app, not an arbitrary URL, so a provider picture can't go there.
    let row = sqlx::query(
        "INSERT INTO users (email, display_name) VALUES ($1, $2)
         RETURNING id, email, display_name, avatar_url, created_at",
    )
    .bind(&email)
    .bind(&display_name)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match &e {
        // Two concurrent first sign-ins for the same address.
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("that email is already registered".to_string())
        }
        _ => AppError::from(e),
    })?;
    let user_id: Uuid = row.try_get("id")?;

    sqlx::query(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(provider.slug())
    .bind(&identity.provider_user_id)
    .bind(user_id)
    .bind(&email)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(user_id)
}

fn normalized_email(identity: &Identity) -> Option<String> {
    identity
        .email
        .as_deref()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.contains('@'))
}

async fn insert_account(
    state: &SharedState,
    user_id: Uuid,
    provider: Provider,
    provider_user_id: &str,
    email: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(provider.slug())
    .bind(provider_user_id)
    .bind(user_id)
    .bind(email)
    .execute(&state.pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.is_unique_violation() => AppError::Conflict(format!(
            "a {} account is already connected",
            provider.slug()
        )),
        _ => AppError::from(e),
    })?;
    Ok(())
}

/// Attach a provider identity to a specific, already-authenticated user.
async fn link_identity(
    state: &SharedState,
    user_id: Uuid,
    provider: Provider,
    identity: &Identity,
) -> AppResult<()> {
    let existing = sqlx::query(
        "SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2",
    )
    .bind(provider.slug())
    .bind(&identity.provider_user_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(row) = existing {
        let owner: Uuid = row.try_get("user_id")?;
        return if owner == user_id {
            Ok(()) // Already connected — idempotent.
        } else {
            Err(AppError::Conflict(format!(
                "That {} account is already connected to a different sharp account.",
                provider.label()
            )))
        };
    }

    let email = normalized_email(identity);
    sqlx::query(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(provider.slug())
    .bind(&identity.provider_user_id)
    .bind(user_id)
    .bind(&email)
    .execute(&state.pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.is_unique_violation() => AppError::Conflict(format!(
            "You already have a {} account connected. Disconnect it first.",
            provider.label()
        )),
        _ => AppError::from(e),
    })?;
    Ok(())
}

// --- Handoff codes -----------------------------------------------------------

async fn mint_handoff_code(state: &SharedState, user_id: Uuid) -> AppResult<String> {
    let raw = social_oauth::random_token();
    // Opportunistic prune: no scheduled job, and expired rows are worthless.
    sqlx::query("DELETE FROM auth_handoff_codes WHERE expires_at < now()")
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO auth_handoff_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(crate::auth::sha256_hex(&raw))
    .bind(user_id)
    .bind(Utc::now() + HANDOFF_TTL)
    .execute(&state.pool)
    .await?;
    Ok(raw)
}

/// POST /auth/oauth/exchange — unauthenticated; the code is the credential. Single
/// use (the DELETE is the claim) and must be unexpired.
pub async fn exchange(
    State(state): State<SharedState>,
    Json(body): Json<ExchangeRequest>,
) -> AppResult<Json<AuthResponse>> {
    let code_hash = crate::auth::sha256_hex(body.code.trim());

    let row = sqlx::query(
        "DELETE FROM auth_handoff_codes
         WHERE code_hash = $1 AND expires_at > now()
         RETURNING user_id",
    )
    .bind(&code_hash)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid or expired code".to_string()))?;

    let user_id: Uuid = row.try_get("user_id")?;

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

// --- Managing linked accounts ------------------------------------------------

/// GET /auth/oauth/accounts — the caller's connected sign-in providers.
pub async fn list_accounts(
    State(state): State<SharedState>,
    user: AuthUser,
) -> AppResult<Json<LinkedAccounts>> {
    let rows = sqlx::query(
        "SELECT provider, email, created_at FROM oauth_accounts
         WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;

    let accounts = rows
        .iter()
        .map(|row| {
            Ok(LinkedAccount {
                provider: row.try_get("provider")?,
                email: row.try_get("email")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    let has_password: bool = sqlx::query("SELECT password_hash IS NOT NULL AS has FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?
        .try_get("has")?;

    Ok(Json(LinkedAccounts {
        has_password,
        accounts,
    }))
}

/// DELETE /auth/oauth/:provider — disconnect a provider.
///
/// Refuses to remove the caller's last remaining way in: an account with no
/// password and no other provider would become unreachable.
pub async fn unlink(
    State(state): State<SharedState>,
    user: AuthUser,
    Path(provider): Path<String>,
) -> AppResult<StatusCode> {
    let provider = parse_provider(&provider)?;

    let row = sqlx::query(
        "SELECT
             (SELECT password_hash IS NOT NULL FROM users WHERE id = $1) AS has_password,
             (SELECT count(*) FROM oauth_accounts WHERE user_id = $1) AS provider_count",
    )
    .bind(user.id)
    .fetch_one(&state.pool)
    .await?;
    let has_password: bool = row.try_get::<Option<bool>, _>("has_password")?.unwrap_or(false);
    let provider_count: i64 = row.try_get("provider_count")?;

    if !has_password && provider_count <= 1 {
        return Err(AppError::Validation(
            "This is your only way to sign in. Set a password with \"Forgot password?\" \
             or connect another provider first."
                .to_string(),
        ));
    }

    let result = sqlx::query("DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = $2")
        .bind(user.id)
        .bind(provider.slug())
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("not connected".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_allowlist_rejects_web_and_script_schemes() {
        assert!(valid_scheme("sharp"));
        assert!(valid_scheme("sharp-dev"));
        for bad in ["http", "https", "javascript", "data", "file", "Sharp", "1sharp", ""] {
            assert!(!valid_scheme(bad), "{bad} must be refused");
        }
        assert!(!valid_scheme(&"a".repeat(33)));
    }

    #[test]
    fn cookie_value_reads_one_of_many() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=1; sharp_oauth_state=abc123; third=x".parse().unwrap(),
        );
        assert_eq!(
            cookie_value(&headers, STATE_COOKIE).as_deref(),
            Some("abc123")
        );
        assert!(cookie_value(&headers, "missing").is_none());
        assert!(cookie_value(&HeaderMap::new(), STATE_COOKIE).is_none());
    }

    #[test]
    fn user_message_strips_the_error_code_prefix() {
        let msg = user_message(&AppError::Forbidden("signups are disabled".to_string()));
        assert_eq!(msg, "signups are disabled");
        // Internal detail is never shown.
        let msg = user_message(&AppError::Internal("db exploded at 0x41".to_string()));
        assert!(!msg.contains("0x41"));
    }
}
