import { q, getSetting, setSetting } from '../db.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { requireAdmin } from '../lib/session.js';

export default async function settingsRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/settings/ghl', async () => {
    const app_ = (await getSetting('ghl_app', {})) || {};
    return {
      client_id: app_.client_id || '',
      client_secret_set: Boolean(app_.client_secret),
      app_base_url: config.appBaseUrl,
      redirect_url: `${config.appBaseUrl}/api/oauth/callback`,
      marketplace_webhook_url: `${config.appBaseUrl}/api/webhooks/inbox`,
      scopes: OAUTH_SCOPES,
      signature_check: !config.allowUnsignedWebhooks,
    };
  });

  app.put('/api/settings/ghl', async (req) => {
    const current = (await getSetting('ghl_app', {})) || {};
    const b = req.body || {};
    const next = {
      client_id: b.client_id !== undefined ? String(b.client_id).trim() : current.client_id || '',
      client_secret: b.client_secret ? String(b.client_secret).trim() : current.client_secret || '',
    };
    await setSetting('ghl_app', next);
    return { ok: true };
  });

  app.get('/api/settings/webhook-log', async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    return q(`SELECT * FROM webhook_log ORDER BY id DESC LIMIT $1`, [limit]);
  });
}
