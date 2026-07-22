# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sharp — self-hosted Slack replacement. Chat, collaborative docs & canvas, plus LiveKit SFU voice/video calls with screen sharing. Rust server (axum + sqlx/Postgres, optional Redis) serving both the REST/WebSocket API and the built React SPA from one binary. Monorepo: `server/` (Rust), `web/` (React+Vite+TS SPA), `desktop/` (Tauri 2 shell around the same web app), `landing/` (Astro static site), `deploy/` (docker-compose + Caddy), `docs/`.

**`docs/ARCHITECTURE.md` is the single source of truth** for the v1 contract: DB schema, wire types, every REST endpoint, every WS event, validation rules. Read it before any change that touches the API surface, and keep it updated when the contract changes — server, web, and desktop are all built against it.

## Commands

```bash
./scripts/dev.sh          # one command: Postgres+Redis via Docker, server on :3000, web on :5173
```

Manual pieces:

```bash
# dev Postgres + Redis only
docker compose -f deploy/docker-compose.dev.yml up -d

# server (from server/)
DATABASE_URL=postgres://sharp:sharp@localhost:5432/sharp \
JWT_SECRET=dev-only-secret cargo run
cargo check               # fast compile check — no DATABASE_URL needed (no sqlx macros)

# web (from web/)
bun run dev               # :5173, proxies /api (incl. websocket) to :3000
bun run build             # tsc --noEmit && vite build — this IS the typecheck; run it to validate TS changes

# desktop (from desktop/)  — frontend is web/dist
bun run dev               # tauri dev (builds/serves web via `bun --cwd ../web`)

# landing (from landing/)
bun run dev / bun run build
```

**Bun is the JS package manager and script runner** (not npm/yarn) — `bun install`, `bun run <script>`, `bun.lock` lockfiles — everywhere: locally, in `deploy/Dockerfile*` (`oven/bun` images), and in GitHub Actions (`oven-sh/setup-bun`).

There is no test suite and no lint config; `cargo check` and `bun run build` (tsc) are the validation gates. Migrations in `server/migrations/` are embedded via `sqlx::migrate!()` and run automatically on server startup.

## Architecture essentials

