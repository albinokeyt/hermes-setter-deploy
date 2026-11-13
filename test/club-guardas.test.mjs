// Fase C3 · guardas del «Correo del Club» (club_email):
//  1) UNA sola normalización (services/club.js · analizarCorreo) que RECHAZA caracteres invisibles o de formato, de
//     control y espacios (ataque V3 del verificador: con U+200B la ficha decía «confirmado» y nada casaba), la misma en
//     la ficha, el interruptor (/api/club/estado), las devoluciones, el SSO y las pistas «Usar».
//  2) El correo del Club nunca puede ser uno de soporte, de la agencia ni de un admin de Hermes (lista ampliable en
//     Configuración → «Correo del Club»), y la pista «Usar» no los ofrece.
// Rutas REALES sobre Postgres real en memoria (PGlite) con las migraciones de verdad; GHL, Redis y el pipeline son
// dobles. Sin red, sin GHL, sin mensajes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { baseDePruebas } from './_pglite.mjs';

// Base: una conexión ANTERIOR al Club creada antes de la 059; el resto se crea después (conexiones del Club).
const pg = await baseDePruebas({ antesDe: '059' });
await pg.exec(`
  INSERT INTO accounts (id, name, location_id, webhook_token, ai_enabled, owner_email, created_at)
  VALUES (1, 'DEP', 'locAntigua01', 'tokA', true, 'cliente@antiguo.com', now() - interval '30 days');
  SELECT setval('accounts_id_seq', 100);
`);
for (const f of fs.readdirSync(new URL('../src/migrations/', import.meta.url)).filter((x) => x.endsWith('.sql') && x >= '059').sort()) {
  await pg.exec(fs.readFileSync(new URL(`../src/migrations/${f}`, import.meta.url), 'utf8'));
}
const filas = async (t, p) => (await pg.query(t, p)).rows;
const u = (p) => new URL(p, import.meta.url).href;

