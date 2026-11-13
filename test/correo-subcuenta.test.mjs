// Fase C · 4) correo del Club de una conexión: el que CONFIRMA soporte (club_email) y, como pista, el de la subcuenta en
// GHL (se lee al crear y en cada reconexión por OAuth). Rutas REALES (OAuth, SSO de la Custom Page, ficha de la conexión)
// sobre Postgres real en memoria (PGlite) con las migraciones de verdad; GHL, Redis y el pipeline se sustituyen por dobles.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { baseDePruebas } from './_pglite.mjs';

// Base: una conexión ANTERIOR al Club (DEP, Rodrigo, Lorena…) creada antes de la 059; el resto se crea después.
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
  },
});
mock.module(u('../src/services/marketplace.js'), { namedExports: { cerrarLotesConsumo: async () => ({ ok: true }) } });

// GHL falso: lo que devuelve GET /locations/{id} por subcuenta, y cuántas veces se ha pedido (y con qué opciones)
const infoGhl = new Map();
const llamadasInfo = [];
const opcionesInfo = [];
const codigos = new Map(); // code de OAuth → locationId
mock.module(u('../src/services/ghl.js'), {
  namedExports: {
    exchangeCodeForLocation: async (code, conocida) => ({ locationId: codigos.get(code) || conocida, access_token: 'at', refresh_token: 'rt' }),
    saveTokens: async (tok) => {
      await pg.query(`INSERT INTO ghl_tokens (location_id, access_token, refresh_token, expires_at) VALUES ($1, 'at', 'rt', now() + interval '1 day')
                      ON CONFLICT (location_id) DO NOTHING`, [tok.locationId]);
      return tok.locationId;
    },
    getLocationInfo: async (_account, locationId, opts) => {
      llamadasInfo.push(locationId);
      opcionesInfo.push(opts ?? null);
      return infoGhl.get(locationId) || { ok: true, name: `Subcuenta ${locationId}`, email: '' };
    },
    getLocationName: async (_account, locationId) => { llamadasInfo.push(locationId); return (infoGhl.get(locationId) || {}).name || ''; },
    listLocationUsers: async () => [],
    listCalendars: async () => [],
    getContact: async () => ({}),
    listWhatsappTemplates: async () => ({ templates: [] }),
  },
});

const { authHook } = await import('../src/lib/session.js');
const portalRoutes = (await import('../src/routes/portal.js')).default;
const ghlOauthRoutes = (await import('../src/routes/ghlOauth.js')).default;
const accountRoutes = (await import('../src/routes/accounts.js')).default;
const authRoutes = (await import('../src/routes/auth.js')).default;
const { aplicarEstadoClub, crearConexionNueva } = await import('../src/services/club.js');

const SOPORTE = 'soporte@departamentodisruptivo.com';
const cuenta = async (loc) => (await filas(`SELECT * FROM accounts WHERE location_id = $1`, [loc]))[0];
const eventos = async (kind) => (await filas(`SELECT payload FROM webhook_log WHERE kind = $1 ORDER BY id`, [kind])).map((r) => r.payload);

// app con las rutas reales; «x-rol: admin» o «x-rol: <id de cuenta>» hace de sesión (sin cabecera: authHook real)
async function app({ conAuthHook = false } = {}) {
  const a = Fastify();
  await a.register(fastifyCookie);
  if (conAuthHook) a.addHook('onRequest', authHook());
  else {
    a.addHook('onRequest', async (req) => {
      const rol = req.headers['x-rol'];
      if (rol === 'admin') { req.auth = { role: 'admin', userId: 1 }; req.userId = 1; } else if (rol) req.auth = { role: 'user', accountId: Number(rol), portal: true };
    });
  }
  a.get('/api/health', async () => ({ ok: true }));
  await a.register(authRoutes);
  await a.register(portalRoutes);
  await a.register(ghlOauthRoutes);
  await a.register(accountRoutes);
  return a;
}

// cifrado igual que GHL (CryptoJS AES.encrypt con passphrase → «Salted__» + EVP_BytesToKey MD5)
function cifrarSso(obj, secreto) {
  const salt = crypto.randomBytes(8);
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < 48) { prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(secreto), salt])).digest(); d = Buffer.concat([d, prev]); }
  const c = crypto.createCipheriv('aes-256-cbc', d.subarray(0, 32), d.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
}

