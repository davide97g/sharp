-- Personal nicknames: each viewer can rename any other user for themselves only.
-- Canonical users.display_name is unchanged; overrides resolve at read/render time.

CREATE TABLE user_nicknames (
    viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (viewer_id, target_user_id),
    CHECK (viewer_id <> target_user_id),
    CHECK (char_length(nickname) > 0 AND char_length(nickname) <= 320)
);

CREATE INDEX user_nicknames_target_idx ON user_nicknames (target_user_id);