mock.module(u('../src/db.js'), {
  namedExports: {
    pool: pg,
    q: filas,
    one: async (t, p) => (await filas(t, p))[0] || null,
    migrate: async () => {},
    getSetting: async (k, fb = null) => { const r = await filas(`SELECT value FROM settings WHERE key = $1`, [k]); return r[0] ? r[0].value : fb; },
    setSetting: async (k, v) => { await pg.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`, [k, JSON.stringify(v)]); },
  },
});
const almacen = new Map();
mock.module(u('../src/lib/redis.js'), {
  namedExports: {
    redis: {
      get: async (k) => almacen.get(k) ?? null,
      set: async (k, v) => { almacen.set(k, v); return 'OK'; },
      setex: async (k, _s, v) => { almacen.set(k, v); return 'OK'; },
      del: async (k) => { almacen.delete(k); return 1; },
      expire: async () => 1,
      incr: async (k) => { const n = (Number(almacen.get(k)) || 0) + 1; almacen.set(k, n); return n; },
    },
    bullConnection: () => ({}),
  },
});
mock.module(u('../src/services/pipeline.js'), {
  namedExports: {
    logEvent: async (kind, payload) => { await pg.query(`INSERT INTO webhook_log (kind, payload) VALUES ($1, $2)`, [kind, JSON.stringify(payload)]); },
    activateSetterForContact: async () => {},
    recordUsage: async () => {},
  },
});
mock.module(u('../src/services/marketplace.js'), {
  namedExports: { cerrarLotesConsumo: async () => ({ ok: true }), puedeProbar: async () => true, SIN_SALDO_PRUEBAS: 'sin saldo' },
});
const infoGhl = new Map();
const codigos = new Map(); // code de OAuth → locationId
mock.module(u('../src/services/ghl.js'), {
  namedExports: {
    exchangeCodeForLocation: async (code, conocida) => ({ locationId: codigos.get(code) || conocida, access_token: 'at', refresh_token: 'rt' }),
    saveTokens: async (tok) => {
      await pg.query(`INSERT INTO ghl_tokens (location_id, access_token, refresh_token, expires_at) VALUES ($1, 'at', 'rt', now() + interval '1 day')
                      ON CONFLICT (location_id) DO NOTHING`, [tok.locationId]);
      return tok.locationId;
    },
    getLocationInfo: async (_a, loc) => infoGhl.get(loc) || { ok: true, name: `Subcuenta ${loc}`, email: '' },
    getLocationName: async () => '',
    listLocationUsers: async () => [],
    listCalendars: async () => [],
    getContact: async () => ({}),
    listWhatsappTemplates: async () => ({ templates: [] }),
  },
});

const portalRoutes = (await import('../src/routes/portal.js')).default;
const ghlOauthRoutes = (await import('../src/routes/ghlOauth.js')).default;
const accountRoutes = (await import('../src/routes/accounts.js')).default;
const settingsRoutes = (await import('../src/routes/settings.js')).default;
const clubRoutes = (await import('../src/routes/club.js')).default;
const club = await import('../src/services/club.js');
const { validarCuerpoDevolucion, procesarDevolucion, diaEnZona } = await import('../src/services/devoluciones.js');

const SECRETO = 'g'.repeat(48);
const SOPORTE = 'soporte@departamentodisruptivo.com';
const SOPORTE_JA = 'soporte@soyjonathanalef.com';
const cuenta = async (loc) => (await filas(`SELECT * FROM accounts WHERE location_id = $1`, [loc]))[0];
const pendiente = async (mail) => (await filas(`SELECT activo, motivo FROM club_estado_pendiente WHERE clave = $1`, [`email:${mail}`]))[0] || null;
const eventos = async (kind) => (await filas(`SELECT payload FROM webhook_log WHERE kind = $1 ORDER BY id`, [kind])).map((r) => r.payload);

function fakeRedis() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, incr: async (k) => { m.set(k, (Number(m.get(k)) || 0) + 1); return m.get(k); }, expire: async () => 1 };
}

// app con las rutas reales; «x-rol: admin» o «x-rol: <id de cuenta>» hace de sesión
async function app() {
  const a = Fastify();
  await a.register(fastifyCookie);
  a.addHook('onRequest', async (req) => {
    const rol = req.headers['x-rol'];
    if (rol === 'admin') { req.auth = { role: 'admin', userId: 1 }; req.userId = 1; } else if (rol) req.auth = { role: 'user', accountId: Number(rol), portal: true };
  });
  await a.register(portalRoutes);
  await a.register(ghlOauthRoutes);
  await a.register(accountRoutes);
  await a.register(settingsRoutes);
  await a.register(clubRoutes, { secreto: SECRETO, redis: fakeRedis() });
  return a;
}
const put = (a, id, payload, rol = 'admin') => a.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { 'x-rol': rol }, payload });
const ficha = async (a, id) => (await a.inject({ method: 'GET', url: `/api/accounts/${id}`, headers: { 'x-rol': 'admin' } })).json();
const putLista = (a, no_club) => a.inject({ method: 'PUT', url: '/api/settings/club-correos', headers: { 'x-rol': 'admin' }, payload: { no_club } });
const estado = (a, payload) => a.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO }, payload });

// cifrado igual que GHL (CryptoJS AES.encrypt con passphrase → «Salted__» + EVP_BytesToKey MD5)
function cifrarSso(obj, secreto) {
  const salt = crypto.randomBytes(8);
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(secreto), salt])).digest(); d = Buffer.concat([d, prev]); }
  const c = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
}
await pg.query(`INSERT INTO settings (key, value) VALUES ('ghl_app', '{"sso_secret":"secreto-sso-de-prueba"}'::jsonb)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
const sso = (a, email, loc) => a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted: cifrarSso({ email, activeLocation: loc }, 'secreto-sso-de-prueba') } });

// ── 1 · caracteres invisibles, de control y espacios ───────────────────────────────────────────────────────────────

test('1 · una sola normalización: rechaza invisibles, controles y espacios (también en el borde si no son ASCII) y dice cuál', () => {
  const malos = [
    ['v3b@x.com\u{200B}', 'invisible', 'U+200B, espacio de ancho cero'],
    ['\u{200B}v3b@x.com', 'invisible', 'U+200B'],
    ['v3\u{200B}b@x.com', 'invisible', 'U+200B'],
    ['\u{FEFF}v3b@x.com', 'invisible', 'U+FEFF'], // el trim() de JS lo quitaba sin decir nada
    ['v3b@x.com\u{2060}', 'invisible', 'U+2060'],
    ['v3\u{AD}b@x.com', 'invisible', 'U+00AD'],
    ['v3b\u{200E}@x.com', 'invisible', 'U+200E'],
    ['v3b\u{202E}@x.com', 'invisible', 'U+202E'],
    ['v3\u{3164}b@x.com', 'invisible', 'U+3164'],
    ['v3\u{E0041}b@x.com', 'invisible', 'U+E0041'],
    ['v3 b@x.com', 'espacio', 'espacios dentro'],
    ['v3\u{A0}b@x.com', 'espacio', 'U+00A0, espacio duro'],
    ['\u{A0}v3b@x.com', 'espacio', 'U+00A0'],
    ['v3\tb@x.com', 'espacio', 'U+0009'],
    ['v3\u0001b@x.com', 'control', 'U+0001'],
    ['v3\u007fb@x.com', 'control', 'U+007F'],
    ['v3\u0085b@x.com', 'control', 'U+0085'],
    ['\u{212A}ate@x.com', 'confuso', 'U+212A, signo kelvin'], // en minúsculas da «kate@x.com»
    ['jose\u{301}@x.com', 'compuesto', 'forma rara'],
  ];
  for (const [v, tipo, trozo] of malos) {
    const a = club.analizarCorreo(v);
    assert.equal(a.correo, '', JSON.stringify(v));
    assert.equal(a.tipo, tipo, JSON.stringify(v));
    assert.ok(a.motivo.includes(trozo), `${JSON.stringify(v)} → ${a.motivo}`);
    assert.equal(club.normalizarCorreo(v), '');
    const s = club.sanearClubEmail(v);
    assert.equal(s.ok, false, JSON.stringify(v));
    assert.match(s.error, /^El correo del Club /);
    assert.ok(s.error.includes(trozo), s.error);
  }
  // espacios ASCII alrededor (como el navegador y GHL), mayúsculas y letras con tilde normales: valen
  assert.deepEqual(club.sanearClubEmail('  V3@X.COM '), { ok: true, valor: 'v3@x.com' });
  assert.deepEqual(club.sanearClubEmail('\tv3@x.com\r\n'), { ok: true, valor: 'v3@x.com' });
  assert.deepEqual(club.sanearClubEmail('José@X.com'), { ok: true, valor: 'josé@x.com' });
  // vacío (nada o solo espacios ASCII) = quitarlo; un invisible o un espacio duro solos NO son «vacío»: se avisa
  // (repaso C3: antes ' \u{A0} ' y '\u{FEFF}' contaban como vacío y quitaban el correo del Club confirmado)
  assert.deepEqual(club.sanearClubEmail(' \t '), { ok: true, valor: null });
  assert.equal(club.sanearClubEmail(' \u{A0} ').ok, false);
  assert.equal(club.sanearClubEmail('\u{FEFF}').ok, false);
  assert.equal(club.sanearClubEmail('\u{200B}').ok, false);
  assert.equal(club.analizarCorreo('x'.repeat(5000)).tipo, 'formato');
});

test('1 · V3 por la ficha: un correo del Club con U+200B se RECHAZA (400 claro) y no queda «confirmado»; escrito bien, se aplica la baja que esperaba', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'V3', locationId: 'locGuardaV31' }, pg);
  await club.aplicarEstadoClub({ email: 'v3b@x.com', activo: false, motivo: 'baja' }, pg); // 202 pendiente
  let r = await put(a, account.id, { club_email: 'v3b@x.com\u{200B}' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /^El correo del Club lleva un carácter invisible \(U\+200B, espacio de ancho cero\)\. .*escríbelo a mano/);
  let fila = await cuenta('locGuardaV31');
  assert.equal(fila.club_email, null, 'antes (V3): se guardaba «v3b@x.com\\u200b» y la ficha decía «confirmado»');
  assert.equal(fila.ai_enabled, true);
  assert.deepEqual(await pendiente('v3b@x.com'), { activo: false, motivo: 'baja' }, 'la baja sigue esperando');
  // con otros campos en el mismo PUT: nada a medias
  r = await put(a, account.id, { club_email: '\u{FEFF}v3b@x.com', name: 'No se renombra' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /U\+FEFF/);
  assert.equal((await cuenta('locGuardaV31')).name, 'V3');
  r = await put(a, account.id, { club_email: ' V3B@x.com ' });
  assert.equal(r.statusCode, 200, r.body);
  fila = await cuenta('locGuardaV31');
  assert.equal(fila.club_email, 'v3b@x.com');
  assert.equal(fila.ai_enabled, false, 'la baja que esperaba se aplica al confirmarlo bien');
  assert.equal(await pendiente('v3b@x.com'), null);
});

