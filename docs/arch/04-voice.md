# Phase 4 — Voice + camera rooms (LiveKit SFU)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> LiveKit SFU voice / camera / screen-share rooms, participant limits, guest call links, and the meeting lifecycle.

Ephemeral WebRTC audio rooms with optional webcam video on channels, DMs, and standalone
meets. Browsers publish one copy of each track to a self-hosted LiveKit SFU; LiveKit forwards
only subscribed simulcast layers. The Sharp server owns admission, 25-participant / 16-camera /
1-screen capacity, short-lived LiveKit credentials, media publish permissions, media-state
coordination, and buffering of participant-submitted provider-transcribed phrases. Registered
users may keep private trigger phrases, while channels/DMs share a trigger vocabulary. Media is
encrypted in transport with WebRTC DTLS-SRTP, but is not end-to-end encrypted from the SFU.
Opted-in transcription sends short VAD-segmented audio chunks through an authenticated Sharp
proxy to an OpenAI-compatible transcription provider.

## Principles

- **Channel or standalone context**: every channel kind (`public`, `private`, or `dm`) may
  have one voice room. `standalone_calls` provides independently named, shareable rooms with
  no channel/DM foreign key. A room exists in memory while it has participants.
- **Ephemeral media state, durable notes**: WebRTC rooms remain in server memory. Once a
  participant opts into meeting notes, attendance, opted-in transcript phrases, generated
  notes, and action items are persisted in Postgres.
- **SFU media**: every participant opens one LiveKit connection. LiveKit forwards media using
  adaptive subscriptions, dynacast, and camera simulcast; Sharp never handles RTP packets.
- **Capacity**: Sharp and LiveKit enforce a maximum of **25 participants**, **16 active
  cameras**, and **1 screen share** per room (all server-authoritative). A rejected seventeenth
  camera stays connected by audio; a rejected second screen share is non-fatal.
- **Web camera scope**: webcam video and screen sharing are supported in the browser client.
  Broadcast, recording, virtual backgrounds, mobile support, and desktop-specific camera
  permission work are deferred.

## Wire types

All ids are strings in JSON (UUIDs). A WebSocket connection id is the peer identity.

```ts
VoiceParticipant = { conn_id: string, user_id: string, display_name: string, guest: boolean, muted: boolean, transcribing: boolean, camera_on: boolean, screen_on: boolean, screen_stream_id: string | null, hand_raised: boolean, hand_raised_at: number | null, annotation_color: string, aura_style: string | null, pos_x: number, pos_y: number, joined_at: string }
MediaCredentials = { provider: 'livekit', server_url: string, participant_token: string, participant_identity: string }
VoiceRoomSnapshot = { channel_id: string, participants: VoiceParticipant[], active_meeting_id: string | null, annotations_allowed: boolean, media?: MediaCredentials }
```

## Main-WS event additions (existing `/api/v1/ws` socket)

The existing envelope remains `{"type": string, "payload": object}` in both directions.

Client → server:

- `voice.join` `{channel_id, link_token?, aura_style?}` — `channel_id` is the room UUID for wire
  compatibility. Authenticated link visitors send `link_token` as admission proof without
  replacing their account session. `aura_style` seeds the participant's broadcast audio-aura pick
  (see `voice.aura`).
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
- `voice.aura` `{channel_id, aura_style: string}` — broadcast the participant's audio-aura pick
  so every viewer renders their avatar with it. Validated against
  `helios|mercury|voiceprint|kinetic-type|eclipse`; an absent/unknown value clears the broadcast
  (`aura_style=null`, viewers fall back to their own local style). Also sent as `aura_style` on
  `voice.join`. Broadcasts `voice.participant_updated`.
- `voice.move` `{channel_id, x: number, y: number, conn_id?: string}` — set a position on the
  spatial floor. Coordinates are normalized (`x` left→right, `y` top→bottom), non-finite values
  are rejected and everything else is clamped to `[0,1]`. `conn_id` defaults to the sender;
  **any participant may move any other participant** in the same room (both ends must currently
  be in it), because the floor is shared furniture. Broadcasts the light
  `voice.participant_moved` (not `participant_updated`). A move from a connection that is no
  longer in the room is dropped silently — no `voice.error`, because a leave routinely races
  the last throttled move. Guests may send it.
