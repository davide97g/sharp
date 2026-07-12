-- sharp Phase 2 hardening: track which doc_updates rows are already compacted, and
-- index doc_links by target so backlink lookups don't scan the whole table.

-- New update rows default to `false`; compaction inserts its merged row as `true`.
-- This lets compaction skip work when nothing new has arrived (no updated_at churn).
ALTER TABLE doc_updates ADD COLUMN compacted boolean NOT NULL DEFAULT false;

CREATE INDEX doc_links_target_idx ON doc_links (target_doc_id);
