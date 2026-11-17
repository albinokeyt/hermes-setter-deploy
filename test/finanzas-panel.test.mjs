// 💵 Panel «Dinero real · OpenRouter y clientes» (GET /api/marketplace/finanzas de routes/marketplace.js).
// La base es Postgres real en memoria (PGlite) con las migraciones de verdad; Redis y BullMQ son dobles y el fetch
// global es falso: responde como OpenRouter (/key, /credits, /keys) y como el marketplace (/api/v1/finanzas), y
// cualquier otro destino rompe el test (así se comprueba que ninguna clave sale hacia otro servidor).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { baseDePruebas } from './_pglite.mjs';

const pg = await baseDePruebas();
const u = (p) => new URL(p, import.meta.url).href;
const filas = async (t, p) => (await pg.query(t, p)).rows;
// fallos.costeIa = true → la PRÓXIMA consulta del coste de la IA (la de /finanzas) lanza, como si la base fallara
const fallos = { costeIa: false };
mock.module(u('../src/db.js'), {
  namedExports: {
    pool: pg,
    q: filas,
    one: async (t, p) => {
      if (fallos.costeIa && String(t).includes('AS historico')) { fallos.costeIa = false; throw new Error('la base no responde'); }
      return (await filas(t, p))[0] || null;
    },
    migrate: async () => {},
    getSetting: async (k, fb = null) => { const r = await filas(`SELECT value FROM settings WHERE key = $1`, [k]); return r[0] ? r[0].value : fb; },
    setSetting: async () => {},
  },
});
const redisFalso = { get: async () => null, set: async () => 'OK', setex: async () => 'OK', del: async () => 1, incr: async () => 1, expire: async () => 1 };
mock.module(u('../src/lib/redis.js'), { namedExports: { redis: redisFalso, bullConnection: () => ({}) } });
const colaFalsa = { add: async () => ({}) };
mock.module(u('../src/queues.js'), {
  namedExports: { debounceQueue: colaFalsa, sendQueue: colaFalsa, followupQueue: colaFalsa, reactivateQueue: colaFalsa, chargeQueue: colaFalsa },
});

// ── secretos de mentira (nunca pueden aparecer en una respuesta) ──
const CLAVE_A = 'sk-or-v1-CLAVESECRETA-AAAA-0000000001';  // la comparten dos proveedores
const CLAVE_B = 'sk-or-v1-OTRACLAVE-BBBB-0000000002';
const CLAVE_OTRO_HOST = 'sk-otro-host-CCCC-000000000003';  // base_url de otro servidor que contiene «openrouter.ai»
const CLAVE_OPENAI = 'sk-openai-DDDD-000000000004';
const CLAVE_GESTION = 'sk-or-v1-GESTION-EEEE-0000000005';
const CLAVE_MD = 'md-clave-de-pruebas-FFFF-6';
const SECRETOS = [CLAVE_A, CLAVE_B, CLAVE_OTRO_HOST, CLAVE_OPENAI, CLAVE_GESTION, CLAVE_MD];

process.env.MD_API_KEY = CLAVE_MD;
process.env.MD_BASE_URL = 'https://md.test';
process.env.MD_ZONA_HORARIA = 'Europe/Madrid';
delete process.env.OPENROUTER_MANAGEMENT_KEY;

// ── fetch falso ──
const bloque = (o = {}) => ({
  cortesia_concedida: 0, cortesia_retirada: 0, real_tarjeta: 0, real_monedero: 0, real_revertido: 0, real_recargado: 0,
  consumo_total: 0, consumo_app: 0, consumo_app_cortesia: 0, consumo_app_real: 0, reembolsos_app: 0, consumo_otras_apps: 0,
  otros: 0, cobrado_monedero_app: 0, ...o,
});
const FINANZAS_OK = {
  regla: 'cortesia_primero', moneda: 'USD', zona: 'Europe/Madrid', zona_valida: true, desde: '2026-11-01', hasta: '2026-11-16',
  locations: [
    {
      location_id: 'locSinConexion', name: 'Cliente solo del marketplace',
      saldo: { total: 1, cortesia: 0, real: 1, registrado: 1, descuadre: false },
      historico: bloque({ real_monedero: 3, real_recargado: 3, consumo_app: 2, consumo_app_real: 2, cobrado_monedero_app: 1.5 }),
      rango: null,
    },
    {
      location_id: 'locAna', name: 'Ana (nombre del marketplace)',
      saldo: { total: 7, cortesia: 2, real: 5, registrado: 7.5, descuadre: true },
      historico: bloque({ cortesia_concedida: 10, cortesia_retirada: 1, real_tarjeta: 20, real_recargado: 20, consumo_app: 12, consumo_app_cortesia: 7, consumo_app_real: 5 }),
      rango: bloque({ consumo_app: 3, consumo_app_cortesia: 1, consumo_app_real: 2, cobrado_monedero_app: 0.5 }),
    },
  ],
  totales: {
    saldo: { total: 8, cortesia: 2, real: 6, registrado: 8.5 },
    historico: bloque({ cortesia_concedida: 10, cortesia_retirada: 1, real_tarjeta: 20, real_monedero: 3, real_recargado: 23, consumo_app: 14, consumo_app_cortesia: 7, consumo_app_real: 7, cobrado_monedero_app: 1.5 }),
    rango: bloque({ consumo_app: 3, consumo_app_cortesia: 1, consumo_app_real: 2, cobrado_monedero_app: 0.5 }),
  },
};
// como el marketplace de verdad: si no se pide rango, no hay bloques «rango»
const sinBloquesRango = (b) => ({
  ...b, desde: null, hasta: null,
  locations: (b.locations || []).map((l) => ({ ...l, rango: null })),
  totales: b.totales ? { ...b.totales, rango: null } : b.totales,
});

