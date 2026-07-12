# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sharp — self-hosted Slack replacement. Rust server (axum + sqlx/Postgres, optional Redis) serving both the REST/WebSocket API and the built React SPA from one binary. Monorepo: `server/` (Rust), `web/` (React+Vite+TS SPA), `desktop/` (Tauri 2 shell around the same web app), `landing/` (Astro static site), `deploy/` (docker-compose + Caddy), `docs/`.

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
- Auth: JWT HS256, 30-day expiry, `Authorization: Bearer` on REST, `?token=` on the WS URL. First-user registration is always allowed even with `SHARP_DISABLE_SIGNUP=true`.

## Deploy

`deploy/docker-compose.yml` (Caddy/VPS) or `deploy/docker-compose.dokploy.yml` (Dokploy/Traefik — see `deploy/DOKPLOY.md`). Multi-stage `deploy/Dockerfile` builds web then server into one image. `deploy/docker-compose.local.yml` runs the full stack without host Rust/Node.
