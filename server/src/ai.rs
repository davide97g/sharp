use crate::config::{AiConfig, TranscribeConfig};
use anyhow::{anyhow, bail};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::Duration;

/// OpenAI-compatible chat/embeddings client. Shared connection pool, like
/// `deepseek.rs`.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// A single chat turn sent upstream (`role` is "system", "user", or "assistant").
#[derive(Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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
    let response = client()
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
    let mut resp = client()
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

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
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
    let body = ChatRequest {
        model: cfg.chat_model.clone(),
        messages,
        stream: true,
    };
    let resp = client()
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
