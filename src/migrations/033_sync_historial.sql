-- Antes de responder, re-leer el historial del contacto en GHL (entrantes y salientes: humano,
-- CTAs, otra herramienta tipo ManyChat en el mismo IG) para que el setter no responda sin contexto.
-- Opcional por setter (cuesta una llamada extra a GHL por respuesta).
ALTER TABLE setters ADD COLUMN IF NOT EXISTS sync_history BOOLEAN NOT NULL DEFAULT false;
