import { q, one } from '../db.js';
import { scopedAccountId } from '../lib/session.js';

export default async function dashboardRoutes(app) {
  app.get('/api/dashboard', async (req) => {
    const parsed = Number(req.query?.account_id);
    const accountFilter = scopedAccountId(req) || (Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    const cond = accountFilter ? `AND c.account_id = ${accountFilter}` : '';
    const condM = accountFilter
      ? `AND m.conversation_id IN (SELECT id FROM conversations WHERE account_id = ${accountFilter})`
      : '';

    const totals = await one(`
      SELECT
        (SELECT COUNT(*)::int FROM conversations c WHERE true ${cond}) AS conversaciones,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.created_at > now() - interval '24 hours' ${cond}) AS nuevas_24h,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.updated_at > now() - interval '24 hours' ${cond}) AS activas_24h,
        (SELECT COUNT(*)::int FROM messages m WHERE m.direction = 'inbound' AND m.created_at > now() - interval '24 hours' ${condM}) AS recibidos_24h,
        (SELECT COUNT(*)::int FROM messages m WHERE m.direction = 'outbound' AND m.created_at > now() - interval '24 hours' ${condM}) AS enviados_24h,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.last_outbound_at IS NOT NULL ${cond}) AS respondidas,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.source <> 'archivo' AND u.created_at > now() - interval '24 hours' ${accountFilter ? `AND u.account_id = ${accountFilter}` : ''}) AS gasto_24h,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.source <> 'archivo' AND u.created_at > now() - interval '30 days' ${accountFilter ? `AND u.account_id = ${accountFilter}` : ''}) AS gasto_30d,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.source <> 'archivo' ${accountFilter ? `AND u.account_id = ${accountFilter}` : ''}) AS gasto_total,
        (SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'agendado' AND ap.created_at > now() - interval '30 days' ${accountFilter ? `AND ap.account_id = ${accountFilter}` : ''}) AS agendas_30d,
        (SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'cancelado' AND ap.created_at > now() - interval '30 days' ${accountFilter ? `AND ap.account_id = ${accountFilter}` : ''}) AS canceladas_30d
    `);

    const byStage = await q(`
      SELECT stage, COUNT(*)::int AS total FROM conversations c WHERE true ${cond} GROUP BY stage
    `);

    const condA = accountFilter ? `AND ap.account_id = ${accountFilter}` : '';
    const condC = accountFilter ? `AND c2.account_id = ${accountFilter}` : '';
    const daily = await q(`
      SELECT to_char(d, 'YYYY-MM-DD') AS dia,
        COALESCE((SELECT COUNT(*)::int FROM messages m WHERE m.direction='inbound' AND m.created_at::date = d ${condM}), 0) AS recibidos,
        COALESCE((SELECT COUNT(*)::int FROM messages m WHERE m.direction='outbound' AND m.created_at::date = d ${condM}), 0) AS enviados,
        COALESCE((SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'agendado' AND ap.created_at::date = d ${condA}), 0) AS agendas,
        COALESCE((SELECT COUNT(*)::int FROM conversations c2 WHERE c2.created_at::date = d ${condC}), 0) AS leads_nuevos
      FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') AS d
      ORDER BY d
    `);

    const perAccount = await q(`
      SELECT a.id, a.name, a.bot_enabled,
        COUNT(c.id)::int AS conversaciones,
        COUNT(c.id) FILTER (WHERE c.stage = 'calificado')::int AS calificados,
        COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
        COUNT(c.id) FILTER (WHERE c.stage = 'en_seguimiento')::int AS en_seguimiento,
        COUNT(c.id) FILTER (WHERE c.updated_at > now() - interval '24 hours')::int AS activas_24h,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.account_id = a.id) AS gasto_total,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.account_id = a.id AND u.created_at > now() - interval '30 days') AS gasto_30d
      FROM accounts a LEFT JOIN conversations c ON c.account_id = a.id
      ${accountFilter ? `WHERE a.id = ${accountFilter}` : ''}
      GROUP BY a.id ORDER BY a.id
    `);

    const recientes = await q(`
      SELECT c.id, c.lead_name, c.channel, c.stage, c.updated_at, a.name AS account_name,
        (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM conversations c JOIN accounts a ON a.id = c.account_id
      WHERE true ${cond}
      ORDER BY c.updated_at DESC LIMIT 8
    `);

    return { totals, byStage, daily, perAccount, recientes };
  });
}
