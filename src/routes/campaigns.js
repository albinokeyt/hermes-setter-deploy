import { q, one } from '../db.js';
import { requireAdmin } from '../lib/session.js';

const VARIANT_FIELDS = [
  'name', 'weight', 'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'max_msgs', 'debounce_seconds', 'followups',
];
const JSON_FIELDS = new Set(['followups']);

async function variantsOf(campaignId) {
  return q(`SELECT * FROM campaign_variants WHERE campaign_id = $1 ORDER BY id`, [campaignId]);
}

// Métricas comparativas por agente dentro de una campaña.
async function campaignResults(campaignId) {
  const rows = await q(`
    SELECT v.id, v.name, v.weight,
      COUNT(c.id)::int AS leads,
      COUNT(c.id) FILTER (WHERE c.stage = 'en_conversacion')::int AS en_conversacion,
      COUNT(c.id) FILTER (WHERE c.stage = 'calificado')::int AS calificados,
      COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
      COUNT(c.id) FILTER (WHERE c.stage = 'agendado')::int AS agendados,
      COUNT(c.id) FILTER (WHERE c.stage = 'agenda_cancelada')::int AS canceladas,
      COUNT(c.id) FILTER (WHERE c.stage = 'descartado')::int AS descartados,
      COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u WHERE u.variant_id = v.id), 0) AS gasto
    FROM campaign_variants v
    LEFT JOIN conversations c ON c.variant_id = v.id
    WHERE v.campaign_id = $1
    GROUP BY v.id ORDER BY v.id
  `, [campaignId]);
  return rows.map((r) => {
    const leads = r.leads || 0;
    const won = (r.agendados || 0);
    const conv = (r.en_conversion || 0) + won;
    return {
      ...r,
      tasa_calificacion: leads ? Math.round(((r.calificados + conv) / leads) * 100) : 0,
      tasa_agenda: leads ? Math.round((won / leads) * 100) : 0,
      tasa_conversion: leads ? Math.round((conv / leads) * 100) : 0,
      gasto: Number(r.gasto || 0),
    };
  });
}

function pickWinner(results, metric) {
  if (!results.length) return null;
  const key = metric === 'calificacion' ? 'tasa_calificacion' : metric === 'conversion' ? 'tasa_conversion' : 'tasa_agenda';
  const withLeads = results.filter((r) => r.leads > 0);
  if (!withLeads.length) return null;
  return withLeads.reduce((best, r) => (r[key] > best[key] ? r : best)).id;
}

export default async function campaignRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/campaigns', async () => {
    return q(`
      SELECT ca.*, a.name AS account_name,
        (SELECT COUNT(*)::int FROM campaign_variants v WHERE v.campaign_id = ca.id) AS variants_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.campaign_id = ca.id) AS leads_count
      FROM campaigns ca JOIN accounts a ON a.id = ca.account_id
      ORDER BY ca.id DESC`);
  });

  app.post('/api/campaigns', async (req, reply) => {
    const { account_id, name, win_metric = 'agendas' } = req.body || {};
    if (!account_id || !name) return reply.code(400).send({ error: 'Faltan la cuenta o el nombre de la campaña' });
    const ca = await one(`INSERT INTO campaigns (account_id, name, win_metric) VALUES ($1, $2, $3) RETURNING *`, [account_id, String(name).trim(), win_metric]);
    return ca;
  });

  app.get('/api/campaigns/:id', async (req, reply) => {
    const ca = await one(`SELECT ca.*, a.name AS account_name FROM campaigns ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = $1`, [req.params.id]);
    if (!ca) return reply.code(404).send({ error: 'No existe' });
    const variants = await variantsOf(ca.id);
    const results = await campaignResults(ca.id);
    return { ...ca, variants, results, winner_id: pickWinner(results, ca.win_metric) };
  });

  app.put('/api/campaigns/:id', async (req, reply) => {
    const ca = await one(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!ca) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const status = ['active', 'paused', 'finished'].includes(b.status) ? b.status : ca.status;
    const winMetric = ['agendas', 'calificacion', 'conversion'].includes(b.win_metric) ? b.win_metric : ca.win_metric;
    const row = await one(`UPDATE campaigns SET name = $1, status = $2, win_metric = $3 WHERE id = $4 RETURNING *`,
      [String(b.name || ca.name).trim(), status, winMetric, ca.id]);
    return row;
  });

  app.delete('/api/campaigns/:id', async (req) => {
    await q(`DELETE FROM campaigns WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.post('/api/campaigns/:id/variants', async (req, reply) => {
    const ca = await one(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!ca) return reply.code(404).send({ error: 'Campaña no encontrada' });
    const b = req.body || {};
    const v = await one(
      `INSERT INTO campaign_variants (campaign_id, name, weight, prompt_identity, prompt_business, prompt_flow, provider_id, model, temperature, max_msgs, debounce_seconds, followups)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ca.id, String(b.name || 'Agente').trim(), Number(b.weight) || 50, b.prompt_identity || '', b.prompt_business || '', b.prompt_flow || '',
       b.provider_id || null, b.model || '', b.temperature ?? 0.8, b.max_msgs || 3, b.debounce_seconds || 35, JSON.stringify(b.followups || [])]
    );
    return v;
  });

  app.put('/api/variants/:id', async (req, reply) => {
    const existing = await one(`SELECT * FROM campaign_variants WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const f of VARIANT_FIELDS) {
      if (!(f in b)) continue;
      vals.push(JSON_FIELDS.has(f) ? JSON.stringify(b[f]) : b[f]);
      sets.push(`${f} = $${vals.length}${JSON_FIELDS.has(f) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return existing;
    vals.push(existing.id);
    return one(`UPDATE campaign_variants SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  });

  app.delete('/api/variants/:id', async (req) => {
    await q(`DELETE FROM campaign_variants WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });
}
