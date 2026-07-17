-- Tiempo de ENTRADA por setter: espera (segundos) antes de responder al PRIMER mensaje de un
-- lead nuevo. La espera de un CTA que case es DOMINANTE sobre este tiempo. 0 = debounce normal.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS entry_wait_seconds INT NOT NULL DEFAULT 0;

-- ACTIVADOR EXTERNO por setter: un workflow de GHL (p. ej. al asignar una etiqueta) hace POST al
-- webhook del setter → este lee el historial del contacto en GHL y escribe él solo.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS activation_enabled BOOLEAN NOT NULL DEFAULT false;
-- Token = secreto bearer que abre un webhook de ESCRITURA sin firma → generado con CSPRNG.
-- gen_random_uuid() es core en PostgreSQL >=13 y usa pg_strong_random (no requiere extensión).
ALTER TABLE setters ADD COLUMN IF NOT EXISTS activation_token TEXT NOT NULL
  DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
-- token distinto por setter existente (el DEFAULT se evalúa una vez por fila, pero forzamos regeneración)
UPDATE setters SET activation_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
CREATE INDEX IF NOT EXISTS idx_setters_activation ON setters (activation_token);
