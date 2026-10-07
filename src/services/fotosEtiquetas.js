// 📸 FOTOS DE ETIQUETAS — la última lista de etiquetas que conocemos de cada contacto.
// ContactTagUpdate de GHL avisa de cada cambio pero no dice CUÁL etiqueta cambió: para saber cuál es la recién puesta
// se compara con la foto anterior. Sin foto no hay forma de saberlo y se da todo por nuevo (lo correcto para un
// contacto recién creado). El fallo: la foto vivía solo en Redis y caducaba a los 30 días, así que un lead que volvía
// pasado un mes llegaba «sin foto» y el setter entraba hablando por una activadora que llevaba meses puesta (caso
// real: «te dejo de nuevo el test» a quien acababa de pedir otra guía, en mitad del DM del workflow).
// Ahora la foto es PERMANENTE (tabla contact_tag_fotos, migración 054) y TODOS los contactos que ya existen reciben la
// suya: al arrancar se copian las que había en Redis y se listan los contactos de cada subcuenta en GHL (una llamada
// por cada 100) para guardar sus etiquetas actuales. A partir de ahí «sin foto» vuelve a significar lo que debe: un
// contacto nuevo cuyo primer cambio de etiquetas es de ahora. No se descarta ninguna activación «por si acaso».
import { q, one, getSetting, setSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { normTag } from '../lib/tags.js';
import * as ghl from './ghl.js';

export const fotoKey = (accountId, contactId) => `tagset:${accountId}:${contactId}`;
const normLista = (tags) => (Array.isArray(tags) ? tags : []).map(normTag).filter(Boolean);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// La foto del contacto o null si no la hay. Postgres manda; Redis es respaldo de las fotos anteriores al cambio.
// Si Postgres falla, LANZA (tras un reintento): decidir «no hay foto» por un error de lectura pisaría la foto buena y
// haría pasar por nuevas todas las etiquetas del contacto.
export async function leerFoto(accountId, contactId) {
  let fila;
  try {
    fila = await one(`SELECT tags FROM contact_tag_fotos WHERE account_id = $1 AND contact_id = $2`, [accountId, String(contactId)]);
  } catch {
    await dormir(400);
    fila = await one(`SELECT tags FROM contact_tag_fotos WHERE account_id = $1 AND contact_id = $2`, [accountId, String(contactId)]);
  }
  if (fila && Array.isArray(fila.tags)) return fila.tags;
  const raw = await redis.get(fotoKey(accountId, contactId)).catch(() => null);
  if (raw) { try { const x = JSON.parse(raw); if (Array.isArray(x)) return x; } catch { /* foto corrupta: como si no hubiera */ } }
  return null;
}

// Guarda (pisa) la foto con la lista YA normalizada. Lanza si Postgres falla tras un reintento (ver leerFoto).
export async function guardarFoto(accountId, contactId, tagsNorm) {
  const sql = `INSERT INTO contact_tag_fotos (account_id, contact_id, tags, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (account_id, contact_id) DO UPDATE SET tags = EXCLUDED.tags, updated_at = now()`;
  const vals = [accountId, String(contactId), JSON.stringify(tagsNorm)];
  try { await q(sql, vals); } catch { await dormir(400); await q(sql, vals); }
  await redis.set(fotoKey(accountId, contactId), JSON.stringify(tagsNorm), 'EX', 30 * 86400).catch(() => {});
}

// Crea la foto SOLO si el contacto no tiene ninguna (nunca pisa una más nueva). Devuelve true si la creó.
export async function sembrarFotoSiFalta(accountId, contactId, tags) {
  const r = await q(
    `INSERT INTO contact_tag_fotos (account_id, contact_id, tags) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (account_id, contact_id) DO NOTHING RETURNING 1 AS x`,
    [accountId, String(contactId), JSON.stringify(normLista(tags))]
  );
  return r.length > 0;
}

export async function borrarFoto(accountId, contactId) {
  await q(`DELETE FROM contact_tag_fotos WHERE account_id = $1 AND contact_id = $2`, [accountId, String(contactId)]).catch(() => {});
  await redis.del(fotoKey(accountId, contactId)).catch(() => {});
}

// ── Carga inicial ────────────────────────────────────────────────────────────────────────────────
// (1) Copia a la tabla las fotos que hoy viven en Redis (exactas y sin llamar a GHL). Una sola vez.
export async function sembrarDesdeRedis() {
  if (await getSetting('fotos_sembradas_redis_054', null)) return null;
  let cursor = '0', copiadas = 0, vistas = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'tagset:*', 'COUNT', 500);
    cursor = next;
    for (const k of keys) {
      const m = /^tagset:(\d+):(.+)$/.exec(k);
      if (!m || m[2].startsWith('sim:')) continue;
      vistas++;
      try {
        const x = JSON.parse(await redis.get(k));
        if (Array.isArray(x) && (await sembrarFotoSiFalta(Number(m[1]), m[2], x))) copiadas++;
      } catch { /* clave caducada entre el SCAN y el GET, cuenta borrada (clave foránea) o JSON corrupto: se salta */ }
    }
  } while (cursor !== '0');
  await setSetting('fotos_sembradas_redis_054', { at: new Date().toISOString(), vistas, copiadas });
  return { vistas, copiadas };
}

