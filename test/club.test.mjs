import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Fastify from 'fastify';
import { baseDePruebas } from './_pglite.mjs';
import {
  crearConexionNueva, aplicarEstadoClub, aplicarPendientePorEmail, validarCuerpoClub, secretoValido,
  promptSinRellenar, sanearPlantilla,
} from '../src/services/club.js';
import clubRoutes from '../src/routes/club.js';
// las funciones nuevas de la fase C se leen del módulo en tiempo de ejecución (si faltan, solo fallan sus pruebas)
import * as club from '../src/services/club.js';

const SECRETO = 'x'.repeat(48);
// la 059 y TODAS las siguientes (060 devoluciones, 061 correos del Club…): el esquema real de producción
const DIR_MIG = new URL('../src/migrations/', import.meta.url);
const SQL_DESDE_059 = fs.readdirSync(DIR_MIG).filter((f) => f.endsWith('.sql') && f >= '059').sort()
  .map((f) => fs.readFileSync(new URL(f, DIR_MIG), 'utf8'));

// conexión «antigua» (anterior al Club) creada ANTES de aplicar la 059
async function baseConAntigua() {
  const pg = await baseDePruebas({ antesDe: '059' });
  await pg.exec(`
    INSERT INTO accounts (id, name, location_id, webhook_token, ai_enabled, owner_email, authorized_emails, created_at)
    VALUES (1, 'DEP', 'locAntigua01', 'tokA', true, 'cliente@x.com', '["cliente@x.com"]', now() - interval '30 days');
    INSERT INTO setters (account_id, name, is_default) VALUES (1, 'Setter principal', true);
    SELECT setval('accounts_id_seq', 100);
  `);
  for (const sql of SQL_DESDE_059) await pg.exec(sql);
  return pg;
}
const ai = async (pg, id) => (await pg.query(`SELECT ai_enabled FROM accounts WHERE id = $1`, [id])).rows[0].ai_enabled;

test('la cuenta antigua NO cambia con la migración (sigue sin modo prueba)', async () => {
  const pg = await baseConAntigua();
  const a = (await pg.query(`SELECT test_mode, ai_enabled, tope_mensual_usd, club_estado_at FROM accounts WHERE id = 1`)).rows[0];
  assert.equal(a.test_mode, false);
  assert.equal(a.ai_enabled, true);
  assert.equal(a.tope_mensual_usd, null);
  assert.equal(a.club_estado_at, null);
  const s = (await pg.query(`SELECT prompt_identity, provider_id FROM setters WHERE account_id = 1`)).rows[0];
  assert.equal(s.prompt_identity, '', 'su setter no recibe la plantilla');
  assert.equal(s.provider_id, null);
  await pg.close();
});

