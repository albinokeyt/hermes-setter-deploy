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

// lo que hace el PUT del admin al CONFIRMAR el correo del Club (routes/accounts.js): guarda club_email y aplica el pendiente
async function confirmar(pg, id, mail) {
  await pg.query(`UPDATE accounts SET club_email = $2 WHERE id = $1`, [id, mail]);
  return club.aplicarPendientesDeConexion(id, pg, { via: 'club_email' });
}
const pendientesDe = async (pg) => (await pg.query(`SELECT clave, activo FROM club_estado_pendiente ORDER BY clave`)).rows;
const ultimoEv = async (pg) => (await pg.query(`SELECT resultado, activo, cuentas, detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];

test('club por correo: SOLO el correo del Club confirmado; el responsable o el correo de la subcuenta solos no tocan nada (pendiente con la pista)', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locNuevaA001' }, pg)).account;
  await pg.query(`UPDATE accounts SET owner_email = 'compra@x.com' WHERE id = $1`, [a.id]);
  let r = await aplicarEstadoClub({ email: 'compra@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202); assert.equal(r.body.resultado, 'pendiente');
  assert.deepEqual(r.body.sin_confirmar, [a.id], 'la pista para soporte: esa conexión lo tiene de responsable');
  assert.equal(await ai(pg, a.id), true, 'sin confirmar no se toca');
  assert.deepEqual(await confirmar(pg, a.id, 'compra@x.com'), [{ activo: false }], 'al confirmarlo se aplica la baja que esperaba');
  assert.equal(await ai(pg, a.id), false);
  // otra conexión con ese correo de responsable Y de subcuenta, sin confirmar: no cuenta (ni empata)
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locNuevaB001' }, pg)).account;
  await pg.query(`UPDATE accounts SET owner_email = 'compra@x.com', ghl_location_email = 'compra@x.com' WHERE id = $1`, [b.id]);
  r = await aplicarEstadoClub({ email: 'compra@x.com', activo: true, motivo: 'alta' }, pg);
  assert.equal(r.code, 200); assert.deepEqual(r.body.cuentas, [a.id]);
  assert.equal(r.body.resultado, 'aplicado');
  r = await aplicarEstadoClub({ email: 'compra@x.com', activo: false, motivo: 'impago' }, pg);
  assert.deepEqual(r.body.cuentas, [a.id]);
  assert.equal(await ai(pg, a.id), false);
  assert.equal(await ai(pg, b.id), true, 'B no se toca');
  assert.equal((await ultimoEv(pg)).detalle.por, 'club_email');
  await pg.close();
});

// lo que hace el SSO (portal.js · claimOwner): el primer usuario certificado por GHL queda como responsable
const reclamar = (pg, id, email) => pg.query(`UPDATE accounts SET owner_email = $2 WHERE id = $1 AND owner_email = ''`, [id, email]);

test('club por correo sin conexión: el pendiente NO se aplica por entrar como responsable (SSO); sí al confirmar el correo del Club, una sola vez', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'futura@x.com', activo: false, motivo: 'baja antes de conectar' }, pg);
  assert.equal(await aplicarPendientePorEmail(1, 'futura@x.com', pg), null, 'conexión antigua: no se aplica');
  assert.equal(await ai(pg, 1), true);
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locNueva0009' }, pg);
  await reclamar(pg, account.id, 'futura@x.com');
  assert.equal(await aplicarPendientePorEmail(account.id, 'Futura@X.com', pg), null, 'ser el responsable no basta');
  assert.equal(await ai(pg, account.id), true);
  assert.deepEqual(await pendientesDe(pg), [{ clave: 'email:futura@x.com', activo: false }], 'sigue esperando');
  assert.deepEqual(await confirmar(pg, account.id, 'futura@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, account.id), false);
  assert.equal(await aplicarPendientePorEmail(account.id, 'futura@x.com', pg), null, 'consumido');
  assert.deepEqual(await club.aplicarPendientesDeConexion(account.id, pg), [], 'consumido');
  const ev = (await pg.query(`SELECT resultado, detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.resultado, 'pendiente_aplicado');
  assert.equal(ev.detalle.via, 'club_email');
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
  // B crea SU conexión y soporte confirma su correo del Club → ahí sí se aplica
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locClienteB1' }, pg)).account;
  await pg.query(`UPDATE accounts SET ai_enabled = false WHERE id = $1`, [b.id]);
  await reclamar(pg, b.id, 'b@x.com');
  assert.deepEqual(await confirmar(pg, b.id, 'b@x.com'), [{ activo: true }]);
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

test('el responsable de DOS conexiones nuevas (p. ej. soporte) no se lleva el pendiente: no se toca ninguna y sigue esperando', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locDoble0001' }, pg)).account;
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locDoble0002' }, pg)).account;
  await aplicarEstadoClub({ email: 'doble@x.com', activo: false, motivo: 'baja' }, pg); // aún sin responsable: pendiente
  await reclamar(pg, a.id, 'doble@x.com');
  await reclamar(pg, b.id, 'doble@x.com');
  assert.equal(await aplicarPendientePorEmail(a.id, 'doble@x.com', pg), null);
  assert.equal(await aplicarPendientePorEmail(b.id, 'doble@x.com', pg), null);
  assert.equal(await ai(pg, a.id), true);
  assert.equal(await ai(pg, b.id), true);
  assert.deepEqual(await pendientesDe(pg), [{ clave: 'email:doble@x.com', activo: false }], 'no se consume: espera a que soporte confirme el bueno');
  await pg.close();
});

