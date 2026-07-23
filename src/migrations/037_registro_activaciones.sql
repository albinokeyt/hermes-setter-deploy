-- Registro de ACTIVACIONES por etiqueta: cada vez que una etiqueta activa a un setter para un contacto
-- se guarda una fila. Sirve para ver en vivo, en la sección Activaciones: qué activaciones llegaron,
-- el temporizador que falta para que el setter hable (respond_at), y luego el mensaje que respondió.
--   status: 'esperando' (cuenta atrás hasta respond_at) | 'respondido' (con el mensaje) | 'descartado' (motivo)
CREATE TABLE IF NOT EXISTS activation_log (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL,
  setter_id INT,
  conversation_id INT,
  contact_id TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  contexto TEXT NOT NULL DEFAULT '',
  wait_seconds INT NOT NULL DEFAULT 0,
  respond_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'esperando',
  message TEXT NOT NULL DEFAULT '',
  motivo TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activation_log_setter ON activation_log (setter_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activation_log_conv ON activation_log (conversation_id) WHERE status = 'esperando';
