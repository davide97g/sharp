# Polls

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Polls in channels and inside calls, including the call-poll persistence boundary.

Channel polls are durable chat resources with live per-user vote state, optional expiry, and an
optional pinned banner. The same poll surface runs inside calls: channel-attached rooms bridge to
the durable channel poll, while standalone-call rooms use replica-local ephemeral state.

## Principles

- **Channel resource, not DM content**: poll creation requires owner/editor posting permission
  in a non-DM channel. Channel members may read and vote.
- **Replacement voting**: each vote request replaces that user's full option set; an empty set
  retracts it. Single-choice polls accept at most one option; multi-choice polls accept any
  unique subset of their options.
- **Personalized fanout**: durable poll events are rebuilt per recipient so `my_votes` is never
  another member's selection.
- **One completion claim**: `closed_notified_at` atomically claims finalization across replicas,
  preventing duplicate close broadcasts and `poll_ended` notifications.

## Database schema (migration `0017_polls.sql`)

- `polls` — UUID `id`, `channel_id`, `creator_id`, nullable `card_message_id`, `question`,
  `multi`, `pinned`, optional `expires_at`, `closed_at`, `closed_reason`,
  `closed_notified_at`, soft-delete `deleted_at`, and `created_at`. Channel/creator deletion
  cascades; deleting the card message only nulls `card_message_id`. Partial indexes cover open
  channel polls and due expiry candidates.
- `poll_options` — UUID `id`, owning `poll_id`, zero-based `position`, and `text`, unique on
  `(poll_id, position)`; rows cascade with the poll.
- `poll_votes` — `(poll_id, option_id, user_id)` primary key plus `voted_at`; option, poll, and
  user references cascade. A separate `poll_id` index supports tallying.
- Migration extends the notifications kind constraint with `poll_ended`.

## Wire types

All ids are strings. `card_message_id` is a string because message ids are `bigint`; timestamps
are RFC3339 UTC strings.

```ts
PollVoter = { id: string; display_name: string }
PollOption = { id: string; position: number; text: string; count: number;
  voters: PollVoter[] }
Poll = { id: string; channel_id: string; creator_id: string;
  card_message_id: string|null; question: string; multi: boolean; pinned: boolean;
  expires_at: string|null; closed_at: string|null;
  closed_reason: 'manual'|'expired'|null; deleted: boolean; created_at: string;
  options: PollOption[]; my_votes: string[]; total_voters: number }

CallPollVoter = { id: string; display_name: string; guest: boolean }
CallPollOption = { id: string; text: string; count: number; voters: CallPollVoter[] }
CallPoll = { id: string; room_id: string; question: string; multi: boolean;
  persistent_poll_id: string|null; creator_id: string; expires_at: string|null;
  closed: boolean; options: CallPollOption[]; my_votes: null }
```

`total_voters` counts distinct registered voters, not selected options. Option `count` and
`voters` expose each option's tally and voter identities.

## REST API (`/api/v1`, non-guest `AuthUser`)

| Method | Path | Request / response |
|---|---|---|
| GET | `/channels/{id}/polls?active=1` | Channel member → `{polls: Poll[]}`, newest first. Without `active=1`, includes closed and deleted polls; active mode includes only non-deleted, unexpired, unclosed polls. |
| POST | `/channels/{id}/polls` | Non-DM owner/editor; `{question, options, multi, pinned, expires_at?}` → `201 Poll`. Creates the durable poll, posts its chat card, then emits `poll.created`. |
| GET | `/polls/{id}` | Channel member → personalized `Poll`. |
| DELETE | `/polls/{id}` | Creator only → 204. Soft-deletes the poll and its card message, then emits `poll.deleted`. |
| POST | `/polls/{id}/vote` | Channel member; `{option_ids}` → personalized `Poll`. Replaces all caller votes and emits `poll.updated`. |
| DELETE | `/polls/{id}/vote` | Channel member → personalized `Poll`. Retracts all caller votes and emits `poll.updated`. |
| POST | `/polls/{id}/close` | Creator or channel owner → `Poll`. Idempotently closes with reason `manual`, emits `poll.updated`, and dispatches completion notifications once. |
| POST | `/polls/{id}/pin` | Creator or channel owner; `{pinned}` → `Poll`. Open polls only; emits `poll.updated`. |

