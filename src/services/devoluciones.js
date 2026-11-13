// 🏛️ CLUB DE SISTEMAS · DEVOLUCIONES que se evalúan solas (POST /api/club/devolucion, migración 060).
//
// Regla aprobada por la persona (los números se editan en Configuración → «Devoluciones del Club»):
//  · Se piden en el formulario de devoluciones en los PLAZO (14) días naturales siguientes al cobro (hora de Madrid).
//  · CUENTA: se aprueba si la IA de su asistente Hermes ha consumido MAX_IA_USD (5) USD o menos desde el cobro (precio al
//    cliente congelado en llm_usage.billed_usd, sumado en sus conexiones); si más, se deniega con el motivo.
//  · BRAIN: se aprueba si ha hecho MAX_BRAIN_TAREAS (10) tareas o menos desde el cobro (lo cuenta el Brain en
//    brain_uso_url); si más, se deniega.
//  · Si falta un dato o no se puede medir → «revision» (la decide soporte).
// 💸 NUNCA se aprueba por un fallo: un error, un dato que falta, una respuesta rara o una incoherencia → «revision».
//    Solo una medida limpia y dentro del límite da «aprobada».
//
// Cada solicitud queda en club_devoluciones, idempotente por contacto + producto + día del cobro: repetir la misma
// petición devuelve la decisión guardada y no vuelve a avisar a GHL. El resultado se manda a GHL (POST a
// ghl_resultado_url, el disparador «Webhook entrante» de un workflow de 4ttZ) en segundo plano, con reintentos (barrido
// cada 5 min desde workers.js) y reenvío manual desde el panel.
//
// Este módulo NO importa pipeline.js ni Redis: todo acepta el pool de Postgres (y fetch) como dependencias, para
// probarlo con una base en memoria (test/devoluciones.test.mjs).

import { pool as poolReal } from '../db.js';
import { ES_NUEVA, DESDE_SQL } from './club.js';

export const AJUSTES_POR_DEFECTO = Object.freeze({
  plazo_dias: 14,
  max_ia_usd: 5,
  max_brain_tareas: 10,
  brain_uso_url: '',
  ghl_resultado_url: '',
});
export const DECISIONES = Object.freeze(['aprobada', 'denegada', 'revision']);

const ZONA = 'Europe/Madrid';
// Fuentes de llm_usage que se cobran al cliente (services/facturacion.js): una de estas SIN precio = consumo sin medir.
const FUENTES_LEADS = ['reply', 'seguimiento', 'vision', 'audio'];
const TIMEOUT_MS = 8000;
const MAX_RESPUESTA = 100_000; // bytes de la respuesta del Brain que se leen como mucho
export const MAX_INTENTOS_ENVIO = 10;

// ── Ajustes (settings.devoluciones) ─────────────────────────────────────────────────────────
const REGLAS = {
  plazo_dias: { min: 1, max: 365, entero: true, error: 'El plazo tiene que ser un número entero de días entre 1 y 365.' },
  max_ia_usd: { min: 0, max: 1000, entero: false, error: 'El máximo de IA de la cuenta tiene que ser un importe entre 0 y 1000 USD.' },
  max_brain_tareas: { min: 0, max: 100000, entero: true, error: 'El máximo de tareas del Brain tiene que ser un número entero entre 0 y 100000.' },
};
const URLS = [
  ['brain_uso_url', 'La URL de uso del Brain'],
  ['ghl_resultado_url', 'La URL del resultado en GHL'],
];

function aNumero(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim().replace(',', '.'));
  return NaN;
}

function numeroValido(v, regla) {
  const n = aNumero(v);
  if (!Number.isFinite(n) || n < regla.min || n > regla.max) return null;
  if (regla.entero && !Number.isInteger(n)) return null;
  return regla.entero ? n : Math.round(n * 100) / 100;
}

// '' (sin configurar) o una URL https:// sin usuario ni contraseña. El secreto del Club solo viaja por https.
function urlValida(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, valor: '' };
  if (s.length > 2000) return { ok: false };
  let u;
  try { u = new URL(s); } catch { return { ok: false }; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return { ok: false };
  return { ok: true, valor: s };
}

/** Ajustes guardados → siempre válidos (lo que no cuadra vuelve al valor por defecto). */
export function sanearAjustes(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const r = { ...AJUSTES_POR_DEFECTO };
  for (const [k, regla] of Object.entries(REGLAS)) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    const n = numeroValido(o[k], regla);
    if (n !== null) r[k] = n;
  }
  for (const [k] of URLS) {
    const u = urlValida(o[k]);
    if (u.ok) r[k] = u.valor;
  }
  return r;
}

/** Cambio del admin (solo los campos que llegan) sobre los actuales: { ok:true, valor } o { ok:false, error }. */
export function validarAjustes(entrada, actual = AJUSTES_POR_DEFECTO) {
  const b = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const r = sanearAjustes(actual);
  for (const [k, regla] of Object.entries(REGLAS)) {
    if (!(k in b)) continue;
    const n = numeroValido(b[k], regla);
    if (n === null) return { ok: false, error: regla.error };
    r[k] = n;
  }
  for (const [k, nombre] of URLS) {
    if (!(k in b)) continue;
    const u = urlValida(b[k]);
    if (!u.ok) return { ok: false, error: `${nombre} tiene que empezar por https:// (sin usuario ni contraseña) o quedar vacía.` };
    r[k] = u.valor;
  }
  return { ok: true, valor: r };
}