test('1 · el interruptor usa la MISMA normalización: invisible, BOM o espacio duro en el borde y kelvin → 400 (visible en GHL), nunca un pendiente que no casará ni el correo de otro', async () => {
  for (const malo of ['v3c@x.com\u{200B}', '\u{FEFF}v3c@x.com', '\u{A0}v3c@x.com', '\u{212A}ate@x.com']) {
    const v = club.validarCuerpoClub({ email: malo, activo: false });
    assert.equal(v.ok, false, JSON.stringify(malo));
    assert.match(v.error, /^email no válido: /);
  }
  assert.equal(club.validarCuerpoClub({ email: ' V3C@X.com ', activo: false }).datos.email, 'v3c@x.com');
  assert.equal(club.validarCuerpoClub({ email: 'sin-arroba', activo: false }).error, 'email no válido');
  assert.equal(club.validarCuerpoClub({ email: '{{contact.email}}', location_id: 'locGuardaI01', activo: false }).datos.email, null, 'sin resolver = no viene');
  const a = await app();
  let r = await estado(a, { email: 'v3c@x.com\u{200B}', activo: false, motivo: 'baja' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /U\+200B/);
  assert.equal(await pendiente('v3c@x.com\u{200B}'), null, 'antes: 202 «pendiente» con una clave que no casaría nunca');
  // kelvin: para GHL es OTRO correo; para Hermes ya no se confunde con el de Kate
  const { account } = await club.crearConexionNueva({ name: 'Kate', locationId: 'locGuardaK01' }, pg);
  assert.equal((await put(a, account.id, { club_email: 'kate@x.com' })).statusCode, 200);
  r = await estado(a, { email: '\u{212A}ate@x.com', activo: false, motivo: 'baja' });
  assert.equal(r.statusCode, 400, 'antes: «\\u212Aate@x.com» pasaba a «kate@x.com» y apagaba a Kate');
  assert.equal((await cuenta('locGuardaK01')).ai_enabled, true);
  r = await estado(a, { email: ' Kate@X.com ', activo: false, motivo: 'baja' });
  assert.equal(r.statusCode, 200);
  assert.equal((await cuenta('locGuardaK01')).ai_enabled, false);
});

test('1 · devoluciones con la MISMA normalización: con un invisible o con kelvin no se mide la cuenta de nadie (revisión con aviso); el correo bueno, sí', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Devo', locationId: 'locGuardaD01' }, pg);
  assert.equal((await put(a, account.id, { club_email: 'kdevo@x.com' })).statusCode, 200);
  const ayer = diaEnZona(new Date(Date.now() - 86_400_000));
  const pedir = async (email, contact_id) => {
    const v = validarCuerpoDevolucion({ email, contact_id, producto: 'cuenta', fecha_cobro: ayer, motivo: 'no me convence' });
    assert.equal(v.ok, true);
    const r = await procesarDevolucion(v.datos, { pg, secreto: 's', fetch: async () => ({ status: 500, text: async () => '' }) });
    return { datos: v.datos, decision: r.body.decision.cuenta, motivo: r.body.motivos.cuenta };
  };
  let d = await pedir('kdevo@x.com\u{200B}', 'contGuarda01');
  assert.equal(d.datos.email, '');
  assert.match(d.datos.avisos.join(' | '), /email no válido: lleva un carácter invisible \(U\+200B/);
  assert.equal(d.decision, 'revision');
  d = await pedir('\u{212A}devo@x.com', 'contGuarda02');
  assert.equal(d.decision, 'revision', 'antes: se leía como «kdevo@x.com» y se medía (y aprobaba) la cuenta de otro');
  assert.match(d.datos.avisos.join(' | '), /U\+212A/);
  d = await pedir(' KDevo@X.com ', 'contGuarda03');
  assert.equal(d.decision, 'aprobada', d.motivo);
});

test('1 · SSO y pistas con la MISMA normalización: el correo de GHL con un invisible no casa con el club_email, y la pista lo dice; el bueno reintenta el pendiente', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'SSO', locationId: 'locGuardaS01' }, pg);
  await pg.query(`UPDATE accounts SET club_email = 'sso.guarda@x.com' WHERE id = $1`, [account.id]);
  // un pendiente que no se pudo aplicar al confirmar (p. ej. falló la base): el SSO del comprador lo reintenta
  await pg.query(`INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ('email:sso.guarda@x.com', false, 'impago', now())`);
  assert.equal(await club.aplicarPendientePorEmail(account.id, 'sso.guarda@x.com\u{200B}', pg), null);
  let r = await sso(a, 'SSO.Guarda@x.com\u{200B}', 'locGuardaS01'); // entra igual (es su usuario de GHL), pero no casa
  assert.equal(r.statusCode, 200, r.body);
  let fila = await cuenta('locGuardaS01');
  assert.equal(fila.ai_enabled, true);
  assert.equal(fila.owner_email, 'sso.guarda@x.com\u{200B}', 'el responsable se guarda como siempre (solo es una pista)');
  const f = await ficha(a, account.id);
  const resp = f.club_pistas.find((p) => p.de === 'responsable');
  assert.equal(resp.usable, false, '«Usar» no ofrece un correo que el servidor rechazaría');
  assert.match(resp.motivo, /^no sirve como correo del Club: lleva un carácter invisible \(U\+200B/);
  r = await sso(a, ' SSO.Guarda@X.com ', 'locGuardaS01');
  assert.equal(r.statusCode, 200);
  fila = await cuenta('locGuardaS01');
  assert.equal(fila.ai_enabled, false, 'con el correo bueno sí se aplica el pendiente');
  assert.equal(await pendiente('sso.guarda@x.com'), null);
});

