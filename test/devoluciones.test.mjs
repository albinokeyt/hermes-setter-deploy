// Evaluador de DEVOLUCIONES del Club (services/devoluciones.js + POST /api/club/devolucion) sobre Postgres real en
// memoria (PGlite) con las migraciones de verdad. Lo que importa: NUNCA aprobar por un fallo, idempotencia y que el
// resultado llegue a GHL una sola vez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { baseDePruebas } from './_pglite.mjs';
import {
  interpretarFecha, evaluarPlazo, normalizarProducto, validarCuerpoDevolucion, sanearAjustes, validarAjustes,
  procesarDevolucion, enviarAGhl, reintentarEnvios, medirBrain, cuerpoParaGhl, diaEnZona, resolverConexion,
  AJUSTES_POR_DEFECTO, listarSolicitudes,
} from '../src/services/devoluciones.js';
import clubRoutes from '../src/routes/club.js';

const SECRETO = 's'.repeat(64);
const AHORA = new Date('2026-11-13T12:00:00Z'); // viernes 13-nov-2026, 13:00 en Madrid
const BRAIN = 'https://brain.test/api/club/uso';
const GHL = 'https://services.leadconnectorhq.com/hooks/LOC/webhook-trigger/abc';
const dirMig = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');

// Base con una conexión ANTIGUA (anterior al Club, p. ej. 4ttZ) y el corte del Club hace un día.
async function base({ brain = BRAIN, ghl = GHL } = {}) {
  const pg = await baseDePruebas({ antesDe: '059' });
  await pg.exec(`
    INSERT INTO accounts (id, name, location_id, webhook_token, owner_email, created_at)
    VALUES (1, 'Agencia', 'locAgencia01', 'tk1', 'jonathan@x.com', now() - interval '60 days');
    SELECT setval('accounts_id_seq', 100);
  `);
  for (const f of fs.readdirSync(dirMig).filter((x) => x.endsWith('.sql') && x >= '059').sort()) {
    await pg.exec(fs.readFileSync(path.join(dirMig, f), 'utf8'));
  }
  await pg.query(`UPDATE settings SET value = jsonb_build_object('desde', now() - interval '1 day') WHERE key = 'club_desde'`);
  await pg.query(`UPDATE settings SET value = value || $1::jsonb WHERE key = 'devoluciones'`, [JSON.stringify({ brain_uso_url: brain, ghl_resultado_url: ghl })]);
  return pg;
}

// conexión NUEVA (del Club)
async function nueva(pg, { id, loc, owner = '' }) {
  await pg.query(`INSERT INTO accounts (id, name, location_id, webhook_token, owner_email) VALUES ($1, $2, $3, $4, $5)`, [id, `C${id}`, loc, `tk${id}`, owner]);
}
async function uso(pg, accountId, billed, cuando, source = 'reply') {
  await pg.query(
    `INSERT INTO llm_usage (account_id, model, prompt_tokens, completion_tokens, cost_usd, billed_usd, source, created_at)
     VALUES ($1, 'm', 1, 1, $2, $3, $4, $5::timestamptz)`,
    [accountId, billed === null ? null : billed / 2, billed, source, cuando]
  );
}

// fetch falso: brain(url) y ghl(body) deciden la respuesta; guarda todas las llamadas
function fetchFalso({ brain = () => ({ body: { tareas: 3 } }), ghl = () => ({ status: 200, body: { status: 'Success' } }) } = {}) {
  const llamadas = [];
  const fn = async (url, init = {}) => {
    llamadas.push({ url: String(url), init });
    const r = String(url).startsWith(BRAIN) ? brain(String(url), init) : ghl(JSON.parse(init.body || '{}'), init);
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})) };
  };
  fn.llamadas = llamadas;
  fn.aGhl = () => llamadas.filter((l) => l.url === GHL).map((l) => JSON.parse(l.init.body));
  fn.aBrain = () => llamadas.filter((l) => l.url.startsWith(BRAIN));
  return fn;
}

const datos = (extra = {}) => validarCuerpoDevolucion({ email: 'cliente@x.com', contact_id: 'cont0001', producto: 'cuenta', motivo: 'no me convence', fecha_cobro: '2026-11-10', location_id: 'locClub0001', ...extra }).datos;
async function evaluar(pg, f, extra = {}, deps = {}) {
  const r = await procesarDevolucion(datos(extra), { pg, fetch: f, ahora: AHORA, secreto: SECRETO, ...deps });
  await r.envios;
  return r;
}

// ── Fechas ──────────────────────────────────────────────────────────────────────────────────
test('fecha del cobro: formatos que se entienden', () => {
  const dia = (s) => { const r = interpretarFecha(s); assert.equal(r.estado, 'ok', s); return diaEnZona(r.candidatos[0]); };
  assert.equal(dia('2026-11-10'), '2026-11-10');
  assert.equal(dia('2026/11/10'), '2026-11-10');
  assert.equal(interpretarFecha('2026-11-10').candidatos[0].toISOString(), '2026-11-09T23:00:00.000Z', 'sin zona = medianoche de Madrid');
  assert.equal(interpretarFecha('2026-11-10T09:15:00Z').candidatos[0].toISOString(), '2026-11-10T09:15:00.000Z');
  assert.equal(interpretarFecha('2026-11-10T09:15:00.123+01:00').candidatos[0].toISOString(), '2026-11-10T08:15:00.000Z');
  assert.equal(interpretarFecha('2026-11-10 23:30 +0000').candidatos[0].toISOString(), '2026-11-10T23:30:00.000Z');
  assert.equal(dia('2026-11-10T23:30:00Z'), '2026-11-11', 'en Madrid ya es el día 11');
  assert.equal(dia('13/11/2026'), '2026-11-13');
  assert.equal(dia('13-11-2026 10:00'), '2026-11-13');
  assert.equal(dia('11/13/2026'), '2026-11-13', 'solo vale como mes/día');
  assert.equal(dia('07/07/2026'), '2026-07-07');
  assert.equal(dia('13 nov 2026'), '2026-11-13');
  assert.equal(dia('13 de noviembre de 2026'), '2026-11-13');
  assert.equal(dia('Nov 13th, 2026'), '2026-11-13');
  assert.equal(dia('November 13 2026 10:30 pm'), '2026-11-13');
  assert.equal(dia('viernes, 13 de noviembre de 2026'), '2026-11-13');
  assert.equal(dia('1º de septiembre de 2026'), '2026-09-01');
  assert.equal(dia('1773100800'), '2026-03-10', 'marca Unix en segundos');
  assert.equal(dia('1773100800000'), '2026-03-10', 'en milisegundos');
  assert.equal(dia('2026-03-29T01:30:00'), '2026-03-29', 'cambio de hora');
});

