-- Exclusión de las IAs (filtro negativo, opuesto a required_tags):
-- exclude_tag (conexión): si el contacto de GHL tiene esta etiqueta, NINGÚN setter le responde.
-- excluded_tags (setter): etiquetas por las que ESE setter en concreto no atiende al lead.
-- Vacío = sin exclusión (no añade coste: el gate solo consulta GHL si hay algo configurado).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS exclude_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE setters ADD COLUMN IF NOT EXISTS excluded_tags JSONB NOT NULL DEFAULT '[]';
