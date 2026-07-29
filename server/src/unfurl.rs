//! Link previews: turning the URLs in a message into Discord-style cards.
//!
//! Contract: docs/arch/01-core.md — "Link previews".
//!
//! Shape of the feature: posting is never blocked on a third-party site. The
//! message is stored and broadcast first; a spawned task then unfurls up to
//! [`MAX_PER_MESSAGE`] links and emits a follow-up `message.previews` event. A
//! slow or dead host therefore costs a card, never a message.
//!
//! **Every fetch here is a URL a user typed, so the whole module is written
//! against SSRF.** The rules, all enforced below and none of them optional
//! unless `UNFURL_ALLOW_PRIVATE=true` says this deployment wants intranet
//! unfurls:
//!
//!   - `http`/`https` only, absolute, at most [`MAX_URL_LEN`] chars.
//!   - Every hop's host is resolved and every resolved address must be publicly
//!     routable — loopback, RFC1918, link-local (including the cloud metadata
//!     endpoint at 169.254.169.254), CGNAT, ULA and friends are all refused.
//!   - Redirects are followed *manually* (up to [`MAX_REDIRECTS`]) so each hop
//!     goes through that same check. This is the reason the module uses
//!     `http::no_redirect_client()` rather than the default pooled client.
//!   - The response body is read through a [`MAX_BODY`] cap, so a multi-gigabyte
//!     "HTML page" cannot be used to exhaust memory.
//!
//! Playable frames are an allowlist ([`embed_for`]), never a page's own
//! `og:video`: an arbitrary site must not be able to get an iframe into the app.
//! Preview images are likewise never hot-linked by the client — they are fetched
//! through `routes/unfurl.rs` so a linked site never sees a reader's IP.

use crate::error::AppResult;
use crate::http;
use crate::models::LinkPreview;
use crate::state::SharedState;
use crate::ws::{channel_member_ids, envelope};
use futures_util::StreamExt;
use reqwest::Url;
use serde_json::json;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Cards per message. Discord shows five; three keeps a link dump from turning
/// one message into a page of images.
pub const MAX_PER_MESSAGE: usize = 3;
const MAX_URL_LEN: usize = 2048;
/// Hard read cap for a page body. The fetch normally stops much earlier, at
/// `</head>`; this is only the backstop for a page that never closes it.
const MAX_BODY: usize = 2 * 1024 * 1024;
const HEAD_END: &[u8] = b"</head>";

/// `slice.windows().position()` without the iterator ceremony.
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 4;
/// How long a good preview stays fresh, and how long a failure is remembered.
/// The short error TTL is what keeps a transient 502 from pinning a link to
/// "couldn't load" for a week.
const OK_TTL_HOURS: i64 = 24 * 7;
const ERROR_TTL_HOURS: i64 = 1;
/// Sent on every unfurl so site owners can identify (and block) us.
const USER_AGENT: &str = "SharpBot/1.0 (+link preview; self-hosted sharp)";

/// Ceiling on unfurls in flight per replica. Without it a single paste-heavy
/// channel could open hundreds of outbound sockets at once.
fn permits() -> &'static Semaphore {
    static PERMITS: std::sync::OnceLock<Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| Semaphore::new(8))
}

// ── URL extraction ───────────────────────────────────────────────────────────────────

/// Characters that commonly trail a URL in prose and are never part of it.
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', '"', '\'', '»', '”', '’'];

/// Pull the linkable URLs out of message text, in order, deduplicated.
///
/// Deliberately blind to: fenced and inline code (a URL in a snippet is being
/// discussed, not shared), markdown link/image targets — which includes sharp's
/// own GIF chips — and `<https://…>`, the Discord-compatible way to say "post
/// this link but no card".
pub fn extract_urls(content: &str) -> Vec<String> {
    let text = strip_code(content);
    let bytes: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();

    let mut i = 0;
    while i < bytes.len() {
        if !starts_scheme(&bytes, i) {
            i += 1;
            continue;
        }
        // A URL reached via `](` is a markdown target; the visible text is what
        // the reader chose to show, so unfurling it would contradict them.
        let suppressed = i >= 2 && bytes[i - 1] == '(' && bytes[i - 2] == ']'
            || (i >= 1 && bytes[i - 1] == '<');
        let mut end = i;
        while end < bytes.len() && !bytes[end].is_whitespace() && !matches!(bytes[end], '<' | '>' | '"' | '`' | '|') {
            end += 1;
        }
        let mut raw: String = bytes[i..end].iter().collect();
        raw = trim_url_tail(&raw).to_string();
        if !suppressed && !raw.is_empty() && !out.contains(&raw) {
            out.push(raw);
        }
        i = end.max(i + 1);
    }
    out
}

