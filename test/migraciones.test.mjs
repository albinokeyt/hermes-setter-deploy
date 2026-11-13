import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseDePruebas } from './_pglite.mjs';

test('las 59 migraciones aplican en Postgres real (PGlite) y la 059 deja plantilla y corte', async () => {
  const pg = await baseDePruebas();
  const p = (await pg.query(`SELECT value FROM settings WHERE key = 'plantilla_conexion'`)).rows[0]?.value;
  assert.ok(p, 'existe plantilla_conexion');
  assert.equal(p.test_tag, 'test-setter');
  assert.equal(p.provider_id, null, 'sin setters en producción con deepseek → proveedor vacío');
  for (const k of ['identity', 'business', 'flow']) assert.match(p.prompt_partida[k], /\[\[RELLENAR/);
  assert.match(p.prompt_partida.identity, /la asistente virtual de/);
  const d = (await pg.query(`SELECT value FROM settings WHERE key = 'club_desde'`)).rows[0]?.value;
  assert.ok(d?.desde);
  const col = (await pg.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'tope_mensual_usd'`)).rows[0];
  assert.equal(col?.data_type, 'numeric');
  await pg.close();
});

test('la 059 elige el proveedor de OpenRouter que usan los setters en producción con deepseek-v4-pro', async () => {
  const pg = await baseDePruebas({ antesDe: '059' });
  await pg.exec(`
    INSERT INTO providers (id, name, base_url, api_key, default_model) VALUES
      (1, 'OpenRouter', 'https://openrouter.ai/api/v1', 'k', 'openai/gpt-4o-mini'),
      (2, 'OpenAI', 'https://api.openai.com/v1', 'k', 'gpt-4o');
    INSERT INTO accounts (id, name, location_id, webhook_token, ai_enabled) VALUES (10, 'A', 'locA', 't1', true), (11, 'B', 'locB', 't2', true), (12, 'C', 'locC', 't3', true);
    INSERT INTO setters (account_id, name, is_default, bot_enabled, provider_id, model) VALUES
      (10, 's', true, true, 1, 'deepseek/deepseek-v4-pro'),
      (11, 's', true, true, 1, 'deepseek/deepseek-v4-pro'),
      (12, 's', true, true, 2, 'deepseek-v4-pro');
  `);
  await pg.exec((await import('node:fs')).readFileSync(new URL('../src/migrations/059_club_conexiones_seguras.sql', import.meta.url), 'utf8'));
  const p = (await pg.query(`SELECT value FROM settings WHERE key = 'plantilla_conexion'`)).rows[0].value;
  assert.equal(p.provider_id, 1);
  assert.equal(p.model, 'deepseek/deepseek-v4-pro');
  await pg.close();
});
