import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, OAUTH_SCOPES } from '../config.js';
import { exchangeCodeForLocation, saveTokens, getLocationName } from '../services/ghl.js';
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
    let selfserveKey = '';
    let knownLoc = '';
    if (state) {
      const stateKey = `oauthstate:${state}`;
      const val = (await redis.get(stateKey)) || '';
      await redis.del(stateKey);
      if (val.startsWith('selfserve:')) {
        const rest = val.slice('selfserve:'.length);
        const idx = rest.indexOf(':');
        if (idx >= 0) { selfserveKey = rest.slice(0, idx); knownLoc = rest.slice(idx + 1); }
        else selfserveKey = rest;
      } else {
        boundAccountId = val;
      }
    } else {
      await logEvent('oauth_instalacion_directa', { nota: 'instalación sin state (lanzada desde GHL, no desde el panel)' });
    }

    try {
      // Si la conexión ya tenía subcuenta (reconexión), sirve de pista para mintear el token.
      if (boundAccountId && !knownLoc) {
        const a = await one(`SELECT location_id FROM accounts WHERE id = $1`, [Number(boundAccountId)]);
        if (a?.location_id) knownLoc = a.location_id;
      }
      const tok = await exchangeCodeForLocation(code, knownLoc);
      const locationId = await saveTokens(tok);

      // Instalación desde el link de agencia → volver al portal para entrar como usuario.
      // No propagamos la agencyKey por la URL (acabaría en historial/Referer/logs); usamos
      // un token de un solo uso en Redis que autoriza la vuelta a /ghl-app.
      if (selfserveKey) {
        await logEvent('oauth_selfserve_conectado', { locationId });
        const entry = crypto.randomBytes(16).toString('hex');
        await redis.setex(`appentry:${entry}`, 180, locationId);
        return reply.redirect(`/ghl-app?entry=${entry}`);
      }

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
        await q(`INSERT INTO setters (account_id, name, is_default) VALUES ($1, 'Setter principal', true)`, [account.id]);
      }
      await logEvent('oauth_conectado', { locationId, account: account.id });
      return reply.redirect(`/cuentas/${account.id}?conectada=1`);
    } catch (err) {
      await logEvent('oauth_error', { error: err.message, body: err.body || null });
      const noLoc = /locationId/i.test(err.message);
      const detalle = noLoc
        ? 'GHL devolvió un token <b>de agencia</b>, no de una subcuenta. Instala la app <b>eligiendo una subcuenta concreta</b>, o mejor abre el <b>enlace del menú de agencia</b> desde dentro de la subcuenta (ese ya sabe qué subcuenta conectar).'
        : 'Hubo un problema al conectar con GoHighLevel. Inténtalo de nuevo o contacta con la agencia.';
      return reply.code(400).type('text/html; charset=utf-8').send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
         <div style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;color:#334155;text-align:center">
           <div style="font-size:40px">🔌</div>
           <h2 style="color:#0f172a;margin:.4em 0">No se pudo conectar la subcuenta</h2>
           <p style="line-height:1.6;color:#475569">${detalle}</p>
           <p style="font-size:12px;color:#94a3b8;margin-top:2em">Detalle técnico: ${String(err.message).replace(/[<>]/g, '')}</p>
         </div>`
      );
    }
  });
}
