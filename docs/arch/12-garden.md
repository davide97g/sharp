# Garden — spatial channel rooms

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Garden is the optional spatial front end to ordinary channel calls. It is not a second calling
system: users walk through a shared outdoor hub, enter a channel building, and the web client may
join that channel's existing LiveKit room. Leaving Garden never affects calls it did not start.

## Durable model

`garden_rooms` has one row for every non-DM channel:

```text
channel_id UUID PK/FK channels(id) ON DELETE CASCADE
plot_index INTEGER UNIQUE
room_variant meadow | pond | orchard | greenhouse
created_at TIMESTAMPTZ
```

Migration `0035_garden.sql` backfills existing channels in stable creation order and installs an
`AFTER INSERT` trigger. The trigger takes an advisory transaction lock, allocates the next plot,
and chooses its variant deterministically from the plot index. DMs never get Garden plots.

`user_prefs.garden_avatar` (migration `0037_garden_avatar.sql`) holds the chosen character.

```text
garden_avatar text NULL   -- NULL = never picked
```

It is a real column rather than a key in the `user_prefs.ui` blob because that blob is opaque to
the server and private to its owner, while this value is rendered on *other* people's screens. It
sits on `user_prefs` rather than `users` because `models::User` is shared by `GET /me` and
`GET /users`, so a column there would publish everyone's choice in every user list for no
benefit — Garden peers already carry it. There is deliberately no `CHECK` list: the value is
validated against `ws::garden::GARDEN_AVATARS` on write and tolerated-then-ignored on read, so
adding or removing a character sheet is a code change and never a migration.

## Map API

`GET /api/v1/garden/map` requires the normal bearer token and returns:

```ts
GardenMap = {
  version: 2
  tile_size: 16
  spawn: { x: number, y: number }
  temple: { x: number, y: number }
  rooms: Array<{
    channel_id: string
    name: string
    kind: 'public' | 'private'
    is_member: boolean
    plot_index: number
    room_variant: 'meadow' | 'pond' | 'orchard' | 'greenhouse'
    occupancy: number
    door_x: number
    door_y: number
  }>
  self_avatar: string | null      // the caller's chosen character
  avatars: string[]               // server roster allowlist
}
```

`self_avatar` is viewer-scoped: a peer's choice arrives on the peer, never here. `avatars` is the
server's own allowlist, so the picker cannot offer an id the server would reject.

The query returns public channels plus private channels of which the requester is a member.
A private non-member receives no plot, name, occupancy, or indication that the channel exists.
Public non-members may see a building and join the channel at its doorway through the existing
`POST /channels/:id/join` endpoint.

Channel create/update/delete/member mutations broadcast `garden.map_changed {version}` to the
affected audience. The client refetches the map rather than trying to patch ACL-sensitive rows.

## Creator mode

A workspace admin can place, move and delete scenery in the hub. The result is shared by
everyone and persisted.

`users.is_admin` (migration `0038`) is the gate — the first workspace-level role in the app,
since `ChannelRole` is channel-scoped and this is the first surface that changes something
*everyone* sees. It is checked in exactly one helper, `routes::require_workspace_admin`, so
widening the definition later (a roles table, several admins, an env allowlist) is a
one-function change. A `BEFORE INSERT` trigger promotes the first account on a fresh install,
which covers both `auth::register` and the social signup path. The flag reaches clients **only**
as `can_edit` on the map response; `models::User` is deliberately untouched because it is shared
with `GET /users`.

`garden_objects` holds one row per placed piece — not a snapshot of the world, so the generated
default keeps following the village as channels are added and these rows stay the sparse diff on
top. The **client generates the id**, so an optimistic placement needs no reconciliation and a
replayed op is idempotent (`ON CONFLICT DO NOTHING`). `created_by` is `ON DELETE SET NULL`: a
departing admin's work outlives their account.

```text
id uuid PK (client-generated)
kind text        -- catalogue id, allowlisted by GARDEN_PROP_IDS in Rust
x, y double      -- tile coords, snapped to a half tile and clamped to the hub
flip boolean
created_by uuid FK users(id) ON DELETE SET NULL
```

