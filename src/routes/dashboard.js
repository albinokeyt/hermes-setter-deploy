import { q, one } from '../db.js';
import { scopedAccountId } from '../lib/session.js';

const DAY = 86400000;

// Rango de fechas [from, to] validado y acotado (máx. 366 días).
function parseRange(query) {
  const now = new Date();
  const parse = (s, fb) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? fb : d; };
  let to = parse(query?.to, now);
  let from = parse(query?.from, new Date(now.getTime() - 29 * DAY));
  from = new Date(from); from.setHours(0, 0, 0, 0);
  to = new Date(to); to.setHours(23, 59, 59, 999);
  if (from > to) [from, to] = [to, from];
  if (to.getTime() - from.getTime() > 366 * DAY) from = new Date(to.getTime() - 366 * DAY);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default async function dashboardRoutes(app) {
  app.get('/api/dashboard', async (req) => {
    const parsed = Number(req.query?.account_id);
    const accountFilter = scopedAccountId(req) || (Number.isInteger(parsed) && parsed > 0 ? parsed : null);
    const { from, to } = parseRange(req.query || {});
    const P = [from, to]; // $1 = desde, $2 = hasta

    const cond = accountFilter ? `AND c.account_id = ${accountFilter}` : '';
    const condM = accountFilter
      ? `AND m.conversation_id IN (SELECT id FROM conversations WHERE account_id = ${accountFilter})`
      : '';
    const condA = accountFilter ? `AND ap.account_id = ${accountFilter}` : '';
    const condU = accountFilter ? `AND u.account_id = ${accountFilter}` : '';

    const totals = await one(`
      SELECT
        (SELECT COUNT(*)::int FROM conversations c WHERE true ${cond}) AS conversaciones_total,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.created_at BETWEEN $1 AND $2 ${cond}) AS nuevas,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.updated_at BETWEEN $1 AND $2 ${cond}) AS activas,
        (SELECT COUNT(*)::int FROM messages m WHERE m.direction = 'inbound' AND m.created_at BETWEEN $1 AND $2 ${condM}) AS recibidos,
        (SELECT COUNT(*)::int FROM messages m WHERE m.direction = 'outbound' AND m.created_at BETWEEN $1 AND $2 ${condM}) AS enviados,
        (SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'agendado' AND ap.created_at BETWEEN $1 AND $2 ${condA}) AS agendas,
        (SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'cancelado' AND ap.created_at BETWEEN $1 AND $2 ${condA}) AS canceladas,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.source <> 'archivo' AND u.created_at BETWEEN $1 AND $2 ${condU}) AS gasto
    `, P);

    // Estado actual del pipeline (no depende del rango)
    const byStage = await q(`
      SELECT stage, COUNT(*)::int AS total FROM conversations c WHERE true ${cond} GROUP BY stage
    `);

    const condC = accountFilter ? `AND c2.account_id = ${accountFilter}` : '';
    const daily = await q(`
      SELECT to_char(d, 'YYYY-MM-DD') AS dia,
        COALESCE((SELECT COUNT(*)::int FROM messages m WHERE m.direction='inbound' AND m.created_at::date = d ${condM}), 0) AS recibidos,
        COALESCE((SELECT COUNT(*)::int FROM messages m WHERE m.direction='outbound' AND m.created_at::date = d ${condM}), 0) AS enviados,
        COALESCE((SELECT COUNT(*)::int FROM appointments ap WHERE ap.status = 'agendado' AND ap.created_at::date = d ${condA}), 0) AS agendas,
        COALESCE((SELECT COUNT(*)::int FROM conversations c2 WHERE c2.created_at::date = d ${condC}), 0) AS leads_nuevos
      FROM generate_series($1::date, $2::date, interval '1 day') AS d
      ORDER BY d
    `, P);

    const perAccount = await q(`
      SELECT a.id, a.name, a.bot_enabled,
        COUNT(c.id)::int AS conversaciones,
        COUNT(c.id) FILTER (WHERE c.stage = 'calificado')::int AS calificados,
        COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
        COUNT(c.id) FILTER (WHERE c.stage IN ('en_seguimiento','seguimiento_calificado'))::int AS en_seguimiento,
        COUNT(c.id) FILTER (WHERE c.updated_at BETWEEN $1 AND $2)::int AS activas,
        (SELECT COALESCE(SUM(u.cost_usd), 0) FROM llm_usage u WHERE u.account_id = a.id AND u.source <> 'archivo' AND u.created_at BETWEEN $1 AND $2) AS gasto
      FROM accounts a LEFT JOIN conversations c ON c.account_id = a.id
      ${accountFilter ? `WHERE a.id = ${accountFilter}` : ''}
      GROUP BY a.id ORDER BY a.id
    `, P);

    const recientes = await q(`
      SELECT c.id, c.lead_name, c.channel, c.stage, c.updated_at, a.name AS account_name,
        (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM conversations c JOIN accounts a ON a.id = c.account_id
      WHERE true ${cond}
      ORDER BY c.updated_at DESC LIMIT 8
    `);

    // Gasto de IA por tipo dentro del rango (chat, seguimiento, imagen, audio, pruebas)
    const gastoPorTipo = await q(`
      SELECT source, COALESCE(SUM(cost_usd), 0) AS total
      FROM llm_usage
      WHERE source <> 'archivo' AND created_at BETWEEN $1 AND $2
        ${accountFilter ? `AND account_id = ${accountFilter}` : ''}
      GROUP BY source ORDER BY total DESC
    `, P);

    return { range: { from, to }, totals, byStage, daily, perAccount, recientes, gastoPorTipo };
  });
}
