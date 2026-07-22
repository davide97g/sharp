-- Apple Push Notification service device tokens for the native macOS (Tauri)
-- desktop app, so it receives push while closed. One row per device token.
-- Mirrors expo_push_tokens; inert unless the server has APNS_* configured.
CREATE TABLE apns_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,               -- hex APNs device token
    platform text NOT NULL DEFAULT 'macos',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX apns_tokens_user_idx ON apns_tokens (user_id);
