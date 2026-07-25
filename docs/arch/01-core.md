# sharp — Architecture & API Contract (v1)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Core contract: auth, users, channels, messages, threads, reactions, search, the main WebSocket, and the shape of server / web / desktop / landing / deploy.

sharp is a self-hostable Slack replacement. This document is the **single source of truth**
for v1: every component (server, web, desktop, deploy) is built against this contract.

## Monorepo layout

```
sharp/
├── server/     # Rust: axum + sqlx (Postgres) + Redis (optional fanout)
├── web/        # React + Vite + TypeScript SPA (the product UI)
├── desktop/    # Tauri 2 shell wrapping the web app (macOS, Windows, Linux)
├── landing/    # Astro landing page (sharphq site + download links)
├── deploy/     # docker-compose + Dockerfile + Caddy for VPS deployment
└── docs/       # this file & friends
```

## Principles

- **Chat is append-only rows, not CRDTs.** Messages live in Postgres; realtime is
  websocket fanout. (CRDTs arrive in Phase 2 for docs, as a separate service.)
- **One binary deploys everything.** The Rust server serves `/api/v1/*` and the built
  web SPA as static files with SPA fallback. Single container + Postgres (+ Redis).
- **Single workspace in v1.** Multi-workspace/tenancy comes later; the schema keeps it easy.
- **Desktop = same web app in a Tauri shell.** Server URL is chosen at login.

## v1 feature scope (ruthless)

Auth (email+password, JWT) · public/private channels · DMs · messages (markdown text)
· threads (`parent_id`) · edit/soft-delete · reactions · mentions (`@name`) · typing
indicators · presence (online/offline) · per-channel unread counts · full-text search
(Postgres FTS). **Deferred:** file uploads, notifications (email/push), multi-workspace,
OAuth/SSO.

## Database schema (Postgres ≥ 15)

```sql
users(
  id uuid PK default gen_random_uuid(),
  email text UNIQUE NOT NULL,            -- store lowercased
  password_hash text NOT NULL,           -- argon2id
  display_name text NOT NULL,
  avatar_url text,                       -- proxied /api/v1/users/{id}/avatar?v=<token>; null = none
  avatar_content_type text,              -- stored object's content-type (for the proxy)
  created_at timestamptz NOT NULL default now()
)

-- Personal nicknames: viewer-only overrides for other users' names (emoji OK).
-- Canonical display_name is unchanged; clients resolve at render time.
user_nicknames(
  viewer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  nickname text NOT NULL,                -- trim; 1–80 Unicode chars
  updated_at timestamptz NOT NULL default now(),
  PRIMARY KEY (viewer_id, target_user_id),
  CHECK (viewer_id <> target_user_id)
)

channels(
  id uuid PK default gen_random_uuid(),
  name text NOT NULL,                    -- for dm: generated, not shown
  kind text NOT NULL CHECK (kind IN ('public','private','dm')),
  topic text NOT NULL default '',
  created_by uuid REFERENCES users(id),    -- historical creator only; never used for channel authz
  created_at timestamptz NOT NULL default now()
)
-- partial unique index on lower(name) WHERE kind <> 'dm'

channel_members(
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL default 'editor' CHECK (role IN ('owner','editor','viewer')),
  last_read_message_id bigint NOT NULL default 0,
  joined_at timestamptz NOT NULL default now(),
  PRIMARY KEY (channel_id, user_id)
)
-- every non-DM channel has at least one owner; both DM members are editors

messages(
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  parent_id bigint REFERENCES messages(id),   -- NULL = top-level; one level deep only
  reply_to_id bigint REFERENCES messages(id) ON DELETE SET NULL, -- quote-reply target (not a thread)
  content text NOT NULL,
  created_at timestamptz NOT NULL default now(),
  edited_at timestamptz,
  deleted_at timestamptz,                     -- soft delete; content blanked on delete
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
)
-- indexes: (channel_id, id DESC); (parent_id); GIN (search)

reactions(
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL default now(),
  PRIMARY KEY (message_id, user_id, emoji)
)

voice_triggers(
  id uuid PK default gen_random_uuid(),
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE, -- NULL = private personal trigger
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- personal owner / channel creator
  phrase text NOT NULL,                    -- lowercase, trimmed, single-spaced
  action text NOT NULL default 'gif',      -- forward-compatible; v1 supports gif only
  created_at timestamptz NOT NULL default now()
)
-- unique (user_id, phrase) WHERE channel_id IS NULL
-- unique (channel_id, phrase) WHERE channel_id IS NOT NULL
```

