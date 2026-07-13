-- Lectura de imágenes y transcripción de audios que envían los leads
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vision_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vision_provider_id INT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vision_model TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS audio_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS audio_provider_id INT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS audio_model TEXT NOT NULL DEFAULT '';