fn starts_scheme(chars: &[char], i: usize) -> bool {
    let rest: String = chars[i..chars.len().min(i + 8)].iter().collect();
    let lower = rest.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Drop sentence punctuation and any closing bracket that was never opened
/// inside the URL — `(see https://example.com/a)` links to `/a`, while
/// `https://en.wikipedia.org/wiki/Rust_(language)` keeps its parenthesis.
fn trim_url_tail(raw: &str) -> &str {
    let mut end = raw.len();
    loop {
        let slice = &raw[..end];
        let Some(last) = slice.chars().last() else { break };
        let trimmed = match last {
            c if TRAILING.contains(&c) => true,
            ')' => slice.matches('(').count() < slice.matches(')').count(),
            ']' => slice.matches('[').count() < slice.matches(']').count(),
            '}' => slice.matches('{').count() < slice.matches('}').count(),
            _ => false,
        };
        if !trimmed {
            break;
        }
        end -= last.len_utf8();
    }
    &raw[..end]
}

/// Blank out fenced blocks and inline code spans, preserving length is not
/// needed — only the surviving text is scanned.
fn strip_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    // Fenced blocks first, so a stray backtick inside one cannot desync the
    // inline-span pass below.
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 3..];
        match rest.find("```") {
            Some(end) => rest = &rest[end + 3..],
            None => return strip_inline_code(&out),
        }
    }
    out.push_str(rest);
    strip_inline_code(&out)
}

fn strip_inline_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..start]);
        rest = &rest[start + 1..];
        match rest.find('`') {
            Some(end) => rest = &rest[end + 1..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Canonical cache key for a URL: `http(s)` only, host lowercased by the parser,
/// fragment dropped (it never changes what a server returns).
pub fn normalize(raw: &str) -> Option<String> {
    if raw.len() > MAX_URL_LEN {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str()?;
    url.set_fragment(None);
    let out = url.to_string();
    (out.len() <= MAX_URL_LEN).then_some(out)
}

/// True when the URL points back at this deployment. Doc, task and call links
/// already render as their own chips, so a card would be a duplicate.
fn is_self_link(url: &Url, app_url: Option<&str>) -> bool {
    let Some(app) = app_url.and_then(|u| Url::parse(u).ok()) else {
        return false;
    };
    url.host_str().is_some() && url.host_str() == app.host_str()
}

// ── SSRF guards ──────────────────────────────────────────────────────────────────────

/// Publicly routable? `IpAddr::is_global` is still unstable, so the rules are
/// spelled out here. Anything not clearly public is refused.
fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // 100.64.0.0/10 CGNAT
                || (a == 100 && (64..128).contains(&b))
                // 198.18.0.0/15 benchmarking
                || (a == 198 && (18..20).contains(&b))
                // 240.0.0.0/4 reserved
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(mapped));
            }
            let seg = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                // fc00::/7 unique local
                || (seg[0] & 0xfe00) == 0xfc00
                // fe80::/10 link local
                || (seg[0] & 0xffc0) == 0xfe80
                // 2001:db8::/32 documentation
                || (seg[0] == 0x2001 && seg[1] == 0x0db8))
        }
    }
}