test('1 · el correo de la subcuenta en GHL con un invisible no se guarda como pista y el registro dice por qué', async () => {
  const a = await app();
  codigos.set('cGuarda1', 'locGuardaO01');
  infoGhl.set('locGuardaO01', { ok: true, name: 'Oauth', email: 'cliente.o@x.com\u{200B}' });
  const r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=cGuarda1' });
  assert.equal(r.statusCode, 302);
  const acc = await cuenta('locGuardaO01');
  assert.equal(acc.ghl_location_email, null);
  const ev = (await eventos('club_correo_subcuenta_vacio')).find((e) => e.account === acc.id);
  assert.match(ev.nota, /no es válido \(lleva un carácter invisible \(U\+200B, espacio de ancho cero\)\)/);
});

// ── 2 · correos de soporte, de la agencia y de los admins de Hermes ────────────────────────────────────────────────

test('2 · el correo del Club no puede ser el de soporte (los dos, en cualquier forma): 400 claro, nada a medias y la prueba no se aplica', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Cliente S', locationId: 'locGuardaP01' }, pg);
  await club.aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba del workflow' }, pg);
  for (const v of [SOPORTE, ' Soporte@DepartamentoDisruptivo.com ', SOPORTE_JA, 'SOPORTE@SOYJONATHANALEF.COM']) {
    const r = await put(a, account.id, { club_email: v, name: 'No' });
    assert.equal(r.statusCode, 400, v);
    assert.equal(r.json().error, 'Ese correo es de soporte o de la agencia (Configuración → «Correo del Club»): no puede ser el correo del Club de un cliente. Escribe el correo con el que compró el cliente (compruébalo en 4ttZ).');
  }
  const fila = await cuenta('locGuardaP01');
  assert.equal(fila.club_email, null);
  assert.equal(fila.name, 'Cliente S');
  assert.equal(fila.ai_enabled, true, 'la prueba con el correo de soporte no apaga al cliente');
  assert.deepEqual(await pendiente(SOPORTE), { activo: false, motivo: 'prueba del workflow' }, 'sigue esperando: no se aplicará a ningún cliente');
});

test('2 · ni el de un administrador de Hermes (usuario con forma de correo); un usuario de panel de cliente y un admin sin correo no cuentan', async () => {
  await pg.query(`INSERT INTO users (username, password_hash, role) VALUES ('Jefa@Agencia.com', 'x', 'admin'), ('admin', 'x', 'admin'), ('cliente.panel@x.com', 'x', 'user')
                  ON CONFLICT (username) DO NOTHING`);
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Cliente A', locationId: 'locGuardaA01' }, pg);
  let r = await put(a, account.id, { club_email: 'JEFA@agencia.com' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /^Ese correo es de un administrador de Hermes: no puede ser el correo del Club de un cliente\./);
  assert.equal((await cuenta('locGuardaA01')).club_email, null);
  r = await put(a, account.id, { club_email: 'cliente.panel@x.com' });
  assert.equal(r.statusCode, 200, 'un usuario de panel de un cliente puede ser el comprador');
  assert.deepEqual((await club.leerCorreosNoClub(pg)).admins, ['jefa@agencia.com']);
});

test('2 · lista configurable en Configuración → «Correo del Club»: correos y dominios (con subdominios), sin duplicar los fijos, líneas malas con 400 claro; solo admin', async () => {
  const a = await app();
  let r = await a.inject({ method: 'GET', url: '/api/settings/club-correos', headers: { 'x-rol': 'admin' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().fijos, [SOPORTE, SOPORTE_JA], 'los dos de soporte, siempre');
  assert.deepEqual(r.json().no_club, [], 'por defecto no hay más');
  assert.ok(r.json().admins.includes('jefa@agencia.com'));
  assert.deepEqual(r.json().en_uso, []);
  for (const [method, payload] of [['GET', undefined], ['PUT', { no_club: '' }]]) {
    r = await a.inject({ method, url: '/api/settings/club-correos', headers: { 'x-rol': '101' }, payload });
    assert.equal(r.statusCode, 403, `${method} de un cliente`);
  }
  r = await putLista(a, 'elena.soporte@gmail.com\nesto no es un correo');
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, '«esto no es un correo» no es un correo ni un dominio (@dominio.com): tiene espacios dentro.');
  r = await putLista(a, 'elena.soporte@gmail.com\nsin-arroba');
  assert.equal(r.json().error, '«sin-arroba» no es un correo ni un dominio (@dominio.com).');
  r = await putLista(a, 'elena.soporte@gmail.com\u{200B}');
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /: lleva un carácter invisible \(U\+200B/);
  assert.deepEqual((await club.leerCorreosNoClub(pg)).no_club, [], 'nada a medias');
  // minúsculas, sin duplicados y sin los fijos (cuentan siempre)
  r = await putLista(a, ' Elena.Soporte@Gmail.com \n@MiAgencia.com, soporte@departamentodisruptivo.com\nelena.soporte@gmail.com\n\n');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().no_club, ['elena.soporte@gmail.com', '@miagencia.com']);
  assert.deepEqual(r.json().fijos, [SOPORTE, SOPORTE_JA]);
  const cambio = (await eventos('club_correos_cambiados')).at(-1);
  assert.deepEqual({ antes: cambio.antes, despues: cambio.despues }, { antes: [], despues: ['elena.soporte@gmail.com', '@miagencia.com'] });
  // y el servidor lo aplica al confirmar
  const { account } = await club.crearConexionNueva({ name: 'Cliente L', locationId: 'locGuardaL01' }, pg);
  for (const v of ['elena.soporte@gmail.com', 'ana@miagencia.com', 'ana@eu.miagencia.com']) {
    r = await put(a, account.id, { club_email: v });
    assert.equal(r.statusCode, 400, v);
    assert.match(r.json().error, /es de soporte o de la agencia/);
  }
  r = await put(a, account.id, { club_email: 'ana@otramiagencia.com' });
  assert.equal(r.statusCode, 200, 'un dominio que solo acaba igual no cuenta');
});

test('2 · si se añade a la lista un correo que YA es el correo del Club de una conexión, Configuración lo avisa (en_uso) y esa ficha se sigue guardando', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Antes staff', locationId: 'locGuardaE01' }, pg);
  assert.equal((await put(a, account.id, { club_email: 'nuevo.staff@x.com' })).statusCode, 200);
  const r = await putLista(a, 'elena.soporte@gmail.com\n@miagencia.com\nnuevo.staff@x.com');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().en_uso, [{ id: account.id, nombre: 'Antes staff', club_email: 'nuevo.staff@x.com' }]);
  // la ficha con el MISMO club_email se guarda (no cambia: no se vuelve a comprobar); cambiarlo a uno bueno, también
  let p = await put(a, account.id, { club_email: 'nuevo.staff@x.com', alias: 'Renombrada' });
  assert.equal(p.statusCode, 200);
  assert.equal((await cuenta('locGuardaE01')).alias, 'Renombrada');
  p = await put(a, account.id, { club_email: 'comprador.e@x.com' });
  assert.equal(p.statusCode, 200);
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/settings/club-correos', headers: { 'x-rol': 'admin' } })).json().en_uso, []);
});