test('conexión nueva: nace en modo prueba con test-setter y el setter copia la plantilla', async () => {
  const pg = await baseConAntigua();
  await pg.exec(`INSERT INTO providers (id, name, base_url, api_key) VALUES (7, 'OR', 'https://openrouter.ai/api/v1', 'k')`);
  await pg.query(`UPDATE settings SET value = jsonb_set(jsonb_set(value, '{provider_id}', '7'), '{model}', '"deepseek/deepseek-v4-pro"') WHERE key = 'plantilla_conexion'`);
  const { account, creada } = await crearConexionNueva({ name: 'Nueva', locationId: 'locNueva0001', conPortalKey: true, origen: 'sso' }, pg);
  assert.equal(creada, true);
  assert.equal(account.test_mode, true);
  assert.equal(account.test_tag, 'test-setter');
  assert.ok(account.portal_key);
  const s = (await pg.query(`SELECT * FROM setters WHERE account_id = $1`, [account.id])).rows;
  assert.equal(s.length, 1);
  assert.equal(s[0].is_default, true);
  assert.equal(s[0].provider_id, 7);
  assert.equal(s[0].model, 'deepseek/deepseek-v4-pro');
  assert.match(s[0].prompt_identity, /asistente virtual/);
  assert.equal(promptSinRellenar(s[0]), true);
  assert.equal(promptSinRellenar({ prompt_identity: 'Soy Ana', prompt_business: 'x', prompt_flow: 'y' }), false);
  // segunda llamada: reutiliza, no duplica
  const otra = await crearConexionNueva({ name: 'Nueva', locationId: 'locNueva0001' }, pg);
  assert.equal(otra.creada, false);
  assert.equal(otra.account.id, account.id);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM setters WHERE account_id = $1`, [account.id])).rows[0].n, 1);
  await pg.close();
});

test('conexión nueva: si la API de la plantilla ya no existe, nace sin proveedor (no falla la instalación)', async () => {
  const pg = await baseConAntigua();
  await pg.query(`UPDATE settings SET value = jsonb_set(value, '{provider_id}', '999') WHERE key = 'plantilla_conexion'`);
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locNueva0002' }, pg);
  const s = (await pg.query(`SELECT provider_id, model FROM setters WHERE account_id = $1`, [account.id])).rows[0];
  assert.equal(s.provider_id, null);
  assert.equal(s.model, '');
  assert.equal(account.portal_key, null, 'OAuth no crea portal_key (como antes)');
  await pg.close();
});

test('conexión nueva: dos altas a la vez de la misma subcuenta crean UNA sola conexión', async () => {
  const pg = await baseConAntigua();
  const [a, b] = await Promise.all([
    crearConexionNueva({ name: 'A', locationId: 'locCarrera01' }, pg),
    crearConexionNueva({ name: 'B', locationId: 'locCarrera01' }, pg),
  ]);
  assert.equal(a.account.id, b.account.id);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM accounts WHERE location_id = 'locCarrera01'`)).rows[0].n, 1);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM setters WHERE account_id = $1`, [a.account.id])).rows[0].n, 1);
  await pg.close();
});

test('club por location_id: apaga, es idempotente y vuelve a encender', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locNueva0003' }, pg);
  let r = await aplicarEstadoClub({ location_id: 'locNueva0003', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 200); assert.equal(r.body.resultado, 'aplicado');
  assert.equal(await ai(pg, account.id), false);
  r = await aplicarEstadoClub({ location_id: 'locNueva0003', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 200); assert.equal(r.body.resultado, 'sin_cambios');
  r = await aplicarEstadoClub({ location_id: 'locNueva0003', activo: true, motivo: 'pago recuperado' }, pg);
  assert.equal(r.body.resultado, 'aplicado');
  assert.equal(await ai(pg, account.id), true);
  const ev = (await pg.query(`SELECT resultado FROM club_eventos ORDER BY id`)).rows.map((x) => x.resultado);
  assert.deepEqual(ev, ['aplicado', 'sin_cambios', 'aplicado']);
  assert.equal(await ai(pg, 1), true, 'la antigua no se ha tocado');
  await pg.close();
});

test('club por location_id sin conexión: queda pendiente (202) y se aplica al crearse', async () => {
  const pg = await baseConAntigua();
  const r = await aplicarEstadoClub({ location_id: 'locFutura001', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202); assert.equal(r.body.resultado, 'pendiente');
  const { account } = await crearConexionNueva({ name: 'F', locationId: 'locFutura001' }, pg);
  assert.equal(account.ai_enabled, false);
  assert.equal(await ai(pg, account.id), false);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_estado_pendiente`)).rows[0].n, 0);
  await pg.close();
});

