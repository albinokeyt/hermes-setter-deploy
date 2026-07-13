CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id INT,
  ghl_appointment_id TEXT,
  ghl_contact_id TEXT NOT NULL DEFAULT '',
  calendar_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'agendado',
  start_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_ghl ON appointments (ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appt_account ON appointments (account_id, created_at);