test('2 · pistas «Usar» de la ficha: nunca ofrecen el correo de soporte ni el de un admin; sí el del comprador; y los pendientes de soporte salen como no confirmables', async () => {
  await pg.query(`INSERT INTO users (username, password_hash, role) VALUES ('jefa@agencia.com', 'x', 'admin') ON CONFLICT (username) DO NOTHING`);
  const a = await app();
  infoGhl.set('locGuardaU01', { ok: true, name: 'Cliente U', email: 'Comprador.U@x.com' });
  assert.equal((await sso(a, SOPORTE, 'locGuardaU01')).statusCode, 200); // soporte abre Hermes primero: responsable
  const acc = await cuenta('locGuardaU01');
  assert.equal(acc.owner_email, SOPORTE);
  await club.aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba' }, pg);
  let f = await ficha(a, acc.id);
  assert.deepEqual(f.club_pistas, [
    { de: 'responsable', email: SOPORTE, usable: false, motivo: 'es de soporte o de la agencia (Configuración → «Correo del Club»): no se puede usar como correo del Club' },
    { de: 'correo_subcuenta', email: 'comprador.u@x.com', usable: true },
  ]);
  const prueba = f.club_pendientes.find((p) => p.email === SOPORTE);
  assert.equal(prueba.confirmable, false);
  assert.match(prueba.no_confirmable, /es de soporte o de la agencia/);
  // la ficha del cliente no recibe ni las pistas ni los pendientes
  const delCliente = (await a.inject({ method: 'GET', url: `/api/accounts/${acc.id}`, headers: { 'x-rol': String(acc.id) } })).json();
  assert.equal('club_pistas' in delCliente, false);
  assert.equal('club_pendientes' in delCliente, false);
  // al confirmar la pista buena queda «confirmada» (sin «Usar»)
  assert.equal((await put(a, acc.id, { club_email: 'comprador.u@x.com' })).statusCode, 200);
  f = await ficha(a, acc.id);
  assert.deepEqual(f.club_pistas[1], { de: 'correo_subcuenta', email: 'comprador.u@x.com', usable: false, confirmado: true });
  // un admin de Hermes de responsable tampoco se ofrece
  const { account: otra } = await club.crearConexionNueva({ name: 'Cliente U2', locationId: 'locGuardaU02' }, pg);
  await pg.query(`UPDATE accounts SET owner_email = 'jefa@agencia.com' WHERE id = $1`, [otra.id]);
  f = await ficha(a, otra.id);
  assert.equal(f.club_pistas[0].usable, false);
  assert.match(f.club_pistas[0].motivo, /^es de un administrador de Hermes/);
  // sin la lista (no se pudo leer) no se ofrece ninguna
  assert.deepEqual(club.pistasParaFicha({ owner_email: 'comprador@x.com' }, null).map((p) => p.usable), [false]);
});

