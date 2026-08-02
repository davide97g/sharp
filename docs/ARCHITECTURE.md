# sharp — Architecture & API Contract

sharp is a self-hostable Slack replacement: chat, collaborative docs/canvas/boards, LiveKit
voice & video, a calendar, flexible idea boards, and an AI assistant — one Rust binary serving the
API plus the built React SPA.

**This file is the index.** The contract itself lives in [`docs/arch/`](arch/), split by feature.
Read the invariants below, then open only the file for the surface you are changing.

---

## Read this before changing anything

These hold across every feature. Breaking one compiles fine and fails in production.

1. **The contract is normative, not descriptive.** `docs/arch/*` defines the wire format that
   server, web, and desktop are each built against independently. Change code and doc in the
   same commit, or the next reader trusts the wrong one.
2. **Message IDs are Postgres `bigint`, serialized as JSON strings.** Never a JS number — past
   2^53 the client corrupts them silently. `server/src/models.rs` and `web/src/lib/types.ts`
   mirror each other. Channel, user, and doc IDs are UUIDs.
3. **No `sqlx::query!` macros — runtime queries only.** Deliberate: compilation must not need a
   live `DATABASE_URL`. `cargo check` is the fast gate precisely because of this.
4. **Every mutation that changes visible state must emit its WebSocket event.** There is no
   reconciliation poll: a missing broadcast means clients silently desync until reload. The
   event lists in `docs/arch/*` are the authority; `server/src/ws/` sends, and
   `web/src/lib/wsEvents.ts` applies.
5. **Single workspace.** No tenancy column, no workspace scoping. The schema keeps it addable;
   nothing in the code assumes it exists.
6. **Threads are one level deep.** A message with `parent_id` can never itself be a parent.
7. **Deletes are soft** — `deleted_at` set, `content` blanked, row kept so thread and reply
   references survive.
8. **Unread counts count top-level messages only** — thread replies never bump a channel badge.
9. **Optional features are inert, not broken, when unconfigured.** Every integration
   (S3, LiveKit, AI, GIFs, Google, GitHub, email, push, passkeys) resolves to `Option<T>` in
   `server/src/config.rs` and the whole feature disappears from the UI. Never make an
   unconfigured integration a hard startup failure. `deploy/.env.example` is the canonical
   list of every variable and what goes inert without it.
10. **Never leak content past its ACL.** Retrieval for Sharpy re-checks channel membership and
    doc roles per request; encrypted DMs are never embedded, never readable server-side.
11. **UI is built from `web/src/ui/` primitives** — see [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).
    No hand-rolled class recipes, no hard-coded hex (theme presets break).

## Where do I change what

