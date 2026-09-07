// 💳 Marketplace Disruptivo — pasarela de accesos y cobros del Departamento Disruptivo.
//
// Hermes NO gestiona pagos propios: pregunta si la subcuenta tiene el uso INCLUIDO (plan o prueba)
// y, si no lo tiene, cobra su consumo del saldo del cliente en el marketplace (crédito interno
// primero, wallet de GHL después).
//
// Dos enganches en el pipeline, en este orden:
//   1) ANTES de atender   → puedeAtender()   (access + has-funds)
//   2) DESPUÉS de entregar → registrarConsumo() (outbox + cola de cobro)
//
// La unidad facturable es UNA CONVERSACIÓN POR DÍA NATURAL: da igual que ese día se crucen 30
// mensajes con el lead, cuenta 1. Quien lo garantiza no es el código sino el propio event_id
// determinista + el UNIQUE de marketplace_charges (migración 047).
//
// PRINCIPIOS INNEGOCIABLES (de la auditoría de esta integración):
//  · Ningún camino puede dejar de responder a un lead por un problema del marketplace (fail-open),
//    y el gate NUNCA descarta un mensaje: si no hay saldo, se reprograma.
//  · Ningún cobro se pierde en silencio: todo estado no resuelto vuelve al barrido.
//  · Ningún cobro se duplica: mismo event_id siempre, lock por cobro y UPDATE con guarda.

import { q, one } from '../db.js';
import { redis } from '../lib/redis.js';
import { chargeQueue } from '../queues.js';

const texto = (v) => String(v ?? '').trim();

// ── Configuración (todo por variables de entorno; la clave JAMÁS en el repositorio) ──────────
const BASE = (process.env.MD_BASE_URL || 'https://marketplace.escaladoacelerado.es').replace(/\/+$/, '');
const KEY = texto(process.env.MD_API_KEY);
const METER = texto(process.env.MD_METER) || 'consumo-apps';
const PRECIO_UNIDAD = Number(process.env.MD_PRECIO_UNIDAD || 0.25);
const UNIDADES_POR_COBRO = Number(process.env.MD_UNIDADES_POR_COBRO || 1);
const ZONA = texto(process.env.MD_ZONA_HORARIA) || 'UTC';
// permite desplegar con el gate puesto pero SIN cobrar todavía (observación previa)
const COBROS_ACTIVOS = texto(process.env.MD_COBROS).toLowerCase() !== 'false';

// El GATE corre DENTRO del pipeline (worker de concurrencia 5): un timeout largo aquí convierte
// una lentitud del marketplace en un atasco de respuestas a los leads. 4 s es de sobra para dos
// endpoints de lectura, y si no llegan a tiempo se atiende igual (fail-open).
const TIMEOUT_GATE_MS = 4_000;
// El COBRO corre en segundo plano: ahí sí se puede esperar.
const TIMEOUT_COBRO_MS = 35_000;
const MAX_INTENTOS = 5;
const MAX_INTENTOS_TOTALES = 8;              // tope del barrido antes de rendirse y pedir ayuda
const CACHE_ACCESO_FRESCA_MS = 5 * 60_000;   // se considera vigente 5 min
const CACHE_ACCESO_TTL_S = 24 * 3600;        // y sirve como último-bueno hasta 24 h
const CACHE_FONDOS_TTL_S = 60;
const CACHE_FALLO_TTL_S = 60;                // tras un fallo, no se machaca al marketplace por cada mensaje
const CORTADO_TTL_S = 600;
const LOCK_COBRO_S = 300;

// Límites de la tarifa dinámica «consumo-apps» (documentación de la API): fuera de rango el
// marketplace responde 400, así que se detecta al arrancar en vez de fallar cobro tras cobro.
const PRECIO_MIN = 0.01;
const PRECIO_MAX = 100;

// Los ÚNICOS códigos definitivos según el contrato. Todo lo demás (500, 504, 408, una página HTML
// de un proxy…) es transitorio y se reintenta con el MISMO event_id: tratarlo como definitivo
// perdía el cobro para siempre.
const DEFINITIVOS = new Set([400, 401, 403, 404]);
const ESTADOS_RESUELTOS = ['cobrado', 'incluido'];

