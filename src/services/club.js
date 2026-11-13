// 🏛️ CLUB DE SISTEMAS — conexiones nuevas seguras + interruptor del Club (migración 059).
//
// 1) crearConexionNueva(): el ÚNICO sitio donde nace una conexión sola (callback OAuth, enlace de agencia /ghl-app y
//    SSO de la Custom Page). Toda conexión nueva nace en 🧪 MODO PRUEBA (test_mode=true, etiqueta «test-setter» o la
//    de la plantilla) y su «Setter principal» copia la plantilla global «plantilla_conexion» {provider_id, model,
//    prompt_partida}. Las conexiones que YA existen no se tocan: aquí solo se INSERTA.
// 2) aplicarEstadoClub(): lo que hace POST /api/club/estado (routes/club.js). Pone ai_enabled = activo en TODAS las
//    conexiones NUEVAS de una subcuenta (o en la conexión nueva cuyo CORREO DEL CLUB CONFIRMADO es ese correo).
//    ai_enabled es el interruptor maestro que el cliente no puede tocar (solo admin). Si la conexión aún no existe, el
//    estado queda PENDIENTE y se aplica al crearse (por subcuenta) o cuando soporte CONFIRME ese correo del Club en una
//    conexión (por correo). Si hay ambigüedad, no toca nada.
//
// SEGURIDAD
//  · Conexiones ANTERIORES al Club (creadas antes de la migración 059: DEP, Jonathan, Rodrigo…) → nunca se tocan desde
//    aquí («protegida»). La comparación con el corte se hace en SQL (microsegundos; en JS se truncaría a ms).
//  · CORREO DEL CLUB de una conexión (migración 061, correoDelClubSQL) = SOLO club_email: lo CONFIRMA soporte en la ficha
//    de la conexión (o el admin por la API) al instalar Hermes, y es único (índice de la 061). Repaso de la fase C: el
//    RESPONSABLE (owner_email, el primero que entra por SSO: a menudo soporte) y el correo de la subcuenta en GHL
//    (ghl_location_email: lo edita el propio cliente en su subcuenta) ya NO enlazan solos: con ellos un cliente podía
//    quedarse con el alta o la baja de otro comprador, y una prueba del interruptor con el correo de soporte apagaba al
//    primer cliente que soporte abría. Ahora solo son PISTAS para soporte («sin_confirmar» en el registro y en la ficha).
//    Los «correos autorizados» tampoco sirven (el cliente los edita en su pestaña Accesos).
//  · Fase C3: todos los correos del Club pasan por UNA normalización (analizarCorreo), que rechaza los caracteres
//    invisibles, de control y los espacios; y el correo del Club no puede ser uno de soporte, de la agencia ni de un admin
//    de Hermes (motivoNoClub; lista ampliable en Configuración → «Correo del Club»).
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

/**
 * SQL: ¿el parámetro (un correo YA en minúsculas) es el CORREO DEL CLUB CONFIRMADO de la conexión (club_email)? Es lo
 * único que enlaza una conexión con un correo de compra (lo confirma soporte; es único en la base).
 * @param {string} param marcador del parámetro, p. ej. '$1'   @param {string} t prefijo de la tabla, p. ej. 'a.'
 */
export const correoDelClubSQL = (param, t = '') =>
  `(${param} <> '' AND COALESCE(${t}club_email, '') = ${param})`;

/**
 * SQL: conexión SIN correo del Club confirmado cuyo responsable o correo de la subcuenta en GHL es el parámetro. NO
 * enlaza nada: es la pista que se le da a soporte («confirma el correo del Club en esta conexión») en el registro, en la
 * respuesta 202 y en las devoluciones que van a revisión.
 */
export const SIN_CONFIRMAR_SQL = (param, t = '') =>
  `(${param} <> '' AND COALESCE(${t}club_email, '') = ''
        AND (lower(COALESCE(${t}owner_email, '')) = ${param} OR COALESCE(${t}ghl_location_email, '') = ${param}))`;
const MAX_PISTAS = 20;

