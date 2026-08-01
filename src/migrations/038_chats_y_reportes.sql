-- CHATS PERSISTENTES del arquitecto/corrector (tipo ChatGPT): conversaciones con nombre, retomables,
-- que NO se pierden al navegar a otra sección. Una fila por conversación; messages = [{role,text}].
CREATE TABLE IF NOT EXISTS editor_chats (
  id SERIAL PRIMARY KEY,
  setter_id INT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'architect',   -- 'architect' (crear prompt) | 'edit' (corrector/ingeniero)
  name TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_chats ON editor_chats (setter_id, mode, updated_at DESC);

-- CONVERSACIONES DE PRUEBA del playground, con las correcciones enviadas en cada una y la versión de
-- prompt con la que quedó (last_version = último prompt_versions.id del setter al guardar).
CREATE TABLE IF NOT EXISTS playground_chats (
  id SERIAL PRIMARY KEY,
  setter_id INT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  corrections JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{texto, fecha}]
  last_version INT,
  version_num INT,          -- número legible (v1, v2…) calculado al estampar: NO se recalcula después
                            -- (prompt_versions se poda a 30 y el número se desinflaría)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playground_chats ON playground_chats (setter_id, updated_at DESC);

-- REPORTES DE BUGS: los usuarios reportan errores (texto + captura); el admin los ve todos.
CREATE TABLE IF NOT EXISTS bug_reports (
  id SERIAL PRIMARY KEY,
  account_id INT,
  reporter TEXT NOT NULL DEFAULT '',        -- quién lo reportó (nombre/email o 'admin')
  tipo TEXT NOT NULL DEFAULT 'sistema',     -- 'sistema' | 'setter' | 'facturacion' | 'otro'
  descripcion TEXT NOT NULL,
  imagen TEXT NOT NULL DEFAULT '',          -- captura en data URL (comprimida en el cliente)
  status TEXT NOT NULL DEFAULT 'abierto',   -- 'abierto' | 'resuelto'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bug_reports ON bug_reports (account_id, id DESC);

-- Cinturón idempotente por si esta migración corrió con una versión anterior del fichero.
ALTER TABLE playground_chats ADD COLUMN IF NOT EXISTS version_num INT;

-- Contador MONÓTONO de versiones de prompt por setter: prompt_versions se poda a 30 filas, así que
-- contar filas para el «vN» se desinflaba con el tiempo. Este contador solo crece.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS prompt_version_seq INT NOT NULL DEFAULT 0;
UPDATE setters s SET prompt_version_seq = (SELECT COUNT(*) FROM prompt_versions pv WHERE pv.setter_id = s.id)
 WHERE prompt_version_seq = 0;
