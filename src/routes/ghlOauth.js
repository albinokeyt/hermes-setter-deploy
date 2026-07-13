import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { exchangeCode, saveTokens, getLocationName } from '../services/ghl.js';
import { logEvent } from '../services/pipeline.js';

export default async function ghlOauthRoutes(app) {
  // devuelve la URL de instalación (con state anti-CSRF vinculado a la cuenta que conecta)
  app.get('/api/ghl/oauth/url', async (req, reply) => {
    const creds = (await getSetting('ghl_app', {})) || {};
    if (!creds.client_id) return reply.code(400).send({ error: 'Configura primero el Client ID en Configuración' });

    const accountId = Number(req.query?.account_id);
    if (accountId) {
      const acc = await one(`SELECT id FROM accounts WHERE id = $1`, [accountId]);
      if (!acc) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    await redis.setex(`oauthstate:${nonce}`, 600, String(accountId || ''));

    const redirect = `${config.appBaseUrl}/api/ghl/oauth/callback`;
    const url =
      'https://marketplace.gohighlevel.com/oauth/chooselocation' +
      `?response_type=code&redirect_uri=${encodeURIComponent(redirect)}` +
      `&client_id=${encodeURIComponent(creds.client_id)}` +
      `&scope=${OAUTH_SCOPES.map(encodeURIComponent).join('%20')}` +
      `&state=${nonce}`;
    return { url };
  });

  app.get('/api/ghl/oauth/callback', async (req, reply) => {
    const { code, state } = req.query || {};
    if (!code) return reply.code(400).send({ error: 'Falta el parámetro code' });

    const stateKey = `oauthstate:${state || ''}`;
    const boundAccountId = await redis.get(stateKey);
    if (boundAccountId === null) return reply.code(403).send({ error: 'Instalación no iniciada desde el panel (state inválido o caducado). Vuelve a intentarlo desde Cuentas → Conexión GHL.' });
    await redis.del(stateKey);

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
