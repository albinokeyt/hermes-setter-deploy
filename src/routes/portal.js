import crypto from 'node:crypto';
import { one, q } from '../db.js';
import { redis } from '../lib/redis.js';
import { createSession, setSessionCookie } from '../lib/session.js';

// La cuenta se identifica por SU clave de portal (única por cuenta), no por el
// location_id (que el usuario controla). Así, poseer el enlace de una cuenta no
// autoriza a otra. El location_id solo se usa como verificación adicional.
async function accountByPortalKey(key) {
  if (!key) return null;
  return one(`SELECT * FROM accounts WHERE portal_key = $1`, [String(key)]);
}

async function upsertPortalUser(accountId, name, email) {
  return one(
    `INSERT INTO portal_users (account_id, email, name, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account_id, email) DO UPDATE SET
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE portal_users.name END,
       last_seen_at = now()
     RETURNING *`,
    [accountId, String(email || '').trim().toLowerCase(), String(name || '').trim()]
  );
}

async function startPortalSession(reply, account, name, email) {
  const pu = await upsertPortalUser(account.id, name, email);
  const token = await createSession({ portal: true, role: 'user', accountId: account.id, portalUserId: pu.id });
  setSessionCookie(reply, token, { portal: true });
}

export default async function portalRoutes(app) {
  // Entrada desde el Custom Menu Link de GHL:
  // https://TU-APP/ghl-portal?key=CLAVE_DE_LA_CUENTA&location_id={{location.id}}&email={{user.email}}&name={{user.name}}
  app.get('/ghl-portal', async (req, reply) => {
    const { key, location_id, email, name } = req.query || {};
    const account = await accountByPortalKey(key);
    if (!account) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Enlace de portal no válido. Pide al administrador el enlace de tu cuenta.</h3>');
    }
    // Defensa extra: si el enlace trae location_id, debe coincidir con el de la cuenta.
    if (location_id && account.location_id && String(location_id) !== account.location_id) {
      return reply.code(403).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif">Este enlace no corresponde a tu subcuenta.</h3>');
    }
    // Si GHL nos pasa el email ({{user.email}}), entra directo.
    if (email && String(email).includes('@')) {
      await startPortalSession(reply, account, name, email);
      return reply.redirect('/');
    }
    // Primera vez sin email: token temporal en cookie (NO reexponemos la clave en la URL).
    const regToken = crypto.randomBytes(24).toString('hex');
    await redis.setex(`portalreg:${regToken}`, 900, String(account.id));
    reply.setCookie('hermes_portal_reg', regToken, { path: '/', httpOnly: true, sameSite: 'none', secure: true, maxAge: 900 });
    return reply.redirect('/registro-portal');
  });

  app.post('/api/portal/register', async (req, reply) => {
    const regToken = req.cookies?.hermes_portal_reg;
    const accountId = regToken ? await redis.get(`portalreg:${regToken}`) : null;
    if (!accountId) return reply.code(403).send({ error: 'Registro caducado. Vuelve a abrir el enlace desde GHL.' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [Number(accountId)]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const cleanName = String(req.body?.name || '').trim();
    const cleanEmail = String(req.body?.email || '').trim();
    if (!cleanName || !cleanEmail.includes('@')) return reply.code(400).send({ error: 'Nombre y correo válidos son obligatorios' });
    await redis.del(`portalreg:${regToken}`);
    reply.clearCookie('hermes_portal_reg', { path: '/' });
    await startPortalSession(reply, account, cleanName, cleanEmail);
    return { ok: true };
  });
}
