# Phase 2 — Docs (Affine-style knowledge base)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Collaborative BlockNote/Yjs documents: schema, role resolution, the binary sync socket, and chat/doc content bridging.

Collaborative block documents living **inside channels**. Chat stays append-only rows;
docs are Yjs CRDTs. Both are served by the same single binary — no sidecar.

## Principles

- **Editor**: BlockNote (`@blocknote/react` + `@blocknote/mantine`) — Notion/Affine-style
  block editor on ProseMirror, collaborative via Yjs.
- **Sync**: Yjs on the client; the Rust server persists and relays updates using `yrs`.
  The server does not interpret document semantics except for compaction, plain-text
  extraction (search) and doc-link extraction (backlinks).
- **Authorization is per channel**: every doc belongs to a channel; channel membership and role
  gate access. On top: per-doc `everyone_role` + per-user role overrides.
- **Bridging**: `@user` mentions inside docs notify people (inbox + WS); `[[doc]]` chips
  embed docs in chat messages and other docs; docs can be shared to a channel.
- **Limitation (v2)**: live doc sync rooms are per-replica (no Redis fanout for binary
  updates). Updates always persist to Postgres, so replicas converge on reopen. Chat
  events about docs (`doc.*`) do go through Redis like all other events.

## Database schema (migrations `0002_docs.sql`, `0013_doc_inherit.sql`)

```sql
docs(
  id uuid PK default gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind text NOT NULL default 'doc'            -- 'doc' (blocknote) | 'canvas' (tldraw, migration 0006) | 'board' (kanban, migration 0021)
    CHECK (kind IN ('doc','canvas','board')),
  title text NOT NULL default '',            -- shown as 'Untitled' when empty
  icon text NOT NULL default '',              -- emoji, may be empty
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL default now(),
  updated_at timestamptz NOT NULL default now(),
  deleted_at timestamptz,                     -- soft delete = trash (restorable)
  everyone_role text NOT NULL default 'inherit'
    CHECK (everyone_role IN ('editor','viewer','none','inherit')),
  content_text text NOT NULL default '',      -- extracted plain text (search/preview)
  search tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', title || ' ' || content_text)) STORED
)
-- indexes: (channel_id, updated_at DESC); GIN (search)

doc_updates(                                  -- yjs update log (v1 lib0 encoding)
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL default now()
)
-- index: (doc_id, id)

doc_roles(                                    -- per-user overrides of everyone_role
  doc_id uuid REFERENCES docs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor','viewer','none')),
  PRIMARY KEY (doc_id, user_id)
)

doc_links(                                    -- doc → doc links, for backlinks
  doc_id uuid REFERENCES docs(id) ON DELETE CASCADE,        -- source
  target_doc_id uuid REFERENCES docs(id) ON DELETE CASCADE, -- target
  PRIMARY KEY (doc_id, target_doc_id)
)

doc_mentions(                                 -- @user inside a doc = inbox notification
  id bigint PK GENERATED ALWAYS AS IDENTITY,
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  from_user uuid NOT NULL REFERENCES users(id),
  to_user uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL default now(),
  read_at timestamptz
)
-- index: (to_user, read_at)
```

### Role resolution (effective `my_role`)

1. Not a member of the doc's channel → **no access** (404, and doc never listed).
2. Doc creator → `owner` (always full access; cannot be demoted; manages roles/trash).
3. Channel owner → `owner` (including role management, `everyone_role`, permanent delete).
4. `doc_roles` row for the user → that role.
5. If `docs.everyone_role != 'inherit'` → that role.
6. Otherwise channel editor → `editor`; channel viewer → `viewer`.

Per-doc `none` cannot hide a doc from its creator or a channel owner. For everyone else, `none`
behaves like the doc doesn't exist. `viewer` = read-only (server
drops their sync updates; UI renders read-only). `editor` = full content editing +
rename + trash. Only `owner` edits roles, `everyone_role`, and permanently deletes.

## Wire types

Doc-mention IDs are `bigint` → **serialized as strings** (same invariant as messages).

```ts
DocRole = 'owner'|'editor'|'viewer'|'none'
Doc = {
  id: string, channel_id: string, kind: 'doc'|'canvas'|'board', title: string, icon: string,
  created_by: string|null, created_at: string, updated_at: string,
  deleted_at: string|null,
  everyone_role: 'editor'|'viewer'|'none'|'inherit',
  my_role: DocRole,                    // resolved for the requesting/receiving user
  preview: string                      // first 160 chars of content_text
}
DocMention = {
  id: string,
  doc: { id: string, kind: 'doc'|'canvas'|'board', title: string, icon: string, channel_id: string },
  from_user: { id: string, display_name: string },
  created_at: string, read_at: string|null
}
```

## REST API additions — base `/api/v1`

