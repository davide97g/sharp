-- sharp Phase 2: docs (Affine-style collaborative knowledge base)

CREATE TABLE docs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT '',
    icon text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    everyone_role text NOT NULL DEFAULT 'editor'
        CHECK (everyone_role IN ('editor', 'viewer', 'none')),
    content_text text NOT NULL DEFAULT '',
    search tsvector GENERATED ALWAYS AS
        (to_tsvector('simple', title || ' ' || content_text)) STORED
);

CREATE INDEX docs_channel_updated_idx ON docs (channel_id, updated_at DESC);
CREATE INDEX docs_search_idx ON docs USING GIN (search);

CREATE TABLE doc_updates (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_updates_doc_idx ON doc_updates (doc_id, id);

CREATE TABLE doc_roles (
    doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('editor', 'viewer', 'none')),
    PRIMARY KEY (doc_id, user_id)
);

CREATE TABLE doc_links (
    doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    target_doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, target_doc_id)
);

CREATE TABLE doc_mentions (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    doc_id uuid NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    from_user uuid NOT NULL REFERENCES users(id),
    to_user uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
);

CREATE INDEX doc_mentions_inbox_idx ON doc_mentions (to_user, read_at);
