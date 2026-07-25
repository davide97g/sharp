-- Privacy preferences that the *server* has to enforce.
--
-- Deliberately real columns rather than keys in `user_prefs.ui`: that blob is
-- opaque to the server by contract (migration 0029), and these three change
-- what the server tells other people about you. A privacy control that only the
-- client honours is not a privacy control.
ALTER TABLE user_prefs
    -- Appear offline to everyone. Presence is derived from live WS connections,
    -- so this filters the derived list rather than dropping the connection.
    ADD COLUMN invisible boolean NOT NULL DEFAULT false,
    -- Broadcast "… is typing" to the channel. Opting out is one-way: you still
    -- see other people's indicators, matching how every other client behaves.
    ADD COLUMN share_typing boolean NOT NULL DEFAULT true,
    -- How much of a message may appear in an OS/browser push notification.
    -- 'generic' sends sender-less, content-less text — the notification tells
    -- you something arrived and nothing more.
    ADD COLUMN push_preview text NOT NULL DEFAULT 'full'
        CHECK (push_preview IN ('full', 'generic'));
