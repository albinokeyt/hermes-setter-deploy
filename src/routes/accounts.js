import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, scopedAccountId, requireManageAgents, accessibleAccountIds, canAccessAccount } from '../lib/session.js';
import * as ghl from '../services/ghl.js';

const ADMIN_EDITABLE = [
  'name', 'alias', 'mode', 'pit_token', 'location_id', 'channels', 'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'active_hours',
  'timezone', 'sync_tags', 'auto_handoff', 'bot_enabled', 'ai_enabled', 'test_mode', 'test_tag', 'exclude_tag',
  'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
  'calendar_id', 'calendar_ids', 'auto_handoff_minutes', 'required_tags', 'required_tags_mode', 'ctas',
];

// Un usuario normal solo toca su agente: prompt, comportamiento y seguimientos.
const USER_EDITABLE = [
  'alias',
  'prompt_identity', 'prompt_business', 'prompt_flow', 'followups', 'debounce_seconds', 'max_msgs',
  'active_hours', 'timezone', 'temperature', 'bot_enabled', 'test_mode', 'test_tag', 'auto_handoff_minutes',
  'required_tags', 'required_tags_mode',
];

const JSON_FIELDS = new Set(['channels', 'followups', 'active_hours', 'calendar_ids', 'required_tags', 'ctas']);

function stripSecrets(row, req) {
  if (req.auth?.role === 'admin') return row;
  // el token crudo de comentarios no se expone; solo la URL ya montada (comment_webhook_url)
  const { pit_token, webhook_token, webhook_url, portal_key, portal_url, comment_token, ...safe } = row;
  return safe;
}

export default async function accountRoutes(app) {
  app.get('/api/accounts', async (req) => {
    const ids = await accessibleAccountIds(req); // null = admin (todas)
    const rows = await q(`
      SELECT a.*, p.name AS provider_name,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id) AS conversations_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id AND c.updated_at > now() - interval '24 hours') AS active_24h,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id
      ${ids ? 'WHERE a.id = ANY($1::int[])' : ''}
      ORDER BY a.id`, ids ? [ids] : []);
    return rows.map((r) => {
      // URL del webhook de comentarios (para pegar en GHL); el token crudo se elimina en stripSecrets.
      r.comment_webhook_url = `${config.appBaseUrl}/api/webhooks/comment/${r.comment_token}`;
      return stripSecrets(r, req);
    });
  });

  app.get('/api/accounts/:id', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const row = await one(`
      SELECT a.*, p.name AS provider_name,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    row.webhook_url = `${config.appBaseUrl}/api/webhooks/workflow/${row.webhook_token}`;
    row.comment_webhook_url = `${config.appBaseUrl}/api/webhooks/comment/${row.comment_token}`;
    if (req.auth?.role === 'admin') {
      row.portal_url = `${config.appBaseUrl}/ghl-portal?key=${row.portal_key}&location_id={{location.id}}&email={{user.email}}&name={{user.name}}`;
    }
    return stripSecrets(row, req);
  });

  app.post('/api/accounts', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'Ponle un nombre a la cuenta' });
    const token = crypto.randomBytes(16).toString('hex');
    const portalKey = crypto.randomBytes(24).toString('hex');
    const row = await one(
      `INSERT INTO accounts (name, webhook_token, portal_key) VALUES ($1, $2, $3) RETURNING *`,
      [String(name).trim(), token, portalKey]
    );
    // Toda conexión arranca con su setter principal (para tener siempre a quién enrutar).
    await q(`INSERT INTO setters (account_id, name, is_default) VALUES ($1, 'Setter principal', true)`, [row.id]);
    return row;
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const existing = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const editable = req.auth?.role === 'admin' ? ADMIN_EDITABLE : USER_EDITABLE;
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const field of editable) {
      if (!(field in b)) continue;
      vals.push(JSON_FIELDS.has(field) ? JSON.stringify(b[field]) : b[field] === '' && field === 'location_id' ? null : b[field]);
      sets.push(`${field} = $${vals.length}${JSON_FIELDS.has(field) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return stripSecrets(existing, req);
    vals.push(existing.id);
    const row = await one(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    return stripSecrets(row, req);
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    await q(`DELETE FROM accounts WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  // Alias (nombre visible): lo cambia el DUEÑO aunque la IA esté apagada — renombrar NO es función
  // de IA, así que NO pasa por requireManageAgents, solo por canAccessAccount.
  app.put('/api/accounts/:id/alias', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const alias = String(req.body?.alias ?? '').trim().slice(0, 80);
    const row = await one(`UPDATE accounts SET alias = $1 WHERE id = $2 RETURNING *`, [alias, req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    return stripSecrets(row, req);
  });

  // Registro reciente del webhook de comentarios de ESTA conexión (para probar que llega).
  // Los recibidos salen de la tabla comments (durable, no se purga); los intentos sin texto o
  // duplicados salen de webhook_log (traza efímera, con tope global de ~2000 filas) solo como ayuda.
  app.get('/api/accounts/:id/comment-log', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const received = await q(
      `SELECT id, author, author_id, text, post_ref, channel, raw, created_at
       FROM comments WHERE account_id = $1 ORDER BY id DESC LIMIT 20`,
      [req.params.id]
    );
    const issues = await q(
      `SELECT id, kind, payload, created_at FROM webhook_log
       WHERE kind IN ('comentario_incompleto', 'comentario_duplicado') AND payload->>'account' = $1
       ORDER BY id DESC LIMIT 10`,
      [String(req.params.id)]
    );
    return { received, issues };
  });

  // Lista de calendarios de la subcuenta (desde GHL; si falta el scope, usa los vistos en citas).
  app.get('/api/accounts/:id/calendars', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    if (!account.location_id) return { calendars: [], source: 'sin_conexion' };
    try {
      const cals = await ghl.listCalendars(account, account.location_id);
      if (cals.length) return { calendars: cals, source: 'ghl' };
    } catch (err) {
      // scope no concedido u otro error → seguimos al fallback
    }
    const seen = await q(
      `SELECT DISTINCT calendar_id AS id FROM appointments WHERE account_id = $1 AND calendar_id IS NOT NULL AND calendar_id <> ''`,
      [account.id]
    );
    return { calendars: seen.map((s) => ({ id: s.id, name: s.id })), source: 'historial' };
  });
}