test('fecha del cobro: falta, ilegible o ambigua', () => {
  assert.equal(interpretarFecha('').estado, 'falta');
  assert.equal(interpretarFecha(undefined).estado, 'falta');
  assert.equal(interpretarFecha('{{contact.fecha_cobro}}').estado, 'falta');
  for (const s of ['ayer', '31/02/2026', '2026-13-01', '10/11/26', '13 nov', 'nov 2026', '25:00 13/11/2026', '2026-11-10T25:00', 'martes 2026', '13 nov 2026 nov', '2026-11-10T10:00+15:00', '1999-01-01']) {
    assert.equal(interpretarFecha(s).estado, 'ilegible', s);
  }
  const a = interpretarFecha('05/11/2026');
  assert.equal(a.estado, 'ambigua');
  assert.deepEqual(a.candidatos.map((d) => diaEnZona(d)), ['2026-11-05', '2026-05-11']);
});

test('plazo: días naturales en Madrid, límite incluido, futura y ambigua', () => {
  const aj = { ...AJUSTES_POR_DEFECTO };
  const p = (s) => evaluarPlazo(interpretarFecha(s), s, aj, AHORA);
  assert.equal(p('2026-11-13').dias, 0);
  assert.equal(p('2026-10-30').dias, 14);
  assert.equal(p('2026-10-30').decision, undefined, 'el día 14 aún entra');
  assert.equal(p('2026-10-29').decision, 'denegada');
  assert.match(p('2026-10-29').motivo, /Han pasado 15 días desde el cobro \(plazo: 14 días\)/);
  assert.equal(p('2026-11-14').decision, 'revision', 'cobro posterior a hoy');
  assert.equal(p('').decision, 'revision');
  assert.equal(p('').fecha_clave, '');
  assert.equal(p('ayer').decision, 'revision');
  assert.equal(p('ayer').fecha_clave, 'texto:ayer');
  // 05/11: el 5 de noviembre entra en plazo y el 11 de mayo no → no se adivina
  assert.equal(p('05/11/2026').decision, 'revision');
  // 12/11: el 11 de diciembre es futuro → solo queda el 12 de noviembre
  assert.equal(p('12/11/2026').decision, undefined);
  assert.equal(p('12/11/2026').dia, '2026-11-12');
  // 03/04/2026: las dos lecturas están fuera de plazo → denegada con la lectura más favorable
  assert.equal(p('03/04/2026').decision, 'denegada');
  assert.equal(p('03/04/2026').dias, 224);
  // con el plazo cambiado
  assert.equal(evaluarPlazo(interpretarFecha('2026-11-05'), '2026-11-05', { ...aj, plazo_dias: 7 }, AHORA).decision, 'denegada');
});

test('producto: canónicos, texto de un desplegable y lo que no se entiende', () => {
  assert.equal(normalizarProducto('cuenta'), 'cuenta');
  assert.equal(normalizarProducto(' Brain '), 'brain');
  assert.equal(normalizarProducto('AMBOS'), 'ambos');
  assert.equal(normalizarProducto('Cuenta (Club de Sistemas)'), 'cuenta');
  assert.equal(normalizarProducto('Disruptive Brain'), 'brain');
  assert.equal(normalizarProducto('Cuenta, Brain'), null, 'ya no se adivina: no es una opción del formulario');
  assert.equal(normalizarProducto('Los dos'), 'ambos');
  assert.equal(normalizarProducto(''), null);
  assert.equal(normalizarProducto('{{contact.producto}}'), null);
  assert.equal(normalizarProducto('el curso'), null);
});

// Fase C · [formulario] el verificador vio que «Solo el Brain, no la cuenta» se leía como «ambos» y podía aprobar una
// devolución de la cuenta que nadie pidió. Ahora solo valen los canónicos y las opciones EXACTAS del desplegable.
test('producto ESTRICTO: solo cuenta|brain|ambos y las opciones del desplegable real; cualquier otro texto → desconocido (revisión)', async () => {
  const valen = {
    cuenta: 'cuenta', ' Brain ': 'brain', AMBOS: 'ambos',
    // opciones del campo iYMss3x5ZpMxQKBI5tYB («Club DD · Devolución · Qué devolver») del formulario 1Y7ZLul66R5Mk8hEx7y9
    'Cuenta del Club': 'cuenta', 'Disruptive Brain': 'brain', 'Las dos': 'ambos',
    // las de la fase B que también se aceptan
    'Cuenta (Club de Sistemas)': 'cuenta', 'Los dos': 'ambos',
    // sin distinguir mayúsculas ni tildes y quitando espacios
    'CUENTA DEL CLUB': 'cuenta', 'cuénta  del   club': 'cuenta', ' disruptive brain ': 'brain', 'LAS DOS': 'ambos', 'lás dos': 'ambos',
    'Cuenta(Club de Sistemas)': 'cuenta', 'Disruptive Brain': 'brain',
  };
  for (const [texto, esperado] of Object.entries(valen)) assert.equal(normalizarProducto(texto), esperado, texto);
  for (const texto of [
    // los ejemplos del verificador (faseB/hermes-devoluciones-verif/producto.txt)
    'Disruptive Brain del Club de Sistemas', 'Solo el Brain, no la cuenta', 'Brain (sin Hermes)', 'La suscripción del Club', 'Cuenta, Brain',
    // y otros parecidos que tampoco son opciones del formulario
    'cuenta y brain', 'Hermes', 'club', 'ambos productos', 'las dos cosas', 'brain.', 'la cuenta', 'Cuenta del Club, Disruptive Brain',
    '', '   ', '{{contact.club_dd__devolucin__qu_devolver}}', 'el curso',
  ]) {
    assert.equal(normalizarProducto(texto), null, texto);
  }
  // de punta a punta: un texto raro NUNCA mide (ni aprueba) la cuenta ni pregunta al Brain
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' }); // 0 USD de IA: se aprobaría si se midiese
  const f = fetchFalso();
  const raros = ['Solo el Brain, no la cuenta', 'Disruptive Brain del Club de Sistemas', 'Brain (sin Hermes)', 'La suscripción del Club'];
  for (const [i, producto] of raros.entries()) {
    const r = await evaluar(pg, f, { producto, contact_id: `contP${String(i).padStart(3, '0')}` });
    assert.deepEqual(r.body.decision, { desconocido: 'revision' }, producto);
    assert.match(r.body.motivos.desconocido, /No se entiende qué quiere devolver/);
  }
  assert.equal(f.aBrain().length, 0, 'tampoco se pregunta al Brain');
  assert.deepEqual(f.aGhl().map((x) => `${x.producto}:${x.decision}`), raros.map(() => 'desconocido:revision'));
  await pg.close();
});

