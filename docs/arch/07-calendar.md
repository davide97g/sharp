# Phase 5 — Calendar

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Scheduled meetings, Google Calendar sync, and the reminder background loops.

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
  row → WS `calendar.reminder` + `notify::push_event` (web push when no web session is
  visible; self-guards DND). The "start" claims carry a lower time bound (`> now() - 10 min`) so the Google
  −30d sync window can't back-fill a blast of stale reminders. Reminders do **not** write
  `notifications` inbox rows (the schema needs actor/message ids Google events lack).
- **Google sync poller** (5-min tick, `calendar_sync::poll_active_accounts`): iterate
  `calendar_accounts WHERE status='active'`, `sync_account` each; `invalid_grant` on refresh
  flips `status='invalid'`. The whole loop is gated on `config.google.is_some()`.
- **Poll expiry scheduler** (30s tick, `routes::polls::expire_tick`): finds due open persistent
  polls, atomically claims each through `closed_notified_at`, closes it with reason `expired`,
  broadcasts its final state, and dispatches completion notifications. The same tick closes
  expired ephemeral standalone-call polls in memory.

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