/// Resolve the URL's host and refuse it unless every address it answers with is
/// public. Checking *all* of them (not just the first) is what stops a host that
/// returns one public and one loopback address from slipping through.
async fn guard_host(url: &Url, allow_private: bool) -> Result<(), String> {
    if allow_private {
        return Ok(());
    }
    let host = url.host_str().ok_or_else(|| "no host".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip_is_public(ip)
            .then_some(())
            .ok_or_else(|| format!("blocked address {ip}"));
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("dns: {e}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("dns: no addresses".to_string());
    }
    for addr in addrs {
        if !ip_is_public(addr.ip()) {
            return Err(format!("blocked address {}", addr.ip()));
        }
    }
    Ok(())
}

/// A fetched response, body already capped.
pub struct Fetched {
    pub final_url: Url,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// GET with manual redirect following, a per-hop host guard, and a body cap.
///
/// `max_body` is a parameter because the image proxy allows much more than a
/// page body: it is streaming a JPEG, not looking for `<meta>` tags.
pub async fn fetch_guarded(
    start: &Url,
    allow_private: bool,
    max_body: usize,
    accept: &str,
) -> Result<Fetched, String> {
    let mut url = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        guard_host(&url, allow_private).await?;
        let res = http::no_redirect_client()
            .get(url.clone())
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::ACCEPT, accept)
            .header(reqwest::header::ACCEPT_LANGUAGE, "en;q=0.9,*;q=0.5")
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("request: {e}"))?;

        if res.status().is_redirection() {
            let location = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect without location".to_string())?;
            url = url
                .join(location)
                .map_err(|e| format!("bad redirect target: {e}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("redirect left http(s)".to_string());
            }
            continue;
        }
        if !res.status().is_success() {
            return Err(format!("status {}", res.status().as_u16()));
        }

        let content_type = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let final_url = res.url().clone();

        // Read to the cap, but stop at `</head>` on an HTML page: the metadata is
        // all in the head, and pages that inline their app there (YouTube's is
        // ~700 KB) would otherwise need a cap big enough to swallow the whole
        // document before the `<meta>` tags show up.
        let html = content_type.starts_with("text/html")
            || content_type.starts_with("application/xhtml");
        let mut body: Vec<u8> = Vec::new();
        let mut searched = 0usize;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("body: {e}"))?;
            let room = max_body.saturating_sub(body.len());
            if room == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if html {
                // Overlap by the tag length so a `</head>` split across two
                // chunks is still found.
                let from = searched.saturating_sub(HEAD_END.len());
                if find_bytes(&body[from..], HEAD_END).is_some() {
                    break;
                }
                searched = body.len();
            }
        }
        return Ok(Fetched {
            final_url,
            content_type,
            body,
        });
    }
    Err("too many redirects".to_string())
}

// ── Video embeds (allowlist) ─────────────────────────────────────────────────────────

fn valid_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 24
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Player URL + fallback thumbnail for the hosts we are willing to frame.
///
/// Allowlisted on purpose: the frame runs third-party code inside the app, so it
/// must never be derived from a page's own metadata. Both entries are the
/// privacy-preserving variants (`youtube-nocookie`, `dnt=1`).
pub fn embed_for(url: &Url) -> Option<(String, Option<String>)> {
    let host = url.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    let youtube_id = match host.as_str() {
        "youtu.be" => segments.first().map(|s| s.to_string()),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            match segments.first().copied() {
                Some("watch") => url
                    .query_pairs()
                    .find(|(k, _)| k == "v")
                    .map(|(_, v)| v.to_string()),
                Some("live") | Some("shorts") | Some("embed") | Some("v") => {
                    segments.get(1).map(|s| s.to_string())
                }
                _ => None,
            }
        }
        _ => None,
    };
    if let Some(id) = youtube_id.filter(|id| valid_video_id(id)) {
        return Some((
            format!("https://www.youtube-nocookie.com/embed/{id}"),
            Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
        ));
    }

    if host == "vimeo.com" || host == "player.vimeo.com" {
        if let Some(id) = segments
            .iter()
            .find(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty())
        {
            return Some((format!("https://player.vimeo.com/video/{id}?dnt=1"), None));
        }
    }
    None
}

// ── HTML metadata ────────────────────────────────────────────────────────────────────

fn truncate(value: &str, max: usize) -> String {
    let clean: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > max {
        clean.chars().take(max).collect::<String>() + "…"
    } else {
        clean
    }
}

fn clean_opt(value: Option<String>, max: usize) -> Option<String> {
    value
        .map(|v| truncate(&v, max))
        .filter(|v| !v.trim().is_empty())
}

