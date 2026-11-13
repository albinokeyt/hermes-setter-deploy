import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseDePruebas } from './_pglite.mjs';
import { inicioMes, sanearTope, topeDe, comprobarTope, zonaValida } from '../src/services/tope.js';

test('inicio del mes natural en la zona de la conexión', () => {
  // 13-nov-2026 12:00 UTC → en Madrid (UTC+1 en noviembre) el mes empezó el 31-oct 23:00 UTC
  assert.equal(inicioMes('Europe/Madrid', new Date('2026-11-13T12:00:00Z')).toISOString(), '2026-10-31T23:00:00.000Z');
  // 1-jul en Madrid (UTC+2)
  assert.equal(inicioMes('Europe/Madrid', new Date('2026-07-15T00:00:00Z')).toISOString(), '2026-06-30T22:00:00.000Z');
  // 31-oct 23:30 UTC ya es 1-nov en Madrid
  assert.equal(inicioMes('Europe/Madrid', new Date('2026-10-31T23:30:00Z')).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(inicioMes('UTC', new Date('2026-11-13T12:00:00Z')).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(inicioMes('America/Mexico_City', new Date('2026-11-01T03:00:00Z')).toISOString(), '2026-10-01T06:00:00.000Z');
  assert.equal(zonaValida('No/Existe'), 'Europe/Madrid');
});

test('saneado del tope', () => {
  assert.deepEqual(sanearTope(''), { ok: true, valor: null });
  assert.deepEqual(sanearTope(null), { ok: true, valor: null });
  assert.deepEqual(sanearTope('12,345'), { ok: true, valor: 12.35 });
  assert.deepEqual(sanearTope('20.00'), { ok: true, valor: 20 });
  assert.equal(sanearTope(0).ok, false);
  assert.equal(sanearTope(-3).ok, false);
  assert.equal(sanearTope('abc').ok, false);
  assert.equal(sanearTope(1e9).ok, false);
  assert.equal(topeDe({ tope_mensual_usd: '15.50' }), 15.5);
  assert.equal(topeDe({ tope_mensual_usd: null }), null);
  assert.equal(topeDe({}), null);
});

test('comprobarTope suma el precio al cliente del mes y corta al llegar', async () => {
  const pg = await baseDePruebas();
  await pg.exec(`
    INSERT INTO accounts (id, name, location_id, webhook_token, tope_mensual_usd, timezone) VALUES (5, 'T', 'locT', 'tk', 2.00, 'Europe/Madrid');
    INSERT INTO llm_usage (account_id, model, prompt_tokens, completion_tokens, cost_usd, billed_usd, source, created_at) VALUES
      (5, 'm', 1, 1, 0.5, 1.00, 'reply', '2026-11-05T10:00:00Z'),
      (5, 'm', 1, 1, 0.3, 0.60, 'seguimiento', '2026-11-10T10:00:00Z'),
      (5, 'm', 1, 1, 0.9, 0, 'playground', '2026-11-10T10:00:00Z'),
      (5, 'm', 1, 1, 5, 10.00, 'reply', '2026-10-20T10:00:00Z');
  `);
  const acc = (await pg.query(`SELECT * FROM accounts WHERE id = 5`)).rows[0];
  const ahora = new Date('2026-11-13T12:00:00Z');
  let t = await comprobarTope(acc, pg, ahora);
  assert.equal(t.alcanzado, false);
  assert.equal(t.consumo, 1.6, 'octubre y las pruebas no cuentan');
  await pg.exec(`INSERT INTO llm_usage (account_id, model, prompt_tokens, completion_tokens, cost_usd, billed_usd, source, created_at) VALUES (5, 'm', 1, 1, 0.2, 0.40, 'reply', '2026-11-12T10:00:00Z')`);
  t = await comprobarTope(acc, pg, ahora);
  assert.equal(t.alcanzado, true, 'llegar al tope ya corta');
  // sin tope: no consulta y siempre atiende
  t = await comprobarTope({ ...acc, tope_mensual_usd: null }, pg, ahora);
  assert.equal(t.alcanzado, false);
  // mes siguiente: vuelve a 0
  t = await comprobarTope(acc, pg, new Date('2026-12-02T12:00:00Z'));
  assert.equal(t.alcanzado, false);
  assert.equal(t.consumo, 0);
  await pg.close();
});
