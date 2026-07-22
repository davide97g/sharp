-- Granular notification preferences: per-type toggles, scheduled Do-Not-Disturb
-- (quiet hours), and a per-channel notification mode (all / mentions / muted).

-- Per-type toggles + scheduled DND on the global per-user prefs row.
ALTER TABLE user_prefs
    ADD COLUMN notify_dm      boolean NOT NULL DEFAULT true,
    ADD COLUMN notify_mention boolean NOT NULL DEFAULT true,
    ADD COLUMN notify_reply   boolean NOT NULL DEFAULT true,
    ADD COLUMN notify_task    boolean NOT NULL DEFAULT true,
    ADD COLUMN notify_poll    boolean NOT NULL DEFAULT true,
    ADD COLUMN dnd_scheduled  boolean NOT NULL DEFAULT false,
    -- Quiet-hours window as minutes-of-day in [0,1440) in the user's local time.
    -- The window may wrap past midnight (start > end). NULL until configured.
    ADD COLUMN dnd_start      integer,
    ADD COLUMN dnd_end        integer,
    -- Minutes east of UTC for the user's local clock, so the server can evaluate
    -- the quiet-hours window (the client sends its current offset on save).
    ADD COLUMN tz_offset      integer NOT NULL DEFAULT 0;

-- Per-channel notification mode. 'all' = every triggering event, 'mentions' =
-- only mentions/replies, 'muted' = nothing. Back-fill from the legacy boolean;
-- `muted` is kept in sync so existing reads keep working.
ALTER TABLE channel_prefs
    ADD COLUMN mode text NOT NULL DEFAULT 'all'
        CHECK (mode IN ('all', 'mentions', 'muted'));
UPDATE channel_prefs SET mode = 'muted' WHERE muted = true;