/// `#rgb` / `#rrggbb` only — the value ends up in an inline style.
fn valid_color(value: &str) -> bool {
    let v = value.trim();
    v.starts_with('#')
        && (v.len() == 4 || v.len() == 7)
        && v[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Read `<meta>`/`<title>`/`<link rel=icon>` into a preview. Pure so it can be
/// unit-tested without a network.
pub fn parse_html(html: &str, final_url: &Url) -> LinkPreview {
    use scraper::{Html, Selector};

    let doc = Html::parse_document(html);
    let meta_sel = Selector::parse("meta").expect("static selector");
    let title_sel = Selector::parse("title").expect("static selector");
    let icon_sel = Selector::parse(r#"link[rel~="icon" i], link[rel="shortcut icon" i]"#)
        .expect("static selector");

    // First value wins: pages that repeat a property mean the head one.
    let mut meta: HashMap<String, String> = HashMap::new();
    for el in doc.select(&meta_sel) {
        let key = el
            .value()
            .attr("property")
            .or_else(|| el.value().attr("name"))
            .or_else(|| el.value().attr("itemprop"))
            .map(|k| k.trim().to_ascii_lowercase());
        let (Some(key), Some(content)) = (key, el.value().attr("content")) else {
            continue;
        };
        meta.entry(key).or_insert_with(|| content.to_string());
    }
    let pick = |keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| meta.get(*k).cloned())
            .filter(|v| !v.trim().is_empty())
    };

    let doc_title = doc
        .select(&title_sel)
        .next()
        .map(|el| el.text().collect::<String>());

    let image_raw = pick(&[
        "og:image:secure_url",
        "og:image:url",
        "og:image",
        "twitter:image",
        "twitter:image:src",
    ]);
    let image_url = image_raw.and_then(|src| final_url.join(src.trim()).ok());
    let image_url = image_url.filter(|u| matches!(u.scheme(), "http" | "https"));

    let favicon = doc
        .select(&icon_sel)
        .find_map(|el| el.value().attr("href"))
        .and_then(|href| final_url.join(href.trim()).ok())
        .or_else(|| final_url.join("/favicon.ico").ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"));

    let (embed_url, fallback_thumb) = match embed_for(final_url) {
        Some((embed, thumb)) => (Some(embed), thumb),
        None => (None, None),
    };
    let kind = if embed_url.is_some() {
        "video"
    } else if pick(&["og:type"]).as_deref() == Some("image") {
        "photo"
    } else {
        "link"
    };

    LinkPreview {
        url: final_url.to_string(),
        kind: kind.to_string(),
        title: clean_opt(pick(&["og:title", "twitter:title"]).or(doc_title), 300),
        description: clean_opt(
            pick(&["og:description", "twitter:description", "description"]),
            600,
        ),
        site_name: clean_opt(
            pick(&["og:site_name", "application-name"])
                .or_else(|| final_url.host_str().map(|h| h.trim_start_matches("www.").to_string())),
            100,
        ),
        author: clean_opt(pick(&["author", "twitter:creator", "article:author"]), 100),
        image_url: image_url.map(|u| u.to_string()).or(fallback_thumb),
        image_width: pick(&["og:image:width"]).and_then(|v| v.trim().parse().ok()),
        image_height: pick(&["og:image:height"]).and_then(|v| v.trim().parse().ok()),
        favicon_url: favicon.map(|u| u.to_string()),
        embed_url,
        color: pick(&["theme-color"]).filter(|c| valid_color(c)),
    }
}

// ── Fetch + cache ────────────────────────────────────────────────────────────────────

fn row_to_preview(row: &sqlx::postgres::PgRow) -> AppResult<LinkPreview> {
    Ok(LinkPreview {
        url: row.try_get("url")?,
        kind: row.try_get("kind")?,
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        site_name: row.try_get("site_name")?,
        author: row.try_get("author")?,
        image_url: row.try_get("image_url")?,
        image_width: row.try_get("image_width")?,
        image_height: row.try_get("image_height")?,
        favicon_url: row.try_get("favicon_url")?,
        embed_url: row.try_get("embed_url")?,
        color: row.try_get("color")?,
    })
}

/// Cached row for `url`, if one is still fresh for its kind.
async fn cached(pool: &PgPool, url: &str) -> AppResult<Option<LinkPreview>> {
    let row = sqlx::query(
        "SELECT * FROM link_previews
         WHERE url = $1
           AND fetched_at > now() - make_interval(hours => CASE WHEN kind = 'error' THEN $2 ELSE $3 END)",
    )
    .bind(url)
    .bind(ERROR_TTL_HOURS as i32)
    .bind(OK_TTL_HOURS as i32)
    .fetch_optional(pool)
    .await?;
    row.as_ref().map(row_to_preview).transpose()
}

async fn store(pool: &PgPool, url: &str, preview: &LinkPreview) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO link_previews
             (url, kind, title, description, site_name, author, image_url, image_width,
              image_height, favicon_url, embed_url, color, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (url) DO UPDATE SET
             kind = EXCLUDED.kind, title = EXCLUDED.title, description = EXCLUDED.description,
             site_name = EXCLUDED.site_name, author = EXCLUDED.author,
             image_url = EXCLUDED.image_url, image_width = EXCLUDED.image_width,
             image_height = EXCLUDED.image_height, favicon_url = EXCLUDED.favicon_url,
             embed_url = EXCLUDED.embed_url, color = EXCLUDED.color, fetched_at = now()",
    )
    .bind(url)
    .bind(&preview.kind)
    .bind(&preview.title)
    .bind(&preview.description)
    .bind(&preview.site_name)
    .bind(&preview.author)
    .bind(&preview.image_url)
    .bind(preview.image_width)
    .bind(preview.image_height)
    .bind(&preview.favicon_url)
    .bind(&preview.embed_url)
    .bind(&preview.color)
    .execute(pool)
    .await?;
    Ok(())
}

/// An otherwise-empty preview. `kind = "error"` is the cached failure; the other
/// kinds are filled in by the caller.
fn blank_preview(url: &str, kind: &str) -> LinkPreview {
    LinkPreview {
        url: url.to_string(),
        kind: kind.to_string(),
        title: None,
        description: None,
        site_name: None,
        author: None,
        image_url: None,
        image_width: None,
        image_height: None,
        favicon_url: None,
        embed_url: None,
        color: None,
    }
}

fn error_preview(url: &str) -> LinkPreview {
    blank_preview(url, "error")
}

/// Fetch (or reuse) the preview for one already-normalized URL.
async fn resolve(state: &SharedState, url: &str) -> AppResult<LinkPreview> {
    if let Some(hit) = cached(&state.pool, url).await? {
        return Ok(hit);
    }
    let allow_private = state.config.unfurl.allow_private;
    let parsed = match Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(error_preview(url)),
    };

    let _permit = permits().acquire().await;
    let preview = match fetch_guarded(
        &parsed,
        allow_private,
        MAX_BODY,
        "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
    )
    .await
    {
        // A link straight to an image is its own card: the image is the preview.
        Ok(fetched) if fetched.content_type.starts_with("image/") => LinkPreview {
            image_url: Some(fetched.final_url.to_string()),
            site_name: fetched
                .final_url
                .host_str()
                .map(|h| h.trim_start_matches("www.").to_string()),
            ..blank_preview(fetched.final_url.as_str(), "photo")
        },
        Ok(fetched) => {
            let html = String::from_utf8_lossy(&fetched.body);
            parse_html(&html, &fetched.final_url)
        }
        Err(reason) => {
            tracing::debug!(url, reason, "unfurl failed");
            error_preview(url)
        }
    };

    // Store under the *requested* URL: that is the cache key the message rows
    // point at, whatever the site redirected us to.
    store(&state.pool, url, &preview).await?;
    let mut preview = preview;
    preview.url = url.to_string();
    Ok(preview)
}

