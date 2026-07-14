import { q, one, getSetting, setSetting } from '../db.js';
import { requireAdmin } from '../lib/session.js';
import { chatCompletion } from '../services/llm.js';
import { recordUsage, invalidateArchiveCache } from '../services/pipeline.js';

function quien(m) {
  if (m.direction === 'inbound') return 'Lead';
  if (m.source === 'humano') return 'Humano';
  if (m.source === 'seguimiento') return 'Seguimiento IA';
  return 'Setter IA';
}

// Construye el WHERE de los filtros de la sección.
function buildFilter(query) {
  const where = [];
  const vals = [];
  const aid = Number(query.account_id);
  if (Number.isInteger(aid) && aid > 0) { vals.push(aid); where.push(`c.account_id = $${vals.length}`); }
  if (query.direction === 'inbound' || query.direction === 'outbound') { vals.push(query.direction); where.push(`m.direction = $${vals.length}`); }
  if (query.search) { vals.push(`%${query.search}%`); where.push(`m.body ILIKE $${vals.length}`); }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

// Escapa un valor para CSV y neutraliza inyección de fórmulas (=, +, -, @, tab, CR).
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const BASE_SELECT = `
  SELECT m.id, m.created_at, m.direction, m.source, m.body,
         c.lead_name, c.channel, c.ghl_contact_id, a.name AS account_name
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN accounts a ON a.id = c.account_id`;

export default async function archiveRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/archive/settings', async () => {
    return (await getSetting('archive', { enabled: true, provider_id: null, model: '' })) || { enabled: true };
  });

  app.put('/api/archive/settings', async (req) => {
    const cur = (await getSetting('archive', {})) || {};
    const b = req.body || {};
    const next = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled !== false,
      provider_id: b.provider_id !== undefined ? b.provider_id || null : cur.provider_id ?? null,
      model: b.model !== undefined ? b.model : cur.model || '',
    };
    await setSetting('archive', next);
    invalidateArchiveCache();
    return next;
  });

  app.get('/api/archive/messages', async (req) => {
    const { clause, vals } = buildFilter(req.query || {});
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    const offset = Number(req.query?.offset) || 0;
    const total = await one(`SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id ${clause}`, vals);
    const rows = await q(
      `${BASE_SELECT} ${clause} ORDER BY m.id DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    );
    return { total: total?.n || 0, messages: rows.map((m) => ({ ...m, quien: quien(m) })) };
  });

  // Comentarios entrantes de Instagram (recibidos por webhook).
  app.get('/api/archive/comments', async (req) => {
    const where = [];
    const vals = [];
    const aid = Number(req.query?.account_id);
    if (Number.isInteger(aid) && aid > 0) { vals.push(aid); where.push(`co.account_id = $${vals.length}`); }
    if (req.query?.search) { vals.push(`%${req.query.search}%`); where.push(`(co.text ILIKE $${vals.length} OR co.author ILIKE $${vals.length})`); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Number(req.query?.limit) || 100, 500);
    const offset = Number(req.query?.offset) || 0;
    const total = await one(`SELECT COUNT(*)::int AS n FROM comments co ${clause}`, vals);
    const rows = await q(
      `SELECT co.id, co.created_at, co.author, co.author_id, co.text, co.post_ref, co.channel, a.name AS account_name
       FROM comments co LEFT JOIN accounts a ON a.id = co.account_id
       ${clause} ORDER BY co.id DESC LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    );
    return { total: total?.n || 0, comments: rows };
  });

  app.get('/api/archive/export', async (req, reply) => {
    const { clause, vals } = buildFilter(req.query || {});
    const rows = await q(`${BASE_SELECT} ${clause} ORDER BY m.id DESC LIMIT 50000`, vals);
    const header = ['Fecha', 'Hora', 'Cuenta', 'Canal', 'Lead', 'Direccion', 'Quien', 'Mensaje'];
    const lines = [header.map(csvCell).join(',')];
    for (const m of rows) {
      const d = new Date(m.created_at);
      lines.push([
        d.toISOString().slice(0, 10),
        d.toISOString().slice(11, 19),
        m.account_name,
        m.channel,
        m.lead_name || m.ghl_contact_id,
        m.direction === 'inbound' ? 'Entrante' : 'Saliente',
        quien(m),
        m.body,
      ].map(csvCell).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="mensajes-hermes.csv"`);
    return '﻿' + lines.join('\r\n');
  });

  app.get('/api/archive/spend', async () => {
    const row = await one(`
      SELECT
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '24 hours'), 0) AS d24,
        COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS d30,
        COALESCE(SUM(cost_usd), 0) AS total,
        COUNT(*)::int AS preguntas
      FROM llm_usage WHERE source = 'archivo'`);
    return row || { d24: 0, d30: 0, total: 0, preguntas: 0 };
  });

  // La IA de la sección: responde preguntas SOBRE los mensajes filtrados.
  app.post('/api/archive/ask', async (req, reply) => {
    const b = req.body || {};
    const question = String(b.question || '').trim();
    if (!question) return reply.code(400).send({ error: 'Escribe una pregunta' });
    const provider = b.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [b.provider_id]) : null;
    if (!provider) return reply.code(400).send({ error: 'Elige un modelo de texto para la IA de esta sección' });

    const { clause, vals } = buildFilter(b);
    // newest-first; recortamos por presupuesto quedándonos con los MÁS RECIENTES,
    // luego los ordenamos cronológicamente para el prompt.
    const rows = await q(`${BASE_SELECT} ${clause} ORDER BY m.id DESC LIMIT 500`, vals);
    const fmt = (m) => {
      const d = new Date(m.created_at);
      return `[${d.toISOString().slice(0, 16).replace('T', ' ')}] ${m.account_name} · ${m.lead_name || m.ghl_contact_id} (${m.channel}) ${quien(m)}: ${String(m.body).replace(/\s+/g, ' ')}\n`;
    };
    const kept = [];
    let used = 0;
    for (const m of rows) { // recorre del más nuevo al más viejo
      const line = fmt(m);
      if (used + line.length > 14000) break;
      kept.push(m);
      used += line.length;
    }
    kept.reverse(); // cronológico para el prompt
    const context = kept.map(fmt).join('');

    const system =
      'Eres un analista de conversaciones de ventas. Responde en español, con datos concretos, SOLO en base a los mensajes reales de abajo (fecha, cuenta, lead, quién habla y texto). ' +
      'Si te piden conteos, cuenta sobre los mensajes disponibles y aclara que es sobre la muestra cargada. No inventes nada que no esté en los mensajes.\n\n=== MENSAJES ===\n' +
      (context || '(no hay mensajes con esos filtros)');

    let result;
    try {
      result = await chatCompletion({
        provider,
        model: b.model || provider.default_model,
        temperature: 0.3,
        maxTokens: 900,
        json: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      });
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
    // gasto atribuido a 'archivo' (account_id null) → excluido del panel principal
    await recordUsage(null, null, provider, b.model || provider.default_model, result.usage, 'archivo');
    return { answer: result.content, muestra: kept.length };
  });
}
