-- 🚫 «No responder si el NOMBRE del contacto contiene…» (conexión). Lista de palabras o frases; si el nombre del
-- contacto en GHL contiene alguna (palabra completa, sin mayúsculas ni acentos), NINGÚN setter de la conexión le
-- responde, ni le escribe por una etiqueta activadora, ni le manda seguimientos. Caso real: Despierta en Pareja marca
-- a sus clientes del programa con «PC» o «Programa completo» en el nombre y no quiere que Sofía les conteste.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS excluded_name_words JSONB NOT NULL DEFAULT '[]';