// ── Message wiring ───────────────────────────────────────────────────────────────────

/// Previews for a set of messages, ready to hang off the serialized `Message`.
/// Error rows and messages whose author hid the cards are simply absent.
pub async fn load_previews_map(
    pool: &PgPool,
    ids: &[i64],
) -> AppResult<HashMap<i64, Vec<LinkPreview>>> {
    let mut map: HashMap<i64, Vec<LinkPreview>> = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT mlp.message_id, lp.*
         FROM message_link_previews mlp
         JOIN link_previews lp ON lp.url = mlp.url
         JOIN messages m ON m.id = mlp.message_id
         WHERE mlp.message_id = ANY($1) AND lp.kind <> 'error'
           AND NOT m.previews_hidden AND m.deleted_at IS NULL
         ORDER BY mlp.message_id, mlp.position",
    )
    .bind(ids.to_vec())
    .fetch_all(pool)
    .await?;
    for row in &rows {
        let message_id: i64 = row.try_get("message_id")?;
        map.entry(message_id).or_default().push(row_to_preview(row)?);
    }
    Ok(map)
}

/// Unfurl a message's links and broadcast the result. Spawned, never awaited by
/// the posting request: a card is worth waiting for, a `POST /messages` is not.
pub async fn unfurl_message(state: &SharedState, message_id: i64, channel_id: Uuid, content: &str) {
    if let Err(e) = unfurl_inner(state, message_id, channel_id, content).await {
        tracing::warn!(message_id, error = %e, "unfurl_message failed");
    }
}