test('club por correo: NUNCA toca una conexión anterior al Club aunque coincida el correo', async () => {
  const pg = await baseConAntigua();
  const r = await aplicarEstadoClub({ email: 'cliente@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202); assert.equal(r.body.resultado, 'pendiente');
  assert.equal(await ai(pg, 1), true);
  const ev = (await pg.query(`SELECT detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0].detalle;
  assert.match(ev.antiguas, /no se tocan/);
  await pg.close();
});

test('club por correo: una conexión nueva → se aplica; dos → ambiguo, no toca nada', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locNuevaA001' }, pg)).account;
  await pg.query(`UPDATE accounts SET owner_email = 'compra@x.com' WHERE id = $1`, [a.id]);
  let r = await aplicarEstadoClub({ email: 'compra@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 200); assert.deepEqual(r.body.cuentas, [a.id]);
  assert.equal(await ai(pg, a.id), false);
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locNuevaB001' }, pg)).account;
  await pg.query(`UPDATE accounts SET owner_email = 'compra@x.com' WHERE id = $1`, [b.id]);
  r = await aplicarEstadoClub({ email: 'compra@x.com', activo: true, motivo: 'alta' }, pg);
  assert.equal(r.code, 202); assert.equal(r.body.resultado, 'ambiguo');
  assert.equal(await ai(pg, a.id), false, 'nada cambia en la ambigüedad');
  assert.equal(await ai(pg, b.id), true);
  await pg.close();
});

// lo que hace el SSO (portal.js · claimOwner): el primer usuario certificado por GHL queda como responsable
const reclamar = (pg, id, email) => pg.query(`UPDATE accounts SET owner_email = $2 WHERE id = $1 AND owner_email = ''`, [id, email]);

test('club por correo sin conexión: pendiente que se aplica cuando su RESPONSABLE entra por SSO en una conexión NUEVA, una sola vez', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'futura@x.com', activo: false, motivo: 'baja antes de conectar' }, pg);
  assert.equal(await aplicarPendientePorEmail(1, 'futura@x.com', pg), null, 'conexión antigua: no se aplica');
  assert.equal(await ai(pg, 1), true);
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locNueva0009' }, pg);
  await reclamar(pg, account.id, 'futura@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'Futura@X.com', pg), { activo: false });
  assert.equal(await ai(pg, account.id), false);
  assert.equal(await aplicarPendientePorEmail(account.id, 'futura@x.com', pg), null, 'consumido');
  const ev = (await pg.query(`SELECT resultado, detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.resultado, 'pendiente_aplicado');
  assert.equal(ev.detalle.via, 'correo_sso');
  await pg.close();
});

test('seguridad: los «correos autorizados» (los edita el cliente) NO resuelven el correo del Club', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locClienteA1' }, pg)).account;
  await aplicarEstadoClub({ location_id: 'locClienteA1', activo: false, motivo: 'impago A' }, pg);
  // A (responsable) mete el correo de B en su pestaña Accesos
  await pg.query(`UPDATE accounts SET owner_email = 'a@x.com', authorized_emails = '["a@x.com","b@x.com"]' WHERE id = $1`, [a.id]);
  const r = await aplicarEstadoClub({ email: 'b@x.com', activo: true, motivo: 'alta B' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'pendiente', 'el alta de B queda pendiente para B');
  assert.equal(await ai(pg, a.id), false, 'A sigue apagado: no se queda con el alta de B');
  // B crea SU conexión y entra como responsable → ahí sí se aplica
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locClienteB1' }, pg)).account;
  await pg.query(`UPDATE accounts SET ai_enabled = false WHERE id = $1`, [b.id]);
  await reclamar(pg, b.id, 'b@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(b.id, 'b@x.com', pg), { activo: true });
  assert.equal(await ai(pg, b.id), true);
  assert.equal(await ai(pg, a.id), false);
  await pg.close();
});

test('seguridad: un miembro del equipo que entra por SSO en la subcuenta de OTRO cliente no le aplica su pendiente', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locClienteA2' }, pg)).account;
  await reclamar(pg, a.id, 'a@x.com');
  await aplicarEstadoClub({ email: 'b@x.com', activo: false, motivo: 'baja B antes de conectar' }, pg);
  assert.equal(await aplicarPendientePorEmail(a.id, 'b@x.com', pg), null);
  assert.equal(await ai(pg, a.id), true, 'A no se apaga por la baja de B');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_estado_pendiente WHERE clave = 'email:b@x.com'`)).rows[0].n, 1, 'el pendiente de B sigue esperando a B');
  await pg.close();
});

test('pendiente por correo con el responsable al frente de DOS conexiones nuevas: ambiguo, no toca nada', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locDoble0001' }, pg)).account;
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locDoble0002' }, pg)).account;
  await aplicarEstadoClub({ email: 'doble@x.com', activo: false, motivo: 'baja' }, pg); // aún sin responsable: pendiente
  await reclamar(pg, a.id, 'doble@x.com');
  await reclamar(pg, b.id, 'doble@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(a.id, 'doble@x.com', pg), { ambiguo: true });
  assert.equal(await ai(pg, a.id), true);
  assert.equal(await ai(pg, b.id), true);
  const ev = (await pg.query(`SELECT resultado FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.resultado, 'ambiguo');
  await pg.close();
});

test('orden: un alta vieja pendiente por correo NO reenciende una conexión apagada después por impago (subcuenta)', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'compra@x.com', activo: true, motivo: 'alta' }, pg); // pendiente (aún sin responsable)
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0001' }, pg);
  await aplicarEstadoClub({ location_id: 'locOrden0001', activo: false, motivo: 'impago' }, pg);
  await reclamar(pg, account.id, 'compra@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'compra@x.com', pg), { obsoleto: true });
  assert.equal(await ai(pg, account.id), false, 'sigue apagada por el impago');
  const ev = (await pg.query(`SELECT resultado FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.resultado, 'pendiente_obsoleto');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_estado_pendiente`)).rows[0].n, 0, 'consumido');
  await pg.close();
});

test('orden: alta por correo y baja por subcuenta, las dos antes de existir la conexión → manda la baja (la más reciente)', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'compra2@x.com', activo: true, motivo: 'alta' }, pg);
  await aplicarEstadoClub({ location_id: 'locOrden0002', activo: false, motivo: 'baja' }, pg);
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0002' }, pg);
  assert.equal(account.ai_enabled, false);
  await reclamar(pg, account.id, 'compra2@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'compra2@x.com', pg), { obsoleto: true });
  assert.equal(await ai(pg, account.id), false);
  await pg.close();
});

