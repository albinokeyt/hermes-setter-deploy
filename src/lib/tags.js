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

// ── Palabra clave de un lead magnet ──────────────────────────────────────────────────────────────
// El mensaje del lead reducido a palabras (sin tildes, emojis ni signos) para compararlo con una palabra clave:
// «❤️ Quiero la Guía», «quiero la guia» y «QUIERO LA GUÍA!» son lo mismo.
export const normPalabra = (s) => normTag(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// 🚫 «No responder si el NOMBRE del contacto contiene…» (ajuste de la conexión). Cada entrada se busca como palabra o
// frase COMPLETA, sin distinguir mayúsculas ni acentos y sin contar la puntuación: «PC» casa con «Laura PC»,
// «PC - Laura», «laura_pc», «(PC)» o «Laura P.C.», pero no con «Pcarmen» ni con «López»; «Programa completo» casa
// con «Marta · programa completo». Devuelve la entrada que casó (tal como está configurada) o null.
export function palabraEnNombre(nombre, palabras) {
  const n = ` ${normPalabra(nombre)} `;
  if (!n.trim()) return null;
  const sinPuntos = ` ${normPalabra(String(nombre || '').replace(/\./g, ''))} `; // «P.C.» → «PC»
  for (const p of Array.isArray(palabras) ? palabras : []) {
    const w = normPalabra(p);
    if (w && (n.includes(` ${w} `) || sinPuntos.includes(` ${w} `))) return String(p).trim();
  }
  return null;
}
// La lista tal como se guarda: texto, sin vacíos ni repetidas, como mucho 30 entradas de 60 caracteres.
export function sanearPalabrasNombre(valor) {
  const lista = Array.isArray(valor) ? valor : String(valor || '').split(/[,;\n]/);
  const vistas = new Set();
  const out = [];
  for (const v of lista) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const t = String(v).trim().slice(0, 60);
    const k = normPalabra(t);
    if (!k || vistas.has(k)) continue;
    vistas.add(k); out.push(t);
    if (out.length >= 30) break;
  }
  return out;
}

// Palabras clave de una ficha del catálogo. `keyword` admite varias separadas por coma, «;», «/» o «|»
// (p. ej. «VÍDEO, CLASE»): la primera es la principal, las demás son alias que también escribe la gente.
export const palabrasDeLeadMagnet = (l) => String(l?.keyword || '').split(/[,;/|]/).map(normPalabra).filter(Boolean);

// La ficha cuyo material ACABA DE PEDIR el lead: su mensaje ENTERO es una palabra clave del catálogo («Comunicación»).
// Solo mensaje entero: «tenemos problemas de comunicación» no es pedir la guía (y así dispara también GHL: sus
// workflows de palabra clave casan el DM exacto). Si varias fichas comparten palabra, gana la última (como el webhook).
export function leadMagnetPorPalabra(account, body) {
  const m = normPalabra(body);
  if (!m || m.length > 60) return null;
  let hit = null;
  for (const l of (Array.isArray(account?.lead_magnets) ? account.lead_magnets : [])) {
    if (l && tagsDeLeadMagnet(l).length && palabrasDeLeadMagnet(l).includes(m)) hit = l;
  }
  return hit;
}

// Ficha de un lead magnet como contexto de conversación: QUÉ pidió, no una orden de entrada.
export const fichaLeadMagnet = (l) => {
  const palabra = String(l?.keyword || '').split(/[,;/|]/)[0].trim();
  return [
    l?.name ? `El lead pidió «${l.name}»${palabra ? ` (comentó «${palabra}»)` : ''}.` : '',
    l?.promise, l?.details,
  ].filter(Boolean).join(' ').slice(0, 1500);
};