test('OAuth de una subcuenta NUEVA: crea la conexión del Club y guarda el correo de la subcuenta como PISTA; la baja que esperaba se aplica al CONFIRMAR', async () => {
  const a = await app();
  await aplicarEstadoClub({ email: 'comprador@x.com', activo: false, motivo: 'baja antes de instalar' }, pg); // 202 pendiente
  codigos.set('c1', 'locOAuth0001');
  infoGhl.set('locOAuth0001', { ok: true, name: 'Empresa del comprador', email: 'Comprador@X.com' });
  llamadasInfo.length = 0;
  const r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c1' });
  assert.equal(r.statusCode, 302);
  const acc = await cuenta('locOAuth0001');
  assert.match(r.headers.location, new RegExp(`^/cuentas/${acc.id}\\?conectada=1$`));
  assert.equal(acc.name, 'Empresa del comprador');
  assert.equal(acc.ghl_location_email, 'comprador@x.com');
  assert.ok(acc.ghl_location_email_at);
  assert.equal(acc.ai_enabled, true, 'el correo de la subcuenta no enlaza: la baja sigue esperando');
  assert.equal(acc.test_mode, true, 'nace en modo prueba como siempre');
  assert.deepEqual(llamadasInfo, ['locOAuth0001'], 'una sola llamada a GHL para el nombre y el correo');
  assert.equal((await filas(`SELECT count(*)::int AS n FROM club_estado_pendiente WHERE clave = 'email:comprador@x.com'`))[0].n, 1);
  // la ficha (admin) enseña ese pendiente a soporte, y al confirmar el correo del Club se aplica
  const ficha = (await a.inject({ method: 'GET', url: `/api/accounts/${acc.id}`, headers: { 'x-rol': 'admin' } })).json();
  assert.deepEqual(ficha.club_pendientes.map((x) => [x.email, x.de, x.activo]), [['comprador@x.com', ['correo_subcuenta'], false]]);
  const put = await a.inject({ method: 'PUT', url: `/api/accounts/${acc.id}`, headers: { 'x-rol': 'admin' }, payload: { club_email: 'comprador@x.com' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await cuenta('locOAuth0001')).ai_enabled, false);
  assert.equal((await filas(`SELECT count(*)::int AS n FROM club_estado_pendiente WHERE clave = 'email:comprador@x.com'`))[0].n, 0);
  const ficha2 = (await a.inject({ method: 'GET', url: `/api/accounts/${acc.id}`, headers: { 'x-rol': 'admin' } })).json();
  assert.deepEqual(ficha2.club_pendientes, []);
});

test('A6 · OAuth de una conexión del Club que ya existía: lo lee y lo guarda; en cada reconexión vuelve a preguntar (10 s como máximo) y, si GHL tiene otro, NO lo pisa y lo anota', async () => {
  const a = await app();
  const { account } = await crearConexionNueva({ name: 'Creada antes', locationId: 'locReco00001' }, pg);
  infoGhl.set('locReco00001', { ok: true, name: 'X', email: 'reco@x.com' });
  codigos.set('c2', 'locReco00001');
  llamadasInfo.length = 0; opcionesInfo.length = 0;
  let r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c2' });
  assert.equal(r.statusCode, 302);
  assert.equal((await cuenta('locReco00001')).ghl_location_email, 'reco@x.com');
  assert.deepEqual(llamadasInfo, ['locReco00001']);
  assert.deepEqual(opcionesInfo, [{ timeoutMs: 10_000 }], 'con tope corto: no retrasa la vuelta de OAuth');
  // la misma: se pregunta y no se anota nada
  llamadasInfo.length = 0;
  r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c2' });
  assert.deepEqual(llamadasInfo, ['locReco00001']);
  assert.equal((await eventos('club_correo_subcuenta_distinto')).filter((e) => e.account === account.id).length, 0);
  // el cliente lo cambia en GHL y se reconecta: se pregunta, NO se pisa y queda anotado para soporte (antes: 0 eventos)
  infoGhl.set('locReco00001', { ok: true, name: 'X', email: 'cambiado@x.com' });
  llamadasInfo.length = 0;
  r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c2' });
  assert.equal(r.statusCode, 302);
  assert.deepEqual(llamadasInfo, ['locReco00001']);
  assert.equal((await cuenta('locReco00001')).ghl_location_email, 'reco@x.com');
  assert.equal((await cuenta('locReco00001')).id, account.id);
  const dist = (await eventos('club_correo_subcuenta_distinto')).filter((e) => e.account === account.id);
  assert.equal(dist.length, 1);
  assert.deepEqual({ guardado: dist[0].guardado, en_ghl: dist[0].en_ghl, origen: dist[0].origen }, { guardado: 'reco@x.com', en_ghl: 'cambiado@x.com', origen: 'oauth' });
  // también desde el enlace de agencia (selfserve) se vuelve a leer
  almacen.set('oauthstate:n2b', 'selfserve:clave:locReco00001');
  llamadasInfo.length = 0;
  r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c2&state=n2b' });
  assert.equal(r.statusCode, 302);
  assert.deepEqual(llamadasInfo, ['locReco00001']);
  assert.equal((await eventos('club_correo_subcuenta_distinto')).filter((e) => e.account === account.id).length, 2);
});

test('OAuth de una conexión ANTERIOR al Club (DEP, Rodrigo, Lorena…): ni se pregunta el correo ni se guarda nada', async () => {
  const a = await app();
  codigos.set('c3', 'locAntigua01');
  infoGhl.set('locAntigua01', { ok: true, name: 'DEP', email: 'info@dep.com' });
  llamadasInfo.length = 0;
  const r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c3' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/cuentas/1?conectada=1');
  assert.deepEqual(llamadasInfo, []);
  const acc = await cuenta('locAntigua01');
  assert.equal(acc.ghl_location_email, null);
  assert.equal(acc.ai_enabled, true);
  assert.equal(acc.name, 'DEP');
});