test('orden: un estado por correo MÁS RECIENTE que el último aplicado sí se aplica al entrar el responsable', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0003' }, pg);
  await aplicarEstadoClub({ location_id: 'locOrden0003', activo: false, motivo: 'impago' }, pg);
  await aplicarEstadoClub({ email: 'compra3@x.com', activo: true, motivo: 'pago recuperado' }, pg); // aún sin responsable
  await reclamar(pg, account.id, 'compra3@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'compra3@x.com', pg), { activo: true });
  assert.equal(await ai(pg, account.id), true);
  await pg.close();
});

test('orden: el admin apaga la IA a mano (PUT /api/accounts) → un alta vieja pendiente ya no la reenciende', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0004' }, pg);
  await aplicarEstadoClub({ email: 'compra4@x.com', activo: true, motivo: 'alta' }, pg); // pendiente
  // el mismo SET que arma routes/accounts.js para el admin (guardar SIN cambiar no marca nada)
  const setAdmin = `UPDATE accounts SET ai_enabled = $1, club_estado_at = CASE WHEN ai_enabled IS DISTINCT FROM $1::boolean THEN now() ELSE club_estado_at END WHERE id = $2 RETURNING club_estado_at`;
  let r = await pg.query(setAdmin, [true, account.id]);
  assert.equal(r.rows[0].club_estado_at, null, 'guardar el mismo valor no cuenta como decisión');
  r = await pg.query(setAdmin, [false, account.id]);
  assert.ok(r.rows[0].club_estado_at, 'apagar a mano sí');
  await reclamar(pg, account.id, 'compra4@x.com');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'compra4@x.com', pg), { obsoleto: true });
  assert.equal(await ai(pg, account.id), false);
  const src = fs.readFileSync(new URL('../src/routes/accounts.js', import.meta.url), 'utf8');
  assert.match(src, /club_estado_at = CASE WHEN ai_enabled IS DISTINCT FROM \$\$\{vals\.length\}::boolean THEN now\(\) ELSE club_estado_at END/);
  await pg.close();
});

test('el corte de «conexión nueva» se compara en SQL con microsegundos (1 µs antes = antigua)', async () => {
  const pg = await baseConAntigua();
  await pg.query(`UPDATE settings SET value = jsonb_build_object('desde', '2026-11-13T10:00:00.123456+00:00'::timestamptz) WHERE key = 'club_desde'`);
  await pg.exec(`
    INSERT INTO accounts (id, name, location_id, webhook_token, created_at) VALUES
      (201, 'justo antes', 'locMicro0001', 'tkm1', '2026-11-13T10:00:00.123455+00:00'),
      (202, 'justo en el corte', 'locMicro0002', 'tkm2', '2026-11-13T10:00:00.123456+00:00');
  `);
  let r = await aplicarEstadoClub({ location_id: 'locMicro0001', activo: false, motivo: 'x' }, pg);
  assert.equal(r.body.resultado, 'protegida', 'en JS (ms) habría pasado por nueva');
  r = await aplicarEstadoClub({ location_id: 'locMicro0002', activo: false, motivo: 'x' }, pg);
  assert.equal(r.body.resultado, 'aplicado');
  await pg.close();
});

test('un pendiente de subcuenta caducado (más de 60 días) no se aplica al crear la conexión', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ location_id: 'locViejo0001', activo: false, motivo: 'baja antigua' }, pg);
  await pg.query(`UPDATE club_estado_pendiente SET updated_at = now() - interval '61 days'`);
  const { account } = await crearConexionNueva({ name: 'V', locationId: 'locViejo0001' }, pg);
  assert.equal(account.ai_enabled, true);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_estado_pendiente`)).rows[0].n, 0, 'se consume igualmente');
  await pg.close();
});

test('club por location_id: una conexión ANTERIOR al Club está protegida (p. ej. {{location.id}} de 4ttZ)', async () => {
  const pg = await baseConAntigua();
  const r = await aplicarEstadoClub({ location_id: 'locAntigua01', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202); assert.equal(r.body.resultado, 'protegida');
  assert.equal(await ai(pg, 1), true);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM club_estado_pendiente`)).rows[0].n, 0);
  await pg.close();
});

