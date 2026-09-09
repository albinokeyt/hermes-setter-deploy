-- Tope OPCIONAL de palabras por mensaje, por conexión y por setter.
-- NULL = sin tope, que es el comportamiento de siempre: encenderlo es decisión de cada cuenta.
-- Nace de medir 1.269 conversaciones reales de Albatros: el setter externo manda el mismo texto
-- (~41 palabras por respuesta) en 3 mensajes de ~14 palabras y Hermes en 1-2 de 26, y el 51 % de
-- las conversaciones de Facebook mueren en el segundo turno.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS max_words INT;
ALTER TABLE setters  ADD COLUMN IF NOT EXISTS max_words INT;
