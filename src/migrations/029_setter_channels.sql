-- Canales de atención POR SETTER (antes eran de la conexión): cada setter responde solo
-- en SUS canales. Los mensajes de todos los canales se siguen archivando a nivel conexión.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS channels JSONB NOT NULL DEFAULT '["IG","WhatsApp"]'::jsonb;

-- Backfill: cada setter hereda los canales que su conexión tenía elegidos (preserva el comportamiento).
UPDATE setters s SET channels = a.channels
  FROM accounts a
  WHERE s.account_id = a.id AND a.channels IS NOT NULL AND jsonb_typeof(a.channels) = 'array';