export const mdActivo = () => Boolean(KEY);
const precioValido = () => Number.isFinite(PRECIO_UNIDAD) && PRECIO_UNIDAD >= PRECIO_MIN && PRECIO_UNIDAD <= PRECIO_MAX;
const unidadesValidas = () => Number.isFinite(UNIDADES_POR_COBRO) && UNIDADES_POR_COBRO > 0;

export function mdConfig() {
  return {
    activo: mdActivo(),
    cobros_activos: COBROS_ACTIVOS,
    base_url: BASE,
    meter: METER,
    precio_unidad: PRECIO_UNIDAD,
    unidades_por_cobro: UNIDADES_POR_COBRO,
    zona_horaria: ZONA,
    // nunca se devuelve la clave: solo si está puesta y sus últimos 4 para identificarla
    api_key_puesta: Boolean(KEY),
    api_key_pista: KEY ? `…${KEY.slice(-4)}` : '',
    precio_valido: precioValido(),
    unidades_validas: unidadesValidas(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evita inundar el registro de eventos con el mismo aviso: 1 por clave y ventana.
async function unaVezCada(clave, segundos) {
  try {
    return Boolean(await redis.set(`md:log:${clave}`, '1', 'EX', segundos, 'NX'));
  } catch {
    return true; // sin Redis se registra igual: mejor ruido que silencio
  }
}

// El logEvent vive en pipeline.js y pipeline importa este módulo: carga perezosa para no crear un
// ciclo de imports en el arranque (ESM lo toleraría, pero deja el módulo a medio inicializar).
async function evento(kind, payload) {
  try {
    const { logEvent } = await import('./pipeline.js');
    await logEvent(kind, payload);
  } catch { /* el registro de eventos nunca puede tumbar un cobro */ }
}

// ── Día natural y event_id determinista ─────────────────────────────────────────────────────
// 'sv-SE' formatea como YYYY-MM-DD. La zona se fija por entorno y NO debe cambiarse en caliente:
// el día forma parte del event_id, así que cambiarla puede recontar una conversación ese día.
export function diaNatural(fecha = new Date()) {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA }).format(fecha);
  } catch {
    return fecha.toISOString().slice(0, 10); // zona mal escrita → UTC
  }
}

const limpio = (v) => texto(v).replace(/[^A-Za-z0-9_-]/g, '');

/** hermes-{locationId}-{conversationId}-{YYYY-MM-DD} — máx. 190 caracteres. */
export function eventIdDe(locationId, conversationId, dia = diaNatural()) {
  return `hermes-${limpio(locationId)}-${limpio(conversationId)}-${limpio(dia)}`.slice(0, 190);
}

// BullMQ RECHAZA los jobId que contengan ':' salvo que tengan exactamente 3 segmentos
// (job.js: «Custom Id cannot contain :»). Con dos puntos el add() lanzaba SIEMPRE y no se
// encolaba ni un cobro. Se usan guiones y nada más.
const jobIdDe = (eventId, sufijo = '') => `md-${eventId}${sufijo}`.replace(/:/g, '-');

// ── Transporte ──────────────────────────────────────────────────────────────────────────────
// «Bearer» con B mayúscula y un espacio: el servidor compara el prefijo literal y un "bearer"
// en minúscula cae al fallback de X-Api-Key y responde 401.
async function llamar(metodo, ruta, cuerpo, timeoutMs = TIMEOUT_COBRO_MS) {
  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── 1) Puerta de acceso ─────────────────────────────────────────────────────────────────────
