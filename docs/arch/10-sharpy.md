# Phase 6 — Sharpy (AI workspace assistant)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Sharpy RAG assistant: pgvector embeddings, ACL-filtered retrieval, and the SSE ask flow.

RAG chatbot over workspace content: semantic search (pgvector) across messages and doc text,
answers streamed from any OpenAI-compatible LLM, per-user persisted conversations, slide-over
panel in the web UI ("Ask Sharpy" home box + rail toggle).

## Principles

- **Optional, config-gated.** Enabled iff `AI_API_KEY` is set. Unset → no worker spawned, write
  hooks no-op, all `/sharpy/*` routes 503 except `GET /sharpy/status` (`{"enabled":false}`);
  web hides the rail button and keeps the home box in preview mode.
- **Provider-agnostic.** One OpenAI-compatible endpoint pair (`/chat/completions` streaming,
  `/embeddings`) via `AI_BASE_URL` — OpenAI, DeepSeek, Ollama, LM Studio all work.
- **Permission-safe retrieval.** Vector search joins `channel_members` for messages (same ACL as
  `/search`) and re-checks per-doc roles via `compute_role` (same as `/docs/search`). Sharpy can
  never surface content the asking user couldn't read. Encrypted DMs are never embedded.
- **Self-healing index, no job queue.** A 15s worker embeds whatever is missing/stale; write
  hooks just invalidate (delete embedding rows on edit/delete) or opportunistically embed new
  messages inline. Doc staleness is `md5(content_text)`-driven off compaction output.

## Env

| var | default | meaning |
|---|---|---|
| `AI_API_KEY` | — | required to enable Sharpy |
| `AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base |
| `AI_CHAT_MODEL` | `gpt-4o-mini` | answer model |
| `AI_EMBED_MODEL` | `text-embedding-3-small` | embedding model |

**Postgres now needs the `vector` extension** — compose files use `pgvector/pgvector:pg16`
(was `postgres:16-alpine`). Migration `0022_sharpy.sql` runs `CREATE EXTENSION IF NOT EXISTS
vector` and fails on a non-pgvector image. Upgrading an existing volume from the alpine image:
data is compatible (both PG16), but the musl→glibc collation change warrants a one-time
`REINDEX DATABASE sharp;`.

## Database schema (migration `0022_sharpy.sql`)

- `message_embeddings (message_id bigint PK → messages CASCADE, channel_id uuid, embedding vector, created_at)`
  — one row per embedded message; index on `channel_id`.
- `doc_embeddings (doc_id uuid → docs CASCADE, chunk_index int, chunk_text text, embedding vector, PK (doc_id, chunk_index))`
  — doc text chunked ~1200 chars (title-prefixed), max 40 chunks/doc.
- `doc_embedding_state (doc_id uuid PK → docs CASCADE, content_hash text, embedded_at)` — md5 of
  `content_text` at embed time; hash mismatch → worker re-chunks.
- `assistant_conversations (id uuid PK, user_id → users CASCADE, title, created_at, updated_at)`.
- `assistant_messages (id bigint identity PK, conversation_id → CASCADE, role 'user'|'assistant', content text, sources jsonb, created_at)`.

`embedding vector` is deliberately dimension-less: the embedding model (and its dim) is
deployment config. Retrieval is an exact cosine scan (`<=>`), no ANN index — fine at
self-hosted scale; add HNSW later if a workspace outgrows it. Rust side uses the `pgvector`
crate (sqlx feature). **Changing `AI_EMBED_MODEL` (or provider) after rows exist requires**
`TRUNCATE message_embeddings, doc_embeddings, doc_embedding_state;` — mixed dimensions make
the `<=>` scan error, and the worker re-embeds everything from scratch anyway.

## Embedding pipeline (`server/src/ai.rs` client + worker loop in `main.rs`)

- Worker tick (15s, spawned only when configured): batch-embed up to 64 messages lacking an
  embedding row (non-deleted, non-encrypted, non-blank), then up to 4 docs whose
  `content_text` is non-empty and hash-stale (canvas/board have empty `content_text`, so only
  real docs + board note text ever embed).
- `publish_message` background spawn also embeds the new message immediately (failure silent —
  worker catches up next tick).
- `edit_message` / soft delete drop the row; worker re-embeds edited content.
- All failures are `tracing::warn` + retry next tick; worker never panics.

## Wire types

```ts
type SharpyConversation = { id: string; title: string; created_at: string; updated_at: string };
type SharpySource =
  | { kind: 'message'; message_id: string; channel_id: string; channel_name: string;
      author: string; snippet: string; created_at: string }
  | { kind: 'doc'; doc_id: string; title: string; doc_kind: 'doc' | 'canvas' | 'board'; snippet: string };
type SharpyMessage = { id: string; role: 'user' | 'assistant'; content: string;
                       sources: SharpySource[] | null; created_at: string };
```

## REST API additions — base `/api/v1`, `AuthUser`

- `GET /sharpy/status` → `{ enabled: bool }` (200 even when disabled).
- `GET /sharpy/conversations` → own conversations, newest-updated first.
- `POST /sharpy/conversations` → 201 new empty conversation.
- `GET /sharpy/conversations/{id}` → `{ conversation, messages }` (404 unless owner).
- `DELETE /sharpy/conversations/{id}` → 204.
- `POST /sharpy/conversations/{id}/messages` body `{ content: 1..4000 }` → **SSE stream**.

## Ask flow + SSE protocol

1. Persist user message; first message titles the conversation (first 60 chars).
2. Embed the query; retrieve top 12 messages + top 8 doc chunks (30 candidates → role filter),
   ACL-filtered as above. DM channels are labeled "DM" in context (hidden names never leak).
3. Prompt = Sharpy system prompt (cite sources as `[n]`, answer generally when context
   irrelevant, current date) + numbered context block + last 20 conversation turns.
4. Response `text/event-stream`, each event `data: <json>`:
   `{"type":"sources","sources":[…]}` first, then repeated `{"type":"delta","text":"…"}`,
   terminal `{"type":"done","message":<SharpyMessage>}` (assistant row persisted with sources)
   or `{"type":"error","message":"…"}` (nothing persisted).

Client consumes via `fetch` + `ReadableStream` reader (POST + `Authorization` header, so no
`EventSource`).

## Web UI

- `components/SharpyPanel.tsx` — slide-over aside (ThreadPanel pattern: desktop right rail
  `w-[420px]`, mobile sheet, Esc closes), mounted in `AppShell` for **all** modes; toggled by
  `sharpyOpen` store flag. Conversation history list, new-chat, streaming answer rendered live
  through the shared `Markdown` component, source chips linking to `/c/{channel}`, `/d/{doc}`,
  `/x/{canvas}`, board route.
- Home "Ask Sharpy" box submits straight into a new conversation and opens the panel; stays a
  preview stub when disabled. Mode-rail sparkle button toggles the panel (only when enabled).
- Store: flat `sharpy*` fields + actions in the single zustand store; `initSharpy()` runs at
  post-login bootstrap (status + conversation list).

