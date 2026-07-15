-- WhatsApp-style quote replies: a message may reference another message in the
-- same channel. Distinct from parent_id (threads); replies here stay top-level.
ALTER TABLE messages ADD COLUMN reply_to_id bigint REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX messages_reply_to_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
