-- Varios calendarios por setter (migra el calendar_id único al array)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS calendar_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE accounts SET calendar_ids = to_jsonb(ARRAY[calendar_id])
  WHERE calendar_id <> '' AND calendar_ids = '[]'::jsonb;

-- Minutos para reactivar el bot tras intervención humana (0 = queda pausado hasta reactivar a mano)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auto_handoff_minutes INT NOT NULL DEFAULT 0;

-- Por qué se pausó la conversación (humano / ia / manual) para decidir la reactivación
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS paused_by TEXT NOT NULL DEFAULT '';
