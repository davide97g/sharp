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
}
```

The query returns public channels plus private channels of which the requester is a member.
A private non-member receives no plot, name, occupancy, or indication that the channel exists.
Public non-members may see a building and join the channel at its doorway through the existing
`POST /channels/:id/join` endpoint.

Channel create/update/delete/member mutations broadcast `garden.map_changed {version}` to the
affected audience. The client refetches the map rather than trying to patch ACL-sensitive rows.

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

Server to client:

- `garden.state {self, peers}` — private snapshot sent to an entering connection.
- `garden.peer_joined {peer}`
- `garden.peer_moved {conn_id, seq, x, y, facing, moving}`
- `garden.peer_left {conn_id}`
- `garden.corrected {seq, x, y}` — authoritative position after an invalid speed jump.
- `garden.space_changed {space, channel_id?, peer}`
- `garden.temple_arrived {peer}`
- `garden.peer_zen {conn_id, zen_mode}`
- `garden.map_changed {version}`
- `garden.error {code, channel_id?}`, where current codes include `not_member`, `not_at_door`,
  and `not_at_temple`.

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
}
```

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
- The persistent desktop room rail and mobile sheet show only ACL-visible rooms. Room teleport
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
  movement is the sole writer of that voice participant's normalized spatial coordinates;
  direct `voice.move` attempts are ignored. Exiting to the hub leaves only a Garden-owned call.
- The existing collapsible/resizable `VideoStage` remains the call UI, so chat, docs, canvas,
  and Garden stay usable beneath it.

The runtime generates an original Sharp map from the durable room coordinates and renders it
with open-source Phaser plus attributed CC0 subsets. Ninja Adventure supplies the base world and
character sheets; PixelKensei's Feudal Japan Props Vol. 2 supplies temple pieces; qubodup's
CC0 Dark Shrine Loop supplies Zen ambience. Provenance is stored beside each asset. Interaction,
collision, jump, landing, teleport, creation, and Zen one-shots are synthesized through Sharp's
existing audio mixer, so they require no additional copyrighted samples. Garden does not copy
WorkAdventure or Pokémon code, maps, characters, names, sounds, or extracted game assets.