// Si la base falla, lanza: la petición responde 500 y no se guarda nada (nunca se decide con ajustes inventados).
export async function leerAjustes(pg = poolReal) {
  const r = await pg.query(`SELECT value FROM settings WHERE key = 'devoluciones'`);
  return sanearAjustes(r.rows[0]?.value);
}

export async function guardarAjustes(valor, pg = poolReal) {
  const limpio = sanearAjustes(valor);
  await pg.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('devoluciones', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(limpio)]
  );
  return limpio;
}

// ── Cuerpo de la petición ───────────────────────────────────────────────────────────────────
const RE_LOC = /^[A-Za-z0-9_-]{6,64}$/;
const RE_CONTACTO = /^[A-Za-z0-9_-]{4,64}$/;
const RE_EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;
// un merge field de GHL vacío o sin resolver ({{contact.x}}) cuenta como «no viene»
const sinResolver = (s) => !s || /\{\{.*\}\}/.test(s);
const limpiarTexto = (v, n) =>
  String(v ?? '').slice(0, n * 2).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** 'cuenta' | 'brain' | 'ambos' | null (no se entiende). Admite el texto de un desplegable de GHL. */
export function normalizarProducto(v) {
  const s = sinTildes(String(v ?? '').slice(0, 200)).toLowerCase().trim();
  if (!s || sinResolver(s)) return null;
  if (s === 'cuenta' || s === 'brain' || s === 'ambos') return s;
  if (/\bambos\b|\blos dos\b|\blas dos\b/.test(s)) return 'ambos';
  const brain = /\bbrain\b/.test(s);
  const cuenta = /\bcuenta\b|\bclub\b|\bhermes\b/.test(s);
  if (brain && cuenta) return 'ambos';
  if (brain) return 'brain';
  if (cuenta) return 'cuenta';
  return null;
}

/**
 * Valida el cuerpo. Solo rechaza (400) si no hay a quién atribuir la solicitud (ni contact_id ni email válidos):
 * cualquier otro dato que falte o no se entienda acaba en «revision» (así nunca se pierde una solicitud).
 */
export function validarCuerpoDevolucion(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { ok: false, error: 'cuerpo no válido' };
  const contacto = String(b.contact_id ?? '').trim();
  const correo = String(b.email ?? '').trim().toLowerCase();
  const loc = String(b.location_id ?? '').trim();
  // longitudes antes de cualquier expresión regular (un texto enorme no puede costar CPU)
  const contact_id = contacto.length <= 200 && !sinResolver(contacto) && RE_CONTACTO.test(contacto) ? contacto : '';
  const email = correo.length <= 254 && !sinResolver(correo) && RE_EMAIL.test(correo) ? correo : '';
  if (!contact_id && !email) return { ok: false, error: 'falta contact_id o email (válidos)' };
  const location_id = loc.length <= 200 && !sinResolver(loc) && RE_LOC.test(loc) ? loc : '';
  const producto_texto = limpiarTexto(b.producto, 120);
  const fechaBruta = typeof b.fecha_cobro === 'number' ? String(b.fecha_cobro) : limpiarTexto(b.fecha_cobro, 100);
  const avisos = [];
  if (contacto && !sinResolver(contacto) && !contact_id) avisos.push('contact_id no válido: se identifica por el correo');
  if (correo && !sinResolver(correo) && !email) avisos.push('email no válido');
  if (loc && !sinResolver(loc) && !location_id) avisos.push('location_id no válido: se ignora');
  return {
    ok: true,
    datos: {
      contact_id,
      email,
      location_id,
      producto: normalizarProducto(producto_texto),
      producto_texto,
      fecha_texto: sinResolver(fechaBruta) ? '' : fechaBruta,
      motivo: limpiarTexto(b.motivo, 2000),
      avisos,
    },
  };
}

// ── Fechas (zona de Madrid) ─────────────────────────────────────────────────────────────────
function partesEnZona(instante, zona = ZONA) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante);
  return Object.fromEntries(p.filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
}

/** 'YYYY-MM-DD' del día natural de ese instante en Madrid. */
export function diaEnZona(instante, zona = ZONA) {
  const v = partesEnZona(instante, zona);
  return `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`;
}

// Hora de pared en Madrid → instante (dos pasadas: el desfase puede cambiar con el horario de verano).
function instanteEnZona(y, mo, d, hh = 0, mi = 0, ss = 0, zona = ZONA) {
  const pared = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const desfase = (t) => {
    const v = partesEnZona(new Date(t), zona);
    return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(t / 1000) * 1000;
  };
  let t = pared - desfase(pared);
  t = pared - desfase(t);
  return new Date(t);
}

