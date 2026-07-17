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
  avatar_url text,                       -- proxied /api/v1/users/{id}/avatar?v=<token>; null = none
  avatar_content_type text,              -- stored object's content-type (for the proxy)
  created_at timestamptz NOT NULL default now()
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
| POST | `/auth/desktop/code` | (authed) → `{code, expires_in}` — mints a one-time, single-use browser-login code (TTL 60s, in-process/per-replica) bound to the caller. Used by the desktop browser-login bridge. |
| POST | `/auth/desktop/exchange` | `{code}` → `{token, user}` — unauthenticated; consumes the code (single use, must be unexpired) and issues a JWT. The native app calls this after receiving the `sharp://auth?code=&state=` deep link. |
| GET | `/me` | → `User` |
| PATCH | `/me` | `{display_name?}` → `User` (emits `user.updated`) |
| POST | `/me/avatar` | multipart `file` (raster image, ≤ MAX_UPLOAD_MB) → `User` (stores to `avatars/{uid}`, bumps `avatar_url?v=`, emits `user.updated`) |
| DELETE | `/me/avatar` | → `User` (clears avatar, emits `user.updated`) |
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
| GET | `/healthz` | → `200 {"status":"ok"}` (no auth) |

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

---

# Phase 2 — Docs (Affine-style knowledge base)

Collaborative block documents living **inside channels**. Chat stays append-only rows;
docs are Yjs CRDTs. Both are served by the same single binary — no sidecar.

## Principles

- **Editor**: BlockNote (`@blocknote/react` + `@blocknote/mantine`) — Notion/Affine-style
  block editor on ProseMirror, collaborative via Yjs.
- **Sync**: Yjs on the client; the Rust server persists and relays updates using `yrs`.
  The server does not interpret document semantics except for compaction, plain-text
  extraction (search) and doc-link extraction (backlinks).
- **Authorization is per channel**: every doc belongs to a channel; channel membership and role
  gate access. On top: per-doc `everyone_role` + per-user role overrides.
- **Bridging**: `@user` mentions inside docs notify people (inbox + WS); `[[doc]]` chips
  embed docs in chat messages and other docs; docs can be shared to a channel.
- **Limitation (v2)**: live doc sync rooms are per-replica (no Redis fanout for binary
  updates). Updates always persist to Postgres, so replicas converge on reopen. Chat
  events about docs (`doc.*`) do go through Redis like all other events.

## Database schema (migrations `0002_docs.sql`, `0013_doc_inherit.sql`)

```sql
docs(
  id uuid PK default gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind text NOT NULL default 'doc'            -- 'doc' (blocknote) | 'canvas' (tldraw); migration 0006
    CHECK (kind IN ('doc','canvas')),
  title text NOT NULL default '',            -- shown as 'Untitled' when empty
  icon text NOT NULL default '',              -- emoji, may be empty
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL default now(),
  updated_at timestamptz NOT NULL default now(),
  deleted_at timestamptz,                     -- soft delete = trash (restorable)
  everyone_role text NOT NULL default 'inherit'
    CHECK (everyone_role IN ('editor','viewer','none','inherit')),
  content_text text NOT NULL default '',      -- extracted plain text (search/preview)
  search tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', title || ' ' || content_text)) STORED
)
-- indexes: (channel_id, updated_at DESC); GIN (search)

doc_updates(                                  -- yjs update log (v1 lib0 encoding)
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL default now()
)
-- index: (doc_id, id)

doc_roles(                                    -- per-user overrides of everyone_role
  doc_id uuid REFERENCES docs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor','viewer','none')),
  PRIMARY KEY (doc_id, user_id)
)

doc_links(                                    -- doc → doc links, for backlinks
  doc_id uuid REFERENCES docs(id) ON DELETE CASCADE,        -- source
  target_doc_id uuid REFERENCES docs(id) ON DELETE CASCADE, -- target
  PRIMARY KEY (doc_id, target_doc_id)
)

doc_mentions(                                 -- @user inside a doc = inbox notification
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  from_user uuid NOT NULL REFERENCES users(id),
  to_user uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL default now(),
  read_at timestamptz
)
-- index: (to_user, read_at)
```

### Role resolution (effective `my_role`)

1. Not a member of the doc's channel → **no access** (404, and doc never listed).
2. Doc creator → `owner` (always full access; cannot be demoted; manages roles/trash).
3. Channel owner → `owner` (including role management, `everyone_role`, permanent delete).
4. `doc_roles` row for the user → that role.
5. If `docs.everyone_role != 'inherit'` → that role.
6. Otherwise channel editor → `editor`; channel viewer → `viewer`.

Per-doc `none` cannot hide a doc from its creator or a channel owner. For everyone else, `none`
behaves like the doc doesn't exist. `viewer` = read-only (server
drops their sync updates; UI renders read-only). `editor` = full content editing +
rename + trash. Only `owner` edits roles, `everyone_role`, and permanently deletes.

## Wire types

Doc-mention IDs are `bigint` → **serialized as strings** (same invariant as messages).

