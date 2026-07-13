CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  default_model TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location_id TEXT UNIQUE,
  mode TEXT NOT NULL DEFAULT 'oauth',
  pit_token TEXT NOT NULL DEFAULT '',
  webhook_token TEXT UNIQUE NOT NULL,
  channels JSONB NOT NULL DEFAULT '["IG","WhatsApp"]'::jsonb,
  prompt_identity TEXT NOT NULL DEFAULT '',
  prompt_business TEXT NOT NULL DEFAULT '',
  prompt_flow TEXT NOT NULL DEFAULT '',
  provider_id INT REFERENCES providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.8,
  debounce_seconds INT NOT NULL DEFAULT 35,
  max_msgs INT NOT NULL DEFAULT 3,
  followups JSONB NOT NULL DEFAULT '[]'::jsonb,
  active_hours JSONB NOT NULL DEFAULT '{"always": true, "start": "09:00", "end": "21:00"}'::jsonb,
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  sync_tags BOOLEAN NOT NULL DEFAULT true,
  auto_handoff BOOLEAN NOT NULL DEFAULT true,
  bot_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ghl_tokens (
  location_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  company_id TEXT,
  raw JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ghl_contact_id TEXT NOT NULL,
  ghl_conversation_id TEXT,
  channel TEXT NOT NULL DEFAULT 'IG',
  lead_name TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'nuevo',
  bot_paused BOOLEAN NOT NULL DEFAULT false,
  memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  followup_step INT NOT NULL DEFAULT 0,
  followup_state TEXT NOT NULL DEFAULT 'ninguno',
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, ghl_contact_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_conv_stage ON conversations (stage);
CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations (account_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'lead',
  body TEXT NOT NULL,
  ghl_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ghl_id ON messages (ghl_message_id) WHERE ghl_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stage_history (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stagehist_conv ON stage_history (conversation_id);
CREATE INDEX IF NOT EXISTS idx_stagehist_at ON stage_history (created_at);

CREATE TABLE IF NOT EXISTS webhook_log (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whlog_at ON webhook_log (created_at DESC);
