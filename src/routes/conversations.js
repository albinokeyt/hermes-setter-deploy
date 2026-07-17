import { q, one } from '../db.js';
import { STAGES, STAGE_KEYS } from '../config.js';
import { applyStage, cancelBotJobs, invalidateContactTags } from '../services/pipeline.js';
import * as ghl from '../services/ghl.js';
import { accessibleAccountIds, canAccessAccount } from '../lib/session.js';

async function loadScopedConv(req, reply) {
  const conv = await one(`SELECT * FROM conversations WHERE id = $1`, [req.params.id]);
  if (!conv) {
    reply.code(404).send({ error: 'No existe' });
    return null;
  }
  if (!(await canAccessAccount(req, conv.account_id))) {
    reply.code(403).send({ error: 'Sin acceso a esta conversación' });
    return null;
  }
  return conv;
}

export default async function conversationRoutes(app) {
  app.get('/api/stages', async () => STAGES);

  app.get('/api/conversations', async (req) => {
    const { stage, search, setter_id, human, limit = 50, offset = 0 } = req.query || {};
    const ids = await accessibleAccountIds(req); // null = admin (todas)
    const where = [];
    const vals = [];
    if (ids) { vals.push(ids); where.push(`c.account_id = ANY($${vals.length}::int[])`); }
    if (req.query?.account_id) { vals.push(req.query.account_id); where.push(`c.account_id = $${vals.length}`); }
    if (setter_id) { vals.push(setter_id); where.push(`c.setter_id = $${vals.length}`); }
    if (stage) { vals.push(stage); where.push(`c.stage = $${vals.length}`); }
    if (search) { vals.push(`%${search}%`); where.push(`(c.lead_name ILIKE $${vals.length} OR c.lead_email ILIKE $${vals.length} OR c.ghl_contact_id ILIKE $${vals.length})`); }
    // filtro por intervención humana: '1' = donde un humano ha escrito; 'ia' = solo IA
    const humanExists = `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.source = 'humano')`;
    if (human === '1') where.push(humanExists);
    else if (human === 'ia') where.push(`NOT ${humanExists}`);
    vals.push(Math.min(Number(limit) || 50, 200));
    vals.push(Number(offset) || 0);
    return q(
      `SELECT c.id, c.account_id, c.setter_id, c.channel, c.lead_name, c.lead_email, c.ghl_contact_id, c.stage, c.bot_paused, c.paused_by,
              c.followup_state, c.last_inbound_at, c.last_outbound_at, c.updated_at, COALESCE(NULLIF(a.alias,''), a.name) AS account_name, a.location_id,
              st.name AS setter_name,
              ${humanExists} AS human_touched,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
              (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_direction
       FROM conversations c
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN setters st ON st.id = c.setter_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.updated_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const base = await loadScopedConv(req, reply);
    if (!base) return;
    const conv = await one(
      `SELECT c.*, COALESCE(NULLIF(a.alias,''), a.name) AS account_name, a.channels AS account_channels, a.location_id, st.name AS setter_name
       FROM conversations c JOIN accounts a ON a.id = c.account_id
       LEFT JOIN setters st ON st.id = c.setter_id
       WHERE c.id = $1`,
      [base.id]
    );
    // Los 500 MÁS RECIENTES (no los más antiguos), luego en orden cronológico ascendente para pintar.
    const messages = await q(
      `SELECT * FROM (
         SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500
       ) t ORDER BY created_at ASC, id ASC`,
      [conv.id]
    );
    const history = await q(`SELECT * FROM stage_history WHERE conversation_id = $1 ORDER BY id DESC LIMIT 20`, [conv.id]);
    return { ...conv, messages, stage_history: history };
  });

  app.put('/api/conversations/:id', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    const b = req.body || {};

    if (typeof b.bot_paused === 'boolean' && b.bot_paused !== conv.bot_paused) {
      // pausa manual: marca 'manual' (no se reactiva sola). Reactivar a mano limpia el estado.
      const pausedBy = b.bot_paused ? 'manual' : '';
      await q(`UPDATE conversations SET bot_paused = $1, paused_by = $2, updated_at = now() WHERE id = $3`, [b.bot_paused, pausedBy, conv.id]);
      await cancelBotJobs(conv.id); // cancela debounce, seguimientos y cualquier reactivación pendiente
    }
    if (b.stage && STAGE_KEYS.includes(b.stage) && b.stage !== conv.stage) {
      await applyStage(conv, account, b.stage, 'cambio manual desde el panel');
      // Sacar la conversación de «atención humana» reactiva el bot (quita la pausa que puso la IA).
      if (conv.stage === 'atencion_humana' && b.stage !== 'atencion_humana' && conv.paused_by === 'ia') {
        await q(`UPDATE conversations SET bot_paused = false, paused_by = '', updated_at = now() WHERE id = $1`, [conv.id]);
      }
    }
    if (b.memory && typeof b.memory === 'object') {
      await q(`UPDATE conversations SET memory = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(b.memory), conv.id]);
    }
    return one(`SELECT * FROM conversations WHERE id = $1`, [conv.id]);
  });

  // Borra la conversación por completo (chat + memoria + sesión) para que el contacto
  // vuelva a entrar como NUEVO. Útil para pruebas. No toca el contacto en GHL.
  app.delete('/api/conversations/:id', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    await cancelBotJobs(conv.id); // cancela debounce/seguimientos/reactivación pendientes
    await q(`DELETE FROM llm_usage WHERE conversation_id = $1`, [conv.id]);
    await q(`DELETE FROM appointments WHERE conversation_id = $1`, [conv.id]);
    await q(`DELETE FROM conversations WHERE id = $1`, [conv.id]); // cascada: mensajes + historial
    return { ok: true };
  });

  // envío manual desde el panel (toma el control: pausa el bot)
  app.post('/api/conversations/:id/send', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    const message = String(req.body?.message || '').trim();
    if (!message) return reply.code(400).send({ error: 'Mensaje vacío' });
    try {
      const res = await ghl.sendMessage(account, { channel: conv.channel, contactId: conv.ghl_contact_id, message });
      await q(
        `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id) VALUES ($1,'outbound','humano',$2,$3)`,
        [conv.id, message, res?.messageId || null]
      );
      await q(`UPDATE conversations SET bot_paused = true, paused_by = 'manual', last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
      await cancelBotJobs(conv.id);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // conteos por etiqueta (rápido, para las cabeceras del tablero con muchos leads)
  // Sacar/volver a meter un contacto en las IAs (etiqueta de exclusión general en GHL).
  app.post('/api/conversations/:id/exclude', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    // usa la etiqueta configurada; si no hay, define 'sin-ia' y la deja fijada en la conexión
    let tag = String(account.exclude_tag || '').trim();
    if (!tag) { tag = 'sin-ia'; await q(`UPDATE accounts SET exclude_tag = $1 WHERE id = $2`, [tag, account.id]); }
    try {
      await ghl.addTags(account, conv.ghl_contact_id, [tag]);
    } catch (err) {
      return reply.code(502).send({ error: `No se pudo poner la etiqueta en GHL: ${err.message}` });
    }
    await q(`UPDATE conversations SET bot_paused = true, paused_by = 'excluido', updated_at = now() WHERE id = $1`, [conv.id]);
    await cancelBotJobs(conv.id);
    await invalidateContactTags(account.id, conv.ghl_contact_id);
    return { ok: true, tag };
  });

  app.post('/api/conversations/:id/include', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    const tag = String(account.exclude_tag || 'sin-ia').trim();
    try {
      await ghl.removeTags(account, conv.ghl_contact_id, [tag]);
    } catch (err) {
      return reply.code(502).send({ error: `No se pudo quitar la etiqueta en GHL: ${err.message}` });
    }
    await q(`UPDATE conversations SET bot_paused = false, paused_by = '', updated_at = now() WHERE id = $1`, [conv.id]);
    await invalidateContactTags(account.id, conv.ghl_contact_id);
    return { ok: true };
  });

  app.get('/api/kanban/counts', async (req) => {
    const ids = await accessibleAccountIds(req);
    const where = [];
    const vals = [];
    if (ids) { vals.push(ids); where.push(`account_id = ANY($${vals.length}::int[])`); }
    if (req.query?.account_id) { vals.push(req.query.account_id); where.push(`account_id = $${vals.length}`); }
    const rows = await q(
      `SELECT stage, COUNT(*)::int AS n FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY stage`,
      vals
    );
    const counts = {};
    for (const r of rows) counts[r.stage] = r.n;
    return counts;
  });

  app.get('/api/kanban', async (req) => {
    const ids = await accessibleAccountIds(req);
    const rows = await q(
      `SELECT c.id, c.lead_name, c.ghl_contact_id, c.channel, c.stage, c.updated_at, c.bot_paused,
              COALESCE(NULLIF(a.alias,''), a.name) AS account_name,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
       FROM conversations c JOIN accounts a ON a.id = c.account_id
       ${ids ? 'WHERE c.account_id = ANY($1::int[])' : ''}
       ORDER BY c.updated_at DESC LIMIT 400`,
      ids ? [ids] : []
    );
    const board = {};
    for (const s of STAGE_KEYS) board[s] = [];
    for (const r of rows) if (board[r.stage]) board[r.stage].push(r);
    return board;
  });
}
