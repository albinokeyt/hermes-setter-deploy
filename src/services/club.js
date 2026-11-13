// 🏛️ CLUB DE SISTEMAS — conexiones nuevas seguras + interruptor del Club (migración 059).
//
// 1) crearConexionNueva(): el ÚNICO sitio donde nace una conexión sola (callback OAuth, enlace de agencia /ghl-app y
//    SSO de la Custom Page). Toda conexión nueva nace en 🧪 MODO PRUEBA (test_mode=true, etiqueta «test-setter» o la
//    de la plantilla) y su «Setter principal» copia la plantilla global «plantilla_conexion» {provider_id, model,
//    prompt_partida}. Las conexiones que YA existen no se tocan: aquí solo se INSERTA.
// 2) aplicarEstadoClub(): lo que hace POST /api/club/estado (routes/club.js). Pone ai_enabled = activo en TODAS las
//    conexiones NUEVAS de una subcuenta (o en la ÚNICA conexión nueva cuyo RESPONSABLE tiene ese correo). ai_enabled es
//    el interruptor maestro que el cliente no puede tocar (solo admin). Si la conexión aún no existe, el estado queda
//    PENDIENTE y se aplica al crearse (por subcuenta) o cuando su responsable entra por SSO (por correo). Si hay
//    ambigüedad, no toca nada.
//
// SEGURIDAD
//  · Conexiones ANTERIORES al Club (creadas antes de la migración 059: DEP, Jonathan, Rodrigo…) → nunca se tocan desde
//    aquí («protegida»). La comparación con el corte se hace en SQL (microsegundos; en JS se truncaría a ms).
//  · Por correo solo vale el RESPONSABLE (owner_email): lo fija GHL por SSO cifrado (primer usuario de la subcuenta) o el
//    admin, y el cliente no puede cambiarlo. Los «correos autorizados» NO sirven: el propio cliente los edita en su
//    pestaña Accesos, y con ellos podría quedarse con el estado del Club de otra persona.
//  · Candado por subcuenta y por correo (pg_advisory_xact_lock): un estado que llegue justo mientras se crea la
//    conexión no se pierde ni se aplica dos veces.
//  · Orden: accounts.club_estado_at guarda cuándo se DECIDIÓ el estado que tiene la conexión. Un pendiente solo se
//    aplica si es posterior (un alta vieja que esperaba por correo no reenciende una conexión apagada luego por impago).
//
// Este módulo NO importa pipeline.js ni Redis: todas las funciones aceptan el pool de Postgres como último parámetro
// (por defecto el real) para poder probarlas con una base en memoria (test/club.test.mjs).

import crypto from 'node:crypto';
import { pool as poolReal } from '../db.js';

export const TEST_TAG_POR_DEFECTO = 'test-setter';
const MAX_PROMPT = 20000;
const PENDIENTE_DIAS = 60; // un estado pendiente más viejo que esto ya no se aplica