Creation trims all text. Question length is **1–500 characters**; there must be **2–10**
options; each option is **1–100 characters** after trimming and option text must be unique.
`expires_at`, when supplied, must be in the future. Vote option ids must be unique and belong
to that poll.

## Message token and pinned banner

Creating any durable poll posts a normal message as the creator with content
`[[poll:<uuid>|<question>]]`; `|`, `]`, and newlines in the token question are replaced with
spaces. The message follows the normal message broadcast/notification path, stores its id in
`card_message_id`, and renders as the interactive poll card. Notification previews humanize the
token as `📊 <question>`.

`pinned=true` makes an **open** poll appear in the channel's sticky active-poll banner. Multiple
pinned polls collapse behind a count and can be expanded. The banner admits only non-deleted,
unclosed polls; manual close, or the scheduler processing an expiry, therefore auto-unsticks the
poll even though the stored `pinned` field need not be rewritten. Pin changes are rejected after
close/expiry.

## WS events

Durable server events use the existing main socket:

- `poll.created` / `poll.updated` — `{poll: Poll}`, sent to all channel members with
  recipient-specific `my_votes`.
- `poll.deleted` — `{poll_id, channel_id, message_id}` to all channel members.

Call-poll commands and state use that same socket:

- client `voice.poll_create` — `{room_id, question, options, multi, expires_at?}`; registered
  active room participant only, with the same text/count/expiry validation as REST. Guests cannot
  create polls, and a room holds at most one poll.
- client `voice.poll_vote` — `{room_id, poll_id, option_ids}`; active participants, including
  guests. Empty `option_ids` retracts the vote.
- client `voice.poll_close` — `{room_id, poll_id}`; active poll creator only.
- server `voice.poll_state` — `{room_id, poll: CallPoll|null}`, broadcast as a complete snapshot
  after mutations and standalone expiry. Current poll state is also included in `voice.state` and
  `hello.voice_rooms` snapshots for joining/reconnecting clients.

## Call-poll persistence boundary

- **Channel-attached call**: creation calls the durable channel-poll path with `pinned=false`,
  persists options and registered-user votes in Postgres, posts the `[[poll:…]]` chat card, and
  mirrors durable changes between chat and `voice.poll_state`. The call wrapper's
  `persistent_poll_id` identifies the durable poll.
- **Standalone call**: poll, options, and votes live only in the room's in-memory `CallPoll` on
  one replica. They are not Redis-fanned, never post to chat, and disappear when the last
  participant leaves and the room is removed (or the replica restarts).
- **Guest votes**: always live in the in-memory call overlay, including on a channel-attached
  poll. They affect the live `voice.poll_state` tally only: they are never inserted into
  `poll_votes`, never emitted on the durable `Poll`, and never appear on the chat card. Registered
  votes on a channel-attached poll use the durable vote path; standalone registered votes remain
  in the same ephemeral overlay.

## Expiry and completion notifications

`main.rs` runs `routes::polls::expire_tick` every 30 seconds. It selects due, open, non-deleted
durable polls; `finalize_poll_and_notify` atomically claims each with
`UPDATE … WHERE closed_notified_at IS NULL RETURNING`, sets `closed_at`, reason `expired`, and
`closed_notified_at`, emits the final `poll.updated`, dispatches notifications, and mirrors closure
into any live channel call. The tick also marks expired standalone-call polls closed in memory and
broadcasts `voice.poll_state`.

Completion recipients are `creator ∪ distinct registered voters`. Each unmuted recipient gets a
`poll_ended` inbox row and recipient-only `notification.created`; the actor is the poll creator and
the message link targets the card when present. Preview contains the question plus the first
highest-count option and tally, or `no votes`. A channel mute suppresses the row and every delivery.
DND preserves the inbox row and WS event but suppresses web/Expo push; normal client DND handling
also suppresses arrival toast/OS popup. Delivery is best-effort after the atomic finalization claim.

