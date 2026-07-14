-- Usuario restringido: si can_manage_agents = false, solo ve/usa los mensajes
-- (conversaciones), no puede configurar los setters ni probar el agente.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_manage_agents BOOLEAN NOT NULL DEFAULT true;

-- Comentarios entrantes de Instagram (recibidos por webhook desde una automatización de GHL).
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  post_ref TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'IG',
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_account ON comments (account_id, id DESC);
