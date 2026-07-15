-- Profile pictures and chat-layout preference.

-- Proxied avatar URL, e.g. /api/v1/users/<id>/avatar?v=<token>; null = no custom avatar.
ALTER TABLE users ADD COLUMN avatar_url text;
-- Content-type of the stored avatar object (so the proxy serves it correctly).
ALTER TABLE users ADD COLUMN avatar_content_type text;

-- Preferred DM rendering: 'bubble' (WhatsApp-style) or 'classic' (Slack-style rows).
-- Null means the user has not chosen yet (first-run chooser is shown).
ALTER TABLE user_prefs ADD COLUMN chat_layout text;
