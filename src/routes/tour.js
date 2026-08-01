import { q, one } from '../db.js';
import { requireAdmin } from '../lib/session.js';

// 🧭 Progreso del tutorial guiado. Cada usuario reporta hasta qué paso llegó (se guarda el MÁXIMO
// alcanzado, no el paso actual: retroceder o volver a abrir el tour no baja el porcentaje).
// El admin lo ve por usuario/conexión. El total viaja con cada usuario porque los pasos varían por
// rol (un usuario "solo mensajes" tiene menos pasos que el admin) y con futuros rediseños del tour.
export default async function tourRoutes(app) {
  app.post('/api/tour/progress', async (req, reply) => {
    const b = req.body || {};
    const total = Math.max(1, Math.min(500, Number(b.total) || 1));
    const done = b.terminado === true;
    const paso = done ? total : Math.max(0, Math.min(total, Number(b.paso) || 0));

    let key = '';
    let label = '';
    if (req.userId) {
      key = `u:${req.userId}`;
      const u = await one(`SELECT username FROM users WHERE id = $1`, [req.userId]);
      label = u?.username || `usuario #${req.userId}`;
    } else if (req.auth?.portalUserId) {
      key = `p:${req.auth.portalUserId}`;
      const pu = await one(`SELECT name, email FROM portal_users WHERE id = $1`, [req.auth.portalUserId]);
      label = pu?.name || pu?.email || 'usuario de GHL';
    } else {
      return reply.code(400).send({ error: 'Sesión sin usuario' });
    }

    await q(
      `INSERT INTO tour_progress (user_key, label, account_id, role, paso, total, completado_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() ELSE NULL END)
       ON CONFLICT (user_key) DO UPDATE SET
         label = EXCLUDED.label,
         account_id = EXCLUDED.account_id,
         role = EXCLUDED.role,
         paso = GREATEST(tour_progress.paso, EXCLUDED.paso),
         total = EXCLUDED.total,
         completado_at = COALESCE(tour_progress.completado_at, EXCLUDED.completado_at),
         updated_at = now()`,
      [key, label, req.auth?.accountId || null, req.auth?.role || 'user', paso, total, done]
    );
    return { ok: true };
  });

  app.get('/api/tour/progress', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const rows = await q(
      `SELECT t.user_key, t.label, t.role, t.paso, t.total, t.completado_at, t.updated_at,
              COALESCE(NULLIF(a.alias, ''), a.name) AS account_name
         FROM tour_progress t LEFT JOIN accounts a ON a.id = t.account_id
        ORDER BY t.updated_at DESC LIMIT 200`
    );
    // completado = 100 fijo; en curso se topa a 99 aunque el total del tour cambie entre versiones
    return {
      progreso: rows.map((r) => ({
        ...r,
        pct: r.completado_at ? 100 : Math.min(99, Math.round((r.paso * 100) / Math.max(1, r.total))),
      })),
    };
  });
}
