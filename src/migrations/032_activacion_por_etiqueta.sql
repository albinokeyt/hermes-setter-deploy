-- Activación externa por ETIQUETA (vía nativa, evento ContactTagUpdate del marketplace):
-- cuando el contacto recibe esta etiqueta en GHL, el setter lee el chat y escribe él solo,
-- tras esperar activation_wait_seconds. (El webhook por-setter de la 031 queda como alternativa.)
ALTER TABLE setters ADD COLUMN IF NOT EXISTS activation_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE setters ADD COLUMN IF NOT EXISTS activation_wait_seconds INT NOT NULL DEFAULT 0;