`POST /api/v1/garden/layout` takes `{ops}` (1..=64) of `add` / `move` / `remove` — one gesture is
one request and one broadcast — and returns the authoritative object list. It runs in a single
transaction, so an over-cap batch places nothing rather than part of itself. Validation:
admin gate, `kind` against the allowlist, non-finite coordinates refused, coordinates clamped to
the same hub bounds movement uses, a 1500-object ceiling, and `placement_is_allowed`, which
refuses any spot within 1.5 tiles of a doorway or on the plaza core or temple threshold — an
admin must not be able to wall the workspace out of its own rooms.

Success broadcasts `garden.layout_changed {objects, actor_id}` to every online user. It carries
the whole list rather than a diff, so a client that missed an earlier event still converges; the
actor skips its own echo because it already applied optimistically. On the client, `layout` is a
**sibling** of `garden.map`, not a field inside it: the Phaser scene rebuilds when `map` changes
identity, so nesting layout there would restart the world on every drag.

Interaction: a click selects the piece under the cursor (hit-tested against sprite bounds, so
selection does not depend on Phaser's input plugin), a click on open ground places the armed
brush or moves the selection, `Delete` removes it, and `Escape` leaves creator mode before it
means "leave the room". The local player is **frozen** while editing — no input, no velocity and
no `garden.move` — so a click never means two things and peers do not see the editor jitter in
place. Creator mode is desktop-only; precision on a 16px grid through a finger is not a fight
worth having in v1. Scenery marked solid also blocks movement, client-side, exactly as the
houses and trees already do.

There is deliberately no server-side history and no draft/publish: two admins can undo each
other, and the safety nets are the protected zones, the object cap and the change being visible
live to everyone.

## Hub terrain

`web/src/lib/garden/terrain.ts` generates the outdoor world as a pure function of
`(seed, width, height, doorways, temple, plaza)`. Nothing about it is persisted or sent: every
client derives the identical grid from a shared constant seed, which is why the map API stays a
short list of rooms rather than ten thousand tiles. The server remains authoritative for
movement speed and scene bounds — terrain is cosmetic plus **client-side** collision, the same
arrangement the houses and trees already had.

Order matters and encodes the safety property: grass and tufted-grass noise, then ponds, then
the plaza and temple apron, then **roads last**. Because roads are painted over everything, and
because pond placement additionally refuses any cell reserved by a doorway, its building
footprint, its spur, the plaza or the temple axis, a generated world can never strand a room
behind water. Adding a channel re-runs the generator with the new doorway included, so its road
appears and any pond that would have blocked it is simply never placed.

Terrain ids are `grass`, `grass_alt`, `dirt`, `stone`, `water`. Only `water` blocks movement, as
merged horizontal runs of static bodies rather than one body per tile. Water renders through a
16-case shore mask (`waterMask`, `WATER_TILE_OFFSETS`) taken from the grass-shore family in
`tileset_water.png`; those ring tiles already contain grass pixels, so water composites onto
grass in a single tilemap layer with no overlay and no generated alpha masks. Fixed-coordinate
scenery asks `isPlantable` before placing, because ponds move with the seed and the room list.

## Main WebSocket events

Garden uses the existing `/api/v1/ws` connection and envelope.

Client to server:

- `garden.enter {}` — create or resume this connection's hub peer.
- `garden.leave {}` — remove it from Garden only.
- `garden.move {seq, x, y, facing}` — `facing` is `up|down|left|right`.
- `garden.room_enter {channel_id}` — accepted only for a visible channel membership and while
  the peer is within 4.5 tiles of that plot's deterministic doorway.
- `garden.room_exit {}` — return to the hub outside the current building.
- `garden.room_teleport {channel_id}` — move directly to a visible room. Public non-members join
  through the normal channel membership flow first; the server chooses a random safe arrival
  coordinate and never reveals an inaccessible private room.
- `garden.temple_teleport {}` — while in the hub, travel to the public temple threshold using
  the same visual transition as room teleport.
- `garden.zen {enabled}` — publish Zen presence. Enabling is accepted only within 4.5 tiles of
  the hub temple; disabling is accepted from any Garden space.
- `garden.avatar {avatar}` — choose a character. Validated against `GARDEN_AVATARS`; an
  unknown id is rejected with `garden.error {code: "bad_avatar"}` and nothing is persisted.

Server to client:

- `garden.state {self, peers}` — private snapshot sent to an entering connection.
- `garden.peer_joined {peer}`
- `garden.peer_moved {conn_id, seq, x, y, facing, moving}`
- `garden.peer_left {conn_id}`
- `garden.corrected {seq, x, y}` — authoritative position after an invalid speed jump.
- `garden.space_changed {space, channel_id?, peer}`
- `garden.temple_arrived {peer}`
- `garden.peer_zen {conn_id, zen_mode}`
- `garden.peer_avatar {conn_id, user_id, avatar}` — one event per connection of the changing
  user, each to that peer's own space audience, so a change made in one tab reaches peers
  watching any of them. Clients retexture in place rather than rebuilding the avatar.
- `garden.map_changed {version}`
- `garden.error {code, channel_id?}`, where current codes include `not_member`, `not_at_door`,
  `not_at_temple`, `bad_avatar`, and `no_peer`.
- `no_peer` answers any client event other than `garden.enter`/`garden.leave`/`garden.move` that
  arrives on a connection the peer registry does not know — the registry is per-connection and
  in-process, so a `garden.enter` that never landed leaves a client whose map and doorway
  prompts look healthy while every action is ignored. The client re-sends `garden.enter` on this
  code and is respawned in the hub; silence here was previously indistinguishable from a bug in
  the keyboard layer.

`GardenPeer` is:

```ts
{
  conn_id: string
  user_id: string
  display_name: string
  space: 'hub' | 'room'
  channel_id: string | null
  x: number
  y: number
  facing: 'up' | 'down' | 'left' | 'right'
  moving: boolean
  seq: number
  zen_mode: boolean
  avatar: string | null
  color_index: number
}
```

## Appearance

`avatar` is the chosen character roster id, or `null` for someone who never picked. Rendering
falls back to `AVATAR_IDS[hash(user_id) % n]`, keyed on the **immutable user id** — not the
display name, which would mean a rename silently changed your character and two people sharing a
name were indistinguishable. The roster lives in
`web/src/components/garden/gardenAvatars.ts`, is mirrored by hand in `ws::garden::GARDEN_AVATARS`,
and its provenance is recorded in `web/public/assets/garden/ninja-adventure/README.md`. Every
sheet must be 64x112 — 4 facing columns x 7 rows of 16px frames.

`color_index` is a highlight slot assigned by **join order within the live session** and never
persisted; restarting the server reassigns every slot. Assignment is keyed by `user_id`, so a
person with two tabs wears one colour, and takes the lowest slot nobody holds, so a slot freed by
someone leaving is reused rather than the palette drifting upward. Past ten concurrent people the
slot wraps deterministically from the user id, so a collision is stable rather than flickering.
Slot 0 is the product accent, so the first arrival looks "default". The ten colours themselves
live client-side in `web/src/lib/gardenColors.ts` — the server only hands out an index. They are
fixed hex rather than theme tokens because they must stay legible against grass and stone under
every preset and accent hue, and because Phaser needs a numeric fill.

The colour renders in three places: the ring under the avatar, a tick down the leading edge of the
name label, and the minimap dot. Zen mode overrides the ring green while it lasts —
state wins over identity — and leaving Zen restores the person's own colour.

The server owns the last accepted sequence and position. It rejects stale sequences, clamps
scene bounds, and permits at most 8 tiles/second plus latency slack. The browser sends at 10 Hz
and interpolates remote peers between updates. The outdoor hub targets signed-in online users;
an interior targets only that channel's current members. Removing membership ejects that user's
Garden peer to the hub immediately.

Garden presence is ephemeral and in-process, like voice-room coordination. Restarting the server
returns everyone to the hub. No Garden movement or visit history is persisted.

## Calls and UX

- Garden is a `/garden` route, desktop rail destination, and primary mobile-web tab.
- The map is a nearest-neighbor, device-pixel-aware Phaser canvas loaded only with the Garden route.
  React owns chrome, consent, room browsing, and accessible controls; Phaser owns high-frequency
  world rendering.
- The world is a 16-bit top-down garden inspired by the saturated greens, strong silhouettes,
  tiled paths, and readable four-direction movement of handheld-era JRPGs. Sharp's product
  chrome remains token-driven and visually separate from the game world.
- The tilemap, houses, trees, props, animated flowers, shadows, and four-direction character
  sheets come from Pixel-Boy and AAA's CC0 Ninja Adventure Asset Pack. Provenance and the
  upstream revision live beside the assets under `web/public/assets/garden/ninja-adventure/`.
  Garden contains no Pokémon or Nintendo artwork, maps, code, names, or extracted game data.
- Phaser Arcade bodies prevent the local player from crossing buildings, mature trees, room
  walls, the shared table, chairs, crates, and planters. The server remains authoritative for
  movement speed and scene bounds.
- Arrow keys and WASD move; pointer/touch chooses a destination; `Space` performs a visual jump
  with a deforming ground shadow and landing dust. The room rail can guide the avatar to a
  doorway or the Zen temple without requiring canvas precision. `Enter` enters a nearby room or
  the temple, `Escape` exits, and `R` opens the accessible room-creation dialog. Semantic
  shortcuts are declared in the shared shortcut registry and may be rebound.
- The desktop room rail is **collapsed by default** so the map is the page: only the header card
  shows at rest. Hovering the card peeks the panel, and its chevron pins it open — three states,
  because a boolean cannot express "peeking". A 150 ms debounced hide is what lets the cursor
  cross the gap between card and panel. The pin is device-local
  (`sharp.gardenRailPinned`), Escape collapses before it means "leave the room", and
  reduced-motion users get no animation. The mobile sheet is unchanged and remains the only
  affordance below `lg`.
- The character picker is offered once per device to anyone who has never chosen
  (`sharp.gardenAvatarPrompted`) and is reopenable from the gear in the header. It is
  deliberately **not** blocking: skipping keeps the deterministic fallback, which already looks
  correct and distinct to everyone else.
- The desktop room rail and mobile sheet show only ACL-visible rooms. Room teleport
  uses an Escape-like spin and lift, a brief black transition, and a randomized spin-down
  arrival. Reduced-motion users receive a short opacity transition instead. The bottom-right
  minimap tracks the hub paths, visible rooms, temple, and current player position.
- Entering the temple enables device DnD while preserving its prior state, publishes
  `zen_mode` to Garden peers, and opens a quiet temple interior. Leaving restores DnD only when
  Garden originally enabled it. A CC0 ambient loop starts by default; the device-local melody
  toggle and volume remain user-controlled.
- First room entry asks whether Garden may manage room audio. The answer is device-local
  (`sharp.gardenAudio`). Camera remains off. If another call is active, Garden preserves it and
  shows a conflict message.
- Garden-owned calls use `voice.join {garden_active:true}`. While this flag is set, Garden
  movement is the sole writer of that voice participant's normalized spatial coordinates — the
  only shared floor left, since call-view arrangements are per listener (`docs/arch/04-voice.md`).
  A listener in the call view may still place a Garden walker somewhere else in their own mix.
  Exiting to the hub leaves only a Garden-owned call.
- The existing collapsible/resizable `VideoStage` remains the call UI, so chat, docs, canvas,
  and Garden stay usable beneath it.

The runtime generates an original Sharp map from the durable room coordinates and renders it
with open-source Phaser plus attributed CC0 subsets. Ninja Adventure supplies the base world and
character sheets; PixelKensei's Feudal Japan Props Vol. 2 supplies temple pieces; qubodup's
CC0 Dark Shrine Loop supplies Zen ambience. Provenance is stored beside each asset. Interaction,
collision, jump, landing, teleport, creation, and Zen one-shots are synthesized through Sharp's
existing audio mixer, so they require no additional copyrighted samples. Garden does not copy
WorkAdventure or Pokémon code, maps, characters, names, sounds, or extracted game assets.
