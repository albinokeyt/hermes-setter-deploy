// Normalización ÚNICA de etiquetas para compararlas en todo Hermes: minúsculas, SIN tildes y con los
// espacios internos colapsados. «cta élite», «CTA  Elite» y «cta elite» son la misma etiqueta para el
// negocio. La usan el webhook de etiquetas, el contexto persistente del CTA y el prompt: si cada sitio
// normalizara distinto, una etiqueta con doble espacio casaría en uno y no en otro.
export const normTag = (t) => String(t || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// Todas las etiquetas (normalizadas) que marcan a un lead magnet del catálogo: la principal (`tag`) y
// las extra (`tags_extra`, separadas por «;»). Un mismo material suele llegar por varias vías —el CTA
// del comentario pone «cta: pacto | …» y la portada pone «lm-pacto-de-los-siete»— y el setter tiene
// que reconocerlo por cualquiera de ellas. El separador es «;» porque «|» y «,» aparecen dentro de los
// nombres de etiqueta reales de los clientes.
export const tagsDeLeadMagnet = (l) => [l?.tag, ...String(l?.tags_extra || '').split(';')]
  .map(normTag).filter(Boolean);
