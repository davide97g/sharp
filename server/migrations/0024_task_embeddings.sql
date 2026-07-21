-- Sharpy retrieval over tasks (Phase 7D). One embedding per task; content is
-- identifier + title + description + comments, re-embedded when the hash drifts.
CREATE TABLE task_embeddings (
    task_id      uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    content      text NOT NULL,
    content_hash text NOT NULL,
    embedding    vector NOT NULL,
    embedded_at  timestamptz NOT NULL DEFAULT now()
);
