# File uploads (S3-compatible) & Notifications

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> S3 file uploads, the notification inbox, the three push transports, and appearance + privacy preferences.

Two post-v1 features that share the single binary. Files live in S3-compatible object
storage; notifications are ordinary append-only Postgres rows fanned out over the existing
WS hub, plus web push for offline recipients.

## Database schema (migrations `0004_notifications.sql`, `0005_files.sql`)

```sql
files(
  id uuid PK default gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until attached
  doc_id uuid REFERENCES docs(id) ON DELETE CASCADE,             -- doc image; migration 0020
  user_id uuid NOT NULL REFERENCES users(id),                   -- uploader
  key text NOT NULL,                    -- object key: channels/<channel_id>/<file_id>
  filename text NOT NULL, content_type text NOT NULL, size bigint NOT NULL,
  created_at timestamptz NOT NULL default now()
)
-- indexes: (message_id); (channel_id, user_id) WHERE message_id IS NULL

notifications(
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- recipient
  kind text NOT NULL CHECK (kind IN ('mention','dm','reply','poll_ended')),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  preview text NOT NULL default '', created_at timestamptz NOT NULL default now(),
  read_at timestamptz
)
-- indexes: (user_id, id DESC); (user_id) WHERE read_at IS NULL

channel_prefs(user_id uuid, channel_id uuid, muted boolean NOT NULL default false,
  mode text NOT NULL default 'all' CHECK (mode IN ('all','mentions','muted')),  -- 0026; muted kept in sync
  wallpaper jsonb,                                   -- 0030; per-viewer chat wallpaper, opaque to the server
  PRIMARY KEY (user_id, channel_id))                 -- absence = mode 'all'
user_prefs(user_id uuid PK, dnd boolean NOT NULL default false,
  chat_layout text,                                  -- 'bubble'|'classic'; null = not chosen yet
  -- migration 0026: per-type toggles + scheduled DND (quiet hours)
  notify_dm boolean NOT NULL default true, notify_mention boolean NOT NULL default true,
  notify_reply boolean NOT NULL default true, notify_task boolean NOT NULL default true,
  notify_poll boolean NOT NULL default true, dnd_scheduled boolean NOT NULL default false,
  dnd_start integer, dnd_end integer,                -- minutes-of-day, user-local; may wrap midnight
  tz_offset integer NOT NULL default 0,              -- minutes east of UTC
  -- migration 0029: opaque client-owned appearance blob (theme, scheme, accent
  -- hue, density, interface scale, motion, rail, sounds). No schema, no CHECK —
  -- the shape lives in web/src/lib/uiPrefs.ts so a new preference costs no migration.
  ui jsonb NOT NULL default '{}'::jsonb,
  -- migration 0031: privacy switches the *server* enforces (not in the ui blob,
  -- which is opaque to it by contract).
  invisible boolean NOT NULL default false,       -- filtered out of disclosed presence
  share_typing boolean NOT NULL default true,     -- one-way: stop sending, keep receiving
  push_preview text NOT NULL default 'full'       -- 'generic' = content-free push
      CHECK (push_preview IN ('full','generic')))
push_subscriptions(id uuid PK, user_id uuid, endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL, auth text NOT NULL, created_at timestamptz)
expo_push_tokens(id uuid PK, user_id uuid REFERENCES users(id), token text UNIQUE NOT NULL,
  platform text NOT NULL DEFAULT 'ios', created_at timestamptz)
apns_tokens(id uuid PK, user_id uuid REFERENCES users(id), token text UNIQUE NOT NULL,
  platform text NOT NULL DEFAULT 'macos', created_at timestamptz)  -- migration 0027; native macOS push
app_meta(key text PK, value text NOT NULL)           -- e.g. auto-generated VAPID keys
```

## Wire types

Message ids and notification ids are `bigint` → **serialized as strings** (JS safety).