test('OAuth sin permiso para leer la subcuenta (GHL 401/403): la conexión se crea igual y queda anotado', async () => {
  const a = await app();
  codigos.set('c4', 'locSinPerm01');
  infoGhl.set('locSinPerm01', { ok: false, status: 401, error: 'The token is not authorized for this scope.' });
  const r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c4' });
  assert.equal(r.statusCode, 302);
  const acc = await cuenta('locSinPerm01');
  assert.ok(acc, 'la conexión existe');
  assert.equal(acc.name, 'Subcuenta locSin', 'sin permiso tampoco hay nombre: el de siempre');
  assert.equal(acc.ghl_location_email, null);
  const ev = (await eventos('club_correo_subcuenta_error')).find((e) => e.account === acc.id);
  assert.ok(ev, 'anotado en el registro de eventos');
  assert.equal(ev.sin_permiso, true);
  assert.equal(ev.http, 401);
  // y una subcuenta cuyo correo en GHL está vacío: se anota y no se guarda nada
  codigos.set('c4b', 'locVacio0001');
  infoGhl.set('locVacio0001', { ok: true, name: 'Vacía', email: '' });
  assert.equal((await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c4b' })).statusCode, 302);
  const vacia = await cuenta('locVacio0001');
  assert.equal(vacia.ghl_location_email, null);
  assert.ok((await eventos('club_correo_subcuenta_vacio')).some((e) => e.account === vacia.id));
});

test('OAuth lanzado desde la ficha (state con la cuenta) y desde el enlace de agencia: también lee el correo', async () => {
  const a = await app();
  // ficha: el admin creó la conexión a mano (POST /api/accounts) y pulsa «Conectar subcuenta de GHL»
  const creada = await a.inject({ method: 'POST', url: '/api/accounts', headers: { 'x-rol': 'admin' }, payload: { name: 'A mano' } });
  assert.equal(creada.statusCode, 200);
  const id = creada.json().id;
  almacen.set('oauthstate:n5', String(id));
  codigos.set('c5', 'locFicha0001');
  infoGhl.set('locFicha0001', { ok: true, name: 'Ficha', email: 'ficha@x.com' });
  let r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c5&state=n5' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, `/cuentas/${id}?conectada=1`);
  assert.equal((await cuenta('locFicha0001')).ghl_location_email, 'ficha@x.com');
  // enlace de agencia (selfserve): la vuelta pasa por /ghl-app, que crea la conexión
  almacen.set('oauthstate:n6', 'selfserve:clave:locAgen00001');
  codigos.set('c6', 'locAgen00001');
  infoGhl.set('locAgen00001', { ok: true, name: 'Agencia link', email: 'agen@x.com' });
  r = await a.inject({ method: 'GET', url: '/api/oauth/callback?code=c6&state=n6' });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, /^\/ghl-app\?entry=/);
  r = await a.inject({ method: 'GET', url: r.headers.location });
  assert.equal(r.statusCode, 302);
  assert.equal((await cuenta('locAgen00001')).ghl_location_email, 'agen@x.com');
});

test('cambiar la conexión de subcuenta olvida el correo de la anterior (OAuth desde la ficha y PUT del admin)', async () => {
  const a = await app();
  const id = (await a.inject({ method: 'POST', url: '/api/accounts', headers: { 'x-rol': 'admin' }, payload: { name: 'Se mueve' } })).json().id;
  almacen.set('oauthstate:r1', String(id));
  codigos.set('r1', 'locMueve0001');
  infoGhl.set('locMueve0001', { ok: true, name: 'Uno', email: 'uno@x.com' });
  await a.inject({ method: 'GET', url: '/api/oauth/callback?code=r1&state=r1' });
  assert.equal((await filas(`SELECT ghl_location_email FROM accounts WHERE id = $1`, [id]))[0].ghl_location_email, 'uno@x.com');
  almacen.set('oauthstate:r2', String(id));
  codigos.set('r2', 'locMueve0002');
  infoGhl.set('locMueve0002', { ok: true, name: 'Dos', email: 'dos@x.com' });
  await a.inject({ method: 'GET', url: '/api/oauth/callback?code=r2&state=r2' });
  let f = (await filas(`SELECT location_id, ghl_location_email FROM accounts WHERE id = $1`, [id]))[0];
  assert.deepEqual(f, { location_id: 'locMueve0002', ghl_location_email: 'dos@x.com' }, 'el de la subcuenta nueva');
  // el admin cambia el location_id a mano: se olvida (se leerá al reconectar); guardar la ficha sin cambiarlo no lo toca
  let r = await a.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { 'x-rol': 'admin' }, payload: { location_id: 'locMueve0002', name: 'Se mueve' } });
  assert.equal(r.statusCode, 200);
  assert.equal((await filas(`SELECT ghl_location_email FROM accounts WHERE id = $1`, [id]))[0].ghl_location_email, 'dos@x.com');
  r = await a.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { 'x-rol': 'admin' }, payload: { location_id: 'locMueve0003' } });
  assert.equal(r.statusCode, 200);
  f = (await filas(`SELECT location_id, ghl_location_email, ghl_location_email_at FROM accounts WHERE id = $1`, [id]))[0];
  assert.deepEqual(f, { location_id: 'locMueve0003', ghl_location_email: null, ghl_location_email_at: null });
});

