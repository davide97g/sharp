# Leftovers — deferred work

Tracking what was intentionally skipped while shipping **file uploads** + **notifications**
(see `ARCHITECTURE.md` → "File uploads & Notifications"). Ordered roughly by priority.

## Roadmap features not started

- **Multi-workspace / tenancy** — single workspace remains (v1 assumption).

(Phase 2 docs and Phase 3 canvas have shipped — see `ARCHITECTURE.md`.)

## Phase 3 canvas — follow-ups

- **Canvas backlinks / full-text search** — intentional non-features: compaction skips
  blocknote text/link extraction for canvases, so `content_text` stays empty and no
  `doc_links` are written (canvas search matches on title only). See ARCHITECTURE.md → Phase 3.
- **Browser QA** — cross-kind routing (share chip, quick switcher, global search, in-doc
  link picker) and the editor kind-guard redirects (`/d/` ↔ `/x/`) were fixed and typecheck
  clean, but not yet exercised in a live browser. Do a manual pass: share a canvas to a
  channel (expect a 🎨 chip → `/x/`), open a canvas id at `/d/` (expect redirect to `/x/`),
  and confirm canvas mentions surface in the Canvas-mode inbox.

## Notifications — follow-ups

- **Email delivery (SMTP)** — not implemented. User chose in-app + web push + desktop
  only. Add an SMTP sender for offline mention/DM digests later.
- **`@here` / `@channel`** — only per-user `@Display Name` mentions notify today.
- **Per-channel notification *level*** — currently mute (on/off) + global DND. A Slack-style
  level (all / mentions-only / nothing) per channel is a natural extension of `channel_prefs`.
- **Notification read-on-view** — the bell dropdown marks read on click / "mark all";
  it does not auto-mark-read on open. Decide desired behavior.
- **Verification gaps needing a real browser**: the live `notification.created` WS event
  and end-to-end **web-push delivery** (VAPID sign → encrypted payload → browser SW) were
  validated by construction + automated server/web checks, but not against physical iOS and
  Android devices and their live browser push services. Do a manual pass on each: install the
  PWA, grant permission, close it, trigger a DM, and confirm the OS notification. VAPID keys
  auto-generate on first server start.

## File uploads — follow-ups

- **Orphaned upload GC** — a file uploaded but never attached (user cancels) stays in the
  bucket + a `files` row with `message_id IS NULL` forever. Add a periodic sweep
  (delete pending rows older than N hours + their objects). `Storage::delete` already exists.
- **Purge on message delete** — soft-deleting a message keeps its attachments reachable via
  `/files/{id}`. Decide whether delete should also remove the objects (privacy) and wire
  `Storage::delete`.
- **Image dimensions** — `width`/`height` are not stored, so image messages can cause a
  small layout shift on load. Extract dimensions on upload (image crate) if desired.
- **Client-side type/size guard** — the server enforces `MAX_UPLOAD_MB`; the client uploads
  first and surfaces the server error. Add a pre-upload size/type check for nicer UX.
- **Thumbnails / transcoding**, **antivirus scanning**, **per-attachment remove UI after
  send**, and **whole-window drag-and-drop** are all unimplemented.

## Merge / coordination notes

- This work lives on branch `worktree-notifications-files` (a git worktree), isolated from
  the parallel **docs** work. Merge back into `main` when ready.
- Migrations here are `0003_files.sql` + `0004_notifications.sql`. The docs branch uses
  `0002_docs.sql`. **Before merging, confirm no migration-version collision** and renumber
  if both branches grabbed the same number.
- Shared files edited by both branches (expect merge conflicts, both additive):
  `server/src/{models.rs, main.rs, routes/mod.rs, ws/mod.rs, state.rs}`,
  `web/src/{store.ts, lib/types.ts, lib/api.ts, App.tsx}`,
  `docs/ARCHITECTURE.md`, `server/Cargo.toml`, `web/package.json`.