Migrations: `server/migrations/` via `sqlx::migrate!()` (embedded, run on startup).

## Wire types (JSON)

Message IDs are `bigint` → **serialized as strings** everywhere (JS safety).
Timestamps are RFC3339 UTC strings. Errors: `{"error": {"code": "...", "message": "..."}}`
with proper HTTP status (400/401/403/404/409/422).

```ts
User    = { id: string, email?: string, display_name: string, avatar_url: string|null, created_at: string }
          // email is private: sent only on the viewer's own record (/auth/me, login, register,
          // update-me). Omitted for every other user (lists, members, doc roles, dm_user,
          // user.updated broadcast). Never leaks another user's address to the client.
ChannelRole = 'owner'|'editor'|'viewer'
VoiceTrigger = { id: string, channel_id: string|null, user_id: string, phrase: string, action: string, created_at: string }
Channel = {
  id: string, name: string, kind: 'public'|'private'|'dm', topic: string,
  created_by: string|null, created_at: string,
  is_member: boolean, my_role: ChannelRole|null,  // null for non-members
  unread_count: number,                           // for the requesting user
  last_message_at: string|null,
  dm_user: User|null                              // the *other* user, when kind='dm'
}
Reaction = { emoji: string, count: number, me: boolean }
Message  = {
  id: string, channel_id: string, parent_id: string|null,
  user: { id: string, display_name: string, avatar_url: string|null },
  content: string,                                 // '' when deleted
  created_at: string, edited_at: string|null, deleted_at: string|null,
  reactions: Reaction[],
  reply_count: number, last_reply_at: string|null, // top-level messages only
  reply_to: ReplyPreview|null                      // WhatsApp-style quote target (not a thread)
}
// Quote-reply snapshot embedded in a message; content is a truncated single-line preview.
ReplyPreview = { id: string, user: { id, display_name, avatar_url }, content: string, deleted: boolean }
```

## REST API — base `/api/v1`, auth via `Authorization: Bearer <jwt>`

| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/register` | `{email, password, display_name}` → `201 {token, user}` |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/password/config` | → `{enabled}` — whether self-service reset is available (an email backend is configured). The web login only shows "Forgot password?" when true. |
| POST | `/auth/password/forgot` | `{email}` → `200` **always** (no user-enumeration). If email is configured and the address exists, emails a reset link `{APP_URL or request origin}/reset-password?token=<raw>` (TTL 1h). Only the SHA-256 of the raw token is persisted (`password_reset_tokens`). |
| POST | `/auth/password/reset` | `{token, password}` → `200` — validates the unused/unexpired token, sets the new password hash, burns all of that user's tokens; `400` on invalid/expired token or password < 8. |
| POST | `/auth/desktop/code` | (authed) → `{code, expires_in}` — mints a one-time, single-use browser-login code (TTL 60s, in-process/per-replica) bound to the caller. Used by the desktop browser-login bridge. |
| POST | `/auth/desktop/exchange` | `{code}` → `{token, user}` — unauthenticated; consumes the code (single use, must be unexpired) and issues a JWT. The native app calls this after receiving the `sharp://auth?code=&state=` deep link. |
| GET | `/me` | → `User` |
| PATCH | `/me` | `{display_name?}` → `User` (emits `user.updated`) |
| POST | `/me/avatar` | multipart `file` (raster image, ≤ MAX_UPLOAD_MB) → `User` (stores to `avatars/{uid}`, bumps `avatar_url?v=`, emits `user.updated`) |
| DELETE | `/me/avatar` | → `User` (clears avatar, emits `user.updated`) |
| GET | `/me/nicknames` | → `{nicknames: Record<userId, string>}` — personal overrides the caller has set for other users |
| PUT | `/users/{id}/nickname` | `{nickname}` → `204` (trim; empty clears; max 80 Unicode chars; emoji OK; cannot target self) |
| DELETE | `/users/{id}/nickname` | → `204` (clears the caller's override for that user) |
| GET | `/users` | → `{users: User[], online_user_ids: string[]}` |
| GET | `/users/{id}/avatar` | → image bytes (any authed user; `?v=` cache-buster) |
| GET | `/channels` | → `{channels: Channel[]}` (public ∪ my private/dm) |
| POST | `/channels` | `{name, kind: 'public'\|'private', topic?, member_ids?}` → `201 Channel` |
| POST | `/channels/dm` | `{user_id}` → `Channel` (get-or-create) |
| PATCH | `/channels/{id}` | `{name?, topic?, kind?}` → `Channel` (channel owner; not DMs) |
| DELETE | `/channels/{id}` | → `204` (channel owner; hard delete, cascades; not DMs) |
| POST | `/channels/{id}/join` | → `204` (public only) |
| POST | `/channels/{id}/leave` | → `204` (last owner of a non-DM gets 403 until ownership is transferred) |
| GET | `/channels/{id}/members` | → `{members: (User & {role: ChannelRole})[]}` (role flattened onto each user) |
| POST | `/channels/{id}/members` | `{user_ids: string[]}` → `204` (channel owner; new members are editors; not DMs) |
| DELETE | `/channels/{id}/members/{user_id}` | → `204` (channel owner; last owner cannot be removed; not DMs) |
| PUT | `/channels/{id}/members/{user_id}/role` | `{role: ChannelRole}` → `204` (channel owner; 400 for DM/invalid role, 403 for non-owner/non-member target, 409 when demoting last owner; emits `channel.member_updated`) |
| POST | `/channels/{id}/read` | `{message_id}` → `204` (sets last_read high-water mark) |
| GET | `/channels/{id}/messages?before=<id>&limit=50` | → `{messages: Message[]}` top-level only, **ascending**, the `limit` newest with `id < before` (or newest overall) |
| POST | `/channels/{id}/messages` | `{content, parent_id?, reply_to_id?, attachment_ids?}` → `201 Message` (`reply_to_id`: quote a non-deleted message in the same channel) |
| GET | `/messages/{id}/thread` | → `{parent: Message, replies: Message[]}` (asc) |
| PATCH | `/messages/{id}` | `{content}` → `Message` (author only) |
| DELETE | `/messages/{id}` | → `204` (author only, soft) |
| PUT | `/messages/{id}/reactions/{emoji}` | → `204` |
| DELETE | `/messages/{id}/reactions/{emoji}` | → `204` |
| GET | `/search?q=&limit=20&channel_id=` | → `{results: (Message & {channel_name: string, snippet: string})[]}` (my channels only; optional `channel_id` scopes to one channel; `snippet` is a `ts_headline` with `<<`/`>>` markers around matches) |
| GET | `/healthz` | → `200 {"status":"ok","version":"<server package version>"}` (no auth) |

Channel management (rename/topic/visibility, membership, roles, deletion) is channel-owner only.
`channel_members.role` is the sole channel authorization source; `channels.created_by` is historical.
Every non-DM channel must retain at least one owner. DMs cannot be edited, deleted, or have members
or roles changed; both DM members are editors.

Owners and editors may post/edit their own messages, add reactions, upload files, create docs or
canvases, create/regenerate call links, and join voice. Viewers have read-only chat: they may read,
download, remove their own reactions, delete their own messages, mark read, and leave, but may not
perform those posting actions. Viewer posting gates return 403.

Validation: password ≥ 8 chars; channel name `[a-z0-9-]{1,50}`; message content 1–8000 chars.
Registering the **first user** of an instance is always open; later registrations are open
too in v1 (env `SHARP_DISABLE_SIGNUP=true` closes them).

## WebSocket — `GET /api/v1/ws?token=<jwt>`

Envelope both directions: `{"type": string, "payload": object}`.

Server → client:

- `hello` `{user_id, online_user_ids: string[]}` — on connect
- `user.updated` `{user: User}` — broadcast to all online users on a profile change (display name
  or avatar). Clients patch their `users` directory (and `me` if it's their own id); avatars are
  resolved from that directory so message/sidebar/header avatars update live.
- `message.created` `{message: Message, duck_streak?: {count, last_at}}` — to all members of
  its channel (also to the author's other devices). `duck_streak` is set for top-level
  non-GIF posts (shared channel burst for the duck bar). Thread replies carry non-null
  `parent_id`.
- `message.updated` `{message: Message}`
- `message.deleted` `{message_id, channel_id, parent_id}`
- `reaction.added` / `reaction.removed` `{message_id, channel_id, emoji, user_id}`
- `channel.created` `{channel: Channel}` — to members (public: to everyone)
- `channel.updated` `{channel: Channel}` — to members on rename/topic/visibility edit. Clients
  merge only `name`/`topic`/`kind` (per-viewer `unread_count`/`is_member`/`my_role` are preserved). A
  public→private flip also sends `channel.deleted` to online non-members; private→public sends
  them a non-member `channel.created`.
- `channel.deleted` `{channel_id}` — channel removed, or the recipient can no longer see it
  (deleted; removed from a private channel). Client drops all cached state and, if it was open,
  navigates home.
- `channel.member_joined` `{channel_id, user: User, role: ChannelRole}` and
  `channel.member_left` `{channel_id, user: User}`. Adding a user also sends that user a member-view
  `channel.created` so private channels appear.
- `channel.member_updated` `{channel_id, user_id, role: ChannelRole}` — to all channel members after
  a role change; open doc/canvas sync rooms for that channel are refreshed immediately.
- `typing` `{channel_id, user_id, display_name}` — client shows ~3s
- `presence` `{user_id, status: 'online'|'offline'}`
- `duck.streak` `{channel_id, duck_streak: {count, last_at}}` — shared duck bar reset
  after someone triggers a GIF suggestion (count `0`)
- `voice_trigger.created` `{channel_id, trigger: VoiceTrigger}` and
  `voice_trigger.deleted` `{channel_id, trigger_id}` — to all channel members after a shared
  channel/DM voice trigger changes. Personal triggers are private and do not emit WS events.
- `poll.created` / `poll.updated` `{poll: Poll}` — personalized per channel member so
  `my_votes` reflects that recipient.
- `poll.deleted` `{poll_id, channel_id, message_id}` — after creator-only soft deletion;
  `message_id` is the removed poll-card message id or `null`.

Client → server:

- `typing` `{channel_id}` (throttle client-side to 1/3s)
- `ping` `{}` → server replies `pong` (also plain WS ping/pong at protocol level)

Fanout: in-process `tokio::sync::broadcast` hub keyed by connection; each event targets
member user-ids. If `REDIS_URL` is set, events are also published/consumed via Redis
pub/sub channel `sharp:events` so multiple server replicas stay in sync. Presence =
connected-socket map (with Redis: keys `sharp:presence:<user_id>` with TTL).

## Server (Rust)

axum 0.7 + tokio + tower-http (cors, static SPA fallback via `ServeDir`),
sqlx 0.8 (postgres, runtime-tokio-rustls, **no query macros** — runtime queries only, so
no DATABASE_URL needed at compile time), argon2, jsonwebtoken (HS256, 30-day expiry,
claims `{sub: user_id, exp}`), redis (optional), tracing + tracing-subscriber.

Env: `DATABASE_URL` (required) · `JWT_SECRET` (required) · `PORT` (default 3000) ·
`REDIS_URL` (optional) · `WEB_DIST` (default `./web-dist`; if missing, API-only) ·
`SHARP_DISABLE_SIGNUP` · `RUST_LOG`.

Layout: `main.rs`, `config.rs`, `error.rs` (AppError → JSON), `auth.rs` (extractor),
`ws/` (hub, session), `routes/` (auth, users, channels, messages, search), `models.rs`.

SPA cache policy (`spa_cache_control` middleware in `main.rs`, mirrored by
`deploy/nginx.web.conf` in the split deploy): hashed `/assets/*` →
`public, max-age=31536000, immutable`; every other static file (index.html, sw.js,
manifest, icons) → `no-cache` (revalidate; 304s keep it cheap). `/api/*` untouched.

**Instant updates after deploy**: the Vite build stamps a per-build id into `sw.js`
(cache name + comment), so every deploy ships a byte-different worker. The client
registers with `updateViaCache: 'none'` and calls `registration.update()` on
focus/visible/online and every 15 min; the new worker `skipWaiting()`s +
`clients.claim()`s, and on `controllerchange` the page reloads once onto the new
version (deferred while an input is focused so a deploy never eats a draft).
Navigations are fetched with `cache: 'no-store'` (network-first, cache fallback
offline), so a fresh launch always gets the newest index.html.

## Web (React)

Vite + React 18 + TypeScript. Router: react-router. State: zustand. Styling: Tailwind CSS v4
(dark, sleek, `#`-accented brand). Markdown rendering: react-markdown + remark-gfm
(no raw HTML). API/WS base URL: `import.meta.env.VITE_API_URL` falling back to
`localStorage['sharp.serverUrl']` falling back to `window.location.origin` — the login
screen shows a "server" field when running inside Tauri (`'__TAURI_INTERNALS__' in window`).

UI: auth screen · sidebar (channels with unread badges, DMs with presence dots, create/join,
search box) · message pane (day dividers, grouped consecutive messages, hover actions:
react/reply/edit/delete, reply-count opens thread) · right-hand thread panel · composer
(Enter sends, Shift+Enter newline, ⌘K quick-switcher) · typing indicator row.
Reconnect WS with backoff; refetch channel list on reconnect.

## Desktop (Tauri 2)

`desktop/` Tauri 2 app whose frontend is `web/dist` (built with `VITE_API_URL` unset →
user enters server URL at login; persisted in localStorage). Plugins:
`tauri-plugin-notifications` (new-message notifications when window unfocused; the
community superset that **replaced** the official `tauri-plugin-notification` — the two
cannot coexist, see 05-files-notifications.md),
`tauri-plugin-shell` (external links). Bundle IDs `dev.sharp.app`. Targets: macOS
(aarch64 + x86_64 dmg), Windows (nsis), Linux (AppImage/deb). Built in CI via
`tauri-apps/tauri-action` on git tag `v*`, artifacts attached to GitHub Releases.

## Landing (Astro)

`landing/` — Astro (latest v5), single static page, zero client JS beyond an OS-detect
snippet for the download button. Hero with the `#` mark, tagline, download buttons
linking `https://github.com/davide97g/sharp/releases/latest`, feature trio (Chat/Self-host/
Open source), copy-paste `docker compose up -d` block, GitHub link. Deployable to any
static host; also served by the VPS Caddy at the apex domain.

## Deploy (VPS)

`deploy/docker-compose.yml`: `postgres:16-alpine` + `redis:7-alpine` + `sharp`
(multi-stage Dockerfile: node builds `web/dist` → rust builds server → distroless/debian
runtime serving both) + `caddy` (TLS, reverse proxy; also serves `landing/dist` on the
apex and the app on `app.<domain>` — or app at `/` if one domain). `.env.example` with
strong-secret placeholders. One command: `docker compose up -d`.

---

