CREATE TABLE meetings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'interrupted')),
    summary_status text NOT NULL DEFAULT 'pending'
        CHECK (summary_status IN ('pending', 'ready', 'failed', 'unavailable')),
    summary text NOT NULL DEFAULT '',
    decisions text NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    last_activity_at timestamptz NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meetings_channel_started_idx ON meetings (channel_id, started_at DESC);
CREATE INDEX meetings_active_channel_idx ON meetings (channel_id) WHERE status = 'active';

CREATE TABLE meeting_attendance (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    display_name text NOT NULL,
    guest boolean NOT NULL DEFAULT false,
    joined_at timestamptz NOT NULL,
    left_at timestamptz,
    UNIQUE (meeting_id, connection_id)
);

CREATE INDEX meeting_attendance_meeting_idx ON meeting_attendance (meeting_id, joined_at);

CREATE TABLE meeting_transcript_phrases (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    attendance_id uuid REFERENCES meeting_attendance(id) ON DELETE SET NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    display_name text NOT NULL,
    guest boolean NOT NULL DEFAULT false,
    text text NOT NULL,
    spoken_at timestamptz NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);

CREATE INDEX meeting_transcript_meeting_idx
    ON meeting_transcript_phrases (meeting_id, spoken_at, id);
CREATE INDEX meeting_transcript_search_idx ON meeting_transcript_phrases USING GIN (search);

CREATE TABLE meeting_action_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text text NOT NULL,
    assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    completed boolean NOT NULL DEFAULT false,
    position integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_action_items_meeting_idx
    ON meeting_action_items (meeting_id, position, created_at);
