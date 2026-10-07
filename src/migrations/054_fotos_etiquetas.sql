-- «Foto» PERMANENTE de las etiquetas de cada contacto: la última lista que conocemos (la manda ContactTagUpdate). GHL
-- avisa de cada cambio de etiquetas pero no dice CUÁL cambió, así que se compara con la foto anterior para saber cuál
-- es la recién puesta. Antes vivía solo en Redis y caducaba a los 30 días: un lead que volvía pasado un mes llegaba
-- «sin foto» y el setter entraba hablando por una etiqueta activadora que llevaba meses puesta (p. ej. la del test).
CREATE TABLE IF NOT EXISTS contact_tag_fotos (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, contact_id)
);
