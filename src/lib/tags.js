// Normalización ÚNICA de etiquetas para compararlas en todo Hermes: minúsculas, SIN tildes y con los
// espacios internos colapsados. «cta élite», «CTA  Elite» y «cta elite» son la misma etiqueta para el
// negocio. La usan el webhook de etiquetas, el contexto persistente del CTA y el prompt: si cada sitio
// normalizara distinto, una etiqueta con doble espacio casaría en uno y no en otro.
export const normTag = (t) => String(t || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
