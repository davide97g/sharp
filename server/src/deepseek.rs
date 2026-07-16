use crate::config::DeepSeekConfig;
use crate::gif::GifResult;
use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

const QUERY_SYSTEM_PROMPT: &str = "\
You write GIF search queries for a mean group-chat roast bot.

Given structured chat context, output ONE short English GIF search query (2-4 words).

Rules:
- Prefer classic, well-indexed reaction/meme phrases (facepalm, this is fine, absolute garbage, cringe, mic drop, dumpster fire, laughing, yikes, eye roll).
- Ground the query in the punchline's topic when there is a named product, person, or claim (e.g. gemini ai fail, google ai trash) — still reaction-style, not a news headline.
- Avoid internet slang that maps to random meme stock (ratio, W, L, based, sigma, goated, NPC).
- Be petty and dunking, but searchable. No slurs, no NSFW, no hate targeting protected classes.
- Output ONLY the query — no quotes, no punctuation, no explanation.";

const PICK_SYSTEM_PROMPT: &str = "\
You pick the best roast GIF for a group chat.

Given the chat context and candidate GIFs (id + title), choose the single GIF whose title/vibe best matches the punchline roast.
Prefer classic reaction GIFs tied to the topic. Avoid watermarked, spammy, empty-titled, or unrelated random memes.
Output ONLY the GIF id — nothing else.";

const QUERY_TEMPERATURE: f32 = 0.7;
const PICK_TEMPERATURE: f32 = 0.3;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u16,
    temperature: f32,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ResponseMessage,
}

#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

/// Package recent messages so the model focuses on who/what to roast.
pub fn format_roast_context(transcript: &[(String, String)]) -> String {
    let chat = transcript
        .iter()
        .map(|(display_name, content)| format!("{display_name}: {content}"))
        .collect::<Vec<_>>()
        .join("\n");

    let punchline_start = transcript.len().saturating_sub(3);
    let punchline = transcript[punchline_start..]
        .iter()
        .map(|(display_name, content)| format!("{display_name}: {content}"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut speakers: Vec<&str> = Vec::new();
    for (display_name, _) in transcript[punchline_start..].iter() {
        if !speakers.iter().any(|name| *name == display_name.as_str()) {
            speakers.push(display_name.as_str());
        }
    }

    format!(
        "Recent chat:\n{chat}\n\nPunchline (latest):\n{punchline}\n\nLatest speakers: {speakers}",
        speakers = speakers.join(", ")
    )
}

pub async fn suggest_query(
    config: &DeepSeekConfig,
    transcript: &[(String, String)],
) -> anyhow::Result<String> {
    let context = format_roast_context(transcript);
    let raw = chat_completion(
        config,
        QUERY_SYSTEM_PROMPT,
        &format!("{context}\n\nWrite one GIF search query that roasts this punchline."),
        24,
        QUERY_TEMPERATURE,
    )
    .await?;
    let query = sanitize_query(&raw);
    if query.is_empty() {
        bail!("deepseek returned an empty query");
    }
    Ok(query)
}

/// Ask the model to pick the best candidate id; returns `None` if the reply isn't a known id.
pub async fn pick_gif(
    config: &DeepSeekConfig,
    transcript: &[(String, String)],
    query: &str,
    candidates: &[GifResult],
) -> anyhow::Result<Option<String>> {
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() == 1 {
        return Ok(Some(candidates[0].id.clone()));
    }

    let context = format_roast_context(transcript);
    let list = candidates
        .iter()
        .map(|gif| {
            let title = if gif.title.trim().is_empty() {
                "(no title)"
            } else {
                gif.title.trim()
            };
            format!("- id={} title={}", gif.id, title)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "{context}\n\nSearch query used: {query}\n\nCandidates:\n{list}\n\nPick the best GIF id."
    );
    let raw = chat_completion(config, PICK_SYSTEM_PROMPT, &user, 48, PICK_TEMPERATURE).await?;
    let cleaned = sanitize_pick(&raw);
    if candidates.iter().any(|gif| gif.id == cleaned) {
        return Ok(Some(cleaned));
    }
    // Model sometimes echoes `id=…` or wraps the id — dig for a known id substring.
    for gif in candidates {
        if cleaned.contains(&gif.id) || raw.contains(&gif.id) {
            return Ok(Some(gif.id.clone()));
        }
    }
    Ok(None)
}

async fn chat_completion(
    config: &DeepSeekConfig,
    system: &str,
    user: &str,
    max_tokens: u16,
    temperature: f32,
) -> anyhow::Result<String> {
    let body = ChatRequest {
        model: config.model.clone(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: system.to_string(),
            },
            ChatMessage {
                role: "user",
                content: user.to_string(),
            },
        ],
        max_tokens,
        temperature,
    };
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let response = tokio::time::timeout(Duration::from_secs(10), async {
        client()
            .post(url)
            .bearer_auth(&config.api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<ChatResponse>()
            .await
    })
    .await
    .map_err(|_| anyhow!("deepseek request timed out"))??;

    response
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| anyhow!("deepseek returned no choices"))
}

fn sanitize_query(raw: &str) -> String {
    // Keep first line only — models sometimes append an explanation.
    let first_line = raw.lines().next().unwrap_or("").trim();
    let without_trailing_punctuation = first_line
        .trim_end_matches(|character: char| {
            is_trailing_punctuation(character) && !matches!(character, '"' | '\'' | '”' | '’')
        })
        .trim();
    let unquoted = strip_surrounding_quotes(without_trailing_punctuation);
    let clean = unquoted.trim_end_matches(is_trailing_punctuation).trim();
    clean.chars().take(64).collect()
}

fn sanitize_pick(raw: &str) -> String {
    let first_line = raw.lines().next().unwrap_or("").trim();
    let unquoted = strip_surrounding_quotes(first_line.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '`' | '"' | '\'' | '“' | '”' | '‘' | '’')
    }));
    unquoted
        .trim()
        .trim_start_matches("id=")
        .trim_start_matches("ID=")
        .trim()
        .chars()
        .take(128)
        .collect()
}

fn is_trailing_punctuation(character: char) -> bool {
    character.is_ascii_punctuation()
        || matches!(character, '…' | '。' | '！' | '？' | '，' | '；' | '：')
}

fn strip_surrounding_quotes(value: &str) -> &str {
    let pairs = [('"', '"'), ('\'', '\''), ('“', '”'), ('‘', '’')];
    for (open, close) in pairs {
        if let Some(inner) = value
            .strip_prefix(open)
            .and_then(|value| value.strip_suffix(close))
        {
            return inner.trim();
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{format_roast_context, sanitize_pick, sanitize_query};

    #[test]
    fn formats_punchline_focus() {
        let transcript = vec![
            ("alice".into(), "hello".into()),
            ("bob".into(), "gemini sucks".into()),
            ("alice".into(), "schifo".into()),
        ];
        let ctx = format_roast_context(&transcript);
        assert!(ctx.contains("Recent chat:"));
        assert!(ctx.contains("Punchline (latest):"));
        assert!(ctx.contains("bob: gemini sucks"));
        assert!(ctx.contains("Latest speakers: alice, bob"));
    }

    #[test]
    fn cleans_query_and_pick() {
        assert_eq!(sanitize_query("\"dumpster fire\"\nextra"), "dumpster fire");
        assert_eq!(sanitize_pick("id=abc123"), "abc123");
        assert_eq!(sanitize_pick("`xyz`"), "xyz");
    }
}