- **sqlx runtime queries only — no `query!` macros.** Deliberate: keeps compilation independent of a live DATABASE_URL. Don't introduce macros.
- **Message IDs are Postgres `bigint` but serialized as strings** in all JSON (JS number safety). Channel/user IDs are UUIDs. Keep this invariant in both Rust models and TS types (`web/src/lib/types.ts` mirrors `server/src/models.rs`).
- **Realtime fanout**: `server/src/ws/` — in-process broadcast hub targeting member user-ids; if `REDIS_URL` is set, events also go through Redis pub/sub (`sharp:events`) for multi-replica sync. Every mutation route that changes visible state must emit the corresponding WS event (see the event list in ARCHITECTURE.md).
- **Single binary serves everything**: API under `/api/v1`, plus the built SPA from `WEB_DIST` (default `./web-dist`) with SPA fallback; if the dir is missing it runs API-only.
- **Web state lives in one zustand store** (`web/src/store.ts`) — API calls in `lib/api.ts`, WS client with reconnect+backoff in `lib/ws.ts`; on reconnect the channel list is refetched.
- **Server URL resolution in the web app** (order matters): `VITE_API_URL` → `localStorage['sharp.serverUrl']` → `window.location.origin`. The desktop build leaves `VITE_API_URL` unset so users enter a server URL at login (Tauri detected via `'__TAURI_INTERNALS__' in window`).
- **Domain rules**: single workspace in v1; threads are one level deep (`parent_id` on messages, replies can't be parents); deletes are soft (`deleted_at` set, content blanked); unread counts count top-level messages only; DM channels are get-or-create with a generated hidden name and per-viewer `dm_user`.
- **Docs (Phase 2)**: collaborative BlockNote/Yjs docs living inside channels. The server persists/relays Yjs updates via `yrs` over a binary WS (`/api/v1/docs/{id}/sync`, custom frame protocol — see the Phase 2 section of ARCHITECTURE.md) with compaction of the `doc_updates` log; web side is `web/src/lib/docSync.ts` (provider) + `web/src/components/docs/`. Roles resolve owner (creator) > per-user override > `everyone_role`, and access changes revoke open sync sessions live. Bridging: `[[doc:<uuid>|<title>]]` chips in chat, `mention`/`doclink` inline content in docs, doc-mention inbox. **Keep Mantine on v8**: `@blocknote/mantine`'s Mantine v9 is React-19-only and crashes the editor under React 18.
- **Canvas (Phase 3)**: collaborative tldraw whiteboards built on the exact same doc foundation — a canvas **is a `docs` row with `kind = 'canvas'`** (migration `0006_doc_kind.sql`), reusing the same sync socket, permissions, and inbox. tldraw records live under `ydoc.getMap('tldraw')` (server never interprets them); web binding is `web/src/lib/tldrawYjs.ts` + `web/src/components/canvas/`. Compaction skips extracting text, so canvases have title-only search and no backlinks. **tldraw assets are self-hosted** (bundled by Vite) — no CDN; the editor chunk is lazy-loaded. The web app has a three-way **mode rail** (Chat `/`, Docs `/d/:id`, Canvas `/x/:id`).
- **Voice/video calls (Phase 4)**: ephemeral **LiveKit SFU WebRTC** rooms — one per channel/DM or an independent `standalone_calls` room, plus optional **webcam video** and **screen sharing** (with system/tab audio). Sharp authorizes joins, mints 60-second room tokens, coordinates state, and enforces **25 participants / 16 cameras / 1 screen share**; self-hosted LiveKit carries media using adaptive subscriptions, dynacast, and simulcast. Client engine is `web/src/lib/voice.ts`; UI is `web/src/components/voice/` (`VideoStage` adaptive grid/filmstrip + draggable/resizable + in-page fullscreen stage, `CallChatRail`, `VoiceMiniWidget`). **Picture-in-picture** (`web/src/lib/pip.ts`): Meet-style Document PiP with element-PiP fallback so a call floats while you browse other channels. App state rides the existing main WS (`voice.*` events — see Phase 4 in ARCHITECTURE.md); `server/src/ws/voice.rs` owns the room registry. LiveKit config uses `LIVEKIT_URL`/`LIVEKIT_INTERNAL_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`. **Transcription**: VAD-chunked MediaRecorder audio is proxied to an OpenAI-compatible provider, configured independently with `TRANSCRIBE_API_KEY`/`TRANSCRIBE_BASE_URL`/`TRANSCRIBE_MODEL` (falling back to matching AI settings). **Call links** (`server/src/routes/call_links.rs`): authenticated visitors keep their user session and use the link as admission proof; anonymous visitors get a limited, room-bound guest JWT (`web/src/components/GuestCall.tsx`).
- **Sharpy AI assistant (Phase 6)**: RAG chatbot over workspace content. Enabled iff `AI_API_KEY` set (OpenAI-compatible: `AI_BASE_URL`/`AI_CHAT_MODEL`/`AI_EMBED_MODEL`); fully inert otherwise. pgvector (migration `0022_sharpy.sql`, compose images are `pgvector/pgvector:pg16` now — the `vector` extension is required); dimension-less `vector` columns + exact cosine scan, so switching embed models means truncating the embedding tables. Self-healing 15s embed worker (no job queue) + immediate embed in `publish_message`; edit/delete hooks drop rows. Retrieval is ACL-filtered (`channel_members` join for messages, doc-role re-check for docs) — Sharpy must never surface content the asker can't read; encrypted DMs never embed. Server: `server/src/ai.rs` (embeddings + streaming chat client), `server/src/routes/sharpy.rs`. Answers stream over SSE (`sources`/`delta`/`done` events) consumed via fetch-reader in `lib/api.ts`; UI is `web/src/components/SharpyPanel.tsx` slide-over (all modes) + home "Ask Sharpy" box + rail toggle. Query-embed failure degrades to a context-free answer (chat-only providers like DeepSeek work).
- **Tasks (Phase 7)**: Linear-lite tracker — **server-authoritative Postgres rows, NOT a Yjs doc kind** (migration `0023_tasks.sql`; the polls pattern: REST + `task.*`/`project.*` WS events broadcast to all users + notifications). Projects carry a `key`; identifiers (`SHARP-123`) allocate from `projects.next_number` in-transaction. Workflow states have fixed *types* (`backlog|unstarted|started|completed|canceled`) — automation and `completed_at` stamping target type, never name. Ordering = fracIndex strings (server mirrors `between(last, null)` in `routes/tasks.rs`). Server: `server/src/routes/tasks.rs` + `routes/github.rs`. Web: fifth **Tasks** rail mode (`/tasks`, `/t/:key`, `/t/:key/:num` peek), `web/src/components/tasks/` (list + board views, `useTaskDnd`). Chat bridging: bare identifiers auto-linkify against known project keys (Markdown.tsx), `[[task:<identifier>|<title>]]` chips, hover-toolbar "Create task" sets `source_message_id`, QuickSwitcher jumps. Notifications `task_assigned`/`task_comment` are channel-less (`notifications.channel_id` now nullable + `task_id` column). **GitHub sync** is env-first and inert without `GITHUB_WEBHOOK_SECRET` (+ optional `GITHUB_REPOS` allowlist): HMAC-verified webhook links branches/PRs by identifier in branch/title/body and moves states (started on branch/PR, completed on merge); Sharpy embeds tasks via `task_embeddings` (migration `0024`).
- **Notifications + web push**: `server/src/notify.rs` turns a new message into inbox rows + `notification.created` WS events + push to offline recipients. Kinds: `dm`, `mention` (`@Display Name` / `@all`), `reply`, `poll_ended`, `task_assigned`, `task_comment`. **Granular prefs** (migration `0026`): per-channel mode (`all`/`mentions`/`muted`), per-type master switches (`notify_{dm,mention,reply,task,poll}` — disabled type = no row at all), and DND that is either the manual toggle or a scheduled quiet-hours window (`dnd_scheduled`+`dnd_start`/`dnd_end` minutes-of-day local via `tz_offset`). All enforced in `notify.rs` (`channel_allows`/`kind_enabled`/`is_dnd`); DND keeps the inbox row+WS but suppresses push; managed from **Settings → Notifications** (`NotificationsSettings` in `UserSettingsModal.tsx`, store helper `dndActive()`). Web push uses the `web-push` crate (VAPID/RFC 8291); keys resolve env → `app_meta` persisted → auto-generated (`server/src/vapid.rs`), zero-config. Public key at `/push/vapid`; service worker `web/public/sw.js`; dead subs (404/410) pruned. **Native macOS push (APNs)**: `server/src/apns.rs` (token-based ES256 `.p8` JWT cached ~50 min + reqwest HTTP/2, prunes 410/BadDeviceToken), env-gated by `APNS_*` (inert unless all set), stored in `apns_tokens` (migration `0027`), gated on no-visible-session like web push. The Tauri desktop shell registers via `tauri-plugin-notifications` (community superset that **replaced** the official `tauri-plugin-notification` — they can't coexist; provides local notifications too) and `web/src/lib/apns.ts` POSTs the hex token to `/push/apns/register` — **best-effort: only works in a signed/notarized build with the `aps-environment` entitlement + Push-capable App ID; unsigned builds fall back silently** to WS + local + web push.
- Auth: JWT HS256, 30-day expiry, `Authorization: Bearer` on REST, `?token=` on the WS URL. First-user registration is always allowed even with `SHARP_DISABLE_SIGNUP=true`.
- **Desktop browser-login flow**: the Tauri app authenticates in the system browser, not an embedded form. It opens `<server-url>/desktop-auth?state=&scheme=` (a self-contained page served by the API from `server/src/desktop_auth.html`, so it works even in a split deploy where the SPA is on another subdomain); after login the page calls `POST /auth/desktop/code` (mints a one-time 60s code bound to the caller), then deep-links back via `sharp://auth?code=&state=`; the native app calls `POST /auth/desktop/exchange` (unauthenticated, single-use) to get its JWT. Web glue is `web/src/lib/desktopAuth.ts`. One-time codes are in-process/per-replica.

## Deploy

`deploy/docker-compose.yml` (Caddy/VPS) or `deploy/docker-compose.dokploy.yml` (Dokploy/Traefik — see `deploy/DOKPLOY.md`). Multi-stage `deploy/Dockerfile` builds web then server into one image. `deploy/docker-compose.local.yml` runs the full stack without host Rust/Node.
