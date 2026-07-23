-- TIEMPO DE INSERCIÓN: al ENTRAR un lead nuevo (o tras un periodo de inactividad), el setter retiene
-- su primer mensaje estos segundos ANTES de procesarlo. El mensaje entra al sistema pero no se manda
-- aún a la IA; pasado ese tiempo se validan TODAS las reglas de filtrado (etiquetas incluidas). Sirve
-- para que una automatización de GHL que asigna una etiqueta (p. ej. para que el setter NO responda)
-- tenga tiempo de asentarse antes de que el setter decida. La activación por etiqueta LO SALTA.
--   · insertion_wait_seconds = segundos que espera antes de procesar el primer mensaje
--   · insertion_idle_hours   = si el lead vuelve tras estas horas sin actividad, se reaplica (0 = solo
--                              la primera vez que entra)
-- A nivel de CONEXIÓN (default de la subcuenta) y a nivel de SETTER (el setter, si >0, manda).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS insertion_wait_seconds INT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS insertion_idle_hours INT NOT NULL DEFAULT 0;
ALTER TABLE setters  ADD COLUMN IF NOT EXISTS insertion_wait_seconds INT NOT NULL DEFAULT 0;
ALTER TABLE setters  ADD COLUMN IF NOT EXISTS insertion_idle_hours INT NOT NULL DEFAULT 0;
