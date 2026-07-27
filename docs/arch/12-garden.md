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
  version: number
  tile_size: 16
  spawn: { x: number, y: number }
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

Server to client:

- `garden.state {self, peers}` — private snapshot sent to an entering connection.
- `garden.peer_joined {peer}`
- `garden.peer_moved {conn_id, seq, x, y, facing, moving}`
- `garden.peer_left {conn_id}`
- `garden.corrected {seq, x, y}` — authoritative position after an invalid speed jump.
- `garden.space_changed {space, channel_id?, peer}`
- `garden.map_changed {version}`
- `garden.error {code, channel_id?}`, where current codes are `not_member` and `not_at_door`.

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
- The map is an anti-aliased, device-pixel-aware Phaser canvas loaded only with the Garden route.
  React owns chrome, consent, room browsing, and accessible controls; Phaser owns high-frequency
  world rendering.
- The world is a top-down spatial floor, not a pixel-art game. Its ground, paths, pavilions,
  labels, borders, and presence states resolve from Sharp's active theme tokens, so every
  appearance preset carries into Garden.
- Emoji of varied sizes are temporary scene-asset placeholders for people, trees, flowers,
  buildings, and furniture. They are visual only: Garden controls keep the shared monochrome
  SVG language and the accessible room list remains the non-canvas interaction path. Emoji can
  later be replaced with authored assets without changing world coordinates or the wire format.
- Arrow keys and WASD move; pointer/touch chooses a destination. The room list can guide the
  avatar to a doorway without requiring canvas precision. `Enter` enters a nearby room and
  `Escape` exits the current room; both are declared in the shared shortcut registry and may be
  rebound.
- First room entry asks whether Garden may manage room audio. The answer is device-local
  (`sharp.gardenAudio`). Camera remains off. If another call is active, Garden preserves it and
  shows a conflict message.
- Garden-owned calls use `voice.join {garden_active:true}`. While this flag is set, Garden
  movement is the sole writer of that voice participant's normalized spatial coordinates;
  direct `voice.move` attempts are ignored. Exiting to the hub leaves only a Garden-owned call.
- The existing collapsible/resizable `VideoStage` remains the call UI, so chat, docs, canvas,
  and Garden stay usable beneath it.

The runtime draws an original procedural scene and depends only on open-source Phaser. It does
not copy WorkAdventure or Pokémon code, maps, characters, names, or other game assets.
