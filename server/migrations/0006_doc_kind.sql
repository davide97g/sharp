-- sharp: add a `kind` discriminator to docs so the same table + sync pipeline can
-- store either a blocknote doc ('doc') or a tldraw canvas ('canvas'). Phase 3.
ALTER TABLE docs ADD COLUMN kind text NOT NULL DEFAULT 'doc'
    CHECK (kind IN ('doc', 'canvas'));
