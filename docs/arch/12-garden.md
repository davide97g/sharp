# Garden — a private focus space

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Garden is a single-player room you walk into to stop being reachable. Entering turns Do Not
Disturb on and hides the app chrome; an optional focus timer rides the top edge; you can also
start nothing and just wander. There are no peers, no channel rooms, no calls and no shared
floor — those all belonged to the previous spatial-hub design and were removed, not disabled.

Because nobody else is in the world, almost nothing about it needs a server. The client
generates the whole garden from a constant seed, so the API is four endpoints and there is **no
Garden WebSocket surface at all**.

## Durable model

One table. `garden_focus_sessions` (migration `0040_garden_focus.sql`) exists for exactly one
reason: a running timer has to survive a reload, and elapsed time must come from a clock the
client cannot move.

```text
id            uuid PK
user_id       uuid FK users(id) ON DELETE CASCADE
mode          countdown | stopwatch
duration_secs integer NULL   -- countdown only; CHECK ties it to mode
started_at    timestamptz
ended_at      timestamptz NULL
```

- `garden_focus_one_active` is a **partial unique index** on `user_id WHERE ended_at IS NULL`, so
  two tabs cannot both start a timer.
- Elapsed time is always `now() - started_at`, never a client-accumulated counter.
- The `garden_focus_mode_duration` CHECK states the same rule as `parse_start` in Rust, so a
  malformed row cannot exist even if a future caller skips the route.

`user_prefs.garden_avatar` (migration `0037`) still holds the chosen character. It stays a real
column rather than a key in the opaque `user_prefs.ui` blob because the server validates it
against `routes::garden::GARDEN_AVATARS` before storing — the client must not be able to save an
id that would later fail to resolve. Nothing else about Garden is persisted: no position, no
visit, no world state.

Migration `0040` **drops** `garden_rooms`, `garden_objects` and the `allocate_garden_room`
trigger. `users.is_admin` and its `garden_seed_first_admin` trigger (migration `0038`) stay —
creator mode was their only reader, but a flag that already promotes the founder across both
signup paths is worth keeping for the next workspace-wide surface, and re-adding it later would
lose that promotion. There is deliberately no Rust helper reading it right now.

## REST API

All four require the normal bearer token.

`GET /api/v1/garden`

```ts
GardenState = {
  avatar: string | null        // null = never picked; opens the picker once per device
  avatars: string[]            // server roster allowlist
  session: FocusSession | null // a timer that survived a reload
  preset_minutes: number[]     // 10, 20, 30, 45, 60, 120
}

FocusSession = {
  id: string
  mode: 'countdown' | 'stopwatch'
  duration_secs: number | null
  started_at: string           // RFC 3339
  elapsed_secs: number         // measured by the server, not by the caller
}
```

`elapsed_secs` is what the client ticks from; `started_at` is informational. A device an hour out
of sync still shows the right remaining time.

`POST /api/v1/garden/avatar` `{avatar}` — validated against the roster, else `400`.

`POST /api/v1/garden/session` `{mode, duration_secs?}` → `{session}`. A countdown requires
`duration_secs` in `1..=86400`; a stopwatch refuses one. Starting **replaces** whatever was
running, both statements in one transaction: pressing "30 minutes" while a stopwatch runs means
30 minutes, and the unique index must never see two live rows.

`DELETE /api/v1/garden/session` → `{stopped: {mode, duration_secs, elapsed_secs} | null}`.
Idempotent — stopping nothing is a success, because a countdown reaching zero can be reported by
two tabs at once.

`preset_minutes` is a UI affordance, not a rule: the server accepts any duration inside the
ceiling, so adding a preset never needs a server change.

## The world

`web/src/lib/garden/terrain.ts` generates the garden as a pure function of
`(seed, width, height, shrine, plaza)`. Nothing is persisted or sent: `GARDEN_SEED` is a constant
in `GardenGame.tsx`, so every device draws the identical world and walking back in is walking
back into the same garden. Terrain is cosmetic plus **client-side** collision; there is no server
authority over movement any more, because there is nothing to keep honest.

