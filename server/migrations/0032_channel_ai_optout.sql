-- Per-channel opt-out from the Sharpy (AI) index.
--
-- A channel can be readable by the assistant's asker and still be somewhere its
-- contents should not be summarised, quoted back, or embedded at all. This is a
-- channel-level property rather than a personal preference: the whole point is
-- that nobody's question can surface this channel's content.
--
-- Enforced in three places (server/src/routes/sharpy.rs): the embed worker
-- skips these channels, retrieval joins them out, and turning the flag on
-- deletes any embeddings already stored.
ALTER TABLE channels
    ADD COLUMN ai_excluded boolean NOT NULL DEFAULT false;