// ── Fase C · 4) cliente sin location_id: el correo del Club también es el de la subcuenta en GHL o el que pone el admin ──
const SOPORTE = 'soporte@departamentodisruptivo.com';
const pendientes = async (pg) => (await pg.query(`SELECT clave, activo FROM club_estado_pendiente ORDER BY clave`)).rows;
const ultimoEvento = async (pg) => (await pg.query(`SELECT resultado, activo, cuentas, detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];

test('cliente sin location_id: soporte abrió Hermes primero y el comprador es el correo de la subcuenta → la baja y el alta por correo llegan', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locSoporte01' }, pg);
  await reclamar(pg, account.id, SOPORTE); // el primer usuario que entró por SSO fue soporte
  assert.equal(await ai(pg, account.id), true, 'nace encendida (migración 045)');
  // antes de enlazar el correo de la subcuenta: la baja del comprador no encuentra nada (el fallo de la fase B)
  let r = await aplicarEstadoClub({ email: 'comprador@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'pendiente');
  // Hermes lee el correo de la subcuenta en GHL (al crear o reconectar) → se enlaza y se aplica ese pendiente
  const v = await club.vincularCorreoSubcuenta({ accountId: account.id, correo: ' Comprador@X.com ', origen: 'oauth' }, pg);
  assert.equal(v.estado, 'guardado');
  assert.deepEqual(v.pendiente, { activo: false });
  assert.equal(await ai(pg, account.id), false, 'la baja que esperaba se aplica al enlazar');
  assert.equal((await pg.query(`SELECT ghl_location_email FROM accounts WHERE id = $1`, [account.id])).rows[0].ghl_location_email, 'comprador@x.com');
  // a partir de ahí, el alta y la baja por correo van directas a SU conexión (200)
  r = await aplicarEstadoClub({ email: 'comprador@x.com', activo: true, motivo: 'pago recuperado' }, pg);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cuentas, [account.id]);
  assert.equal(await ai(pg, account.id), true);
  assert.deepEqual(await pendientes(pg), [], 'no queda nada colgado');
  await pg.close();
});

test('pendientes: lo que llegó por correo ANTES de existir la conexión se aplica al enlazarla (el ÚLTIMO estado) y queda como aplicado', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'compra@x.com', activo: true, motivo: 'alta' }, pg); // 202 pendiente
  await aplicarEstadoClub({ email: 'compra@x.com', activo: false, motivo: 'baja' }, pg); // 202: pisa al anterior
  assert.deepEqual(await pendientes(pg), [{ clave: 'email:compra@x.com', activo: false }], 'se guarda solo el último');
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locPend00001' }, pg);
  await reclamar(pg, account.id, SOPORTE);
  const v = await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'compra@x.com', origen: 'sso' }, pg);
  assert.deepEqual(v.pendiente, { activo: false });
  assert.equal(await ai(pg, account.id), false, 'manda la baja (la última)');
  assert.deepEqual(await pendientes(pg), [], 'consumido');
  const ev = await ultimoEvento(pg);
  assert.equal(ev.resultado, 'pendiente_aplicado', 'marcado como aplicado en el registro durable (club_eventos)');
  assert.equal(ev.activo, false);
  assert.deepEqual(ev.cuentas, [account.id]);
  assert.equal(ev.detalle.via, 'correo_subcuenta');
  const log = (await pg.query(`SELECT payload FROM webhook_log WHERE kind = 'club_estado_pendiente_aplicado' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(log.payload.via, 'correo_subcuenta');
  await pg.close();
});

