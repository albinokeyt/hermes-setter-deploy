// 🏛️ CLUB DE SISTEMAS · correo de la SUBCUENTA en GHL al crear o reconectar una conexión (fase C, migración 061).
//
// Los workflows de 4ttZ solo mandan el correo del comprador. La subcuenta SaaS del cliente la crea GHL con ese correo,
// así que Hermes lo lee de GHL (GET /locations/{id}) y lo guarda en la conexión (accounts.ghl_location_email): desde ahí
// el interruptor del Club y las devoluciones la encuentran por ese correo aunque soporte haya abierto Hermes primero.
// Solo en conexiones del Club que aún no lo tienen (las de antes del Club —DEP, Rodrigo, Lorena…— ni se preguntan).
// Best effort: NUNCA lanza ni rompe la instalación, la reconexión ni el SSO; si GHL no deja (permiso), se anota.

import { getLocationInfo } from './ghl.js';
import { quiereCorreoSubcuenta, vincularCorreoSubcuenta } from './club.js';
import { pool } from '../db.js';

async function anotar(kind, payload) {
  await pool.query(`INSERT INTO webhook_log (kind, payload) VALUES ($1, $2)`, [kind, JSON.stringify(payload)]).catch(() => {});
}

const A_MANO = 'pon el correo de la compra en «Correo del Club» de la conexión (Conexiones → la conexión → Conexión GHL)';

/**
 * @param {object} account  la conexión (id, location_id, mode…)
 * @param {{ origen?: string, info?: object|null }} opts  info = lo que ya devolvió getLocationInfo (para no pedirlo dos veces)
 * @returns {Promise<{ estado: string }>}
 */
export async function enlazarCorreoSubcuenta(account, { origen = '', info = null } = {}) {
  try {
    if (!account?.id || !account.location_id) return { estado: 'sin_subcuenta' };
    if (!(await quiereCorreoSubcuenta(account.id))) return { estado: 'no_hace_falta' };
    // (en una reconexión es una llamada de más a GHL: con un tope corto para no retrasar la vuelta de OAuth)
    const datos = info || (await getLocationInfo({ ...account, mode: account.mode || 'oauth' }, account.location_id, { timeoutMs: 10_000 }));
    const base = { account: account.id, location_id: account.location_id, origen };
    if (!datos?.ok) {
      if (datos?.sin_token) {
        await anotar('club_correo_subcuenta_error', { ...base, sin_token: true, error: String(datos.error || '').slice(0, 200),
          nota: 'la app aún no tiene token en esta subcuenta: el correo se leerá al instalarla o reconectarla por OAuth' });
        return { estado: 'sin_token' };
      }
      const sinPermiso = datos?.status === 401 || datos?.status === 403;
      await anotar('club_correo_subcuenta_error', { ...base, http: datos?.status ?? null, sin_permiso: sinPermiso, error: String(datos?.error || '').slice(0, 200),
        nota: sinPermiso
          ? `GHL no deja leer la subcuenta (permiso locations.readonly): ${A_MANO}`
          : `no se pudo leer el correo de la subcuenta en GHL (se reintenta en la próxima reconexión): o ${A_MANO}` });
      return { estado: sinPermiso ? 'sin_permiso' : 'error_ghl' };
    }
    const r = datos.email ? await vincularCorreoSubcuenta({ accountId: account.id, correo: datos.email, origen }) : { estado: 'sin_correo' };
    if (r.estado === 'sin_correo') {
      await anotar('club_correo_subcuenta_vacio', { ...base, en_ghl: String(datos.email || '').slice(0, 254),
        nota: datos.email ? `el correo de la subcuenta en GHL no es válido: ${A_MANO}` : `la subcuenta no tiene correo en GHL: ${A_MANO}` });
    }
    return r;
  } catch (err) {
    await anotar('club_correo_subcuenta_error', { account: account?.id ?? null, origen, error: String(err?.message || err).slice(0, 200) });
    return { estado: 'error' };
  }
}