// ── Correos: UNA sola normalización para todo el Club (fase C3) ─────────────────────────────────────────────────────
// La usan el «Correo del Club» de la ficha (sanearClubEmail), el interruptor (validarCuerpoClub), las devoluciones
// (services/devoluciones.js · validarCuerpoDevolucion), el SSO (aplicarPendientePorEmail), la pista del correo de la
// subcuenta (vincularCorreoSubcuenta) y las pistas «Usar» de la ficha (pistasParaFicha). Quita los espacios ASCII de
// alrededor (lo mismo que hacen el navegador y GHL), pasa a minúsculas y RECHAZA —nunca «arregla»— lo que haría que un
// correo no casara nunca con el de la compra o que dos correos distintos para GHL fueran el mismo para Hermes:
// caracteres invisibles o de formato (en cualquier sitio, también al principio o al final), de control, espacios que no
// son ASCII o dentro del correo, el signo kelvin (U+212A, que en minúsculas da una «k») y el texto sin la forma normal de
// Unicode (NFC: p. ej. la tilde separada de la letra). Lo encontró el verificador de la fase C (ataque V3): un club_email
// con U+200B se guardaba, la ficha decía «confirmado» y nunca casaba con el correo que manda el workflow.
const RE_CORREO = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;
// invisibles: los de formato (\p{Cf}: U+00AD, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF…) y los rellenos
// que Unicode no clasifica como formato pero no se ven (U+034F, U+115F, U+1160, U+17B4, U+17B5, U+180B–U+180F, U+2800,
// U+3164, U+FE00–U+FE0F, U+FFA0, U+E0100–U+E01EF)
const RE_INVISIBLE = /[\p{Cf}\u{34F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{E0100}-\u{E01EF}]/u;
const RE_ESPACIO = /[\s\p{Z}]/u;
// de control (U+0000–U+001F, U+007F–U+009F), sin asignar, de uso privado y mitades sueltas de un par sustituto
const RE_CONTROL = /[\p{Cc}\p{Cn}\p{Co}\p{Cs}]/u;
const ESPACIO_ASCII = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
const NOMBRE_CARACTER = {
  0x00a0: 'espacio duro', 0x00ad: 'guion suave', 0x200b: 'espacio de ancho cero', 0x200c: 'separador de ancho cero',
  0x200d: 'unión de ancho cero', 0x200e: 'marca de izquierda a derecha', 0x200f: 'marca de derecha a izquierda',
  0x202e: 'cambio de sentido del texto', 0x2060: 'unión de palabras', 0x3164: 'relleno invisible', 0xfeff: 'marca BOM',
  0x212a: 'signo kelvin',
};
const codigoCaracter = (ch) => {
  const cp = ch.codePointAt(0);
  const u = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  return NOMBRE_CARACTER[cp] ? `${u}, ${NOMBRE_CARACTER[cp]}` : u;
};
// recorte de los espacios ASCII de alrededor, en tiempo lineal (sin expresiones regulares)
function recortarAscii(s) {
  let i = 0;
  let j = s.length;
  while (i < j && ESPACIO_ASCII.has(s.charCodeAt(i))) i++;
  while (j > i && ESPACIO_ASCII.has(s.charCodeAt(j - 1))) j--;
  return s.slice(i, j);
}

/**
 * Analiza un correo con LA normalización del Club.
 * @returns {{ correo: string } | { correo: '', tipo: 'invisible'|'espacio'|'control'|'compuesto'|'confuso'|'formato', motivo: string }}
 *   correo: en minúsculas y sin espacios alrededor. Si no vale, correo '' con el tipo y el motivo en español
 *   («lleva un carácter invisible (U+200B, espacio de ancho cero)»).
 */
export function analizarCorreo(v) {
  if (typeof v !== 'string') return { correo: '', tipo: 'formato', motivo: 'no es un correo' };
  if (v.length > 1000) return { correo: '', tipo: 'formato', motivo: 'es demasiado largo' };
  const s = recortarAscii(v);
  if (!s) return { correo: '', tipo: 'formato', motivo: 'está vacío' };
  if (s.length > 254) return { correo: '', tipo: 'formato', motivo: 'es demasiado largo' };
  let m = s.match(RE_INVISIBLE);
  if (m) return { correo: '', tipo: 'invisible', motivo: `lleva un carácter invisible (${codigoCaracter(m[0])})` };
  m = s.match(RE_ESPACIO);
  if (m) return { correo: '', tipo: 'espacio', motivo: m[0] === ' ' ? 'tiene espacios dentro' : `tiene un espacio raro (${codigoCaracter(m[0])})` };
  m = s.match(RE_CONTROL);
  if (m) return { correo: '', tipo: 'control', motivo: `lleva un carácter de control (${codigoCaracter(m[0])})` };
  // (antes que la forma normal: el signo kelvin también cambia con NFC, y así el aviso dice qué carácter es)
  const confuso = [...s].find((ch) => ch.codePointAt(0) > 0x7f && /^[\x00-\x7f]+$/.test(ch.toLowerCase()));
  if (confuso) return { correo: '', tipo: 'confuso', motivo: `lleva un carácter que en minúsculas se convierte en otra letra (${codigoCaracter(confuso)})` };
  if (s.normalize('NFC') !== s) return { correo: '', tipo: 'compuesto', motivo: 'lleva una letra escrita de forma rara (Unicode sin normalizar, p. ej. la tilde separada de la letra)' };
  const correo = s.toLowerCase();
  if (correo.length > 254 || !RE_CORREO.test(correo)) return { correo: '', tipo: 'formato', motivo: 'no tiene forma de correo' };
  return { correo };
}

/** Correo con la normalización del Club (analizarCorreo), o '' si no vale. */
export function normalizarCorreo(v) {
  return analizarCorreo(v).correo;
}

const CONSEJO_CORREO = {
  invisible: 'Suele colarse al copiar y pegar, y con él nunca casaría con el correo de la compra: escríbelo a mano y vuelve a guardar.',
  espacio: 'Un correo no lleva espacios: quítalos (o escríbelo a mano) y vuelve a guardar.',
  control: 'Escríbelo a mano y vuelve a guardar.',
  compuesto: 'Suele pasar al copiar y pegar, y así nunca casaría con el correo de la compra: escríbelo a mano y vuelve a guardar.',
  confuso: 'Así nunca casaría con el correo de la compra: escríbelo a mano y vuelve a guardar.',
};

/** club_email que llega del admin: { ok:true, valor: correo | null (vacío = quitarlo) } o { ok:false, error }. */
export function sanearClubEmail(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, valor: null };
  const a = analizarCorreo(v);
  if (a.correo) return { ok: true, valor: a.correo };
  if (CONSEJO_CORREO[a.tipo]) return { ok: false, error: `El correo del Club ${a.motivo}. ${CONSEJO_CORREO[a.tipo]}` };
  return { ok: false, error: 'El correo del Club no es válido: escribe un correo (p. ej. el de la compra) o déjalo vacío.' };
}