/** Días naturales entre dos 'YYYY-MM-DD' (b − a). */
export function diasEntre(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

function fechaValida(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const horaValida = (hh, mi, ss) => hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59 && ss >= 0 && ss <= 59;

const ILEGIBLE = Object.freeze({ estado: 'ilegible' });
function una(fecha) {
  if (!(fecha instanceof Date) || !Number.isFinite(fecha.getTime())) return ILEGIBLE;
  const y = fecha.getUTCFullYear();
  if (y < 2000 || y > 2100) return ILEGIBLE;
  return { estado: 'ok', candidatos: [fecha] };
}

const MESES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
const NOMBRES_MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'sept',
];
const DIAS_SEMANA = new Set([
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'lun', 'mie', 'jue', 'vie', 'sab', 'dom',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
]);
const RELLENO = new Set(['de', 'del', 'el', 'the', 'of', 'a', 'las', 'los']);

/**
 * Interpreta la fecha del cobro. Sin zona horaria → hora de Madrid.
 * @returns {{ estado: 'falta'|'ilegible' } | { estado: 'ok'|'ambigua', candidatos: Date[] }}
 *   «ambigua»: numérica que vale como día/mes y como mes/día con fechas distintas (decide evaluarPlazo).
 */
export function interpretarFecha(valor) {
  const s = String(valor ?? '').trim().slice(0, 100);
  if (sinResolver(s)) return { estado: 'falta' };
  // 1) marca de tiempo Unix en segundos o milisegundos
  if (/^\d{10}(\.\d+)?$/.test(s)) return una(new Date(Math.round(Number(s) * 1000)));
  if (/^\d{13}$/.test(s)) return una(new Date(Number(s)));
  // 2) ISO: 2026-11-10 · 2026/11/10 · 2026-11-10T09:15[:00[.000]][Z|±hh[:mm]] (también con espacio en vez de T)
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?)?$/i);
  if (m) {
    const [y, mo, d, hh, mi, ss] = [m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0].map(Number);
    if (!fechaValida(y, mo, d) || !horaValida(hh, mi, ss)) return ILEGIBLE;
    if (m[7]) {
      const z = m[7].toUpperCase();
      let desfase = 0;
      if (!['Z', 'UTC', 'GMT'].includes(z)) {
        const o = z.match(/^([+-])(\d{2}):?(\d{2})?$/);
        desfase = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3] || 0));
        if (Math.abs(desfase) > 14 * 60) return ILEGIBLE;
      }
      return una(new Date(Date.UTC(y, mo - 1, d, hh, mi, ss) - desfase * 60_000));
    }
    return una(instanteEnZona(y, mo, d, hh, mi, ss));
  }
  // 3) numérica día/mes/año (la de España). Si también vale como mes/día y es otra fecha → ambigua.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:(?:,\s*|\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [a, b, y, hh, mi, ss] = [m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0].map(Number);
    if (!horaValida(hh, mi, ss)) return ILEGIBLE;
    const candidatos = [];
    if (fechaValida(y, b, a)) candidatos.push(instanteEnZona(y, b, a, hh, mi, ss)); // día/mes
    if (a !== b && fechaValida(y, a, b)) candidatos.push(instanteEnZona(y, a, b, hh, mi, ss)); // mes/día
    if (!candidatos.length) return ILEGIBLE;
    return candidatos.length === 1 ? { estado: 'ok', candidatos } : { estado: 'ambigua', candidatos };
  }
  // 4) con el nombre del mes (español o inglés): «13 nov 2026», «13 de noviembre de 2026», «Nov 13th, 2026 10:30 am»
  let t = sinTildes(s).toLowerCase();
  let hora = [0, 0, 0];
  const mh = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (mh) {
    let hh = Number(mh[1]);
    const mi = Number(mh[2]);
    const ss = Number(mh[3] ?? 0);
    if (mh[4]) {
      if (hh < 1 || hh > 12) return ILEGIBLE;
      hh = (hh % 12) + (mh[4].startsWith('p') ? 12 : 0);
    }
    if (!horaValida(hh, mi, ss)) return ILEGIBLE;
    hora = [hh, mi, ss];
    t = t.replace(mh[0], ' ');
  }
  const tokens = t.replace(/[,./-]/g, ' ').split(/\s+/).filter((x) => x && !RELLENO.has(x) && !DIAS_SEMANA.has(x));
  let dia = null;
  let mes = null;
  let anio = null;
  for (const tk of tokens) {
    if (/^\d{4}$/.test(tk)) { if (anio !== null) return ILEGIBLE; anio = Number(tk); continue; }
    const md = tk.match(/^(\d{1,2})(st|nd|rd|th|º|ª|o)?$/);
    if (md) { if (dia !== null) return ILEGIBLE; dia = Number(md[1]); continue; }
    const k = tk.slice(0, 3);
    if (/^[a-z]{3,}$/.test(tk) && MESES[k] && NOMBRES_MES.some((n) => n.startsWith(tk))) {
      if (mes !== null) return ILEGIBLE;
      mes = MESES[k];
      continue;
    }
    return ILEGIBLE; // una palabra que no es día, mes ni año
  }
  if (dia === null || mes === null || anio === null || !fechaValida(anio, mes, dia)) return ILEGIBLE;
  return una(instanteEnZona(anio, mes, dia, ...hora));
}