// Fase C · [dinero] el verificador aprobó la CUENTA con 40 USD gastados mandando una fecha_cobro de HOY pero con una hora
// POSTERIOR a ahora (faseB/hermes-devoluciones-verif/futura-mismo-dia.txt): se medía desde un instante futuro = 0 USD.
test('plazo: un cobro POSTERIOR a ahora (más tarde hoy con hora, ISO con hora o marca Unix) → revisión, nunca aprobada', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 40, '2026-11-13T10:00:00Z'); // 40 USD hoy a las 11:00 de Madrid, ANTES de pedir la devolución
  const casos = [
    ['2026-11-13T20:00:00Z', 'revision'], // hoy a las 21:00 de Madrid (ahora son las 13:00)
    [String(Math.floor(Date.parse('2026-11-13T21:30:00Z') / 1000)), 'revision'], // marca Unix de hoy, más tarde (1794605400)
    [String(Date.parse('2026-11-13T12:00:01Z')), 'revision'], // en milisegundos, un segundo después de ahora
    ['2026-11-13 14:30', 'revision'], // hora de Madrid sin zona, más tarde
    ['13/11/2026 22:00', 'revision'],
    ['November 13, 2026 9:30 pm', 'revision'],
    ['2026-11-13', 'denegada'], // solo el día: la medianoche de Madrid ya pasó → se mide (40 USD > 5)
    ['November 13, 2026', 'denegada'], // el formato en que GHL rellena los campos de fecha
    ['2026-11-13T09:00:00Z', 'denegada'], // con hora, pero ya pasada → se mide desde ahí
  ];
  for (const [i, [fecha, esperada]] of casos.entries()) {
    const r = await evaluar(pg, fetchFalso(), { fecha_cobro: fecha, contact_id: `contF${String(i).padStart(3, '0')}` });
    assert.equal(r.body.decision.cuenta, esperada, fecha);
    if (esperada === 'revision') assert.match(r.body.motivos.cuenta, /es posterior a ahora: lo revisa soporte/, fecha);
    else assert.equal(r.body.motivos.cuenta, 'Has usado 40,00 USD de IA (límite 5)', fecha);
  }
  // en evaluarPlazo: el instante de ahora mismo aún vale; un milisegundo después ya no
  const aj = { ...AJUSTES_POR_DEFECTO };
  assert.equal(evaluarPlazo(interpretarFecha(String(AHORA.getTime())), '', aj, AHORA).decision, undefined);
  assert.equal(evaluarPlazo(interpretarFecha(String(AHORA.getTime() + 1)), '', aj, AHORA).decision, 'revision');
  // ambigua con una lectura futura y otra pasada: la futura se descarta (como antes)
  assert.equal(evaluarPlazo(interpretarFecha('12/11/2026'), '12/11/2026', aj, AHORA).dia, '2026-11-12');
  await pg.close();
});

// Fase C · 5) las fechas tal como las rellena GHL en los campos de fecha («November 13, 2026») se leen en hora de Madrid.
test('fechas de GHL («November 13, 2026», «November 20, 2026»): medianoche de Madrid y días naturales de Madrid', () => {
  const a = interpretarFecha('November 13, 2026');
  assert.equal(a.estado, 'ok');
  assert.equal(a.candidatos.length, 1);
  assert.equal(a.candidatos[0].toISOString(), '2026-11-12T23:00:00.000Z', 'medianoche de Madrid (CET, UTC+1)');
  assert.equal(diaEnZona(a.candidatos[0]), '2026-11-13');
  const b = interpretarFecha('November 20, 2026');
  assert.equal(b.estado, 'ok');
  assert.equal(b.candidatos[0].toISOString(), '2026-11-19T23:00:00.000Z');
  assert.equal(diaEnZona(b.candidatos[0]), '2026-11-20');
  const aj = { ...AJUSTES_POR_DEFECTO };
  const p = (s, ahora) => evaluarPlazo(interpretarFecha(s), s, aj, ahora);
  // hoy, 13 de noviembre a las 13:00 de Madrid: el 13 es «hoy» (0 días) y el 20 aún no ha llegado
  assert.equal(p('November 13, 2026', AHORA).dias, 0);
  assert.equal(p('November 13, 2026', AHORA).decision, undefined);
  assert.equal(p('November 13, 2026', AHORA).fecha_clave, '2026-11-13');
  assert.equal(p('November 20, 2026', AHORA).decision, 'revision');
  // a las 00:30 de Madrid del 13 (aún el 12 en UTC) ya es «el día 13»; a las 23:59 del 12 todavía no
  assert.equal(p('November 13, 2026', new Date('2026-11-12T23:30:00Z')).dias, 0);
  assert.equal(p('November 13, 2026', new Date('2026-11-12T22:59:59Z')).decision, 'revision');
  // cobro del 20: el día 14 (4 de diciembre) entra hasta las 23:59:59 de Madrid; a las 00:00 del 5 ya son 15 → denegada
  assert.equal(p('November 20, 2026', new Date('2026-12-04T22:59:59Z')).dias, 14);
  assert.equal(p('November 20, 2026', new Date('2026-12-04T22:59:59Z')).decision, undefined);
  const fuera = p('November 20, 2026', new Date('2026-12-04T23:00:00Z'));
  assert.equal(fuera.decision, 'denegada');
  assert.equal(fuera.motivo, 'Han pasado 15 días desde el cobro (plazo: 14 días)');
  // variantes del mismo formato
  assert.equal(diaEnZona(interpretarFecha('Friday, November 13, 2026').candidatos[0]), '2026-11-13');
  assert.equal(diaEnZona(interpretarFecha('november 20, 2026').candidatos[0]), '2026-11-20');
  assert.equal(diaEnZona(interpretarFecha('Nov 20, 2026').candidatos[0]), '2026-11-20');
});

test('cuerpo: solo se rechaza sin contact_id ni email; lo demás pasa (y acaba en revisión si falta)', () => {
  assert.equal(validarCuerpoDevolucion(null).ok, false);
  assert.equal(validarCuerpoDevolucion([]).ok, false);
  assert.equal(validarCuerpoDevolucion({ producto: 'cuenta' }).ok, false);
  assert.equal(validarCuerpoDevolucion({ email: '{{contact.email}}', contact_id: '{{contact.id}}' }).ok, false);
  const d = validarCuerpoDevolucion({ email: ' Cliente@X.com ', contact_id: 'con espacios', location_id: "x'; DROP", producto: 'brain', fecha_cobro: 1773100800 }).datos;
  assert.equal(d.email, 'cliente@x.com');
  assert.equal(d.contact_id, '');
  assert.equal(d.location_id, '');
  assert.equal(d.fecha_texto, '1773100800');
  assert.equal(d.avisos.length, 2);
  const largo = validarCuerpoDevolucion({ contact_id: 'abcd1234', motivo: 'x'.repeat(50000), producto: 'p'.repeat(5000) }).datos;
  assert.equal(largo.motivo.length, 2000);
  assert.equal(largo.producto, null);
});

