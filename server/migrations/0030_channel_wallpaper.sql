-- Per-user, per-channel chat wallpaper.
--
-- Lives on channel_prefs rather than in the user_prefs.ui blob because it is
-- naturally unbounded (one row per conversation you have decorated) and the ui
-- blob is size-capped. Like that blob, the value is opaque to the server: the
-- descriptor shape is owned by web/src/lib/wallpaper.ts.
--
-- NULL = no wallpaper, which is also what a missing channel_prefs row means.
ALTER TABLE channel_prefs
    ADD COLUMN wallpaper jsonb;
