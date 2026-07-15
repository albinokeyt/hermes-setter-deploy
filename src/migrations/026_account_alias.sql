-- Alias (nombre visible) de la conexión. Si está puesto, se muestra en vez del nombre técnico
-- (que a veces es un trozo del location_id cuando no se pudo leer el nombre real de GHL).
-- Lo pone el admin y el propio dueño puede cambiarlo.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alias TEXT NOT NULL DEFAULT '';
