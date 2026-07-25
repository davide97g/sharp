-- Disappearing messages.
--
-- The TTL is a property of the *channel* — everyone in a conversation shares
-- one retention rule, the way Signal and WhatsApp do it. A per-viewer setting
-- would be theatre: the other person's copy would still be there.
--
-- `expires_at` is stamped on each message at publish time from the channel's
-- TTL, rather than computed at read time from the channel's current setting.
-- That way changing (or clearing) the TTL never retroactively deletes history
-- that was posted under the old rule.
ALTER TABLE channels
    -- Minutes until a new message expires. NULL = keep forever (the default).
    ADD COLUMN message_ttl_minutes integer
        CHECK (message_ttl_minutes IS NULL OR message_ttl_minutes > 0);

ALTER TABLE messages
    ADD COLUMN expires_at timestamptz;

-- The sweep polls for due messages; without this it is a sequential scan of
-- every message in the workspace on every tick.
CREATE INDEX messages_expires_at_idx
    ON messages (expires_at)
    WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