```ts
DocRole = 'owner'|'editor'|'viewer'|'none'
Doc = {
  id: string, channel_id: string, kind: 'doc'|'canvas', title: string, icon: string,
  created_by: string|null, created_at: string, updated_at: string,
  deleted_at: string|null,
  everyone_role: 'editor'|'viewer'|'none'|'inherit',
  my_role: DocRole,                    // resolved for the requesting/receiving user
  preview: string                      // first 160 chars of content_text
}
DocMention = {
  id: string,
  doc: { id: string, kind: 'doc'|'canvas', title: string, icon: string, channel_id: string },
  from_user: { id: string, display_name: string },
  created_at: string, read_at: string|null
}
```

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| GET | `/channels/{id}/docs` | → `{docs: Doc[]}` (not trashed, `my_role != none`, updated_at desc) |
| GET | `/channels/{id}/docs/trash` | → `{docs: Doc[]}` (trashed, same visibility) |
| POST | `/channels/{id}/docs` | `{title?, icon?, kind?}` → `201 Doc` (channel owner/editor; `kind` defaults `'doc'`, or `'canvas'` for a whiteboard) |
| GET | `/docs/{id}` | → `Doc` |
| PATCH | `/docs/{id}` | `{title?, icon?, everyone_role?}` → `Doc` (title/icon: editor+; everyone_role: owner; empty body → 422) |
| DELETE | `/docs/{id}` | → `204` (editor+; soft — sets `deleted_at`) |
| POST | `/docs/{id}/restore` | → `Doc` (editor+) |
| DELETE | `/docs/{id}/permanent` | → `204` (owner only; hard delete) |
| GET | `/docs/{id}/roles` | → `{roles: [{user: User, role: 'editor'\|'viewer'\|'none'}]}` (member; **explicit overrides only** — the client merges with the channel member list + `everyone_role`) |
| PUT | `/docs/{id}/roles/{user_id}` | `{role: 'editor'\|'viewer'\|'none'}` → `204` (owner; target must be channel member, not creator) |
| DELETE | `/docs/{id}/roles/{user_id}` | → `204` (owner; removes override) |
| GET | `/docs/{id}/backlinks` | → `{docs: Doc[]}` (docs linking here that the requester can see: **must be a member of the linking doc's channel** + role ≠ none) |
| POST | `/docs/{id}/mentions` | `{user_id}` → `204` (editor+; no self-mentions; not on trashed docs; target must be able to see the doc; dedup: skipped if an unread mention of the same user in the same doc exists) |
| GET | `/mentions` | → `{mentions: DocMention[]}` (mine, unread first then newest, limit 50) |
| POST | `/mentions/read` | `{ids: string[]}` → `204` (marks mine read) |
| GET | `/docs/search?q=&limit=20&doc_id=` | → `{results: (Doc & {channel_name: string, snippet: string})[]}` (docs I can see, FTS + title ILIKE; optional `doc_id` scopes to one doc; `snippet` is a `ts_headline` over `content_text` with `<<`/`>>` markers, empty for canvases) |

Validation: title ≤ 200 chars; icon ≤ 16 chars; mention POST is idempotent.

## Doc sync WebSocket — `GET /api/v1/docs/{id}/sync?token=<jwt>`

Access checked on upgrade (channel member + `my_role != none`); `403`/`404` otherwise.
Trashed docs accept read-only connections (restore preview), updates are dropped.

**Binary frames**; first byte is the frame type, rest is payload:

| byte | name | direction | payload |
|---|---|---|---|
| `0x00` | update | both | Yjs update, v1 encoding. Client→server: persisted to `doc_updates` + relayed to the room (dropped silently if sender is a viewer). Server→client: applied to the local Y.Doc. |
| `0x01` | awareness | both | `y-protocols/awareness` update bytes. Relayed to the room, never persisted. Server caches each connection's last awareness frame and replays all cached frames to a new joiner; on disconnect peers time the client out (30s y-protocols timeout). |
| `0x02` | init state | server→client | Merged doc state as one Yjs v1 update (all `doc_updates` rows merged via `yrs::merge_updates_v1`). Sent once on connect. |
| `0x03` | server state vector | server→client | `yrs` state vector of the merged state, sent right after `0x02`. Client replies with `Y.encodeStateAsUpdate(ydoc, sv)` as a `0x00` frame if it holds changes the server lacks (offline edits / reconnect). |
| `0x04` | role | server→client | 1 byte: `0` = read-only (viewer, or doc trashed), `1` = editor/owner. Sent on connect **and again mid-session** whenever effective access changes (role/`everyone_role` edit, trash, restore) — the client must apply it live. |

The Yjs fragment name is **`blocknote`** — client binds
`ydoc.getXmlFragment('blocknote')`, server reads `get_or_insert_xml_fragment("blocknote")`.
(Canvas docs — `kind = 'canvas'` — reuse this exact sync socket but store a tldraw document
under `ydoc.getMap('tldraw')` instead; the server never interprets it. See Phase 3 below.)

**Persistence & compaction**: every incoming `0x00` inserts a `doc_updates` row and bumps
`docs.updated_at`. Compaction (merge all rows into one via yrs, refresh `content_text` and
`doc_links` from the XML, broadcast `doc.updated`) runs when the last connection leaves
the room, lazily on room open, and **mid-session every 200 persisted updates** — so an
always-open tab can't grow the log unboundedly. Rows carry a `compacted` flag (migration
`0003`): when no uncompacted rows exist, compaction is a no-op — no merge, no event, no
`updated_at` change, so merely viewing a doc never reorders doc lists. yrs merges run on
the blocking thread pool. Update frames are capped at 512 KB (oversized ⇒ socket closed);
awareness frames over 64 KB are dropped silently. If persisting an update fails, the frame
is not relayed and the socket is closed so the client resyncs from DB state.

**Access revocation is live**: channel-member role changes, per-doc role/`everyone_role` changes,
trash and restore push a
fresh `0x04` to open sessions (and flip server-side update dropping instantly); loss of
access (`none` or channel removal/leave) and permanent deletion close the socket server-side. A closed client's
reconnect gets 403/404 on upgrade — after a few consecutive upgrade failures the client
must stop retrying and treat the doc as unavailable. A slow consumer whose send queue
fills (1024 frames) is evicted from the room.

## Main-WS event additions (existing `/api/v1/ws` socket)