- `voice.poll_create` `{room_id, question, options, multi, expires_at?}`
- `voice.poll_vote` `{room_id, poll_id, option_ids}` — an empty option list retracts the vote.
- `voice.poll_close` `{room_id, poll_id}` — creator only.
- `voice.annotate_allow` `{channel_id, allowed: boolean}` — toggle whether non-sharers may draw
  over the shared screen. New screen shares enable this by default. Accepted only from the
  participant holding the screen-share slot (`screen_on == true`); a non-sharer gets
  `voice.error {code:"annotate_denied"}`. Idempotent (a request matching the current state is a
  no-op with no broadcast).
- `voice.annotate` `{channel_id, stroke_id: string, kind: "start"|"points"|"end", points: [number, number][], size?: number}`
  — an ephemeral pen stroke fragment. `points` are normalized (0..1) coordinates relative to
  the shared video content. Validation: `stroke_id` ≤ 64 chars, `points` ≤ 128 pairs, each
  coord a finite number clamped server-side to `[0,1]`; `size` (brush width as a fraction of
  video width) clamped to `(0, 0.02]`. Sender must be an active participant (else
  `not_in_room`), the room must have an active screen share, and either
  `annotations_allowed == true` or the sender is the sharer (else `annotate_denied`).
- `voice.annotate_clear` `{channel_id}` — clear all live strokes. Sharer only (else
  `annotate_denied`).

Server → client:

- `hello` payload is extended with `conn_id: string` and
  `voice_rooms: VoiceRoomSnapshot[]`, where each snapshot is
  `{channel_id, participants: VoiceParticipant[], active_meeting_id, annotations_allowed}` and each participant is
  `{conn_id, user_id, display_name: string, guest: boolean, muted: boolean, transcribing: boolean, camera_on: boolean, screen_on: boolean, screen_stream_id: string | null, hand_raised: boolean, hand_raised_at: number | null, annotation_color: string, aura_style: string | null, joined_at: string}`.
  `annotation_color` is a CSS hex color assigned server-side at join (a fixed 12-hue palette).
  `aura_style` is the audio-aura signature the participant broadcasts so every viewer sees
  their pick; `null` falls back to the viewer's own local style. One of
  `helios|mercury|voiceprint|kinetic-type|eclipse` (validated server-side; unknown values become `null`).
  `hand_raised_at` is Unix epoch milliseconds set when the hand was raised and `null` while lowered.
  `pos_x`/`pos_y` are the participant's normalized position on the spatial floor.
  `display_name` is filled server-side for everyone (users from the `users` table,
  guests from their token) so clients can render names without `/users` access; `guest`
  marks public voice-link joiners.
- `voice.state` `{channel_id, participants: VoiceParticipant[], active_meeting_id, poll, annotations_allowed, media}` — sent only to the joining
  connection immediately after a successful join. `media` contains a 60-second, room-bound
  LiveKit participant token and public SFU URL; it is never broadcast to other connections.
- `voice.participant_joined` `{channel_id, participant: VoiceParticipant}` — broadcast to
  the room audience (see broadcast targeting below).
- `voice.participant_left` `{channel_id, conn_id, user_id}` — broadcast to the room
  audience.
- `voice.participant_updated` `{channel_id, participant: VoiceParticipant}` — broadcast to
  the room audience after mute, transcription, camera, screen-share, or raise-hand state
  changes.
- `voice.participant_moved` `{channel_id, conn_id, x, y}` — broadcast to the room audience after
  a `voice.move`. Deliberately smaller than `participant_updated`: it travels at pointer rate.
- `voice.roast_armed` `{channel_id, armed: boolean}` — broadcast to the room audience when
  three phrases with gaps of at most 20 seconds arm a voice roast, and with `armed=false`
  after a successful voice GIF suggestion consumes it.
- `voice.trigger_fired` `{channel_id, user_id, display_name, phrase}` — broadcast to the room
  audience after a registered speaker's matched trigger successfully auto-posts a GIF. `phrase`
  is the stored trigger phrase, not the full transcription utterance.
