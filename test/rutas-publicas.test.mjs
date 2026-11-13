// Rutas públicas EXACTAS del Club (lib/rutas.js + el authHook real de lib/session.js) e IP real detrás de Traefik
// (lib/ipReal.js). session.js importa Redis y Postgres: se sustituyen por dobles (--experimental-test-module-mocks).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import net from 'node:net';
import * as rutas from '../src/lib/rutas.js';
import { ipReal, claveFreno } from '../src/lib/ipReal.js';

const { esRutaPublica, rutaSinQuery } = rutas;

test('rutas públicas: las del Club, EXACTAS (sin la query)', () => {
  for (const u of ['/api/club/estado', '/api/club/estado?x=1', '/api/club/devolucion', '/api/club/devolucion?a=b&c=d']) {
    assert.equal(esRutaPublica(u), true, u);
  }
  for (const u of [
    '/api/club/estadoX', '/api/club/estado/', '/api/club/estado/otra', '/api/club/', '/api/club', '/api/club/devolucionX',
    '/api/club/devolucion/', '/api/club/devolucion/1', '/api/club/DEVOLUCION', '/api/club/estado%3Fx', '/api/club/estado#x',
    '/api/club/estado;x', '/api/accounts', '/api/settings/devoluciones',
  ]) {
    assert.equal(esRutaPublica(u), false, u);
  }
  assert.equal(rutaSinQuery('/a?b?c'), '/a');
});

// Fase C · 2) los públicos que NO son del Club se comparan sin la query y con LÍMITE DE SEGMENTO (igual al prefijo o
// prefijo + «/»). Hoy no existe ninguna subruta suya: /api/health, /api/auth/login, /api/oauth/callback,
// /api/portal/register y /api/portal/sso son rutas sueltas (comprobado con un listado de todas las rutas registradas).
test('rutas públicas que no son del Club: sin la query y con límite de segmento; los webhooks, todo /api/webhooks/…', () => {
  for (const u of [
    '/api/health', '/api/health?x=1', '/api/auth/login', '/api/auth/login?r=/x', '/api/oauth/callback', '/api/oauth/callback?code=1&state=2',
    '/api/portal/register', '/api/portal/sso', '/api/portal/sso?a=1',
    '/api/health/', '/api/portal/sso/x', // prefijo + «/» (hoy no hay ninguna ruta así)
    '/api/webhooks/inbox', '/api/webhooks/workflow/abc', '/api/webhooks/comments/k?x=1', '/api/webhooks/etiquetas',
  ]) {
    assert.equal(esRutaPublica(u), true, u);
  }
  for (const u of [
    // antes eran públicas por prefijo suelto
    '/api/healthz', '/api/healthcheck', '/api/health%2F..%2Faccounts', '/api/auth/loginX', '/api/auth/login-admin', '/api/oauth/callbackX',
    '/api/oauth/callback%3F', '/api/portal/ssoX', '/api/portal/sso-config', '/api/portal/register2', '/api/healthz?/api/health',
    // las de al lado que nunca lo fueron
    '/api/auth/logout', '/api/auth/me', '/api/oauth/url', '/api/portal/access', '/api/webhooks', '/api', '/', '',
  ]) {
    assert.equal(esRutaPublica(u), false, u);
  }
  assert.equal('rutaDeUrl' in rutas, false, 'la forma absoluta ya no se «traduce»: se rechaza con 400 en el authHook');
});

