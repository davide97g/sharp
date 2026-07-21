CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE message_embeddings (
  message_id bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_embeddings_channel_idx ON message_embeddings (channel_id);

CREATE TABLE doc_embeddings (
  doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  chunk_text text NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (doc_id, chunk_index)
);

CREATE TABLE doc_embedding_state (
  doc_id uuid PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  sources jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (conversation_id, id);
