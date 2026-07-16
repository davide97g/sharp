ALTER TABLE channels ADD COLUMN voice_link_token text;
CREATE UNIQUE INDEX channels_voice_link_token_idx ON channels (voice_link_token) WHERE voice_link_token IS NOT NULL;