// ── Correos que NUNCA pueden ser el correo del Club de un cliente (fase C3) ─────────────────────────────────────────
// Los de soporte y de la agencia: con uno de ellos confirmado en la conexión de un cliente, una prueba del interruptor o
// una devolución hecha con ese correo acabarían en ese cliente (y el botón «Usar» del responsable lo dejaba a un clic,
// porque soporte suele ser el primero que abre Hermes). Siempre: los dos de soporte (aquí, fijos) y los usuarios ADMIN de
// Hermes cuyo usuario es un correo. Además, los que el admin añada en Configuración → «Correo del Club» (setting
// club_correos = { no_club: [correo | «@dominio.com» (ese dominio y sus subdominios)] }).
export const CORREOS_SOPORTE = Object.freeze(['soporte@departamentodisruptivo.com', 'soporte@soyjonathanalef.com']);
const MAX_NO_CLUB = 200;

// una entrada de la lista: correo (normalizado) o «@dominio» en minúsculas; null si no vale
function entradaNoClub(v) {
  if (typeof v !== 'string') return null;
  const s = recortarAscii(v);
  if (s.startsWith('@')) {
    const a = analizarCorreo(`x${s}`);
    return a.correo ? a.correo.slice(1) : null;
  }
  return analizarCorreo(s).correo || null;
}

/** Lista guardada → siempre válida: sin lo que no vale, sin duplicados y sin los fijos (cuentan siempre). */
export function sanearNoClub(v) {
  const out = [];
  for (const x of (Array.isArray(v) ? v : []).slice(0, MAX_NO_CLUB * 2)) {
    const e = entradaNoClub(x);
    if (e && !CORREOS_SOPORTE.includes(e) && !out.includes(e)) out.push(e);
  }
  return out.slice(0, MAX_NO_CLUB);
}

/** Cambio del admin: lista o texto (uno por línea, o separados por comas) → { ok:true, valor } | { ok:false, error }. */
export function validarNoClub(entrada) {
  const lineas = Array.isArray(entrada) ? entrada : typeof entrada === 'string' ? entrada.slice(0, 50_000).split(/[\n,;]+/) : null;
  if (!lineas) return { ok: false, error: 'Manda la lista de correos (uno por línea).' };
  const valor = [];
  for (const bruto of lineas) {
    if (typeof bruto !== 'string') return { ok: false, error: 'Cada línea tiene que ser un correo o un dominio (@dominio.com).' };
    const t = recortarAscii(bruto);
    if (!t) continue;
    const e = entradaNoClub(t);
    if (!e) {
      const a = analizarCorreo(t.startsWith('@') ? `x${t}` : t);
      return { ok: false, error: `«${t.slice(0, 80)}» no es un correo ni un dominio (@dominio.com)${a.tipo !== 'formato' ? `: ${a.motivo}` : ''}.` };
    }
    if (!CORREOS_SOPORTE.includes(e) && !valor.includes(e)) valor.push(e);
  }
  if (valor.length > MAX_NO_CLUB) return { ok: false, error: `Como mucho ${MAX_NO_CLUB} correos o dominios.` };
  return { ok: true, valor };
}

