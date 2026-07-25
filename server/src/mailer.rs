//! Outbound transactional email.
//!
//! Two interchangeable backends: Resend's HTTP API (no outbound SMTP ports
//! required — the default choice on hosts that block them) and any SMTP relay
//! via lettre/rustls. The backend is chosen once at startup from [`MailConfig`];
//! `None` in [`AppState`](crate::state::AppState) means email is unconfigured and
//! every email-dependent feature degrades gracefully.
//!
//! Only the password-reset flow uses this today.

use crate::config::{MailConfig, ResendConfig, SmtpConfig};
use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

#[derive(Clone)]
pub enum Mailer {
    Resend {
        api_key: String,
        from: String,
        base_url: String,
    },
    Smtp {
        transport: AsyncSmtpTransport<Tokio1Executor>,
        from: Mailbox,
    },
}

impl Mailer {
    /// Build the backend from config. Returns an error string on a bad From
    /// address or TLS setup so startup can log it and continue without email.
    pub fn from_config(cfg: &MailConfig) -> Result<Self, String> {
        match cfg {
            MailConfig::Resend(cfg) => Self::resend(cfg),
            MailConfig::Smtp(cfg) => Self::smtp(cfg),
        }
    }

    /// Human-readable backend name for startup logs.
    pub fn backend(&self) -> &'static str {
        match self {
            Mailer::Resend { .. } => "resend",
            Mailer::Smtp { .. } => "smtp",
        }
    }

    fn resend(cfg: &ResendConfig) -> Result<Self, String> {
        // Parsed only to reject a malformed From at startup rather than on the
        // first send; Resend takes the raw string.
        cfg.from
            .parse::<Mailbox>()
            .map_err(|e| format!("invalid EMAIL_FROM address: {e}"))?;

        Ok(Mailer::Resend {
            api_key: cfg.api_key.clone(),
            from: cfg.from.clone(),
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
        })
    }

    fn smtp(cfg: &SmtpConfig) -> Result<Self, String> {
        let from: Mailbox = cfg
            .from
            .parse()
            .map_err(|e| format!("invalid EMAIL_FROM address: {e}"))?;

        let mut builder = if cfg.implicit_tls {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
                .map_err(|e| format!("smtp relay: {e}"))?
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
                .map_err(|e| format!("smtp starttls relay: {e}"))?
        }
        .port(cfg.port);

        if let (Some(user), Some(pass)) = (&cfg.username, &cfg.password) {
            builder = builder.credentials(Credentials::new(user.clone(), pass.clone()));
        }

        Ok(Mailer::Smtp {
            transport: builder.build(),
            from,
        })
    }

    /// Send a multipart (plain + HTML) message. `to` is a bare address.
    pub async fn send(&self, to: &str, subject: &str, text: &str, html: &str) -> Result<(), String> {
        match self {
            Mailer::Resend {
                api_key,
                from,
                base_url,
            } => {
                let body = serde_json::json!({
                    "from": from,
                    "to": [to],
                    "subject": subject,
                    "text": text,
                    "html": html,
                });

                let response = crate::http::client()
                    .post(format!("{base_url}/emails"))
                    .bearer_auth(api_key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("resend send: {e}"))?;

                let status = response.status();
                if !status.is_success() {
                    // Resend returns a JSON body with a `message` field; fall back
                    // to whatever text came back so the log is never empty.
                    let detail = response.text().await.unwrap_or_default();
                    return Err(format!("resend send: HTTP {status}: {detail}"));
                }
                Ok(())
            }
            Mailer::Smtp { transport, from } => {
                let to: Mailbox = to.parse().map_err(|e| format!("invalid recipient: {e}"))?;
                let message = Message::builder()
                    .from(from.clone())
                    .to(to)
                    .subject(subject)
                    .multipart(
                        MultiPart::alternative()
                            .singlepart(
                                SinglePart::builder()
                                    .header(ContentType::TEXT_PLAIN)
                                    .body(text.to_string()),
                            )
                            .singlepart(
                                SinglePart::builder()
                                    .header(ContentType::TEXT_HTML)
                                    .body(html.to_string()),
                            ),
                    )
                    .map_err(|e| format!("build message: {e}"))?;

                transport
                    .send(message)
                    .await
                    .map_err(|e| format!("send: {e}"))?;
                Ok(())
            }
        }
    }
}
