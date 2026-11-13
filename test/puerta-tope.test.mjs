// Puerta del marketplace con el TOPE de gasto: puedeAtender corta al llegar al tope y puedeProbar (pruebas a 0) no.
// marketplace.js importa Postgres, Redis y BullMQ: se sustituyen por dobles (node --experimental-test-module-mocks).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const consumos = new Map(); // account_id → suma del mes (lo que devolvería llm_usage)
const eventos = [];
const poolFalso = {
  query: async (text, params) => {
    if (/FROM llm_usage/.test(text)) return { rows: [{ c: consumos.get(params[0]) || 0 }] };
    return { rows: [] };
  },
};
const u = (p) => new URL(p, import.meta.url).href;
mock.module(u('../src/db.js'), {
  namedExports: {
    pool: poolFalso,
    q: async () => [],
    one: async () => null,
    getSetting: async (_k, fb = null) => fb,
  },
});
mock.module(u('../src/lib/redis.js'), {
  namedExports: { redis: { set: async () => 'OK', get: async () => null, del: async () => 1, incr: async () => 1, expire: async () => 1 } },
});
mock.module(u('../src/queues.js'), { namedExports: { chargeQueue: { add: async () => ({}) } } });
mock.module(u('../src/services/facturacion.js'), { namedExports: { getFacturacion: async () => ({ multiplicador: 2, fuentes: [] }) } });
mock.module(u('../src/services/pipeline.js'), { namedExports: { logEvent: async (kind, payload) => { eventos.push({ kind, payload }); } } });

delete process.env.MD_API_KEY; // integración del marketplace APAGADA: sin el tope, todo se atiende
const { puedeAtender, puedeProbar } = await import('../src/services/marketplace.js');

test('sin tope (NULL): se atiende como siempre y no se consulta el consumo', async () => {
  consumos.set(1, 999);
  const r = await puedeAtender({ id: 1, location_id: 'loc1', tope_mensual_usd: null });
  assert.equal(r.atender, true);
  assert.equal(r.motivo, 'integracion_apagada');
});

test('con tope alcanzado: puedeAtender NO atiende (motivo tope_mensual) y deja el evento', async () => {
  consumos.set(2, 25);
  const r = await puedeAtender({ id: 2, location_id: 'loc2', tope_mensual_usd: '20.00', timezone: 'Europe/Madrid' });
  assert.equal(r.atender, false);
  assert.equal(r.motivo, 'tope_mensual');
  assert.equal(r.tope, 20);
  assert.ok(eventos.some((e) => e.kind === 'tope_mensual_alcanzado' && e.payload.account === 2));
});

test('con tope sin alcanzar: se atiende', async () => {
  consumos.set(3, 4.99);
  const r = await puedeAtender({ id: 3, location_id: 'loc3', tope_mensual_usd: 5 });
  assert.equal(r.atender, true);
});

test('las PRUEBAS del panel (van a 0) no las corta el tope: puedeProbar solo mira el saldo', async () => {
  consumos.set(4, 100);
  const cuenta = { id: 4, location_id: 'loc4', tope_mensual_usd: 10 };
  assert.equal((await puedeAtender(cuenta)).atender, false, 'el setter sí está cortado');
  assert.equal(await puedeProbar({ auth: { role: 'user' } }, cuenta), true);
});
