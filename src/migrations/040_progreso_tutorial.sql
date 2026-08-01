-- Progreso del tutorial guiado por usuario: el admin ve quién lo hizo y hasta dónde llegó.
CREATE TABLE IF NOT EXISTS tour_progress (
  user_key TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT '',
  paso INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 1,
  completado_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