test('orden: un alta vieja pendiente por correo NO reenciende una conexión apagada después por impago (subcuenta)', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'compra@x.com', activo: true, motivo: 'alta' }, pg); // pendiente (aún sin responsable)
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0001' }, pg);
  await aplicarEstadoClub({ location_id: 'locOrden0001', activo: false, motivo: 'impago' }, pg);
  assert.deepEqual(await confirmar(pg, account.id, 'compra@x.com'), [{ obsoleto: true }]);
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
  assert.deepEqual(await confirmar(pg, account.id, 'compra2@x.com'), [{ obsoleto: true }]);
  assert.equal(await ai(pg, account.id), false);
  await pg.close();
});

test('orden: un estado por correo MÁS RECIENTE que el último aplicado sí se aplica al confirmar el correo del Club', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locOrden0003' }, pg);
  await aplicarEstadoClub({ location_id: 'locOrden0003', activo: false, motivo: 'impago' }, pg);
  await aplicarEstadoClub({ email: 'compra3@x.com', activo: true, motivo: 'pago recuperado' }, pg); // aún sin confirmar
  assert.deepEqual(await confirmar(pg, account.id, 'compra3@x.com'), [{ activo: true }]);
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
  assert.deepEqual(await confirmar(pg, account.id, 'compra4@x.com'), [{ obsoleto: true }]);
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

// ── Fase C · 4) cliente sin location_id: el correo del Club es el que CONFIRMA soporte (club_email); el de la subcuenta en
// GHL y el responsable solo son pistas (repaso: A1-A4 del verificador) ──
const SOPORTE = 'soporte@departamentodisruptivo.com';
const pendientes = async (pg) => (await pg.query(`SELECT clave, activo FROM club_estado_pendiente ORDER BY clave`)).rows;
const ultimoEvento = async (pg) => (await pg.query(`SELECT resultado, activo, cuentas, detalle FROM club_eventos ORDER BY id DESC LIMIT 1`)).rows[0];

test('cliente sin location_id: soporte abrió Hermes primero; el correo de la subcuenta es solo una pista y al CONFIRMAR el correo del Club la baja que esperaba se aplica', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locSoporte01' }, pg);
  await reclamar(pg, account.id, SOPORTE); // el primer usuario que entró por SSO fue soporte
  assert.equal(await ai(pg, account.id), true, 'nace encendida (migración 045)');
  let r = await aplicarEstadoClub({ email: 'comprador@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'pendiente');
  assert.equal(r.body.sin_confirmar, undefined, 'aún no hay ninguna pista con ese correo');
  // Hermes lee el correo de la subcuenta en GHL (al crear o reconectar): se guarda como pista, NO aplica nada
  const v = await club.vincularCorreoSubcuenta({ accountId: account.id, correo: ' Comprador@X.com ', origen: 'oauth' }, pg);
  assert.deepEqual(v, { estado: 'guardado' });
  assert.equal(await ai(pg, account.id), true, 'el correo de la subcuenta no enlaza: la baja sigue esperando');
  assert.equal((await pg.query(`SELECT ghl_location_email FROM accounts WHERE id = $1`, [account.id])).rows[0].ghl_location_email, 'comprador@x.com');
  const guardado = (await pg.query(`SELECT payload FROM webhook_log WHERE kind = 'club_correo_subcuenta_guardado' ORDER BY id DESC LIMIT 1`)).rows[0].payload;
  assert.deepEqual(guardado.pendiente, { activo: false, motivo: 'impago' }, 'queda anotado que hay un estado esperando por ese correo');
  assert.match(guardado.nota, /NO se aplica solo/);
  r = await aplicarEstadoClub({ email: 'comprador@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 202);
  assert.deepEqual(r.body.sin_confirmar, [account.id], 'ahora sí hay pista: la conexión lo tiene de correo de la subcuenta');
  // soporte confirma el correo del Club → se aplica el último estado que esperaba
  assert.deepEqual(await confirmar(pg, account.id, 'comprador@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, account.id), false);
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
  assert.deepEqual(v, { estado: 'guardado' }, 'el correo de la subcuenta no aplica nada');
  assert.equal(await ai(pg, account.id), true);
  assert.deepEqual(await confirmar(pg, account.id, 'compra@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, account.id), false, 'manda la baja (la última)');
  assert.deepEqual(await pendientes(pg), [], 'consumido');
  const ev = await ultimoEvento(pg);
  assert.equal(ev.resultado, 'pendiente_aplicado', 'marcado como aplicado en el registro durable (club_eventos)');
  assert.equal(ev.activo, false);
  assert.deepEqual(ev.cuentas, [account.id]);
  assert.equal(ev.detalle.via, 'club_email');
  const log = (await pg.query(`SELECT payload FROM webhook_log WHERE kind = 'club_estado_pendiente_aplicado' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(log.payload.via, 'club_email');
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
  assert.equal(r.body.sin_confirmar, undefined, 'con club_email puesto, los otros dos ya ni son pista');
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

test('A1 · el correo de la compra de responsable o de subcuenta en OTRAS conexiones ya no empata: confirmarlo en la buena basta', async () => {
  const pg = await baseConAntigua();
  const a = (await crearConexionNueva({ name: 'A', locationId: 'locAmbig0001' }, pg)).account;
  const b = (await crearConexionNueva({ name: 'B', locationId: 'locAmbig0002' }, pg)).account;
  await club.vincularCorreoSubcuenta({ accountId: a.id, correo: 'x@x.com' }, pg); // su subcuenta tiene su correo
  await reclamar(pg, b.id, 'x@x.com'); // entró primero por SSO en otra subcuenta (p. ej. la de un socio)
  let r = await aplicarEstadoClub({ email: 'x@x.com', activo: false, motivo: 'baja' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'pendiente', 'antes: «ambiguo» y la baja se perdía');
  assert.deepEqual(r.body.sin_confirmar, [a.id, b.id], 'las dos son pista para soporte');
  assert.equal(await ai(pg, a.id), true);
  assert.equal(await ai(pg, b.id), true);
  // soporte confirma el correo del Club en la BUENA (A) → se aplica ahí; B no cuenta (antes seguía empatando)
  assert.deepEqual(await confirmar(pg, a.id, 'x@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, a.id), false);
  assert.equal(await ai(pg, b.id), true);
  r = await aplicarEstadoClub({ email: 'x@x.com', activo: true, motivo: 'alta' }, pg);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cuentas, [a.id]);
  assert.equal(await ai(pg, b.id), true);
  // y la base no admite el mismo correo del Club en dos conexiones (no puede volver a haber empate)
  await assert.rejects(pg.query(`UPDATE accounts SET club_email = 'x@x.com' WHERE id = $1`, [b.id]), /duplicate|unique|único/i);
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
  assert.equal(await club.quiereCorreoSubcuenta(account.id, pg), false, 'ya lo tiene: al crear o por SSO no se vuelve a pedir a GHL');
  assert.equal(await club.quiereCorreoSubcuenta(account.id, pg, { releer: true }), true, 'en una reconexión por OAuth sí (para ver si ha cambiado)');
  assert.equal(await club.quiereCorreoSubcuenta(1, pg, { releer: true }), false, 'una conexión anterior al Club, nunca');
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

test('confirmar el correo del Club y el interruptor a la vez (mismo correo): nunca se pierde el estado ni queda pendiente colgado', async () => {
  for (const orden of ['confirmar_primero', 'estado_primero']) {
    const pg = await baseConAntigua();
    const { account } = await crearConexionNueva({ name: 'N', locationId: `locVez${orden.slice(0, 6)}` }, pg);
    const confirma = () => confirmar(pg, account.id, 'vez@x.com');
    const estado = () => aplicarEstadoClub({ email: 'vez@x.com', activo: false, motivo: 'baja' }, pg);
    await Promise.all(orden === 'confirmar_primero' ? [confirma(), estado()] : [estado(), confirma()]);
    assert.equal(await ai(pg, account.id), false, orden);
    assert.deepEqual(await pendientes(pg), [], orden);
    await pg.close();
  }
});

test('SSO: solo reintenta el pendiente del correo del Club CONFIRMADO (ni el del responsable ni el de la subcuenta)', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'N', locationId: 'locSSO000001' }, pg);
  await reclamar(pg, account.id, SOPORTE);
  await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'comprador2@x.com' }, pg);
  await aplicarEstadoClub({ location_id: 'locSSO000001', activo: false, motivo: 'impago' }, pg);
  // un pendiente MÁS NUEVO del comprador (p. ej. llegó antes de confirmar su correo del Club)
  await pg.query(`INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ('email:comprador2@x.com', true, 'pago recuperado', now() + interval '1 second')`);
  // y una «prueba» del interruptor hecha con el correo de soporte (A4)
  await pg.query(`INSERT INTO club_estado_pendiente (clave, activo, motivo, updated_at) VALUES ($1, true, 'prueba', now() + interval '2 seconds')`, [`email:${SOPORTE}`]);
  assert.equal(await aplicarPendientePorEmail(account.id, 'alguien@equipo.com', pg), null, 'otro usuario del equipo: no es el correo del Club');
  assert.equal(await aplicarPendientePorEmail(account.id, SOPORTE, pg), null, 'soporte es el responsable, pero no el correo del Club');
  assert.equal(await aplicarPendientePorEmail(account.id, 'comprador2@x.com', pg), null, 'el correo de la subcuenta tampoco basta');
  assert.equal(await ai(pg, account.id), false);
  // el club_email ya está puesto (p. ej. al confirmarlo falló la base): el SSO del comprador lo reintenta
  await pg.query(`UPDATE accounts SET club_email = 'comprador2@x.com' WHERE id = $1`, [account.id]);
  assert.deepEqual(await aplicarPendientePorEmail(account.id, 'comprador2@x.com', pg), { activo: true });
  assert.equal(await ai(pg, account.id), true);
  assert.deepEqual(await pendientes(pg), [{ clave: `email:${SOPORTE}`, activo: true }], 'la prueba de soporte sigue sin aplicarse a nadie');
  await pg.close();
});

test('A2 · un cliente pone en SU subcuenta el correo de otro comprador: no se queda con su pendiente ni le deja ambiguo', async () => {
  const pg = await baseConAntigua();
  await aplicarEstadoClub({ email: 'victima@x.com', activo: false, motivo: 'baja de la víctima' }, pg); // 202 pendiente
  const atac = (await crearConexionNueva({ name: 'Atacante', locationId: 'locAtaca0001' }, pg)).account;
  assert.deepEqual(await club.vincularCorreoSubcuenta({ accountId: atac.id, correo: 'Victima@X.com' }, pg), { estado: 'guardado' });
  await reclamar(pg, atac.id, 'atacante@x.com');
  assert.equal(await aplicarPendientePorEmail(atac.id, 'atacante@x.com', pg), null);
  assert.equal(await ai(pg, atac.id), true, 'antes (A2): la baja de la víctima apagaba al atacante y se consumía');
  assert.deepEqual(await pendientes(pg), [{ clave: 'email:victima@x.com', activo: false }], 'la baja sigue esperando a la víctima');
  // la víctima instala después; soporte confirma SU correo del Club → la baja le llega a ella
  const vic = (await crearConexionNueva({ name: 'Víctima', locationId: 'locVicti0001' }, pg)).account;
  await club.vincularCorreoSubcuenta({ accountId: vic.id, correo: 'victima@x.com' }, pg);
  await reclamar(pg, vic.id, 'victima@x.com');
  assert.deepEqual(await confirmar(pg, vic.id, 'victima@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, vic.id), false);
  // el impago posterior de la víctima ya no sale ambiguo: va a la suya
  const r = await aplicarEstadoClub({ email: 'victima@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.cuentas, [vic.id]);
  assert.equal(await ai(pg, atac.id), true, 'el atacante no se entera de los estados de la víctima');
  await pg.close();
});

test('A3 · el alta de otro comprador no vuelve a encender a quien puso su correo en su subcuenta', async () => {
  const pg = await baseConAntigua();
  // la secuencia del verificador, en la ventana ANTES de que soporte confirme nada
  const atac = (await crearConexionNueva({ name: 'Atacante 2', locationId: 'locAtaca0002' }, pg)).account;
  await reclamar(pg, atac.id, 'atacante2@x.com');
  await club.vincularCorreoSubcuenta({ accountId: atac.id, correo: 'victima2@x.com' }, pg);
  await pg.query(`UPDATE accounts SET ai_enabled = false WHERE id = $1`, [atac.id]); // apagado (p. ej. por su impago)
  // víctima 2: soporte abrió Hermes primero y su subcuenta tiene el correo del negocio (aún sin confirmar)
  const vic = (await crearConexionNueva({ name: 'Víctima 2', locationId: 'locVicti0002' }, pg)).account;
  await reclamar(pg, vic.id, SOPORTE);
  await club.vincularCorreoSubcuenta({ accountId: vic.id, correo: 'info@negocio-victima.com' }, pg);
  let r = await aplicarEstadoClub({ email: 'victima2@x.com', activo: true, motivo: 'pago recuperado' }, pg);
  assert.equal(r.code, 202);
  assert.equal(r.body.resultado, 'pendiente');
  assert.equal(await ai(pg, atac.id), false, 'antes (A3): el alta de la víctima encendía al atacante (correo de su subcuenta)');
  // su propio impago, sin confirmar, espera; al confirmar soporte su correo de compra se aplica, y un alta ajena tampoco lo enciende
  r = await aplicarEstadoClub({ email: 'atacante2@x.com', activo: false, motivo: 'impago' }, pg);
  assert.equal(r.code, 202);
  await pg.query(`UPDATE accounts SET ai_enabled = true WHERE id = $1`, [atac.id]);
  assert.deepEqual(await confirmar(pg, atac.id, 'atacante2@x.com'), [{ activo: false }]);
  assert.equal(await ai(pg, atac.id), false, 'su impago le llega al confirmar');
  r = await aplicarEstadoClub({ email: 'victima2@x.com', activo: true, motivo: 'otro pago recuperado' }, pg);
  assert.equal(r.code, 202);
  assert.equal(await ai(pg, atac.id), false);
  await pg.close();
});

test('A4 · una prueba del interruptor con el correo de soporte no apaga al cliente que soporte abre después', async () => {
  const pg = await baseConAntigua();
  let r = await aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba del workflow con el correo de soporte' }, pg);
  assert.equal(r.code, 202);
  const { account } = await crearConexionNueva({ name: 'Cliente real', locationId: 'locClienteR1' }, pg);
  await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'cliente.real@x.com' }, pg);
  await reclamar(pg, account.id, SOPORTE); // soporte abre Hermes primero (el procedimiento lo permite)
  assert.equal(await aplicarPendientePorEmail(account.id, SOPORTE, pg), null);
  assert.equal(await ai(pg, account.id), true, 'antes (A4): la prueba apagaba la IA del primer cliente real');
  // y una prueba EN VIVO con el correo de soporte, con soporte de responsable de esa conexión, tampoco la toca
  r = await aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'otra prueba' }, pg);
  assert.equal(r.code, 202);
  assert.deepEqual(r.body.sin_confirmar, [account.id], 'solo como pista para soporte');
  assert.equal(await ai(pg, account.id), true);
  await pg.close();
});

test('ficha: pendientesParaFicha enseña lo que espera por el correo del Club, el del responsable o el de la subcuenta', async () => {
  const pg = await baseConAntigua();
  const { account } = await crearConexionNueva({ name: 'Ficha', locationId: 'locFichaP001' }, pg);
  await reclamar(pg, account.id, SOPORTE);
  await club.vincularCorreoSubcuenta({ accountId: account.id, correo: 'comprador@x.com' }, pg);
  await aplicarEstadoClub({ email: SOPORTE, activo: false, motivo: 'prueba' }, pg);
  await aplicarEstadoClub({ email: 'comprador@x.com', activo: true, motivo: 'alta' }, pg);
  await aplicarEstadoClub({ email: 'otro@x.com', activo: true, motivo: 'alta de otro' }, pg);
  const acc = (await pg.query(`SELECT * FROM accounts WHERE id = $1`, [account.id])).rows[0];
  const p = await club.pendientesParaFicha(acc, pg);
  assert.deepEqual(p.map((x) => [x.email, x.de, x.activo, x.vigente]).sort(), [
    ['comprador@x.com', ['correo_subcuenta'], true, true],
    [SOPORTE, ['responsable'], false, true],
  ]);
  assert.ok(p.every((x) => x.updated_at && x.motivo));
  assert.deepEqual(await club.pendientesParaFicha({}, pg), []);
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