test('ajustes: saneado (vuelve al defecto) y validación del admin (https, rangos, 0 permitido)', () => {
  assert.deepEqual(sanearAjustes(null), AJUSTES_POR_DEFECTO);
  assert.deepEqual(sanearAjustes({ plazo_dias: 'abc', max_ia_usd: -1, brain_uso_url: 'http://x.com' }), AJUSTES_POR_DEFECTO);
  assert.equal(sanearAjustes({ max_ia_usd: 0 }).max_ia_usd, 0, 'cero vale: cualquier uso deniega');
  let v = validarAjustes({ plazo_dias: '30', max_ia_usd: '7,5', max_brain_tareas: 0, brain_uso_url: 'https://brain.escaladoacelerado.es/api/club/uso' });
  assert.equal(v.ok, true);
  assert.equal(v.valor.plazo_dias, 30);
  assert.equal(v.valor.max_ia_usd, 7.5);
  assert.equal(v.valor.max_brain_tareas, 0);
  assert.equal(validarAjustes({ plazo_dias: 0 }).ok, false);
  assert.equal(validarAjustes({ plazo_dias: 14.5 }).ok, false);
  assert.equal(validarAjustes({ max_ia_usd: '' }).ok, false, 'vaciar un número no lo pone a 0 en silencio');
  assert.equal(validarAjustes({ brain_uso_url: 'http://brain.test' }).ok, false);
  assert.equal(validarAjustes({ ghl_resultado_url: 'https://user:pass@x.com/h' }).ok, false);
  assert.equal(validarAjustes({ ghl_resultado_url: 'javascript:alert(1)' }).ok, false);
  v = validarAjustes({ ghl_resultado_url: '' }, { ...AJUSTES_POR_DEFECTO, ghl_resultado_url: GHL, max_ia_usd: 9 });
  assert.equal(v.valor.ghl_resultado_url, '');
  assert.equal(v.valor.max_ia_usd, 9, 'lo que no llega se queda como estaba');
});

// ── CUENTA ──────────────────────────────────────────────────────────────────────────────────
test('cuenta: dentro del límite → aprobada; avisa a GHL una vez con el resultado', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 0.7, '2026-11-11T10:00:00Z');
  await uso(pg, 101, 0.5, '2026-11-12T10:00:00Z', 'seguimiento');
  await uso(pg, 101, 30, '2026-11-01T10:00:00Z'); // ANTES del cobro: no cuenta
  await uso(pg, 101, 0, '2026-11-12T10:00:00Z', 'playground'); // pruebas: van a 0
  const f = fetchFalso();
  const r = await evaluar(pg, f);
  assert.equal(r.code, 200);
  assert.equal(r.body.decision.cuenta, 'aprobada');
  assert.equal(r.body.decision_cuenta, 'aprobada');
  assert.match(r.body.motivos.cuenta, /^Has usado 1,20 USD de IA \(límite 5\)/);
  const enviados = f.aGhl();
  assert.equal(enviados.length, 1);
  assert.deepEqual(
    { email: enviados[0].email, contact_id: enviados[0].contact_id, producto: enviados[0].producto, decision: enviados[0].decision },
    { email: 'cliente@x.com', contact_id: 'cont0001', producto: 'cuenta', decision: 'aprobada' }
  );
  assert.equal(enviados[0].fecha_cobro, '2026-11-10');
  assert.equal(enviados[0].consumo_ia_usd, 1.2);
  assert.equal(f.llamadas.find((l) => l.url === GHL).init.headers['x-club-secret'], undefined, 'el secreto NO viaja a GHL');
  const fila = (await pg.query(`SELECT * FROM club_devoluciones`)).rows[0];
  assert.equal(fila.ghl_estado, 'enviado');
  assert.equal(fila.ghl_intentos, 1);
  assert.equal(fila.medida.consumo_usd, 1.2);
  assert.equal(f.aBrain().length, 0, 'producto cuenta: no se pregunta al Brain');
  await pg.close();
});

test('cuenta: más del límite → denegada con «Has usado X USD de IA (límite 5)»', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 7.32, '2026-11-11T10:00:00Z');
  const r = await evaluar(pg, fetchFalso());
  assert.equal(r.body.decision.cuenta, 'denegada');
  assert.equal(r.body.motivos.cuenta, 'Has usado 7,32 USD de IA (límite 5)');
  await pg.close();
});

test('cuenta: justo en el límite aprueba; una milésima por encima deniega y el motivo lo deja ver', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 5, '2026-11-11T10:00:00Z');
  assert.equal((await evaluar(pg, fetchFalso())).body.decision.cuenta, 'aprobada');
  await uso(pg, 101, 0.0004, '2026-11-11T11:00:00Z');
  const r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0002' });
  assert.equal(r.body.decision.cuenta, 'denegada');
  assert.equal(r.body.motivos.cuenta, 'Has usado 5,0004 USD de IA (límite 5)');
  await pg.close();
});

test('cuenta: consumo SIN precio conocido → revisión (salvo que lo conocido ya pase del límite)', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 1, '2026-11-11T10:00:00Z');
  await uso(pg, 101, null, '2026-11-11T11:00:00Z'); // respuesta a un lead sin coste conocido
  await uso(pg, 101, null, '2026-11-11T11:00:00Z', 'playground'); // una prueba sin coste no cuenta
  let r = await evaluar(pg, fetchFalso());
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /1 llamada\(s\) de IA sin precio/);
  await uso(pg, 101, 6, '2026-11-12T10:00:00Z');
  r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0003' });
  assert.equal(r.body.decision.cuenta, 'denegada');
  await pg.close();
});

