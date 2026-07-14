-- El setter solo responde a leads cuyo contacto de GHL tenga estas etiquetas.
-- Vacío = responde a todos. Modo 'any' = cualquiera de ellas; 'all' = todas.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS required_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS required_tags_mode TEXT NOT NULL DEFAULT 'any';