| Surface | Server | Web | Contract |
|---|---|---|---|
| Auth, sessions, password reset, passkeys | `auth.rs`, `passkeys.rs`, `mailer.rs`, `desktop_auth.html` | `components/Login.tsx`, `ResetPassword.tsx`, `lib/desktopAuth.ts` | [01-core](arch/01-core.md) |
| Social sign-in (Google, GitHub) | `social_oauth.rs` (protocol), `routes/social_auth.rs` (policy) | `components/OauthCallback.tsx`, `components/auth/ProviderMark.tsx`, `settings/AccountsTab.tsx` | [01-core](arch/01-core.md) |
| Channels, members, roles | `routes/channels.rs` | `components/Sidebar.tsx`, `ChannelSettingsModal.tsx` | [01-core](arch/01-core.md) |
| Messages, threads, reactions, search | `routes/messages.rs`, `routes/search.rs` | `components/MessagePane.tsx`, `MessageItem.tsx`, `Composer.tsx` | [01-core](arch/01-core.md) |
| Link previews (unfurls) | `unfurl.rs`, `routes/unfurl.rs` (image proxy + on-demand resolve) | `components/LinkPreview.tsx`, `lib/linkUrls.ts` | [01-core](arch/01-core.md) |
| Home screen: resume rail + "what moved" board | — (reads `/docs/recent`, `/calendar/events`; everything else is already-loaded store state) | `components/Home.tsx`, `components/home/`, `lib/recents.ts` | [01-core](arch/01-core.md) |
| Realtime fanout, presence, typing | `ws/mod.rs`, `ws/session.rs` | `lib/ws.ts`, `lib/wsEvents.ts` | [01-core](arch/01-core.md) |
| Docs (BlockNote/Yjs) | `routes/docs.rs`, `docs_sync.rs` | `components/docs/`, `lib/docSync.ts` | [02-docs](arch/02-docs.md) |
| Canvas, Boards | same as docs (`kind` column) | `components/canvas/`, `components/board/`, `lib/excalidrawYjs.ts`, `lib/boardDoc.ts` | [03-canvas-board](arch/03-canvas-board.md) |
| Voice, video, screen share, call links | `ws/voice/`, `routes/voice.rs`, `routes/call_links.rs`, `livekit.rs` | `components/voice/`, `lib/voice.ts`, `lib/pip.ts` | [04-voice](arch/04-voice.md) |
| Garden focus space | `routes/garden.rs` | `components/garden/`, `lib/garden/terrain.ts`, `store.ts` | [12-garden](arch/12-garden.md) |
| File uploads | `routes/files.rs`, `storage.rs` | `components/Composer.tsx`, `lib/api.ts` | [05-files-notifications](arch/05-files-notifications.md) |
| Notification inbox | `routes/notifications.rs`, `notify.rs` | `components/NotificationCenter.tsx` | [05-files-notifications](arch/05-files-notifications.md) |
| Notification prefs, DND, appearance, privacy | `routes/prefs.rs`, `privacy.rs` | `components/settings/`, `lib/uiPrefs.ts`, `lib/theme.ts`, `lib/localPrefs.ts` | [05-files-notifications](arch/05-files-notifications.md) |
| Push transports (web, APNs, Expo) | `routes/push.rs`, `vapid.rs`, `apns.rs`, `expo_push.rs` | `public/sw.js`, `lib/notify.ts`, `lib/apns.ts` | [05-files-notifications](arch/05-files-notifications.md) |
| GIFs, duck roasts | `routes/gifs.rs`, `gif.rs`, `deepseek.rs` | `components/GifPicker.tsx` | [06-gifs](arch/06-gifs.md) |
| Calendar, meetings | `routes/calendar.rs`, `routes/meetings.rs`, `calendar_sync.rs`, `google_oauth.rs` | `components/calendar/`, `components/meetings/` | [07-calendar](arch/07-calendar.md) |
| Polls | `routes/polls.rs`, `ws/voice/polls.rs` | `components/PollView.tsx`, `CreatePollModal.tsx` | [08-polls](arch/08-polls.md) |
| E2EE DMs | `routes/e2ee.rs` (key transport only) | `lib/e2ee/` | [09-e2ee](arch/09-e2ee.md) |
| Sharpy AI | `routes/sharpy.rs`, `ai.rs` | `components/SharpyPanel.tsx`, `components/sharpy/` | [10-sharpy](arch/10-sharpy.md) |
| Env vars, feature gating | `config.rs` | `vite.config.ts` | `deploy/.env.example` |
| Deploy topology | — | — | `deploy/README.md`, `deploy/DOKPLOY.md` |

Shared server helpers worth reusing before writing new ones:

- `routes/mod.rs` — `ChannelRole`, `channel_kind`, `is_member`, `member_role`,
  `channel_member_roles`, `count_owners`, and the `require_member` / `require_can_post` /
  `require_owner` guards. **Do not re-derive channel authorization in a route module.**
- `error.rs` — `AppError` → JSON. Every handler returns `AppResult<T>`.
- `notify.rs` — `deliver_push` / `insert_and_fanout` own the DND, privacy-preview, and
  per-transport visibility rules. Never call a push backend directly from a route.
- `http.rs` — the pooled `reqwest::Client`s (the default one, plus `no_redirect_client()` that
  link unfurling needs to re-check every hop). No per-module client.
- `ai.rs` — the OpenAI-compatible chat/embed/transcribe client and its wire structs.

Shared web helpers:

- `web/src/ui/` (barrel `../ui`) — every visual primitive. See [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).
- `lib/api.ts` — the `api` object is the flat index of every endpoint. Add there, not ad hoc.
- `lib/util.ts` — id comparison, all time/duration/byte formatting, initials.
- `lib/localPrefs.ts` — every `sharp.*` localStorage key, typed. One writer per key.
- `store.ts` — the single zustand store; `lib/wsEvents.ts` holds the event reducer and
  `lib/store/*` the pure helpers.

