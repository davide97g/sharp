CREATE TABLE calendar_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  provider_email text NOT NULL,
  access_token_enc text NOT NULL,      -- AES-256-GCM, nonce-prefixed, base64
  refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_email)
);

CREATE TABLE calendar_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  summary text NOT NULL DEFAULT '',
  color text,
  is_primary boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  UNIQUE (account_id, external_id)
);

CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES calendar_calendars(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text, location text,
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'confirmed',
  html_link text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  reminded_lead_at timestamptz,        -- upsert must NEVER overwrite these two
  reminded_start_at timestamptz,
  UNIQUE (calendar_id, external_id)
);
CREATE INDEX calendar_events_window_idx ON calendar_events (start_at);

CREATE TABLE scheduled_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  standalone_call_id uuid REFERENCES standalone_calls(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  card_message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  reminded_lead_at timestamptz, reminded_start_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_meetings_context_check CHECK (
    (channel_id IS NOT NULL AND standalone_call_id IS NULL)
    OR (channel_id IS NULL AND standalone_call_id IS NOT NULL)
    OR (channel_id IS NULL AND standalone_call_id IS NULL)   -- pure calendar entry
  )
);
CREATE INDEX scheduled_meetings_start_idx ON scheduled_meetings (start_at);
CREATE INDEX scheduled_meetings_channel_idx ON scheduled_meetings (channel_id, start_at);

CREATE TABLE scheduled_meeting_attendees (
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response text NOT NULL DEFAULT 'needs_action'
    CHECK (response IN ('needs_action','accepted','declined','tentative')),
  PRIMARY KEY (meeting_id, user_id)
);
