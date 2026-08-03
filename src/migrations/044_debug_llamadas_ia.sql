-- Detalle completo de cada llamada de IA que generó mensajes reales (solo lo consulta el admin):
-- input íntegro (system + historial), respuesta cruda, origen (respuesta/seguimiento/activación),
-- tokens, modelo y cuántos mensajes de historial leyó. Se poda a 30 días para no crecer sin fin.
CREATE TABLE IF NOT EXISTS llm_debug (
  id SERIAL PRIMARY KEY,
  conversation_id INT,
  source TEXT NOT NULL DEFAULT 'reply',
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd NUMERIC,
  history_count INT,
  activacion TEXT NOT NULL DEFAULT '',
  input JSONB NOT NULL DEFAULT '[]'::jsonb,
  output TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_debug_created_idx ON llm_debug (created_at);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gasto_debug_id INT;