## Contract files

| File | Covers |
|---|---|
| [01-core.md](arch/01-core.md) | Auth, users, channels, messages, threads, reactions, search, the main WS socket, and the server / web / desktop / landing / deploy shape |
| [02-docs.md](arch/02-docs.md) | Collaborative docs: schema, role resolution, the binary Yjs sync socket, content bridging |
| [03-canvas-board.md](arch/03-canvas-board.md) | Canvas and Board doc kinds — deltas from 02 only |
| [04-voice.md](arch/04-voice.md) | LiveKit rooms, camera/screen slots, limits, spatial floor + positional audio, mic control (push-to-talk, force-mute, per-peer local mute), guest call links, meeting lifecycle |
| [05-files-notifications.md](arch/05-files-notifications.md) | Uploads, notification inbox and semantics, push transports, appearance + privacy prefs |
| [06-gifs.md](arch/06-gifs.md) | GIF providers and budget, duck roast flow, durable meeting notes |
| [07-calendar.md](arch/07-calendar.md) | Scheduled meetings, Google Calendar sync, reminder loops |
| [08-polls.md](arch/08-polls.md) | Channel polls and call polls, persistence boundary |
| [09-e2ee.md](arch/09-e2ee.md) | Encrypted DMs: device keys, opaque envelopes, server blind spots |
| [10-sharpy.md](arch/10-sharpy.md) | pgvector embeddings, ACL-filtered retrieval, SSE ask flow |
| [12-garden.md](arch/12-garden.md) | Single-player focus space: DnD on entry, focus timers, the generated world |

Phase numbers in these titles are historical shipping order, not a hierarchy — and they are
not unique (docs and Sharpy were both "Phase 6" at different times). Navigate by feature.

## Monorepo layout

```
sharp/
├── server/     # Rust: axum + sqlx (Postgres) + Redis (optional fanout) — also serves the SPA
├── web/        # React + Vite + TypeScript SPA (the product UI)
├── desktop/    # Tauri 2 shell wrapping the web app (macOS, Windows, Linux)
├── mobile/     # Expo native app — out of scope for most work; ask before touching
├── landing/    # Astro landing page
├── deploy/     # docker-compose + Dockerfiles + Caddy + .env.example
├── scripts/    # dev.sh, stop.sh, release.sh, build-native.sh
└── docs/       # this index + arch/ + DESIGN_SYSTEM.md + RELEASE.md + LEFTOVERS.md
```

## Validation gates

No lint config. These three commands are the entire safety net:

```bash
cd server && cargo check     # no DATABASE_URL needed — see invariant 3
cd server && cargo test      # 45 unit tests, no DB, sub-second
cd web    && bun run build   # tsc --noEmit + vite build
```

The Rust tests cover the pure logic that is easy to break silently: camera and screen slot
accounting in `ws/voice/`, phrase streaks and voice-trigger word-boundary matching,
notification preview building, reset-token hashing, GitHub webhook HMAC. Add to them when
you touch that kind of code — they need no database and run instantly. The web app has no
tests, so `bun run build` (tsc) is all that guards it.

Bun is the JS package manager and script runner everywhere — locally, in `deploy/Dockerfile*`,
and in CI. Never `npm`/`yarn`. Migrations in `server/migrations/` are embedded via
`sqlx::migrate!()` and run on startup; add the next number, never edit a shipped one.

## Other docs

- [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) — the source of truth for UI construction. Live
  catalog at the `/design` route in dev builds.
- [`RELEASE.md`](RELEASE.md) — version, changelog, and tag workflow (`scripts/release.sh`).
- [`LEFTOVERS.md`](LEFTOVERS.md) — deliberately deferred work and intentional non-features.
- [`../deploy/README.md`](../deploy/README.md), [`../deploy/DOKPLOY.md`](../deploy/DOKPLOY.md),
  [`../deploy/DB_STUDIO.md`](../deploy/DB_STUDIO.md) — deployment topologies.