/** { fijos, no_club, admins }: los de soporte, los de Configuración y los usuarios admin de Hermes que son un correo. */
export async function leerCorreosNoClub(pg = poolReal) {
  const ajuste = (await pg.query(`SELECT value FROM settings WHERE key = 'club_correos'`)).rows[0]?.value;
  const admins = (await pg.query(`SELECT username FROM users WHERE role = 'admin' ORDER BY id`)).rows
    .map((r) => normalizarCorreo(r.username)).filter(Boolean);
  return { fijos: [...CORREOS_SOPORTE], no_club: sanearNoClub(ajuste?.no_club), admins: [...new Set(admins)] };
}

export async function guardarCorreosNoClub(lista, pg = poolReal) {
  const no_club = sanearNoClub(lista);
  await pg.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('club_correos', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify({ no_club })]
  );
  return no_club;
}

/**
 * Si ese correo (YA normalizado) no puede ser el correo del Club de un cliente, el motivo en español; si puede, null.
 * corto → para una pista de la ficha; si no, el mensaje del 400 al guardarlo.
 */
export function motivoNoClub(correo, noClub, { corto = false } = {}) {
  if (!correo || !noClub) return null;
  const arroba = correo.lastIndexOf('@');
  const dominio = arroba >= 0 ? correo.slice(arroba + 1) : '';
  const lista = noClub.no_club || [];
  let de = null;
  if ((noClub.admins || []).includes(correo)) de = 'es de un administrador de Hermes';
  else if ((noClub.fijos || []).includes(correo) || lista.includes(correo)
    || lista.some((e) => e.startsWith('@') && (dominio === e.slice(1) || dominio.endsWith(`.${e.slice(1)}`)))) {
    de = 'es de soporte o de la agencia (Configuración → «Correo del Club»)';
  }
  if (!de) return null;
  return corto
    ? `${de}: no se puede usar como correo del Club`
    : `Ese correo ${de}: no puede ser el correo del Club de un cliente. Escribe el correo con el que compró el cliente (compruébalo en 4ttZ).`;
}

/** Conexiones que YA tienen confirmado como correo del Club uno que no puede serlo (p. ej. se añadió luego a la lista). */
export async function conexionesConCorreoNoClub(noClub, pg = poolReal) {
  const filas = (await pg.query(`SELECT id, name, alias, club_email FROM accounts WHERE club_email IS NOT NULL ORDER BY id`)).rows;
  return filas.filter((f) => motivoNoClub(f.club_email, noClub))
    .map((f) => ({ id: f.id, nombre: f.alias || f.name, club_email: f.club_email }));
}

/**
 * Pistas para el «Correo del Club» en la ficha (solo admin): el responsable y el correo de la subcuenta, con la MISMA
 * normalización y las mismas reglas que aplica el servidor al guardarlo. «Usar» (usable) solo se ofrece con un correo
 * que se podría guardar: válido, que no es de soporte, de la agencia ni de un admin de Hermes, y que no es ya el correo
 * del Club de la conexión. Sin la lista (no se pudo leer) no se ofrece ninguno.
 * @returns {Array<{ de: 'responsable'|'correo_subcuenta', email: string, usable: boolean, motivo?: string, confirmado?: true }>}
 */