test('cuenta: sin conexión, conexión anterior al Club o correo que no cuadra → revisión (nunca aprueba)', async () => {
  const pg = await base();
  // ninguna conexión con ese correo
  let r = await evaluar(pg, fetchFalso(), { location_id: '', email: 'nadie@x.com' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /No se encuentra su cuenta de Hermes/);
  // una subcuenta sin conexión de Hermes
  r = await evaluar(pg, fetchFalso(), { location_id: 'locNoExiste1', email: 'nadie@x.com', contact_id: 'cont0017' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /La subcuenta indicada no tiene cuenta de Hermes/);
  // la subcuenta de la AGENCIA (conexión anterior al Club)
  r = await evaluar(pg, fetchFalso(), { location_id: 'locAgencia01', contact_id: 'cont0004' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /no es una cuenta del Club/);
  // conexión del Club de OTRO responsable y el correo no es de nadie de esa subcuenta
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'otro@x.com' });
  r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0005' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /no es de ningún usuario conocido/);
  // …pero si el cliente entró por SSO en esa subcuenta (portal_users), sí cuadra
  await pg.query(`INSERT INTO portal_users (account_id, email, name) VALUES (101, 'cliente@x.com', 'Cliente')`);
  r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0006' });
  assert.equal(r.body.decision.cuenta, 'aprobada');
  // y con el correo en los autorizados de la conexión, también
  await nueva(pg, { id: 102, loc: 'locClub0002', owner: 'soporte@x.com' });
  await pg.query(`UPDATE accounts SET authorized_emails = '["soporte@x.com","Cliente2@x.com"]' WHERE id = 102`);
  r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0007', location_id: 'locClub0002', email: 'cliente2@x.com' });
  assert.equal(r.body.decision.cuenta, 'aprobada');
  // conexión sin responsable todavía (nadie ha abierto Hermes): manda la subcuenta
  await nueva(pg, { id: 103, loc: 'locClub0003' });
  r = await evaluar(pg, fetchFalso(), { contact_id: 'cont0008', location_id: 'locClub0003', email: 'cliente3@x.com' });
  assert.equal(r.body.decision.cuenta, 'aprobada');
  await pg.close();
});

test('cuenta por correo: el correo del Club CONFIRMADO de UNA conexión nueva; ser solo el responsable no basta; rastro en otra → revisión', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 2, '2026-11-11T10:00:00Z');
  // solo de responsable (sin confirmar): revisión, con la pista para soporte
  let con = await resolverConexion({ location_id: '', email: 'cliente@x.com' }, pg);
  assert.deepEqual(con, { estado: 'no_encontrada', via: 'correo', cuentas: [], sin_confirmar: [101] });
  let r = await evaluar(pg, fetchFalso(), { location_id: '', contact_id: 'cont0030' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /No se encuentra su cuenta de Hermes/);
  assert.deepEqual((await pg.query(`SELECT medida FROM club_devoluciones WHERE contact_id = 'cont0030'`)).rows[0].medida.sin_confirmar, [101]);
  // soporte confirma el correo del Club → ya se mide SU conexión
  await pg.query(`UPDATE accounts SET club_email = 'cliente@x.com' WHERE id = 101`);
  r = await evaluar(pg, fetchFalso(), { location_id: '' });
  assert.equal(r.body.decision.cuenta, 'aprobada');
  con = await resolverConexion({ location_id: '', email: 'cliente@x.com' }, pg);
  assert.deepEqual(con, { estado: 'ok', via: 'correo', cuentas: [101] });
  // Fase C · 4e) una location_id SIN conexión de Hermes → revisión: ya NO se busca por correo (podría medir OTRA
  // conexión de esa persona, de otra subcuenta)
  con = await resolverConexion({ location_id: 'locNoExiste1', email: 'cliente@x.com' }, pg);
  assert.deepEqual(con, { estado: 'sin_conexion', via: 'subcuenta', cuentas: [] });
  r = await evaluar(pg, fetchFalso(), { location_id: 'locNoExiste1', contact_id: 'cont0016' });
  assert.equal(r.body.decision.cuenta, 'revision', 'antes: aprobada midiendo la conexión 101 por el correo');
  assert.match(r.body.motivos.cuenta, /La subcuenta indicada no tiene cuenta de Hermes/);
  // entró por SSO en OTRA conexión nueva → no se sabe cuál es la suya
  await nueva(pg, { id: 102, loc: 'locClub0002', owner: 'otro@x.com' });
  await pg.query(`INSERT INTO portal_users (account_id, email) VALUES (102, 'cliente@x.com')`);
  con = await resolverConexion({ location_id: '', email: 'cliente@x.com' }, pg);
  assert.equal(con.estado, 'ambiguo');
  // responsable de dos conexiones nuevas (p. ej. soporte): no se encuentra por correo (y nunca se aprueba)
  await nueva(pg, { id: 103, loc: 'locClub0003', owner: 'doble@x.com' });
  await nueva(pg, { id: 104, loc: 'locClub0004', owner: 'doble@x.com' });
  r = await evaluar(pg, fetchFalso(), { location_id: '', email: 'doble@x.com', contact_id: 'cont0009' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /No se encuentra su cuenta de Hermes/);
  con = await resolverConexion({ location_id: '', email: 'doble@x.com' }, pg);
  assert.deepEqual(con.sin_confirmar, [103, 104]);
  // el correo de la conexión ANTIGUA no resuelve por correo
  con = await resolverConexion({ location_id: '', email: 'jonathan@x.com' }, pg);
  assert.equal(con.estado, 'no_encontrada');
  await pg.close();
});

// Fase C · 4) hoy 4ttZ solo manda el correo del comprador. Si soporte abre Hermes antes que el cliente, el responsable
// (owner_email) es soporte. Repaso: el correo de la subcuenta en GHL lo elige el cliente, así que tampoco basta; lo que
// cuenta es el correo del Club que CONFIRMA soporte (club_email).
test('cuenta por correo (sin location_id): solo vale el club_email confirmado; el correo de la subcuenta en GHL es solo una pista', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'soporte@departamentodisruptivo.com' }); // soporte abrió Hermes primero
  await pg.query(`UPDATE accounts SET ghl_location_email = 'cliente@x.com' WHERE id = 101`); // leído de GHL al conectar
  await uso(pg, 101, 7.5, '2026-11-11T10:00:00Z');
  let r = await evaluar(pg, fetchFalso(), { location_id: '' });
  assert.equal(r.body.decision.cuenta, 'revision', 'sin confirmar no se mide nada (podría ser la subcuenta de otro)');
  let con = await resolverConexion({ location_id: '', email: 'cliente@x.com' }, pg);
  assert.deepEqual(con, { estado: 'no_encontrada', via: 'correo', cuentas: [], sin_confirmar: [101] });
  // soporte confirma el correo de la compra (club_email): desde ese momento cuenta ese, y el de la subcuenta ni es pista
  await pg.query(`UPDATE accounts SET club_email = 'compra@gmail.com' WHERE id = 101`);
  con = await resolverConexion({ location_id: '', email: 'cliente@x.com' }, pg);
  assert.deepEqual(con, { estado: 'no_encontrada', via: 'correo', cuentas: [] });
  con = await resolverConexion({ location_id: '', email: 'compra@gmail.com' }, pg);
  assert.deepEqual(con, { estado: 'ok', via: 'correo', cuentas: [101] });
  r = await evaluar(pg, fetchFalso(), { location_id: '', email: 'compra@gmail.com', contact_id: 'cont0021' });
  assert.equal(r.body.decision.cuenta, 'denegada');
  // con location_id, el club_email y el correo de la subcuenta también «casan» con esa subcuenta (antes: no_casa)
  r = await evaluar(pg, fetchFalso(), { location_id: 'locClub0001', email: 'compra@gmail.com', contact_id: 'cont0022' });
  assert.equal(r.body.decision.cuenta, 'denegada');
  r = await evaluar(pg, fetchFalso(), { location_id: 'locClub0001', email: 'cliente@x.com', contact_id: 'cont0023' });
  assert.equal(r.body.decision.cuenta, 'denegada');
  r = await evaluar(pg, fetchFalso(), { location_id: 'locClub0001', email: 'otro@x.com', contact_id: 'cont0024' });
  assert.equal(r.body.decision.cuenta, 'revision', 'un correo que no es de nadie de esa subcuenta sigue sin casar');
  // A1 · OTRA conexión con ese correo de responsable (sin confirmar) ya no empata: sigue siendo la 101
  await nueva(pg, { id: 102, loc: 'locClub0002', owner: 'compra@gmail.com' });
  r = await evaluar(pg, fetchFalso(), { location_id: '', email: 'compra@gmail.com', contact_id: 'cont0025' });
  assert.equal(r.body.decision.cuenta, 'denegada', 'antes: revisión «varias cuentas»');
  con = await resolverConexion({ location_id: '', email: 'compra@gmail.com' }, pg);
  assert.deepEqual(con, { estado: 'ok', via: 'correo', cuentas: [101] });
  // un correo que solo está de correo de subcuenta en dos conexiones: no se encuentra (con las dos de pista)
  await nueva(pg, { id: 103, loc: 'locClub0003', owner: '' });
  await pg.query(`UPDATE accounts SET ghl_location_email = 'doble@x.com' WHERE id IN (102, 103)`);
  con = await resolverConexion({ location_id: '', email: 'doble@x.com' }, pg);
  assert.deepEqual(con, { estado: 'no_encontrada', via: 'correo', cuentas: [], sin_confirmar: [102, 103] });
  // un correo de subcuenta igual al de una conexión ANTERIOR al Club no la encuentra
  await pg.query(`UPDATE accounts SET ghl_location_email = 'jonathan@x.com' WHERE id = 1`);
  con = await resolverConexion({ location_id: '', email: 'jonathan@x.com' }, pg);
  assert.equal(con.estado, 'no_encontrada');
  await pg.close();
});

