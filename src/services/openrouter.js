// 💵 OpenRouter (el proveedor de IA): cuánto han gastado las claves de Hermes y cuánto queda en la cuenta.
//
// Dos fuentes, las dos de SOLO LECTURA:
//   · gastoClavesHermes(): por cada API key de OpenRouter guardada en Proveedores (providers.api_key), GET /api/v1/key →
//     gasto y límite de ESA clave. Funciona con las claves normales de chat.
//   · cuentaOpenRouter(): GET /api/v1/credits (total comprado y gastado de TODA la cuenta) y GET /api/v1/keys (gasto de
//     cada clave de la cuenta, también las de otras apps como el Disruptive Brain). Exigen una «management key», que no
//     sirve para chatear: se lee de la variable de entorno OPCIONAL OPENROUTER_MANAGEMENT_KEY y nunca se enseña.
//
// Reglas de seguridad:
//   · Las claves se mandan SIEMPRE a las URL fijas de openrouter.ai, nunca a la base_url del proveedor (si alguien la
//     cambiara, la clave acabaría en otro servidor).
//   · Jamás se devuelve una clave en claro: solo su máscara (lib/mascara.js) y los mensajes de error no llevan nada
//     de la respuesta del servidor.
// Caché en memoria de 5 minutos por función (las cifras de OpenRouter no cambian al segundo y así no se le machaca);
// con { refrescar: true } se salta.

import crypto from 'node:crypto';
import { q } from '../db.js';
import { mascaraClave } from '../lib/mascara.js';

const URL_KEY = 'https://openrouter.ai/api/v1/key';
const URL_CREDITS = 'https://openrouter.ai/api/v1/credits';
const URL_KEYS = 'https://openrouter.ai/api/v1/keys';
const TIMEOUT_MS = 8_000;
const CACHE_MS = 5 * 60_000;
const CACHE_ERROR_MS = 30_000; // un fallo se recuerda poco: que «Actualizar» lo reintente pronto

const claveGestion = () => String(process.env.OPENROUTER_MANAGEMENT_KEY || '').trim();
const huella = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const r6 = (n) => Math.round(n * 1e6) / 1e6;
// número o null (OpenRouter manda null en los límites que no existen)
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? r6(n) : null;
};

