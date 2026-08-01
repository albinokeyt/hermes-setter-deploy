-- Respuesta del admin a un reporte de error: el usuario la ve en su reporte.
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS respuesta TEXT NOT NULL DEFAULT '';
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS respondida_at TIMESTAMPTZ;
