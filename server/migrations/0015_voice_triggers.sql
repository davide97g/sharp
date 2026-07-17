CREATE TABLE voice_triggers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phrase text NOT NULL,
    action text NOT NULL DEFAULT 'gif',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX voice_triggers_personal_uniq
    ON voice_triggers (user_id, phrase) WHERE channel_id IS NULL;
CREATE UNIQUE INDEX voice_triggers_channel_uniq
    ON voice_triggers (channel_id, phrase) WHERE channel_id IS NOT NULL;
CREATE INDEX voice_triggers_channel_idx ON voice_triggers (channel_id);