| Method | Path | Body → Response |
|---|---|---|
| GET | `/channels/{id}/docs` | → `{docs: Doc[]}` (not trashed, `my_role != none`, updated_at desc) |
| GET | `/channels/{id}/docs/trash` | → `{docs: Doc[]}` (trashed, same visibility) |
| POST | `/channels/{id}/docs` | `{title?, icon?, kind?}` → `201 Doc` (channel owner/editor; `kind` defaults `'doc'`, or `'canvas'` for a whiteboard, or `'board'` for a kanban) |
| GET | `/docs/{id}` | → `Doc` |
| PATCH | `/docs/{id}` | `{title?, icon?, everyone_role?}` → `Doc` (title/icon: editor+; everyone_role: owner; empty body → 422) |
| DELETE | `/docs/{id}` | → `204` (editor+; soft — sets `deleted_at`) |
| POST | `/docs/{id}/restore` | → `Doc` (editor+) |
| DELETE | `/docs/{id}/permanent` | → `204` (owner only; hard delete) |
| GET | `/docs/{id}/roles` | → `{roles: [{user: User, role: 'editor'\|'viewer'\|'none'}]}` (member; **explicit overrides only** — the client merges with the channel member list + `everyone_role`) |
| PUT | `/docs/{id}/roles/{user_id}` | `{role: 'editor'\|'viewer'\|'none'}` → `204` (owner; target must be channel member, not creator) |
| DELETE | `/docs/{id}/roles/{user_id}` | → `204` (owner; removes override) |
| GET | `/docs/{id}/backlinks` | → `{docs: Doc[]}` (docs linking here that the requester can see: **must be a member of the linking doc's channel** + role ≠ none) |
| POST | `/docs/{id}/mentions` | `{user_id}` → `204` (editor+; no self-mentions; not on trashed docs; target must be able to see the doc; dedup: skipped if an unread mention of the same user in the same doc exists) |
| GET | `/mentions` | → `{mentions: DocMention[]}` (mine, unread first then newest, limit 50) |
| POST | `/mentions/read` | `{ids: string[]}` → `204` (marks mine read) |
| GET | `/docs/search?q=&limit=20&doc_id=` | → `{results: (Doc & {channel_name: string, snippet: string})[]}` (docs I can see, FTS + title ILIKE; optional `doc_id` scopes to one doc; `snippet` is a `ts_headline` over `content_text` with `<<`/`>>` markers, empty for canvases and boards) |
| GET | `/docs/recent?kind=&limit=30` | → `{docs: [{doc: Doc, channel_name: string}]}` (workspace-wide visible docs, newest updated first; optional `kind` is `doc`, `canvas`, or `board`; `limit` defaults to 30, max 100) |

Validation: title ≤ 200 chars; icon ≤ 16 chars; mention POST is idempotent.

## Doc sync WebSocket — `GET /api/v1/docs/{id}/sync?token=<jwt>`

Access checked on upgrade (channel member + `my_role != none`); `403`/`404` otherwise.
Trashed docs accept read-only connections (restore preview), updates are dropped.

**Binary frames**; first byte is the frame type, rest is payload:

| byte | name | direction | payload |
|---|---|---|---|
| `0x00` | update | both | Yjs update, v1 encoding. Client→server: persisted to `doc_updates` + relayed to the room (dropped silently if sender is a viewer). Server→client: applied to the local Y.Doc. |
| `0x01` | awareness | both | `y-protocols/awareness` update bytes. Relayed to the room, never persisted. Server caches each connection's last awareness frame and replays all cached frames to a new joiner; on disconnect peers time the client out (30s y-protocols timeout). |
| `0x02` | init state | server→client | Merged doc state as one Yjs v1 update (all `doc_updates` rows merged via `yrs::merge_updates_v1`). Sent once on connect. |
| `0x03` | server state vector | server→client | `yrs` state vector of the merged state, sent right after `0x02`. Client replies with `Y.encodeStateAsUpdate(ydoc, sv)` as a `0x00` frame if it holds changes the server lacks (offline edits / reconnect). |
| `0x04` | role | server→client | 1 byte: `0` = read-only (viewer, or doc trashed), `1` = editor/owner. Sent on connect **and again mid-session** whenever effective access changes (role/`everyone_role` edit, trash, restore) — the client must apply it live. |

The Yjs fragment name is **`blocknote`** — client binds
`ydoc.getXmlFragment('blocknote')`, server reads `get_or_insert_xml_fragment("blocknote")`.
(Canvas docs — `kind = 'canvas'` — reuse this exact sync socket but store a tldraw document
under `ydoc.getMap('tldraw')` instead; the server never interprets it. See Phase 3 below.)

**Persistence & compaction**: every incoming `0x00` inserts a `doc_updates` row and bumps
`docs.updated_at`. Compaction (merge all rows into one via yrs, refresh `content_text` and
`doc_links` from the XML, broadcast `doc.updated`) runs when the last connection leaves
the room, lazily on room open, and **mid-session every 200 persisted updates** — so an
always-open tab can't grow the log unboundedly. Rows carry a `compacted` flag (migration
`0003`): when no uncompacted rows exist, compaction is a no-op — no merge, no event, no
`updated_at` change, so merely viewing a doc never reorders doc lists. yrs merges run on
the blocking thread pool. Update frames are capped at 512 KB (oversized ⇒ socket closed);
awareness frames over 64 KB are dropped silently. If persisting an update fails, the frame
is not relayed and the socket is closed so the client resyncs from DB state.

