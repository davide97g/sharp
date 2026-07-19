CREATE TABLE e2ee_devices (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT '',
    x25519_pub text NOT NULL,
    ed25519_pub text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX e2ee_devices_user_idx ON e2ee_devices (user_id);

CREATE TABLE e2ee_backups (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    salt text NOT NULL,
    nonce text NOT NULL,
    ciphertext text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE messages ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