test('pendientes: también al poner el admin el correo del Club (club_email); y club_email MANDA sobre el responsable y el de la subcuenta', async () => {
  const pg = await baseConAntigua();
  const { account: a } = await crearConexionNueva({ name: 'A', locationId: 'locClubE0001' }, pg);
  await reclamar(pg, a.id, SOPORTE);
  await club.vincularCorreoSubcuenta({ accountId: a.id, correo: 'info@empresa.com' }, pg); // la subcuenta tiene OTRO correo
  let r = await aplicarEstadoClub({ email: 'personal@gmail.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.body.resultado, 'pendiente', 'el correo de la compra no es el de la subcuenta');
  // lo que hace el PUT del admin (routes/accounts.js): guarda club_email y aplica los pendientes de la conexión
  await pg.query(`UPDATE accounts SET club_email = 'personal@gmail.com' WHERE id = $1`, [a.id]);
  assert.deepEqual(await club.aplicarPendientesDeConexion(a.id, pg, { via: 'club_email' }), [{ activo: false }]);
  assert.equal(await ai(pg, a.id), false);
  assert.equal((await ultimoEvento(pg)).detalle.via, 'club_email');
  // club_email manda: ni el correo de la subcuenta ni el del responsable encuentran ya esta conexión
  r = await aplicarEstadoClub({ email: 'info@empresa.com', activo: true, motivo: 'x' }, pg);
  assert.equal(r.body.resultado, 'pendiente');
  r = await aplicarEstadoClub({ email: SOPORTE, activo: true, motivo: 'x' }, pg);
  assert.equal(r.body.resultado, 'pendiente');
  assert.equal(await ai(pg, a.id), false);
  r = await aplicarEstadoClub({ email: 'personal@gmail.com', activo: true, motivo: 'pago recuperado' }, pg);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cuentas, [a.id]);
  assert.equal(await ai(pg, a.id), true);
  // un pendiente de un correo que ya no es suyo no se le aplica
  assert.deepEqual(await club.aplicarPendientesDeConexion(a.id, pg), []);
  assert.equal(await ai(pg, a.id), true);
  await pg.close();
});

test('por correo: el mismo correo en DOS conexiones del Club (en cualquiera de los tres campos) → ambiguo, no se toca nada', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locAmbig0001' }, pg)).account;
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locAmbig0002' }, pg)).account;
  await club.vincularCorreoSubcuenta({ accountId: a.id, correo: 'x@x.com' }, pg);
  await reclamar(pg, b.id, 'x@x.com');
  let r = await aplicarEstadoClub({ email: 'x@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'ambiguo');
  assert.equal(await ai(pg, a.id), true);
  assert.equal(await ai(pg, b.id), true);
  // el admin desambigua con club_email en A → ya solo queda B
  await pg.query(`UPDATE accounts SET club_email = 'a@x.com' WHERE id = $1`, [a.id]);
  r = await aplicarEstadoClub({ email: 'x@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cuentas, [b.id]);
  assert.equal(await ai(pg, a.id), true);
  assert.equal(await ai(pg, b.id), false);
  // un pendiente cuyo correo está en dos conexiones al enlazar: ambiguo, no toca ninguna
  const c = (await crearConexionNueva({ name: 'C', locationId: 'locAmbig0003' }, pg)).account;
  const d = (await crearConexionNueva({ name: 'D', locationId: 'locAmbig0004' }, pg)).account;
  await aplicarEstadoClub({ email: 'dos@x.com', activo: false, motivo: 'baja' }, pg); // pendiente
  await reclamar(pg, c.id, 'dos@x.com');
  const v = await club.vincularCorreoSubcuenta({ accountId: d.id, correo: 'dos@x.com' }, pg);
  assert.deepEqual(v.pendiente, { ambiguo: true });
  assert.equal(await ai(pg, c.id), true);
  assert.equal(await ai(pg, d.id), true);
  await pg.close();
});

test('correo de la subcuenta: solo en conexiones del Club, en minúsculas, NO se pisa (queda el primero) y nunca lanza', async () => {
  const pg = await baseConAntigua();
  // conexión ANTERIOR al Club: ni se pide ni se guarda
  assert.equal(await club.quiereCorreoSubcuenta(1, pg), false);
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: 1, correo: 'cliente@x.com' }, pg)).estado, 'anterior_al_club');
  assert.equal((await pg.query(`SELECT ghl_location_email FROM accounts WHERE id = 1`)).rows[0].ghl_location_email, null);
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locCorreo001' }, pg);
  assert.equal(await club.quiereCorreoSubcuenta(account.id, pg), true);
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'no-es-un-correo' }, pg)).estado, 'sin_correo');
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: account.id, correo: '' }, pg)).estado, 'sin_correo');
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'Primero@X.com' }, pg)).estado, 'guardado');
  assert.equal(await club.quiereCorreoSubcuenta(account.id, pg), false, 'ya lo tiene: no se vuelve a pedir a GHL');
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'primero@x.com' }, pg)).estado, 'ya_estaba');
  // si luego el cliente cambia el correo de su subcuenta en GHL, NO se sigue solo (si no, podría quedarse con el estado
  // del Club de otra persona): queda el primero y se anota para soporte
  const dist = await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'otro@x.com' }, pg);
  assert.equal(dist.estado, 'distinto');
  const fila = (await pg.query(`SELECT ghl_location_email, ghl_location_email_at FROM accounts WHERE id = $1`, [account.id])).rows[0];
  assert.equal(fila.ghl_location_email, 'primero@x.com');
  assert.ok(fila.ghl_location_email_at);
  assert.ok((await pg.query(`SELECT 1 FROM webhook_log WHERE kind = 'club_correo_subcuenta_distinto'`)).rows.length);
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: 999999, correo: 'a@b.com' }, pg)).estado, 'no_existe');
  assert.equal(await club.quiereCorreoSubcuenta(999999, pg), false);
  // la base rota no tumba la conexión: devuelve un estado de error
  const rota = { ...pg, query: () => Promise.reject(new Error('caída')), connect: async () => { throw new Error('caída'); } };
  assert.equal((await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'a@b.com' }, rota)).estado, 'error');
  assert.equal(await club.quiereCorreoSubcuenta(account.id, rota), false);
  await pg.close();
});

