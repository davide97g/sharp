ALTER TABLE docs
  DROP CONSTRAINT IF EXISTS docs_everyone_role_check;

ALTER TABLE docs
  ADD CONSTRAINT docs_everyone_role_check
  CHECK (everyone_role IN ('editor', 'viewer', 'none', 'inherit'));

ALTER TABLE docs
  ALTER COLUMN everyone_role SET DEFAULT 'inherit';
