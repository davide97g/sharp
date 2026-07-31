-- Garden rework: a private, single-player focus space instead of a shared
-- spatial hub.
--
-- Everything Garden used to persist existed to coordinate *other people* —
-- plots per channel, admin-placed scenery, a workspace admin flag. None of it
-- has a reader any more: the garden is one fixed default world per user, nobody
-- else is in it, and no position or visit is stored.
--
-- The only durable state left is a running focus timer, because that is the one
-- fact that has to survive a reload: a countdown must resume with the right
-- remaining time even if the tab dies, and its authority has to be a server
-- clock rather than a client's.

-- --- Focus sessions --------------------------------------------------------
CREATE TABLE garden_focus_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 'countdown' runs to duration_secs; 'stopwatch' counts up with no end.
    mode text NOT NULL CHECK (mode IN ('countdown', 'stopwatch')),
    -- Countdown length. NULL for a stopwatch, enforced below rather than left to
    -- route code, so a malformed row cannot exist.
    duration_secs integer
        CHECK (duration_secs IS NULL OR (duration_secs > 0 AND duration_secs <= 86400)),
    -- Elapsed time is always derived from these two, never accumulated by a
    -- client, so a paused tab or a clock skew cannot inflate a session.
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT garden_focus_mode_duration CHECK (
        (mode = 'countdown' AND duration_secs IS NOT NULL)
        OR (mode = 'stopwatch' AND duration_secs IS NULL)
    )
);

-- One running session per person. A partial unique index rather than a check in
-- the route: two tabs starting a timer at once must not both win.
CREATE UNIQUE INDEX garden_focus_one_active
    ON garden_focus_sessions (user_id)
 WHERE ended_at IS NULL;

-- Reading "my finished sessions, newest first" is the only other access path.
CREATE INDEX garden_focus_user_recent_idx
    ON garden_focus_sessions (user_id, started_at DESC);

-- --- Retired multiplayer state ---------------------------------------------
-- Plots were derived from the channel list, so nothing here is user-authored
-- data that could be recovered later; the scenery rows were admin decoration
-- for a shared hub that no longer exists (per-user decoration will be its own
-- feature, with its own table, when it lands).
DROP TRIGGER IF EXISTS channels_allocate_garden_room ON channels;
DROP FUNCTION IF EXISTS allocate_garden_room();
DROP TABLE IF EXISTS garden_objects;
DROP TABLE IF EXISTS garden_rooms;

-- users.is_admin and its garden_seed_first_admin trigger (migration 0038) stay.
-- Creator mode was their only reader, but a workspace-admin flag that already
-- promotes the founder on both signup paths is worth keeping for the next
-- surface that needs one; dropping and re-adding it would lose that promotion.