// access:true  → uso INCLUIDO (plan, prueba o cortesía): se atiende y NO se cobra nada.
// access:false → se cobra por uso. Llega con HTTP 200: es una respuesta normal, NO un error.
//
// Caché de 5 minutos por subcuenta (los accesos se dan y se quitan en caliente). Si el marketplace
// no responde, vale el último resultado bueno aunque esté vencido, hasta 24 h; si nunca hubo uno,
// se devuelve null = «no lo sé» y el llamador sigue el flujo normal SIN cortar el servicio.
export async function accesoDe(locationId, { timeoutMs = TIMEOUT_COBRO_MS } = {}) {
  const loc = texto(locationId);
  if (!mdActivo() || !loc) return null;
  const clave = `md:acc:${loc}`;

  let guardado = null;
  let falloReciente = false;
  try {
    const [raw, fallo] = await Promise.all([redis.get(clave), redis.get(`md:accerr:${loc}`)]);
    if (raw) guardado = JSON.parse(raw);
    falloReciente = Boolean(fallo);
  } catch { /* Redis caído: se consulta a la API */ }

  if (guardado && Date.now() - Number(guardado.at || 0) < CACHE_ACCESO_FRESCA_MS) {
    return { access: Boolean(guardado.access), via: guardado.via || '', credit: guardado.credit ?? null, cache: true };
  }
  // Hubo un fallo hace menos de un minuto: no se vuelve a llamar (si no, CADA mensaje del lead
  // pagaría el timeout completo). Se sirve el último bueno, marcado como vencido.
  if (falloReciente) {
    return guardado
      ? { access: Boolean(guardado.access), via: guardado.via || '', credit: guardado.credit ?? null, cache: true, vencida: true }
      : null;
  }

  try {
    const { status, data } = await llamar('GET', `/api/v1/access/${encodeURIComponent(loc)}`, null, timeoutMs);
    if (status === 200 && typeof data?.access === 'boolean') {
      const val = { access: data.access, via: texto(data.via), credit: data.credit ?? null, at: Date.now() };
      await redis.set(clave, JSON.stringify(val), 'EX', CACHE_ACCESO_TTL_S).catch(() => {});
      await recordarAcceso(loc, data.access);
      return { ...val, cache: false };
    }
    await redis.set(`md:accerr:${loc}`, '1', 'EX', CACHE_FALLO_TTL_S).catch(() => {});
    if (await unaVezCada(`acc:${status}:${loc}`, 900)) {
      await evento('marketplace_acceso_error', { location: loc, status, error: texto(data?.error).slice(0, 200) });
    }
  } catch (err) {
    await redis.set(`md:accerr:${loc}`, '1', 'EX', CACHE_FALLO_TTL_S).catch(() => {});
    if (await unaVezCada(`accnet:${loc}`, 900)) {
      await evento('marketplace_acceso_sin_respuesta', { location: loc, error: texto(err?.message).slice(0, 200) });
    }
  }

  // último resultado bueno, aunque esté vencido (hasta 24 h: es el TTL de la clave). `vencida` es
  // importante: con ella NO se puede cerrar un cobro como «incluido» (ver procesarCobro).
  if (guardado) return { access: Boolean(guardado.access), via: guardado.via || '', credit: guardado.credit ?? null, cache: true, vencida: true };
  return null; // nunca tuvimos uno → «no lo sé»
}

async function recordarAcceso(locationId, access) {
  try {
    await q(
      `UPDATE accounts SET md_acceso = $2, md_acceso_at = now() WHERE location_id = $1 AND md_acceso IS DISTINCT FROM $2`,
      [locationId, access ? 'incluido' : 'por_uso']
    );
  } catch { /* columna nueva: si la migración aún no corrió, no pasa nada */ }
}

// ── Semáforo de fondos (SOLO cuando access es false explícito) ──────────────────────────────
// No reserva nada: el saldo lo comparten todas las apps del marketplace. Ante cualquier fallo se
// responde «sí hay fondos» (fail-open): cortar a TODOS los clientes porque el marketplace tuvo un
// hipo sería mucho peor que cobrar un cargo que luego rebote.
export async function hayFondos(locationId, { timeoutMs = TIMEOUT_COBRO_MS } = {}) {
  const loc = texto(locationId);
  if (!mdActivo() || !loc) return { hasFunds: true, desconocido: true };
  const clave = `md:fondos:${loc}`;
  try {
    const cache = await redis.get(clave);
    if (cache === '1') return { hasFunds: true, cache: true };
    if (cache === '0') return { hasFunds: false, cache: true };
    if (cache === '?') return { hasFunds: true, desconocido: true, cache: true };
  } catch { /* sin caché, se pregunta */ }

  try {
    const { status, data } = await llamar('GET', `/api/v1/locations/${encodeURIComponent(loc)}/has-funds`, null, timeoutMs);
    if (status === 200 && typeof data?.hasFunds === 'boolean') {
      await redis.set(clave, data.hasFunds ? '1' : '0', 'EX', CACHE_FONDOS_TTL_S).catch(() => {});
      return { hasFunds: data.hasFunds, credit: data.credit ?? null };
    }
    // 404 (no conectada), 409 (conexión caída), 502…: NO se corta el servicio, pero se cachea el
    // fallo para no repetir la llamada en cada mensaje.
    await redis.set(clave, '?', 'EX', CACHE_FALLO_TTL_S).catch(() => {});
    if (await unaVezCada(`fon:${status}:${loc}`, 900)) {
      await evento('marketplace_fondos_error', { location: loc, status, error: texto(data?.error).slice(0, 200) });
    }
  } catch (err) {
    await redis.set(clave, '?', 'EX', CACHE_FALLO_TTL_S).catch(() => {});
    if (await unaVezCada(`fonnet:${loc}`, 900)) {
      await evento('marketplace_fondos_sin_respuesta', { location: loc, error: texto(err?.message).slice(0, 200) });
    }
  }
  return { hasFunds: true, desconocido: true };
}