test('cuenta: si la consulta del consumo falla o devuelve algo raro → revisión, NUNCA aprobada', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const roto = { ...pg, query: (t, p) => (/FROM llm_usage/.test(t) ? Promise.reject(new Error('se cayó la base')) : pg.query(t, p)) };
  let r = await evaluar(roto, fetchFalso());
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /No se ha podido evaluar/);
  const raro = { ...pg, query: (t, p) => (/FROM llm_usage/.test(t) ? Promise.resolve({ rows: [{ usd: 'NaN', sin_precio: 0, llamadas: 0 }] }) : pg.query(t, p)) };
  r = await evaluar(raro, fetchFalso(), { contact_id: 'cont0010' });
  assert.equal(r.body.decision.cuenta, 'revision');
  const vacio = { ...pg, query: (t, p) => (/FROM llm_usage/.test(t) ? Promise.resolve({ rows: [] }) : pg.query(t, p)) };
  r = await evaluar(vacio, fetchFalso(), { contact_id: 'cont0011' });
  assert.equal(r.body.decision.cuenta, 'revision');
  const sinRecuento = { ...pg, query: (t, p) => (/FROM llm_usage/.test(t) ? Promise.resolve({ rows: [{ usd: '1.00' }] }) : pg.query(t, p)) };
  r = await evaluar(sinRecuento, fetchFalso(), { contact_id: 'cont0015' });
  assert.equal(r.body.decision.cuenta, 'revision', 'sin el recuento de llamadas sin precio no se da por bueno');
  await pg.close();
});

// ── BRAIN ───────────────────────────────────────────────────────────────────────────────────
test('brain: pregunta por POST con el secreto y el correo y la fecha en el CUERPO (no en la dirección); ≤ límite aprueba, más deniega', async () => {
  const pg = await base();
  let f = fetchFalso({ brain: () => ({ body: { tareas: 10 } }) });
  let r = await evaluar(pg, f, { producto: 'brain' });
  assert.equal(r.body.decision.brain, 'aprobada');
  const ll = f.aBrain()[0];
  assert.equal(ll.init.method, 'POST');
  assert.equal(ll.url, BRAIN, 'la dirección va limpia: ni correo ni fecha');
  assert.doesNotMatch(ll.url, /cliente|%40|@/);
  assert.deepEqual(JSON.parse(ll.init.body), { email: 'cliente@x.com', desde: '2026-11-09T23:00:00.000Z' });
  assert.equal(ll.init.headers['content-type'], 'application/json');
  assert.equal(ll.init.headers['x-club-secret'], SECRETO);
  assert.equal(ll.init.redirect, 'error', 'el secreto no sigue redirecciones');
  f = fetchFalso({ brain: () => ({ body: { tareas: '11' } }) });
  r = await evaluar(pg, f, { producto: 'brain', contact_id: 'cont0012' });
  assert.equal(r.body.decision.brain, 'denegada');
  assert.equal(r.body.motivos.brain, 'Has hecho 11 tareas con el Brain (límite 10)');
  await pg.close();
});

test('brain: cualquier respuesta que no sea un número limpio → revisión', async () => {
  const pg = await base();
  const casos = [
    () => ({ status: 500, body: { error: 'x' } }),
    () => ({ status: 401, body: {} }),
    () => ({ status: 302, body: '' }),
    () => new Error('timeout'),
    () => ({ body: 'no es json' }),
    () => ({ body: [] }),
    () => ({ body: { medible: false, tareas: 0 } }),
    () => ({ body: { encontrado: false } }),
    () => ({ body: { ok: false, tareas: 0 } }),
    () => ({ body: { tareas: -1 } }),
    () => ({ body: { tareas: 2.5 } }),
    () => ({ body: { tareas: null } }),
    () => ({ body: { tareas: '3 tareas' } }),
    () => ({ body: {} }),
    () => ({ body: { tareas: 1e21 } }),
    () => ({ body: 'x'.repeat(200_001) }),
  ];
  let i = 0;
  for (const brain of casos) {
    const r = await evaluar(pg, fetchFalso({ brain }), { producto: 'brain', contact_id: `contB${String(i++).padStart(3, '0')}` });
    assert.equal(r.body.decision.brain, 'revision', `caso ${i}`);
  }
  assert.equal((await medirBrain({ email: 'a@b.com', desde: AHORA, url: 'http://brain.test/x', secreto: SECRETO, fetchFn: fetchFalso() })).estado, 'no_medible', 'sin https no se manda el secreto');
  await pg.close();
});

test('brain: sin URL configurada o sin correo → revisión sin llamar a nadie', async () => {
  const pg = await base({ brain: '' });
  const f = fetchFalso();
  let r = await evaluar(pg, f, { producto: 'brain' });
  assert.equal(r.body.decision.brain, 'revision');
  assert.match(r.body.motivos.brain, /no está configurada/);
  r = await evaluar(pg, f, { producto: 'brain', email: '', contact_id: 'cont0013' });
  assert.equal(r.body.decision.brain, 'revision');
  assert.equal(f.aBrain().length, 0);
  await pg.close();
});

// ── AMBOS, plazo e idempotencia ─────────────────────────────────────────────────────────────
test('ambos: cada producto por separado, dos filas y dos avisos a GHL', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, 9, '2026-11-11T10:00:00Z');
  const f = fetchFalso({ brain: () => ({ body: { tareas: 2 } }) });
  const r = await evaluar(pg, f, { producto: 'ambos' });
  assert.deepEqual(r.body.decision, { cuenta: 'denegada', brain: 'aprobada' });
  assert.equal(r.body.decision_brain, 'aprobada');
  assert.equal(r.body.solicitudes.length, 2);
  assert.deepEqual(f.aGhl().map((x) => `${x.producto}:${x.decision}`).sort(), ['brain:aprobada', 'cuenta:denegada']);
  await pg.close();
});

test('fuera de plazo: denegada en los dos productos SIN medir nada', async () => {
  const pg = await base();
  const f = fetchFalso();
  const r = await evaluar(pg, f, { producto: 'ambos', fecha_cobro: '2026-10-01' });
  assert.deepEqual(r.body.decision, { cuenta: 'denegada', brain: 'denegada' });
  assert.match(r.body.motivos.brain, /Han pasado 43 días/);
  assert.equal(f.aBrain().length, 0);
  await pg.close();
});

