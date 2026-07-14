-- Modelo Conexión → varios Setters.
-- 'accounts' pasa a ser la CONEXIÓN (subcuenta GHL: location_id, OAuth, calendarios, portal).
-- 'setters' son los bots/agentes que cuelgan de una conexión; el lead se enruta al
-- setter cuyo required_tags casa con las etiquetas del contacto en GHL.
CREATE TABLE IF NOT EXISTS setters (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Setter',
  is_default BOOLEAN NOT NULL DEFAULT false,   -- setter que atiende cuando ningún required_tags casa
  bot_enabled BOOLEAN NOT NULL DEFAULT true,
  weight INT NOT NULL DEFAULT 100,             -- desempate si varios setters casan
  required_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_tags_mode TEXT NOT NULL DEFAULT 'any',
  prompt_identity TEXT NOT NULL DEFAULT '',
  prompt_business TEXT NOT NULL DEFAULT '',
  prompt_flow TEXT NOT NULL DEFAULT '',
  provider_id INT REFERENCES providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.8,
  debounce_seconds INT NOT NULL DEFAULT 35,
  max_msgs INT NOT NULL DEFAULT 3,
  followups JSONB NOT NULL DEFAULT '[]'::jsonb,
  vision_enabled BOOLEAN NOT NULL DEFAULT false,
  vision_provider_id INT REFERENCES providers(id) ON DELETE SET NULL,
  vision_model TEXT NOT NULL DEFAULT '',
  audio_enabled BOOLEAN NOT NULL DEFAULT false,
  audio_provider_id INT REFERENCES providers(id) ON DELETE SET NULL,
  audio_model TEXT NOT NULL DEFAULT '',
  calendar_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_setters_account ON setters (account_id);

-- Backfill idempotente: 1 setter "principal" por cada conexión existente, copiando su config actual.
INSERT INTO setters (account_id, name, is_default, bot_enabled, weight,
  required_tags, required_tags_mode, prompt_identity, prompt_business, prompt_flow,
  provider_id, model, temperature, debounce_seconds, max_msgs, followups,
  vision_enabled, vision_provider_id, vision_model, audio_enabled, audio_provider_id, audio_model, calendar_ids)
SELECT a.id, 'Setter principal', true, a.bot_enabled, 100,
  a.required_tags, a.required_tags_mode, a.prompt_identity, a.prompt_business, a.prompt_flow,
  a.provider_id, a.model, a.temperature, a.debounce_seconds, a.max_msgs, a.followups,
  a.vision_enabled, a.vision_provider_id, a.vision_model, a.audio_enabled, a.audio_provider_id, a.audio_model, a.calendar_ids
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM setters s WHERE s.account_id = a.id);

-- Dimensión de setter en las tablas que hoy solo tienen account_id (nullable, aditivo).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS setter_id INT REFERENCES setters(id) ON DELETE SET NULL;
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS setter_id INT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS setter_id INT;
CREATE INDEX IF NOT EXISTS idx_conv_setter ON conversations (setter_id);

-- Conversaciones existentes → al setter principal de su conexión.
UPDATE conversations c SET setter_id = s.id
FROM setters s
WHERE s.account_id = c.account_id AND s.is_default AND c.setter_id IS NULL;