Order encodes the safety property: grass noise, then ponds, then the plaza and shrine apron, then
**paths last** — so a pond can never strand the shrine or cut the ring lane, which loops the
garden and always returns to the plaza. Terrain ids are `grass`, `grass_alt`, `dirt`, `stone`,
`water`; only `water` blocks movement, as merged horizontal runs of static bodies rather than one
body per tile. Water renders through a 16-case shore mask (`waterMask`, `WATER_TILE_OFFSETS`)
whose ring tiles already contain grass pixels, so water composites onto grass in a single tilemap
layer with no overlay.

Scenery is likewise a pure function of tile coordinates (`tileNoise` in `GardenGame.tsx`): trees
mass along the outer margin so the garden reads as enclosed without a fence, and thin toward the
middle. Every placement asks `isPlantable` first, which refuses water, paths, the stone clearing
and the shrine's own clearing — a bush growing in the middle of a path stops it being a path.

The shrine at the end of the path is **scenery, not a control**. Nothing happens when you reach
it. Timers live in the chrome, where they can be reached without walking, because a control you
have to walk to is a control you cannot use with a keyboard.

Per-user decoration is a later feature. When it lands it is a sparse diff painted on top of this
generated default — never a snapshot of it — so the default can keep changing.

## Client

- `/garden` is a route, a desktop rail destination, and a primary mobile-web tab.
- `AppShell` hides the mode rail, the dock and the mobile tab bar for this route. The garden's own
  header carries the way out, and that is the whole point: no unread counts, no dock, no badges.
- `GardenView.tsx` owns chrome and lifecycle; `GardenGame.tsx` owns the Phaser scene. React never
  subscribes to anything at frame rate, and the scene never writes to the store.
- **DnD**: entering enables it and records whether it was already on; leaving restores the user's
  own setting rather than switching it off for them.
- **Leaving ends the session.** A timer is tied to being in the garden, not to the account —
  otherwise a countdown finishing in another part of the app would leave DnD stuck on with no
  client running to clear it. This is stated in the UI rather than implied. A *reload* is not
  leaving: React cleanup does not run, the row stays open, and re-entry resumes it from
  `elapsed_secs`.
- The unmount cleanup defers by a tick and checks a mount counter, because StrictMode mounts,
  unmounts and remounts in development and the exit path is destructive.
- **The focus bar** is the one heavy piece of chrome (`.garden-bar-*` in `index.css`): a countdown
  fills toward its end, a stopwatch sweeps instead, because there is no end to fill toward and a
  fake fill would imply one. Reduced motion keeps the width and colour and stops the movement — a
  progress bar is information, not decoration.
- A countdown reaching zero plays the longest cue in the feature (`sound.garden.timerDone`) and
  opens a summary. It has to be noticed by someone who stopped looking at the screen, which is
  the entire reason for setting a timer and walking around.
- Arrow keys and WASD move, pointer/tap chooses a destination, `Space` jumps. `T` opens the timer,
  `Escape` leaves. Both are declared in the shared shortcut registry and may be rebound.
- The character picker is offered once per device to anyone who never chose
  (`sharp.gardenAvatarPrompted`) and is reopenable from the gear. Deliberately dismissible:
  skipping keeps the deterministic fallback from `resolveAvatarId`, keyed on the immutable user
  id.
- Ambience (a CC0 loop) is device-local (`sharp.gardenAmbience`, `sharp.gardenAmbienceVolume`) and
  starts on the first gesture, since autoplay is blocked before one.

## Appearance and assets

The roster lives in `web/src/components/garden/gardenAvatars.ts`, mirrored by hand in
`routes::garden::GARDEN_AVATARS`. Every sheet must be 64x112 — 4 facing columns x 7 rows of 16px
frames. There is no name label, no presence dot and no identity ring on the character: there is
nobody to read them.

The tilemap, trees, props, animated flowers, shadows and character sheets come from Pixel-Boy and
AAA's CC0 Ninja Adventure Asset Pack; the shrine pieces come from PixelKensei's Feudal Japan
Props Vol. 2; the ambience is qubodup's CC0 Dark Shrine Loop. Provenance lives beside each asset
under `web/public/assets/garden/`. Footstep, bump, jump, landing and timer cues are synthesized
through Sharp's existing audio mixer (`lib/sound.ts`), so Garden never becomes a second mixer.
Garden contains no Pokémon or Nintendo artwork, maps, code, names or extracted game data, and
does not copy WorkAdventure.
