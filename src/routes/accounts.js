import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { config } from '../config.js';

const EDITABLE = [
  'name', 'mode', 'pit_token', 'location_id', 'channels', 'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'active_hours',
  'timezone', 'sync_tags', 'auto_handoff', 'bot_enabled', 'test_mode', 'test_tag',
];

const JSON_FIELDS = new Set(['channels', 'followups', 'active_hours']);

export default async function accountRoutes(app) {
  app.get('/api/accounts', async () => {
    return q(`
      SELECT a.*, p.name AS provider_name,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id) AS conversations_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id AND c.updated_at > now() - interval '24 hours') AS active_24h,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id
      ORDER BY a.id`);
  });

  app.get('/api/accounts/:id', async (req, reply) => {
    const row = await one(`
      SELECT a.*, p.name AS provider_name,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    row.webhook_url = `${config.appBaseUrl}/api/webhooks/workflow/${row.webhook_token}`;
    return row;
  });

  app.post('/api/accounts', async (req, reply) => {
    const { name } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'Ponle un nombre a la cuenta' });
    const token = crypto.randomBytes(16).toString('hex');
    const row = await one(
      `INSERT INTO accounts (name, webhook_token) VALUES ($1, $2) RETURNING *`,
      [String(name).trim(), token]
    );
    return row;
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    const existing = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const field of EDITABLE) {
      if (!(field in b)) continue;
      vals.push(JSON_FIELDS.has(field) ? JSON.stringify(b[field]) : b[field] === '' && field === 'location_id' ? null : b[field]);
      sets.push(`${field} = $${vals.length}${JSON_FIELDS.has(field) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return existing;
    vals.push(existing.id);
    const row = await one(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    return row;
  });

  app.delete('/api/accounts/:id', async (req) => {
    await q(`DELETE FROM accounts WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });
}
