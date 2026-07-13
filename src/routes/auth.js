import { one, q } from '../db.js';
import { verifyPassword, hashPassword, createSession, destroySession } from '../lib/session.js';
import { config } from '../config.js';

export default async function authRoutes(app) {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const user = await one(`SELECT * FROM users WHERE username = $1`, [String(username || '').trim()]);
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = await createSession(user.id);
    reply.setCookie('hermes_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true, username: user.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req.cookies?.hermes_session);
    reply.clearCookie('hermes_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = await one(`SELECT id, username, created_at FROM users WHERE id = $1`, [req.userId]);
    return user || {};
  });

  app.put('/api/auth/me', async (req, reply) => {
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
