import { one, q } from '../db.js';
import { verifyPassword, hashPassword, createSession, destroySession, setSessionCookie } from '../lib/session.js';

export default async function authRoutes(app) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const user = await one(`SELECT * FROM users WHERE username = $1`, [String(username || '').trim()]);
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = await createSession({
      userId: user.id,
      role: user.role || 'admin',
      accountId: user.account_id || null,
      portal: false,
    });
    setSessionCookie(reply, token);
    return { ok: true, username: user.username, role: user.role || 'admin' };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req.cookies?.hermes_session);
    reply.clearCookie('hermes_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const base = {
      role: req.auth?.role || 'user',
      portal: Boolean(req.auth?.portal),
      account_id: req.auth?.accountId || null,
      account_name: null,
    };
    if (base.account_id) {
      const acc = await one(`SELECT name FROM accounts WHERE id = $1`, [base.account_id]);
      base.account_name = acc?.name || null;
    }
    if (req.auth?.portal) {
      const pu = req.auth.portalUserId ? await one(`SELECT name, email FROM portal_users WHERE id = $1`, [req.auth.portalUserId]) : null;
      return { ...base, username: pu?.name || pu?.email || 'Usuario GHL' };
    }
    const user = await one(`SELECT id, username, role, account_id, can_manage_agents, created_at FROM users WHERE id = $1`, [req.userId]);
    return { ...base, ...(user || {}), account_id: base.account_id, role: base.role, can_manage_agents: user?.can_manage_agents !== false };
  });

  app.put('/api/auth/me', async (req, reply) => {
    if (req.auth?.portal) return reply.code(403).send({ error: 'El acceso por enlace de GHL no gestiona contraseñas' });
    const { current_password, username, password } = req.body || {};
    const user = await one(`SELECT * FROM users WHERE id = $1`, [req.userId]);
    if (!user || !verifyPassword(String(current_password || ''), user.password_hash)) {
      return reply.code(400).send({ error: 'La contraseña actual no es correcta' });
    }
    const newUsername = String(username || user.username).trim();
    const newHash = password ? hashPassword(String(password)) : user.password_hash;
    await q(`UPDATE users SET username = $1, password_hash = $2 WHERE id = $3`, [newUsername, newHash, user.id]);
    return { ok: true };
  });
}
