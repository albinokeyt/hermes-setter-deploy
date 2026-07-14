import { q, getSetting, setSetting } from '../db.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { requireAdmin } from '../lib/session.js';
import { DEFAULT_GUARDRAIL, invalidateGuardrailCache } from '../services/agent.js';
import { DEFAULT_ARCHITECT } from './promptEditor.js';
import { agencyKey } from './portal.js';

export default async function settingsRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  // Prompts globales: guardarraíl + arquitecto + qué modelo usa el arquitecto y el corrector
  app.get('/api/settings/prompts', async () => {
    const g = (await getSetting('guardrail', null)) || {};
    const a = (await getSetting('architect_prompt', null)) || {};
    const am = (await getSetting('architect_model', {})) || {};
    const cm = (await getSetting('corrector_model', {})) || {};
    return {
      guardrail: g.text || DEFAULT_GUARDRAIL,
      guardrail_default: DEFAULT_GUARDRAIL,
      architect: a.text || DEFAULT_ARCHITECT,
      architect_default: DEFAULT_ARCHITECT,
      architect_provider_id: am.provider_id ?? null,
      architect_model: am.model || '',
      corrector_provider_id: cm.provider_id ?? null,
      corrector_model: cm.model || '',
    };
  });

  app.put('/api/settings/prompts', async (req) => {
    const b = req.body || {};
    if (typeof b.guardrail === 'string') { await setSetting('guardrail', { text: b.guardrail.trim() }); invalidateGuardrailCache(); }
    if (typeof b.architect === 'string') { await setSetting('architect_prompt', { text: b.architect.trim() }); }
    if ('architect_provider_id' in b || 'architect_model' in b) {
      await setSetting('architect_model', { provider_id: b.architect_provider_id || null, model: b.architect_model || '' });
    }
    if ('corrector_provider_id' in b || 'corrector_model' in b) {
      await setSetting('corrector_model', { provider_id: b.corrector_provider_id || null, model: b.corrector_model || '' });
    }
    return { ok: true };
  });

  app.get('/api/settings/ghl', async () => {
    const app_ = (await getSetting('ghl_app', {})) || {};
    const ak = await agencyKey();
    return {
      client_id: app_.client_id || '',
      client_secret_set: Boolean(app_.client_secret),
      sso_secret_set: Boolean(app_.sso_secret),
      app_base_url: config.appBaseUrl,
      redirect_url: `${config.appBaseUrl}/api/oauth/callback`,
      marketplace_webhook_url: `${config.appBaseUrl}/api/webhooks/inbox`,
      agency_menu_url: `${config.appBaseUrl}/ghl-app?key=${ak}&location_id={{location.id}}&email={{user.email}}&name={{user.name}}`,
      custom_page_url: `${config.appBaseUrl}/`,
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
      sso_secret: b.sso_secret ? String(b.sso_secret).trim() : current.sso_secret || '',
    };
    await setSetting('ghl_app', next);
    return { ok: true };
  });

  app.get('/api/settings/webhook-log', async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    return q(`SELECT * FROM webhook_log ORDER BY id DESC LIMIT $1`, [limit]);
  });
}