test('sin fecha del cobro o producto que no se entiende → revisión', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  let r = await evaluar(pg, fetchFalso(), { fecha_cobro: '{{contact.fecha_cobro}}' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.match(r.body.motivos.cuenta, /Falta la fecha del cobro/);
  r = await evaluar(pg, fetchFalso(), { producto: 'el curso', contact_id: 'cont0014' });
  assert.deepEqual(r.body.decision, { desconocido: 'revision' });
  await pg.close();
});

test('idempotencia: la misma solicitud otra vez devuelve lo guardado y NO vuelve a avisar a GHL', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const f = fetchFalso();
  const a = await evaluar(pg, f);
  // entre medias gasta mucho: la decisión de ese cobro ya está tomada
  await uso(pg, 101, 50, '2026-11-12T10:00:00Z');
  const b = await evaluar(pg, f, { fecha_cobro: '10 de noviembre de 2026' }); // mismo día en otro formato
  assert.equal(a.body.decision.cuenta, 'aprobada');
  assert.equal(b.body.decision.cuenta, 'aprobada');
  assert.equal(b.body.repetida, true);
  assert.equal(b.body.solicitudes[0].id, a.body.solicitudes[0].id);
  assert.equal(f.aGhl().length, 1);
  const fila = (await pg.query(`SELECT count(*)::int AS n, max(repeticiones) AS rep FROM club_devoluciones`)).rows[0];
  assert.equal(fila.n, 1);
  assert.equal(fila.rep, 1);
  // otro cobro (otro día) es otra solicitud
  const c = await evaluar(pg, f, { fecha_cobro: '2026-11-12' });
  assert.notEqual(c.body.solicitudes[0].id, a.body.solicitudes[0].id);
  await pg.close();
});

test('idempotencia con dos peticiones idénticas A LA VEZ: una fila por producto y un solo aviso', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const f = fetchFalso();
  const [x, y] = await Promise.all([evaluar(pg, f, { producto: 'ambos' }), evaluar(pg, f, { producto: 'ambos' })]);
  assert.deepEqual(x.body.decision, y.body.decision);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_devoluciones`)).rows[0].n, 2);
  assert.equal(f.aGhl().length, 2, 'un aviso por producto, no por petición');
  await pg.close();
});

// ── Aviso a GHL: sin URL, fallos y reintentos ───────────────────────────────────────────────
test('sin URL de GHL: solo guarda y responde (sin_url), y el admin puede mandarla después', async () => {
  const pg = await base({ ghl: '' });
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const f = fetchFalso();
  const r = await evaluar(pg, f);
  assert.equal(r.body.solicitudes[0].envio_ghl, 'sin_url');
  assert.equal(f.aGhl().length, 0);
  assert.equal((await pg.query(`SELECT ghl_estado FROM club_devoluciones`)).rows[0].ghl_estado, 'sin_url');
  assert.deepEqual(await enviarAGhl(r.body.solicitudes[0].id, { pg, fetchFn: f, forzar: true }), { estado: 'sin_url' });
  await pg.query(`UPDATE settings SET value = value || $1::jsonb WHERE key = 'devoluciones'`, [JSON.stringify({ ghl_resultado_url: GHL })]);
  assert.equal((await reintentarEnvios({ pg, fetchFn: f })).revisadas, 0, 'el barrido no manda las «sin URL» viejas');
  assert.equal((await enviarAGhl(r.body.solicitudes[0].id, { pg, fetchFn: f, forzar: true })).estado, 'enviado');
  assert.equal(f.aGhl().length, 1);
  await pg.close();
});

test('aviso a GHL que falla: queda en error, el barrido lo reintenta con espera y no lo duplica', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  let caido = true;
  const f = fetchFalso({ ghl: () => (caido ? { status: 503, body: 'caído' } : { status: 200, body: {} }) });
  const r = await evaluar(pg, f);
  const id = r.body.solicitudes[0].id;
  let fila = (await pg.query(`SELECT * FROM club_devoluciones WHERE id = $1`, [id])).rows[0];
  assert.equal(fila.ghl_estado, 'error');
  assert.equal(fila.ghl_error, 'HTTP 503');
  // recién fallado: el barrido espera (5 min tras el 1.er intento)
  assert.equal((await reintentarEnvios({ pg, fetchFn: f })).revisadas, 0);
  await pg.query(`UPDATE club_devoluciones SET ghl_ultimo_intento_at = now() - interval '6 minutes' WHERE id = $1`, [id]);
  caido = false;
  assert.deepEqual(await reintentarEnvios({ pg, fetchFn: f }), { revisadas: 1, enviadas: 1 });
  fila = (await pg.query(`SELECT * FROM club_devoluciones WHERE id = $1`, [id])).rows[0];
  assert.equal(fila.ghl_estado, 'enviado');
  assert.equal(fila.ghl_intentos, 2);
  assert.equal((await reintentarEnvios({ pg, fetchFn: f })).revisadas, 0, 'una enviada no se vuelve a mandar');
  // la misma solicitud otra vez tampoco reenvía
  await evaluar(pg, f);
  assert.equal(f.aGhl().length, 2, '1 fallido + 1 bueno');
  await pg.close();
});

test('envío interrumpido (proceso caído a mitad): el barrido lo recupera; y nadie envía dos veces a la vez', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const f = fetchFalso();
  const r = await procesarDevolucion(datos(), { pg, fetch: f, ahora: AHORA, secreto: SECRETO });
  await r.envios;
  const id = r.body.solicitudes[0].id;
  await pg.query(`UPDATE club_devoluciones SET ghl_estado = 'enviando', ghl_ultimo_intento_at = now() - interval '11 minutes', ghl_intentos = 1 WHERE id = $1`, [id]);
  assert.equal((await enviarAGhl(id, { pg, fetchFn: f })).estado, 'ocupado', 'enviándose: nadie más la reclama');
  await reintentarEnvios({ pg, fetchFn: f }); // pasa a error (espera 5 min desde el último intento: ya pasó)
  assert.equal((await pg.query(`SELECT ghl_estado FROM club_devoluciones WHERE id = $1`, [id])).rows[0].ghl_estado, 'enviado');
  // dos reclamaciones a la vez sobre una pendiente: solo una envía
  await pg.query(`UPDATE club_devoluciones SET ghl_estado = 'pendiente' WHERE id = $1`, [id]);
  const antes = f.aGhl().length;
  const res = await Promise.all([enviarAGhl(id, { pg, fetchFn: f }), enviarAGhl(id, { pg, fetchFn: f })]);
  assert.deepEqual(res.map((x) => x.estado).sort(), ['enviado', 'ocupado']);
  assert.equal(f.aGhl().length, antes + 1);
  await pg.close();
});

test('cuerpo para GHL: los campos acordados', () => {
  const c = cuerpoParaGhl({ id: 7, email: 'a@b.com', contact_id: 'c1', producto: 'brain', decision: 'denegada', motivo: 'm', fecha_dia: '2026-11-10', location_id: '', medida: { dias: 3, tareas: 11 } });
  assert.deepEqual(c, { email: 'a@b.com', contact_id: 'c1', producto: 'brain', decision: 'denegada', motivo: 'm', solicitud_id: 7, fecha_cobro: '2026-11-10', dias_desde_cobro: 3, consumo_ia_usd: null, tareas_brain: 11, location_id: '' });
});

test('panel: listado con totales y filtro por decisión', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await evaluar(pg, fetchFalso({ brain: () => ({ body: { tareas: 50 } }) }), { producto: 'ambos' });
  const { solicitudes, totales } = await listarSolicitudes({}, pg);
  assert.equal(solicitudes.length, 2);
  assert.deepEqual(totales, { aprobada: 1, denegada: 1 });
  assert.equal((await listarSolicitudes({ decision: 'denegada' }, pg)).solicitudes[0].producto, 'brain');
  assert.equal((await listarSolicitudes({ decision: "x' OR 1=1" }, pg)).solicitudes.length, 2, 'filtro raro = sin filtro');
  await pg.close();
});

// ── Endpoint ────────────────────────────────────────────────────────────────────────────────
function fakeRedis() {
  const m = new Map();
  return {
    incr: async (k) => { m.set(k, (Number(m.get(k)) || 0) + 1); return m.get(k); },
    expire: async () => 1,
    claves: () => [...m.keys()],
  };
}
async function appDePruebas(pg, f, extra = {}) {
  // mismas opciones y mismo lector JSON que producción (src/index.js)
  const app = Fastify({ trustProxy: true, bodyLimit: 20 * 1024 * 1024 });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, payload, done) => {
    req.rawBody = payload;
    try { done(null, payload ? JSON.parse(payload) : {}); } catch { done(null, {}); }
  });
  await app.register(clubRoutes, { pool: pg, redis: fakeRedis(), secreto: SECRETO, fetch: f, esperarEnvios: true, reloj: () => 1_800_000_000_000, ...extra });
  return app;
}

test('endpoint /api/club/devolucion: 503 sin secreto, 401 malo, 400 sin identidad, 200 bien, 413 enorme', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  const cuerpo = { email: 'cliente@x.com', contact_id: 'cont0001', producto: 'cuenta', motivo: 'x', fecha_cobro: '2026-11-10', location_id: 'locClub0001' };
  const sin = await appDePruebas(pg, fetchFalso(), { secreto: '' });
  assert.equal((await sin.inject({ method: 'POST', url: '/api/club/devolucion', payload: cuerpo })).statusCode, 503);
  const corto = await appDePruebas(pg, fetchFalso(), { secreto: 'corto' });
  assert.equal((await corto.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': 'corto' }, payload: cuerpo })).statusCode, 503);
  const f = fetchFalso();
  const app = await appDePruebas(pg, f);
  assert.equal((await app.inject({ method: 'POST', url: '/api/club/devolucion', payload: cuerpo })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': 'malo' }, payload: cuerpo })).statusCode, 401);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_devoluciones`)).rows[0].n, 0, 'sin secreto válido no se guarda nada');
  let r = await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': SECRETO }, payload: { producto: 'cuenta' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': SECRETO, 'content-type': 'application/json' }, payload: 'esto no es json' });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { authorization: `Bearer ${SECRETO}` }, payload: cuerpo });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().decision.cuenta, 'aprobada');
  assert.equal(r.json().solicitudes[0].envio_ghl, 'en_curso');
  assert.equal(f.aGhl().length, 1);
  r = await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': SECRETO, 'content-type': 'application/json' }, payload: JSON.stringify({ ...cuerpo, motivo: 'x'.repeat(20000) }) });
  assert.equal(r.statusCode, 413);
  await pg.close();
});