export function pistasParaFicha(acc, noClub) {
  const actual = acc?.club_email || '';
  const out = [];
  for (const [de, valor] of [['responsable', acc?.owner_email], ['correo_subcuenta', acc?.ghl_location_email]]) {
    if (typeof valor !== 'string' || !valor.trim()) continue;
    const a = analizarCorreo(valor);
    if (!a.correo) { out.push({ de, email: valor.trim().slice(0, 254), usable: false, motivo: `no sirve como correo del Club: ${a.motivo}` }); continue; }
    if (!noClub) { out.push({ de, email: a.correo, usable: false, motivo: 'no se ha podido comprobar la lista de correos de soporte: recarga la ficha' }); continue; }
    const no = motivoNoClub(a.correo, noClub, { corto: true });
    if (no) { out.push({ de, email: a.correo, usable: false, motivo: no }); continue; }
    out.push({ de, email: a.correo, usable: a.correo !== actual, ...(a.correo === actual ? { confirmado: true } : {}) });
  }
  return out;
}

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
  const emailCrudo = String(b.email ?? '');
  // longitudes antes de cualquier expresión regular (un texto enorme no puede costar CPU)
  if (location_id.length > 200) return { ok: false, error: 'location_id no válido' };
  if (emailCrudo.length > 1000) return { ok: false, error: 'email no válido' };
  // un merge field de GHL vacío o sin resolver ({{contact.x}}) cuenta como «no viene»
  const sinResolver = (s) => !s || /\{\{.*\}\}/.test(s);
  const loc = sinResolver(location_id) ? '' : location_id;
  if (loc && !RE_LOC.test(loc)) return { ok: false, error: 'location_id no válido' };
  // 🏛️ la MISMA normalización que el correo del Club (analizarCorreo, sobre el texto CRUDO: un trim() de JS quitaría un
  // BOM o un espacio duro de los bordes y dos correos distintos para GHL serían el mismo para Hermes). Uno con un carácter
  // invisible no podría casar nunca con un club_email: se rechaza (400, visible en GHL) en vez de quedar pendiente sin
  // que nadie lo vea.
  let mail = '';
  if (!sinResolver(emailCrudo.trim())) {
    const a = analizarCorreo(emailCrudo);
    if (!a.correo) return { ok: false, error: a.tipo === 'formato' ? 'email no válido' : `email no válido: ${a.motivo}` };
    mail = a.correo;
  }
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
  pendiente_correo: { code: 202, nota: 'Ninguna conexión tiene ese correo del Club confirmado: el estado queda pendiente y se aplicará cuando soporte confirme ese correo en la conexión del cliente (Conexiones → la conexión → Conexión GHL → Club de Sistemas).' },
  ambiguo: { code: 202, nota: 'Ese correo del Club está confirmado en varias conexiones (no debería pasar: es único): no se ha tocado nada. Manda el location_id o deja ese correo del Club en una sola conexión.' },
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

  // B) Solo CORREO: la conexión NUEVA cuyo correo del Club CONFIRMADO (club_email) es ese. Ninguna → pendiente (se aplica
  //    cuando soporte confirme ese correo en una conexión). club_email es único (061): dos no puede haber; si las hubiera,
  //    no se toca nada. Las conexiones sin confirmar que tienen ese correo de responsable o de subcuenta NO se tocan: se
  //    anotan como pista para soporte («sin_confirmar»).
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
      `SELECT id, location_id FROM accounts WHERE ${ES_NUEVA} AND ${correoDelClubSQL('$1')} ORDER BY id`, [email]
    )).rows;
    const antiguas = (await c.query(
      `SELECT count(*)::int AS n FROM accounts WHERE NOT ${ES_NUEVA} AND (lower(owner_email) = $1 OR authorized_emails @> $2::jsonb)`,
      [email, JSON.stringify([email])]
    )).rows[0]?.n || 0;
    const notaAntiguas = antiguas ? `${antiguas} conexión(es) anteriores al Club con ese correo: no se tocan` : undefined;
    if (cands.length > 1) {
      const ids = cands.map((x) => x.id);
      const detalle = { via: 'correo', nota: 'ese correo del Club está confirmado en varias conexiones (no debería pasar: es único): no se toca ninguna; deja ese correo del Club en una sola conexión', antiguas: notaAntiguas };
      await insertarClubEvento(c, { ...base, resultado: 'ambiguo', cuentas: ids, detalle });
      return { resultado: 'ambiguo', clave: 'ambiguo', candidatas: ids.length, detalle };
    }
    if (!cands.length) {
      await guardarPendiente(c, claveEmail(email), activo, motivo);
      const sinConfirmar = (await c.query(
        `SELECT id FROM accounts WHERE ${ES_NUEVA} AND ${SIN_CONFIRMAR_SQL('$1')} ORDER BY id LIMIT ${MAX_PISTAS}`, [email]
      )).rows.map((x) => x.id);
      const detalle = {
        via: 'correo',
        nota: sinConfirmar.length
          ? `ninguna conexión tiene ese correo del Club confirmado; ${sinConfirmar.length === 1 ? 'la conexión' : 'las conexiones'} #${sinConfirmar.join(', #')} lo ${sinConfirmar.length === 1 ? 'tiene' : 'tienen'} de responsable o de correo de la subcuenta SIN confirmar: no se ${sinConfirmar.length === 1 ? 'toca' : 'tocan'}; se aplicará cuando soporte confirme el correo del Club en la del comprador`
          : 'ninguna conexión tiene ese correo del Club confirmado: se aplicará cuando soporte lo confirme en la conexión del comprador',
        sin_confirmar: sinConfirmar.length ? sinConfirmar : undefined,
        antiguas: notaAntiguas,
      };
      await insertarClubEvento(c, { ...base, resultado: 'pendiente', detalle });
      return { resultado: 'pendiente', clave: 'pendiente_correo', detalle, sinConfirmar };
    }
    const cuenta = cands[0];
    const cambiadas = await fijarEstado(c, [cuenta.id], activo);
    await c.query(`DELETE FROM club_estado_pendiente WHERE clave = $1`, [claveEmail(email)]);
    const resultado = cambiadas.length ? 'aplicado' : 'sin_cambios';
    const detalle = { via: 'correo', por: 'club_email', cambiadas, antiguas: notaAntiguas };
    await insertarClubEvento(c, { ...base, location_id: cuenta.location_id, resultado, cuentas: [cuenta.id], detalle });
    return { resultado, cuentas: [cuenta.id], cambiadas, location_id: cuenta.location_id, detalle };
  });
  await eventoLog(pg, `club_estado_${r.resultado}`, { location_id: r.location_id || null, email, activo, motivo, cuentas: r.cuentas || [], ...r.detalle });
  if (r.clave) {
    return {
      code: RESPUESTAS[r.clave].code,
      body: {
        ok: true, resultado: r.resultado, via: 'correo',
        ...(r.candidatas ? { candidatas: r.candidatas } : {}),
        ...(r.sinConfirmar?.length ? { sin_confirmar: r.sinConfirmar } : {}),
        nota: RESPUESTAS[r.clave].nota,
      },
    };
  }
  return { code: 200, body: { ok: true, resultado: r.resultado, via: 'correo', cuentas: r.cuentas, cambiadas: r.cambiadas, ai_enabled: activo } };
}

