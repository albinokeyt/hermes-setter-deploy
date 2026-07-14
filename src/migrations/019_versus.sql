-- Versus (ex-Competencias): comparar N setters (de cualquier conexión) sobre la MISMA
-- audiencia para ver cuál rinde mejor. Cuando un versus está activo, gobierna el enrutado
-- de su audiencia e IGNORA las etiquetas propias de cada setter (reparte por peso).
CREATE TABLE IF NOT EXISTS versus (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused | finished
  win_metric TEXT NOT NULL DEFAULT 'agendas',   -- agendas | calificacion | conversion
  audience TEXT NOT NULL DEFAULT 'all',          -- all = todos los leads entrantes | tag = con una etiqueta
  audience_tag TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_versus_status ON versus (status);

-- Setters que compiten en un versus (setters reales, con su peso de reparto dentro del versus).
CREATE TABLE IF NOT EXISTS versus_setters (
  id SERIAL PRIMARY KEY,
  versus_id INT NOT NULL REFERENCES versus(id) ON DELETE CASCADE,
  setter_id INT NOT NULL REFERENCES setters(id) ON DELETE CASCADE,
  weight INT NOT NULL DEFAULT 50,
  UNIQUE (versus_id, setter_id)
);
CREATE INDEX IF NOT EXISTS idx_versus_setters_v ON versus_setters (versus_id);
CREATE INDEX IF NOT EXISTS idx_versus_setters_s ON versus_setters (setter_id);

-- A qué versus pertenece cada conversación (para medir por versus sin doble conteo).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS versus_id INT REFERENCES versus(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conv_versus ON conversations (versus_id);
