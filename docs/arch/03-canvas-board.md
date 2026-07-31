# Phase 3 — Canvas (edgeless whiteboard)

> Part of the sharp architecture contract. Index: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
> Canvas (tldraw) and Board (kanban) doc kinds. Both are `docs` rows with a different `kind` — read 02-docs.md first; only the deltas are here.

Collaborative tldraw whiteboards, built entirely on the Phase 2 doc foundation: a canvas
**is a `docs` row with `kind = 'canvas'`** (migration `0006_doc_kind.sql`). It reuses the
doc REST surface, the per-channel + per-doc role model, trash/restore, and the
`/api/v1/docs/{id}/sync` WebSocket **unchanged**.

- **Editor**: `tldraw` v5 — full edgeless toolset (draw, shapes, arrows, text, sticky
  notes, images) with live multiplayer cursors.
- **Sync**: the doc-sync socket is content-agnostic (raw Yjs v1 bytes + `yrs` merge). A
  canvas stores its tldraw document as whole `TLRecord`s in `ydoc.getMap('tldraw')` —
  document-scope records only, so each viewer keeps its own camera/selection. The client
  binds it with `useYjsTldrawStore` (`web/src/lib/tldrawYjs.ts`) over the shared
  `SharpDocProvider`; presence rides the existing `y-protocols` awareness.
- **Compaction**: `compact_doc` still merges the update log for canvases, but **skips the
  blocknote text/link extraction** — `content_text` stays empty and no `doc_links` are
  written, so canvas search matches on title only and canvases have no backlinks.
- **Wire**: `Doc` carries `kind`; `POST /channels/{id}/docs` accepts optional `kind`.
  `doc.created`/`doc.updated` carry `kind`, so clients route to the doc editor (`/d/:id`)
  or the canvas editor (`/x/:id`).
- **Web**: a third **Canvas** mode in the rail; `web/src/components/canvas/` mirrors
  `components/docs/` (Home / channel list / sidebar / editor). The tldraw editor chunk is
  lazy-loaded, and tldraw assets are **self-hosted** (bundled by Vite) — no CDN dependency.

# Phase 3.5 — Boards (Notion-style kanban)

Collaborative kanban boards, the third doc kind — built on the same Phase 2 doc foundation
as canvas: a board **is a `docs` row with `kind = 'board'`** (migration
`0021_board_kind.sql`). It reuses the doc REST surface, the per-channel + per-doc role
model, trash/restore, mentions, and the `/api/v1/docs/{id}/sync` WebSocket **unchanged**.
Cards are lightweight items (not docs/pages): a title plus configurable properties,
rendered as tiles in columns. One view in v1: grouped by a status single-select.

- **Sync**: the doc-sync socket is content-agnostic (raw Yjs v1 bytes + `yrs` merge); the
  server never interprets board content. All board logic is client-side Yjs, in one Y.Doc
  per board:
  - `ydoc.getMap('board')` — schema/meta: `properties: Y.Array<Y.Map>` — each
    `{ id, type: 'select'|'multiSelect'|'date'|'assignee', name, options?: Y.Array<Y.Map{id,label,color}> }`
    where `color` is a **palette key** (`"blue"`), never a hex value. The status
    property's option order **is** the column order (no separate structure).
    `groupByPropertyId` names the select that drives columns (fixed to the seeded Status
    in v1, stored for future-proofing).
  - `ydoc.getMap('cards')` — cardId → `Y.Map{ id, title, description, order, values: Y.Map }`,
    plus two lazily-created arrays: `checklist: Y.Array<Y.Map{id,text,done}>` and
    `docRefs: Y.Array<Y.Map{id,docId,title,kind,icon}>`.
    `values` is keyed by propertyId: select → optionId; multiSelect → `Y.Array<optionId>`;
    date → `YYYY-MM-DD`; assignee → userId. A card's column is derived from
    `values[groupByPropertyId]`; a missing/dangling optionId falls into a synthetic
    leftmost "No status" column.
  - **Ordering** is via fractional-index strings (`web/src/lib/fracIndex.ts` `between()`,
    base-62; cardId tie-break); a move is a single-field write. LWW per field (Y.Map
    default). Deleting a column removes the option only — cards fall to uncategorized, no
    cascade.
  - **Seeding** is client-side, gated on the provider being `synced` (never over server
    state) and guarded by an empty-map check inside one transaction (first writer wins):
    Status select with Todo (gray) / In progress (blue) / Done (green).
- **Compaction**: `compact_doc` still merges the update log for boards, but — like canvases
  — **skips the blocknote text/link extraction**, so `content_text` stays empty and no
  `doc_links` are written: boards have title-only search and no backlinks.
- **Wire**: `Doc.kind` (and `DocMention.doc.kind`) is `'doc'|'canvas'|'board'`; `POST
  /channels/{id}/docs` accepts `kind: 'board'` (server `validate_kind` whitelists it).
  `doc.created`/`doc.updated` carry `kind`, so clients route to `/b/:id`.
- **Bridging**: `[[board:<uuid>|<title>]]` chips render a 🗂️ chip navigating to
  `/b/<uuid>`; board mentions deep-link (inbox + push) to `/b/`. Boards are excluded from
  the chat `[[` doc-link autocomplete in v1.
- **Web**: a fourth **Board** mode in the rail; `web/src/components/board/` mirrors
  `components/canvas/` (Home / channel list / sidebar / editor), plus board-specific
  `BoardColumn` / `BoardCard` / `CardPanel` / `PropertyControls` / `CustomizePanel` and a
  hand-rolled `useBoardDnd` (Pointer Events, no `@dnd-kit`). Colors resolve from an 8-key
  categorical palette (`web/src/lib/boardColors.ts`) into `--board-*` CSS tokens; keys, not
  hex, are stored in the Y.Doc. No heavy dependency, so the board chunk is not lazy-loaded.
- **Card doc references**: a card can point at any doc, canvas or board — `docRefs` above,
  written by `addCardDocRef`/`deleteCardDocRef` in `web/src/lib/boardDoc.ts`, one reference
  per target (re-adding is a no-op). The picker in `CardPanel` searches `/docs/search` and
  falls back to `/docs/recent`, so **permissions stay the server's business** and the board
  doc never queries the docs table. `title`/`kind`/`icon` are a snapshot taken at link time
  (a renamed target keeps its old label until re-linked); `docId` is the truth and the chip
  routes through `docRoute()` in `components/docs/DocSurface.tsx` — the one place that knows
  `/d/` vs `/x/` vs `/b/`. `BoardCard` shows a 📄 count. Card descriptions grow with their
  content rather than scrolling inside a fixed box.
- **Embedding in docs**: the doc editor's `/` slash menu has a **Board** item (group Media)
  that inserts a custom BlockNote block `boardembed` (`propSchema: { docId }`, content
  `none` — `web/src/components/docs/BoardEmbed.tsx`, spec wired in `docs/schema.tsx`).
  Unbound (`docId=''`) it renders an inline picker: search existing boards (channel list +
  `/docs/search`, board-filtered) or create one in the host doc's channel; bound, it mounts
  the full interactive `BoardEditorInner` (own `SharpDocProvider` per embed — same live
  board as the standalone `/b/:id` view) inside a non-editable island, with
  Customize / Open / Unlink chrome. Edit rights come from the **board's** role resolution
  (server ROLE frame), independent of the host doc's role; no access renders an in-place
  fallback. The block serializes to XML the compactor ignores, so embeds contribute
  nothing to search/backlinks. Ambient context (channel, viewer, host editability) reaches
  the block through `DocEmbedContext` provided by `DocEditorInner`.