// ── Estados PENDIENTES por correo: se aplican cuando soporte CONFIRMA ese correo del Club en una conexión ──────────────
// El enlace es SOLO el club_email confirmado (routes/accounts.js → aplicarPendientesDeConexion). El SSO (portal.js) lo
// reintenta si el usuario que entra ES ese correo del Club confirmado (por si al confirmarlo falló algo); el responsable
// y el correo de la subcuenta en GHL ya no aplican nada. Hay UN pendiente por correo (guardarPendiente lo pisa: siempre
// el ÚLTIMO estado que llegó); se consume una vez (DELETE) y queda registrado como «pendiente_aplicado» en club_eventos
// (registro durable) y en el registro de eventos del panel.

/**
 * Dentro de una transacción con el candado de ESE correo ya tomado. Se aplica SOLO si el correo es el correo del Club
 * confirmado de esta conexión y la conexión es NUEVA (si hubiera otra con el mismo, «ambiguo»: no se toca nada; con el
 * índice único de la 061 no puede pasar). Si la conexión ya tiene un estado del Club POSTERIOR (club_estado_at: aplicado
 * por subcuenta, por correo o a mano por el admin), el pendiente viejo se descarta («pendiente_obsoleto»).
 */
async function aplicarPendienteEnTx(c, accountId, mail, via) {
  const acc = (await c.query(
    `SELECT id, location_id, ${ES_NUEVA} AS nueva, ${correoDelClubSQL('$2')} AS suyo FROM accounts WHERE id = $1`, [accountId, mail]
  )).rows[0];
  if (!acc || !acc.nueva || !acc.suyo) return null; // no es SU conexión nueva: el pendiente sigue esperando
  const fila = (await c.query(
    `DELETE FROM club_estado_pendiente WHERE clave = $1 RETURNING activo, motivo, ${VIGENTE} AS vigente, updated_at::text AS cuando`, [claveEmail(mail)]
  )).rows[0];
  if (!fila || !fila.vigente) return null;
  const base = { location_id: acc.location_id, email: mail, activo: Boolean(fila.activo), motivo: fila.motivo };
  const suyas = (await c.query(
    `SELECT id FROM accounts WHERE ${ES_NUEVA} AND ${correoDelClubSQL('$1')} ORDER BY id`, [mail]
  )).rows.map((x) => x.id);
  if (suyas.length > 1) {
    const detalle = { via, nota: 'ese correo del Club está confirmado en varias conexiones (no debería pasar: es único): no se toca ninguna; deja ese correo del Club en una sola conexión' };
    await insertarClubEvento(c, { ...base, resultado: 'ambiguo', cuentas: suyas, detalle });
    return { ambiguo: true, ...base, cuentas: suyas, detalle };
  }
  // solo si ese estado es POSTERIOR al último que ya tiene la conexión (comparado en SQL, con microsegundos)
  const aplicada = (await c.query(
    `UPDATE accounts SET ai_enabled = $1, club_estado_at = $3::timestamptz
      WHERE id = $2 AND (club_estado_at IS NULL OR club_estado_at < $3::timestamptz) RETURNING id`,
    [base.activo, acc.id, fila.cuando]
  )).rows.length > 0;
  if (!aplicada) {
    const detalle = { via, nota: 'la conexión ya tiene un estado del Club más reciente: el pendiente viejo no se aplica' };
    await insertarClubEvento(c, { ...base, resultado: 'pendiente_obsoleto', cuentas: [acc.id], detalle });
    return { obsoleto: true, ...base, cuentas: [acc.id], detalle };
  }
  const detalle = { via };
  await insertarClubEvento(c, { ...base, resultado: 'pendiente_aplicado', cuentas: [acc.id], detalle });
  return { ...base, cuentas: [acc.id], detalle };
}

