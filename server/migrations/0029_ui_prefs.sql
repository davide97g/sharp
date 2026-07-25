-- Generic per-user UI preference blob.
--
-- Every appearance-ish preference so far (theme, rail position, dock auto-hide,
-- sounds) lived only in the browser's localStorage, so nothing followed a user
-- across devices, and every server-side preference needed its own column plus
-- three hand-edited SQL statements. This column is the escape hatch: an opaque
-- JSON object owned by the client, merged shallowly at the top level on PATCH,
-- and size-capped by the handler (see routes/notifications.rs::patch_ui_prefs).
--
-- Deliberately opaque to the server: no schema, no CHECK, no validation beyond
-- "is a JSON object under N bytes". The client (web/src/lib/uiPrefs.ts) owns the
-- shape and its own defaults, so adding a preference never needs a migration.
ALTER TABLE user_prefs
    ADD COLUMN ui jsonb NOT NULL DEFAULT '{}'::jsonb;