**Access revocation is live**: channel-member role changes, per-doc role/`everyone_role` changes,
trash and restore push a
fresh `0x04` to open sessions (and flip server-side update dropping instantly); loss of
access (`none` or channel removal/leave) and permanent deletion close the socket server-side. A closed client's
reconnect gets 403/404 on upgrade — after a few consecutive upgrade failures the client
must stop retrying and treat the doc as unavailable. A slow consumer whose send queue
fills (1024 frames) is evicted from the room.

## Main-WS event additions (existing `/api/v1/ws` socket)

- `doc.created` `{doc: Doc}` — to channel members (per-viewer `my_role`, like `channel.created`'s `dm_user`). Members whose role resolves to `none` receive a **redacted** doc (`title`/`icon`/`preview` empty, `my_role: "none"`) — the client uses it purely to drop the doc from its UI.
- `doc.updated` `{doc: Doc}` — meta changes (rename/icon/roles/restore) + after non-empty compaction (same `none` redaction)
- `doc.deleted` `{doc_id, channel_id, permanent: boolean}` — trash or hard delete
- `doc.mention` `{mention: DocMention}` — to the mentioned user only

## Content bridging

- **Doc chips in chat**: message content may contain `[[doc:<uuid>|<title>]]`,
  `[[canvas:<uuid>|<title>]]`, or `[[board:<uuid>|<title>]]`. The
  composer opens a doc picker on typing `[[` (searches `/docs/search`; boards are excluded
  from this autocomplete in v1); the renderer
  replaces the token with a clickable chip navigating to `/d/<uuid>` (doc), `/x/<uuid>`
  (canvas), or `/b/<uuid>` (board, 🗂️). Plain text
  otherwise — search and the API are unaffected. A "Share to channel" action on a doc
  posts such a message via the normal messages endpoint. `notify.rs` strips these resource
  tokens when building notification previews.
- **Doc links in docs**: custom BlockNote inline content `doclink` with props
  `{docId, title}`, inserted via a `[`-triggered picker inside the editor (BlockNote
  suggestion menus key on a single character). Serialized into
  the Yjs XML as a `<doclink docId="…"/>` element — that's what compaction scans for
  backlinks.
- **People mentions in docs**: custom BlockNote inline content `mention` with props
  `{userId, name}`, inserted via `@` suggestion menu (channel members). On insert the
  client calls `POST /docs/{id}/mentions`; the server persists it and emits `doc.mention`.
  Delivery mirrors chat: recipients online get toast + OS popup (unless DND / already
  viewing the doc); offline recipients get **web push** (deep-links by doc kind: `/d/`
  doc, `/x/` canvas, `/b/` board). Push payloads carry an explicit `path` the service
  worker navigates to.

## Web UI (docs mode)

- **Mode rail**: thin far-left rail with icons — Chat (`#`), Docs, Canvas, and Board (🗂️) —
  switching between the chat, docs, canvas, and board UIs. Routes: chat keeps `/`, `/c/:channelId`;
  docs adds `/docs` (home: recent docs + my mentions inbox), `/docs/c/:channelId` (channel
  doc list + trash), `/d/:docId` (editor); canvas adds `/canvas`, `/x/:docId`; board adds
  `/board` (home), `/board/c/:channelId` (channel board list + trash), `/b/:docId` (editor),
  plus an in-channel `/c/:channelId/board` gallery. Each rail
  icon carries its own unread badge: Chat = unread chat notifications; Docs = unread
  mentions on `kind:'doc'` docs; Canvas = unread mentions on `kind:'canvas'` docs; Board =
  unread mentions on `kind:'board'` docs.
- **Docs sidebar**: channels (member ones) with their doc lists, new-doc button, trash
  section per channel, mentions inbox link.
- **Editor page**: emoji icon + borderless title input (debounced PATCH), BlockNote
  editor bound to the doc's Y.Doc fragment, presence avatars from awareness, share-to-
  channel action, role manager modal (owner only), backlinks list, read-only banner for
  viewers, trashed banner with restore. Editors can paste, drop, or select raster images;
  BlockNote uploads them through `/docs/{id}/uploads` and persists the authenticated proxied
  `/files/{id}` URL in Yjs. Rendering resolves that URL to a short-lived local blob URL.
- **Provider**: custom `SharpDocProvider` in `web/src/lib/docSync.ts` implementing the
  frame protocol over WebSocket with reconnect+backoff, exposing a `y-protocols`
  `Awareness` instance for BlockNote's `collaboration.provider`.
- Cursor colors are derived deterministically from the user id.

