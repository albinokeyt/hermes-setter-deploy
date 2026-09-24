// 🛒 Compras de los leads: listado por conexión y SINCRONIZACIÓN con la API de pedidos de GHL (payments/orders).
// El camino normal es el webhook OrderStatusUpdate de la app (pipeline.handleOrderEvent); la sincronización trae
// el histórico y completa los productos que falten. Leer productos necesita el permiso payments/orders.readonly
// en el token de la subcuenta: si no lo tiene, lo dice claro en vez de fallar mudo.
import { q, one } from '../db.js';
import * as ghl from '../services/ghl.js';
import { registrarCompra, normalizarPedido, pedidoCuenta, logEvent } from '../services/pipeline.js';
import { canAccessAccount, accessibleAccountIds } from '../lib/session.js';

const numId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GHL limita las ráfagas: ante un 429 se espera 3 s y se reintenta una vez.
async function con429(fn) {
  try { return await fn(); } catch (err) { if (Number(err?.status) !== 429) throw err; await sleep(3000); return fn(); }
}

export default async function comprasRoutes(app) {
  // Últimas compras que cuentan como venta (reales, pagadas, no anuladas), con el lead al que se enlazaron.
  app.get('/api/compras', async (req, reply) => {
    const ids = await accessibleAccountIds(req);
    const accountId = numId(req.query?.account_id);
    if (accountId && !(await canAccessAccount(req, accountId))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const limit = Math.min(Math.max(Math.trunc(Number(req.query?.limit)) || 50, 1), 500);
    const where = ['p.cuenta'];
    const vals = [];
    if (accountId) { vals.push(accountId); where.push(`p.account_id = $${vals.length}`); }
    else if (ids) { vals.push(ids); where.push(`p.account_id = ANY($${vals.length}::int[])`); }
    vals.push(limit);
    return q(
      `SELECT p.id, p.account_id, p.conversation_id, p.ghl_contact_id, p.amount, p.currency, p.status, p.payment_status, p.items, p.source,
              p.atribuida, p.origen, p.ordered_at, p.created_at,
              c.lead_name, c.stage, c.channel, COALESCE(NULLIF(a.alias,''), a.name) AS account_name, s.name AS setter_name
         FROM purchases p JOIN accounts a ON a.id = p.account_id
         LEFT JOIN conversations c ON c.id = p.conversation_id
         LEFT JOIN setters s ON s.id = p.setter_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.ordered_at DESC LIMIT $${vals.length}`,
      vals
    );
  });

  // Trae los pedidos de GHL de los últimos N días (por defecto 90) y los registra/enlaza igual que el webhook.
  // Es idempotente: re-sincronizar no vuelve a mover status ni duplica pedidos. Solo admin.
  app.post('/api/accounts/:id/compras/sincronizar', async (req, reply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'Solo para administradores' });
    const accountId = numId(req.params.id);
    const account = accountId ? await one(`SELECT * FROM accounts WHERE id = $1`, [accountId]) : null;
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    if (!account.location_id) return reply.code(400).send({ error: 'La conexión no tiene subcuenta de GHL' });
    const dias = Math.min(Math.max(Math.trunc(Number(req.body?.dias)) || 90, 1), 365);
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
    const hasta = new Date().toISOString();
    const res = { dias, leidos: 0, ventas: 0, nuevas: 0, con_lead: 0, sin_lead: 0, con_productos: 0, sin_productos_pendientes: 0, paginas: 0 };
    // pedidos que ya tienen productos guardados: no se vuelven a pedir (cada barrida avanza sobre los que faltan)
    const conItems = new Set((await q(`SELECT ghl_order_id FROM purchases WHERE account_id = $1 AND jsonb_array_length(items) > 0`, [account.id])).map((r) => r.ghl_order_id));
    let detalles = 0; // tope de GET /orders/:id por barrida (productos): no saturar la API
    let sinPermisoProductos = false;
    try {
      for (let offset = 0, pagina = 0; pagina < 30; pagina++) {
        const r = await con429(() => ghl.listOrders(account, { startAt: desde, endAt: hasta, limit: 100, offset }));
        const data = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.orders) ? r.orders : null);
        if (!data) {
          await logEvent('compras_respuesta_inesperada', { account: account.id, campos: Object.keys(r || {}) });
          res.aviso = 'GHL devolvió una respuesta sin lista de pedidos: no se ha podido leer nada (queda en el Registro de eventos).';
          break;
        }
        res.paginas++;
        for (const o of data) {
          res.leidos++;
          const n = normalizarPedido(o);
          if (!n.orderId || !n.contactId) continue;
          const cuenta = pedidoCuenta(n);
          if (cuenta) res.ventas++;
          if (cuenta && !n.items.length && !conItems.has(n.orderId) && !sinPermisoProductos) {
            if (detalles < 80) {
              detalles++;
              try {
                n.items = normalizarPedido(await con429(() => ghl.getOrder(account, n.orderId))).items;
              } catch (err) {
                const st = Number(err?.status) || 0;
                if (st === 401 || st === 403) sinPermisoProductos = true; // sin permiso: no se insiste con el resto
              }
            } else res.sin_productos_pendientes++;
          }
          if (n.items.length || conItems.has(n.orderId)) res.con_productos++;
          const out = await registrarCompra(account, n, { origen: 'sincronizacion' });
          if (out?.registrada && out?.cuenta && !out?.ya_aplicada) res.nuevas++;
          if (cuenta) { if (out?.conversationId) res.con_lead++; else res.sin_lead++; }
        }
        if (data.length < 100) break;
        offset += data.length;
      }
    } catch (err) {
      const st = Number(err?.status) || 0;
      if (st === 401 || st === 403) {
        await logEvent('compras_sin_permiso', { account: account.id, status: st, error: String(err.message).slice(0, 200) });
        return { ...res, error_permiso: true, mensaje: `GHL rechaza la lectura de pedidos: falta el permiso «payments/orders.readonly». ${consejoPermiso(account)}` };
      }
      return reply.code(502).send({ ...res, error: String(err.message).slice(0, 300) });
    }
    if (sinPermisoProductos) res.aviso_productos = `Los pedidos se han leído, pero no sus productos: falta el permiso «payments/orders.readonly». ${consejoPermiso(account)}`;
    await logEvent('compras_sincronizadas', { account: account.id, ...res });
    return res;
  });
}

function consejoPermiso(account) {
  return account.mode === 'pit'
    ? 'Esta conexión usa un token privado (PIT): añade ese permiso a la integración privada de la subcuenta (Ajustes → Integraciones privadas → editar permisos) y, si GHL genera un token nuevo, pégalo en la pestaña Conexión.'
    : 'Añade el permiso en la app del marketplace (Scopes), márcalo en Configuración de Hermes y vuelve a autorizar la app en esta subcuenta para que su token lo incluya.';
}
