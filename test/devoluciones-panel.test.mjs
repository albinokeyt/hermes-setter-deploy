// Panel del admin para las devoluciones del Club (rutas de routes/settings.js) y arranque de workers.js con el barrido
// de avisos. settings.js y workers.js arrastran Redis, BullMQ y el pipeline: se sustituyen por dobles y la base es
// Postgres real en memoria (PGlite) con las migraciones de verdad.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { baseDePruebas } from './_pglite.mjs';

const pg = await baseDePruebas();
const u = (p) => new URL(p, import.meta.url).href;
const filas = async (t, p) => (await pg.query(t, p)).rows;
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
const redisFalso = { get: async () => null, set: async () => 'OK', setex: async () => 'OK', del: async () => 1, incr: async () => 1, expire: async () => 1 };
mock.module(u('../src/lib/redis.js'), { namedExports: { redis: redisFalso, bullConnection: () => ({}) } });
const colaFalsa = { add: async () => ({}) };
mock.module(u('../src/queues.js'), {
  namedExports: { debounceQueue: colaFalsa, sendQueue: colaFalsa, followupQueue: colaFalsa, reactivateQueue: colaFalsa, chargeQueue: colaFalsa },
});

const settingsRoutes = (await import('../src/routes/settings.js')).default;
const workers = await import('../src/workers.js');

async function app(role = 'admin') {
  const a = Fastify();
  a.addHook('onRequest', async (req) => { req.auth = { role, userId: 1 }; });
  await a.register(settingsRoutes);
  return a;
}

test('arranque: workers.js y settings.js cargan con el barrido de devoluciones (sin errores de importación)', () => {
  assert.equal(typeof workers.startWorkers, 'function');
  assert.equal(typeof settingsRoutes, 'function');
});

test('panel: solo el admin ve y cambia los ajustes de devoluciones', async () => {
  const cliente = await app('user');
  assert.equal((await cliente.inject({ method: 'GET', url: '/api/settings/devoluciones' })).statusCode, 403);
  assert.equal((await cliente.inject({ method: 'PUT', url: '/api/settings/devoluciones', payload: { max_ia_usd: 999 } })).statusCode, 403);
  assert.equal((await cliente.inject({ method: 'POST', url: '/api/settings/devoluciones/1/enviar' })).statusCode, 403);
});

test('panel: lee los ajustes por defecto, los cambia con validación y lo deja en el registro', async () => {
  const a = await app();
  let r = await a.inject({ method: 'GET', url: '/api/settings/devoluciones' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.deepEqual(j.ajustes, { plazo_dias: 14, max_ia_usd: 5, max_brain_tareas: 10, brain_uso_url: '', ghl_resultado_url: '' });
  assert.match(j.url, /\/api\/club\/devolucion$/);
  assert.equal(j.configurado, false);
  assert.deepEqual(j.solicitudes, []);
  r = await a.inject({ method: 'PUT', url: '/api/settings/devoluciones', payload: { plazo_dias: 0 } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /plazo/);
  r = await a.inject({ method: 'PUT', url: '/api/settings/devoluciones', payload: { brain_uso_url: 'http://inseguro.test/uso' } });
  assert.equal(r.statusCode, 400);
  r = await a.inject({ method: 'PUT', url: '/api/settings/devoluciones', payload: { max_ia_usd: '7,5', ghl_resultado_url: 'https://services.leadconnectorhq.com/hooks/x/webhook-trigger/y' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ajustes.max_ia_usd, 7.5);
  assert.equal(r.json().ajustes.plazo_dias, 14, 'lo que no llega no cambia');
  const guardado = (await filas(`SELECT value FROM settings WHERE key = 'devoluciones'`))[0].value;
  assert.equal(guardado.max_ia_usd, 7.5);
  const log = (await filas(`SELECT payload FROM webhook_log WHERE kind = 'devoluciones_ajustes_cambiados' ORDER BY id DESC LIMIT 1`))[0];
  assert.equal(log.payload.antes.max_ia_usd, 5);
  assert.equal(log.payload.despues.max_ia_usd, 7.5);
});

test('panel: reenviar a GHL valida el id y responde 409 si no existe', async () => {
  const a = await app();
  assert.equal((await a.inject({ method: 'POST', url: '/api/settings/devoluciones/abc/enviar' })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/api/settings/devoluciones/0/enviar' })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/api/settings/devoluciones/999/enviar' })).statusCode, 409);
  await pg.query(`UPDATE settings SET value = value || '{"ghl_resultado_url": ""}'::jsonb WHERE key = 'devoluciones'`);
  const r = await a.inject({ method: 'POST', url: '/api/settings/devoluciones/999/enviar' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Webhook entrante/);
});