/**
 * GATE previo a atender. Devuelve { atender, acceso, motivo }.
 * Se llama desde el pipeline con timeout CORTO: nunca puede retrasar la respuesta al lead.
 * - Integración apagada, cuenta sin location_id o acceso DESCONOCIDO → se atiende (fail-open).
 * - access true  → se atiende y NO se cobrará (ni se consultan fondos: lo prohíbe el contrato).
 * - access false + sin fondos → NO se atiende ahora y queda constancia para el administrador.
 */
export async function puedeAtender(account) {
  if (!mdActivo()) return { atender: true, acceso: null, motivo: 'integracion_apagada' };
  const loc = texto(account?.location_id);
  if (!loc) return { atender: true, acceso: null, motivo: 'sin_location_id' };

  const acceso = await accesoDe(loc, { timeoutMs: TIMEOUT_GATE_MS });
  if (acceso?.access) {
    await marcarConFondos(account);
    return { atender: true, acceso, motivo: 'incluido' };
  }
  // «No lo sé» NO es «no tiene acceso»: el contrato solo permite consultar fondos con access:false.
  // Sin esto, un timeout de /access dejaba mudo a un cliente de suscripción con el wallet a 0.
  if (!acceso || acceso.access !== false) {
    return { atender: true, acceso, motivo: 'acceso_desconocido' };
  }

  const fondos = await hayFondos(loc, { timeoutMs: TIMEOUT_GATE_MS });
  if (fondos.hasFunds) {
    await marcarConFondos(account);
    return { atender: true, acceso, motivo: fondos.desconocido ? 'fondos_desconocidos' : 'con_fondos' };
  }

  await marcarSinFondos(account);
  return { atender: false, acceso, motivo: 'sin_fondos' };
}

async function marcarSinFondos(account) {
  try {
    await q(`UPDATE accounts SET md_sin_fondos_at = COALESCE(md_sin_fondos_at, now()) WHERE id = $1`, [account.id]);
  } catch { /* la columna llega con la migración 047 */ }
  if (await unaVezCada(`sinfondos:${account.id}`, 3600)) {
    await evento('marketplace_sin_fondos', {
      account: account.id, location: account.location_id,
      nota: 'La subcuenta no tiene saldo en el marketplace: sus respuestas se aplazan hasta que recargue.',
    });
  }
}

async function marcarConFondos(account) {
  try {
    await q(`UPDATE accounts SET md_sin_fondos_at = NULL WHERE id = $1 AND md_sin_fondos_at IS NOT NULL`, [account.id]);
  } catch { /* idem */ }
}