- `doc.created` `{doc: Doc}` — to channel members (per-viewer `my_role`, like `channel.created`'s `dm_user`). Members whose role resolves to `none` receive a **redacted** doc (`title`/`icon`/`preview` empty, `my_role: "none"`) — the client uses it purely to drop the doc from its UI.
- `doc.updated` `{doc: Doc}` — meta changes (rename/icon/roles/restore) + after non-empty compaction (same `none` redaction)
- `doc.deleted` `{doc_id, channel_id, permanent: boolean}` — trash or hard delete
- `doc.mention` `{mention: DocMention}` — to the mentioned user only

## Content bridging

- **Doc chips in chat**: message content may contain `[[doc:<uuid>|<title>]]`. The
  composer opens a doc picker on typing `[[` (searches `/docs/search`); the renderer
  replaces the token with a clickable doc chip navigating to `/d/<uuid>`. Plain text
  otherwise — search and the API are unaffected. A "Share to channel" action on a doc
  posts such a message via the normal messages endpoint.
- **Doc links in docs**: custom BlockNote inline content `doclink` with props
  `{docId, title}`, inserted via a `[`-triggered picker inside the editor (BlockNote
  suggestion menus key on a single character). Serialized into
  the Yjs XML as a `<doclink docId="…"/>` element — that's what compaction scans for
  backlinks.
- **People mentions in docs**: custom BlockNote inline content `mention` with props
  `{userId, name}`, inserted via `@` suggestion menu (channel members). On insert the
  client calls `POST /docs/{id}/mentions`; the server persists it and emits `doc.mention`.
  Delivery mirrors chat: recipients online get toast + OS popup (unless DND / already
  viewing the doc); offline recipients get **web push** (deep-links to `/d/` or `/x/` by
  doc kind). Push payloads carry an explicit `path` the service worker navigates to.

## Web UI (docs mode)

- **Mode rail**: thin far-left rail with three icons — Chat (`#`), Docs, and Canvas —
  switching between the chat, docs, and canvas UIs. Routes: chat keeps `/`, `/c/:channelId`;
  docs adds `/docs` (home: recent docs + my mentions inbox), `/docs/c/:channelId` (channel
  doc list + trash), `/d/:docId` (editor); canvas adds `/canvas`, `/x/:docId`. Each rail
  icon carries its own unread badge: Chat = unread chat notifications; Docs = unread
  mentions on `kind:'doc'` docs; Canvas = unread mentions on `kind:'canvas'` docs.
- **Docs sidebar**: channels (member ones) with their doc lists, new-doc button, trash
  section per channel, mentions inbox link.
- **Editor page**: emoji icon + borderless title input (debounced PATCH), BlockNote
  editor bound to the doc's Y.Doc fragment, presence avatars from awareness, share-to-
  channel action, role manager modal (owner only), backlinks list, read-only banner for
  viewers, trashed banner with restore.
- **Provider**: custom `SharpDocProvider` in `web/src/lib/docSync.ts` implementing the
  frame protocol over WebSocket with reconnect+backoff, exposing a `y-protocols`
  `Awareness` instance for BlockNote's `collaboration.provider`.
- Cursor colors are derived deterministically from the user id.

# Phase 3 — Canvas (edgeless whiteboard)

Collaborative tldraw whiteboards, built entirely on the Phase 2 doc foundation: a canvas
**is a `docs` row with `kind = 'canvas'`** (migration `0006_doc_kind.sql`). It reuses the
doc REST surface, the per-channel + per-doc role model, trash/restore, and the
`/api/v1/docs/{id}/sync` WebSocket **unchanged**.

- **Editor**: `tldraw` v5 — full edgeless toolset (draw, shapes, arrows, text, sticky
  notes, images) with live multiplayer cursors.
- **Sync**: the doc-sync socket is content-agnostic (raw Yjs v1 bytes + `yrs` merge). A
  canvas stores its tldraw document as whole `TLRecord`s in `ydoc.getMap('tldraw')` —
  document-scope records only, so each viewer keeps its own camera/selection. The client
  binds it with `useYjsTldrawStore` (`web/src/lib/tldrawYjs.ts`) over the shared
  `SharpDocProvider`; presence rides the existing `y-protocols` awareness.
- **Compaction**: `compact_doc` still merges the update log for canvases, but **skips the
  blocknote text/link extraction** — `content_text` stays empty and no `doc_links` are
  written, so canvas search matches on title only and canvases have no backlinks.
- **Wire**: `Doc` carries `kind`; `POST /channels/{id}/docs` accepts optional `kind`.
  `doc.created`/`doc.updated` carry `kind`, so clients route to the doc editor (`/d/:id`)
  or the canvas editor (`/x/:id`).
- **Web**: a third **Canvas** mode in the rail; `web/src/components/canvas/` mirrors
  `components/docs/` (Home / channel list / sidebar / editor). The tldraw editor chunk is
  lazy-loaded, and tldraw assets are **self-hosted** (bundled by Vite) — no CDN dependency.

# Phase 4 — Voice + camera rooms (WebRTC mesh)

Ephemeral P2P-mesh WebRTC audio rooms with optional webcam video on channels, DMs, and
standalone meets.
Browsers connect directly; the server does signaling, media-state coordination, and buffering
of member-submitted speech-recognition phrases for roast GIF suggestions and durable voice-trigger
matching. Registered users may keep private trigger phrases, while channels/DMs share a trigger
vocabulary. No media passes through the server and there is no SFU.

## Principles

- **Channel or standalone context**: every channel kind (`public`, `private`, or `dm`) may
  have one voice room. `standalone_calls` provides independently named, shareable rooms with
  no channel/DM foreign key. A room exists in memory while it has participants.
- **Ephemeral media state, durable notes**: WebRTC rooms remain in server memory. Once a
  participant opts into meeting notes, attendance, opted-in transcript phrases, generated
  notes, and action items are persisted in Postgres.
- **P2P mesh media**: every eligible participant connects directly to every other eligible
  participant. The server relays signaling messages only and never handles media.
- **Capacity**: the server enforces a maximum of **8 audio participants**, **4 active
  cameras**, and **1 screen share** per room (all server-authoritative). A rejected fifth
  camera stays connected by audio; a rejected second screen share is non-fatal.
- **Web camera scope**: webcam video and screen sharing are supported in the browser client.
  Broadcast, recording, virtual backgrounds, mobile support, and desktop-specific camera
  permission work are deferred.

## Wire types

All ids are strings in JSON (UUIDs). A WebSocket connection id is the peer identity.

```ts
VoiceParticipant = { conn_id: string, user_id: string, display_name: string, guest: boolean, muted: boolean, transcribing: boolean, camera_on: boolean, screen_on: boolean, screen_stream_id: string | null, hand_raised: boolean, hand_raised_at: number | null, joined_at: string }
VoiceRoomSnapshot = { channel_id: string, participants: VoiceParticipant[], active_meeting_id: string | null }
VoiceSignalKind = 'offer'|'answer'|'candidate'
```

## Main-WS event additions (existing `/api/v1/ws` socket)

The existing envelope remains `{"type": string, "payload": object}` in both directions.

Client → server:

- `voice.join` `{channel_id, link_token?}` — `channel_id` is the room UUID for wire
  compatibility. Authenticated link visitors send `link_token` as admission proof without
  replacing their account session.
- `voice.leave` `{channel_id}`
- `voice.mute` `{channel_id, muted: boolean}`
- `voice.transcribe` `{channel_id, enabled: boolean}` — opt in or out of sending
  locally transcribed phrases for the participant's active room connection.
- `voice.phrase` `{channel_id, text: string}` — accepted only from an active
  participant with `transcribing=true`. Text is trimmed, capped at 500 characters, and empty
  phrases are ignored.
- Registered users and call-link guests may use `voice.transcribe` / `voice.phrase`. Guest
  tokens remain scoped to their bound channel and cannot access meeting REST endpoints.
- `voice.camera` `{channel_id, enabled: boolean}`
- `voice.screen` `{channel_id, enabled: boolean, stream_id?: string}` — `stream_id` is the
  msid of the sharer's screen `MediaStream`, sent only when enabling.
- `voice.hand` `{channel_id, raised: boolean}` — raise or lower the participant's hand.
  Idempotent (a request that matches the current state is a no-op with no broadcast).
  Guests may send it. Unmuting via `voice.mute` also lowers a raised hand automatically.
- `voice.signal` `{channel_id, to_user, to_conn, kind: "offer"|"answer"|"candidate", data: object}`
  — `data` is SDP `{type,sdp}` for an offer/answer, or `RTCIceCandidateInit` for a candidate.

Server → client:

- `hello` payload is extended with `conn_id: string` and
  `voice_rooms: VoiceRoomSnapshot[]`, where each snapshot is
  `{channel_id, participants: VoiceParticipant[], active_meeting_id}` and each participant is
  `{conn_id, user_id, display_name: string, guest: boolean, muted: boolean, transcribing: boolean, camera_on: boolean, screen_on: boolean, screen_stream_id: string | null, hand_raised: boolean, hand_raised_at: number | null, joined_at: string}`.
  `hand_raised_at` is Unix epoch milliseconds set when the hand was raised and `null` while lowered.
  `display_name` is filled server-side for everyone (users from the `users` table,
  guests from their token) so clients can render names without `/users` access; `guest`
  marks public voice-link joiners.
- `voice.state` `{channel_id, participants: VoiceParticipant[]}` — sent only to the joining
  connection immediately after a successful join.
- `voice.participant_joined` `{channel_id, participant: VoiceParticipant}` — broadcast to
  the room audience (see broadcast targeting below).
- `voice.participant_left` `{channel_id, conn_id, user_id}` — broadcast to the room
  audience.
- `voice.participant_updated` `{channel_id, participant: VoiceParticipant}` — broadcast to
  the room audience after mute, transcription, camera, screen-share, or raise-hand state
  changes.
- `voice.roast_armed` `{channel_id, armed: boolean}` — broadcast to the room audience when
  three phrases with gaps of at most 20 seconds arm a voice roast, and with `armed=false`
  after a successful voice GIF suggestion consumes it.
- `voice.trigger_fired` `{channel_id, user_id, display_name, phrase}` — broadcast to the room
  audience after a registered speaker's matched trigger successfully auto-posts a GIF. `phrase`
  is the stored trigger phrase, not the full transcription utterance.
- `voice.signal` `{channel_id, from_user, from_conn, to_user, to_conn, kind, data}` —
  delivered to `to_user`'s connections; receivers filter on
  `to_conn === my conn_id`.
- `voice.error`
  `{channel_id, code: "room_full"|"camera_full"|"screen_taken"|"not_member"|"not_in_room"|"link_revoked"}`
  — sent only to the offending connection. `camera_full` and `screen_taken` do not end the
  audio call. `link_revoked` is sent to a guest whose voice link no longer matches the
  channel's current token (the link was regenerated or removed).

## Server behavior

- `voice.join`: registered users may enter through channel owner/editor membership,
  standalone-call ownership, or a matching `link_token`. A registered link visitor remains
  a registered participant. Guests skip membership and instead verify the JWT's bound link
  against the room's current token. Then check the 8-participant cap and send `voice.error`
  with `code: "room_full"`
  to the sender only when full. Insert the participant with `muted=false, camera_on=false`
  and its resolved `display_name`/`guest`, reply with `voice.state` on the sender's tx only,
  then broadcast `voice.participant_joined` to the room audience. Joining twice from the same
  conn is idempotent and re-sends `voice.state`. New participants start with
  `transcribing=false` and hand lowered (`hand_raised=false`, `hand_raised_at=null`). Demoting a registered participant to channel viewer removes all of that
  user's connections from the room immediately.
- **Broadcast targeting**: every voice broadcast (`participant_joined`/`left`/`updated` and
  `voice.roast_armed`)
  targets the **union** of the channel's member ids and the user-ids currently in the room's
  participant map (computed at broadcast time; `participant_left` additionally includes the
  just-removed user's id). This is required so guests — who are not channel members — receive
  participant events. `voice.signal` targets an explicit `to_user` and is unchanged.
- `voice.leave`: remove the sender's conn from the room, drop the room when empty, and
  broadcast `voice.participant_left`.
- `voice.mute`: update the participant's flag and broadcast `voice.participant_updated`. When
  the change is an unmute (`muted=false`) and the participant's hand is raised, also clear
  `hand_raised`/`hand_raised_at` in the same participant snapshot so a single
  `voice.participant_updated` carries both changes.
- `voice.hand`: require an active room participant; set `hand_raised` to the requested
  `raised` value (stamping `hand_raised_at` with the current Unix epoch ms when raising,
  clearing it to `null` when lowering) and broadcast the complete participant through
  `voice.participant_updated`. A request that matches the current state is an idempotent
  no-op with no broadcast. Guests may raise/lower their hand.
- `voice.transcribe`: require an active room participant, update `transcribing`, and broadcast
  the complete participant through `voice.participant_updated`. First opt-in creates a durable
  meeting and snapshots current attendance. Disabling stops future phrases from that connection
  but does not end the meeting.
- `voice.phrase`: require an active participant with `transcribing=true`; append the server-known
  display name and trimmed text to the room's oldest-first transcript buffer (maximum 50 phrases).
  A phrase within 20 seconds of the previous phrase increments the room streak; otherwise it
  starts a new streak at one. The first transition to three or more phrases broadcasts
  `voice.roast_armed {armed:true}`. After that existing meeting/streak work, registered speakers'
  phrases are checked asynchronously against channel triggers plus their private personal
  triggers; guest phrases never fire triggers. Matching lowercases text, collapses whitespace,
  strips punctuation into word boundaries, and requires the trigger words as a contiguous word
  subsequence (`roast` does not match `roasted`). Earliest occurrence wins; a channel trigger
  beats a personal trigger at the same word position, with creation order/id as the stable
  fallback.
- A matched trigger uses the shared per-channel `gif_suggest_cooldowns` entry and configured
  `gif.duck_cooldown_secs`, so voice triggers, voice-roast suggestions, and chat duck suggestions
  suppress one another during slow mode. Disabled duck settings, a missing GIF provider/API key,
  or missing DeepSeek configuration skip matching entirely. The detached task reads the latest
  five non-deleted top-level channel messages oldest-first (excluding prior duck GIFs), requires
  at least two, runs the normal DeepSeek/provider best-GIF pipeline, and posts
  `[[gif:<url>|<alt>|duck|<query>]]` as the speaker through the normal message/notification path.
  Standalone rooms have no channel messages, so personal matches there abort silently.
- `voice.camera`: require an active room participant; atomically reserve/release a camera
  slot and broadcast the complete participant state. Enabling is rejected with `camera_full`
  when four slots are already reserved. Repeated requests are idempotent.
- `voice.screen`: require an active room participant; atomically reserve/release the single
  screen-share slot and broadcast the complete participant state. On enable, store
  `screen_stream_id` from the request's `stream_id`; on disable, clear it to `null`. Enabling
  is rejected with `screen_taken` when another participant already holds the slot. Repeated
  requests are idempotent (state unchanged → re-broadcast current state).
- `voice.signal`: the sender must be a participant of `channel_id`; otherwise send
  `voice.error` with `code: "not_in_room"`. Relay with
  `hub.broadcast(envelope, vec![to_user])`, adding `from_user` and `from_conn`.
- WS disconnect: remove that conn from every room it is in, broadcast
  `voice.participant_left` for each, close durable attendance, and drop empty rooms. Last leave
  finalizes the meeting and queues AI notes.
- Member removed from channel / leaves channel / channel deleted: evict all of that user's
  conns from the room (all conns for channel delete), with `voice.participant_left`
  broadcasts.

## Mesh topology and signaling

- Peer identity is the WS connection id (`conn_id`, a UUID string). A user may have
  multiple connections, and each is a distinct mesh peer. The main WS `hello` event tells
  the client its own `conn_id`.
- The lexicographically smaller `conn_id` creates the initial offer. Peers then use WebRTC
  perfect negotiation for camera track addition/removal; the larger `conn_id` is the polite
  peer, making simultaneous toggles deterministic and glare-safe.
- A client never creates a peer connection to a conn whose `user_id` equals its own, which
  prevents self-echo across the user's devices and tabs.
- ICE candidates are trickled through `voice.signal` as they become available.
- Camera capture uses ideal 640×360 at 20 fps (24 fps maximum), with an approximate
  500 kbps outgoing-sender cap to constrain mesh upload cost.
- Screen-share tracks are published under a **separate `MediaStream`** (distinct from the
  camera/mic stream) whose id the sharer advertises out-of-band as `screen_stream_id` in the
  `voice.screen` message. Receivers classify each inbound track by comparing
  `event.streams[0].id` against the participant's advertised `screen_stream_id`, so a
  simultaneous camera + screen sharer's two video tracks route to the correct surface.

## Web camera UI and lifecycle

- Joining remains audio-first. Camera capture starts only after an explicit toggle and a
  successful server slot reservation.
- The call UI is a floating app overlay, separate from chat / docs / canvas. Main content
  stays interactive underneath. Stage modes: `expanded` (large floating panel), `compact`
  (smaller panel), and `mini` (corner widget). Panels are draggable, resizable, and can be
  collapsed/expanded without leaving the call. Camera-off participants show as circular
  avatars; camera-on participants use a responsive video grid. Controls (mute, camera,
  leave) and Meet-style device pickers live on the overlay. There is no sidebar voice bar.
- Local preview is mirrored; remote video is not. Remote audio continues through hidden
  audio elements independently of navigation.
- Camera stays active while the voice session is open across channel / docs / canvas
  navigation. Leaving the call, logout, page unload, or WebSocket reconnection stops local
  tracks. Permission/device failure releases the reserved slot and leaves audio connected.

## REST API addition — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| GET | `/voice/config` | (any valid token — **user OR guest**) → `{"ice_servers": [{"urls": ["stun:..."]}, {"urls": ["turn:..."], "username": "...", "credential": "..."}]}`; the TURN entry is present only when configured. This is the only endpoint guests may use successfully; trigger-management endpoints return 403 to guests and other REST endpoints reject guest tokens with 401. |
| GET | `/voice/triggers` | (registered user only; guest → 403) → `{triggers: VoiceTrigger[]}` containing only the caller's private personal triggers. |
| POST | `/voice/triggers` | (registered user only; guest → 403) `{phrase}` → `201 VoiceTrigger`; normalizes lowercase/trim/single spaces, requires 2..=80 normalized characters, duplicate → 409. |
| DELETE | `/voice/triggers/{id}` | (registered user only; guest → 403) → `204` for the caller's personal trigger; 404 when absent or owned by someone else. |
| GET | `/channels/{id}/voice-triggers` | (channel member; guest → 403) → `{triggers: VoiceTrigger[]}` shared by the channel/DM. |
| POST | `/channels/{id}/voice-triggers` | (channel owner/editor; either DM member; guest → 403) `{phrase}` → `201 VoiceTrigger`; same normalization/validation, duplicate → 409; emits `voice_trigger.created`. |
| DELETE | `/channels/{id}/voice-triggers/{trigger_id}` | (channel owner/editor; either DM member; guest → 403) → `204`, 404 when absent; emits `voice_trigger.deleted`. |
| GET | `/channels/{id}/gifs/suggest-voice` | (member-only) → `{query, results}` from recent buffered voice phrases; fewer than two phrases or shared channel cooldown returns 200 `{query: null, results: []}`; 503 when duck suggestions are disabled. Success resets only the voice phrase streak/armed state and broadcasts `voice.roast_armed {armed:false}`. |
| GET | `/channels/{id}/voice-link` | (Bearer auth, channel member) → `{"token": string \| null}` — the channel's current public voice-link token, or `null` if none exists. |
| POST | `/channels/{id}/voice-link` | (Bearer auth, channel owner/editor) → `{"token": string}` — generate a fresh 32-byte URL-safe token, **replacing** (revoking) any previous value. |
| POST | `/calls` | (Bearer auth) `{"title": string}` → `201 {"room_id", "token", "title"}`. Creates a standalone call with no channel/DM association. |
| GET | `/call-links/{token}` | (public, no auth) → `{"room_id": string, "room_kind": "public"\|"private"\|"dm"\|"standalone", "channel_name": string}`; `404` if unknown. For DMs the literal `"Call"` replaces the hidden name. |
| POST | `/call-links/{token}/join` | (public, no auth) body `{"name": string}` (trimmed, 1..=80 chars, else `422`) → `{"token": <guest JWT>, "channel_id": string, "user_id": string, "name": string}`; `404` for an unknown token. `user_id` is the minted guest subject UUID. |

## Public guest voice links

Channel owner/editors can create stable, revocable room links; `New meet` creates a
`standalone_calls` row with its own link. A signed-in visitor keeps their current JWT and
account identity when opening either link. An anonymous visitor enters a display name and
receives a limited guest JWT bound to that room — no chat, no other REST.

- **Link token**: stored on `channels.voice_link_token` (nullable `text`, unique when set —
  migration `0010_voice_link.sql`). `POST /channels/{id}/voice-link` overwrites it, so a
  previous link is instantly revoked. `GET` returns the current value.
- **Guest JWT**: minted by `POST /call-links/{token}/join`. Stateless, **12-hour** expiry,
  HS256 (same secret as user tokens). Claims: `sub` = a fresh random UUID (the guest's
  session identity / `user_id`), `guest: true`, `name`, `channel_id` (bound room), and
  `link` (the token used to join). User tokens omit `guest` (defaults to `false` on decode),
  so existing tokens keep working.
- **Guest restrictions**: most REST endpoints use `AuthUser`, which rejects tokens with
  `guest: true` (401). `/voice/config` and voice-trigger management use `VoiceConfigAuth` to
  distinguish both token kinds; config succeeds for guests while trigger management returns
  403. On the main WS, a guest may only send `ping`
  plus `voice.join`, `voice.leave`, `voice.mute`, `voice.camera`, `voice.screen`,
  `voice.hand`, and `voice.signal`, and only when the event's `channel_id` matches its bound
  channel. Member-only
  `voice.transcribe` and `voice.phrase`, plus all other events, are silently dropped. Guest
  connect/disconnect does **not** emit presence.
- **Revocation at join**: `voice.join` re-checks the guest token's `link` against the
  channel's current `voice_link_token`. If an owner/editor has regenerated (or the link was removed),
  the guest gets `voice.error` `code: "link_revoked"` and cannot join, even with an
  unexpired token. Guests count toward the normal `MAX_PARTICIPANTS` cap.

## Server configuration

- `STUN_URLS` — optional, comma-separated; default `stun:stun.l.google.com:19302`
- `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` — optional; TURN is offered only when all
  three are set

## Multi-replica behavior

The room registry, buffered transcript, phrase streak, armed state, and GIF cooldown are
per-replica and in memory; trigger vocabularies themselves are durable Postgres rows. Live
`voice.*` events converge across replicas through the existing Redis fanout in
`Hub::broadcast` (`sharp:events`). The cold `hello` snapshot and transcript used for a voice
suggestion are local-replica-only, the same documented limitation as presence.

## Huddle ring

When a client receives `voice.participant_joined` for a DM and is not itself a participant,
it shows a toast and plays a ring chime. Voice v1 has no accept/decline state machine.

## Desktop

The macOS Tauri build requires `NSMicrophoneUsageDescription` in `Info.plist` and the
`com.apple.security.device.audio-input` entitlement for existing audio. Browser camera is
the supported video target; Tauri camera behavior and Linux/Windows WebViews are unvalidated.

## Roadmap after v1

~~Files/uploads (S3/MinIO)~~ (shipped) → ~~notifications~~ (shipped) → ~~Phase 2 docs~~
(shipped: BlockNote+Yjs+yrs, in-binary) → ~~Phase 3 canvas~~ (shipped: tldraw on the same
doc/sync/permission foundation — see the Phase 3 section above) → ~~Phase 4 voice~~ (shipped:
WebRTC mesh — see the Phase 4 section) → ~~Phase 5 calendar~~ (shipped: Google Calendar pull
sync + native scheduled meetings — see the Phase 5 section below) → multi-workspace. Chat
stays append-only. (File uploads + notifications: see the section below.)

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
user_prefs(user_id uuid PK, dnd boolean NOT NULL default false,
  chat_layout text)                                  -- 'bubble'|'classic'; null = not chosen yet
push_subscriptions(id uuid PK, user_id uuid, endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL, auth text NOT NULL, created_at timestamptz)
expo_push_tokens(id uuid PK, user_id uuid REFERENCES users(id), token text UNIQUE NOT NULL,
  platform text NOT NULL DEFAULT 'ios', created_at timestamptz)
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
  actor: { id: string, display_name: string, avatar_url: string|null },
  channel_id: string, channel_kind: 'public'|'private'|'dm', channel_name: string,
  message_id: string|null, preview: string,
  created_at: string, read_at: string|null
}
ChatLayout = 'bubble' | 'classic'        // DM rendering: WhatsApp-style vs Slack-style rows
Prefs = { dnd: boolean, muted_channel_ids: string[], chat_layout: ChatLayout | null }
```

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| POST | `/channels/{id}/messages` | now also accepts `attachment_ids?: string[]`; content may be empty iff ≥1 attachment |
| POST | `/channels/{id}/uploads` | multipart `file` → `201 Attachment` (channel owner/editor; ≤ `MAX_UPLOAD_MB`) |
| GET | `/files/{id}?download=1` | streamed bytes (member only); `download=1` forces attachment disposition |
| GET | `/notifications?before=<id>&limit=30` | → `{notifications: Notification[], unread_count}` (newest first) |
| POST | `/notifications/read` | `{ids?: string[]}` or `{all: true}` → `204` |
| GET | `/prefs` | → `Prefs` |
| PUT | `/prefs/dnd` | `{dnd}` → `204` |
| PUT | `/prefs/chat-layout` | `{chat_layout: 'bubble'\|'classic'}` → `204` |
| PUT | `/channels/{id}/prefs` | `{muted}` → `204` |
| GET | `/push/vapid` | → `{public_key: string\|null}` |
| POST | `/push/subscribe` | `{endpoint, keys:{p256dh, auth}}` → `204` (upsert by endpoint) |
| POST | `/push/unsubscribe` | `{endpoint}` → `204` |
| POST | `/push/expo/register` | `{token, platform?: 'ios'}` → `204` (upsert by token) |
| POST | `/push/expo/unregister` | `{token}` → `204` |

Uploads and downloads are **always proxied through the server** (never presigned to the
browser) so channel-membership auth is enforced on every read. The web client fetches
attachments as blobs with the `Authorization` header.

## WebSocket event addition (existing `/api/v1/ws`)

- `notification.created` `{notification: Notification}` — to the recipient only.

## Notification semantics

Triggers, computed on message create:
- **dm** — any message in a `dm` channel notifies the other member(s).
- **mention** — `@Display Name` matching a channel member (longest match wins) notifies them.
  `@all` (word-boundary match, case-insensitive) notifies every other channel member with
  kind `mention`; not applicable in DMs. The composer suggests `@all` in the `@` picker
  after matching people (hidden in DMs).
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

### Mobile push (Expo)

Expo tokens from the native app are stored in `expo_push_tokens` and delivered through the
Expo Push API alongside web push. The same gate applies: muted channels create nothing;
the inbox row and WS event always happen; Expo/web push is only sent when the recipient is
offline and not in DND. `DeviceNotRegistered` tickets prune their token. `EXPO_ACCESS_TOKEN`
is an optional bearer-token environment variable for Expo projects that require it. The mobile
wire types in `mobile/src/lib/types.ts` are a copy of `web/src/lib/types.ts` and must be kept
in sync.

## Storage & push implementation

- **Storage**: `object_store` crate (feature `aws`) → one config targets AWS S3, MinIO,
  R2, B2. `server/src/storage.rs`. Object key = `channels/<channel_id>/<file_id>`.
- **Web push**: `web-push` crate (VAPID / RFC 8291, `hyper-client`). Keys resolve
  env → `app_meta` → auto-generated P-256 (`p256`) and persisted, so push works with zero
  config. Public key served at `/push/vapid`; dead subscriptions (404/410) are pruned.
- **Expo push**: `reqwest` sends batched native-device tickets to Expo; invalid-device tickets
  (`DeviceNotRegistered`) are pruned.

## Env additions

`S3_BUCKET` · `S3_ACCESS_KEY` · `S3_SECRET_KEY` (all three enable uploads) · `S3_ENDPOINT`
(optional; MinIO/R2) · `S3_REGION` (default `us-east-1`) · `S3_ALLOW_HTTP` (auto-on for
`http://` endpoints) · `MAX_UPLOAD_MB` (default 25) · `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
(optional; base64url — auto-generated if unset) · `VAPID_SUBJECT` (default
`mailto:admin@sharp.app`) · `EXPO_ACCESS_TOKEN` (optional). Dev/local/prod compose add a
`minio` service + bucket-init job.

---

# GIFs & duck suggestions

GIF search proxied through the server (provider API keys never reach the client), a GIF
picker in chat + docs, and an optional "duck": an LLM-powered (DeepSeek) suggester that
watches fast chat streaks and auto-picks a mean roast GIF to send.

## Providers & settings

- Provider abstraction in `server/src/gif.rs` (`GifProvider` trait). Implemented: **GIPHY**
  (default) and **Tenor v2** (legacy — Tenor accepts no new API clients since Jan 2026).
  Adding a provider = new impl + `resolve_provider` match arm.
- Settings persist in `app_meta` (no migration): `gif.provider` (default `giphy`),
  `gif.api_key`, `gif.duck_enabled` (default `true`), `gif.duck_cooldown_secs`
  (default `120`; allowed `30|60|120|300`), `gif.duck_context` (default `1m`;
  allowed `1m|2m|3m`). API key resolution: `app_meta` →
  provider-matching env fallback (`GIPHY_API_KEY` / `TENOR_API_KEY`).
- **Any authenticated user may read/update workspace settings** (channel roles do not apply;
  v1 has no workspace-admin role). The key is write-only: never echoed back by the API.
- Web UI: Settings → Workspace tab (provider select, API key, duck toggle, slow mode,
  context window, DeepSeek status, GIPHY hourly usage bar).
- **GIPHY rate limit**: server self-enforces a sliding **100 searches / hour** window
  (free-tier style). Each `/gifs/search` and duck-suggest provider search acquires one
  slot; at cap the API returns `429 rate_limited`. Usage is per-replica in-memory
  (`giphy_usage` on `AppState`) and exposed on settings as
  `giphy_usage: {used, limit, resets_at}` (`resets_at` = when the oldest call ages out,
  or `null` when unused).

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| GET | `/gifs/config` | → `{enabled, duck, provider, duck_cooldown_secs, duck_context}` — `enabled` = provider+key resolvable; `duck` = enabled ∧ DeepSeek configured ∧ `gif.duck_enabled` |
| GET | `/gifs/search?q=&limit=` | → `{results: [GifResult]}`; `q` required (400), `limit` 1..=30 default 24; 503 `unavailable` when unconfigured or upstream fails; 429 `rate_limited` when GIPHY hourly cap is hit |
| GET | `/gifs/settings` | → `{provider, has_api_key, duck_enabled, duck_cooldown_secs, duck_context, deepseek_configured, giphy_usage}` |
| PUT | `/gifs/settings` | `{provider?, api_key?, duck_enabled?, duck_cooldown_secs?, duck_context?}` → same as GET; provider ∈ `giphy\|tenor`; cooldown ∈ `30\|60\|120\|300`; context ∈ `1m\|2m\|3m`; `api_key: ""` clears, absent keeps |
| POST | `/channels/{id}/gif-suggest` | (member-only) → `{query, results}`; on cooldown returns 200 `{query: null, results: []}`; 503 when duck disabled; 429 when GIPHY cap is hit |

`giphy_usage = {used: u32, limit: u32, resets_at: string|null}` — `limit` is always `100`;
`resets_at` is an ISO-8601 timestamp for the first recovery moment in the sliding window.

`GifResult = {id, url, preview_url, width, height, title}` — `url` is the provider-CDN GIF
(hotlinked, nothing stored server-side).

## Durable meeting notes

- **Lifecycle**: first transcription opt-in creates one `meetings` row and snapshots the
  room's joined participants. Later joins/leaves create attendance intervals. The last leave
  finalizes the meeting; a heartbeat watchdog marks stale orphaned meetings `interrupted` at
  their last durable activity while preserving calls owned by another replica.
- **Attribution**: every accepted phrase uses the server-known participant for that WebSocket
  connection. This is source attribution, not acoustic voice biometrics. Raw transcript phrases
  are immutable and carry server timestamps.
- **Consent**: only opted-in connections contribute phrases. Opting out stops future phrases;
  attendance and meeting lifecycle continue. Guests may contribute but cannot use meeting REST.
  Once notes start, every other current or late-joining participant gets one non-blocking prompt
  to share their microphone transcript; accepting and declining are both respected for that meeting.
- **Notes**: on completion, configured DeepSeek generates summary, decisions, and structured
  actions asynchronously. Long transcripts are chunked. Missing configuration leaves the record
  usable with `summary_status=unavailable`; failures may be retried.
- **Access**: every REST operation verifies current channel membership. Members may list/search,
  read, edit title/summary/decisions/actions, regenerate notes, or permanently delete a record.
- **REST**: `GET /meetings`, `GET|PATCH|DELETE /meetings/:id`,
  `PUT /meetings/:id/actions`, `POST /meetings/:id/regenerate`.
- **Live events**: `meeting.started`, `meeting.phrase`, `meeting.ended`, and
  `meeting.summary_ready` update connected channel members without exposing saved records to guests.

## Message content token

A sent GIF is plain message content: `[[gif:<url>|<alt>]]` (alt = provider title, `|`/`]`
stripped). Duck-automation roast GIFs append `|duck`: `[[gif:<url>|<alt>|duck]]`, and
optionally embed the search query as a fourth field:
`[[gif:<url>|<alt>|duck|<query>]]` (`|`/`]` stripped from the query). Suggestion context
skips prior roasts (any `|duck` token) while the web client still renders them like
normal GIFs and shows `<query>` under the image on hover. Manual GIF sends stay unmarked.
The web client pre-splits content on this token **before**
react-markdown (remark-gfm would autolink the embedded URL) and renders an `<img>` linked
to the source; same family as the `[[doc:…]]`/`[[canvas:…]]` chips. Chat-only
(channels/DMs/threads); docs and canvas are not integrated.

## Duck flow

1. **Shared channel streak** (server, per-replica `AppState.duck_streaks`): every
   top-level non-GIF message from any owner/editor bumps the burst; gaps >20s reset.
   The new count rides `message.created` as `duck_streak: {count, last_at}` so
   every member's progress bar stays in sync.
2. Client progress bar fills with the shared count (more messages = more boost,
   saturates at 3+). Drains as the streak cools. At ≥3 messages with enough
   freshness the duck CTA appears (`drop a roast`).
3. Clicking the duck CTA → `POST /channels/{id}/gif-suggest` (cooldown from
   `gifConfig.duck_cooldown_secs`) → auto-sends the top GIF; server resets the
   shared streak and broadcasts `duck.streak` `{channel_id, duck_streak:{count:0,…}}`.
4. Server suggest: loads the last **1 / 2 / 3 minutes** of top-level messages
   (from `duck_context`, default 1m, up to 40), **excluding** prior duck-roast GIFs
   (`|duck` token); packages a punchline-focused transcript for DeepSeek; DeepSeek
   returns one **classic reaction-style** roast query (topic-grounded when a product/
   person is named); provider search fetches **10** results; server soft-ranks by
   title overlap + reaction hints vs watermark/spam penalties; if the top hit looks
   junk-heavy, regenerates the query **once**; DeepSeek then picks the best id from
   the top **6** ranked candidates (falls back to local rank #1). Response still
   returns a single GIF in `results`. Duck hidden when `/gifs/config.duck` is false.

## Env additions

`GIPHY_API_KEY` / `TENOR_API_KEY` (optional fallback when no key saved in settings) ·
`DEEPSEEK_API_KEY` (optional; duck disabled without it) · `DEEPSEEK_MODEL` (default
`deepseek-chat`) · `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`).

---

# Phase 5 — Calendar

Read-only Google Calendar pull sync plus native **scheduled meetings** that bind to a
channel/DM, a standalone call, or nothing (a pure calendar entry). A 5th mode-rail tab
(`calendar`) shows a merged agenda; a unified reminder pipeline fires lead + start
notifications for both Google events and native meetings.

**Namespacing (important):** this is entirely separate from the transcript `meetings`
feature (migration 0011, `routes::meetings`, `meeting.*` WS events). Everything here is
namespaced `calendar_*` / `scheduled_meetings`, `calendar.*` events, mode `'calendar'`,
module `routes/calendar.rs`. Never conflate the two.

## Principles

- **Read-only Google sync**: scope `openid email https://www.googleapis.com/auth/calendar.readonly` (openid+email feed the userinfo account-email lookup). sharp
  never writes to Google; native meetings live only in sharp.
- **Provider-ready**: `provider` column (`google` today) leaves room for Outlook/CalDAV.
- **Tokens encrypted at rest**: access/refresh tokens are sealed with AES-256-GCM under a key
  derived from `JWT_SECRET` (no new secret env). See "Google OAuth" below.
- **Reminder dedup via atomic claim**: per-row `reminded_lead_at` / `reminded_start_at` flags
  claimed with `UPDATE … WHERE reminded_x_at IS NULL RETURNING`. No reminders table;
  multi-replica safe (a row is delivered by exactly one replica).
- **Sync upserts never touch `reminded_*`** — otherwise a resync would re-arm a fired reminder.

## Database schema (migration `0016_calendar.sql`)

- `calendar_accounts` — one per connected Google account per user. `access_token_enc`,
  `refresh_token_enc` (nullable), `token_expires_at`, `scopes`, `status` (`active`/`invalid`),
  `last_synced_at`. `UNIQUE (user_id, provider, provider_email)`.
- `calendar_calendars` — a calendar within an account. `external_id`, `summary`, `color`,
  `is_primary`, `selected` (per-user toggle; sync upsert never overwrites it).
  `UNIQUE (account_id, external_id)`.
- `calendar_events` — synced events in the rolling window. `external_id`, `title`,
  `description`, `location`, `start_at`, `end_at`, `all_day`, `status`, `html_link`, `raw`
  (jsonb), `reminded_lead_at`, `reminded_start_at`. `UNIQUE (calendar_id, external_id)`.
- `scheduled_meetings` — native meetings. Optional `channel_id` **xor** `standalone_call_id`
  (or neither = pure calendar entry; enforced by `scheduled_meetings_context_check`).
  `creator_id`, `title`, `description`, `start_at`, `end_at`, `all_day`, `status`
  (`scheduled`/`cancelled`), `card_message_id` (→ chat card, `ON DELETE SET NULL`),
  `reminded_lead_at`, `reminded_start_at`.
- `scheduled_meeting_attendees` — `(meeting_id, user_id)` PK, `response`
  (`needs_action`/`accepted`/`declined`/`tentative`).

## Wire types

```ts
CalendarConnection = { id; provider:'google'; provider_email; status:'active'|'invalid';
  last_synced_at: string|null; calendars: CalendarCalendar[] }
CalendarCalendar = { id; external_id; summary; color: string|null; is_primary; selected }
ScheduledMeeting = { id; channel_id: string|null; standalone_call_id: string|null;
  creator: { id; display_name; avatar_url: string|null };
  title; description; start_at; end_at; all_day; status:'scheduled'|'cancelled';
  join_path: string|null;                       // server-computed, see below
  attendees: { user_id; display_name; response }[]; my_response: string|null }
CalendarItem =
  | { source:'google'; id; calendar_id; title; description: string|null; location: string|null;
      start_at; end_at; all_day; html_link: string|null; color: string|null }
  | { source:'native'; id; title; start_at; end_at; all_day; join_path: string|null;
      meeting: ScheduledMeeting }
```

**`join_path`** (computed server-side): channel meeting → `/c/{channel_id}`; standalone →
`/call/{link_token}`; pure calendar entry → `null`.

## REST API (`/api/v1`, `AuthUser` unless noted)

| Method | Path | Behavior |
|---|---|---|
| GET | `/calendar/connections` | `{connections}` with nested calendars |
| GET | `/calendar/google/connect` | `{url}` (503 `unavailable` if Google unconfigured) |
| GET | `/calendar/google/callback?code=&state=` | **no auth** — verify state JWT → exchange → store encrypted tokens → kick initial sync → 302 `/calendar?connected=1` (self-contained HTML page when the SPA isn't served from this binary) |
| DELETE | `/calendar/connections/{id}` | 204; cascades calendars + events |
| PATCH | `/calendar/calendars/{id}` | `{selected}` → 204 |
| POST | `/calendar/sync` | 202; fire-and-forget refresh of the caller's active accounts |
| GET | `/calendar/events?from=&to=` | → `{ events: CalendarItem[] }` — merged Google (selected calendars) ∪ native meetings the caller attends, ascending; window defaults now−30d … now+90d |
| POST | `/calendar/meetings` | `{title, description?, start_at, end_at, all_day?, channel_id?, standalone_call_id?, attendee_ids?, post_card?}` → 201 `ScheduledMeeting`. Default attendees = channel members; creator always attends (auto-accepts). `post_card` + channel → posts a `[[meet:…]]` chat card |
| GET | `/calendar/meetings/{id}` | creator/attendee only |
| PATCH | `/calendar/meetings/{id}` | creator only; body `{title?, description?, start_at?, end_at?, all_day?, attendee_ids?}` → `ScheduledMeeting`. A start/end change resets `reminded_*` to NULL. `attendee_ids`, when present, is the FULL replacement attendee set (creator always kept, deduped): kept attendees preserve their RSVP, new ones start at the default response, removed ones' rows are deleted. Broadcasts `calendar.meeting_updated` to the current attendees; removed attendees additionally get a `calendar.meeting_cancelled` (same `{meeting_id}` payload as DELETE) so their stale calendar item drops |
| DELETE | `/calendar/meetings/{id}` | creator only; soft `status='cancelled'` |
| POST | `/calendar/meetings/{id}/rsvp` | attendee only; `{response}` → 204 |

**Chat card**: with `post_card` + a channel context, the meeting posts a message
`[[meet:<uuid>|<title>|<start_iso>]]` via the internal `routes::messages::post_message_as`
helper (identical `message.created` broadcast + `notify::dispatch_message` behavior) and
stores its id in `card_message_id`. `notify::strip_resource_tokens` humanizes the token to
`📅 <title>` in notification previews.

## WS events

- `calendar.meeting_created` / `calendar.meeting_updated` — `{meeting}` (fanned out
  per-attendee so each recipient's `my_response` is correct).
- `calendar.meeting_cancelled` — `{meeting_id}` to attendees (also sent to attendees removed via a PATCH `attendee_ids` replacement).
- `calendar.synced` — `{account_id, last_synced_at}` to the account owner.
- `calendar.reminder` — `{kind:'lead'|'start', title, start_at, join_path, source:'google'|'native', ref_id}`
  to the recipient (online toast + OS notification client-side).

## Background loops (`main.rs`, copying the meeting-heartbeat spawn pattern)

- **Reminder scheduler** (30s tick, `calendar_sync::reminder_tick`): four atomic claim
  `UPDATE … RETURNING` queries — lead (`start_at` in the next 10 min) and start (`start_at`
  just passed) over both `scheduled_meetings` (status `scheduled`) and `calendar_events`
  (join to account for the owner; only `selected` calendars, `active` accounts, `confirmed`
  events). Native rows fan out to attendees; Google rows go to the account owner. Each claimed
  row → WS `calendar.reminder` + `notify::push_event` (offline web push, self-guards
  online/DND). The "start" claims carry a lower time bound (`> now() - 10 min`) so the Google
  −30d sync window can't back-fill a blast of stale reminders. Reminders do **not** write
  `notifications` inbox rows (the schema needs actor/message ids Google events lack).
- **Google sync poller** (5-min tick, `calendar_sync::poll_active_accounts`): iterate
  `calendar_accounts WHERE status='active'`, `sync_account` each; `invalid_grant` on refresh
  flips `status='invalid'`. The whole loop is gated on `config.google.is_some()`.

## Google OAuth

Authorization-code flow, confidential client. The self-hoster supplies their own Google Cloud
OAuth client via env. Flow (`google_oauth.rs`, hand-rolled reqwest + serde — not the
`google-calendar3` crate):

1. `GET /calendar/google/connect` mints a **short-lived (10 min) HS256 state JWT**
   `{sub:user_id, purpose:"cal_oauth"}` signed with `JWT_SECRET` (stateless, multi-replica
   safe), and returns the consent URL: `response_type=code`,
   `scope=openid email …/auth/calendar.readonly`, `access_type=offline`, `prompt=consent`,
   `include_granted_scopes=true`.
2. The callback verifies the state JWT, exchanges the code at
   `https://oauth2.googleapis.com/token`, fetches the account email from the userinfo endpoint,
   and upserts `calendar_accounts` (keeping the stored refresh token when the exchange omits
   one).
3. Rolling-window sync (`calendar_sync.rs`): `calendarList.list` → upsert calendars, then per
   selected calendar `events.list?singleEvents=true&orderBy=startTime&timeMin=now-30d&timeMax=now+90d`,
   paginating `nextPageToken`; upsert events (`ON CONFLICT` excludes `reminded_*`), delete
   rows that vanished from the window or were cancelled.

**Token encryption**: `calendar_crypto.rs` derives a 32-byte key via HKDF-SHA256 over
`JWT_SECRET` (info `sharp-calendar-token-v1`), then AES-256-GCM seals each token with a fresh
random 12-byte nonce; the stored value is `base64(nonce ‖ ciphertext)`. No new secret env.

**`invalid_grant`**: a dead/expired/revoked refresh token flips the connection to
`status='invalid'`; the UI prompts a reconnect.

**Testing-mode 7-day caveat**: while the Google consent screen is in "Testing", refresh
tokens **expire after 7 days**. Publish the OAuth app to production (or use "Internal" for a
Workspace org) to keep them alive. Document/warn accordingly.

**Redirect-URI exact match**: `GOOGLE_REDIRECT_URI` must byte-for-byte match a redirect
registered on the OAuth client and point at the **API** origin, e.g.
`https://<app-domain>/api/v1/calendar/google/callback` (dev:
`http://localhost:3000/api/v1/calendar/google/callback`). In split deploys it targets the API
subdomain, not the SPA.

## Env additions

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (both required to enable Google Calendar) ·
`GOOGLE_REDIRECT_URI` (required alongside them; exact-match, API origin). All unset → calendar
connections disabled (native scheduled meetings still work).
