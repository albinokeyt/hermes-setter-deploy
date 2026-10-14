// 💰 FACTURACIÓN POR CONSUMO DE IA — lo que paga cada cliente es NUESTRO coste de IA × un multiplicador.
//
// El coste de cada llamada lo pone recordUsage (pipeline.js): el que devuelve OpenRouter (usage.cost) o, si el
// proveedor no lo da, el calculado con los precios de la API (price_in/price_out, audio, imagen). El PRECIO AL
// CLIENTE es ese coste × multiplicador (por defecto 2: el doble), y SOLO en el trabajo con leads: respuestas,
// seguimientos, imágenes y audios. Las pruebas (simulador, «Probar agente») y el editor de prompts (corrector,
// arquitecto) los pagamos nosotros: su precio al cliente es 0.
//
// El precio se calcula y se CONGELA al registrar cada llamada (llm_usage.billed_usd): cambiar el multiplicador no
// toca lo ya registrado. También se guarda si el cliente tenía el uso incluido en ese momento (llm_usage.incluido):
// eso no se cobra nunca. Se cobra la IA consumida para sus leads aunque una respuesta acabe descartada (p. ej. el
// lead volvió a escribir mientras se generaba): la llamada se hizo y costó. Los cobros los agrupa el Marketplace en lotes (services/marketplace.js →
// cerrarLotesConsumo): una llamada cuesta milésimas de dólar y el marketplace cobra como mínimo 0,01 USD.
import { getSetting, setSetting } from '../db.js';

// Todas las fuentes que registra recordUsage (salvo 'archivo', que no es de ningún cliente).
export const FUENTES = [
  { key: 'reply', txt: 'Respuestas a leads (incluye las entradas por etiqueta)' },
  { key: 'seguimiento', txt: 'Seguimientos (y su comprobación previa con IA)' },
  { key: 'vision', txt: 'Lectura de imágenes que mandan los leads' },
  { key: 'audio', txt: 'Transcripción de audios que mandan los leads' },
  { key: 'simulador', txt: 'Simulador (pruebas)' },
  { key: 'playground', txt: '«Probar agente» (pruebas)' },
  { key: 'corrector', txt: 'Corrector de prompts' },
  { key: 'arquitecto', txt: 'Arquitecto de prompts' },
];
const CLAVES = FUENTES.map((f) => f.key);

export const FACTURACION_POR_DEFECTO = Object.freeze({
  multiplicador: 2,
  umbral_usd: 1,
  fuentes: ['reply', 'seguimiento', 'vision', 'audio'],
});

const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

export function sanearFacturacion(v = {}) {
  const fuentes = Array.isArray(v.fuentes)
    ? [...new Set(v.fuentes.map((x) => String(x)).filter((x) => CLAVES.includes(x)))]
    : [...FACTURACION_POR_DEFECTO.fuentes];
  return {
    // ×1 = a precio de coste (sin margen); el techo evita un error de tecleo que cobre una barbaridad
    multiplicador: Math.round(num(v.multiplicador, FACTURACION_POR_DEFECTO.multiplicador, 1, 20) * 100) / 100,
    // cada cuánto consumo acumulado se cobra (además, como mucho, una vez al día)
    umbral_usd: Math.round(num(v.umbral_usd, FACTURACION_POR_DEFECTO.umbral_usd, 0.1, 50) * 100) / 100,
    fuentes,
  };
}

// recordUsage corre en CADA llamada de IA: se lee de la BD como mucho una vez por minuto.
let cache = null;
let cacheAt = 0;
export async function getFacturacion() {
  if (cache && Date.now() - cacheAt < 60_000) return cache;
  try {
    const guardado = await getSetting('facturacion', null);
    cache = sanearFacturacion({ ...FACTURACION_POR_DEFECTO, ...(guardado && typeof guardado === 'object' ? guardado : {}) });
  } catch {
    cache = cache || sanearFacturacion(FACTURACION_POR_DEFECTO); // sin BD: el último bueno o el de por defecto
  }
  cacheAt = Date.now();
  return cache;
}

export async function guardarFacturacion(valor) {
  // un campo vacío o nulo NO pisa el valor guardado (vaciar el multiplicador no puede dejarlo a ×1 en silencio)
  const entrada = Object.fromEntries(Object.entries(valor || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const limpio = sanearFacturacion({ ...(await getFacturacion()), ...entrada });
  await setSetting('facturacion', limpio);
  cache = limpio;
  cacheAt = Date.now();
  return limpio;
}

// Precio al cliente de UNA llamada. null = no se sabe cuánto costó (no se puede cobrar); 0 = no se le cobra.
export function precioCliente(cost, source, fac) {
  if (cost === null || cost === undefined || !Number.isFinite(Number(cost))) return null;
  if (!fac.fuentes.includes(source)) return 0;
  return Number(cost) * fac.multiplicador;
}