// ── 2) Módulo ÚNICO de cobro ────────────────────────────────────────────────────────────────
// Política EXACTA del contrato:
//   200 y 201 → éxito (200 idempotent = ya estaba cobrado: seguir, no volver a cobrar)
//   400/401/403/404 → error de la petición o de configuración: registrar, avisar y PARAR
//   TODO lo demás (409/429/502/503, 5xx, timeout, red) → MISMA petición, MISMO event_id, backoff
//   sin confirmar tras los reintentos → NO cobrar con otro event_id; el marketplace reconcilia solo
export async function cobrar({ locationId, units, eventId, price, description }) {
  if (!mdActivo()) return { ok: false, estado: 'error', error: 'MD_API_KEY no configurada' };
  const cuerpo = {
    location_id: locationId,
    meter: METER,
    units,
    event_id: eventId,
    ...(price === undefined || price === null ? {} : { price }),
    ...(description ? { description: String(description).slice(0, 500) } : {}),
  };

  let ultimo = '';
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    let status;
    let data;
    try {
      ({ status, data } = await llamar('POST', '/api/v1/charges', cuerpo, TIMEOUT_COBRO_MS));
    } catch (err) {
      ultimo = texto(err?.message) || 'sin respuesta';
      await sleep(2000 * (intento + 1)); // red/timeout → MISMO event_id
      continue;
    }

    // 200 (ya estaba cobrado o reconciliado) y 201 (cobrado ahora) son AMBOS éxito
    if (status === 200 || status === 201) {
      return {
        ok: true,
        estado: 'cobrado',
        charge: data?.charge || null,
        idempotente: Boolean(data?.idempotent),
        reconciliado: Boolean(data?.reconciled),
        test_mode: Boolean(data?.test_mode) || data?.charge?.status === 'test',
      };
    }

    // el administrador cortó los cobros de la app: no es un error nuestro
    if (status === 403 && /deshabilitad/i.test(texto(data?.error))) {
      await redis.set('md:cortado', '1', 'EX', CORTADO_TTL_S).catch(() => {});
      return { ok: false, estado: 'cortado', error: texto(data?.error) };
    }

    // 400/401/403/404: reintentar no arregla nada
    if (DEFINITIVOS.has(status)) {
      return { ok: false, estado: 'error', status, error: `HTTP ${status}: ${texto(data?.error)}`.slice(0, 300) };
    }

    // cualquier otro código (409/429/502/503, 500, 504…) es transitorio: MISMA petición
    ultimo = `HTTP ${status}: ${texto(data?.error)}`.slice(0, 300);
    await sleep(2000 * (intento + 1));
  }

  // Agotados los reintentos: NUNCA con otro event_id. Lo recoge el barrido, que primero PREGUNTA
  // al marketplace si el cargo existe y solo reenvía cuando confirma que no llegó.
  return { ok: false, estado: 'sin_confirmar', error: ultimo.slice(0, 300) };
}

/**
 * Consulta cómo acabó un cobro dudoso.
 * Devuelve { ok, charge }: `ok:false` = no se pudo consultar (≠ «no existe»). Distinguirlos es
 * lo que permite reenviar con seguridad un cobro que nunca llegó a salir.
 */
export async function consultarCobro(eventId) {
  if (!mdActivo()) return { ok: false, charge: null };
  try {
    const { status, data } = await llamar('GET', `/api/v1/charges?event_id=${encodeURIComponent(eventId)}`, null, TIMEOUT_COBRO_MS);
    if (status !== 200) return { ok: false, charge: null, status };
    const lista = Array.isArray(data?.charges) ? data.charges : [];
    return { ok: true, charge: lista[0] || null };
  } catch (err) {
    return { ok: false, charge: null, error: texto(err?.message) };
  }
}

export async function listarTarifas() {
  try {
    const { status, data } = await llamar('GET', '/api/v1/meters', null, TIMEOUT_GATE_MS);
    return { status, meters: data?.meters || [], error: texto(data?.error) };
  } catch (err) {
    return { status: 0, meters: [], error: texto(err?.message) || 'sin respuesta' };
  }
}

// ── Outbox: registrar el consumo y encolar el cobro ──────────────────────────────────────────
/**
 * Se llama DESPUÉS de entregar el servicio (mensaje ya enviado al lead), nunca antes.
 * El INSERT ON CONFLICT DO NOTHING es lo que aplica «una conversación por día»: solo el primer
 * mensaje del día de esa conversación crea fila y encola cobro; el resto no hace ni una llamada.
 */
export async function registrarConsumo({ account, conversationId }) {
  if (!mdActivo() || !COBROS_ACTIVOS) return null;
  const loc = texto(account?.location_id);
  if (!conversationId) return null;
  if (!loc) {
    // Sin location_id no hay a quién cobrar. Antes era mudo y una conexión mal configurada podía
    // atender gratis durante meses sin que nadie lo viera.
    if (await unaVezCada(`sinloc:${account?.id}`, 21600)) {
      await evento('marketplace_sin_location_id', {
        account: account?.id ?? null, nombre: account?.name || '',
        nota: 'Esta conexión atiende leads pero no tiene location_id de GHL: su consumo NO se puede cobrar.',
      });
    }
    return null;
  }
  if (!precioValido() || !unidadesValidas()) {
    if (await unaVezCada('cfgmal', 3600)) {
      await evento('marketplace_config_invalida', {
        precio: PRECIO_UNIDAD, unidades: UNIDADES_POR_COBRO,
        nota: `MD_PRECIO_UNIDAD debe estar entre ${PRECIO_MIN} y ${PRECIO_MAX} y MD_UNIDADES_POR_COBRO ser > 0`,
      });
    }
    return null;
  }

  const dia = diaNatural();
  const eventId = eventIdDe(loc, conversationId, dia);
  try {
    // La fila se crea ANTES de llamar al marketplace (outbox): si el proceso muere entre medias,
    // el barrido la recoge. El DO NOTHING devuelve 0 filas cuando ya existía → no se re-encola.
    const fila = await one(
      `INSERT INTO marketplace_charges (event_id, account_id, conversation_id, location_id, dia, units, price)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id, event_id`,
      [eventId, account.id, conversationId, loc, dia, UNIDADES_POR_COBRO, PRECIO_UNIDAD]
    );
    if (!fila) return null; // esa conversación ya estaba contada hoy
    // jobId determinista y SIN ':' (BullMQ lo rechaza): dos procesos a la vez no encolan dos veces
    await chargeQueue.add('charge', { eventId }, { jobId: jobIdDe(eventId) });
    return fila;
  } catch (err) {
    await evento('marketplace_registro_error', { location: loc, conv: conversationId, error: texto(err?.message).slice(0, 200) });
    return null;
  }
}

