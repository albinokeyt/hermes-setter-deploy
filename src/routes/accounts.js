import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, scopedAccountId } from '../lib/session.js';

const ADMIN_EDITABLE = [
  'name', 'mode', 'pit_token', 'location_id', 'channels', 'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'active_hours',
  'timezone', 'sync_tags', 'auto_handoff', 'bot_enabled', 'test_mode', 'test_tag',
  'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
];

// Un usuario normal solo toca su agente: prompt, comportamiento y seguimientos.
const USER_EDITABLE = [
  'prompt_identity', 'prompt_business', 'prompt_flow', 'followups', 'debounce_seconds', 'max_msgs',
  'active_hours', 'timezone', 'temperature', 'bot_enabled', 'test_mode', 'test_tag',
];

const JSON_FIELDS = new Set(['channels', 'followups', 'active_hours']);

function stripSecrets(row, req) {
  if (req.auth?.role === 'admin') return row;
  const { pit_token, webhook_token, webhook_url, portal_key, portal_url, ...safe } = row;
  return safe;
}

export default async function accountRoutes(app) {
  app.get('/api/accounts', async (req) => {
    const scope = scopedAccountId(req);
    const rows = await q(`
      SELECT a.*, p.name AS provider_name,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id) AS conversations_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id AND c.updated_at > now() - interval '24 hours') AS active_24h,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id
      ${scope ? 'WHERE a.id = $1' : ''}
      ORDER BY a.id`, scope ? [scope] : []);
    return rows.map((r) => stripSecrets(r, req));
  });

  app.get('/api/accounts/:id', async (req, reply) => {
    const scope = scopedAccountId(req);
    if (scope && Number(req.params.id) !== scope) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const row = await one(`
      SELECT a.*, p.name AS provider_name,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    row.webhook_url = `${config.appBaseUrl}/api/webhooks/workflow/${row.webhook_token}`;
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
    return row;
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    const scope = scopedAccountId(req);
    if (scope && Number(req.params.id) !== scope) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
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
}