test('2 · motivoNoClub, sanearNoClub y validarNoClub (unidad)', () => {
  const n = { fijos: [...club.CORREOS_SOPORTE], no_club: ['elena@gmail.com', '@miagencia.com'], admins: ['jefa@agencia.com'] };
  assert.match(club.motivoNoClub(SOPORTE_JA, n), /soporte o de la agencia/);
  assert.match(club.motivoNoClub('jefa@agencia.com', n), /administrador de Hermes/);
  assert.match(club.motivoNoClub('elena@gmail.com', n, { corto: true }), /no se puede usar como correo del Club$/);
  assert.ok(club.motivoNoClub('x@miagencia.com', n));
  assert.ok(club.motivoNoClub('x@a.b.miagencia.com', n));
  assert.equal(club.motivoNoClub('x@otramiagencia.com', n), null);
  assert.equal(club.motivoNoClub('comprador@x.com', n), null);
  assert.deepEqual(club.sanearNoClub(['A@B.com', 'a@b.com', 'basura', '@X.com', SOPORTE, 42, 'c@d.com\u{200B}']), ['a@b.com', '@x.com']);
  assert.deepEqual(club.sanearNoClub(null), []);
  assert.equal(club.validarNoClub(42).ok, false);
  assert.equal(club.validarNoClub([42]).ok, false);
  assert.deepEqual(club.validarNoClub(['  ', 'A@B.com']), { ok: true, valor: ['a@b.com'] });
  assert.deepEqual(club.validarNoClub(''), { ok: true, valor: [] }, 'vaciarla se puede: los de soporte y los admins cuentan siempre');
  assert.equal(club.validarNoClub(Array.from({ length: 201 }, (_, i) => `u${i}@x.com`)).ok, false);
});

test('panel: «Usar» sale de club_pistas (lo que el servidor deja guardar), la ficha no manda club_pistas y Configuración tiene la lista', async () => {
  const src = fs.readFileSync(new URL('../web/src/pages/AccountEdit.jsx', import.meta.url), 'utf8');
  assert.match(src, /acc\.club_pistas/);
  assert.doesNotMatch(src, /set\(\{ club_email: acc\.(owner_email|ghl_location_email) \}\)/, 'antes: «Usar» copiaba el correo sin comprobar nada');
  const { SOLO_LECTURA } = await import('../web/src/cambios.js');
  assert.ok(SOLO_LECTURA.includes('club_pistas'));
  assert.match(fs.readFileSync(new URL('../web/src/pages/Settings.jsx', import.meta.url), 'utf8'), /<CorreosClub \/>/);
  assert.match(fs.readFileSync(new URL('../web/src/components/CorreosClub.jsx', import.meta.url), 'utf8'), /\/api\/settings\/club-correos/);
  assert.match(src, /p\?\.usable && !yaPuesto && p\.aviso/, 'repaso C3: el aviso de las pistas con tilde se enseña junto a «Usar»');
});

// ── 3 · repaso de la C3 (hallazgos del verificador independiente) ────────────────────────────────────────────────────

test('3 · letras de otros alfabetos, puntos mal puestos y signos que un correo no admite: se rechazan y se dice cuál; las letras con tilde valen', () => {
  const malos = [
    ['\u{455}oporte@departamentodisruptivo.com', 'alfabeto', 'una letra cirílica («\u{455}», U+0455)'],
    ['\u{FF53}oporte@departamentodisruptivo.com', 'alfabeto', 'de ancho completo («\u{FF53}», U+FF53)'],
    ['soporte@departamentod\u{130}sruptivo.com', 'alfabeto', 'U+0130, I turca con punto'],
    ['soporte@departamentod\u{131}sruptivo.com', 'alfabeto', 'U+0131, i turca sin punto'],
    ['p\u{3BF}pe@x.com', 'alfabeto', 'una letra griega'],
    ['ana\u{2013}x@x.com', 'alfabeto', 'U+2013, guion largo'],
    ['ana\u{FF11}@x.com', 'alfabeto', 'U+FF11'],
    ['stra\u{DF}e@x.com', 'alfabeto', 'U+00DF'],
    ['q\u{307}@x.com', 'alfabeto', 'un acento o signo suelto (U+0307)'],
    ['ana@x.com.', 'punto', 'acaba en punto'],
    ['soporte@departamentodisruptivo.com.', 'punto', 'acaba en punto'],
    ['.ana@x.com', 'punto', 'empieza por punto'],
    ['ana.@x.com', 'punto', 'justo antes de la @'],
    ['ana@.x.com', 'punto', 'justo después de la @'],
    ['ana..b@x.com', 'punto', 'dos puntos seguidos'],
    ['ana@x..com', 'punto', 'dos puntos seguidos'],
    ['soporte(x)@departamentodisruptivo.com', 'signo', '«(»'],
    ['ana,b@x.com', 'signo', '«,»'],
    ['ana@-x.com', 'formato', 'no tiene forma de correo'],
    ['ana@x_y.com', 'formato', 'no tiene forma de correo'],
    ['ana@10.0.0.10', 'formato', 'no tiene forma de correo'],
  ];
  for (const [v, tipo, trozo] of malos) {
    const a = club.analizarCorreo(v);
    assert.equal(a.correo, '', JSON.stringify(v));
    assert.equal(a.tipo, tipo, `${JSON.stringify(v)} → ${a.tipo}`);
    assert.ok(a.motivo.includes(trozo), `${JSON.stringify(v)} → ${a.motivo}`);
    const s = club.sanearClubEmail(v);
    assert.equal(s.ok, false, JSON.stringify(v));
    if (tipo !== 'formato') assert.ok(s.error.startsWith(`El correo del Club ${a.motivo}. `), s.error);
  }
  for (const [v, bueno] of [['José@X.com', 'josé@x.com'], ['ÑANDÚ@Correo.es', 'ñandú@correo.es'], ['pepe@españa.es', 'pepe@españa.es'],
    ['a.b+c@x-y.co', 'a.b+c@x-y.co'], ['ana@xn--espaa-rta.es', 'ana@xn--espaa-rta.es'], ['o.k@sub.dominio.com.es', 'o.k@sub.dominio.com.es']]) {
    assert.equal(club.analizarCorreo(v).correo, bueno, v);
  }
});

