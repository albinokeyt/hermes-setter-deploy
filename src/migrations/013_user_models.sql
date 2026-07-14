-- Marca si una API de IA está disponible para usuarios normales (no solo admins).
ALTER TABLE providers ADD COLUMN IF NOT EXISTS user_available BOOLEAN NOT NULL DEFAULT false;
