-- 1) INFORMACION DE LEAD MAGNETS por conexion: catalogo de todo lo que el negocio regala/vende por
--    CTA (palabra, nombre, etiqueta, promesa, enlace, detalle). El agente lo lleva SIEMPRE en el prompt
--    (indice compacto) y con detalle cuando el lead pregunta por uno o cuando es el que pidio.
--    Antes el conocimiento de cada lead magnet vivia solo en el contexto de la etiqueta activadora, que
--    se consume en UNA respuesta: al turno siguiente el setter ya no sabia que guia habia pedido el lead.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lead_magnets JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2) CONTEXTO PERSISTENTE DEL CTA en la conversacion. Cuando una etiqueta activadora casa, ademas de
--    programar (o no) la entrada proactiva, se guarda AQUI que pidio el lead y con que instrucciones.
--    Se inyecta en TODAS las respuestas siguientes hasta que otro CTA lo sustituya. Asi, aunque la
--    activacion proactiva se descarte (ventana de Meta cerrada, bot pausado, canal distinto), cuando el
--    lead escriba el setter responde sabiendo que material pidio. Medido en Despierta en Pareja:
--    334 de 743 conversaciones en 'ventana_cerrada' = la activacion se tiraba y el contexto con ella.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cta_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cta_context TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS cta_at TIMESTAMPTZ;
