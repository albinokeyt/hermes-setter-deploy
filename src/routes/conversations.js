import { q, one } from '../db.js';
import { STAGES, STAGE_KEYS } from '../config.js';
import { applyStage, cancelBotJobs } from '../services/pipeline.js';
import * as ghl from '../services/ghl.js';
import { scopedAccountId } from '../lib/session.js';

async function loadScopedConv(req, reply) {
  const conv = await one(`SELECT * FROM conversations WHERE id = $1`, [req.params.id]);
  if (!conv) {
    reply.code(404).send({ error: 'No existe' });
    return null;
  }
  const scope = scopedAccountId(req);
  if (scope && conv.account_id !== scope) {
    reply.code(403).send({ error: 'Sin acceso a esta conversación' });
    return null;
  }
  return conv;
}

export default async function conversationRoutes(app) {
  app.get('/api/stages', async () => STAGES);

  app.get('/api/conversations', async (req) => {
    const { stage, search, limit = 50, offset = 0 } = req.query || {};
    const account_id = scopedAccountId(req) || req.query?.account_id;
    const where = [];
    const vals = [];
    if (account_id) { vals.push(account_id); where.push(`c.account_id = $${vals.length}`); }
    if (stage) { vals.push(stage); where.push(`c.stage = $${vals.length}`); }
    if (search) { vals.push(`%${search}%`); where.push(`(c.lead_name ILIKE $${vals.length} OR c.ghl_contact_id ILIKE $${vals.length})`); }
    vals.push(Math.min(Number(limit) || 50, 200));
    vals.push(Number(offset) || 0);
    return q(
      `SELECT c.id, c.account_id, c.channel, c.lead_name, c.ghl_contact_id, c.stage, c.bot_paused,
              c.followup_state, c.last_inbound_at, c.last_outbound_at, c.updated_at, a.name AS account_name,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_direction
       FROM conversations c JOIN accounts a ON a.id = c.account_id
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
      `SELECT c.*, a.name AS account_name, a.channels AS account_channels
       FROM conversations c JOIN accounts a ON a.id = c.account_id WHERE c.id = $1`,
      [base.id]
    );
    const messages = await q(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT 500`, [conv.id]);
    const history = await q(`SELECT * FROM stage_history WHERE conversation_id = $1 ORDER BY id DESC LIMIT 20`, [conv.id]);
    return { ...conv, messages, stage_history: history };
  });

  app.put('/api/conversations/:id', async (req, reply) => {
    const conv = await loadScopedConv(req, reply);
    if (!conv) return;
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    const b = req.body || {};

    if (typeof b.bot_paused === 'boolean' && b.bot_paused !== conv.bot_paused) {
      await q(`UPDATE conversations SET bot_paused = $1, updated_at = now() WHERE id = $2`, [b.bot_paused, conv.id]);
      if (b.bot_paused) await cancelBotJobs(conv.id);
    }
    if (b.stage && STAGE_KEYS.includes(b.stage) && b.stage !== conv.stage) {
      await applyStage(conv, account, b.stage, 'cambio manual desde el panel');
    }
    if (b.memory && typeof b.memory === 'object') {
      await q(`UPDATE conversations SET memory = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(b.memory), conv.id]);
    }
    return one(`SELECT * FROM conversations WHERE id = $1`, [conv.id]);
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
      await q(`UPDATE conversations SET bot_paused = true, last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
      await cancelBotJobs(conv.id);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  app.get('/api/kanban', async (req) => {
    const scope = scopedAccountId(req);
    const rows = await q(
      `SELECT c.id, c.lead_name, c.ghl_contact_id, c.channel, c.stage, c.updated_at, c.bot_paused,
              a.name AS account_name,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM conversations c JOIN accounts a ON a.id = c.account_id
       ${scope ? 'WHERE c.account_id = $1' : ''}
       ORDER BY c.updated_at DESC LIMIT 400`,
      scope ? [scope] : []
    );
    const board = {};
    for (const s of STAGE_KEYS) board[s] = [];
    for (const r of rows) if (board[r.stage]) board[r.stage].push(r);
    return board;
  });
}
