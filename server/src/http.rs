//! The process-wide outbound HTTP client.
//!
//! One `reqwest::Client` means one connection pool, one TLS session cache and one DNS
//! cache shared by every outbound integration — AI/embeddings, DeepSeek, GIF providers,
//! Google OAuth + Calendar, APNs, Expo, Resend. Eight modules used to hold their own
//! private `OnceLock` client, so eight pools were kept warm to do one job.
//!
//! Guardrail: never build a `reqwest::Client` anywhere else. Anything request-shaped —
//! timeouts, headers, auth, multipart — belongs on the `RequestBuilder` this hands you,
//! not on a second client.
//!
//! No global timeout is configured, deliberately: the Sharpy chat client streams SSE for
//! as long as the model talks, and a client-level timeout covers the whole response body,
//! so it would cut long answers off mid-sentence. **A non-streaming caller should set its
//! own `.timeout(..)` on the request** (see `ai::transcribe` for the pattern).
//!
//! HTTP/2 — which APNs requires — is negotiated per host via ALPN, so nothing extra is
//! needed here for it.

use std::sync::OnceLock;

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// The one deliberate exception to "one client": a second pool that never
/// follows redirects.
///
/// Link unfurling fetches URLs users typed, so every hop's host has to be
/// re-resolved and re-checked against the SSRF rules before it is requested —
/// otherwise a public page could redirect the server at `169.254.169.254`.
/// Redirect policy is fixed at client-build time in reqwest, so following hops
/// by hand requires its own client. Nothing else should use this.
pub fn no_redirect_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}