async fn unfurl_inner(
    state: &SharedState,
    message_id: i64,
    channel_id: Uuid,
    content: &str,
) -> AppResult<()> {
    let app_url = state.config.app_url.clone();
    let urls: Vec<String> = extract_urls(content)
        .iter()
        .filter_map(|raw| normalize(raw))
        .filter(|url| {
            Url::parse(url)
                .map(|parsed| !is_self_link(&parsed, app_url.as_deref()))
                .unwrap_or(false)
        })
        .take(MAX_PER_MESSAGE)
        .collect();

    // An edit that removed the last link must remove the cards with it — and
    // tell everyone, or the clients keep rendering what the message no longer says.
    let removed = sqlx::query("DELETE FROM message_link_previews WHERE message_id = $1")
        .bind(message_id)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if urls.is_empty() {
        if removed > 0 {
            broadcast_previews(state, message_id, channel_id, &[]).await?;
        }
        return Ok(());
    }

    let mut previews = Vec::new();
    for (position, url) in urls.iter().enumerate() {
        let preview = resolve(state, url).await?;
        sqlx::query(
            "INSERT INTO message_link_previews (message_id, position, url)
             VALUES ($1, $2, $3)
             ON CONFLICT (message_id, position) DO UPDATE SET url = EXCLUDED.url",
        )
        .bind(message_id)
        .bind(position as i32)
        .bind(url)
        .execute(&state.pool)
        .await?;
        if preview.kind != "error" {
            previews.push(preview);
        }
    }
    if previews.is_empty() {
        return Ok(());
    }

    // The author may have hit ✕ while we were fetching; respect that.
    let hidden: bool = sqlx::query("SELECT previews_hidden FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_optional(&state.pool)
        .await?
        .map(|row| row.try_get("previews_hidden"))
        .transpose()?
        .unwrap_or(true);
    if hidden {
        return Ok(());
    }

    broadcast_previews(state, message_id, channel_id, &previews).await
}

/// Tell every channel member what a message's cards are now (an empty list
/// means "drop them", which is what the author's ✕ sends).
pub async fn broadcast_previews(
    state: &SharedState,
    message_id: i64,
    channel_id: Uuid,
    previews: &[LinkPreview],
) -> AppResult<()> {
    let targets = channel_member_ids(&state.pool, channel_id).await?;
    let event = envelope(
        "message.previews",
        json!({
            "message_id": message_id.to_string(),
            "channel_id": channel_id.to_string(),
            "link_previews": previews,
        }),
    );
    state.hub.broadcast(event, targets).await;
    Ok(())
}

/// Fire-and-forget unfurl of a **new** message. Text without `http` in it cannot
/// produce a card and has no rows to clean up, so it never reaches the worker.
pub fn spawn_unfurl(state: &SharedState, message_id: i64, channel_id: Uuid, content: String) {
    if !content.contains("http") {
        return;
    }
    spawn_reunfurl(state, message_id, channel_id, content);
}

/// Fire-and-forget unfurl of an **edited** message. Runs even when the new text
/// has no links at all — that is exactly the case where the existing cards have
/// to be deleted and the empty list broadcast.
pub fn spawn_reunfurl(state: &SharedState, message_id: i64, channel_id: Uuid, content: String) {
    if !state.config.unfurl.enabled {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        unfurl_message(&state, message_id, channel_id, &content).await;
    });
}

