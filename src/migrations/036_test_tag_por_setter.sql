-- Etiqueta de PRUEBA propia por setter: al poner UN setter en modo test, solo responde a contactos
-- con SU etiqueta (no la de la conexión). Así se pueden probar varios setters a la vez, cada uno con
-- su etiqueta. El modo test de la CONEXIÓN sigue siendo un test "en bloque" con la etiqueta de la
-- conexión (aplica a todos los setters). Regla: si un contacto tiene varias etiquetas de test, el
-- setter MÁS NUEVO (id mayor) gana la propiedad del contacto.
ALTER TABLE setters ADD COLUMN IF NOT EXISTS test_tag TEXT NOT NULL DEFAULT '';
