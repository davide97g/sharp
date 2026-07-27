-- Social sign-in (Google, GitHub): provider identities, plus the one-time code
-- that hands a completed OAuth callback back to the SPA.

-- A user created through a social provider has no password. Password login,
-- password reset and passkey enrolment all treat NULL as "no password set".
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One row per (provider, provider account). The provider's stable subject id is
-- the identity — never the email, which users can change at the provider.
CREATE TABLE oauth_accounts (
    provider text NOT NULL CHECK (provider IN ('google', 'github')),
    provider_user_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Email as the provider reported it at link time, for display only.
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX oauth_accounts_user ON oauth_accounts (user_id);
-- At most one account per provider per user.
CREATE UNIQUE INDEX oauth_accounts_user_provider ON oauth_accounts (user_id, provider);

-- Short-lived, single-use handoff codes. The OAuth callback is a browser
-- redirect, so it cannot deliver a JWT to the SPA without putting it in a URL;
-- it redirects with one of these instead and the SPA exchanges it for the real
-- token. Stored as SHA-256 so a DB leak alone is not a live credential, and in
-- Postgres rather than in-process so any replica can complete the exchange.
CREATE TABLE auth_handoff_codes (
    code_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
