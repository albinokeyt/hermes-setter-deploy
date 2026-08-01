-- Varias capturas por reporte de error (lista de data-URLs). La columna vieja `imagen` se
-- conserva para los reportes antiguos; los nuevos guardan todo en `imagenes`.
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS imagenes JSONB NOT NULL DEFAULT '[]'::jsonb;
