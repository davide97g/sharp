-- File attachments (S3-compatible object storage; rows here are the metadata).

CREATE TABLE files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id bigint REFERENCES messages(id) ON DELETE CASCADE, -- NULL until attached to a message
    user_id uuid NOT NULL REFERENCES users(id),                 -- uploader
    key text NOT NULL,                                          -- object key in the bucket
    filename text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX files_message_id_idx ON files (message_id);
-- pending (not-yet-attached) uploads, looked up on message create by uploader + channel
CREATE INDEX files_pending_idx ON files (channel_id, user_id) WHERE message_id IS NULL;
