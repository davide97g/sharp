//! Outbound transactional email over SMTP (lettre, rustls).
//!
//! Only the password-reset flow uses this today. The transport is built once at
//! startup from [`SmtpConfig`] and shared via a connection pool; `None` in
//! [`AppState`](crate::state::AppState) means SMTP is unconfigured and every
//! email-dependent feature degrades gracefully.

use crate::config::SmtpConfig;
use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

#[derive(Clone)]
pub struct Mailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl Mailer {
    /// Build the transport from config. Returns an error string on a bad From
    /// address or TLS setup so startup can log it and continue without email.
    pub fn from_config(cfg: &SmtpConfig) -> Result<Self, String> {
        let from: Mailbox = cfg
            .from
            .parse()
            .map_err(|e| format!("invalid SMTP_FROM address: {e}"))?;

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

        Ok(Self {
            transport: builder.build(),
            from,
        })
    }

    /// Send a multipart (plain + HTML) message. `to` is a bare address.
    pub async fn send(&self, to: &str, subject: &str, text: &str, html: &str) -> Result<(), String> {
        let to: Mailbox = to.parse().map_err(|e| format!("invalid recipient: {e}"))?;
        let message = Message::builder()
            .from(self.from.clone())
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

        self.transport
            .send(message)
            .await
            .map_err(|e| format!("send: {e}"))?;
        Ok(())
    }
}