// ── Formato de importes (sin depender del idioma instalado en el servidor) ─────────────────
const numCorto = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
// Texto del cliente que se repite en un motivo (va a GHL y puede acabar en un email): sin caracteres de HTML y corto.
const eco = (s, n = 60) => String(s || '').replace(/[<>"'`\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function usdTexto(usd, limite) {
  let s = usd.toFixed(2);
  // 5,0004 USD con límite 5 se deniega: que el motivo no diga «5,00 (límite 5)»
  if (limite !== undefined && usd > limite && Number(s) <= limite) s = usd.toFixed(4);
  return s.replace('.', ',');
}
const recortar = (v, n) => { try { return JSON.stringify(v).slice(0, n); } catch { return ''; } };

/**
 * Plazo: días naturales (Madrid) desde el cobro hasta hoy. Devuelve { decision?, motivo?, fecha, dia, dias, fecha_clave }.
 * Sin decision → dentro del plazo (sigue la medida del producto).
 */
export function evaluarPlazo(fecha, fechaTexto, ajustes, ahora = new Date()) {
  const plazo = ajustes.plazo_dias;
  const bruto = String(fechaTexto || '').slice(0, 100);
  const claveTexto = `texto:${bruto.toLowerCase().replace(/\s+/g, ' ')}`;
  const texto = eco(bruto);
  if (fecha.estado === 'falta') {
    return { decision: 'revision', motivo: 'Falta la fecha del cobro: lo revisa soporte.', fecha_clave: '', medida: { plazo_dias: plazo } };
  }
  if (fecha.estado === 'ilegible') {
    return { decision: 'revision', motivo: `No se entiende la fecha del cobro («${texto}»): lo revisa soporte.`, fecha_clave: claveTexto, medida: { plazo_dias: plazo } };
  }
  const hoy = diaEnZona(ahora);
  const posibles = fecha.candidatos.map((f) => { const dia = diaEnZona(f); return { fecha: f, dia, dias: diasEntre(dia, hoy) }; })
    .filter((c) => c.dias >= 0); // un cobro no puede ser de un día posterior a hoy
  if (!posibles.length) {
    return { decision: 'revision', motivo: `La fecha del cobro («${texto}») es posterior a hoy: lo revisa soporte.`, fecha_clave: claveTexto, medida: { plazo_dias: plazo } };
  }
  const dentro = posibles.filter((c) => c.dias <= plazo);
  if (dentro.length && dentro.length < posibles.length) {
    // «05/11/2026»: el 5 de noviembre entra en plazo y el 11 de mayo no → no se adivina
    return {
      decision: 'revision',
      motivo: `La fecha del cobro «${texto}» se puede leer como día/mes o como mes/día: lo revisa soporte.`,
      fecha_clave: claveTexto,
      medida: { plazo_dias: plazo, lecturas: posibles.map((c) => c.dia) },
    };
  }
  if (!dentro.length) {
    const c = posibles.reduce((x, y) => (y.dias < x.dias ? y : x)); // la lectura más favorable al cliente
    return {
      decision: 'denegada',
      motivo: `Han pasado ${c.dias} días desde el cobro (plazo: ${plazo} días)`,
      fecha: c.fecha, dia: c.dia, dias: c.dias, fecha_clave: c.dia,
      medida: { plazo_dias: plazo, dias: c.dias, fecha_cobro: c.dia },
    };
  }
  // dentro del plazo con todas las lecturas: se mide desde la MÁS ANTIGUA (ventana más larga = más consumo contado)
  const c = dentro.reduce((x, y) => (y.fecha < x.fecha ? y : x));
  return { fecha: c.fecha, dia: c.dia, dias: c.dias, fecha_clave: c.dia, medida: { plazo_dias: plazo, dias: c.dias, fecha_cobro: c.dia } };
}

// ── Cuenta: conexión de Hermes y consumo de IA ──────────────────────────────────────────────
const MOTIVOS_CONEXION = {
  no_encontrada: 'No se encuentra su cuenta de Hermes (ni por la subcuenta ni por el correo del responsable): lo revisa soporte.',
  protegida: 'La subcuenta indicada no es una cuenta del Club (su conexión de Hermes es anterior al Club): lo revisa soporte.',
  no_casa: 'El correo de la solicitud no es de ningún usuario conocido de esa subcuenta: lo revisa soporte.',
  ambiguo: 'Ese correo aparece en varias cuentas de Hermes: lo revisa soporte.',
  sin_corte: 'No se puede identificar la cuenta por correo (falta el corte del Club): lo revisa soporte.',
};

/**
 * Conexión(es) de Hermes de quien pide la devolución (como /api/club/estado):
 *  1) por location_id → sus conexiones, que tienen que ser NUEVAS (posteriores al Club); si además llega el correo y la
 *     conexión ya tiene responsable, el correo tiene que ser de alguien de esa subcuenta (responsable, correo
 *     autorizado o usuario que entró por SSO) — si no, algo no cuadra (¿subcuenta equivocada?) → revisión;
 *  2) si no, por correo → la ÚNICA conexión nueva cuyo RESPONSABLE (owner_email, lo certifica el SSO de GHL) es ese
 *     correo, y siempre que ese correo no haya entrado por SSO en OTRA conexión nueva (si no, no se sabe cuál es).
 */
export async function resolverConexion({ location_id, email }, pg = poolReal) {
  const correo = String(email || '');
  if (location_id) {
    const filas = (await pg.query(
      `SELECT a.id,
              lower(COALESCE(a.owner_email, '')) AS responsable,
              COALESCE(a.created_at >= ${DESDE_SQL}, false) AS nueva,
              CASE WHEN jsonb_typeof(a.authorized_emails) = 'array'
                   THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.authorized_emails) e WHERE lower(e) = $2)
                   ELSE false END AS autorizado,
              EXISTS (SELECT 1 FROM portal_users p WHERE p.account_id = a.id AND lower(p.email) = $2) AS entro
         FROM accounts a WHERE a.location_id = $1 ORDER BY a.id`,
      [location_id, correo]
    )).rows;
    if (filas.length) {
      const cuentas = filas.map((f) => f.id);
      if (filas.some((f) => !f.nueva)) return { estado: 'protegida', via: 'subcuenta', cuentas };
      if (correo && filas.some((f) => f.responsable && f.responsable !== correo && !f.autorizado && !f.entro)) {
        return { estado: 'no_casa', via: 'subcuenta', cuentas };
      }
      return { estado: 'ok', via: 'subcuenta', cuentas };
    }
  }
  if (correo) {
    const corte = (await pg.query(`SELECT ${DESDE_SQL} AS desde`)).rows[0]?.desde;
    if (!corte) return { estado: 'sin_corte', via: 'correo', cuentas: [] };
    const cands = (await pg.query(
      `SELECT id FROM accounts WHERE ${ES_NUEVA} AND lower(owner_email) = $1 ORDER BY id`, [correo]
    )).rows.map((r) => r.id);
    if (cands.length > 1) return { estado: 'ambiguo', via: 'correo', cuentas: cands };
    if (cands.length === 1) {
      const otras = (await pg.query(
        `SELECT DISTINCT a.id FROM accounts a JOIN portal_users p ON p.account_id = a.id
          WHERE lower(p.email) = $1 AND a.id <> $2 AND COALESCE(a.created_at >= ${DESDE_SQL}, false)
          ORDER BY a.id`,
        [correo, cands[0]]
      )).rows.map((r) => r.id);
      if (otras.length) return { estado: 'ambiguo', via: 'correo', cuentas: [cands[0], ...otras] };
      return { estado: 'ok', via: 'correo', cuentas: cands };
    }
  }
  return { estado: 'no_encontrada', via: location_id ? 'subcuenta' : 'correo', cuentas: [] };
}

// Fuentes que se cobran: las de siempre + las que el admin haya añadido en Marketplace → Facturación.
async function fuentesCobradas(pg) {
  const r = await pg.query(`SELECT value FROM settings WHERE key = 'facturacion'`).catch(() => ({ rows: [] }));
  const f = r.rows?.[0]?.value?.fuentes;
  const extra = Array.isArray(f) ? f.filter((x) => typeof x === 'string' && x.length <= 40) : [];
  return [...new Set([...FUENTES_LEADS, ...extra])];
}

/** Consumo de IA (precio al cliente, USD) de esas conexiones desde `desde`. Lanza si el dato no es un número. */
export async function consumoIa(cuentas, desde, pg = poolReal) {
  const fuentes = await fuentesCobradas(pg);
  const r = (await pg.query(
    `SELECT COALESCE(SUM(billed_usd) FILTER (WHERE billed_usd > 0), 0)::text AS usd,
            (count(*) FILTER (WHERE billed_usd IS NULL AND source = ANY($3::text[])))::int AS sin_precio,
            (count(*) FILTER (WHERE billed_usd > 0))::int AS llamadas
       FROM llm_usage
      WHERE account_id = ANY($1::int[]) AND created_at >= $2::timestamptz`,
    [cuentas, desde.toISOString(), fuentes]
  )).rows[0];
  const usd = Number(r?.usd);
  const sinPrecio = Number(r?.sin_precio);
  // un resultado raro NUNCA cuenta como 0 USD ni como «todo con precio» (aprobaría): se lanza y pasa a revisión
  if (!r || !Number.isFinite(usd) || usd < 0) throw new Error(`consumo de IA no numérico (${r?.usd})`);
  if (!Number.isInteger(sinPrecio) || sinPrecio < 0) throw new Error(`recuento sin precio no válido (${r?.sin_precio})`);
  return { usd, sin_precio: sinPrecio, llamadas: Number(r.llamadas) || 0 };
}

async function evaluarCuenta(datos, plazo, ajustes, pg) {
  const limite = ajustes.max_ia_usd;
  const con = await resolverConexion(datos, pg);
  const base = { ...plazo.medida, limite_usd: limite, via: con.via, cuentas: con.cuentas };
  if (con.estado !== 'ok') return { decision: 'revision', motivo: MOTIVOS_CONEXION[con.estado] || MOTIVOS_CONEXION.no_encontrada, medida: base };
  const c = await consumoIa(con.cuentas, plazo.fecha, pg);
  const medida = { ...base, consumo_usd: Math.round(c.usd * 10000) / 10000, llamadas: c.llamadas, sin_precio: c.sin_precio, desde: plazo.fecha.toISOString() };
  // más del límite → denegada aunque haya llamadas sin precio (solo podrían sumar más)
  if (c.usd > limite) return { decision: 'denegada', motivo: `Has usado ${usdTexto(c.usd, limite)} USD de IA (límite ${numCorto(limite)})`, medida };
  if (c.sin_precio > 0) {
    return { decision: 'revision', motivo: `Hay ${c.sin_precio} llamada(s) de IA sin precio conocido: no se puede medir el consumo; lo revisa soporte.`, medida };
  }
  return {
    decision: 'aprobada',
    motivo: `Has usado ${usdTexto(c.usd)} USD de IA (límite ${numCorto(limite)}) y lo pides a los ${plazo.dias} días del cobro (plazo: ${ajustes.plazo_dias} días)`,
    medida,
  };
}

// ── Brain: tareas hechas desde el cobro (lo cuenta el propio Brain) ────────────────────────
/**
 * GET brain_uso_url?email=&desde=<ISO> con la cabecera X-Club-Secret. Respuesta esperada (200, JSON):
 *   { "tareas": <entero ≥ 0> }   — también se acepta "tasks".
 *   { "medible": false } / { "encontrado": false } / { "ok": false } → no se puede medir (revisión).
 * Cualquier otra cosa (HTTP ≠ 2xx, redirección, tiempo agotado, JSON raro, número no entero) → no medible.
 */
export async function medirBrain({ email, desde, url, secreto, fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const fallo = (motivo, medida = {}) => ({ estado: 'no_medible', motivo, medida });
  let destino;
  try { destino = new URL(url); } catch { return fallo('La URL de uso del Brain no es válida: lo revisa soporte.'); }
  if (destino.protocol !== 'https:') return fallo('La URL de uso del Brain no es https: lo revisa soporte.');
  destino.searchParams.set('email', email);
  destino.searchParams.set('desde', desde.toISOString());
  let res;
  try {
    res = await fetchFn(destino.toString(), {
      method: 'GET',
      headers: { 'x-club-secret': secreto, accept: 'application/json' },
      redirect: 'error', // el secreto no sigue redirecciones a otro sitio
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fallo('El Brain no ha respondido: lo revisa soporte.', { brain_error: String(err?.name || err?.message || err).slice(0, 120) });
  }
  const http = Number(res?.status) || 0;
  if (http < 200 || http >= 300) return fallo(`El Brain respondió con un error (HTTP ${http}): lo revisa soporte.`, { brain_http: http });
  let texto = '';
  try { texto = String(await res.text()); } catch { return fallo('No se pudo leer la respuesta del Brain: lo revisa soporte.', { brain_http: http }); }
  if (texto.length > MAX_RESPUESTA) return fallo('La respuesta del Brain es demasiado grande: lo revisa soporte.', { brain_http: http });
  let j;
  try { j = JSON.parse(texto); } catch { return fallo('La respuesta del Brain no es JSON: lo revisa soporte.', { brain_http: http }); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return fallo('La respuesta del Brain no es válida: lo revisa soporte.', { brain_http: http });
  const resumen = recortar(j, 300);
  if (j.ok === false || j.medible === false || j.encontrado === false || j.found === false) {
    return fallo('El Brain no puede medir el uso de ese correo: lo revisa soporte.', { brain_respuesta: resumen });
  }
  const bruto = j.tareas !== undefined ? j.tareas : j.tasks;
  const n = typeof bruto === 'number' ? bruto : typeof bruto === 'string' && /^\s*\d{1,9}\s*$/.test(bruto) ? Number(bruto) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) return fallo('El Brain no ha dado un número de tareas válido: lo revisa soporte.', { brain_respuesta: resumen });
  return { estado: 'ok', tareas: n, medida: { tareas: n } };
}

async function evaluarBrain(datos, plazo, ajustes, { fetchFn, secreto }) {
  const limite = ajustes.max_brain_tareas;
  const base = { ...plazo.medida, limite_tareas: limite, desde: plazo.fecha.toISOString() };
  const revision = (motivo, medida = base) => ({ decision: 'revision', motivo, medida });
  if (!datos.email) return revision('Falta el correo para medir el uso del Brain: lo revisa soporte.');
  if (!ajustes.brain_uso_url) return revision('La medición del uso del Brain no está configurada: lo revisa soporte.');
  if (!secreto) return revision('Falta el secreto del Club para preguntar al Brain: lo revisa soporte.');
  const m = await medirBrain({ email: datos.email, desde: plazo.fecha, url: ajustes.brain_uso_url, secreto, fetchFn });
  const medida = { ...base, ...m.medida };
  if (m.estado !== 'ok') return revision(m.motivo, medida);
  if (m.tareas > limite) return { decision: 'denegada', motivo: `Has hecho ${m.tareas} tareas con el Brain (límite ${limite})`, medida };
  return {
    decision: 'aprobada',
    motivo: `Has hecho ${m.tareas} tareas con el Brain (límite ${limite}) y lo pides a los ${plazo.dias} días del cobro (plazo: ${ajustes.plazo_dias} días)`,
    medida,
  };
}

async function evaluarProducto(producto, datos, plazo, ajustes, deps) {
  if (producto === 'desconocido') {
    return {
      decision: 'revision',
      motivo: eco(datos.producto_texto)
        ? `No se entiende qué quiere devolver («${eco(datos.producto_texto)}»): lo revisa soporte.`
        : 'Falta qué quiere devolver (cuenta, Brain o ambos): lo revisa soporte.',
      medida: {},
    };
  }
  if (plazo.decision) return { decision: plazo.decision, motivo: plazo.motivo, medida: plazo.medida };
  if (producto === 'cuenta') return evaluarCuenta(datos, plazo, ajustes, deps.pg);
  return evaluarBrain(datos, plazo, ajustes, deps);
}

// Registro de eventos del panel (Configuración → Registro de eventos). Best effort, fuera de transacciones.
async function eventoLog(pg, kind, payload) {
  await pg.query(`INSERT INTO webhook_log (kind, payload) VALUES ($1, $2::jsonb)`, [kind, JSON.stringify(payload)]).catch(() => {});
}

// ── Evaluación completa ─────────────────────────────────────────────────────────────────────
/**
 * Evalúa (o devuelve la decisión ya guardada de) una solicitud de devolución ya validada.
 * @returns {{ code: number, body: object, envios: Promise }}  envios = el aviso a GHL en segundo plano (no lanza).
 */
export async function procesarDevolucion(datos, deps = {}) {
  const pg = deps.pg || poolReal;
  const fetchFn = deps.fetch || globalThis.fetch;
  const ahora = deps.ahora || new Date();
  const secreto = String(deps.secreto || '');
  const ip = deps.ip ? String(deps.ip).slice(0, 64) : null;

  const ajustes = await leerAjustes(pg);
  const productos = datos.producto === 'ambos' ? ['cuenta', 'brain'] : datos.producto ? [datos.producto] : ['desconocido'];
  const clave = datos.contact_id || `email:${datos.email}`;
  const plazo = evaluarPlazo(interpretarFecha(datos.fecha_texto), datos.fecha_texto, ajustes, ahora);
  const fechaClave = plazo.fecha_clave;

  const existentes = new Map(
    (await pg.query(
      `SELECT * FROM club_devoluciones WHERE clave = $1 AND fecha_clave = $2 AND producto = ANY($3::text[])`,
      [clave, fechaClave, productos]
    )).rows.map((f) => [f.producto, f])
  );

  const filas = [];
  const nuevas = [];
  for (const producto of productos) {
    if (existentes.has(producto)) { filas.push({ fila: existentes.get(producto), repetida: true }); continue; }
    let ev;
    try {
      ev = await evaluarProducto(producto, datos, plazo, ajustes, { pg, fetchFn, secreto });
    } catch (err) {
      ev = { decision: 'revision', motivo: 'No se ha podido evaluar automáticamente: lo revisa soporte.', medida: { ...plazo.medida, error: String(err?.message || err).slice(0, 200) } };
    }
    if (!DECISIONES.includes(ev.decision)) ev = { decision: 'revision', motivo: 'Decisión no válida: lo revisa soporte.', medida: ev.medida || {} };
    const medida = { ...(ev.medida || {}), ...(datos.avisos?.length ? { avisos: datos.avisos } : {}) };
    const ins = await pg.query(
      `INSERT INTO club_devoluciones
         (clave, producto, fecha_clave, contact_id, email, location_id, fecha_texto, fecha_cobro, fecha_dia, motivo_cliente,
          producto_texto, decision, motivo, medida, ajustes, ghl_estado, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17)
       ON CONFLICT (clave, producto, fecha_clave) DO NOTHING
       RETURNING *`,
      [
        clave, producto, fechaClave, datos.contact_id, datos.email, datos.location_id, datos.fecha_texto,
        plazo.fecha ? plazo.fecha.toISOString() : null, plazo.dia || '', datos.motivo, datos.producto_texto,
        ev.decision, String(ev.motivo || '').slice(0, 500), JSON.stringify(medida),
        JSON.stringify({ plazo_dias: ajustes.plazo_dias, max_ia_usd: ajustes.max_ia_usd, max_brain_tareas: ajustes.max_brain_tareas }),
        ajustes.ghl_resultado_url ? 'pendiente' : 'sin_url', ip,
      ]
    );
    if (ins.rows[0]) {
      filas.push({ fila: ins.rows[0], repetida: false });
      nuevas.push(ins.rows[0].id);
    } else {
      // otra petición idéntica la guardó a la vez: manda la suya (y es ella quien avisa a GHL)
      const otra = (await pg.query(
        `SELECT * FROM club_devoluciones WHERE clave = $1 AND producto = $2 AND fecha_clave = $3`, [clave, producto, fechaClave]
      )).rows[0];
      if (otra) filas.push({ fila: otra, repetida: true });
    }
  }

  // repetidas: se cuentan y, si su aviso a GHL no llegó, se reintenta
  const reintentar = [];
  for (const { fila, repetida } of filas) {
    if (!repetida) continue;
    await pg.query(`UPDATE club_devoluciones SET repeticiones = repeticiones + 1, updated_at = now() WHERE id = $1`, [fila.id]);
    if (fila.ghl_estado === 'pendiente' || fila.ghl_estado === 'error') reintentar.push(fila.id);
  }

  await eventoLog(pg, 'club_devolucion', {
    clave, email: datos.email, location_id: datos.location_id || null, fecha: fechaClave,
    solicitudes: filas.map(({ fila, repetida }) => ({ id: fila.id, producto: fila.producto, decision: fila.decision, repetida })),
  });

  const ids = [...nuevas, ...reintentar];
  const envios = ajustes.ghl_resultado_url && ids.length
    ? enviarVarios(ids, { pg, fetchFn, ajustes }).catch(() => {})
    : Promise.resolve();

  const decision = {};
  const motivos = {};
  const plano = {};
  for (const { fila } of filas) {
    decision[fila.producto] = fila.decision;
    motivos[fila.producto] = fila.motivo;
    plano[`decision_${fila.producto}`] = fila.decision;
    plano[`motivo_${fila.producto}`] = fila.motivo;
  }
  return {
    code: 200,
    body: {
      ok: true,
      decision,
      motivos,
      ...plano, // decision_cuenta, motivo_cuenta, decision_brain… (fáciles de mapear en GHL)
      repetida: filas.length > 0 && filas.every((f) => f.repetida),
      solicitudes: filas.map(({ fila, repetida }) => ({
        id: fila.id, producto: fila.producto, decision: fila.decision, motivo: fila.motivo, repetida,
        envio_ghl: !ajustes.ghl_resultado_url && fila.ghl_estado !== 'enviado' ? 'sin_url' : ids.includes(fila.id) ? 'en_curso' : fila.ghl_estado,
      })),
    },
    envios,
  };
}

// ── Aviso del resultado a GHL ───────────────────────────────────────────────────────────────
/** Lo que recibe el workflow de GHL (disparador «Webhook entrante»). */
export function cuerpoParaGhl(fila) {
  const m = fila.medida && typeof fila.medida === 'object' ? fila.medida : {};
  return {
    email: fila.email || '',
    contact_id: fila.contact_id || '',
    producto: fila.producto,
    decision: fila.decision,
    motivo: fila.motivo || '',
    solicitud_id: fila.id,
    fecha_cobro: fila.fecha_dia || '',
    dias_desde_cobro: Number.isFinite(m.dias) ? m.dias : null,
    consumo_ia_usd: Number.isFinite(m.consumo_usd) ? m.consumo_usd : null,
    tareas_brain: Number.isFinite(m.tareas) ? m.tareas : null,
    location_id: fila.location_id || '',
  };
}

/**
 * Manda a GHL el resultado de UNA solicitud. Solo envía quien la RECLAMA (UPDATE atómico): el envío en segundo plano,
 * el barrido y el reenvío manual nunca mandan la misma a la vez.
 * forzar (reenvío manual del admin) → también las «sin_url» y las ya enviadas.
 * @returns {{ estado: 'enviado'|'error'|'sin_url'|'ocupado', http?: number, error?: string }}
 */
export async function enviarAGhl(id, { pg = poolReal, fetchFn = globalThis.fetch, ajustes = null, forzar = false } = {}) {
  const aj = ajustes || await leerAjustes(pg);
  if (!aj.ghl_resultado_url) return { estado: 'sin_url' };
  const estados = forzar ? ['pendiente', 'error', 'sin_url', 'enviado'] : ['pendiente', 'error'];
  const fila = (await pg.query(
    `UPDATE club_devoluciones
        SET ghl_estado = 'enviando', ghl_intentos = ghl_intentos + 1, ghl_ultimo_intento_at = now(), updated_at = now()
      WHERE id = $1 AND ghl_estado = ANY($2::text[])
      RETURNING *`,
    [id, estados]
  )).rows[0];
  if (!fila) return { estado: 'ocupado' };
  let ok = false;
  let http = null;
  let error = null;
  try {
    const res = await fetchFn(aj.ghl_resultado_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpoParaGhl(fila)),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    http = Number(res?.status) || 0;
    ok = http >= 200 && http < 300;
    if (!ok) error = `HTTP ${http}`;
    try { await res.text(); } catch { /* el cuerpo no importa */ }
  } catch (err) {
    error = err?.name === 'TimeoutError' ? 'GHL no respondió a tiempo' : String(err?.message || err).slice(0, 200);
  }
  await pg.query(
    `UPDATE club_devoluciones
        SET ghl_estado = $2::text, ghl_http = $3, ghl_error = $4,
            ghl_enviado_at = CASE WHEN $2::text = 'enviado' THEN now() ELSE ghl_enviado_at END, updated_at = now()
      WHERE id = $1`,
    [id, ok ? 'enviado' : 'error', http, ok ? null : error]
  );
  if (!ok) await eventoLog(pg, 'club_devolucion_envio_error', { id, http, error, intento: fila.ghl_intentos });
  return ok ? { estado: 'enviado', http } : { estado: 'error', http, error };
}

async function enviarVarios(ids, deps) {
  const resultados = [];
  for (const id of ids) resultados.push(await enviarAGhl(id, deps).catch((err) => ({ estado: 'error', error: String(err?.message || err) })));
  return resultados;
}

/**
 * Barrido (workers.js, cada 5 min): reintenta los avisos que fallaron o quedaron a medias, con espera creciente
 * (5, 10, 20… min, hasta 6 h), como mucho MAX_INTENTOS_ENVIO veces y solo las solicitudes de los últimos 3 días.
 */
export async function reintentarEnvios({ pg = poolReal, fetchFn = globalThis.fetch, limite = 20 } = {}) {
  const aj = await leerAjustes(pg);
  if (!aj.ghl_resultado_url) return { revisadas: 0, enviadas: 0 };
  // envío interrumpido (el proceso cayó a mitad): pasa a error y entra en el reintento
  await pg.query(
    `UPDATE club_devoluciones SET ghl_estado = 'error', ghl_error = COALESCE(ghl_error, 'envío interrumpido'), updated_at = now()
      WHERE ghl_estado = 'enviando' AND ghl_ultimo_intento_at < now() - interval '10 minutes'`
  );
  const ids = (await pg.query(
    `SELECT id FROM club_devoluciones
      WHERE ghl_estado IN ('pendiente', 'error') AND ghl_intentos < $1 AND created_at > now() - interval '3 days'
        AND (ghl_ultimo_intento_at IS NULL
             OR ghl_ultimo_intento_at < now() - make_interval(mins => LEAST(5 * (power(2, GREATEST(ghl_intentos - 1, 0)))::int, 360)))
      ORDER BY id LIMIT $2`,
    [MAX_INTENTOS_ENVIO, limite]
  )).rows.map((r) => r.id);
  let enviadas = 0;
  for (const id of ids) {
    const r = await enviarAGhl(id, { pg, fetchFn, ajustes: aj }).catch(() => ({ estado: 'error' }));
    if (r.estado === 'enviado') enviadas++;
  }
  return { revisadas: ids.length, enviadas };
}

// ── Panel ───────────────────────────────────────────────────────────────────────────────────
export async function listarSolicitudes({ decision = null, limit = 100 } = {}, pg = poolReal) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const filtro = DECISIONES.includes(decision) ? decision : null;
  const filas = (await pg.query(
    `SELECT id, created_at, updated_at, producto, decision, motivo, contact_id, email, location_id, fecha_texto, fecha_dia,
            motivo_cliente, producto_texto, medida, ajustes, ghl_estado, ghl_intentos, ghl_enviado_at, ghl_http, ghl_error, repeticiones
       FROM club_devoluciones WHERE ($1::text IS NULL OR decision = $1::text) ORDER BY id DESC LIMIT $2`,
    [filtro, lim]
  )).rows;
  const totales = Object.fromEntries((await pg.query(
    `SELECT decision, count(*)::int AS n FROM club_devoluciones GROUP BY decision`
  )).rows.map((r) => [r.decision, r.n]));
  return { solicitudes: filas, totales };
}
