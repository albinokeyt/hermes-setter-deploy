import { q, one } from '../db.js';
import { requireAdmin } from '../lib/session.js';

const AUDIENCES = ['all', 'tag'];
const METRICS = ['agendas', 'calificacion', 'conversion'];
const STATUSES = ['active', 'paused', 'finished'];

async function results(versusId) {
  const rows = await q(
    `SELECT s.id, s.name AS setter_name, a.name AS account_name, vs.weight,
      COUNT(c.id)::int AS leads,
      COUNT(c.id) FILTER (WHERE c.stage IN ('calificado', 'seguimiento_calificado'))::int AS calificados,
      COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
      COUNT(c.id) FILTER (WHERE c.stage = 'agendado')::int AS agendados,
      COUNT(c.id) FILTER (WHERE c.stage = 'descartado')::int AS descartados,
      COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u JOIN conversations cc ON cc.id = u.conversation_id
                WHERE cc.versus_id = $1 AND u.setter_id = s.id), 0) AS gasto
     FROM versus_setters vs
     JOIN setters s ON s.id = vs.setter_id
     JOIN accounts a ON a.id = s.account_id
     LEFT JOIN conversations c ON c.setter_id = s.id AND c.versus_id = $1
     WHERE vs.versus_id = $1
     GROUP BY s.id, s.name, a.name, vs.weight
     ORDER BY s.id`,
    [versusId]
  );
  return rows.map((r) => {
    const leads = r.leads || 0;
    const won = r.agendados || 0;
    const conv = (r.en_conversion || 0) + won;
    return {
      ...r,
      gasto: Number(r.gasto || 0),
      tasa_agenda: leads ? Math.round((won / leads) * 100) : 0,
      tasa_conversion: leads ? Math.round((conv / leads) * 100) : 0,
      tasa_calificacion: leads ? Math.round(((r.calificados + conv) / leads) * 100) : 0,
    };
  });
}

function winner(res, metric) {
  const key = metric === 'calificacion' ? 'tasa_calificacion' : metric === 'conversion' ? 'tasa_conversion' : 'tasa_agenda';
  const withLeads = res.filter((r) => r.leads > 0);
  if (!withLeads.length) return null;
  return withLeads.reduce((best, r) => (r[key] > best[key] ? r : best)).id;
}

export default async function versusRoutes(app) {
  app.addHook('preHandler', async (req, reply) => { if (!requireAdmin(req, reply)) return reply; });

  // setters disponibles (de cualquier conexión) para elegir competidores
  app.get('/api/versus/available-setters', async () => {
    return q(`SELECT s.id, s.name, s.account_id, a.name AS account_name
              FROM setters s JOIN accounts a ON a.id = s.account_id ORDER BY a.name, s.id`);
  });

  app.get('/api/versus', async () => {
    return q(`
      SELECT v.*,
        (SELECT COUNT(*)::int FROM versus_setters vs WHERE vs.versus_id = v.id) AS setters_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.versus_id = v.id) AS leads_count
      FROM versus v ORDER BY v.id DESC`);
  });

  app.post('/api/versus', async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ error: 'Ponle un nombre al versus' });
    const audience = AUDIENCES.includes(b.audience) ? b.audience : 'all';
    const win_metric = METRICS.includes(b.win_metric) ? b.win_metric : 'agendas';
    return one(
      `INSERT INTO versus (name, win_metric, audience, audience_tag) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(b.name).trim(), win_metric, audience, String(b.audience_tag || '').trim()]
    );
  });

  app.get('/api/versus/:id', async (req, reply) => {
    const v = await one(`SELECT * FROM versus WHERE id = $1`, [req.params.id]);
    if (!v) return reply.code(404).send({ error: 'No existe' });
    const setters = await q(
      `SELECT vs.id AS link_id, vs.weight, s.id AS setter_id, s.name AS setter_name, a.name AS account_name
       FROM versus_setters vs JOIN setters s ON s.id = vs.setter_id JOIN accounts a ON a.id = s.account_id
       WHERE vs.versus_id = $1 ORDER BY vs.id`,
      [v.id]
    );
    const res = await results(v.id);
    return { ...v, setters, results: res, winner_id: winner(res, v.win_metric) };
  });

  app.put('/api/versus/:id', async (req, reply) => {
    const v = await one(`SELECT * FROM versus WHERE id = $1`, [req.params.id]);
    if (!v) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    return one(
      `UPDATE versus SET name=$1, status=$2, win_metric=$3, audience=$4, audience_tag=$5 WHERE id=$6 RETURNING *`,
      [
        String(b.name ?? v.name).trim() || v.name,
        STATUSES.includes(b.status) ? b.status : v.status,
        METRICS.includes(b.win_metric) ? b.win_metric : v.win_metric,
        AUDIENCES.includes(b.audience) ? b.audience : v.audience,
        b.audience_tag !== undefined ? String(b.audience_tag).trim() : v.audience_tag,
        v.id,
      ]
    );
  });

  app.delete('/api/versus/:id', async (req) => {
    await q(`DELETE FROM versus WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.post('/api/versus/:id/setters', async (req, reply) => {
    const v = await one(`SELECT id FROM versus WHERE id = $1`, [req.params.id]);
    if (!v) return reply.code(404).send({ error: 'Versus no encontrado' });
    const setterId = Number(req.body?.setter_id);
    const s = await one(`SELECT id FROM setters WHERE id = $1`, [setterId]);
    if (!s) return reply.code(404).send({ error: 'Setter no encontrado' });
    return one(
      `INSERT INTO versus_setters (versus_id, setter_id, weight) VALUES ($1,$2,$3)
       ON CONFLICT (versus_id, setter_id) DO UPDATE SET weight = EXCLUDED.weight RETURNING *`,
      [v.id, setterId, Number(req.body?.weight) || 50]
    );
  });

  app.put('/api/versus/setters/:linkId', async (req, reply) => {
    const row = await one(`UPDATE versus_setters SET weight = $1 WHERE id = $2 RETURNING *`, [Number(req.body?.weight) || 50, req.params.linkId]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    return row;
  });

  app.delete('/api/versus/setters/:linkId', async (req) => {
    await q(`DELETE FROM versus_setters WHERE id = $1`, [req.params.linkId]);
    return { ok: true };
  });
}