// ── Prompt con huecos sin rellenar ───────────────────────────────────────────────────────────
// La plantilla del Club lleva marcadores [[RELLENAR: …]]. Mientras quede alguno en los 3 campos del setter, el
// setter NO atiende fuera del modo prueba ni entra por activaciones (pipeline.js): así nunca sale en vivo
// diciendo «Soy [[RELLENAR…]]» ni sin presentarse como asistente virtual.
export const MARCADOR_RELLENAR = /\[\[\s*RELLENAR/i;
export const promptSinRellenar = (a) =>
  [a?.prompt_identity, a?.prompt_business, a?.prompt_flow].some((t) => MARCADOR_RELLENAR.test(String(t || '')));

// ── Plantilla de conexiones nuevas ───────────────────────────────────────────────────────────
const txt = (v, n) => (typeof v === 'string' ? v : '').replace(/\r/g, '').slice(0, n);

export function sanearPlantilla(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const pid = Number(o.provider_id);
  const pp = o.prompt_partida && typeof o.prompt_partida === 'object' ? o.prompt_partida : {};
  const tag = txt(o.test_tag, 60).trim().replace(/\s+/g, ' ');
  return {
    provider_id: Number.isInteger(pid) && pid > 0 ? pid : null,
    model: txt(o.model, 200).trim(),
    test_tag: tag || TEST_TAG_POR_DEFECTO,
    prompt_partida: {
      identity: txt(pp.identity, MAX_PROMPT),
      business: txt(pp.business, MAX_PROMPT),
      flow: txt(pp.flow, MAX_PROMPT),
    },
    origen: txt(o.origen, 300),
  };
}

export async function leerPlantilla(pg = poolReal) {
  const r = await pg.query(`SELECT value FROM settings WHERE key = 'plantilla_conexion'`);
  return sanearPlantilla(r.rows[0]?.value);
}

// ── Utilidades SQL ───────────────────────────────────────────────────────────────────────────
// Corte de «conexión nueva» (migración 059), leído y comparado SIEMPRE en SQL. Sin corte → NULL → «no es nueva».
// (También los usa services/devoluciones.js para resolver la conexión de quien pide una devolución.)
export const DESDE_SQL = `(SELECT (value->>'desde')::timestamptz FROM settings WHERE key = 'club_desde')`;
export const ES_NUEVA = `COALESCE(created_at >= ${DESDE_SQL}, false)`;
const CANDADO = `SELECT pg_advisory_xact_lock(hashtextextended($1, 59))`;
const VIGENTE = `(updated_at > now() - make_interval(days => ${PENDIENTE_DIAS}))`;
const claveLoc = (loc) => `loc:${loc}`;
const claveEmail = (mail) => `email:${mail}`;

async function enTransaccion(pg, fn) {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Registro de eventos del panel (Configuración → Registro de eventos). Best effort y SIEMPRE fuera de una transacción:
// un fallo dentro de una transacción la dejaría abortada aunque el error se capture en JS.
async function eventoLog(pg, kind, payload) {
  await pg.query(`INSERT INTO webhook_log (kind, payload) VALUES ($1, $2)`, [kind, JSON.stringify(payload)]).catch(() => {});
}

// Registro DURABLE del interruptor (tabla club_eventos). Se escribe dentro de la misma transacción que el cambio.
async function insertarClubEvento(c, { location_id = null, email = null, activo = null, motivo = '', resultado, cuentas = [], detalle = {}, ip = null }) {
  await c.query(
    `INSERT INTO club_eventos (location_id, email, activo, motivo, resultado, cuentas, detalle, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [location_id, email, activo, motivo, resultado, JSON.stringify(cuentas), JSON.stringify(detalle), ip]
  );
}

const selExistente = `SELECT * FROM accounts WHERE location_id = $1 ORDER BY ai_enabled DESC, bot_enabled DESC, id ASC LIMIT 1`;

/**
 * Crea (o devuelve, si ya existe) la conexión de una subcuenta.
 * @returns {{ account, creada: boolean }}
 */
export async function crearConexionNueva({ name, locationId, conPortalKey = false, origen = '' }, pg = poolReal) {
  const loc = String(locationId || '').trim();
  if (!loc) throw new Error('crearConexionNueva: falta locationId');
  const ya = await pg.query(selExistente, [loc]);
  if (ya.rows[0]) return { account: ya.rows[0], creada: false };

  const plantilla = await leerPlantilla(pg);
  let notaProveedor = '';
  let pendiente = null;
  let res;
  try {
    res = await enTransaccion(pg, async (c) => {
      // mismo candado que el interruptor del Club para esta subcuenta (y contra dos altas a la vez)
      await c.query(CANDADO, [`club:${claveLoc(loc)}`]);
      const otra = await c.query(selExistente, [loc]);
      if (otra.rows[0]) return { account: otra.rows[0], creada: false };
      const ins = await c.query(
        `INSERT INTO accounts (name, location_id, mode, webhook_token, portal_key, test_mode, test_tag)
         VALUES ($1, $2, 'oauth', $3, $4, true, $5) RETURNING *`,
        [String(name || `Setter ${loc.slice(0, 6)}`).slice(0, 200), loc, crypto.randomBytes(16).toString('hex'),
          conPortalKey ? crypto.randomBytes(24).toString('hex') : null, plantilla.test_tag]
      );
      const account = ins.rows[0];
      let providerId = plantilla.provider_id;
      if (providerId) {
        const p = await c.query(`SELECT id FROM providers WHERE id = $1`, [providerId]);
        if (!p.rows[0]) { notaProveedor = `la API ${providerId} de la plantilla ya no existe: setter sin proveedor`; providerId = null; }
      }
      const pp = plantilla.prompt_partida;
      await c.query(
        `INSERT INTO setters (account_id, name, is_default, provider_id, model, prompt_identity, prompt_business, prompt_flow)
         VALUES ($1, 'Setter principal', true, $2, $3, $4, $5, $6)`,
        [account.id, providerId, providerId ? plantilla.model : '', pp.identity, pp.business, pp.flow]
      );
      // ¿llegó antes el interruptor del Club para esta subcuenta? se aplica ya, en la misma transacción
      const fila = (await c.query(
        `DELETE FROM club_estado_pendiente WHERE clave = $1 RETURNING activo, motivo, ${VIGENTE} AS vigente, updated_at::text AS cuando`, [claveLoc(loc)]
      )).rows[0];
      if (fila?.vigente) {
        // club_estado_at = cuándo se decidió ESE estado (no ahora): un pendiente por correo más viejo no lo pisará
        await c.query(`UPDATE accounts SET ai_enabled = $1, club_estado_at = $3::timestamptz WHERE id = $2`, [Boolean(fila.activo), account.id, fila.cuando]);
        account.ai_enabled = Boolean(fila.activo);
        pendiente = fila;
        await insertarClubEvento(c, {
          location_id: loc, activo: Boolean(fila.activo), motivo: fila.motivo, resultado: 'pendiente_aplicado',
          cuentas: [account.id], detalle: { via: 'subcuenta', origen },
        });
      }
      return { account, creada: true };
    });
  } catch (err) {
    // otra vía (p. ej. el vínculo manual del admin) ocupó la subcuenta a la vez (UNIQUE location_id): se reutiliza
    if (err && err.code === '23505') {
      const otra = await pg.query(selExistente, [loc]);
      if (otra.rows[0]) return { account: otra.rows[0], creada: false };
    }
    throw err;
  }
  if (!res.creada) return res;
  const { account } = res;
  await eventoLog(pg, 'conexion_nueva_modo_prueba', {
    account: account.id, location: loc, origen, test_tag: plantilla.test_tag,
    proveedor: notaProveedor ? null : plantilla.provider_id, nota: notaProveedor || undefined,
  });
  if (pendiente) {
    await eventoLog(pg, 'club_estado_pendiente_aplicado', { location_id: loc, activo: Boolean(pendiente.activo), motivo: pendiente.motivo, cuentas: [account.id], via: 'subcuenta', origen });
  }
  return { account, creada: true };
}

// ── Interruptor del Club ────────────────────────────────────────────────────────────────────

// Comparación en tiempo constante (sobre los hash: no filtra la longitud del secreto).
export function secretoValido(recibido, secreto) {
  const a = crypto.createHash('sha256').update(String(recibido || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(secreto || ''), 'utf8').digest();
  return Boolean(secreto) && crypto.timingSafeEqual(a, b);
}

const RE_LOC = /^[A-Za-z0-9_-]{6,64}$/;
const RE_EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;

// GHL (nodo «Webhook personalizado») puede mandar los valores como texto: se aceptan true/false y "true"/"false".
function aBooleano(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** Valida el cuerpo. Devuelve { ok:true, datos } o { ok:false, error }. */
export function validarCuerpoClub(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const activo = aBooleano(b.activo);
  if (activo === null) return { ok: false, error: 'activo debe ser true o false' };
  const location_id = String(b.location_id ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  // longitudes antes de cualquier expresión regular (un texto enorme no puede costar CPU)
  if (location_id.length > 200) return { ok: false, error: 'location_id no válido' };
  if (email.length > 254) return { ok: false, error: 'email no válido' };
  // un merge field de GHL vacío o sin resolver ({{contact.x}}) cuenta como «no viene»
  const sinResolver = (s) => !s || /\{\{.*\}\}/.test(s);
  const loc = sinResolver(location_id) ? '' : location_id;
  const mail = sinResolver(email) ? '' : email;
  if (loc && !RE_LOC.test(loc)) return { ok: false, error: 'location_id no válido' };
  if (mail && !RE_EMAIL.test(mail)) return { ok: false, error: 'email no válido' };
  if (!loc && !mail) return { ok: false, error: 'falta location_id o email' };
  const motivo = String(b.motivo ?? '').slice(0, 400).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  return { ok: true, datos: { location_id: loc || null, email: mail || null, activo, motivo } };
}

// Estado DIRECTO (la conexión ya existe): ai_enabled = activo y club_estado_at = ahora en todas, también en las que no
// cambian (la decisión es de ahora: un pendiente más viejo ya no debe pisarla). Devuelve los ids que cambiaron.
async function fijarEstado(c, ids, activo) {
  const r = await c.query(
    `WITH antes AS (SELECT id, ai_enabled FROM accounts WHERE id = ANY($2::int[]) FOR UPDATE)
     UPDATE accounts a SET ai_enabled = $1, club_estado_at = now() FROM antes WHERE a.id = antes.id
     RETURNING a.id, (antes.ai_enabled IS DISTINCT FROM $1) AS cambiada`,
    [activo, ids]
  );
  return r.rows.filter((x) => x.cambiada).map((x) => x.id).sort((x, y) => x - y);
}

async function guardarPendiente(c, clave, activo, motivo) {
  await c.query(
    `INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (clave) DO UPDATE SET activo = $2, motivo = $3, updated_at = now()`,
    [clave, activo, motivo]
  );
}

const RESPUESTAS = {
  pendiente_subcuenta: { code: 202, nota: 'La subcuenta aún no tiene conexión en Hermes: el estado se aplicará cuando se cree.' },
  protegida: { code: 202, nota: 'Esa subcuenta tiene una conexión anterior al Club: no se ha tocado. Revisa que el workflow mande la subcuenta del CLIENTE.' },
  pendiente_correo: { code: 202, nota: 'Aún no hay ninguna conexión nueva cuyo responsable tenga ese correo: el estado se aplicará cuando la cree y entre.' },
  ambiguo: { code: 202, nota: 'Ese correo es el responsable de varias conexiones nuevas: no se ha tocado nada. Manda el location_id.' },
  sin_corte: { code: 202, nota: 'No se puede resolver por correo (falta el corte de la migración 059): no se ha tocado nada.' },
};

/**
 * Aplica el estado del Club. Idempotente: repetir la misma llamada no cambia nada (resultado «sin_cambios»).
 * @returns {{ code: number, body: object }}
 */
export async function aplicarEstadoClub({ location_id, email, activo, motivo, ip = null }, pg = poolReal) {
  // A) Por SUBCUENTA: todas sus conexiones NUEVAS (location_id es UNIQUE, pero se actúa sobre todas igual).
  if (location_id) {
    const base = { location_id, email, activo, motivo, ip };
    const r = await enTransaccion(pg, async (c) => {
      await c.query(CANDADO, [`club:${claveLoc(location_id)}`]);
      const todas = (await c.query(
        `SELECT id, ${ES_NUEVA} AS nueva FROM accounts WHERE location_id = $1 ORDER BY id`, [location_id]
      )).rows;
      if (!todas.length) {
        await guardarPendiente(c, claveLoc(location_id), activo, motivo);
        const detalle = { via: 'subcuenta', nota: 'la subcuenta aún no tiene conexión en Hermes: se aplicará al crearse' };
        await insertarClubEvento(c, { ...base, resultado: 'pendiente', detalle });
        return { resultado: 'pendiente', clave: 'pendiente_subcuenta', detalle };
      }
      // la conexión ya existe: un pendiente viejo de esta subcuenta ya no aplica (manda el estado de ahora)
      await c.query(`DELETE FROM club_estado_pendiente WHERE clave = $1`, [claveLoc(location_id)]);
      const nuevas = todas.filter((x) => x.nueva).map((x) => x.id);
      const protegidas = todas.filter((x) => !x.nueva).map((x) => x.id);
      if (!nuevas.length) {
        // 🛡️ conexión ANTERIOR al Club: nunca se toca desde aquí. Protege del error más probable del workflow: mandar
        // {{location.id}} desde 4ttZ, que es la subcuenta de la AGENCIA y no la del cliente. Se enciende o apaga a mano.
        const detalle = { via: 'subcuenta', nota: 'conexión anterior al Club: no se toca desde el interruptor (¿el workflow manda la subcuenta de la agencia?)' };
        await insertarClubEvento(c, { ...base, resultado: 'protegida', cuentas: protegidas, detalle });
        return { resultado: 'protegida', clave: 'protegida', cuentas: protegidas, detalle };
      }
      const cambiadas = await fijarEstado(c, nuevas, activo);
      const resultado = cambiadas.length ? 'aplicado' : 'sin_cambios';
      const detalle = { via: 'subcuenta', cambiadas, protegidas: protegidas.length ? protegidas : undefined };
      await insertarClubEvento(c, { ...base, resultado, cuentas: nuevas, detalle });
      return { resultado, cuentas: nuevas, cambiadas, detalle };
    });
    await eventoLog(pg, `club_estado_${r.resultado}`, { location_id, email, activo, motivo, cuentas: r.cuentas || [], ...r.detalle });
    if (r.clave) {
      return { code: RESPUESTAS[r.clave].code, body: { ok: true, resultado: r.resultado, via: 'subcuenta', ...(r.cuentas ? { cuentas: r.cuentas } : {}), nota: RESPUESTAS[r.clave].nota } };
    }
    return { code: 200, body: { ok: true, resultado: r.resultado, via: 'subcuenta', cuentas: r.cuentas, cambiadas: r.cambiadas, ai_enabled: activo } };
  }

  // B) Solo CORREO: la ÚNICA conexión NUEVA cuyo RESPONSABLE (owner_email) es ese correo. Ninguna → pendiente (se aplica
  //    cuando ese correo entra por SSO como responsable de una conexión nueva). Más de una → ambigüedad: no se toca nada.
  const base = { email, activo, motivo, ip };
  const r = await enTransaccion(pg, async (c) => {
    const corte = (await c.query(`SELECT ${DESDE_SQL} AS desde`)).rows[0]?.desde;
    if (!corte) {
      const detalle = { via: 'correo', nota: 'falta el corte club_desde (migración 059): no se toca nada por correo' };
      await insertarClubEvento(c, { ...base, resultado: 'ambiguo', detalle });
      return { resultado: 'ambiguo', clave: 'sin_corte', detalle };
    }
    await c.query(CANDADO, [`club:${claveEmail(email)}`]);
    const cands = (await c.query(
      `SELECT id, location_id FROM accounts WHERE ${ES_NUEVA} AND lower(owner_email) = $1 ORDER BY id`, [email]
    )).rows;
    const antiguas = (await c.query(
      `SELECT count(*)::int AS n FROM accounts WHERE NOT ${ES_NUEVA} AND (lower(owner_email) = $1 OR authorized_emails @> $2::jsonb)`,
      [email, JSON.stringify([email])]
    )).rows[0]?.n || 0;
    const notaAntiguas = antiguas ? `${antiguas} conexión(es) anteriores al Club con ese correo: no se tocan` : undefined;
    if (cands.length > 1) {
      const ids = cands.map((x) => x.id);
      const detalle = { via: 'correo', nota: 'ese correo es el responsable de varias conexiones nuevas: no se toca ninguna (manda el location_id)', antiguas: notaAntiguas };
      await insertarClubEvento(c, { ...base, resultado: 'ambiguo', cuentas: ids, detalle });
      return { resultado: 'ambiguo', clave: 'ambiguo', candidatas: ids.length, detalle };
    }
    if (!cands.length) {
      await guardarPendiente(c, claveEmail(email), activo, motivo);
      const detalle = { via: 'correo', nota: 'ninguna conexión nueva con ese responsable: se aplicará cuando ese correo entre por SSO como responsable de una conexión nueva', antiguas: notaAntiguas };
      await insertarClubEvento(c, { ...base, resultado: 'pendiente', detalle });
      return { resultado: 'pendiente', clave: 'pendiente_correo', detalle };
    }
    const cuenta = cands[0];
    const cambiadas = await fijarEstado(c, [cuenta.id], activo);
    await c.query(`DELETE FROM club_estado_pendiente WHERE clave = $1`, [claveEmail(email)]);
    const resultado = cambiadas.length ? 'aplicado' : 'sin_cambios';
    const detalle = { via: 'correo', por: 'responsable', cambiadas, antiguas: notaAntiguas };
    await insertarClubEvento(c, { ...base, location_id: cuenta.location_id, resultado, cuentas: [cuenta.id], detalle });
    return { resultado, cuentas: [cuenta.id], cambiadas, location_id: cuenta.location_id, detalle };
  });
  await eventoLog(pg, `club_estado_${r.resultado}`, { location_id: r.location_id || null, email, activo, motivo, cuentas: r.cuentas || [], ...r.detalle });
  if (r.clave) {
    return { code: RESPUESTAS[r.clave].code, body: { ok: true, resultado: r.resultado, via: 'correo', ...(r.candidatas ? { candidatas: r.candidatas } : {}), nota: RESPUESTAS[r.clave].nota } };
  }
  return { code: 200, body: { ok: true, resultado: r.resultado, via: 'correo', cuentas: r.cuentas, cambiadas: r.cambiadas, ai_enabled: activo } };
}

/**
 * SSO certificado por GHL: si hay un estado del Club PENDIENTE para este correo, se aplica SOLO si este correo es el
 * RESPONSABLE de esta conexión, la conexión es NUEVA y es la única conexión nueva de ese responsable (si no, se
 * registra «ambiguo» y no se toca nada). El pendiente se consume una vez. Un miembro del equipo que entra en la
 * subcuenta de otro cliente no le aplica su estado. Si la conexión ya tiene un estado del Club POSTERIOR (club_estado_at:
 * aplicado por subcuenta o a mano por el admin), el pendiente viejo se descarta («pendiente_obsoleto»).
 * @returns {null | { activo: boolean } | { ambiguo: true } | { obsoleto: true }}
 */
export async function aplicarPendientePorEmail(accountId, email, pg = poolReal) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !accountId) return null;
  // camino rápido (cada entrada por SSO pasa por aquí): sin pendiente para ese correo no se abre transacción
  const hay = await pg.query(`SELECT 1 FROM club_estado_pendiente WHERE clave = $1`, [claveEmail(mail)]);
  if (!hay.rows[0]) return null;
  const r = await enTransaccion(pg, async (c) => {
    await c.query(CANDADO, [`club:${claveEmail(mail)}`]);
    const acc = (await c.query(
      `SELECT id, location_id, lower(owner_email) AS responsable, ${ES_NUEVA} AS nueva FROM accounts WHERE id = $1`, [accountId]
    )).rows[0];
    if (!acc || !acc.nueva || acc.responsable !== mail) return null; // no es SU conexión nueva: el pendiente sigue
    const fila = (await c.query(
      `DELETE FROM club_estado_pendiente WHERE clave = $1 RETURNING activo, motivo, ${VIGENTE} AS vigente, updated_at::text AS cuando`, [claveEmail(mail)]
    )).rows[0];
    if (!fila || !fila.vigente) return null;
    const suyas = (await c.query(
      `SELECT id FROM accounts WHERE ${ES_NUEVA} AND lower(owner_email) = $1 ORDER BY id`, [mail]
    )).rows.map((x) => x.id);
    if (suyas.length > 1) {
      const detalle = { via: 'correo_sso', nota: 'el responsable tiene varias conexiones nuevas: no se toca ninguna (manda el location_id)' };
      await insertarClubEvento(c, { location_id: acc.location_id, email: mail, activo: Boolean(fila.activo), motivo: fila.motivo, resultado: 'ambiguo', cuentas: suyas, detalle });
      return { ambiguo: true, activo: Boolean(fila.activo), motivo: fila.motivo, location_id: acc.location_id, cuentas: suyas, detalle };
    }
    // solo si ese estado es POSTERIOR al último que ya tiene la conexión (comparado en SQL, con microsegundos)
    const aplicada = (await c.query(
      `UPDATE accounts SET ai_enabled = $1, club_estado_at = $3::timestamptz
        WHERE id = $2 AND (club_estado_at IS NULL OR club_estado_at < $3::timestamptz) RETURNING id`,
      [Boolean(fila.activo), acc.id, fila.cuando]
    )).rows.length > 0;
    if (!aplicada) {
      const detalle = { via: 'correo_sso', nota: 'la conexión ya tiene un estado del Club más reciente: el pendiente viejo no se aplica' };
      await insertarClubEvento(c, { location_id: acc.location_id, email: mail, activo: Boolean(fila.activo), motivo: fila.motivo, resultado: 'pendiente_obsoleto', cuentas: [acc.id], detalle });
      return { obsoleto: true, activo: Boolean(fila.activo), motivo: fila.motivo, location_id: acc.location_id, cuentas: [acc.id], detalle };
    }
    const detalle = { via: 'correo_sso' };
    await insertarClubEvento(c, { location_id: acc.location_id, email: mail, activo: Boolean(fila.activo), motivo: fila.motivo, resultado: 'pendiente_aplicado', cuentas: [acc.id], detalle });
    return { activo: Boolean(fila.activo), motivo: fila.motivo, location_id: acc.location_id, cuentas: [acc.id], detalle };
  });
  if (!r) return null;
  const kind = r.ambiguo ? 'club_estado_ambiguo' : r.obsoleto ? 'club_estado_pendiente_obsoleto' : 'club_estado_pendiente_aplicado';
  await eventoLog(pg, kind, { location_id: r.location_id, email: mail, activo: r.activo, motivo: r.motivo, cuentas: r.cuentas, ...r.detalle });
  if (r.ambiguo) return { ambiguo: true };
  if (r.obsoleto) return { obsoleto: true };
  return { activo: r.activo };
}