test('IP real: el ÚLTIMO tramo de X-Forwarded-For (el que añade Traefik); X-Real-Ip y el primer tramo no cuentan', () => {
  const req = (h, remote = '172.18.0.5') => ({ headers: h, socket: { remoteAddress: remote } });
  assert.equal(ipReal(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })), '203.0.113.7');
  assert.equal(ipReal(req({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
  assert.equal(ipReal(req({ 'x-forwarded-for': ['9.9.9.9', '203.0.113.9'] })), '203.0.113.9', 'cabecera repetida');
  assert.equal(ipReal(req({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '8.8.8.8' })), '1.1.1.1', 'X-Real-Ip se ignora');
  assert.equal(ipReal(req({})), '172.18.0.5', 'sin cabecera: la conexión');
  assert.equal(ipReal(req({ 'x-forwarded-for': 'basura' })), '172.18.0.5', 'tramo que no es una IP: la conexión');
  assert.equal(ipReal(req({}, '::ffff:10.0.0.1')), '10.0.0.1');
  assert.equal(ipReal(req({ 'x-forwarded-for': '1.1.1.1, [2001:DB8::1]:443' })), '2001:db8::1');
  assert.equal(ipReal(req({ 'x-forwarded-for': '203.0.113.7:5555' })), '203.0.113.7');
  assert.equal(ipReal({ headers: {} }), 'desconocida');
  assert.equal(ipReal(null), 'desconocida');
  // IPv6 por /64
  assert.equal(claveFreno('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(claveFreno('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(claveFreno('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(claveFreno('::1'), '0:0:0:0::/64');
  assert.equal(claveFreno('203.0.113.7'), '203.0.113.7');
});

// ── authHook de verdad con las rutas del Club ───────────────────────────────────────────────
const u = (p) => new URL(p, import.meta.url).href;
mock.module(u('../src/lib/redis.js'), {
  namedExports: {
    redis: { get: async () => null, setex: async () => 'OK', expire: async () => 1, del: async () => 1, incr: async () => 1 },
    bullConnection: () => ({}),
  },
});
mock.module(u('../src/db.js'), {
  namedExports: {
    pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error('sin base'); } },
    q: async () => [], one: async () => null, migrate: async () => {}, getSetting: async (_k, fb = null) => fb, setSetting: async () => {},
  },
});
const { authHook } = await import('../src/lib/session.js');
const clubRoutes = (await import('../src/routes/club.js')).default;

test('authHook: solo las rutas EXACTAS del Club llegan al endpoint sin sesión; cualquier variante pide login', async () => {
  const app = Fastify();
  app.addHook('onRequest', authHook());
  await app.register(clubRoutes, { secreto: '', redis: { incr: async () => 1, expire: async () => 1 } });
  const post = async (url) => (await app.inject({ method: 'POST', url, payload: {} })).statusCode;
  // exactas → llegan a la ruta (que, sin CLUB_WEBHOOK_SECRET, responde 503 sin hacer nada)
  assert.equal(await post('/api/club/estado'), 503);
  assert.equal(await post('/api/club/estado?origen=ghl'), 503);
  assert.equal(await post('/api/club/devolucion'), 503);
  // variantes → el authHook las corta antes (401), aunque Fastify pudiera enrutarlas
  for (const url of ['/api/club/estadoX', '/api/club/estado/', '/api/club/devolucion/', '/api/club/devolucion/1', '/api/club/otra', '/api/club/estad%6F']) {
    assert.equal(await post(url), 401, url);
  }
  // otros métodos sobre la ruta exacta: no existen (404), nunca hacen nada
  assert.equal((await app.inject({ method: 'GET', url: '/api/club/devolucion' })).statusCode, 404);
});

// Petición HTTP/1.1 CRUDA (app.inject normaliza el destino; un socket no): devuelve el código de estado.
async function servidorDePruebas(rutasExtra) {
  const app = Fastify();
  app.addHook('onRequest', authHook());
  app.post('/api/privada', async () => ({ dentro: true }));
  app.get('/api/privada', async () => ({ dentro: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/webhooks/prueba/:token', async (req) => ({ webhook: req.params.token }));
  if (rutasExtra) rutasExtra(app);
  await app.register(clubRoutes, { secreto: '', redis: { incr: async () => 1, expire: async () => 1 } });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ nf: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const crudo = (destino, metodo = 'POST') => new Promise((res, rej) => {
    const cuerpo = metodo === 'POST' ? ['Content-Type: application/json', 'Content-Length: 2'] : [];
    const peticion = [`${metodo} ${destino} HTTP/1.1`, 'Host: x', ...cuerpo, 'Connection: close', '', metodo === 'POST' ? '{}' : ''].join('\r\n');
    const s = net.connect(port, '127.0.0.1', () => s.end(peticion));
    let d = '';
    s.on('data', (c) => { d += c; });
    s.on('end', () => res({ code: Number(d.split(' ')[1]), body: d.slice(d.indexOf('\r\n\r\n') + 4) }));
    s.on('error', rej);
  });
  return { app, crudo };
}

// Fase C · 2) [seguridad] el verificador entró sin login con «GET http://host?/api/…» (también con puerto, usuario o
// https y «?a»): Fastify enruta la parte de después de la «?» como la ruta, pero el texto no empieza por «/api/».
test('authHook: un destino que no empieza por «/» (forma absoluta u «*») → 400 ANTES de decidir nada', async () => {
  const { app, crudo } = await servidorDePruebas();
  try {
    for (const destino of [
      'http://x/api/privada', 'https://hermes.example/api/privada?x=1', 'HTTP://x/api/privada',
      'http://x?/api/privada', 'http://x:80?/api/privada', 'http://user@x?/api/privada', 'https://x?a/api/privada', // las del verificador
      'http://x/api/club/estado', 'http://x?/api/club/estado', 'http://x/api/health', 'http://x/', 'http://x?/api/webhooks/prueba/t',
    ]) {
      for (const metodo of ['POST', 'GET']) {
        const r = await crudo(destino, metodo);
        assert.equal(r.code, 400, `${metodo} ${destino} → ${r.code} ${r.body}`);
        assert.doesNotMatch(r.body, /dentro|webhook/, `${metodo} ${destino}`);
      }
    }
    assert.equal((await crudo('*', 'OPTIONS')).code, 400, 'OPTIONS * tampoco');
    // lo normal sigue igual
    assert.equal((await crudo('/api/privada')).code, 401);
    assert.equal((await crudo('/api/club/estado')).code, 503, 'la ruta pública del Club llega a su endpoint (protegido por el secreto)');
    assert.equal((await crudo('/api/health', 'GET')).code, 200);
    assert.equal((await crudo('/api/webhooks/prueba/tok1')).code, 200);
    assert.equal((await crudo('/otra/cosa', 'GET')).code, 404, 'lo que no es de la API no pide sesión');
  } finally {
    await app.close();
  }
});

// Fase C · 2) el router DECODIFICA la ruta («/%61pi/privada» casa con «/api/privada») pero el texto no empieza por
// «/api/»: también se mira la ruta que ha casado (req.routeOptions.url). Lo encontró el sondeo de la fase C.
test('authHook: «/%61pi/…» y variantes codificadas no se saltan el login (se mira también la ruta que casó el router)', async () => {
  const { app, crudo } = await servidorDePruebas();
  try {
    for (const destino of ['/%61pi/privada', '/ap%69/privada', '/%61%70%69/privada', '/api/%70rivada', '/%61pi/club/estado', '/%61pi/webhooks/prueba/t']) {
      for (const metodo of ['POST', 'GET']) {
        if (metodo === 'GET' && /club|webhooks/.test(destino)) continue;
        const r = await crudo(destino, metodo);
        assert.equal(r.code, 401, `${metodo} ${destino} → ${r.code} ${r.body}`);
      }
    }
    // una ruta pública con un parámetro codificado sigue llegando (el webhook comprueba su token)
    const r = await crudo('/api/webhooks/prueba/a%20b');
    assert.equal(r.code, 200);
    assert.match(r.body, /"webhook":"a b"/);
    assert.equal((await crudo('/api/club/estad%6F')).code, 401, 'variante codificada de la ruta exacta del Club');
  } finally {
    await app.close();
  }
});

test('authHook: los públicos que no son del Club ya no valen por prefijo suelto (límite de segmento)', async () => {
  // rutas inventadas que empiezan igual que una pública: antes llegaban sin sesión
  const { app, crudo } = await servidorDePruebas((a) => {
    a.get('/api/healthz', async () => ({ dentro: true }));
    a.post('/api/auth/loginX', async () => ({ dentro: true }));
    a.get('/api/oauth/callbackX', async () => ({ dentro: true }));
    a.post('/api/portal/ssoX', async () => ({ dentro: true }));
    a.post('/api/portal/register2', async () => ({ dentro: true }));
  });
  try {
    for (const [destino, metodo] of [['/api/healthz', 'GET'], ['/api/auth/loginX', 'POST'], ['/api/oauth/callbackX', 'GET'], ['/api/portal/ssoX', 'POST'], ['/api/portal/register2', 'POST'], ['/api/healthz?/api/health', 'GET']]) {
      const r = await crudo(destino, metodo);
      assert.equal(r.code, 401, `${metodo} ${destino} → ${r.code} ${r.body}`);
    }
    assert.equal((await crudo('/api/health?x=1', 'GET')).code, 200);
  } finally {
    await app.close();
  }
});
