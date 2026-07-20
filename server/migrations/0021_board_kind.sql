-- sharp: extend the docs `kind` discriminator with 'board' — a Notion-style
-- kanban living in the same table + sync pipeline as docs and canvases. Phase 6.
ALTER TABLE docs
  DROP CONSTRAINT IF EXISTS docs_kind_check;

ALTER TABLE docs
  ADD CONSTRAINT docs_kind_check
  CHECK (kind IN ('doc', 'canvas', 'board'));