```ts
Attachment = { id: string, filename: string, content_type: string, size: number,
               url: string }              // url = proxied path "/api/v1/files/<id>"
Message = { …, attachments: Attachment[] }  // added to the existing Message shape

NotificationKind = 'mention'|'dm'|'reply'|'poll_ended'|'task_assigned'|'task_comment'
Notification = {
  id: string, kind: NotificationKind,
  actor: { id: string, display_name: string, avatar_url: string|null },
  channel_id: string|null, channel_kind: 'public'|'private'|'dm'|null, channel_name: string|null,
  message_id: string|null, task_id: string|null, task_identifier: string|null,
  preview: string, created_at: string, read_at: string|null
}
ChatLayout = 'bubble' | 'classic'        // DM rendering: WhatsApp-style vs Slack-style rows
ChannelNotifyMode = 'all' | 'mentions' | 'muted'
Prefs = {
  dnd: boolean, muted_channel_ids: string[],         // muted_channel_ids = channels with mode 'muted'
  channel_modes: Record<string, ChannelNotifyMode>,  // per-channel override
  chat_layout: ChatLayout | null,
  notify_dm: boolean, notify_mention: boolean, notify_reply: boolean,
  notify_task: boolean, notify_poll: boolean,        // per-type master switches (default on)
  dnd_scheduled: boolean,                             // quiet-hours enabled
  dnd_start: number|null, dnd_end: number|null,       // minutes-of-day, user-local; may wrap midnight
  tz_offset: number                                   // minutes east of UTC (client-supplied)
}
PrefsUpdate = Partial<Pick<Prefs, notify_*|dnd_scheduled|dnd_start|dnd_end|tz_offset>>
```

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| POST | `/channels/{id}/messages` | now also accepts `attachment_ids?: string[]`; content may be empty iff ≥1 attachment |
| POST | `/channels/{id}/uploads` | multipart `file` → `201 Attachment` (channel owner/editor; ≤ `MAX_UPLOAD_MB`) |
| POST | `/docs/{id}/uploads` | multipart `file` → `201 Attachment` (doc editor/owner; active `kind:'doc'` only; PNG/JPEG/GIF/WebP/AVIF signature required; ≤ `MAX_UPLOAD_MB`) |
| GET | `/files/{id}?download=1` | streamed bytes (message file: channel member; doc image: visible doc role); `download=1` forces attachment disposition |
| GET | `/notifications?before=<id>&limit=30` | → `{notifications: Notification[], unread_count}` (newest first) |
| POST | `/notifications/read` | `{ids?: string[]}` or `{all: true}` → `204` |
| GET | `/prefs` | → `Prefs` |
| PUT | `/prefs` | `PrefsUpdate` → `204` (per-type toggles + scheduled DND; omitted fields unchanged) |
| PUT | `/prefs/dnd` | `{dnd}` → `204` |
| PUT | `/prefs/chat-layout` | `{chat_layout: 'bubble'\|'classic'}` → `204` |
| PUT | `/prefs` | also accepts `invisible`, `share_typing`, `push_preview` (0031) |
| PATCH | `/prefs/ui` | JSON object → merged `ui` object (shallow top-level merge; ≤ 8 KB; non-object → 400; also emits `prefs.updated` to the caller's own sessions) |
| PUT | `/channels/{id}/prefs` | `{mode: 'all'\|'mentions'\|'muted'}` (or legacy `{muted}`), and/or `{wallpaper: object\|null}` (≤ 2 KB; each field is independent — sending one never resets the other) → `204` |
| GET | `/push/vapid` | → `{public_key: string\|null}` |
| POST | `/push/subscribe` | `{endpoint, keys:{p256dh, auth}}` → `204` (upsert by endpoint) |
| POST | `/push/unsubscribe` | `{endpoint}` → `204` |
| POST | `/push/expo/register` | `{token, platform?: 'ios'}` → `204` (upsert by token) |
| POST | `/push/expo/unregister` | `{token}` → `204` |
| POST | `/push/apns/register` | `{token}` → `204` (hex APNs device token, upsert; native macOS desktop) |
| POST | `/push/apns/unregister` | `{token}` → `204` |

Uploads and downloads are **always proxied through the server** (never presigned to the
browser) so channel-membership auth is enforced on every read. The web client fetches
attachments as blobs with the `Authorization` header.

## WebSocket event addition (existing `/api/v1/ws`)

- `notification.created` `{notification: Notification}` — to the recipient only.
- `prefs.updated` `{ui: object}` — emitted by `PATCH /prefs/ui` to the caller's **own**
  user id, i.e. all their other tabs and devices. The payload is the fully merged blob,
  so applying it is idempotent and the originating tab needs no echo suppression.
- `app.visibility` `{visible: boolean}` — sent on connect, visibility changes, page show,
  and page hide. Visible connection ids are refreshed in Redis (`sharp:visible:<user_id>`)
  with an expiry, so every server replica shares the foreground-delivery decision.

## Appearance (theme, density, motion)

Every appearance preference lives in one place: `user_prefs.ui` (jsonb, migration 0029),
edited with `PATCH /prefs/ui`. The server never interprets the blob — the shape, the
defaults, and the validation all live in `web/src/lib/uiPrefs.ts` (`UiPrefs`,
`normalizeUiPrefs`), so adding a preference needs no migration and no endpoint.

- **Two tiers.** `localStorage['sharp.ui']` is a *mirror*, read by the inline boot script
  in `web/index.html` so the first paint is already themed. `user_prefs.ui` is the
  *truth*: it arrives with `loadInboxAndPrefs()` and replaces the mirror wholesale — no
  merge, no clock comparison. `store.patchUi()` applies optimistically and rolls back on
  failure; `prefs.updated` keeps other devices in step.
- **Merge semantics.** `PATCH /prefs/ui` does a top-level `jsonb ||` merge, so a nested
  object (`sounds`) replaces the stored one wholesale — always send it complete.
  Payloads over 8 KB, and anything that is not a JSON object, are rejected.
- **Palettes are static CSS.** Each preset is one `:root[data-theme='<id>']` block in
  `web/src/themes.css` declaring only the **core eleven** tokens (5 surfaces, 3 accent,
  3 text). Semantic tones and the board palette are scheme-wide: the dark set lives in
  `index.css` `@theme`, and one `:root[data-scheme='light']` block in `themes.css`
  overrides them for every light preset. Code/scrollbar/kbd/presence tokens are
  `color-mix()` derivations of the core eleven, so they retint for free.
- **Continuous knobs are runtime CSS.** `applyUiPrefs()` (`web/src/lib/theme.ts`) writes a
  single `<style id="sharp-ui">` block holding `--font-scale`, `--motion-scale`, the
  `--density-*` set, and — when `accentHue` is set — an OKLCH-derived accent ramp at fixed
  lightness/chroma so a user-picked hue can never become unreadable. `--motion-snap` and
  `--motion-smooth` are `calc()`-scaled by `--motion-scale`, which is how one slider (0 =
  still) reaches every transition without touching a component.
- **Scheme.** `scheme: 'dark'|'light'|'system'` picks between `theme` and `themeLight`;
  `system` follows `prefers-color-scheme` live via `watchSystemScheme`. The resolved
  scheme is published as `data-scheme` plus an inline `color-scheme`.
- Adding a preset = a block in `themes.css` + an entry in `THEMES` (`lib/theme.ts`). The
  `/design` gallery's token audit swaps each preset onto `documentElement` and reports any
  token that fails to resolve or never moves off the default palette.

### Chat style, effects, and Focus mode

Also in the `ui` blob, all applied client-side:

- **Layout** is per surface. DMs keep their pick in `user_prefs.chat_layout` (the first-run
  chooser gates on it being `null`); channels read `ui.channelLayout`, with
  `ui.channelLayoutOverrides[channelId]` winning. Three shapes: `classic`, `bubble`, and
  `irc` (one line — fixed time and author columns, sharing the classic body column).
- **Density, avatar shape, grouping window, timestamp style, and author name colours** are
  all preferences; `MessageItem` reads them rather than hard-coding. Grouping at 0 minutes
  disables it entirely.
- **Effects** (`glass`, `grain`, `glow`, `scanlines`) publish as a `data-fx` token list on
  `<html>`; the CSS lives in `index.css` and deliberately targets the generated Tailwind
  utility classes (`.bg-panel`, `.bg-accent`) so one rule reaches every surface.
- **Sound packs** re-tune the existing synthesis engine rather than shipping assets: a pack
  is a transform (waveform, pitch, decay, gain, chorus) applied at `envGain` and `tone` in
  `lib/sound.ts`, so all 28 sounds keep their melody and timing.
- **Celebrations** (`lib/celebrate.ts`) fire on a task entering a `completed`-*type* state
  and on a poll closing — both detected in the WS reducer by comparing against prior state.
- **Focus mode** is the master kill switch for effects, wallpapers, and celebrations. The
  streaming privacy shield borrows it via `applyUiPrefs(prefs, focusOverride)` without
  writing the stored preference, so the user's own setting returns when the stream ends.
- **Wallpapers** are per-viewer, per-channel (`channel_prefs.wallpaper`, migration 0030) and
  procedural only — a solid hue or a seeded gradient mesh built from theme tokens, so a
  wallpaper retints with the active preset. Image uploads are intentionally unsupported:
  they would add a second source of orphaned files (see `docs/LEFTOVERS.md`).

## Privacy (Phase 4)

Three of these are server-enforced columns on `user_prefs` (migration 0031) rather
than keys in the opaque `ui` blob, because the server is what has to honour them:

- **`invisible`** — `GET /users` and the WS `presence` announce filter the caller out
  of the disclosed online set. The connection itself is untouched, so their own
  realtime keeps working. No `online` is announced, so no `offline` is either —
  an unpaired offline event would out them as having been connected.
- **`share_typing`** — `ws/session.rs` drops the `typing` relay at the source.
- **`push_preview: 'generic'`** — resolved once in `notify.rs` and applied to *every*
  transport (web push via `push::send_generic`, APNs, Expo). Routing ids survive so
  the tap still lands in the right place; the readable fields carry nothing.

Client-side, `Settings → Privacy` gathers these with pointers to the streaming shield,
encryption, and passkeys. A panic lock (`⌘⇧L`, plus an optional idle timeout in
`ui.idleLockMin`) covers the screen — `ScreenLock` is explicit that this hides the
screen from the room and is *not* re-authentication.

**Ephemeral messages** (migration 0033): `channels.message_ttl_minutes` sets the rule and
`messages.expires_at` is stamped at insert from it, so changing the TTL never reaches back
into history. A 30s sweep (`routes::messages::expire_tick`) soft-deletes due messages the
same way a manual delete does — `deleted_at` set, content blanked, embedding dropped,
`message.deleted` broadcast — so no client needs new code. Batched at 200 per tick.

**Sharpy exclusion** (migration 0032): `channels.ai_excluded` is enforced in three places —
the embed worker skips those channels, retrieval joins them out, and switching it on calls
`purge_channel_embeddings` so the opt-out is retroactive rather than forward-only.

**Seasonal packs** (`web/src/lib/seasonal.ts`) are pure data: a month/day window (which may
wrap the year), an accent hue, a particle effect, a reaction set, and a greeting. Governance
is three-level — the user's `ui.seasonal` (`off`/`subtle`/**`subtle` default**/`full`), with
Focus mode and `prefers-reduced-motion` forcing off regardless. `subtle` retints the accent
and swaps the reaction row; only `full` renders `SeasonalLayer`, a single
`pointer-events:none` canvas whose rAF loop stops while the tab is hidden. A user-chosen
`accentHue` always beats a pack's.

**Preview override** ("Try it now" in Settings → Appearance): `setPackPreview(id)` pins one
pack regardless of the date, persisted in `sharp.seasonPreview` (device-local, deliberately
**not** in the synced blob — a preview is not a preference). `activePack(now, preview)` takes
it as a parameter defaulting to the stored value, so it beats the calendar and nothing else:
intensity, Focus mode, reduced motion and an explicit `accentHue` all still win. The store
mirrors it as `seasonPreview` and `setSeasonPreview` re-runs `applyUiPrefs`, so the accent,
`data-season`, the particle layer and the reaction row all switch live; the components that
render a pack subscribe to that field rather than reading the module value.

## Notification semantics

Triggers, computed on message create:
- **dm** — any message in a `dm` channel notifies the other member(s).
- **mention** — `@Display Name` matching a channel member (longest match wins) notifies them.
  Also matches personal nicknames the **author** has set for those members (`user_nicknames`).
  `@all` (word-boundary match, case-insensitive) notifies every other channel member with
  kind `mention`; not applicable in DMs. The composer suggests `@all` in the `@` picker
  after matching people (hidden in DMs).
- **reply** — a thread reply notifies the parent message's author.
Author is never notified; within a normal channel a mention supersedes a reply for the
same user.

Controls (all enforced server-side in `notify.rs`; the client mirrors DND for toast/sound):
- **Per-channel mode** (`channel_prefs.mode`, default `all`) — `muted` creates no row for
  that channel; `mentions` allows only `mention`/`reply` there; `all` is unrestricted. The
  legacy `muted` boolean is kept in sync (`muted` = mode `muted`) for older reads.
- **Per-type master switch** (`user_prefs.notify_{dm,mention,reply,task,poll}`, default on) —
  a disabled type produces **no notification at all** (no inbox row, no push), like a mute.
  `task` covers both `task_assigned` and `task_comment`.
- **Do Not Disturb** — the manual `dnd` toggle, or an active **scheduled** window
  (`dnd_scheduled` + `dnd_start`/`dnd_end` minutes-of-day in the user's local time via
  `tz_offset`, wrap-aware past midnight). While DND is active the inbox row +
  `notification.created` still happen (bell updates) but **push is suppressed**, and the
  client suppresses toasts / OS popups / sound.
- The client also suppresses the toast/OS popup when the message's channel is already
  open in a focused window.
- All of the above are managed from **Settings → Notifications** (device enable/disable,
  sound, DND mode + quiet hours, per-type toggles, per-channel mode).

Delivery: in-app inbox (bell + dropdown) + arrival toast; OS notification when the app is
open but unfocused (Web Notification API, or `tauri-plugin-notifications` in the desktop
shell); **web push** (service worker `web/public/sw.js`) when the tab is closed and the
recipient has no visible web session on any replica. A hidden tab may keep its WebSocket;
the service worker still receives the VAPID push. iOS/iPadOS setup is offered only from an
installed Home Screen PWA and notification permission is requested directly from the user's
Enable action. Logout unregisters that device's subscription.

### Native macOS push (APNs)

The Tauri desktop shell registers for APNs so it receives push **while closed**, not only
while running. `web/src/lib/apns.ts` calls the `tauri-plugin-notifications` push API on
launch, gets the hex device token, and POSTs it to `/push/apns/register` (stored in
`apns_tokens`). The server (`server/src/apns.rs`) signs a token-based ES256 provider JWT
from the `.p8` key (cached ~50 min per Apple's 20–60 min rule) and POSTs to
`api.push.apple.com` (or the sandbox host); dead tokens (410 / `BadDeviceToken`) are pruned.
APNs delivery shares the web-push gate — sent only when the recipient has **no visible
session**. Configured via `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_PRIVATE_KEY` (or
`APNS_PRIVATE_KEY_PATH`) / `APNS_BUNDLE_ID` / `APNS_ENV`; the whole channel is **inert**
unless all are set (mirrors VAPID/Expo). **Requires a signed + notarized build** whose App
ID has the Push Notifications capability and whose entitlements include
`com.apple.developer.aps-environment` — client registration fails on unsigned/ad-hoc builds,
which then fall back silently to the WebSocket + local-notification + web-push paths.

### Mobile push (Expo)

Expo tokens from the native app are stored in `expo_push_tokens` and delivered through the
Expo Push API alongside web push. The same gate applies: muted channels create nothing;
the inbox row and WS event always happen; Expo push is sent while the recipient is offline,
web push while no web session is visible, and neither is sent in DND. `DeviceNotRegistered`
tickets prune their token. `EXPO_ACCESS_TOKEN`
is an optional bearer-token environment variable for Expo projects that require it. The mobile
wire types in `mobile/src/lib/types.ts` are a copy of `web/src/lib/types.ts` and must be kept
in sync.

## Storage & push implementation

- **Storage**: `object_store` crate (feature `aws`) → one config targets AWS S3, MinIO,
  R2, B2. `server/src/storage.rs`. Message object key =
  `channels/<channel_id>/<file_id>`; doc image key = `docs/<doc_id>/<file_id>`.
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

