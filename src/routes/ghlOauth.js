import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { exchangeCode, saveTokens, getLocationName } from '../services/ghl.js';
import { logEvent } from '../services/pipeline.js';
import { requireAdmin } from '../lib/session.js';

// OJO: las rutas públicas no pueden contener "ghl" — el validador del marketplace
// de GHL rechaza redirect URLs con referencias a HighLevel.
export default async function ghlOauthRoutes(app) {
  // devuelve la URL de instalación (con state anti-CSRF vinculado a la cuenta que conecta).
  // Solo admin: conectar/rebindear subcuentas es operación de administración.
  app.get('/api/oauth/url', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const creds = (await getSetting('ghl_app', {})) || {};
    if (!creds.client_id) return reply.code(400).send({ error: 'Configura primero el Client ID en Configuración' });

    const accountId = Number(req.query?.account_id);
    if (accountId) {
      const acc = await one(`SELECT id FROM accounts WHERE id = $1`, [accountId]);
      if (!acc) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    await redis.setex(`oauthstate:${nonce}`, 600, String(accountId || ''));

    const redirect = `${config.appBaseUrl}/api/oauth/callback`;
    const url =
      'https://marketplace.gohighlevel.com/oauth/chooselocation' +
      `?response_type=code&redirect_uri=${encodeURIComponent(redirect)}` +
      `&client_id=${encodeURIComponent(creds.client_id)}` +
      `&scope=${OAUTH_SCOPES.map(encodeURIComponent).join('%20')}` +
      `&state=${nonce}`;
    return { url };
  });

  app.get('/api/oauth/callback', async (req, reply) => {
    const { code, state } = req.query || {};
    if (!code) return reply.code(400).send({ error: 'Falta el parámetro code' });

    // Con state válido → instalación iniciada desde el panel, vinculada a una cuenta.
    // Sin state → instalación directa desde el portal/marketplace de GHL (GHL no
    // envía state en ese flujo): se acepta y se crea/reutiliza la cuenta por locationId.
    let boundAccountId = '';
    if (state) {
      const stateKey = `oauthstate:${state}`;
      boundAccountId = (await redis.get(stateKey)) || '';
      await redis.del(stateKey);
    } else {
      await logEvent('oauth_instalacion_directa', { nota: 'instalación sin state (lanzada desde GHL, no desde el panel)' });
    }

    try {
      const tok = await exchangeCode(code);
      const locationId = await saveTokens(tok);

      // ¿la instalación se lanzó desde una cuenta concreta? → vincularla
      if (boundAccountId) {
        const account = await one(`SELECT * FROM accounts WHERE id = $1`, [Number(boundAccountId)]);
        if (account) {
          const clash = await one(`SELECT id, name FROM accounts WHERE location_id = $1 AND id <> $2`, [locationId, account.id]);
          if (clash) {
            await logEvent('oauth_location_en_uso', { locationId, cuenta: account.id, ocupada_por: clash.id });
            return reply.redirect(`/cuentas/${account.id}?error=${encodeURIComponent(`Esa subcuenta ya está conectada a la cuenta "${clash.name}"`)}`);
          }
          await q(`UPDATE accounts SET location_id = $1, mode = 'oauth' WHERE id = $2`, [locationId, account.id]);
          await logEvent('oauth_conectado', { locationId, account: account.id });
          return reply.redirect(`/cuentas/${account.id}?conectada=1`);
        }
      }

      // instalación suelta → reutilizar o crear cuenta para esa subcuenta
      let account = await one(`SELECT * FROM accounts WHERE location_id = $1`, [locationId]);
      if (!account) {
        const name = (await getLocationName({ mode: 'oauth', location_id: locationId }, locationId)) || `Subcuenta ${locationId.slice(0, 6)}`;
        account = await one(
          `INSERT INTO accounts (name, location_id, mode, webhook_token) VALUES ($1, $2, 'oauth', $3) RETURNING *`,
          [name, locationId, crypto.randomBytes(16).toString('hex')]
        );
      }
      await logEvent('oauth_conectado', { locationId, account: account.id });
      return reply.redirect(`/cuentas/${account.id}?conectada=1`);
    } catch (err) {
      await logEvent('oauth_error', { error: err.message, body: err.body || null });
      return reply.code(500).send({ error: `Error conectando la subcuenta: ${err.message}` });
    }
  });
}
