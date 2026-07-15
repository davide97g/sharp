CREATE TABLE expo_push_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    platform text NOT NULL DEFAULT 'ios',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expo_push_tokens_user_idx ON expo_push_tokens (user_id);
