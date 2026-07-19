-- Optional WebAuthn/passkey authentication.

CREATE TABLE webauthn_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id bytea NOT NULL UNIQUE,
    passkey jsonb NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id, created_at);

CREATE TABLE webauthn_ceremonies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('register', 'authenticate')),
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    state jsonb NOT NULL,
    pending_name text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webauthn_ceremonies_expiry_idx ON webauthn_ceremonies (expires_at);

CREATE TABLE passkey_management_sessions (
    token_hash bytea PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('exchange_code', 'management_token')),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX passkey_management_sessions_expiry_idx
    ON passkey_management_sessions (expires_at);

ALTER TABLE users ADD COLUMN passkey_prompt_dismissed_at timestamptz;
