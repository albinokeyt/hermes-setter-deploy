-- CTAs por conexión: si el PRIMER mensaje del lead contiene una palabra/frase clave
-- (p. ej. la respuesta automática de un anuncio de Instagram, con o sin emojis), el
-- setter espera un plazo configurable antes de entrar a responder.
-- Formato: [{ "keyword": "quiero info", "wait_seconds": 90 }, { "keyword": "", "wait_seconds": 45 }]
-- keyword vacío = se aplica a CUALQUIER conversación nueva que no case con una específica.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ctas JSONB NOT NULL DEFAULT '[]';