// ── On-demand resolve (encrypted DMs) ────────────────────────────────────────────────
//
// An E2EE DM is ciphertext on the server, so the unfurl above can never run for
// one. The client decrypts, finds the URLs itself, and asks for each one here.
// Nothing about the message is sent — only the URL — and nothing is persisted
// against the message, so the cards are per-viewer and vanish with the session.

const RESOLVE_WINDOW: Duration = Duration::from_secs(60);
const RESOLVE_LIMIT: usize = 20;

/// Per-user sliding window over `POST /unfurl/resolve`. In-process (per replica),
/// like the GIPHY counter: this exists to stop one client from turning the server
/// into a crawler, not to be an exact global quota.
fn resolve_calls() -> &'static std::sync::Mutex<HashMap<Uuid, std::collections::VecDeque<std::time::Instant>>>
{
    static CALLS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<Uuid, std::collections::VecDeque<std::time::Instant>>>,
    > = std::sync::OnceLock::new();
    CALLS.get_or_init(Default::default)
}

/// Reserve one resolve slot for `user`. False when they are over the limit.
pub fn allow_resolve(user: Uuid) -> bool {
    let now = std::time::Instant::now();
    let mut map = match resolve_calls().lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    // Drop users whose window has fully aged out, so the map cannot grow forever.
    map.retain(|_, calls| {
        calls.back().is_some_and(|last| now.duration_since(*last) < RESOLVE_WINDOW)
    });
    let calls = map.entry(user).or_default();
    while calls
        .front()
        .is_some_and(|at| now.duration_since(*at) >= RESOLVE_WINDOW)
    {
        calls.pop_front();
    }
    if calls.len() >= RESOLVE_LIMIT {
        return false;
    }
    calls.push_back(now);
    true
}

/// Resolve one URL for a client that holds plaintext the server cannot read.
/// Shares the cache (and therefore the TTLs) with the message unfurler.
pub async fn resolve_one(state: &SharedState, raw: &str) -> AppResult<Option<LinkPreview>> {
    let Some(url) = normalize(raw) else {
        return Ok(None);
    };
    let preview = resolve(state, &url).await?;
    Ok((preview.kind != "error").then_some(preview))
}