- `voice.poll_state` `{room_id, poll: CallPoll|null}` — complete current call-poll state after
  create, vote, close, or expiry. `voice.state` and the `hello.voice_rooms` snapshots also carry
  the current `poll`.
- `voice.annotate_state` `{channel_id, allowed: boolean}` — broadcast to the room audience
  whenever `annotations_allowed` changes, including automatic enablement when a new screen
  share starts and reset to `false` when the active share ends for any reason (screen disable,
  sharer leaves/disconnects/evicted, room closed). Events are only broadcast on state changes.
- `voice.annotate` `{channel_id, conn_id, user_id, color, stroke_id, kind, points, size?}` —
  relay of a sender's stroke fragment to the room audience, stamped with the sender's `conn_id`,
  `user_id`, and `annotation_color`. Clients ignore events whose `conn_id` matches their own
  (local echo is drawn directly). Nothing is persisted; late joiners see only strokes drawn
  after they join.
- `voice.annotate_clear` `{channel_id}` — relay of the sharer's clear-all to the room audience.
- `voice.error`
  `{channel_id, code: "room_full"|"camera_full"|"screen_taken"|"media_unavailable"|"not_member"|"not_in_room"|"link_revoked"|"annotate_denied"}`
  — sent only to the offending connection. `camera_full` and `screen_taken` do not end the
  audio call. `link_revoked` is sent to a guest whose voice link no longer matches the
  channel's current token (the link was regenerated or removed).

## Server behavior

- `voice.join`: registered users may enter through channel owner/editor membership,
  standalone-call ownership, or a matching `link_token`. A registered link visitor remains
  a registered participant. Guests skip membership and instead verify the JWT's bound link
  against the room's current token. Then check the 25-participant cap and send `voice.error`
  with `code: "room_full"`
  to the sender only when full. Insert the participant with `muted=false, camera_on=false`
  and its resolved `display_name`/`guest`, reply with `voice.state` on the sender's tx only,
  then broadcast `voice.participant_joined` to the room audience. Joining twice from the same
  conn is idempotent and re-sends `voice.state`. New participants start with
  `transcribing=false` and hand lowered (`hand_raised=false`, `hand_raised_at=null`), and are
  placed on the spatial floor by `spawn_position`: a deterministic golden-angle spiral out
  from the centre that skips any point within 0.11 of someone already standing there, so
  arrivals never stack. No RNG — the spawn is a pure function of who is already in the room. Demoting a registered participant to channel viewer removes all of that
  user's connections from the room immediately.
- `voice.move`: require the *sender* to be in the room (else a stale connection could shove
  people around a call it already left), clamp and store on the target conn, broadcast
  `voice.participant_moved`. Positions are room state
  and therefore always broadcast, whether or not any client is currently in the spatial view —
  the server has no notion of who is looking at the floor plan.