test('3 · soporte «escrito de cualquier forma» (ataque G4): +etiqueta, punto final, otro alfabeto y signos → 400; el subdominio solo con «@dominio» en la lista', async () => {
  const a = await app();
  const antes = (await club.leerCorreosNoClub(pg)).no_club;
  const { account } = await club.crearConexionNueva({ name: 'Cliente G4', locationId: 'locRepasoG401' }, pg);
  for (const [v, trozo] of [
    ['soporte+prueba@departamentodisruptivo.com', 'es de soporte o de la agencia'],
    ['Soporte+Club@SoyJonathanAlef.com', 'es de soporte o de la agencia'],
    ['soporte@departamentodisruptivo.com.', 'acaba en punto'],
    ['\u{455}oporte@departamentodisruptivo.com', 'letra cirílica'],
    ['\u{FF53}oporte@departamentodisruptivo.com', 'ancho completo'],
    ['soporte@departamentod\u{130}sruptivo.com', 'I turca con punto'],
    ['soporte(x)@departamentodisruptivo.com', 'no admite'],
  ]) {
    const r = await put(a, account.id, { club_email: v });
    assert.equal(r.statusCode, 400, `${JSON.stringify(v)} → ${r.body}`);
    assert.ok(r.json().error.includes(trozo), r.json().error);
  }
  assert.equal((await cuenta('locRepasoG401')).club_email, null);
  // LÍMITE (decide la persona): un subdominio no es «soporte@» … hasta que se añade «@departamentodisruptivo.com»
  const sub = 'soporte@mail.departamentodisruptivo.com';
  const { account: otra } = await club.crearConexionNueva({ name: 'Cliente G4b', locationId: 'locRepasoG402' }, pg);
  assert.equal(club.motivoNoClub(sub, await club.leerCorreosNoClub(pg)), null);
  assert.equal((await putLista(a, [...antes, '@departamentodisruptivo.com'])).statusCode, 200);
  let r = await put(a, otra.id, { club_email: sub });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /es de soporte o de la agencia/);
  r = await put(a, otra.id, { club_email: 'equipo+club@departamentodisruptivo.com' });
  assert.equal(r.statusCode, 400, 'con el dominio en la lista, todo el dominio');
  // la lista también compara por buzón: un Gmail con puntos y +etiqueta es el mismo buzón
  assert.equal((await putLista(a, [...antes, 'elena.soporte@gmail.com'])).statusCode, 200);
  r = await put(a, otra.id, { club_email: 'E.lena.Soporte+club@googlemail.com' });
  assert.equal(r.statusCode, 400);
  r = await put(a, otra.id, { club_email: 'jefa+club@agencia.com' });
  assert.equal(r.statusCode, 400, 'el admin jefa@agencia.com con +etiqueta');
  assert.match(r.json().error, /administrador de Hermes/);
  r = await put(a, otra.id, { club_email: 'jefa.x@agencia.com' });
  assert.equal(r.statusCode, 200, 'fuera de Gmail los puntos sí cuentan: otro buzón');
  // un «@dominio.» con punto final no se acepta en la lista (antes se guardaba y no bloqueaba nada)
  r = await putLista(a, '@miagencia.com.');
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, '«@miagencia.com.» no es un correo ni un dominio (@dominio.com): acaba en punto.');
  assert.equal((await putLista(a, antes)).statusCode, 200);
});

test('3 · un BOM o un espacio duro solos ya no QUITAN el correo del Club confirmado: 400 y se queda como estaba', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Cliente BOM', locationId: 'locRepasoB01' }, pg);
  assert.equal((await put(a, account.id, { club_email: 'comprador.bom@x.com' })).statusCode, 200);
  for (const [v, trozo] of [['\u{FEFF}', 'U+FEFF, marca BOM'], [' \u{A0} ', 'U+00A0, espacio duro']]) {
    const r = await put(a, account.id, { club_email: v });
    assert.equal(r.statusCode, 400, JSON.stringify(v));
    assert.ok(r.json().error.includes(trozo), r.json().error);
    assert.equal((await cuenta('locRepasoB01')).club_email, 'comprador.bom@x.com', 'antes: 200 y club_email quedaba vacío');
  }
  assert.equal((await put(a, account.id, { club_email: '  ' })).statusCode, 200, 'vaciarlo de verdad se puede');
  assert.equal((await cuenta('locRepasoB01')).club_email, null);
});

test('3 · «Usar» no ofrece el correo del Club de OTRA conexión (antes salía y daba 409), ni uno con letras de otro alfabeto; con tilde, avisa', async () => {
  const a = await app();
  const { account: duena } = await club.crearConexionNueva({ name: 'La de verdad', locationId: 'locRepasoU01' }, pg);
  assert.equal((await put(a, duena.id, { club_email: 'ocupado.u@x.com' })).statusCode, 200);
  const { account } = await club.crearConexionNueva({ name: 'Otra', locationId: 'locRepasoU02' }, pg);
  await pg.query(`UPDATE accounts SET owner_email = 'Ocupado.U@x.com', ghl_location_email = 'josé.u@x.com' WHERE id = $1`, [account.id]);
  // un pendiente viejo para ese correo (no se pudo aplicar): tampoco se puede confirmar aquí
  await pg.query(`INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ('email:ocupado.u@x.com', false, 'baja', now())`);
  let f = await ficha(a, account.id);
  const [resp, sub] = f.club_pistas;
  assert.equal(resp.usable, false);
  assert.equal(resp.motivo, `ya es el correo del Club de la conexión #${duena.id} (La de verdad): quítalo de allí primero si de verdad es de este cliente`);
  const r = await put(a, account.id, { club_email: resp.email });
  assert.equal(r.statusCode, 409, 'lo que la ficha no ofrece es justo lo que el servidor rechaza');
  assert.deepEqual(sub, { de: 'correo_subcuenta', email: 'josé.u@x.com', usable: true, aviso: 'lleva letras con tilde, ñ o ç: compruébalo letra a letra con el de la compra en 4ttZ' });
  const p = f.club_pendientes.find((x) => x.email === 'ocupado.u@x.com');
  assert.equal(p.confirmable, false);
  assert.match(p.no_confirmable, new RegExp(`^ya es el correo del Club de la conexión #${duena.id} `));
  // letras de otro alfabeto en una pista: no se ofrece y se dice cuál
  await pg.query(`UPDATE accounts SET owner_email = '\u{455}oporte@departamentodisruptivo.com' WHERE id = $1`, [account.id]);
  f = await ficha(a, account.id);
  assert.equal(f.club_pistas[0].usable, false);
  assert.match(f.club_pistas[0].motivo, /^no sirve como correo del Club: lleva una letra cirílica \(«\u{455}», U\+0455\)/u);
  // sin poder mirar las otras conexiones (null) no se ofrece ninguna
  assert.deepEqual(club.pistasParaFicha({ id: 1, owner_email: 'comprador@x.com' }, { fijos: [], no_club: [], admins: [] }, null).map((x) => x.usable), [false]);
  await pg.query(`DELETE FROM club_estado_pendiente WHERE clave = 'email:ocupado.u@x.com'`);
});

