-- Calendario que cuenta como "agenda" para esta cuenta. Vacío = cualquier calendario.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS calendar_id TEXT NOT NULL DEFAULT '';