- **Broadcast targeting**: every voice broadcast (`participant_joined`/`left`/`updated`/`moved` and
  `voice.roast_armed`)
  targets the **union** of the channel's member ids and the user-ids currently in the room's
  participant map (computed at broadcast time; `participant_left` additionally includes the
  just-removed user's id). This is required so guests — who are not channel members — receive
  participant events.
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
  when 16 slots are already reserved. After reservation, Sharp updates the participant's
  LiveKit publish permissions. A permission-update failure rolls back an enable and returns
  `media_unavailable`. Repeated requests are idempotent.
- `voice.screen`: require an active room participant; atomically reserve/release the single
  screen-share slot and broadcast the complete participant state. On enable, store
  `screen_stream_id` from the request's `stream_id`; on disable, clear it to `null`. Enabling
  is rejected with `screen_taken` when another participant already holds the slot. Repeated
  requests are idempotent (state unchanged → re-broadcast current state).
- Screen-share annotations: each participant is assigned an `annotation_color` at join —
  a hue from a fixed 12-color palette, preferring one unused by current room participants,
  otherwise derived from the conn_id bytes (no rand dependency). `voice.annotate_allow`
  accepts only the current sharer and toggles the room's `annotations_allowed`, broadcasting
  `voice.annotate_state` on change (idempotent otherwise). `voice.annotate` and
  `voice.annotate_clear` are pure relays (nothing is stored server-side): the server validates
  and stamps `conn_id`/`user_id`/`color`, then broadcasts to the room audience. Starting a new
  share enables annotations for all participants by default; the sharer can disable them without
  a repeated idempotent `voice.screen` enable undoing that choice. When the active
  screen share ends for any reason — `voice.screen` disable, or the sharer leaving,
  disconnecting, being evicted, or the room closing — the server clears `annotations_allowed`
  and broadcasts `voice.annotate_state {allowed:false}`, but only if it was previously `true`.
- WS disconnect: remove that conn from every room it is in, broadcast
  `voice.participant_left` for each, close durable attendance, and drop empty rooms. Last leave
  finalizes the meeting and queues AI notes.
- Member removed from channel / leaves channel / channel deleted: evict all of that user's
  conns from the room (all conns for channel delete), with `voice.participant_left`
  broadcasts.

## SFU topology and media lifecycle

- LiveKit identity equals the Sharp WS connection id (`conn_id`). Multiple tabs/devices remain
  distinct participants and receive separate room-scoped tokens.
- `voice.join` first performs Sharp authorization/capacity checks, then returns short-lived
  LiveKit credentials in the private `voice.state`. Tokens allow room join, subscribe, and
  microphone publish only. Camera/screen publish permission is granted after Sharp reserves
  that slot, preventing clients from bypassing server caps.
- Client uses one `livekit-client` `Room` with adaptive stream, dynacast, and 720p camera
  simulcast layers (180p/360p/720p). Screen share uses its own LiveKit source with a 2.5 Mbps
  ceiling. LiveKit track source metadata routes microphone, camera, screen video, and screen
  audio; no application SDP/ICE signaling exists.
- Reconnecting media keeps the call overlay alive and shows connection state. An unrecoverable
  disconnect leaves Sharp's room; normal leave and server eviction also remove the LiveKit
  participant best-effort.

## Web camera UI and lifecycle

- Joining remains audio-first. Camera capture starts only after an explicit toggle and a
  successful server slot reservation.
- The call UI is a floating app overlay, separate from chat / docs / canvas. Main content
  stays interactive underneath. Stage modes: `expanded` (large floating panel), `compact`
  (smaller panel), and `mini` (corner widget). Panels are draggable, resizable, and can be
  collapsed/expanded without leaving the call. Camera-off participants show as circular
  avatars; camera-on participants use a responsive video grid. Controls (mute, camera,
  leave) and Meet-style device pickers live on the overlay. There is no sidebar voice bar.
- **Microphone capture is forced to mono** (`channelCount: 1`). A stereo capture device with
  signal on only one input — common with audio interfaces and virtual devices — otherwise
  publishes a half-silent stereo track and every listener hears that person out of one speaker.
- Local preview is mirrored; remote video is not. Remote audio continues through hidden
  audio elements independently of navigation.
- Camera stays active while the voice session is open across channel / docs / canvas
  navigation. Leaving the call, logout, page unload, or WebSocket reconnection stops local
  tracks. Permission/device failure releases the reserved slot and leaves audio connected.
- Live transcription does not use the browser Web Speech API. A separate selected/default mic
  capture uses hand-rolled RMS VAD, records 300 ms–15 s Opus WebM segments (MP4 fallback), and
  serially posts them to the server proxy. Mute pauses this capture; leaving releases it fully.

## Spatial view and positional audio

- **The floor plan is shared; the panning is not.** Positions live in the room (`pos_x`/`pos_y`,
  `voice.move`), so everyone sees the same layout. Whether you *hear* the room spatially is a
  device-local preference (`sharp.voiceSpatial`), toggled from the call header.
- Web: `web/src/components/voice/SpatialStage.tsx` draws the floor and moves you (drag, click the
  floor, or WASD/arrows; Shift for a larger step). Only your own avatar is movable — the store's
  `moveVoiceSelf` is the sole writer, optimistic locally and throttled to one `voice.move` every
  70 ms with a trailing send so the resting position always lands.
- Audio: `web/src/lib/voice.ts` (`setSpatialAudio` / `setSpatialPosition`) routes each remote mic
  through `source → PannerNode → GainNode → destination` instead of straight out of its
  `<audio>` element. The element stays attached at `volume = 0` — Chrome only feeds a WebRTC
  stream into an AudioContext while it is also attached to a media element, and a *muted*
  element feeds silence into the graph on some builds. Screen-share audio is never spatialized.
- **Direction and distance are separate nodes, deliberately.** The listener sits at the origin
  facing -Z and never moves; each peer's panner is placed on a fixed-radius circle in the
  direction of that peer (`rolloffFactor: 0` switches the built-in distance model off), so the
  left/right image is equally strong for someone beside you and someone across the room. All of
  the distance falloff lives in the gain node, following `spatialGain` in `web/src/lib/spatial.ts`
  — a smooth, strictly decreasing curve with a floor of 0.06, so a far corner is a murmur and
  never a mute. There are **no volume steps**: the zone rings drawn around you
  (`SPATIAL_ZONE_RADII`) are a legend for that curve, not thresholds in it.
- The positions are pushed into the audio engine by `useSpatialAudio`, mounted by `VideoStage`
  rather than the floor plan, so minimizing the call or going picture-in-picture keeps the
  positional mix alive. A live screen share takes the stage back; the audio stays spatial.
- If the AudioContext or panner cannot be built, that peer falls back to plain element playback
  rather than going silent.

## REST API addition — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| GET | `/voice/config` | (any valid token — **user OR guest**) → `{"provider":"livekit","available":true,"server_url":"wss://media.example.com","transcription":true}`. `available=false` and no URL when LiveKit is unconfigured; `transcription` is true iff a transcription API key resolved. Participant tokens are returned only by private `voice.state`, never this endpoint. |
| POST | `/voice/transcriptions` | (any valid token — **user OR room-bound guest**) raw encoded audio body with its MediaRecorder `Content-Type` (`audio/webm;codecs=opus` or `audio/mp4`), max 6 MiB → `{"text": string}`. The server wraps it as OpenAI-compatible multipart (`file`, `model`, `response_format=json`) and never exposes the provider key; `501 not_configured` when disabled. |
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
  `guest: true` (401). `/voice/config`, `/voice/transcriptions`, and voice-trigger management use
  `VoiceConfigAuth` to distinguish both token kinds; config/transcription succeed for guests
  while trigger management returns 403. On the main WS, a guest may only send `ping`
  plus `voice.join`, `voice.leave`, `voice.mute`, `voice.camera`, `voice.screen`,
  `voice.hand`, `voice.aura`, `voice.transcribe`, and `voice.phrase`, and only when the event's
  `channel_id` matches its bound channel. Remaining guest permissions are enforced by the
  voice handlers. Guest
  connect/disconnect does **not** emit presence.
- **Revocation at join**: `voice.join` re-checks the guest token's `link` against the
  channel's current `voice_link_token`. If an owner/editor has regenerated (or the link was removed),
  the guest gets `voice.error` `code: "link_revoked"` and cannot join, even with an
  unexpired token. Guests count toward the normal `MAX_PARTICIPANTS` cap.

## Server configuration

- `LIVEKIT_URL`, `LIVEKIT_INTERNAL_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — optional
  as a group; calls are disabled when all are absent and startup fails when only some are set.
  `LIVEKIT_URL` is browser-facing (`wss://media.example.com`); `LIVEKIT_INTERNAL_URL` is the
  server-to-LiveKit HTTP API. API credentials never reach the browser.
- `TRANSCRIBE_API_KEY` — optional; falls back to `AI_API_KEY`. Transcription is disabled when
  neither key resolves.
- `TRANSCRIBE_BASE_URL` — optional OpenAI-compatible base; falls back to `AI_BASE_URL`, then
  `https://api.openai.com/v1`.
- `TRANSCRIBE_MODEL` — optional; default `gpt-4o-mini-transcribe` (no chat-model fallback).

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
doc/sync/permission foundation — see the Phase 3 section above) → ~~Phase 3.5 boards~~
(shipped: Notion-style kanban as a third doc kind — see the Phase 3.5 section above) →
~~Phase 4 voice~~ (shipped:
LiveKit SFU — see the Phase 4 section) → ~~Phase 5 calendar~~ (shipped: Google Calendar pull
sync + native scheduled meetings — see the Phase 5 section below) → multi-workspace. Chat
stays append-only. (File uploads + notifications: see the section below.)

---