const estado = {
  claveB: { label: 'Hermes barato', usage: 1.25, usage_daily: 0, usage_weekly: 0.5, usage_monthly: 1, limit: null, limit_remaining: null },
  credits: { total_credits: 100, total_usage: 99.7 },
  md: { status: 200, body: FINANZAS_OK },
};
const llamadas = [];
const responder = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const auth = opts.headers?.Authorization || opts.headers?.authorization || '';
  const destino = String(url);
  llamadas.push({ url: destino, auth });
  if (destino === 'https://openrouter.ai/api/v1/key') {
    if (auth === `Bearer ${CLAVE_A}`) return responder(200, { data: { label: 'Hermes principal', usage: 12.5, usage_daily: 0.5, usage_weekly: 3, usage_monthly: 8, limit: null, limit_remaining: null, is_free_tier: false } });
    if (auth === `Bearer ${CLAVE_B}`) return responder(200, { data: estado.claveB });
    return responder(401, { error: { message: 'No auth credentials found' } });
  }
  if (destino === 'https://openrouter.ai/api/v1/credits') {
    if (auth !== `Bearer ${CLAVE_GESTION}`) return responder(403, { error: { message: 'Only management keys can perform this operation' } });
    return responder(200, { data: estado.credits });
  }
  if (destino === 'https://openrouter.ai/api/v1/keys') {
    if (auth !== `Bearer ${CLAVE_GESTION}`) return responder(403, {});
    return responder(200, { data: [
      { hash: 'h1', name: 'Hermes principal', label: 'sk-or-v1-0e6…1c96', disabled: false, usage: 12.5, usage_monthly: 8, limit: null, limit_remaining: null },
      { hash: 'h2', name: 'Disruptive Brain', label: 'sk-or-v1-9aa…77bd', disabled: true, usage: 40, usage_monthly: 2, limit: 50, limit_remaining: 10 },
    ] });
  }
  if (destino.startsWith('https://md.test/api/v1/finanzas')) {
    if (estado.md === 'red') throw new TypeError('fetch failed');
    // las mismas validaciones que el marketplace (publicApi.js): rango al revés → 400 INVALID_RANGE
    const qs = new URL(destino).searchParams;
    const d = qs.get('desde');
    const h = qs.get('hasta');
    if (d && h && d > h) return responder(400, { code: 'INVALID_RANGE', error: 'La fecha «desde» no puede ser posterior a «hasta»' });
    if (estado.md.status === 200 && !d && !h && Array.isArray(estado.md.body?.locations)) return responder(200, sinBloquesRango(estado.md.body));
    return responder(estado.md.status, estado.md.body);
  }
  throw new Error(`destino inesperado en el test: ${destino}`);
};

const marketplaceRoutes = (await import('../src/routes/marketplace.js')).default;
const { alertaOpenRouter, vaciarCacheOpenRouter } = await import('../src/services/openrouter.js');
const { mascaraClave } = await import('../src/lib/mascara.js');
const { diaNatural, finanzasMd } = await import('../src/services/marketplace.js');
const { diaValido } = await import('../src/lib/fechas.js');

