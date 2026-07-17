-- ── Facturación: costo (lo que pagas) vs precio (lo que cobras al cliente) ──
-- price_in/price_out existentes = COSTO por 1M tokens. Los bill_* son el PRECIO al cliente;
-- si están vacíos, se aplica el margen porcentual (markup_percent) sobre el costo real.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS bill_in NUMERIC(10,4);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS bill_out NUMERIC(10,4);
-- audio e imagen se calculan distinto (por minuto/por imagen): costo y precio editables aparte
ALTER TABLE providers ADD COLUMN IF NOT EXISTS price_audio_min NUMERIC(10,4);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS bill_audio_min NUMERIC(10,4);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS price_image NUMERIC(10,4);
ALTER TABLE providers ADD COLUMN IF NOT EXISTS bill_image NUMERIC(10,4);

-- Lo FACTURADO al cliente por cada llamada (el dashboard del cliente muestra esto; el admin ve ambos)
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS billed_usd NUMERIC(12,6);
UPDATE llm_usage SET billed_usd = cost_usd WHERE billed_usd IS NULL;

-- ── Historial de versiones de los prompts del setter (volver atrás si un cambio salió mal) ──
CREATE TABLE IF NOT EXISTS prompt_versions (
  id SERIAL PRIMARY KEY,
  setter_id INT REFERENCES setters(id) ON DELETE CASCADE,
  prompt_identity TEXT NOT NULL DEFAULT '',
  prompt_business TEXT NOT NULL DEFAULT '',
  prompt_flow TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_setter ON prompt_versions (setter_id, id DESC);
