-- Etiquetas activadoras POR SETTER, cada una con su PROPIO contexto. La gracia: la misma etiqueta
-- puesta en distintos puntos de un workflow (tras un CTA, tras un IF, tras un no-show...) hace que
-- el setter entre hablando DISTINTO, igual que el seguimiento cambia según su contexto.
-- Cada entrada de la lista: { tag, contexto, espera, link }
--   · tag      = etiqueta exacta de GHL que dispara
--   · contexto = qué pasó antes / cómo debe entrar (se le pasa a la IA al activarse por ESA etiqueta)
--   · espera   = segundos que espera antes de escribir
--   · link     = URL de la automatización que la dispara (ManyChat/GHL/lo que sea), solo referencia
ALTER TABLE setters ADD COLUMN IF NOT EXISTS activation_tags JSONB NOT NULL DEFAULT '[]'::jsonb;

-- La etiqueta única que ya existía (activation_tag/activation_wait_seconds) pasa a ser la primera
-- de la lista, para no perder lo que ya estuviera configurado.
UPDATE setters
   SET activation_tags = jsonb_build_array(jsonb_build_object(
         'tag', COALESCE(activation_tag, ''),
         'contexto', '',
         'espera', COALESCE(activation_wait_seconds, 0),
         'link', ''))
 WHERE COALESCE(activation_tag, '') <> ''
   AND COALESCE(jsonb_array_length(activation_tags), 0) = 0;
