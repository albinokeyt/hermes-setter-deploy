-- Campañas de competencia: varios agentes se reparten los leads por peso (%)
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  win_metric TEXT NOT NULL DEFAULT 'agendas',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns (account_id, status);

CREATE TABLE IF NOT EXISTS campaign_variants (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight INT NOT NULL DEFAULT 50,
  prompt_identity TEXT NOT NULL DEFAULT '',
  prompt_business TEXT NOT NULL DEFAULT '',
  prompt_flow TEXT NOT NULL DEFAULT '',
  provider_id INT REFERENCES providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.8,
  max_msgs INT NOT NULL DEFAULT 3,
  debounce_seconds INT NOT NULL DEFAULT 35,
  followups JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_variants_campaign ON campaign_variants (campaign_id);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS campaign_id INT REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS variant_id INT REFERENCES campaign_variants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conv_variant ON conversations (variant_id);

ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS variant_id INT;
