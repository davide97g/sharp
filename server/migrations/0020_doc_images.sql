-- Image attachments embedded in collaborative docs.

ALTER TABLE files
    ADD COLUMN doc_id uuid REFERENCES docs(id) ON DELETE CASCADE;

ALTER TABLE files
    ADD CONSTRAINT files_single_parent_check
    CHECK (message_id IS NULL OR doc_id IS NULL);

CREATE INDEX files_doc_id_idx ON files (doc_id) WHERE doc_id IS NOT NULL;

-- Message uploads are pending only while they belong to neither a message nor a doc.
DROP INDEX files_pending_idx;
CREATE INDEX files_pending_idx ON files (channel_id, user_id)
    WHERE message_id IS NULL AND doc_id IS NULL;
