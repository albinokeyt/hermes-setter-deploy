// Rutas públicas EXACTAS del Club (lib/rutas.js + el authHook real de lib/session.js) e IP real detrás de Traefik
// (lib/ipReal.js). session.js importa Redis y Postgres: se sustituyen por dobles (--experimental-test-module-mocks).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import net from 'node:net';
import { esRutaPublica, rutaSinQuery, rutaDeUrl } from '../src/lib/rutas.js';
import { ipReal, claveFreno } from '../src/lib/ipReal.js';

test('rutas públicas: las del Club, EXACTAS (sin la query); las demás, por prefijo como antes', () => {
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
  // las de siempre no cambian
  for (const u of ['/api/webhooks/inbox', '/api/webhooks/workflow/abc', '/api/auth/login', '/api/oauth/callback?code=1', '/api/health', '/api/portal/sso']) {
    assert.equal(esRutaPublica(u), true, u);
  }
  assert.equal(rutaSinQuery('/a?b?c'), '/a');
  assert.equal(rutaDeUrl('http://x/api/accounts?a=1'), '/api/accounts?a=1');
  assert.equal(rutaDeUrl('HTTPS://hermes.example:443/api/club/estado'), '/api/club/estado');
  assert.equal(rutaDeUrl('http://x'), '/');
  assert.equal(rutaDeUrl('/api/health'), '/api/health');
  assert.equal(rutaDeUrl('*'), '*');
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

test('authHook: un destino en forma absoluta («POST http://host/api/…») NO se salta el login', async () => {
  const app = Fastify();
  app.addHook('onRequest', authHook());
  app.post('/api/privada', async () => ({ dentro: true }));
  await app.register(clubRoutes, { secreto: '', redis: { incr: async () => 1, expire: async () => 1 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const crudo = (destino) => new Promise((res, rej) => {
    const peticion = [`POST ${destino} HTTP/1.1`, 'Host: x', 'Content-Type: application/json', 'Content-Length: 2', 'Connection: close', '', '{}'].join('\r\n');
    const s = net.connect(port, '127.0.0.1', () => s.end(peticion));
    let d = '';
    s.on('data', (c) => { d += c; });
    s.on('end', () => res(Number(d.split(' ')[1])));
    s.on('error', rej);
  });
  try {
    assert.equal(await crudo('/api/privada'), 401);
    assert.equal(await crudo('http://x/api/privada'), 401, 'antes: 200 sin sesión');
    assert.equal(await crudo('https://hermes.example/api/privada?x=1'), 401);
    assert.equal(await crudo('http://x/api/club/estado'), 503, 'la ruta pública sigue llegando a su endpoint (protegido por el secreto)');
    assert.equal(await crudo('http://x/api/club/estadoX'), 401);
  } finally {
    await app.close();
  }
});