// (2) Lista TODOS los contactos de la subcuenta en GHL, página a página, y guarda como foto las etiquetas que llevan
// ahora (solo si el contacto aún no tiene foto: nunca pisa una más nueva). Los contactos sin etiquetas no necesitan
// foto: no arrastran nada viejo. ~2 páginas por segundo; ante un 429/5xx espera y reintenta la misma página. Devuelve
// el resumen, o lanza si no pudo terminar (entonces NO se marca la cuenta y se reintenta más tarde).
const V_CONTACTS = '2021-07-28';
export async function sembrarCuentaDesdeGhl(account, { pausaMs = 450, maxPaginas = 20000 } = {}) {
  const res = { paginas: 0, contactos: 0, con_etiquetas: 0, creadas: 0 };
  let startAfter = null, startAfterId = null;
  for (;;) {
    const qs = new URLSearchParams({ locationId: account.location_id, limit: '100' });
    if (startAfterId) { qs.set('startAfterId', String(startAfterId)); if (startAfter != null) qs.set('startAfter', String(startAfter)); }
    let data = null;
    for (let intento = 1; ; intento++) {
      try { data = await ghl.ghlApi(account, 'GET', `/contacts/?${qs.toString()}`, { version: V_CONTACTS }); break; }
      catch (err) {
        const st = Number(err?.status) || 0;
        const transitorio = st === 429 || st >= 500 || st === 0; // 0 = red/timeout
        if (!transitorio || intento >= 6) throw err;
        await dormir(st === 429 ? 30_000 : 8_000 * intento);
      }
    }
    const contactos = Array.isArray(data?.contacts) ? data.contacts : [];
    if (!contactos.length) break;
    res.paginas++; res.contactos += contactos.length;
    const ids = [], listas = [];
    for (const c of contactos) {
      const tags = normLista(c?.tags);
      if (c?.id && tags.length) { ids.push(String(c.id)); listas.push(JSON.stringify(tags)); }
    }
    if (ids.length) {
      res.con_etiquetas += ids.length;
      const r = await q(
        `INSERT INTO contact_tag_fotos (account_id, contact_id, tags)
         SELECT $1, x.id, x.tags::jsonb FROM unnest($2::text[], $3::text[]) AS x(id, tags)
         ON CONFLICT (account_id, contact_id) DO NOTHING RETURNING 1 AS x`,
        [account.id, ids, listas]
      );
      res.creadas += r.length;
    }
    const meta = data?.meta || {};
    const sigId = meta.startAfterId || contactos[contactos.length - 1]?.id || null;
    if (!sigId || sigId === startAfterId || contactos.length < 100 || res.paginas >= maxPaginas) break;
    const ultimo = contactos[contactos.length - 1];
    const fechaUlt = Date.parse(ultimo?.dateAdded || '');
    startAfterId = sigId; startAfter = meta.startAfter ?? (Number.isFinite(fechaUlt) ? fechaUlt : null);
    await dormir(pausaMs);
  }
  return res;
}

// Recorre las conexiones que aún no tienen su carga hecha (marcador por cuenta en settings). Una cuenta nueva la
// recibe en la siguiente pasada (cada hora); una que falla (app desinstalada, GHL caído) se reintenta más tarde.
let sembrando = false;
export async function sembrarCuentasPendientes() {
  if (sembrando) return;
  sembrando = true;
  try {
    const cuentas = await q(`SELECT * FROM accounts WHERE COALESCE(location_id, '') <> '' ORDER BY id`);
    for (const acc of cuentas) {
      const clave = `fotos_cuenta_${acc.id}`;
      if (await getSetting(clave, null)) continue;
      const t0 = Date.now();
      try {
        const r = await sembrarCuentaDesdeGhl(acc);
        await setSetting(clave, { at: new Date().toISOString(), ...r });
        console.log(`[fotos] cuenta ${acc.id} «${acc.name || ''}»: ${r.contactos} contactos en ${r.paginas} páginas, ${r.con_etiquetas} con etiquetas, ${r.creadas} fotos nuevas (${Math.round((Date.now() - t0) / 1000)} s)`);
      } catch (err) {
        console.log(`[fotos] cuenta ${acc.id} «${acc.name || ''}»: no se pudo completar (${String(err.message).slice(0, 160)}); se reintenta en la próxima pasada`);
      }
    }
  } finally {
    sembrando = false;
  }
}

// Se llama al arrancar (después de migrate): en segundo plano y sin tumbar el arranque si algo falla.
export function arrancarSembradoDeFotos() {
  const pasada = async () => {
    try {
      const r = await sembrarDesdeRedis();
      if (r) console.log(`[fotos] copiadas de Redis: ${r.copiadas} de ${r.vistas}`);
      await sembrarCuentasPendientes();
    } catch (err) {
      console.error('[fotos] la carga de fotos falló (se reintenta en la próxima pasada):', err.message);
    }
  };
  setTimeout(pasada, 30_000);
  setInterval(pasada, 60 * 60_000);
}
