CREATE TABLE polls (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    creator_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_message_id    bigint REFERENCES messages(id) ON DELETE SET NULL,
    question           text NOT NULL,
    multi              boolean NOT NULL DEFAULT false,
    pinned             boolean NOT NULL DEFAULT false,
    expires_at         timestamptz,
    closed_at          timestamptz,
    closed_reason      text,
    closed_notified_at timestamptz,
    deleted_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX polls_channel_open_idx ON polls (channel_id)
    WHERE closed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX polls_expiry_idx ON polls (expires_at)
    WHERE closed_at IS NULL AND deleted_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE poll_options (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id  uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    position smallint NOT NULL,
    text     text NOT NULL,
    UNIQUE (poll_id, position)
);

CREATE TABLE poll_votes (
    poll_id   uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    voted_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE INDEX poll_votes_poll_idx ON poll_votes (poll_id);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('mention','dm','reply','poll_ended'));