test('freno: cambiar el PRIMER tramo de X-Forwarded-For no lo esquiva (cuenta el último, el de Traefik)', async () => {
  const pg = await base();
  const app = await appDePruebas(pg, fetchFalso());
  const intento = (xff) => app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': 'malo', 'x-forwarded-for': xff }, payload: { email: 'a@b.com' } });
  for (let i = 0; i < 20; i++) assert.equal((await intento(`10.0.0.${i}, 203.0.113.7`)).statusCode, 401);
  assert.equal((await intento('10.9.9.9, 203.0.113.7')).statusCode, 429, 'misma IP real: frenado aunque cambie el primer tramo');
  assert.equal((await intento('203.0.113.8')).statusCode, 401, 'otra IP real no está frenada');
  // IPv6: todo el /64 cuenta como una
  for (let i = 0; i < 20; i++) await intento(`2001:db8:1:2::${(i + 1).toString(16)}`);
  assert.equal((await intento('2001:db8:1:2:ffff::1')).statusCode, 429);
  // el secreto bueno pasa siempre (nadie puede bloquear a GHL haciéndose pasar por su IP)
  const r = await app.inject({ method: 'POST', url: '/api/club/devolucion', headers: { 'x-club-secret': SECRETO, 'x-forwarded-for': '203.0.113.7' }, payload: { email: 'a@b.com', contact_id: 'cont0001', producto: 'cuenta', fecha_cobro: '2026-11-10' } });
  assert.equal(r.statusCode, 200);
  await pg.close();
});

test('freno GLOBAL: repartir los intentos entre muchas IPs no lo esquiva; y vale también para /api/club/estado', async () => {
  const pg = await base();
  const app = await appDePruebas(pg, fetchFalso(), { limiteGlobal: 30 });
  let ultimo = 0;
  for (let i = 0; i < 31; i++) {
    const ruta = i % 2 ? '/api/club/estado' : '/api/club/devolucion';
    ultimo = (await app.inject({ method: 'POST', url: ruta, headers: { 'x-club-secret': 'malo', 'x-forwarded-for': `198.51.100.${i}` }, payload: {} })).statusCode;
  }
  assert.equal(ultimo, 429, 'el intento 31 de este minuto, desde una IP nueva, ya se frena');
  const ok = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO }, payload: { activo: 'x' } });
  assert.equal(ok.statusCode, 400, 'con el secreto bueno se sigue entrando (400 por el cuerpo, sin efectos)');
  await pg.close();
});

test('motivos: el texto del cliente que se repite en el motivo va sin HTML (acaba en emails de GHL)', async () => {
  const pg = await base();
  const r = await evaluar(pg, fetchFalso(), { fecha_cobro: '<img src=x onerror=alert(1)>', contact_id: 'contX001' });
  assert.equal(r.body.decision.cuenta, 'revision');
  assert.doesNotMatch(r.body.motivos.cuenta, /[<>"']/);
  const r2 = await evaluar(pg, fetchFalso(), { producto: '<b>el curso</b>', contact_id: 'contX002' });
  assert.equal(r2.body.decision.desconocido, 'revision');
  assert.doesNotMatch(r2.body.motivos.desconocido, /[<>]/);
  await pg.close();
});

test('cuenta: una fuente que el admin cobra (Facturación) y vino SIN precio también manda a revisión', async () => {
  const pg = await base();
  await nueva(pg, { id: 101, loc: 'locClub0001', owner: 'cliente@x.com' });
  await uso(pg, 101, null, '2026-11-11T10:00:00Z', 'simulador');
  assert.equal((await evaluar(pg, fetchFalso())).body.decision.cuenta, 'aprobada', 'el simulador no se cobra por defecto');
  await pg.query(`INSERT INTO settings (key, value) VALUES ('facturacion', '{"fuentes":["reply","seguimiento","simulador"]}'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const r = await evaluar(pg, fetchFalso(), { contact_id: 'contX003' });
  assert.equal(r.body.decision.cuenta, 'revision');
  await pg.close();
});