// Lo que se devuelve fuera, y su anotación en el registro de eventos del panel (siempre FUERA de la transacción).
async function cerrarPendiente(pg, r) {
  if (!r) return null;
  const kind = r.ambiguo ? 'club_estado_ambiguo' : r.obsoleto ? 'club_estado_pendiente_obsoleto' : 'club_estado_pendiente_aplicado';
  await eventoLog(pg, kind, { location_id: r.location_id, email: r.email, activo: r.activo, motivo: r.motivo, cuentas: r.cuentas, ...r.detalle });
  if (r.ambiguo) return { ambiguo: true };
  if (r.obsoleto) return { obsoleto: true };
  return { activo: r.activo };
}

/**
 * Si hay un estado del Club PENDIENTE para este correo, se aplica a esta conexión cuando ese correo es su correo del Club
 * CONFIRMADO (aplicarPendienteEnTx). Lo llama el SSO de la Custom Page (via 'correo_sso'): solo reintenta lo que no se
 * pudo aplicar al confirmar el club_email; que el usuario sea el responsable o tenga el correo de la subcuenta no basta
 * (p. ej. soporte, que abre muchas subcuentas, no se lleva a ninguna una prueba hecha con su correo).
 * @returns {Promise<null | { activo: boolean } | { ambiguo: true } | { obsoleto: true }>}
 */
export async function aplicarPendientePorEmail(accountId, email, pg = poolReal, { via = 'correo_sso' } = {}) {
  const mail = normalizarCorreo(email); // la misma normalización que el club_email (con un invisible no casaría nunca)
  if (!mail || !accountId) return null;
  // camino rápido (cada entrada por SSO pasa por aquí): sin pendiente para ese correo no se abre transacción
  const hay = await pg.query(`SELECT 1 FROM club_estado_pendiente WHERE clave = $1`, [claveEmail(mail)]);
  if (!hay.rows[0]) return null;
  const r = await enTransaccion(pg, async (c) => {
    await c.query(CANDADO, [`club:${claveEmail(mail)}`]);
    return aplicarPendienteEnTx(c, accountId, mail, via);
  });
  return cerrarPendiente(pg, r);
}

/**
 * Tras CONFIRMAR (o cambiar) el club_email de una conexión: aplica el estado del Club que estuviera PENDIENTE para ese
 * correo (el último que llegó). Solo el club_email: el responsable y el correo de la subcuenta no enlazan.
 * El candado de ese correo se toma ANTES de mirar si hay pendiente: un estado que esté entrando a la vez por el
 * interruptor (y que aún no viera este club_email) termina primero y su pendiente se ve aquí; nunca queda colgado.
 * @returns {Promise<Array<{ activo: boolean } | { ambiguo: true } | { obsoleto: true }>>}
 */
export async function aplicarPendientesDeConexion(accountId, pg = poolReal, { via = 'club_email' } = {}) {
  const acc = (await pg.query(`SELECT club_email FROM accounts WHERE id = $1`, [accountId])).rows[0];
  const mail = acc?.club_email || '';
  if (!mail) return [];
  const r = await enTransaccion(pg, async (c) => {
    await c.query(CANDADO, [`club:${claveEmail(mail)}`]);
    return aplicarPendienteEnTx(c, accountId, mail, via);
  });
  const out = await cerrarPendiente(pg, r);
  return out ? [out] : [];
}

/**
 * Para la ficha de la conexión (solo admin): los estados del Club que esperan por alguno de los correos de esta conexión
 * (correo del Club confirmado, responsable o correo de la subcuenta), para que soporte los vea ANTES de confirmar: si
 * confirma un correo, se aplica el último que espera por él. Con noClub (leerCorreosNoClub), los que esperan por un
 * correo de soporte, de la agencia o de un admin (una prueba) llevan confirmable:false y el motivo: el servidor no deja
 * confirmarlos en la conexión de un cliente.
 */
export async function pendientesParaFicha(acc, pg = poolReal, noClub = null) {
  const de = new Map(); // correo → de dónde sale en la ficha
  const meter = (valor, origen) => {
    const mail = normalizarCorreo(valor);
    if (mail) de.set(mail, [...(de.get(mail) || []), origen]);
  };
  meter(acc?.club_email, 'club_email');
  meter(acc?.owner_email, 'responsable');
  meter(acc?.ghl_location_email, 'correo_subcuenta');
  if (!de.size) return [];
  const r = await pg.query(
    `SELECT clave, activo, motivo, updated_at, ${VIGENTE} AS vigente FROM club_estado_pendiente
      WHERE clave = ANY($1::text[]) ORDER BY updated_at DESC`,
    [[...de.keys()].map(claveEmail)]
  );
  return r.rows.map((p) => {
    const email = p.clave.slice('email:'.length);
    const no = motivoNoClub(email, noClub, { corto: true });
    return {
      email, de: de.get(email) || [], activo: p.activo, motivo: p.motivo, updated_at: p.updated_at, vigente: p.vigente,
      ...(no ? { confirmable: false, no_confirmable: no } : {}),
    };
  });
}