test('3 · interruptor: los 400 quedan en club_eventos («rechazado») con lo recibido visible; una lista no pasa por texto; con location_id válido se aplica por la subcuenta', async () => {
  const a = await app();
  const rechazados = async () => filas(`SELECT location_id, email, activo, motivo, detalle, ip FROM club_eventos WHERE resultado = 'rechazado' ORDER BY id`);
  const n0 = (await rechazados()).length;
  let r = await estado(a, { email: 'v5r@x.com\u{200B}', activo: false, motivo: 'baja' });
  assert.equal(r.statusCode, 400);
  let ev = (await rechazados()).at(-1);
  assert.equal(ev.email, null);
  assert.equal(ev.activo, false);
  assert.equal(ev.motivo, 'baja');
  assert.equal(ev.detalle.recibido.email, 'v5r@x.com<U+200B>');
  assert.match(ev.detalle.error, /^email no válido: lleva un carácter invisible \(U\+200B/);
  assert.ok((await eventos('club_estado_rechazado')).some((e) => e.recibido?.email === 'v5r@x.com<U+200B>'));
  // listas: antes String(['ana@x.com']) era 'ana@x.com' y String(['true']) era 'true'
  r = await estado(a, { email: ['v5r@x.com'], activo: false });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'email no válido: tiene que ser texto');
  assert.equal((await rechazados()).at(-1).detalle.recibido.email, '(lista)');
  r = await estado(a, { email: 'v5r@x.com', activo: ['true'] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'activo debe ser true o false');
  ev = (await rechazados()).at(-1);
  assert.equal(ev.email, 'v5r@x.com', 'el correo bueno sí se anota');
  assert.equal(ev.detalle.recibido.activo, '(lista)');
  r = await estado(a, { location_id: ['locRepasoI01'], activo: true });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'location_id no válido: tiene que ser texto');
  assert.equal((await rechazados()).length, n0 + 4);
  // con el secreto MALO no se anota nada (solo cuentan las llamadas de GHL)
  r = await a.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': 'otro'.repeat(10) }, payload: { email: 'x\u{200B}@x.com', activo: false } });
  assert.equal(r.statusCode, 401);
  assert.equal((await rechazados()).length, n0 + 4);
  // CON location_id válido, un correo que no vale ya no tumba la orden: se aplica por la subcuenta y se avisa
  const { account } = await club.crearConexionNueva({ name: 'Por subcuenta', locationId: 'locRepasoI02' }, pg);
  r = await estado(a, { location_id: 'locRepasoI02', email: 'cliente.i@x.com\u{200B}', activo: false, motivo: 'impago' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().resultado, 'aplicado');
  assert.equal(r.json().aviso, 'email no válido: lleva un carácter invisible (U+200B, espacio de ancho cero). Se ha usado solo la subcuenta (location_id); ese correo no se ha guardado.');
  assert.equal((await cuenta('locRepasoI02')).ai_enabled, false, 'antes: 400 y la IA seguía encendida tras el impago');
  ev = (await filas(`SELECT email, resultado, cuentas, detalle FROM club_eventos WHERE location_id = 'locRepasoI02' ORDER BY id`)).at(-1);
  assert.equal(ev.email, null);
  assert.deepEqual(ev.cuentas, [account.id]);
  assert.match(ev.detalle.email_descartado, /^email no válido: lleva un carácter invisible/);
  r = await estado(a, { location_id: 'locRepasoI02', email: ['cliente.i@x.com'], activo: true });
  assert.equal(r.statusCode, 200);
  assert.match(r.json().aviso, /^email no válido: tiene que ser texto\. /);
});

test('3 · devoluciones: un correo que llega como lista no se lee como correo (aviso y, sin contact_id, 400)', () => {
  let v = validarCuerpoDevolucion({ email: ['kdevo@x.com'], contact_id: 'contRepaso01', producto: 'cuenta', motivo: 'x' });
  assert.equal(v.ok, true);
  assert.equal(v.datos.email, '');
  assert.ok(v.datos.avisos.includes('email no válido: tiene que ser texto'));
  v = validarCuerpoDevolucion({ email: ['kdevo@x.com'], producto: 'cuenta' });
  assert.equal(v.ok, false);
});

test('3 · si la base rechaza el correo del Club por su CHECK (23514), la ficha da un 400 claro y no un 500', async () => {
  const a = await app();
  const { account } = await club.crearConexionNueva({ name: 'Cliente CHECK', locationId: 'locRepasoC01' }, pg);
  // una restricción de prueba con «club_email» en el nombre (en PGlite no hay valor que pase la app y no la 061)
  await pg.exec(`ALTER TABLE accounts ADD CONSTRAINT accounts_club_email_prueba_23514 CHECK (club_email IS NULL OR club_email NOT LIKE 'prueba23514%')`);
  try {
    const r = await put(a, account.id, { club_email: 'prueba23514@x.com' });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, 'El correo del Club no es válido: escríbelo a mano y vuelve a guardar.');
    assert.equal((await cuenta('locRepasoC01')).club_email, null);
  } finally {
    await pg.exec(`ALTER TABLE accounts DROP CONSTRAINT accounts_club_email_prueba_23514`);
  }
});