// Solo las base_url que de verdad son de OpenRouter: una clave de otro proveedor que casara con el ILIKE por casualidad
// (p. ej. «https://otro.com/?openrouter.ai») no se manda a OpenRouter.
function esDeOpenRouter(baseUrl) {
  try {
    const h = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return h === 'openrouter.ai' || h.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

// ── Caché ─────────────────────────────────────────────────────────────────────────────────────
const cache = new Map(); // nombre → { at, huella, ttl, valor }

async function conCache(nombre, firma, refrescar, calcular) {
  const hit = cache.get(nombre);
  if (!refrescar && hit && hit.huella === firma && Date.now() - hit.at < hit.ttl) return hit.valor;
  const { valor, conError } = await calcular();
  cache.set(nombre, { at: Date.now(), huella: firma, ttl: conError ? CACHE_ERROR_MS : CACHE_MS, valor });
  return valor;
}

/** Vacía la caché (tests, o tras cambiar claves). */
export function vaciarCacheOpenRouter() {
  cache.clear();
}

// ── Transporte ────────────────────────────────────────────────────────────────────────────────
function textoDeEstado(status) {
  if (status === 401) return 'OpenRouter no acepta esta clave (HTTP 401): puede que esté borrada o desactivada.';
  if (status === 403) return 'OpenRouter no deja consultar esto con esta clave (HTTP 403): hace falta una management key.';
  if (status === 402) return 'OpenRouter dice que la cuenta no tiene saldo (HTTP 402).';
  if (status === 429) return 'OpenRouter está limitando las consultas (HTTP 429): prueba en un minuto.';
  return `OpenRouter respondió con un error (HTTP ${status}).`;
}

async function pedir(url, clave) {
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${clave}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // ni err.message: el texto del fallo de red no aporta y así no se arriesga a filtrar nada
    throw new Error(err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `OpenRouter no respondió en ${TIMEOUT_MS / 1000} s.`
      : 'No se pudo conectar con OpenRouter.');
  }
  const cuerpo = await res.json().catch(() => null);
  if (!res.ok) throw new Error(textoDeEstado(res.status));
  if (!cuerpo || typeof cuerpo !== 'object' || cuerpo.data === undefined) throw new Error('OpenRouter devolvió una respuesta que no se entiende.');
  return cuerpo.data;
}

// ── Gasto de las claves que usa Hermes ────────────────────────────────────────────────────────
/**
 * Una fila por API key distinta (varias filas de Proveedores pueden compartir clave):
 * [{ proveedores:[{id,name}], clave:'sk-or-…1c96', label, usage, usage_daily, usage_weekly, usage_monthly, limit,
 *    limit_remaining, error }]. Nunca la clave en claro.
 */
export async function gastoClavesHermes({ refrescar = false } = {}) {
  const filas = await q(`SELECT id, name, base_url, api_key FROM providers WHERE base_url ILIKE '%openrouter.ai%' ORDER BY id`);
  const grupos = new Map(); // clave → [{id, name}]
  for (const f of filas) {
    const clave = String(f.api_key || '').trim();
    if (!clave || !esDeOpenRouter(f.base_url)) continue;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push({ id: f.id, name: f.name });
  }
  // la huella cambia si se añade, quita o cambia una clave: entonces no vale la caché
  const firma = huella([...grupos.entries()].map(([k, p]) => `${huella(k)}:${p.map((x) => x.id).join(',')}`).join('|'));

  return conCache('claves', firma, refrescar, async () => {
    const valor = await Promise.all([...grupos.entries()].map(async ([clave, proveedores]) => {
      const base = { proveedores, clave: mascaraClave(clave) };
      try {
        const d = await pedir(URL_KEY, clave);
        return {
          ...base,
          label: d?.label ? String(d.label) : null,
          usage: num(d?.usage),
          usage_daily: num(d?.usage_daily),
          usage_weekly: num(d?.usage_weekly),
          usage_monthly: num(d?.usage_monthly),
          limit: num(d?.limit),
          limit_remaining: num(d?.limit_remaining),
          error: null,
        };
      } catch (err) {
        return {
          ...base, label: null, usage: null, usage_daily: null, usage_weekly: null, usage_monthly: null,
          limit: null, limit_remaining: null, error: err.message,
        };
      }
    }));
    return { valor, conError: valor.some((c) => c.error) };
  });
}

// ── Alerta de saldo (función pura) ────────────────────────────────────────────────────────────
// 'agotado' → saldo de la cuenta ≤ 0,5 $ o alguna clave de Hermes con ≤ 0,5 $ de límite restante.
// 'bajo'    → saldo < 5 $ o alguna clave de Hermes con < 2 $ de límite restante.
// 'desconocido' → no se sabe el saldo de la cuenta (sin management key o sin respuesta) y las claves no tienen límite.
// 'ok'      → lo demás.
export const UMBRAL_AGOTADO_USD = 0.5;
export const UMBRAL_BAJO_USD = 5;
export const UMBRAL_BAJO_CLAVE_USD = 2;
const RECARGA = 'Recarga en openrouter.ai/settings/credits.';
const dolares = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export function alertaOpenRouter(cuenta, clavesHermes) {
  const saldo = cuenta?.configurada && Number.isFinite(cuenta?.saldo) ? cuenta.saldo : null;
  const conLimite = (clavesHermes || []).filter((c) => Number.isFinite(c?.limit_remaining));
  const nombre = (c) => c.label || (c.proveedores || []).map((p) => p.name).join(', ') || c.clave || 'sin nombre';
  const detalle = (claves) => [
    saldo !== null ? `Saldo de la cuenta: ${dolares(saldo)}.` : '',
    ...claves.map((c) => `A la clave «${nombre(c)}» le quedan ${dolares(c.limit_remaining)} de su límite.`),
  ].filter(Boolean).join(' ');

  const agotadas = conLimite.filter((c) => c.limit_remaining <= UMBRAL_AGOTADO_USD);
  if ((saldo !== null && saldo <= UMBRAL_AGOTADO_USD) || agotadas.length) {
    return {
      nivel: 'agotado',
      texto: `OpenRouter está sin saldo o a punto de agotarlo: cuando llega a 0, los setters dejan de contestar. ${detalle(agotadas)} ${RECARGA}`.replace(/\s+/g, ' ').trim(),
    };
  }
  const bajas = conLimite.filter((c) => c.limit_remaining < UMBRAL_BAJO_CLAVE_USD);
  if ((saldo !== null && saldo < UMBRAL_BAJO_USD) || bajas.length) {
    return {
      nivel: 'bajo',
      texto: `OpenRouter casi sin saldo: si llega a 0 los setters dejan de contestar. ${detalle(bajas)} ${RECARGA}`.replace(/\s+/g, ' ').trim(),
    };
  }
  if (saldo === null && !conLimite.length) {
    const fallidas = (clavesHermes || []).filter((c) => c?.error).length;
    const base = !cuenta?.configurada
      ? 'No se sabe cuánto saldo queda en OpenRouter: falta la management key (OPENROUTER_MANAGEMENT_KEY) y las claves de Hermes no tienen límite.'
      : `No se ha podido leer el saldo de OpenRouter${cuenta?.error ? ` (${cuenta.error})` : ''}.`;
    return {
      nivel: 'desconocido',
      texto: fallidas ? `${base} Además, no se ha podido consultar ${fallidas === 1 ? '1 clave' : `${fallidas} claves`} de Hermes.` : base,
    };
  }
  return {
    nivel: 'ok',
    texto: saldo !== null
      ? `OpenRouter con saldo: ${dolares(saldo)}.`
      : 'Las claves de Hermes tienen margen en su límite, pero sin la management key no se ve el saldo de la cuenta.',
  };
}

// ── Cuenta entera (con la management key) ─────────────────────────────────────────────────────
/**
 * Sin OPENROUTER_MANAGEMENT_KEY → { configurada:false }.
 * Con ella → { configurada:true, total_credits, total_usage, saldo, claves:[{label,name,disabled,usage,usage_monthly,
 *              limit,limit_remaining}], error } (cada consulta falla por separado: error junta lo que haya fallado).
 */
export async function cuentaOpenRouter({ refrescar = false } = {}) {
  const clave = claveGestion();
  if (!clave) return { configurada: false };

  return conCache('cuenta', huella(clave), refrescar, async () => {
    const [cred, keys] = await Promise.allSettled([pedir(URL_CREDITS, clave), pedir(URL_KEYS, clave)]);
    const errores = [];
    let totalCredits = null;
    let totalUsage = null;
    if (cred.status === 'fulfilled') {
      totalCredits = num(cred.value?.total_credits);
      totalUsage = num(cred.value?.total_usage);
      if (totalCredits === null || totalUsage === null) errores.push('Lo comprado y gastado: OpenRouter no lo ha devuelto.');
    } else {
      errores.push(`Lo comprado y gastado: ${cred.reason?.message || 'sin respuesta'}`);
    }
    let claves = [];
    if (keys.status === 'fulfilled') {
      claves = (Array.isArray(keys.value) ? keys.value : []).map((k) => ({
        label: k?.label ? String(k.label) : '',
        name: k?.name ? String(k.name) : '',
        disabled: Boolean(k?.disabled),
        usage: num(k?.usage),
        usage_monthly: num(k?.usage_monthly),
        limit: num(k?.limit),
        limit_remaining: num(k?.limit_remaining),
      }));
    } else {
      errores.push(`Las claves de la cuenta: ${keys.reason?.message || 'sin respuesta'}`);
    }
    const valor = {
      configurada: true,
      total_credits: totalCredits,
      total_usage: totalUsage,
      saldo: totalCredits !== null && totalUsage !== null ? r6(totalCredits - totalUsage) : null,
      claves,
      error: errores.length ? errores.join(' · ') : null,
    };
    return { valor, conError: errores.length > 0 };
  });
}