// ── Correo de la SUBCUENTA en GHL (migración 061) ───────────────────────────────────────────────────────────────────
// Se lee de GHL (GET /locations/{id}, con el permiso locations.readonly que Hermes ya pide) al crear una conexión del
// Club y al RECONECTARLA por OAuth (services/correoSubcuenta.js). Es solo una PISTA para soporte (la ficha la enseña con
// un botón para usarla como correo del Club): no enlaza nada, porque el cliente puede cambiarla en su subcuenta antes de
// que se lea. Se guarda la PRIMERA vez; si en una reconexión GHL tiene otra, no se pisa y se anota
// «club_correo_subcuenta_distinto» en el registro de eventos.

/**
 * ¿Hay que pedir a GHL el correo de esta subcuenta? Conexión del Club que aún no lo tiene; con releer (reconexión por
 * OAuth), también si ya lo tiene, para ver si GHL tiene ahora otro. Nunca lanza.
 */
export async function quiereCorreoSubcuenta(accountId, pg = poolReal, { releer = false } = {}) {
  try {
    const r = await pg.query(
      `SELECT 1 FROM accounts WHERE id = $1 AND ${ES_NUEVA} AND ($2::boolean OR COALESCE(ghl_location_email, '') = '')`,
      [accountId, Boolean(releer)]
    );
    return Boolean(r.rows[0]);
  } catch {
    return false;
  }
}

/**
 * Guarda el correo de la subcuenta (si la conexión es del Club y aún no lo tenía). NO aplica estados pendientes: el
 * correo de la subcuenta no enlaza nada (si hay uno esperando por ese correo, se anota para que soporte lo vea). Nunca
 * lanza: una instalación o un SSO no se rompen por esto.
 * @returns {Promise<{ estado: 'guardado'|'ya_estaba'|'distinto'|'anterior_al_club'|'no_existe'|'sin_correo'|'error', motivo?: string }>}
 *   motivo (con sin_correo): por qué no vale el correo que tiene GHL (p. ej. «lleva un carácter invisible (U+200B…)»).
 */
export async function vincularCorreoSubcuenta({ accountId, correo, origen = '' }, pg = poolReal) {
  const analisis = analizarCorreo(correo);
  const mail = analisis.correo;
  if (!mail) return { estado: 'sin_correo', ...(typeof correo === 'string' && correo.trim() ? { motivo: analisis.motivo } : {}) };
  let r;
  try {
    r = await enTransaccion(pg, async (c) => {
      const acc = (await c.query(
        `SELECT id, ghl_location_email, ${ES_NUEVA} AS nueva FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]
      )).rows[0];
      if (!acc) return { estado: 'no_existe' };
      if (!acc.nueva) return { estado: 'anterior_al_club' };
      if (acc.ghl_location_email) return { estado: acc.ghl_location_email === mail ? 'ya_estaba' : 'distinto', guardado: acc.ghl_location_email };
      await c.query(`UPDATE accounts SET ghl_location_email = $2, ghl_location_email_at = now() WHERE id = $1`, [acc.id, mail]);
      const espera = (await c.query(`SELECT activo, motivo FROM club_estado_pendiente WHERE clave = $1`, [claveEmail(mail)])).rows[0];
      return { estado: 'guardado', espera };
    });
  } catch (err) {
    await eventoLog(pg, 'club_correo_subcuenta_error', { account: accountId, origen, error: String(err?.message || err).slice(0, 200) });
    return { estado: 'error' };
  }
  if (r.estado === 'guardado') {
    await eventoLog(pg, 'club_correo_subcuenta_guardado', {
      account: accountId, email: mail, origen,
      ...(r.espera ? {
        pendiente: { activo: Boolean(r.espera.activo), motivo: r.espera.motivo },
        nota: 'hay un estado del Club esperando por este correo: NO se aplica solo (el correo de la subcuenta no enlaza). Si es el correo de la compra, confírmalo en «Correo del Club» de la conexión y se aplicará.',
      } : {}),
    });
    return { estado: 'guardado' };
  }
  if (r.estado === 'distinto') {
    await eventoLog(pg, 'club_correo_subcuenta_distinto', {
      account: accountId, guardado: r.guardado, en_ghl: mail, origen,
      nota: 'GHL tiene ahora otro correo en la subcuenta: la pista guardada no se cambia sola. Lo que cuenta es el «Correo del Club» confirmado de la conexión: revísalo si hace falta.',
    });
  }
  return { estado: r.estado };
}
