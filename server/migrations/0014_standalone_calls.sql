CREATE TABLE standalone_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
    link_token text NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX standalone_calls_creator_idx
    ON standalone_calls (created_by, created_at DESC);

ALTER TABLE meetings ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE meetings
    ADD COLUMN standalone_call_id uuid REFERENCES standalone_calls(id) ON DELETE CASCADE;
ALTER TABLE meetings
    ADD CONSTRAINT meetings_context_check CHECK (
        (channel_id IS NOT NULL AND standalone_call_id IS NULL)
        OR (channel_id IS NULL AND standalone_call_id IS NOT NULL)
    );

CREATE INDEX meetings_standalone_started_idx
    ON meetings (standalone_call_id, started_at DESC)
    WHERE standalone_call_id IS NOT NULL;
CREATE INDEX meetings_active_standalone_idx
    ON meetings (standalone_call_id)
    WHERE status = 'active' AND standalone_call_id IS NOT NULL;
