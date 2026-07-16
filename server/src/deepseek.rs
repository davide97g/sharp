use crate::config::DeepSeekConfig;
use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

const SYSTEM_PROMPT: &str = "You are a vicious, disrespectful chat goblin who lives to clown on people. Given recent group-chat messages, output ONE short GIF search query (2-5 words, English) that maximally roasts, dunks on, or humiliates whoever looks dumbest in the convo. Be petty, mean, and unhinged — no mercy, no polite takes. Still: no slurs, no NSFW, no hate targeting protected classes. Output ONLY the query — no quotes, no punctuation, no explanation.";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u8,
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

pub async fn suggest_query(
    config: &DeepSeekConfig,
    transcript: &[(String, String)],
) -> anyhow::Result<String> {
    let transcript = transcript
        .iter()
        .map(|(display_name, content)| format!("{display_name}: {content}"))
        .collect::<Vec<_>>()
        .join("\n");
    let body = ChatRequest {
        model: config.model.clone(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user",
                content: transcript,
            },
        ],
        max_tokens: 20,
        temperature: 1.1,
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

    let raw = response
        .choices
        .first()
        .map(|choice| choice.message.content.trim())
        .ok_or_else(|| anyhow!("deepseek returned no choices"))?;
    let without_trailing_punctuation = raw
        .trim_end_matches(|character: char| {
            is_trailing_punctuation(character) && !matches!(character, '"' | '\'' | '”' | '’')
        })
        .trim();
    let unquoted = strip_surrounding_quotes(without_trailing_punctuation);
    let clean = unquoted.trim_end_matches(is_trailing_punctuation).trim();
    let query: String = clean.chars().take(64).collect();
    if query.is_empty() {
        bail!("deepseek returned an empty query");
    }
    Ok(query)
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