test('club_email: validación (minúsculas, correo válido o vacío) y la base no admite dos conexiones con el mismo', async () => {
  const pg = await baseConAntigua();
  assert.deepEqual(club.sanearClubEmail(' Compra@Gmail.COM '), { ok: true, valor: 'compra@gmail.com' });
  assert.deepEqual(club.sanearClubEmail(''), { ok: true, valor: null });
  assert.deepEqual(club.sanearClubEmail(null), { ok: true, valor: null });
  for (const malo of ['no-es-correo', 'a@b', 'a b@c.com', `${'x'.repeat(250)}@x.com`, '{{contact.email}}', 42, ['a@b.com']]) {
    assert.equal(club.sanearClubEmail(malo).ok, false, String(malo));
  }
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locUnico0001' }, pg)).account;
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locUnico0002' }, pg)).account;
  await pg.query(`UPDATE accounts SET club_email = 'uno@x.com' WHERE id = $1`, [a.id]);
  await assert.rejects(pg.query(`UPDATE accounts SET club_email = 'uno@x.com' WHERE id = $1`, [b.id]), /duplicate|unique|único/i);
  await assert.rejects(pg.query(`UPDATE accounts SET club_email = 'Mayus@x.com' WHERE id = $1`, [b.id]), /check|minusculas|violates/i);
  await pg.query(`UPDATE accounts SET club_email = NULL WHERE id = $1`, [a.id]);
  await pg.query(`UPDATE accounts SET club_email = 'uno@x.com' WHERE id = $1`, [b.id]);
  await pg.close();
});

test('enlazar el correo y el interruptor a la vez (mismo correo): nunca se pierde el estado ni queda pendiente colgado', async () => {
  for (const orden of ['enlace_primero', 'estado_primero']) {
    const pg = await baseConAntigua();
    const { account } = await crearConexionNueva({ name: 'N', locationId: `locVez${orden.slice(0, 6)}` }, pg);
    const enlace = () => club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'vez@x.com' }, pg);
    const estado = () => aplicarEstadoClub({ email: 'vez@x.com', activo: false, motivo: 'baja' }, pg);
    await Promise.all(orden === 'enlace_primero' ? [enlace(), estado()] : [estado(), enlace()]);
    assert.equal(await ai(pg, account.id), false, orden);
    assert.deepEqual(await pendientes(pg), [], orden);
    await pg.close();
  }
});

test('SSO: el pendiente del COMPRADOR se aplica cuando entra él aunque el responsable sea soporte (correo de la subcuenta)', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locSSO000001' }, pg);
  await reclamar(pg, account.id, SOPORTE);
  await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'comprador2@x.com' }, pg);
  await aplicarEstadoClub({ location_id: 'locSSO000001', activo: false, motivo: 'impago' }, pg);
  // un pendiente MÁS NUEVO del comprador que no pudo aplicarse directo (p. ej. llegó cuando había otra conexión con su correo)
  await pg.query(`INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ('email:comprador2@x.com', true, 'pago recuperado', now() + interval '1 second')`);
  assert.equal(await aplicarPendientePorEmail(account.id, 'alguien@equipo.com', pg), null, 'otro usuario del equipo: no es el correo del Club');
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'comprador2@x.com', pg), { activo: true });
  assert.equal(await ai(pg, account.id), true);
  await pg.close();
});

test('validación del cuerpo', () => {
  assert.equal(validarCuerpoClub({ location_id: 'abc123def', activo: 'true' }).datos.activo, true);
  assert.equal(validarCuerpoClub({ email: 'A@B.com', activo: false }).datos.email, 'a@b.com');
  assert.equal(validarCuerpoClub({ location_id: 'abc123def' }).ok, false);
  assert.equal(validarCuerpoClub({ location_id: 'abc123def', activo: 'si' }).ok, false);
  assert.equal(validarCuerpoClub({ activo: true }).ok, false);
  assert.equal(validarCuerpoClub({ location_id: '{{contact.location}}', activo: true }).ok, false, 'merge field sin resolver = no viene');
  assert.equal(validarCuerpoClub({ location_id: '{{contact.x}}', email: 'a@b.com', activo: true }).datos.location_id, null);
  assert.equal(validarCuerpoClub({ location_id: "x'; DROP", activo: true }).ok, false);
  assert.equal(validarCuerpoClub([]).ok, false);
});

test('secreto: comparación correcta', () => {
  assert.equal(secretoValido(SECRETO, SECRETO), true);
  assert.equal(secretoValido('otro', SECRETO), false);
  assert.equal(secretoValido('', ''), false);
});