// ── Worker de cobro ─────────────────────────────────────────────────────────────────────────
export async function procesarCobro(job) {
  const eventId = texto(job?.data?.eventId);
  if (!eventId || !mdActivo()) return;

  // Lock por cobro: el barrido y los reintentos manuales encolan con jobId distinto, así que dos
  // jobs del MISMO event_id pueden coincidir. Sin lock, el que termina último machaca el resultado
  // del que cobró de verdad (perdiendo el charge_id, que es lo único que permite reembolsar).
  const lock = `md:lock:${eventId}`;
  let tengoLock = false;
  try {
    tengoLock = Boolean(await redis.set(lock, '1', 'EX', LOCK_COBRO_S, 'NX'));
  } catch {
    tengoLock = true; // sin Redis se sigue: el marketplace deduplica por event_id de todos modos
  }
  if (!tengoLock) return; // otro job está cobrando este mismo event_id

  try {
    const fila = await one(`SELECT *, to_char(dia, 'YYYY-MM-DD') AS dia_txt FROM marketplace_charges WHERE event_id = $1`, [eventId]);
    if (!fila) return;
    if (ESTADOS_RESUELTOS.includes(fila.estado)) return; // ya resuelta: no se re-cobra JAMÁS

    // Puerta de acceso ANTES de cobrar: casi todos los clientes activos están en prueba gratuita.
    // OJO: solo se cierra como «incluido» con un acceso FRESCO. Con la caché vencida (marketplace
    // caído) cerrar aquí sería terminal e irreversible: se deja pendiente y se reintenta luego.
    const acceso = await accesoDe(fila.location_id);
    if (acceso?.access && !acceso.vencida) {
      await q(
        `UPDATE marketplace_charges SET estado = 'incluido', charge_status = '', ultimo_error = '', updated_at = now()
          WHERE id = $1 AND estado NOT IN ('cobrado','incluido')`,
        [fila.id]
      );
      return;
    }
    // Acceso VENCIDO (caché vieja) o DESCONOCIDO (sin caché y el marketplace no responde): no se
    // sabe si el cliente tiene el uso incluido → NO se cobra. El cobro es asíncrono y posterior a la
    // entrega, así que esperar no cuesta nada: queda pendiente y el barrido lo repesca (con tope de
    // 24 h de antigüedad, tras el cual pasa a revisión manual).
    if (!acceso || (acceso.access && acceso.vencida)) {
      await q(
        `UPDATE marketplace_charges SET ultimo_error = $2, updated_at = now() WHERE id = $1 AND estado = 'pendiente'`,
        [fila.id, acceso ? 'acceso sin confirmar (caché vencida): se reintenta' : 'acceso desconocido (el marketplace no responde): se reintenta']
      );
      return;
    }

    // cobros cortados por el administrador: se deja constancia y se sigue sirviendo
    try {
      if (await redis.get('md:cortado')) {
        await q(`UPDATE marketplace_charges SET estado = 'cortado', updated_at = now() WHERE id = $1 AND estado NOT IN ('cobrado','incluido')`, [fila.id]);
        if (await unaVezCada('cortado', 600)) {
          await evento('marketplace_cobros_cortados', {
            event_id: eventId,
            nota: 'El administrador deshabilitó los cobros de la app. Hermes sigue sirviendo; estos cobros se reintentan solos al reactivarse.',
          });
        }
        return;
      }
    } catch { /* sin Redis se intenta el cobro y el 403 lo volverá a marcar */ }

    const r = await cobrar({
      locationId: fila.location_id,
      units: Number(fila.units),
      eventId,
      price: fila.price === null || fila.price === undefined ? undefined : Number(fila.price),
      // dia_txt viene formateado por Postgres: usar la columna DATE cruda daba el día anterior
      // cuando la zona del contenedor y MD_ZONA_HORARIA no coinciden.
      description: `Hermes Setter · 1 conversación (${fila.dia_txt})`,
    });

    const ch = r.charge || {};
    // La guarda de estado impide que un job tardío pise un cobro ya confirmado por otro.
    await q(
      `UPDATE marketplace_charges
          SET estado = $2, charge_id = COALESCE($3, charge_id), charge_status = $4, test_mode = $5,
              paid_with = $6, amount = $7, intentos = intentos + $9, ultimo_error = $8, updated_at = now()
        WHERE id = $1 AND estado NOT IN ('cobrado','incluido')`,
      [
        fila.id,
        r.estado,
        Number.isInteger(ch.id) ? ch.id : null,
        texto(ch.status),
        Boolean(r.test_mode),
        texto(ch.paid_with),
        ch.amount ?? null,
        texto(r.error),
        // un 'cortado' no es un intento nuestro fallido: no consume el tope (si no, un corte de
        // unas horas del administrador acababa mandando cientos de filas a revisión manual)
        r.estado === 'cortado' ? 0 : 1,
      ]
    );

    if (r.estado === 'error') {
      await evento('marketplace_cobro_rechazado', {
        account: fila.account_id, location: fila.location_id, event_id: eventId, error: r.error,
        nota: 'Petición o configuración incorrecta: NO se reintenta sola. Revisa la clave, la tarifa y el alcance.',
      });
    } else if (r.estado === 'sin_confirmar') {
      await evento('marketplace_cobro_sin_confirmar', {
        account: fila.account_id, location: fila.location_id, event_id: eventId, error: r.error,
        nota: 'El barrido preguntará al marketplace y reenviará el MISMO event_id solo si confirma que no llegó.',
      });
    }
  } finally {
    await redis.del(lock).catch(() => {});
  }
}