await pg.exec(`
  INSERT INTO providers (id, name, base_url, api_key) VALUES
    (1, 'OpenRouter principal', 'https://openrouter.ai/api/v1', '${CLAVE_A}'),
    (2, 'OpenRouter visión', 'https://openrouter.ai/api/v1', '${CLAVE_A}'),
    (3, 'OpenRouter barato', 'https://OpenRouter.ai/api/v1', '${CLAVE_B}'),
    (4, 'Impostor', 'https://otro.test/v1?openrouter.ai', '${CLAVE_OTRO_HOST}'),
    (5, 'OpenAI', 'https://api.openai.com/v1', '${CLAVE_OPENAI}');
  INSERT INTO accounts (id, name, location_id, webhook_token, alias) VALUES
    (10, 'conexion-ana', 'locAna', 'tk10', 'Ana (Hermes)'),
    (11, 'Bea', 'locBea', 'tk11', '');
  INSERT INTO llm_usage (account_id, model, cost_usd, source, created_at) VALUES
    (10, 'm', 0.5, 'reply', '2026-11-10T12:00:00Z'),
    (10, 'm', 0.25, 'playground', '2026-10-01T12:00:00Z'),
    (NULL, 'm', 1.0, 'archivo', '2026-11-10T12:00:00Z'),
    (11, 'm', 0.125, 'reply', '2026-11-16T23:30:00Z');  -- en Madrid ya es el día 17: fuera del rango hasta el 16
`);

async function app(role = 'admin') {
  const a = Fastify();
  a.addHook('onRequest', async (req) => { req.auth = { role, userId: 1 }; });
  await a.register(marketplaceRoutes);
  return a;
}
const URL_RANGO = '/api/marketplace/finanzas?desde=2026-11-01&hasta=2026-11-16';
const sinSecretos = (texto) => { for (const s of SECRETOS) assert.ok(!texto.includes(s), `la respuesta NO puede llevar una clave en claro (${s.slice(0, 9)}…)`); };

test('solo el admin: un cliente recibe 403 y no se consulta ni OpenRouter ni el marketplace', async () => {
  const a = await app('user');
  const antes = llamadas.length;
  const r = await a.inject({ method: 'GET', url: URL_RANGO });
  assert.equal(r.statusCode, 403);
  assert.equal(llamadas.length, antes);
});

test('sin management key: cuenta configurada:false, alerta «desconocido», gasto por clave sin duplicar y ninguna clave en claro', async () => {
  vaciarCacheOpenRouter();
  delete process.env.OPENROUTER_MANAGEMENT_KEY;
  const a = await app();
  const antes = llamadas.length;
  const r = await a.inject({ method: 'GET', url: URL_RANGO });
  assert.equal(r.statusCode, 200);
  sinSecretos(r.payload);
  const j = r.json();
  assert.deepEqual(j.openrouter.cuenta, { configurada: false });
  assert.equal(j.openrouter.comision_pct, 5.5);
  assert.equal(j.resumen.alerta_openrouter.nivel, 'desconocido');
  assert.match(j.resumen.alerta_openrouter.texto, /OPENROUTER_MANAGEMENT_KEY/);
  assert.equal(j.resumen.pagado_openrouter, null);
  assert.equal(j.resumen.comision_estimada, null);
  assert.equal(j.resumen.saldo_openrouter, null);

  // la clave compartida por dos proveedores se consulta UNA vez; el impostor y OpenAI, nunca
  const claves = j.openrouter.claves_hermes;
  assert.equal(claves.length, 2);
  const a1 = claves.find((c) => c.label === 'Hermes principal');
  assert.deepEqual(a1.proveedores.map((p) => p.id), [1, 2]);
  assert.equal(a1.clave, mascaraClave(CLAVE_A));
  assert.equal(a1.usage, 12.5);
  assert.equal(a1.usage_monthly, 8);
  assert.equal(a1.error, null);
  assert.deepEqual(claves.find((c) => c.label === 'Hermes barato').proveedores.map((p) => p.id), [3]);
  assert.equal(j.resumen.gastado_claves_hermes, 13.75);
  assert.equal(j.resumen.gastado_claves_hermes_mes, 9);

  const nuevas = llamadas.slice(antes);
  const aOpenRouter = nuevas.filter((l) => l.url.startsWith('https://openrouter.ai/'));
  assert.equal(aOpenRouter.length, 2, 'una llamada por clave distinta, sin /credits ni /keys');
  assert.ok(aOpenRouter.every((l) => l.url === 'https://openrouter.ai/api/v1/key'), 'siempre la URL fija, nunca la base_url');
  assert.ok(!nuevas.some((l) => l.auth.includes(CLAVE_OTRO_HOST) || l.auth.includes(CLAVE_OPENAI)), 'las claves de otros servidores no salen');
  assert.ok(nuevas.some((l) => l.url.startsWith('https://md.test/api/v1/finanzas') && l.auth === `Bearer ${CLAVE_MD}`));
});

