-- sharp v1 schema

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
    topic text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX channels_name_unique ON channels (lower(name)) WHERE kind <> 'dm';

CREATE TABLE channel_members (
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id bigint NOT NULL DEFAULT 0,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE messages (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id),
    parent_id bigint REFERENCES messages(id),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

CREATE INDEX messages_channel_id_idx ON messages (channel_id, id DESC);
CREATE INDEX messages_parent_id_idx ON messages (parent_id);
CREATE INDEX messages_search_idx ON messages USING GIN (search);

CREATE TABLE reactions (
    message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);
