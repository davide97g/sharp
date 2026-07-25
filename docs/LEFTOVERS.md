# Leftovers — deferred work and intentional non-features

Two lists. The first is work nobody has done yet. The second is behavior that **looks** like a
gap but is a decision — do not "fix" those without asking; see also the `docs/arch/*` sections
they point at.

Verified against the tree on 2026-07-25.

## Intentional non-features — leave them alone

- **Multi-workspace / tenancy.** Single workspace, no scoping column anywhere. The schema keeps
  it addable; nothing assumes it exists. See `ARCHITECTURE.md` invariant 5.
- **Canvas backlinks and full-text search.** Compaction deliberately skips text/link extraction
  for `kind = 'canvas'`, so `content_text` stays empty and no `doc_links` rows are written —
  canvas search matches on title only. See [arch/03-canvas-board.md](arch/03-canvas-board.md).
- **Encrypted DMs are invisible to the server.** They are never embedded for Sharpy, never
  searchable, and never previewed in a push payload. See [arch/09-e2ee.md](arch/09-e2ee.md).
- **No admin password reset.** Passwords are argon2 and unrecoverable; the only path is the
  self-service email flow. See [arch/01-core.md](arch/01-core.md).
- **One-time desktop-login codes are per-replica and in-process.** Not a bug — they live 60s and
  a retry re-mints. See [arch/01-core.md](arch/01-core.md).
- **`TODO(ds)` comments in `web/src/components/`** mark places a design-system primitive was
  deliberately *not* used, with the reason inline. See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## Not started

### Notifications
- **`@here`** — only per-user `@Display Name` and `@all` notify today.
- **Email digests** — transactional email exists (`server/src/mailer.rs`, used by password
  reset) but nothing mails an offline mention/DM digest.
- **Read-on-view** — the notification panel marks read on click and on "mark all"; it does not
  auto-mark-read on open. Decide the desired behavior before implementing.
- **Device verification gaps** — web push (VAPID sign → encrypted payload → service worker) and
  native APNs were validated by construction, not against physical devices. APNs additionally
  needs a signed/notarized build with the `aps-environment` entitlement; unsigned builds fall
  back silently. Manual pass needed: install the PWA, grant permission, close it, trigger a DM.

### File uploads
- **Orphaned upload GC** — a file uploaded but never attached keeps its object and a `files` row
  with `message_id IS NULL` forever. `Storage::delete` already exists and is unused
  (`server/src/storage.rs`); a periodic sweep of pending rows older than N hours is all it needs.
- **Purge on message delete** — soft-deleting a message leaves its attachments reachable via
  `/files/{id}`. A privacy decision, then wire `Storage::delete`.
- **Image dimensions** — `width`/`height` are not stored, so image messages shift layout on load.
- **Client-side size/type guard** — the server enforces `MAX_UPLOAD_MB`; the client uploads
  first and surfaces the error.
- **Thumbnails/transcoding**, **antivirus scanning**, **per-attachment remove after send**, and
  **whole-window drag-and-drop** are all unimplemented.