test('SSO en una subcuenta SIN la app instalada (sin token) o con un correo raro en GHL: entra igual y se anota bien', async () => {
  const a = await app();
  await pg.query(`INSERT INTO settings (key, value) VALUES ('ghl_app', '{"sso_secret":"secreto-sso-de-prueba"}'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  infoGhl.set('locSinTok001', { ok: false, status: 401, error: 'la subcuenta locSinTok001 no está conectada por OAuth', sin_token: true });
  let r = await a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted: cifrarSso({ email: 'c@x.com', activeLocation: 'locSinTok001' }, 'secreto-sso-de-prueba') } });
  assert.equal(r.statusCode, 200);
  const sinTok = await cuenta('locSinTok001');
  const ev = (await eventos('club_correo_subcuenta_error')).find((e) => e.account === sinTok.id);
  assert.equal(ev.sin_token, true);
  assert.equal(ev.sin_permiso, undefined, 'no es un problema de permiso: la app aún no está instalada');
  assert.match(ev.nota, /se leerá al instalarla/);
  infoGhl.set('locRaro00001', { ok: true, name: 'Raro', email: 'esto no es un correo' });
  r = await a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted: cifrarSso({ email: 'c2@x.com', activeLocation: 'locRaro00001' }, 'secreto-sso-de-prueba') } });
  assert.equal(r.statusCode, 200);
  const raro = await cuenta('locRaro00001');
  assert.equal(raro.ghl_location_email, null);
  assert.match((await eventos('club_correo_subcuenta_vacio')).find((e) => e.account === raro.id).nota, /no es válido/);
});

test('SSO de la Custom Page en una subcuenta sin conexión: la crea con soporte de responsable; el comprador NO se reconoce solo y al confirmar su correo del Club sí', async () => {
  const a = await app();
  await pg.query(`INSERT INTO settings (key, value) VALUES ('ghl_app', '{"sso_secret":"secreto-sso-de-prueba"}'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  infoGhl.set('locSSO000001', { ok: true, name: 'Cliente SSO', email: 'cliente.sso@x.com' });
  const encrypted = cifrarSso({ email: SOPORTE, activeLocation: 'locSSO000001', userName: 'Soporte DD' }, 'secreto-sso-de-prueba');
  const r = await a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted } });
  assert.equal(r.statusCode, 200, r.body);
  const acc = await cuenta('locSSO000001');
  assert.equal(acc.owner_email, SOPORTE, 'el primero que entra queda de responsable (como siempre)');
  assert.equal(acc.ghl_location_email, 'cliente.sso@x.com');
  // la baja del comprador (4ttZ solo manda su correo) espera a que soporte confirme el correo del Club
  let e = await aplicarEstadoClub({ email: 'cliente.sso@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(e.code, 202);
  assert.deepEqual(e.body.sin_confirmar, [acc.id]);
  // una prueba con el correo de soporte tampoco toca la conexión que soporte ha abierto (A4)
  e = await aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba' }, pg);
  assert.equal(e.code, 202);
  assert.equal((await cuenta('locSSO000001')).ai_enabled, true);
  const put = await a.inject({ method: 'PUT', url: `/api/accounts/${acc.id}`, headers: { 'x-rol': 'admin' }, payload: { club_email: 'Cliente.SSO@x.com' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await cuenta('locSSO000001')).ai_enabled, false, 'la baja del comprador se aplica al confirmar');
  e = await aplicarEstadoClub({ email: 'cliente.sso@x.com', activo: true, motivo: 'pago recuperado' }, pg);
  assert.equal(e.code, 200);
  assert.deepEqual(e.body.cuentas, [acc.id]);
});

test('ficha de la conexión: club_email solo lo pone el admin (valida, minúsculas, único, solo del Club) y aplica los pendientes', async () => {
  const a = await app();
  const { account: A } = await crearConexionNueva({ name: 'A', locationId: 'locFichaA001' }, pg);
  const { account: B } = await crearConexionNueva({ name: 'B', locationId: 'locFichaB001' }, pg);
  await pg.query(`UPDATE accounts SET owner_email = $2 WHERE id = $1`, [A.id, SOPORTE]);
  await aplicarEstadoClub({ email: 'compra@gmail.com', activo: false, motivo: 'baja' }, pg); // pendiente: nadie tiene ese correo
  const put = (id, body, rol = 'admin') => a.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { 'x-rol': rol }, payload: body });
  let r = await put(A.id, { club_email: 'no-es-un-correo' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /correo del Club/);
  assert.equal((await cuenta('locFichaA001')).club_email, null, 'nada a medias');
  r = await put(A.id, { club_email: ' Compra@Gmail.com ', name: 'A renombrada' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().club_email, 'compra@gmail.com');
  let fila = await cuenta('locFichaA001');
  assert.equal(fila.club_email, 'compra@gmail.com');
  assert.equal(fila.name, 'A renombrada');
  assert.equal(fila.ai_enabled, false, 'la baja que esperaba por ese correo se aplica al ponerlo');
  assert.equal(r.json().ai_enabled, false, 'y la respuesta ya lo refleja');
  const cambio = (await eventos('club_email_cambiado')).find((e) => e.account === A.id);
  assert.deepEqual({ antes: cambio.antes, ahora: cambio.ahora }, { antes: null, ahora: 'compra@gmail.com' });
  // el mismo correo en otra conexión → 409, sin tocar nada
  r = await put(B.id, { club_email: 'COMPRA@gmail.com' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, new RegExp(`#${A.id}`));
  assert.equal((await cuenta('locFichaB001')).club_email, null);
  // una conexión ANTERIOR al Club no lo admite (no se usaría nunca)
  r = await put(1, { club_email: 'x@y.com' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /anterior al Club/);
  // guardar la ficha entera sin cambiarlo no hace nada raro (el panel manda todos los campos)
  r = await put(A.id, { club_email: 'compra@gmail.com', ghl_location_email: 'pirata@x.com', es_club: false });
  assert.equal(r.statusCode, 200);
  fila = await cuenta('locFichaA001');
  assert.equal(fila.ghl_location_email, null, 'el correo de la subcuenta no se edita a mano');
  assert.equal((await eventos('club_email_cambiado')).filter((e) => e.account === A.id).length, 1);
  // la ficha del admin lo enseña (y si es del Club); la del cliente, no
  r = await a.inject({ method: 'GET', url: `/api/accounts/${A.id}`, headers: { 'x-rol': 'admin' } });
  assert.equal(r.json().club_email, 'compra@gmail.com');
  assert.equal(r.json().es_club, true);
  assert.ok('ghl_location_email' in r.json());
  r = await a.inject({ method: 'GET', url: '/api/accounts/1', headers: { 'x-rol': 'admin' } });
  assert.equal(r.json().es_club, false);
  r = await a.inject({ method: 'GET', url: `/api/accounts/${B.id}`, headers: { 'x-rol': String(B.id) } });
  assert.equal(r.statusCode, 200);
  for (const k of ['club_email', 'ghl_location_email', 'ghl_location_email_at', 'es_club']) assert.equal(k in r.json(), false, k);
  r = await a.inject({ method: 'GET', url: '/api/accounts', headers: { 'x-rol': String(B.id) } });
  for (const k of ['club_email', 'ghl_location_email']) assert.equal(k in r.json()[0], false, k);
  // el cliente no puede ponerlo (se ignora como cualquier campo de admin)
  r = await put(B.id, { club_email: 'hack@x.com', alias: 'Mi B' }, String(B.id));
  assert.equal(r.statusCode, 200);
  assert.equal((await cuenta('locFichaB001')).club_email, null);
  // vaciarlo deja la conexión SIN confirmar (por correo ya no la encuentra nadie)
  r = await put(A.id, { club_email: '' });
  assert.equal(r.statusCode, 200);
  assert.equal((await cuenta('locFichaA001')).club_email, null);
  // la ficha del cliente tampoco recibe los pendientes del Club
  r = await a.inject({ method: 'GET', url: `/api/accounts/${A.id}`, headers: { 'x-rol': String(A.id) } });
  assert.equal('club_pendientes' in r.json(), false);
});

test('A1 · por la ficha: confirmar el correo del Club en la BUENA basta, aunque otra conexión lo tenga de responsable', async () => {
  const a = await app();
  const { account: buena } = await crearConexionNueva({ name: 'Buena', locationId: 'locAmbBuena1' }, pg);
  const { account: otra } = await crearConexionNueva({ name: 'Otra', locationId: 'locAmbOtra01' }, pg);
  await pg.query(`UPDATE accounts SET ghl_location_email = 'comprador.a1@x.com' WHERE id = $1`, [buena.id]);
  await pg.query(`UPDATE accounts SET owner_email = 'comprador.a1@x.com' WHERE id = $1`, [otra.id]);
  let r = await aplicarEstadoClub({ email: 'comprador.a1@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.body.resultado, 'pendiente', 'antes: ambiguo');
  assert.deepEqual(r.body.sin_confirmar, [buena.id, otra.id]);
  const put = await a.inject({ method: 'PUT', url: `/api/accounts/${buena.id}`, headers: { 'x-rol': 'admin' }, payload: { club_email: 'comprador.a1@x.com' } });
  assert.equal(put.statusCode, 200);
  assert.equal((await cuenta('locAmbBuena1')).ai_enabled, false, 'la baja que esperaba se aplica a la buena');
  r = await aplicarEstadoClub({ email: 'comprador.a1@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 200, 'antes (A1): seguía en 202 ambiguo');
  assert.deepEqual(r.body.cuentas, [buena.id]);
  assert.equal((await cuenta('locAmbOtra01')).ai_enabled, true);
});

test('A2/A4 · por el SSO real: ni el correo de subcuenta que pone el cliente ni el responsable se llevan pendientes ajenos', async () => {
  const a = await app();
  await pg.query(`INSERT INTO settings (key, value) VALUES ('ghl_app', '{"sso_secret":"secreto-sso-de-prueba"}'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const sso = (email, loc) => a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted: cifrarSso({ email, activeLocation: loc }, 'secreto-sso-de-prueba') } });
  // A2: la víctima tiene una baja esperando; el atacante instala con el correo de la víctima en SU subcuenta
  await aplicarEstadoClub({ email: 'victima.sso@x.com', activo: false, motivo: 'baja de la víctima' }, pg);
  infoGhl.set('locAtacaSSO1', { ok: true, name: 'Atacante', email: 'Victima.SSO@X.com' });
  assert.equal((await sso('atacante.sso@x.com', 'locAtacaSSO1')).statusCode, 200);
  const atac = await cuenta('locAtacaSSO1');
  assert.equal(atac.ghl_location_email, 'victima.sso@x.com');
  assert.equal(atac.ai_enabled, true, 'antes (A2): ai_enabled=false y el pendiente consumido');
  assert.equal((await filas(`SELECT count(*)::int AS n FROM club_estado_pendiente WHERE clave = 'email:victima.sso@x.com'`))[0].n, 1);
  // la víctima entra en SU subcuenta: tampoco se aplica solo (ser responsable no basta); soporte confirma → le llega
  infoGhl.set('locVictiSSO1', { ok: true, name: 'Víctima', email: 'victima.sso@x.com' });
  assert.equal((await sso('victima.sso@x.com', 'locVictiSSO1')).statusCode, 200);
  const vic = await cuenta('locVictiSSO1');
  assert.equal(vic.ai_enabled, true);
  const put = await a.inject({ method: 'PUT', url: `/api/accounts/${vic.id}`, headers: { 'x-rol': 'admin' }, payload: { club_email: 'victima.sso@x.com' } });
  assert.equal(put.statusCode, 200);
  assert.equal((await cuenta('locVictiSSO1')).ai_enabled, false);
  const imp = await aplicarEstadoClub({ email: 'victima.sso@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(imp.code, 200, 'antes: 202 ambiguo [atacante, víctima]');
  assert.deepEqual(imp.body.cuentas, [vic.id]);
  assert.equal((await cuenta('locAtacaSSO1')).ai_enabled, true);
  // A4: prueba con el correo de soporte y soporte abre después la conexión de un cliente real
  await aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba del workflow' }, pg);
  infoGhl.set('locClienteS1', { ok: true, name: 'Cliente real', email: 'cliente.real@x.com' });
  assert.equal((await sso(SOPORTE, 'locClienteS1')).statusCode, 200);
  const real = await cuenta('locClienteS1');
  assert.equal(real.owner_email, SOPORTE);
  assert.equal(real.ai_enabled, true, 'antes (A4): ai_enabled=false');
});

test('A5 · ficha abierta antes de un impago: guardar la ficha ENTERA vieja (con el club_email) no vuelve a encender la IA; un cambio de verdad sí se aplica', async () => {
  const a = await app();
  const { account: d } = await crearConexionNueva({ name: 'Ficha', locationId: 'locFichaV001' }, pg);
  const ficha = (await a.inject({ method: 'GET', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' } })).json(); // soporte abre la ficha
  assert.equal(ficha.ai_enabled, true);
  await aplicarEstadoClub({ location_id: 'locFichaV001', activo: false, motivo: 'impago' }, pg); // llega el impago
  assert.equal((await cuenta('locFichaV001')).ai_enabled, false);
  // el panel ANTERIOR mandaba la ficha entera (con el ai_enabled y el club_estado_at de cuando se abrió)
  const body = { ...ficha, club_email: 'compra-ficha@x.com', name: 'Ficha renombrada' };
  delete body.webhook_url; delete body.webhook_token; delete body.oauth_connected; delete body.provider_name;
  let r = await a.inject({ method: 'PUT', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' }, payload: body });
  assert.equal(r.statusCode, 200, r.body);
  let fila = await cuenta('locFichaV001');
  assert.equal(fila.ai_enabled, false, 'antes (A5): volvía a true');
  assert.equal(fila.club_email, 'compra-ficha@x.com', 'lo demás sí se guarda');
  assert.equal(fila.name, 'Ficha renombrada');
  assert.equal(r.json().ai_enabled, false, 'y la respuesta enseña el estado de verdad');
  const ev = (await eventos('ai_enabled_no_pisado')).find((e) => e.account === d.id);
  assert.ok(ev, 'queda anotado');
  assert.equal(ev.enviado, true);
  assert.equal(ev.actual, false);
  // con la ficha RECARGADA (club_estado_at al día), encender a mano sí se aplica
  const fresca = (await a.inject({ method: 'GET', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' } })).json();
  r = await a.inject({ method: 'PUT', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' }, payload: { ...fresca, ai_enabled: true } });
  assert.equal(r.statusCode, 200);
  assert.equal((await cuenta('locFichaV001')).ai_enabled, true);
  // el interruptor de la lista de conexiones (solo { ai_enabled }) funciona como siempre
  r = await a.inject({ method: 'PUT', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' }, payload: { ai_enabled: false } });
  assert.equal(r.statusCode, 200);
  assert.equal((await cuenta('locFichaV001')).ai_enabled, false);
  r = await a.inject({ method: 'PUT', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' }, payload: { ai_enabled: true } });
  assert.equal((await cuenta('locFichaV001')).ai_enabled, true);
  // una ficha vieja que solo trae el ai_enabled viejo (nada más que cambiar) tampoco lo pisa
  await aplicarEstadoClub({ location_id: 'locFichaV001', activo: false, motivo: 'baja' }, pg);
  r = await a.inject({ method: 'PUT', url: `/api/accounts/${d.id}`, headers: { 'x-rol': 'admin' }, payload: { ai_enabled: true, club_estado_at: fresca.club_estado_at } });
  assert.equal(r.statusCode, 200);
  fila = await cuenta('locFichaV001');
  assert.equal(fila.ai_enabled, false);
});

test('authHook con las rutas REALES: las públicas siguen llegando a su ruta sin sesión; las demás piden login', async () => {
  await pg.query(`INSERT INTO settings (key, value) VALUES ('ghl_app', '{"sso_secret":"secreto-sso-de-prueba"}'::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const a = await app({ conAuthHook: true });
  let r = await a.inject({ method: 'POST', url: '/api/portal/register', payload: {} });
  assert.equal(r.statusCode, 410);
  r = await a.inject({ method: 'POST', url: '/api/portal/sso', payload: { encrypted: 'basura' } });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /verificar tu identidad/);
  r = await a.inject({ method: 'GET', url: '/api/oauth/callback' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Falta el parámetro code/);
  r = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nadie', password: 'x' } });
  assert.equal(r.statusCode, 401);
  assert.match(r.json().error, /Usuario o contraseña/, 'responde la ruta de login, no el authHook');
  r = await a.inject({ method: 'GET', url: '/api/health?x=1' });
  assert.equal(r.statusCode, 200);
  for (const [method, url] of [['GET', '/api/portal/access'], ['GET', '/api/oauth/url'], ['GET', '/api/accounts'], ['GET', '/api/auth/me'], ['PUT', '/api/accounts/1']]) {
    r = await a.inject({ method, url, payload: method === 'PUT' ? {} : undefined });
    assert.equal(r.statusCode, 401, `${method} ${url}`);
    assert.equal(r.json().error, 'no_autenticado');
  }
});