test('caché de 5 min: sin refrescar no se vuelve a llamar a OpenRouter; con refrescar=1, sí', async () => {
  const a = await app();
  let antes = llamadas.length;
  await a.inject({ method: 'GET', url: URL_RANGO });
  assert.equal(llamadas.slice(antes).filter((l) => l.url.startsWith('https://openrouter.ai/')).length, 0);
  antes = llamadas.length;
  await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` });
  assert.equal(llamadas.slice(antes).filter((l) => l.url.startsWith('https://openrouter.ai/')).length, 2);
});

test('con management key y saldo de 0,3 $: alerta «agotado», comprado y comisión estimada, claves de toda la cuenta', async () => {
  process.env.OPENROUTER_MANAGEMENT_KEY = CLAVE_GESTION;
  estado.credits = { total_credits: 100, total_usage: 99.7 };
  const a = await app();
  const r = await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` });
  assert.equal(r.statusCode, 200);
  sinSecretos(r.payload);
  const j = r.json();
  const c = j.openrouter.cuenta;
  assert.equal(c.configurada, true);
  assert.equal(c.total_credits, 100);
  assert.equal(c.total_usage, 99.7);
  assert.equal(c.saldo, 0.3);
  assert.equal(c.error, null);
  assert.deepEqual(c.claves.map((k) => [k.name, k.disabled, k.usage]), [['Hermes principal', false, 12.5], ['Disruptive Brain', true, 40]]);
  assert.ok(!('hash' in c.claves[0]), 'solo los campos acordados');
  assert.equal(j.resumen.pagado_openrouter, 100);
  assert.equal(j.resumen.comision_estimada, 5.5);
  assert.equal(j.resumen.gastado_openrouter_cuenta, 99.7);
  assert.equal(j.resumen.saldo_openrouter, 0.3);
  assert.equal(j.resumen.alerta_openrouter.nivel, 'agotado');
  assert.match(j.resumen.alerta_openrouter.texto, /openrouter\.ai\/settings\/credits/);
});