test('plantilla saneada', () => {
  const p = sanearPlantilla({ provider_id: '5', test_tag: '  ', prompt_partida: { identity: 'a\r\nb' } });
  assert.equal(p.provider_id, 5);
  assert.equal(p.test_tag, 'test-setter');
  assert.equal(p.prompt_partida.identity, 'a\nb');
  assert.equal(sanearPlantilla(null).provider_id, null);
});

function fakeRedis() {
  const m = new Map();
  return {
    get: async (k) => m.get(k) ?? null,
    incr: async (k) => { m.set(k, (Number(m.get(k)) || 0) + 1); return m.get(k); },
    expire: async () => 1,
  };
}

test('endpoint: 503 sin secreto, 401 con secreto malo, 400 cuerpo malo, 200 bien, 429 solo a los fallos', async () => {
  const pg = await baseConAntigua();
  await crearConexionNueva({ name: 'N', locationId: 'locNueva0100' }, pg);
  const cuerpo = { location_id: 'locNueva0100', activo: false, motivo: 'impago' };

  const sin = Fastify();
  await sin.register(clubRoutes, { pool: pg, redis: fakeRedis(), secreto: '' });
  let r = await sin.inject({ method: 'POST', url: '/api/club/estado', payload: cuerpo });
  assert.equal(r.statusCode, 503);

  const corto = Fastify();
  await corto.register(clubRoutes, { pool: pg, redis: fakeRedis(), secreto: 'corto' });
  r = await corto.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': 'corto' }, payload: cuerpo });
  assert.equal(r.statusCode, 503, 'un secreto demasiado corto cuenta como no configurado');

  // mismas opciones y mismo lector JSON que producción (src/index.js): bodyLimit global de 20 MB y body crudo
  const app = Fastify({ trustProxy: true, bodyLimit: 20 * 1024 * 1024 });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, payload, done) => {
    req.rawBody = payload;
    try { done(null, payload ? JSON.parse(payload) : {}); } catch { done(null, {}); }
  });
  await app.register(clubRoutes, { pool: pg, redis: fakeRedis(), secreto: SECRETO, reloj: () => 1_800_000_000_000 });
  r = await app.inject({ method: 'POST', url: '/api/club/estado', payload: cuerpo });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': 'malo' }, payload: cuerpo });
  assert.equal(r.statusCode, 401);
  assert.equal(await ai(pg, 101), true, 'sin secreto válido no cambia nada');
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO }, payload: { location_id: 'locNueva0100' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO }, payload: cuerpo });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().resultado, 'aplicado');
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { authorization: `Bearer ${SECRETO}` }, payload: { ...cuerpo, activo: true } });
  assert.equal(r.statusCode, 200);
  for (let i = 0; i < 20; i++) {
    await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': 'no' }, payload: cuerpo });
  }
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': 'no' }, payload: cuerpo });
  assert.equal(r.statusCode, 429, 'muchos fallos seguidos: freno');
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO }, payload: cuerpo });
  assert.equal(r.statusCode, 200, 'el secreto bueno pasa siempre (nadie puede bloquear a GHL falsificando su IP)');
  // cuerpo enorme: se corta antes de leerlo (ruta pública con su propio límite)
  r = await app.inject({ method: 'POST', url: '/api/club/estado', headers: { 'x-club-secret': SECRETO, 'content-type': 'application/json' }, payload: JSON.stringify({ ...cuerpo, activo: true, motivo: 'x'.repeat(20000) }) });
  assert.equal(r.statusCode, 413);
  assert.equal(await ai(pg, 101), false, 'el cuerpo enorme no ha cambiado nada');
  await pg.close();
});

test('la ruta pública exacta en la sesión: solo /api/club/estado (y /api/club/devolucion) se saltan el login', async () => {
  const src = fs.readFileSync(new URL('../src/lib/session.js', import.meta.url), 'utf8');
  assert.match(src, /esRutaPublica\(ruta\)/, 'el authHook usa lib/rutas.js');
  assert.match(src, /if \(!crudo\.startsWith\('\/'\)\)/, 'y corta con 400 lo que no empieza por «/» (forma absoluta)');
  assert.match(src, /req\.routeOptions\?\.url/, 'y mira también la ruta que ha casado el router');
  assert.doesNotMatch(src, /'\/api\/club\//, 'ninguna ruta del Club por prefijo en la sesión');
  const { esRutaPublica } = await import('../src/lib/rutas.js');
  assert.equal(esRutaPublica('/api/club/estado'), true);
  assert.equal(esRutaPublica('/api/club/estadoX'), false);
});
