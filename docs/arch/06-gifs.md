# GIFs & duck suggestions

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> GIF providers and budget, the automatic duck roast flow, and durable meeting notes.

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
to the source; same family as the `[[doc:…]]`/`[[canvas:…]]`/`[[meet:…]]`/`[[poll:…]]`
chips. Chat-only
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

