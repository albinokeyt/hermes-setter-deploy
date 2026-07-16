-- Modo test POR SETTER: probar un setter concreto sin poner toda la conexión en test.
-- Si la conexión tiene test_mode, aplica a todos; si no, cada setter puede activarlo solo para él.
-- La etiqueta de prueba es la de la conexión (accounts.test_tag).
ALTER TABLE setters ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
