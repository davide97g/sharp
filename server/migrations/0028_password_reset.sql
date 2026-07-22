-- Self-service password reset. Tokens are stored as SHA-256 hashes of the raw
-- secret e-mailed to the user, so a DB leak alone can't reset anyone's password.
CREATE TABLE password_reset_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_expires ON password_reset_tokens(expires_at);