test('saldo de 3 $ → «bajo»; una clave de Hermes con 0,4 $ de límite → «agotado» aunque la cuenta tenga saldo', async () => {
  process.env.OPENROUTER_MANAGEMENT_KEY = CLAVE_GESTION;
  estado.credits = { total_credits: 100, total_usage: 97 };
  const a = await app();
  let j = (await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` })).json();
  assert.equal(j.resumen.saldo_openrouter, 3);
  assert.equal(j.resumen.alerta_openrouter.nivel, 'bajo');
  assert.match(j.resumen.alerta_openrouter.texto, /casi sin saldo/);

  estado.credits = { total_credits: 100, total_usage: 50 };
  estado.claveB = { ...estado.claveB, limit: 5, limit_remaining: 0.4 };
  j = (await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` })).json();
  assert.equal(j.resumen.alerta_openrouter.nivel, 'agotado');
  assert.match(j.resumen.alerta_openrouter.texto, /Hermes barato/);

  estado.claveB = { ...estado.claveB, limit: null, limit_remaining: null };
  j = (await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` })).json();
  assert.equal(j.resumen.alerta_openrouter.nivel, 'ok');
});

test('clientes: cruce por location_id (nombre de Hermes si hay conexión), totales, coste de la IA y resultado', async () => {
  const a = await app();
  const antes = llamadas.length;
  const j = (await a.inject({ method: 'GET', url: URL_RANGO })).json();
  // lo que se pide al marketplace: el rango y la zona del cobro
  const pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
  assert.equal(pedida.pathname, '/api/v1/finanzas');
  assert.equal(pedida.searchParams.get('desde'), '2026-11-01');
  assert.equal(pedida.searchParams.get('hasta'), '2026-11-16');
  assert.equal(pedida.searchParams.get('zona'), 'Europe/Madrid');
  assert.equal(j.zona, 'Europe/Madrid');
  assert.equal(j.desde, '2026-11-01');
  assert.equal(j.hasta, '2026-11-16');

  assert.equal(j.clientes.disponible, true);
  assert.equal(j.clientes.motivo, null);
  const [primera, segunda] = j.clientes.filas;
  assert.equal(primera.location_id, 'locAna', 'ordenado por dinero real recargado');
  assert.equal(primera.account_id, 10);
  assert.equal(primera.name, 'Ana (Hermes)', 'el nombre visible de la conexión de Hermes');
  assert.equal(primera.saldo.descuadre, true);
  assert.equal(primera.rango.consumo_app_real, 2);
  assert.equal(segunda.location_id, 'locSinConexion');
  assert.equal(segunda.account_id, null);
  assert.equal(segunda.name, 'Cliente solo del marketplace');
  assert.equal(segunda.rango, null);
  assert.deepEqual(j.clientes.totales, FINANZAS_OK.totales);

  // coste de la IA de Hermes: todo menos el Archivo; el rango por el día de Madrid
  assert.deepEqual(j.hermes, { coste_ia_historico: 0.875, coste_ia_rango: 0.5, coste_ia_archivo_historico: 1 });
  const r = j.resumen;
  assert.equal(r.te_han_pagado, 24.5);          // 23 recargado + 1,5 cobrado del monedero
  assert.equal(r.cortesia_regalada, 9);          // 10 − 1
  // lo cobrado a Hermes directamente del monedero de GHL es dinero real consumido en Hermes (un solo criterio)
  assert.equal(r.consumido_hermes_real, 8.5);    // 7 del saldo real + 1,5 del monedero
  assert.equal(r.consumido_hermes_real_saldo, 7);
  assert.equal(r.cobrado_monedero_hermes, 1.5);
  assert.equal(r.consumido_hermes_cortesia, 7);
  assert.equal(r.resultado_real_hermes, 7.625);  // 7 + 1,5 − 0,875
  assert.equal(r.saldo_clientes_real, 6);
  assert.equal(r.saldo_clientes_cortesia, 2);
  assert.equal(r.consumido_hermes_real_rango, 2.5); // 2 del saldo + 0,5 del monedero
  assert.equal(r.cobrado_monedero_hermes_rango, 0.5);
  assert.equal(r.resultado_real_rango, 2);       // 2 + 0,5 − 0,5
  assert.equal(j.rango_invalido, false);
  assert.equal(j.aviso_rango, null);
});

test('sin rango: el marketplace se consulta sin fechas y las cifras del rango van a null', async () => {
  const a = await app();
  estado.md = { status: 200, body: { ...FINANZAS_OK, desde: null, hasta: null, totales: { ...FINANZAS_OK.totales, rango: null } } };
  const antes = llamadas.length;
  const j = (await a.inject({ method: 'GET', url: '/api/marketplace/finanzas' })).json();
  const pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
  assert.equal(pedida.searchParams.get('desde'), null);
  assert.equal(pedida.searchParams.get('hasta'), null);
  assert.equal(j.hermes.coste_ia_rango, null);
  assert.equal(j.resumen.resultado_real_rango, null);
  assert.equal(j.resumen.consumido_hermes_real_rango, null);
  assert.equal(j.resumen.cobrado_monedero_hermes_rango, null);
  assert.equal(j.resumen.cobrado_monedero_hermes, 1.5, 'lo histórico sigue');
  assert.equal(j.desde, null);
  assert.equal(j.hasta, null);
  estado.md = { status: 200, body: FINANZAS_OK };
});

test('marketplace sin permiso (403), sin actualizar (404) o sin red: disponible:false con un motivo claro y el resto sigue', async () => {
  const a = await app();
  estado.md = { status: 403, body: { code: 'FINANCES_NOT_ALLOWED', error: 'La app no puede leer finanzas' } };
  let r = await a.inject({ method: 'GET', url: URL_RANGO });
  assert.equal(r.statusCode, 200);
  sinSecretos(r.payload);
  let j = r.json();
  assert.equal(j.clientes.disponible, false);
  assert.match(j.clientes.motivo, /permiso/);
  assert.match(j.clientes.motivo, /Puede leer finanzas/, 'el nombre del interruptor tal como se ve en el marketplace');
  assert.doesNotMatch(j.clientes.motivo, /can_read_finances/, 'sin jerga de la base de datos');
  assert.deepEqual(j.clientes.filas, []);
  assert.equal(j.clientes.totales, null);
  assert.equal(j.resumen.te_han_pagado, null);
  assert.equal(j.resumen.cobrado_monedero_hermes, null);
  assert.equal(j.resumen.resultado_real_hermes, null);
  assert.equal(j.openrouter.claves_hermes.length, 2, 'OpenRouter se sigue viendo');
  assert.equal(j.hermes.coste_ia_historico, 0.875);

  estado.md = { status: 404, body: { message: 'Route GET:/api/v1/finanzas not found', error: 'Not Found', statusCode: 404 } };
  j = (await a.inject({ method: 'GET', url: URL_RANGO })).json();
  assert.equal(j.clientes.disponible, false);
  assert.match(j.clientes.motivo, /actualizar/);

  estado.md = 'red';
  j = (await a.inject({ method: 'GET', url: URL_RANGO })).json();
  assert.equal(j.clientes.disponible, false);
  assert.match(j.clientes.motivo, /conectar/);
  estado.md = { status: 200, body: FINANZAS_OK };
});

test('cliente que solo ha pagado a Hermes del monedero de GHL: cuenta como dinero real consumido y el resultado sale positivo', async () => {
  const a = await app();
  const soloMonedero = bloque({ cobrado_monedero_app: 2 });
  estado.md = { status: 200, body: {
    ...FINANZAS_OK,
    locations: [{ location_id: 'locMonedero', name: 'Solo monedero', saldo: { total: 0, cortesia: 0, real: 0, registrado: 0, descuadre: false }, historico: soloMonedero, rango: soloMonedero }],
    totales: { saldo: { total: 0, cortesia: 0, real: 0, registrado: 0 }, historico: soloMonedero, rango: soloMonedero },
  } };
  try {
    const r = (await a.inject({ method: 'GET', url: URL_RANGO })).json().resumen;
    assert.equal(r.te_han_pagado, 2);
    assert.equal(r.consumido_hermes_real, 2);
    assert.equal(r.consumido_hermes_real_saldo, 0);
    assert.equal(r.cobrado_monedero_hermes, 2);
    assert.equal(r.resultado_real_hermes, 1.125); // 0 + 2 − 0,875
    assert.equal(r.consumido_hermes_real_rango, 2);
    assert.equal(r.resultado_real_rango, 1.5);    // 0 + 2 − 0,5
  } finally {
    estado.md = { status: 200, body: FINANZAS_OK };
  }
});

test('coste de la IA del rango: lo ya cobrado cuenta el día del cobro del lote (como el dinero del marketplace); lo demás, el día de cada llamada', async () => {
  // 1-nov 00:10 en Madrid = 31-oct 23:10 UTC (hora de invierno, +1)
  await pg.exec(`
    INSERT INTO marketplace_charges (id, event_id, account_id, location_id, dia, tipo, estado, test_mode, updated_at) VALUES
      (901, 'hermes-ia-locAna-t901', 10, 'locAna', '2026-11-01', 'consumo_ia', 'cobrado',   false, '2026-10-31T23:10:00Z'),
      (902, 'hermes-ia-locAna-t902', 10, 'locAna', '2026-11-17', 'consumo_ia', 'cobrado',   false, '2026-11-17T09:00:00Z'),
      (903, 'hermes-ia-locAna-t903', 10, 'locAna', '2026-11-16', 'consumo_ia', 'pendiente', false, '2026-11-17T09:00:00Z'),
      (904, 'hermes-ia-locAna-t904', 10, 'locAna', '2026-11-17', 'consumo_ia', 'cobrado',   true,  '2026-11-17T09:00:00Z');
    INSERT INTO llm_usage (account_id, model, cost_usd, source, created_at, md_charge_id) VALUES
      (10, 'm', 1, 'reply', '2026-10-31T12:00:00Z', 901),  -- del 31-oct, cobrada el 1-nov → DENTRO del 1–16 nov
      (10, 'm', 2, 'reply', '2026-11-16T10:00:00Z', 902),  -- del 16-nov, cobrada el 17 → FUERA
      (10, 'm', 4, 'reply', '2026-11-16T10:00:00Z', 903),  -- del 16-nov, lote aún pendiente → por su día: DENTRO
      (10, 'm', 8, 'reply', '2026-11-16T10:00:00Z', 904);  -- del 16-nov, lote de prueba (no es dinero) → por su día: DENTRO
  `);
  try {
    const a = await app();
    const j = (await a.inject({ method: 'GET', url: URL_RANGO })).json();
    // 0,5 (10-nov, sin lote) + 1 + 4 + 8; la de las 23:30Z del 16-nov (sin lote, ya día 17 en Madrid) sigue fuera
    assert.equal(j.hermes.coste_ia_rango, 13.5);
    assert.equal(j.hermes.coste_ia_historico, 15.875, 'el histórico cuenta cada llamada una vez');
    assert.equal(j.resumen.resultado_real_rango, -11); // 2,5 − 13,5
    // del 17 en adelante entra la cobrada el 17 y la de las 23:30Z; ninguna llamada cuenta dos veces
    const k = (await a.inject({ method: 'GET', url: '/api/marketplace/finanzas?desde=2026-11-17&hasta=2026-11-30' })).json();
    assert.equal(k.hermes.coste_ia_rango, 2.125);
    const antes = (await a.inject({ method: 'GET', url: '/api/marketplace/finanzas?desde=2026-01-01&hasta=2026-10-31' })).json();
    assert.equal(antes.hermes.coste_ia_rango, 0.25, 'la del 31-oct ya no cuenta en octubre: se cobró el 1-nov');
    assert.equal(antes.hermes.coste_ia_rango + j.hermes.coste_ia_rango + k.hermes.coste_ia_rango, j.hermes.coste_ia_historico);
  } finally {
    await pg.exec(`DELETE FROM llm_usage WHERE md_charge_id IN (901, 902, 903, 904); DELETE FROM marketplace_charges WHERE id IN (901, 902, 903, 904);`);
  }
});

test('«Desde» posterior a «Hasta»: no se manda el rango al marketplace, lo histórico se sigue viendo y se avisa', async () => {
  const a = await app();
  const antes = llamadas.length;
  const r = await a.inject({ method: 'GET', url: '/api/marketplace/finanzas?desde=2026-11-20&hasta=2026-11-01' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  const pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
  assert.equal(pedida.searchParams.get('desde'), null);
  assert.equal(pedida.searchParams.get('hasta'), null);
  assert.equal(j.clientes.disponible, true, 'la tabla de clientes no desaparece');
  assert.equal(j.clientes.filas.length, 2);
  assert.equal(j.resumen.te_han_pagado, 24.5);
  assert.equal(j.desde, null);
  assert.equal(j.hasta, null);
  assert.equal(j.rango_invalido, true);
  assert.match(j.aviso_rango, /«Desde» es posterior a «Hasta»/);
  assert.equal(j.hermes.coste_ia_rango, null);
  assert.equal(j.hermes.coste_ia_historico, 0.875);
  for (const campo of ['consumido_hermes_real_rango', 'cobrado_monedero_hermes_rango', 'consumido_hermes_cortesia_rango', 'resultado_real_rango']) {
    assert.equal(j.resumen[campo], null, campo);
  }
  assert.ok(j.clientes.filas.every((f) => f.rango === null));

  // Rentabilidad, con las mismas fechas: tampoco se intercambian; vacía pero con el mismo aviso
  const rent = await a.inject({ method: 'GET', url: '/api/marketplace/rentabilidad?desde=2026-11-20&hasta=2026-11-01' });
  assert.equal(rent.statusCode, 200);
  const rj = rent.json();
  assert.equal(rj.rango_invalido, true);
  assert.equal(rj.aviso_rango, j.aviso_rango);
  assert.deepEqual(rj.clientes, []);
  assert.equal(rj.totales, null);
});

test('una sola regla de fechas: un campo vacío o una fecha que no existe → del día 1 del mes a hoy, en Rentabilidad y en Dinero real', async () => {
  const a = await app();
  const hoy = diaNatural();
  const dia1 = `${hoy.slice(0, 8)}01`;

  // «Desde» vacío (el panel manda siempre las dos claves)
  let antes = llamadas.length;
  let r = await a.inject({ method: 'GET', url: `/api/marketplace/finanzas?desde=&hasta=${hoy}` });
  assert.equal(r.statusCode, 200);
  let j = r.json();
  let pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
  assert.equal(pedida.searchParams.get('desde'), dia1);
  assert.equal(pedida.searchParams.get('hasta'), hoy);
  assert.equal(j.desde, dia1);
  assert.equal(j.hasta, hoy);
  const rent = (await a.inject({ method: 'GET', url: `/api/marketplace/rentabilidad?desde=&hasta=${hoy}` })).json();
  assert.equal(rent.desde, dia1);
  assert.equal(j.hermes.coste_ia_rango, rent.totales.coste, 'el mismo periodo que la tabla de Rentabilidad');

  // fecha con buen formato pero imposible: ni 500 ni se manda al marketplace
  antes = llamadas.length;
  r = await a.inject({ method: 'GET', url: '/api/marketplace/finanzas?desde=2026-02-30' });
  assert.equal(r.statusCode, 200);
  j = r.json();
  pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
  assert.equal(pedida.searchParams.get('desde'), dia1);
  assert.equal(pedida.searchParams.get('hasta'), hoy);
  assert.equal(typeof j.hermes.coste_ia_rango, 'number');
  assert.equal(j.clientes.disponible, true);
  assert.equal(j.openrouter.claves_hermes.length, 2);

  const rr = await a.inject({ method: 'GET', url: '/api/marketplace/rentabilidad?desde=2026-02-30&hasta=2026-13-01' });
  assert.equal(rr.statusCode, 200);
  assert.equal(rr.json().desde, dia1);
  assert.equal(rr.json().hasta, hoy);

  assert.equal(diaValido('2026-02-28'), true);
  assert.equal(diaValido('2024-02-29'), true);
  for (const malo of ['2026-02-30', '2026-13-01', '2026-00-10', '0050-01-01', '2026-1-01', '', undefined, null, ['2026-01-01']]) {
    assert.equal(diaValido(malo), false, String(malo));
  }
});

test('el marketplace rechaza las fechas (400): el motivo habla de las fechas, no de «probar en un rato»', async () => {
  try {
    estado.md = { status: 400, body: { code: 'INVALID_RANGE', error: 'desde > hasta' } };
    let m = await finanzasMd({ desde: '2026-11-01', hasta: '2026-11-16', zona: 'Europe/Madrid' });
    assert.equal(m.disponible, false);
    assert.match(m.motivo, /«Desde» es posterior a «Hasta»/);
    assert.doesNotMatch(m.motivo, /en un rato/);

    estado.md = { status: 400, body: { code: 'INVALID_DATE', error: 'formato' } };
    m = await finanzasMd({ desde: '2026-11-01', hasta: '2026-11-16', zona: 'Europe/Madrid' });
    assert.match(m.motivo, /fechas/);
    assert.doesNotMatch(m.motivo, /en un rato/);

    estado.md = { status: 400, body: { error: 'otra cosa' } };
    m = await finanzasMd({ desde: '2026-11-01', hasta: '2026-11-16', zona: 'Europe/Madrid' });
    assert.match(m.motivo, /HTTP 400/);
    assert.doesNotMatch(m.motivo, /en un rato/);

    // y a través de la ruta: el panel enseña ese motivo y lo demás sigue
    estado.md = { status: 400, body: { code: 'INVALID_DATE', error: 'formato' } };
    const j = (await (await app()).inject({ method: 'GET', url: URL_RANGO })).json();
    assert.equal(j.clientes.disponible, false);
    assert.match(j.clientes.motivo, /fechas/);
    assert.equal(j.openrouter.claves_hermes.length, 2);

    // una fecha imposible ni siquiera sale hacia el marketplace
    estado.md = { status: 200, body: FINANZAS_OK };
    const antes = llamadas.length;
    await finanzasMd({ desde: '2026-02-30', hasta: '2026-11-16', zona: 'Europe/Madrid' });
    const pedida = new URL(llamadas.slice(antes).find((l) => l.url.startsWith('https://md.test/')).url);
    assert.equal(pedida.searchParams.get('desde'), null);
    assert.equal(pedida.searchParams.get('hasta'), '2026-11-16');
  } finally {
    estado.md = { status: 200, body: FINANZAS_OK };
  }
});

test('si falla la consulta del coste de la IA: 200, el coste y el resultado en null (nunca 0) y OpenRouter y los clientes siguen', async () => {
  const a = await app();
  fallos.costeIa = true;
  try {
    const r = await a.inject({ method: 'GET', url: URL_RANGO });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(fallos.costeIa, false, 'se ha simulado el fallo');
    assert.deepEqual(j.hermes, { coste_ia_historico: null, coste_ia_rango: null, coste_ia_archivo_historico: null });
    assert.equal(j.resumen.resultado_real_hermes, null);
    assert.equal(j.resumen.resultado_real_rango, null);
    assert.equal(j.resumen.consumido_hermes_real, 8.5, 'lo del marketplace no depende del coste');
    assert.equal(j.clientes.disponible, true);
    assert.equal(j.clientes.filas.length, 2);
    assert.equal(j.openrouter.claves_hermes.length, 2);
  } finally {
    fallos.costeIa = false;
  }
});

test('OpenRouter rechaza una clave (401): esa clave sale con error en español y sin la clave', async () => {
  await pg.exec(`INSERT INTO providers (id, name, base_url, api_key) VALUES (6, 'OpenRouter caducada', 'https://openrouter.ai/api/v1', 'sk-or-v1-CADUCADA-GGGG-0000000007')`);
  const a = await app();
  const r = await a.inject({ method: 'GET', url: `${URL_RANGO}&refrescar=1` });
  assert.ok(!r.payload.includes('sk-or-v1-CADUCADA-GGGG-0000000007'));
  const mala = r.json().openrouter.claves_hermes.find((c) => c.proveedores.some((p) => p.id === 6));
  assert.equal(mala.usage, null);
  assert.match(mala.error, /no acepta esta clave/);
  await pg.exec(`DELETE FROM providers WHERE id = 6`);
});

test('alertaOpenRouter (pura) y máscara de claves', () => {
  assert.equal(alertaOpenRouter({ configurada: false }, []).nivel, 'desconocido');
  assert.equal(alertaOpenRouter({ configurada: false }, [{ label: 'x', limit_remaining: 9 }]).nivel, 'ok');
  assert.equal(alertaOpenRouter({ configurada: false }, [{ label: 'x', limit_remaining: 1.5 }]).nivel, 'bajo');
  assert.equal(alertaOpenRouter({ configurada: true, saldo: 0.5 }, []).nivel, 'agotado');
  assert.equal(alertaOpenRouter({ configurada: true, saldo: 4.99 }, []).nivel, 'bajo');
  assert.equal(alertaOpenRouter({ configurada: true, saldo: 5 }, []).nivel, 'ok');
  const sinLeer = alertaOpenRouter({ configurada: true, saldo: null, error: 'OpenRouter no respondió en 8 s.' }, []);
  assert.equal(sinLeer.nivel, 'desconocido');
  assert.match(sinLeer.texto, /No se ha podido leer/);
  assert.equal(mascaraClave('sk-or-v1-0123456789abcdef'), 'sk-or-…cdef');
  assert.equal(mascaraClave('corta-12345'), '…');
  assert.equal(mascaraClave('media-123456789'), '…6789');
  assert.equal(mascaraClave(''), '');
});
