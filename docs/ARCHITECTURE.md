# sharp — Architecture & API Contract (v1)

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
  created_at timestamptz NOT NULL default now()
)

channels(
  id uuid PK default gen_random_uuid(),
  name text NOT NULL,                    -- for dm: generated, not shown
  kind text NOT NULL CHECK (kind IN ('public','private','dm')),
  topic text NOT NULL default '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL default now()
)
-- partial unique index on lower(name) WHERE kind <> 'dm'

channel_members(
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id bigint NOT NULL default 0,
  joined_at timestamptz NOT NULL default now(),
  PRIMARY KEY (channel_id, user_id)
)

messages(
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  parent_id bigint REFERENCES messages(id),   -- NULL = top-level; one level deep only
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
```

Migrations: `server/migrations/` via `sqlx::migrate!()` (embedded, run on startup).

## Wire types (JSON)

Message IDs are `bigint` → **serialized as strings** everywhere (JS safety).
Timestamps are RFC3339 UTC strings. Errors: `{"error": {"code": "...", "message": "..."}}`
with proper HTTP status (400/401/403/404/409/422).

```ts
User    = { id: string, email: string, display_name: string, created_at: string }
Channel = {
  id: string, name: string, kind: 'public'|'private'|'dm', topic: string,
  created_by: string|null, created_at: string,
  is_member: boolean, unread_count: number,       // for the requesting user
  last_message_at: string|null,
  dm_user: User|null                              // the *other* user, when kind='dm'
}
Reaction = { emoji: string, count: number, me: boolean }
Message  = {
  id: string, channel_id: string, parent_id: string|null,
  user: { id: string, display_name: string },
  content: string,                                 // '' when deleted
  created_at: string, edited_at: string|null, deleted_at: string|null,
  reactions: Reaction[],
  reply_count: number, last_reply_at: string|null  // top-level messages only
}
```

## REST API — base `/api/v1`, auth via `Authorization: Bearer <jwt>`

| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/register` | `{email, password, display_name}` → `201 {token, user}` |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/me` | → `User` |
| GET | `/users` | → `{users: User[], online_user_ids: string[]}` |
| GET | `/channels` | → `{channels: Channel[]}` (public ∪ my private/dm) |
| POST | `/channels` | `{name, kind: 'public'\|'private', topic?, member_ids?}` → `201 Channel` |
| POST | `/channels/dm` | `{user_id}` → `Channel` (get-or-create) |
| POST | `/channels/{id}/join` | → `204` (public only) |
| POST | `/channels/{id}/leave` | → `204` |
| GET | `/channels/{id}/members` | → `{members: User[]}` |
| POST | `/channels/{id}/read` | `{message_id}` → `204` (sets last_read high-water mark) |
| GET | `/channels/{id}/messages?before=<id>&limit=50` | → `{messages: Message[]}` top-level only, **ascending**, the `limit` newest with `id < before` (or newest overall) |
| POST | `/channels/{id}/messages` | `{content, parent_id?}` → `201 Message` |
| GET | `/messages/{id}/thread` | → `{parent: Message, replies: Message[]}` (asc) |
| PATCH | `/messages/{id}` | `{content}` → `Message` (author only) |
| DELETE | `/messages/{id}` | → `204` (author only, soft) |
| PUT | `/messages/{id}/reactions/{emoji}` | → `204` |
| DELETE | `/messages/{id}/reactions/{emoji}` | → `204` |
| GET | `/search?q=&limit=20` | → `{results: (Message & {channel_name: string})[]}` (my channels only) |
| GET | `/healthz` | → `200 {"status":"ok"}` (no auth) |

Validation: password ≥ 8 chars; channel name `[a-z0-9-]{1,50}`; message content 1–8000 chars.
Registering the **first user** of an instance is always open; later registrations are open
too in v1 (env `SHARP_DISABLE_SIGNUP=true` closes them).

## WebSocket — `GET /api/v1/ws?token=<jwt>`

Envelope both directions: `{"type": string, "payload": object}`.

Server → client:

- `hello` `{user_id, online_user_ids: string[]}` — on connect
- `message.created` `{message: Message}` — to all members of its channel (also to the
  author's other devices). Thread replies carry non-null `parent_id`.
- `message.updated` `{message: Message}`
- `message.deleted` `{message_id, channel_id, parent_id}`
- `reaction.added` / `reaction.removed` `{message_id, channel_id, emoji, user_id}`
- `channel.created` `{channel: Channel}` — to members (public: to everyone)
- `channel.member_joined` / `channel.member_left` `{channel_id, user: User}`
- `typing` `{channel_id, user_id, display_name}` — client shows ~3s
- `presence` `{user_id, status: 'online'|'offline'}`

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
`tauri-plugin-notification` (new-message notifications when window unfocused),
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

## Roadmap after v1

~~Files/uploads (S3/MinIO)~~ (shipped) → ~~notifications~~ (shipped) → multi-workspace →
Phase 2 docs (Tiptap+Yjs, y-sweet sidecar) → Phase 3 canvas. Chat stays append-only;
CRDT services stay separate. (File uploads + notifications: see the section below.)

---

# File uploads (S3-compatible) & Notifications

Two post-v1 features that share the single binary. Files live in S3-compatible object
storage; notifications are ordinary append-only Postgres rows fanned out over the existing
WS hub, plus web push for offline recipients.

## Database schema (migrations `0003_files.sql`, `0004_notifications.sql`)

```sql
files(
  id uuid PK default gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until attached
  user_id uuid NOT NULL REFERENCES users(id),                   -- uploader
  key text NOT NULL,                    -- object key: channels/<channel_id>/<file_id>
  filename text NOT NULL, content_type text NOT NULL, size bigint NOT NULL,
  created_at timestamptz NOT NULL default now()
)
-- indexes: (message_id); (channel_id, user_id) WHERE message_id IS NULL

notifications(
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- recipient
  kind text NOT NULL CHECK (kind IN ('mention','dm','reply')),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  preview text NOT NULL default '', created_at timestamptz NOT NULL default now(),
  read_at timestamptz
)
-- indexes: (user_id, id DESC); (user_id) WHERE read_at IS NULL

channel_prefs(user_id uuid, channel_id uuid, muted boolean NOT NULL default false,
  PRIMARY KEY (user_id, channel_id))                 -- absence = not muted
user_prefs(user_id uuid PK, dnd boolean NOT NULL default false)
push_subscriptions(id uuid PK, user_id uuid, endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL, auth text NOT NULL, created_at timestamptz)
app_meta(key text PK, value text NOT NULL)           -- e.g. auto-generated VAPID keys
```

## Wire types

Message ids and notification ids are `bigint` → **serialized as strings** (JS safety).

```ts
Attachment = { id: string, filename: string, content_type: string, size: number,
               url: string }              // url = proxied path "/api/v1/files/<id>"
Message = { …, attachments: Attachment[] }  // added to the existing Message shape

NotificationKind = 'mention'|'dm'|'reply'
Notification = {
  id: string, kind: NotificationKind,
  actor: { id: string, display_name: string },
  channel_id: string, channel_kind: 'public'|'private'|'dm', channel_name: string,
  message_id: string|null, preview: string,
  created_at: string, read_at: string|null
}
Prefs = { dnd: boolean, muted_channel_ids: string[] }
```

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| POST | `/channels/{id}/messages` | now also accepts `attachment_ids?: string[]`; content may be empty iff ≥1 attachment |
| POST | `/channels/{id}/uploads` | multipart `file` → `201 Attachment` (member only; ≤ `MAX_UPLOAD_MB`) |
| GET | `/files/{id}?download=1` | streamed bytes (member only); `download=1` forces attachment disposition |
| GET | `/notifications?before=<id>&limit=30` | → `{notifications: Notification[], unread_count}` (newest first) |
| POST | `/notifications/read` | `{ids?: string[]}` or `{all: true}` → `204` |
| GET | `/prefs` | → `Prefs` |
| PUT | `/prefs/dnd` | `{dnd}` → `204` |
| PUT | `/channels/{id}/prefs` | `{muted}` → `204` |
| GET | `/push/vapid` | → `{public_key: string\|null}` |
| POST | `/push/subscribe` | `{endpoint, keys:{p256dh, auth}}` → `204` (upsert by endpoint) |
| POST | `/push/unsubscribe` | `{endpoint}` → `204` |

Uploads and downloads are **always proxied through the server** (never presigned to the
browser) so channel-membership auth is enforced on every read. The web client fetches
attachments as blobs with the `Authorization` header.

## WebSocket event addition (existing `/api/v1/ws`)

- `notification.created` `{notification: Notification}` — to the recipient only.

## Notification semantics

Triggers, computed on message create:
- **dm** — any message in a `dm` channel notifies the other member(s).
- **mention** — `@Display Name` matching a channel member (longest match wins) notifies them.
- **reply** — a thread reply notifies the parent message's author.
Author is never notified; within a normal channel a mention supersedes a reply for the
same user.

Controls:
- **Mute (per channel)** — no notification row is created for that channel (silent).
- **Do Not Disturb (global)** — inbox row + `notification.created` still happen (bell
  updates), but **web push is suppressed** and the client suppresses toasts / OS popups.
- The client also suppresses the toast/OS popup when the message's channel is already
  open in a focused window.

Delivery: in-app inbox (bell + dropdown) + arrival toast; OS notification when the app is
open but unfocused (Web Notification API, or `tauri-plugin-notification` in the desktop
shell); **web push** (service worker `web/public/sw.js`) when the tab is closed and the
recipient has no live WS connection on this replica.

## Storage & push implementation

- **Storage**: `object_store` crate (feature `aws`) → one config targets AWS S3, MinIO,
  R2, B2. `server/src/storage.rs`. Object key = `channels/<channel_id>/<file_id>`.
- **Web push**: `web-push` crate (VAPID / RFC 8291, `hyper-client`). Keys resolve
  env → `app_meta` → auto-generated P-256 (`p256`) and persisted, so push works with zero
  config. Public key served at `/push/vapid`; dead subscriptions (404/410) are pruned.

## Env additions

`S3_BUCKET` · `S3_ACCESS_KEY` · `S3_SECRET_KEY` (all three enable uploads) · `S3_ENDPOINT`
(optional; MinIO/R2) · `S3_REGION` (default `us-east-1`) · `S3_ALLOW_HTTP` (auto-on for
`http://` endpoints) · `MAX_UPLOAD_MB` (default 25) · `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
(optional; base64url — auto-generated if unset) · `VAPID_SUBJECT` (default
`mailto:admin@sharp.app`). Dev/local/prod compose add a `minio` service + bucket-init job.
