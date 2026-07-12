-- Notifications (inbox), per-channel + global preferences, web-push subscriptions.

CREATE TABLE notifications (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- recipient
    kind text NOT NULL CHECK (kind IN ('mention', 'dm', 'reply')),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who triggered it
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
    preview text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
);

CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Per-channel mute (absence of row = not muted).
CREATE TABLE channel_prefs (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, channel_id)
);

-- Global per-user preferences (absence of row = defaults).
CREATE TABLE user_prefs (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dnd boolean NOT NULL DEFAULT false
);

-- Web-push (RFC 8291) subscriptions; one row per browser endpoint.
CREATE TABLE push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Small key/value store for server-managed secrets (e.g. auto-generated VAPID keys).
CREATE TABLE app_meta (
    key text PRIMARY KEY,
    value text NOT NULL
);
