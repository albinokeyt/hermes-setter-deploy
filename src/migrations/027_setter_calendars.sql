-- Calendarios que cuentan como "agenda" POR SETTER (cada setter mide su propio objetivo de agendar).
-- SIN respaldo: si un setter no elige ninguno, ese setter NO mide agendas (su objetivo no es agendar).
-- La agenda la reclama el setter que atendió la conversación, solo si la reserva es en un calendario suyo.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS calendar_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill (una vez): los setters heredan los calendarios que su conexión ya tuviera elegidos,
-- para no romper los setups existentes que agendaban.
UPDATE setters s SET calendar_ids = a.calendar_ids
  FROM accounts a
  WHERE s.account_id = a.id
    AND a.calendar_ids IS NOT NULL AND a.calendar_ids <> '[]'::jsonb
    AND (s.calendar_ids IS NULL OR s.calendar_ids = '[]'::jsonb);
