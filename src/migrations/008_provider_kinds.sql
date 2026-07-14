-- Cada API puede servir para texto (chat), imagen (visión) y/o audio (transcripción).
-- Las existentes quedan marcadas para las tres para no romper nada; se pueden acotar.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS kinds JSONB NOT NULL DEFAULT '["text","image","audio"]'::jsonb;