/// True if this exact URL is already known as a preview asset — the whitelist the
/// image proxy checks so it can never be used as an open forward proxy.
pub async fn is_known_asset(pool: &PgPool, url: &str) -> AppResult<bool> {
    let row = sqlx::query(
        "SELECT 1 AS x FROM link_previews WHERE image_url = $1 OR favicon_url = $1 LIMIT 1",
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test url")
    }

    #[test]
    fn extracts_plain_urls_in_order() {
        let urls = extract_urls("see https://a.example/x and http://b.example/y please");
        assert_eq!(urls, vec!["https://a.example/x", "http://b.example/y"]);
    }

    #[test]
    fn trims_trailing_punctuation_but_keeps_balanced_parens() {
        assert_eq!(
            extract_urls("read https://example.com/a."),
            vec!["https://example.com/a"]
        );
        assert_eq!(
            extract_urls("(see https://example.com/a)"),
            vec!["https://example.com/a"]
        );
        assert_eq!(
            extract_urls("https://en.wikipedia.org/wiki/Rust_(language)"),
            vec!["https://en.wikipedia.org/wiki/Rust_(language)"]
        );
    }

    #[test]
    fn skips_code_markdown_targets_and_angle_suppression() {
        assert!(extract_urls("`https://example.com`").is_empty());
        assert!(extract_urls("```\nhttps://example.com\n```").is_empty());
        assert!(extract_urls("![gif](https://media.giphy.com/x.gif)").is_empty());
        assert!(extract_urls("<https://example.com>").is_empty());
    }

    #[test]
    fn dedupes_repeated_links() {
        assert_eq!(
            extract_urls("https://a.example https://a.example"),
            vec!["https://a.example"]
        );
    }

    #[test]
    fn normalize_drops_fragment_and_non_http() {
        assert_eq!(
            normalize("https://example.com/a#top").as_deref(),
            Some("https://example.com/a")
        );
        assert!(normalize("javascript:alert(1)").is_none());
        assert!(normalize("file:///etc/passwd").is_none());
    }

    #[test]
    fn private_and_metadata_addresses_are_blocked() {
        for blocked in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.5",
            "172.16.9.9",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !ip_is_public(blocked.parse().expect("ip")),
                "{blocked} must be blocked"
            );
        }
        for allowed in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(
                ip_is_public(allowed.parse().expect("ip")),
                "{allowed} must be allowed"
            );
        }
    }

    #[test]
    fn youtube_forms_all_resolve_to_one_embed() {
        for raw in [
            "https://www.youtube.com/watch?v=_dAk4Ww2RuY",
            "https://youtu.be/_dAk4Ww2RuY",
            "https://youtube.com/live/_dAk4Ww2RuY?feature=share",
            "https://www.youtube.com/shorts/_dAk4Ww2RuY",
        ] {
            let (embed, thumb) = embed_for(&url(raw)).expect(raw);
            assert_eq!(embed, "https://www.youtube-nocookie.com/embed/_dAk4Ww2RuY");
            assert!(thumb.expect("thumb").contains("_dAk4Ww2RuY"));
        }
        assert!(embed_for(&url("https://example.com/watch?v=abc")).is_none());
    }

    #[test]
    fn vimeo_embeds_with_do_not_track() {
        let (embed, _) = embed_for(&url("https://vimeo.com/123456789")).expect("vimeo");
        assert_eq!(embed, "https://player.vimeo.com/video/123456789?dnt=1");
    }

    #[test]
    fn parses_open_graph_over_html_title() {
        // `r##` because the theme-color value below contains `"#`.
        let html = r##"
            <html><head>
              <title>Fallback</title>
              <meta property="og:title" content="Real   Title">
              <meta property="og:description" content="A &amp; B">
              <meta property="og:image" content="/img/card.png">
              <meta property="og:site_name" content="Example">
              <meta name="theme-color" content="#ff0055">
              <link rel="icon" href="/fav.png">
            </head><body></body></html>"##;
        let preview = parse_html(html, &url("https://example.com/post"));
        assert_eq!(preview.title.as_deref(), Some("Real Title"));
        assert_eq!(preview.description.as_deref(), Some("A & B"));
        assert_eq!(
            preview.image_url.as_deref(),
            Some("https://example.com/img/card.png")
        );
        assert_eq!(preview.favicon_url.as_deref(), Some("https://example.com/fav.png"));
        assert_eq!(preview.color.as_deref(), Some("#ff0055"));
        assert_eq!(preview.kind, "link");
    }

    #[test]
    fn falls_back_to_title_tag_and_host() {
        let preview = parse_html("<html><head><title>Bare</title></head></html>", &url("https://www.example.com/"));
        assert_eq!(preview.title.as_deref(), Some("Bare"));
        assert_eq!(preview.site_name.as_deref(), Some("example.com"));
        assert_eq!(preview.favicon_url.as_deref(), Some("https://www.example.com/favicon.ico"));
    }

    #[test]
    fn rejects_unsafe_theme_color() {
        let html = r#"<meta name="theme-color" content="url(javascript:alert(1))">"#;
        assert!(parse_html(html, &url("https://example.com/")).color.is_none());
    }

    #[test]
    fn video_pages_get_an_allowlisted_frame_only() {
        let html = r#"<meta property="og:video" content="https://evil.example/player">"#;
        let plain = parse_html(html, &url("https://evil.example/watch"));
        assert!(plain.embed_url.is_none());
        assert_eq!(plain.kind, "link");

        let yt = parse_html("<title>Live</title>", &url("https://youtube.com/live/_dAk4Ww2RuY"));
        assert_eq!(yt.kind, "video");
        assert_eq!(
            yt.embed_url.as_deref(),
            Some("https://www.youtube-nocookie.com/embed/_dAk4Ww2RuY")
        );
    }
}