// ── Barrido de rezagados ────────────────────────────────────────────────────────────────────
// Red de seguridad del outbox. Ningún estado no resuelto se queda fuera:
//   pendiente     → re-encolar (el proceso murió entre el INSERT y el job)
//   cortado       → volver a 'pendiente' en cuanto el administrador reactiva los cobros
//   sin_confirmar → PREGUNTAR al marketplace: si el cargo existe se cierra; si confirma que NO
//                   existe, se reenvía el MISMO event_id (idempotente, seguro); si no se puede
//                   consultar, se espera al siguiente barrido.
export async function barrerPendientes({ limite = 50 } = {}) {
  if (!mdActivo() || !COBROS_ACTIVOS) return { revisadas: 0 };
  const lim = Math.min(Math.max(Number(limite) || 50, 1), 500);
  const res = { reencolados: 0, cerrados: 0, reenviados: 0, esperando: 0, rendidos: 0, cortados_liberados: 0 };

  try {
    // 1) 'cortado': si el administrador ya reactivó los cobros, vuelven a la cola normal
    let cortadoActivo = false;
    try { cortadoActivo = Boolean(await redis.get('md:cortado')); } catch { /* sin Redis, se liberan */ }
    if (!cortadoActivo) {
      const liberadas = await q(
        `UPDATE marketplace_charges SET estado = 'pendiente', updated_at = now()
          WHERE estado = 'cortado' RETURNING event_id`
      );
      res.cortados_liberados = liberadas.length;
    }

    // 2) 'pendiente' rezagadas. Se toca updated_at al re-encolar para espaciar los reintentos:
    //    sin eso, la misma fila se re-encolaba cada 5 min mientras su job seguía en cola.
    const pendientes = await q(
      `UPDATE marketplace_charges SET updated_at = now()
        WHERE id IN (
          SELECT id FROM marketplace_charges
           WHERE estado = 'pendiente' AND updated_at < now() - interval '5 minutes'
           ORDER BY updated_at LIMIT ${lim}
        ) RETURNING event_id, intentos, (created_at < now() - interval '24 hours') AS vieja`
    );
    for (const p of pendientes) {
      // dos topes: intentos de POST reales (8) o 24 h esperando a que el marketplace responda
      // (acceso desconocido / caché vencida). Después, revisión manual con traza.
      if (Number(p.intentos) >= MAX_INTENTOS_TOTALES || p.vieja) {
        await rendirse(p.event_id, p.vieja ? 'más de 24 h sin poder confirmar el acceso ni el cobro' : 'demasiados intentos sin resolver');
        res.rendidos++;
        continue;
      }
      await chargeQueue.add('charge', { eventId: p.event_id }, { jobId: jobIdDe(p.event_id, `-r${Date.now()}`) });
      res.reencolados++;
    }

    // 3) 'sin_confirmar': primero se pregunta, nunca se re-cobra a ciegas
    const dudosas = await q(
      `SELECT id, event_id, intentos FROM marketplace_charges
        WHERE estado = 'sin_confirmar' AND updated_at < now() - interval '10 minutes'
        ORDER BY updated_at LIMIT 20`
    );
    for (const d of dudosas) {
      const { ok, charge } = await consultarCobro(d.event_id);
      if (!ok) {
        // no se pudo consultar: se espacia y se reintenta en el siguiente barrido
        await q(`UPDATE marketplace_charges SET updated_at = now() WHERE id = $1`, [d.id]);
        continue;
      }
      const st = texto(charge?.status);
      if (charge && ['created', 'test', 'refunded', 'refunding'].includes(st)) {
        await q(
          `UPDATE marketplace_charges
              SET estado = 'cobrado', charge_id = COALESCE($2, charge_id), charge_status = $3,
                  test_mode = $4, paid_with = $5, amount = $6, updated_at = now()
            WHERE id = $1 AND estado NOT IN ('cobrado','incluido')`,
          [d.id, Number.isInteger(charge.id) ? charge.id : null, st, st === 'test', texto(charge.paid_with), charge.amount ?? null]
        );
        res.cerrados++;
        continue;
      }
      if (charge && ['pending', 'unknown'].includes(st)) {
        // en vuelo o sin confirmar: lo cierra el reconciliador del marketplace; se espera
        await q(`UPDATE marketplace_charges SET charge_status = $2, charge_id = COALESCE($3, charge_id), updated_at = now() WHERE id = $1`,
          [d.id, st, Number.isInteger(charge.id) ? charge.id : null]);
        res.esperando++;
        continue;
      }
      // 'failed' (GHL rechazó el cargo: p. ej. wallet sin fondos) o el marketplace CONFIRMA que el
      // event_id no existe: el reintento del consumidor con el MISMO event_id es la vía prevista
      // (el POST reclama las filas failed y la idempotencia es por (app, event_id)). Con tope.
      if (Number(d.intentos) >= MAX_INTENTOS_TOTALES) {
        await rendirse(d.event_id, st === 'failed'
          ? `el marketplace rechaza el cobro (${texto(charge?.error) || 'sin detalle'}): probablemente la subcuenta no tiene saldo`
          : 'el marketplace no registra el cobro tras varios reenvíos');
        res.rendidos++;
        continue;
      }
      await q(`UPDATE marketplace_charges SET estado = 'pendiente', updated_at = now() WHERE id = $1 AND estado = 'sin_confirmar'`, [d.id]);
      await chargeQueue.add('charge', { eventId: d.event_id }, { jobId: jobIdDe(d.event_id, `-v${Date.now()}`) });
      res.reenviados++;
    }
  } catch (err) {
    await evento('marketplace_barrido_error', { error: texto(err?.message).slice(0, 200) });
  }
  return { revisadas: res.reencolados + res.cerrados + res.reenviados + res.rendidos, ...res };
}

// Tope de seguridad: una fila que no se resuelve tras muchos intentos deja de dar vueltas y pasa a
// 'error' para que un humano la mire (sigue siendo reintentable a mano desde el panel).
async function rendirse(eventId, motivo) {
  await q(
    `UPDATE marketplace_charges SET estado = 'error', ultimo_error = $2, updated_at = now()
      WHERE event_id = $1 AND estado NOT IN ('cobrado','incluido')`,
    [eventId, motivo]
  );
  await evento('marketplace_cobro_abandonado', { event_id: eventId, motivo, nota: 'Requiere revisión manual desde el panel (Marketplace → Reintentar).' });
}
