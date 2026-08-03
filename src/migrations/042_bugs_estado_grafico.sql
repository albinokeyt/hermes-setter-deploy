-- Estados con "en curso", fecha de resolución (para el gráfico de incidencias/resoluciones por día)
-- y rastro de reclasificación (si el admin cambia el tipo, se guarda el original).
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS resuelto_at TIMESTAMPTZ;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS tipo_original TEXT NOT NULL DEFAULT '';
-- backfill: los ya resueltos cuentan como resueltos cuando se les respondió (o cuando se crearon)
UPDATE bug_reports SET resuelto_at = COALESCE(respondida_at, created_at) WHERE status = 'resuelto' AND resuelto_at IS NULL;
