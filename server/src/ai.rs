//! The OpenAI-compatible provider client: chat (streaming and one-shot), embeddings,
//! and audio transcription.
//!
//! Contract: docs/arch/10-sharpy.md (embeddings + ask flow) and the transcription section
//! of docs/arch/04-voice.md.
//!
//! This module owns the **wire types** for `/chat/completions` — `ChatMessage`,
//! `ChatRequest`, `ChatResponse`. `deepseek.rs` speaks the same protocol against a
//! different endpoint and reuses them; it used to declare a parallel set that could drift.
//! Anything new that talks to an OpenAI-compatible provider belongs here too.
//!
//! Providers vary: some reject unknown or null parameters, so optional request fields are
//! omitted rather than sent as null. Chat-only providers (no embeddings endpoint) are
//! expected — a query-embed failure degrades Sharpy to a context-free answer instead of
//! erroring, see `routes/sharpy.rs`.

use crate::config::{AiConfig, TranscribeConfig};
use anyhow::{anyhow, bail};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

/// A single chat turn sent upstream (`role` is "system", "user", or "assistant").
#[derive(Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: content.into(),
        }
    }
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
}

#[derive(Deserialize)]
struct EmbedData {
    #[serde(default)]
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

/// Transcribe one encoded audio segment through an OpenAI-compatible
/// `/audio/transcriptions` endpoint.
pub async fn transcribe(
    cfg: &TranscribeConfig,
    bytes: Vec<u8>,
    mime: &str,
    filename: &str,
) -> anyhow::Result<String> {
    let file = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(mime)?;
    let form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("model", cfg.model.clone())
        .text("response_format", "json");
    let url = format!(
        "{}/audio/transcriptions",
        cfg.base_url.trim_end_matches('/')
    );
    let response = crate::http::client()
        .post(url)
        .bearer_auth(&cfg.api_key)
        .multipart(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?
        .json::<TranscriptionResponse>()
        .await?;
    Ok(response.text)
}

/// Embed a batch of inputs. Returns one vector per input, in input order.
pub async fn embed(cfg: &AiConfig, inputs: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/embeddings", cfg.base_url.trim_end_matches('/'));
    let body = EmbedRequest {
        model: &cfg.embed_model,
        input: inputs,
    };
    let mut resp = crate::http::client()
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json::<EmbedResponse>()
        .await?;

    if resp.data.len() != inputs.len() {
        bail!(
            "embeddings response returned {} vectors for {} inputs",
            resp.data.len(),
            inputs.len()
        );
    }
    // The API may return results out of order; `index` restores input order.
    resp.data.sort_by_key(|d| d.index);
    Ok(resp.data.into_iter().map(|d| d.embedding).collect())
}

/// `POST /chat/completions` body, shared by the streaming Sharpy path and the one-shot
/// DeepSeek calls in `deepseek.rs`.
///
/// `stream`, `max_tokens` and `temperature` are omitted from the JSON when unset so each
/// caller sends exactly the parameters it sent before this was shared — some providers
/// reject parameters they do not implement.
#[derive(Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "is_false")]
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ChatRequest {
    /// Streaming completion — the Sharpy ask flow, consumed as SSE by [`chat_stream`].
    pub fn streaming(model: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            stream: true,
            max_tokens: None,
            temperature: None,
        }
    }

    /// One-shot completion with a bounded reply, for the short structured answers
    /// (GIF query, GIF pick, meeting notes) that `deepseek.rs` asks for.
    pub fn once(
        model: impl Into<String>,
        messages: Vec<ChatMessage>,
        max_tokens: u16,
        temperature: f32,
    ) -> Self {
        Self {
            model: model.into(),
            messages,
            stream: false,
            max_tokens: Some(max_tokens),
            temperature: Some(temperature),
        }
    }
}

/// Non-streaming `/chat/completions` response. The streaming shape is `StreamChunk`.
#[derive(Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
pub struct ChatChoice {
    pub message: ChatResponseMessage,
}

#[derive(Deserialize)]
pub struct ChatResponseMessage {
    pub content: String,
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}

#[derive(Default, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

/// State threaded through the SSE-parsing `unfold`.
struct StreamState<S> {
    stream: S,
    /// Raw bytes not yet split into complete lines.
    buffer: String,
    /// `data:` payload lines accumulated for the current (not-yet-terminated) event.
    data_lines: Vec<String>,
    /// Decoded content fragments ready to yield.
    ready: VecDeque<String>,
    done: bool,
}

/// Consume one complete SSE line, updating state; pushes decoded content to `ready`.
fn consume_line<S>(st: &mut StreamState<S>, line: &str) {
    let line = line.trim_end_matches('\r');
    if line.is_empty() {
        // Blank line terminates an event.
        if st.data_lines.is_empty() {
            return;
        }
        let payload = st.data_lines.join("\n");
        st.data_lines.clear();
        if payload == "[DONE]" {
            st.done = true;
            return;
        }
        if let Ok(chunk) = serde_json::from_str::<StreamChunk>(&payload) {
            if let Some(text) = chunk
                .choices
                .into_iter()
                .next()
                .and_then(|c| c.delta.content)
            {
                if !text.is_empty() {
                    st.ready.push_back(text);
                }
            }
        }
        return;
    }
    if let Some(rest) = line.strip_prefix("data:") {
        st.data_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
    }
    // Other SSE fields (event:, id:, comments) are ignored.
}

/// Stream assistant content deltas from an OpenAI-compatible `chat/completions`
/// call with `stream: true`. Tolerates partial chunks, CRLF, multi-line `data:`
/// events, and the terminal `data: [DONE]`.
pub async fn chat_stream(
    cfg: &AiConfig,
    messages: Vec<ChatMessage>,
) -> anyhow::Result<impl Stream<Item = anyhow::Result<String>>> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = ChatRequest::streaming(cfg.chat_model.clone(), messages);
    let resp = crate::http::client()
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;

    let init = StreamState {
        stream: resp.bytes_stream(),
        buffer: String::new(),
        data_lines: Vec::new(),
        ready: VecDeque::new(),
        done: false,
    };

    Ok(futures_util::stream::unfold(init, |mut st| async move {
        loop {
            if let Some(text) = st.ready.pop_front() {
                return Some((Ok(text), st));
            }
            if st.done {
                return None;
            }
            match st.stream.next().await {
                Some(Ok(chunk)) => {
                    st.buffer.push_str(&String::from_utf8_lossy(&chunk));
                    while let Some(pos) = st.buffer.find('\n') {
                        let line = st.buffer[..pos].to_string();
                        st.buffer.drain(..=pos);
                        consume_line(&mut st, &line);
                    }
                }
                Some(Err(e)) => {
                    st.done = true;
                    return Some((Err(anyhow!(e)), st));
                }
                None => {
                    // Upstream closed: flush any trailing event without a final newline.
                    if !st.buffer.is_empty() {
                        let line = std::mem::take(&mut st.buffer);
                        consume_line(&mut st, &line);
                        consume_line(&mut st, "");
                    }
                    st.done = true;
                }
            }
        }
    }))
}
