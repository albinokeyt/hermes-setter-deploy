import { q, one } from '../db.js';
import { hashPassword, requireAdmin } from '../lib/session.js';

export default async function userRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/users', async () => {
    const panel = await q(`
      SELECT u.id, u.username, u.role, u.account_id, u.created_at, a.name AS account_name
      FROM users u LEFT JOIN accounts a ON a.id = u.account_id ORDER BY u.id`);
    const portal = await q(`
      SELECT p.id, p.name, p.email, p.account_id, p.last_seen_at, a.name AS account_name
      FROM portal_users p JOIN accounts a ON a.id = p.account_id
      ORDER BY p.last_seen_at DESC LIMIT 100`);
    return { panel, portal };
  });

  app.post('/api/users', async (req, reply) => {
    const { username, password, role = 'user', account_id = null } = req.body || {};
    const name = String(username || '').trim();
    if (!name || !password) return reply.code(400).send({ error: 'Usuario y contraseña son obligatorios' });
    if (!['admin', 'user'].includes(role)) return reply.code(400).send({ error: 'Rol inválido' });
    if (role === 'user' && !account_id) return reply.code(400).send({ error: 'Un usuario normal debe estar asignado a una cuenta' });
    const exists = await one(`SELECT id FROM users WHERE username = $1`, [name]);
    if (exists) return reply.code(400).send({ error: 'Ese nombre de usuario ya existe' });
    const row = await one(
      `INSERT INTO users (username, password_hash, role, account_id) VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, account_id, created_at`,
      [name, hashPassword(String(password)), role, role === 'admin' ? null : account_id || null]
    );
    return row;
  });

  app.put('/api/users/:id', async (req, reply) => {
    const target = await one(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
    if (!target) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const role = ['admin', 'user'].includes(b.role) ? b.role : target.role;
    if (target.id === req.userId && role !== 'admin') {
      return reply.code(400).send({ error: 'No puedes quitarte a ti mismo el rol de admin' });
    }
    const nextAccountId = role === 'admin' ? null : (b.account_id !== undefined ? b.account_id || null : target.account_id);
    if (role === 'user' && !nextAccountId) return reply.code(400).send({ error: 'Un usuario normal debe estar asignado a una cuenta' });
    const row = await one(
      `UPDATE users SET username = $1, role = $2, account_id = $3, password_hash = $4
       WHERE id = $5 RETURNING id, username, role, account_id, created_at`,
      [
        String(b.username || target.username).trim(),
        role,
        nextAccountId,
        b.password ? hashPassword(String(b.password)) : target.password_hash,
        target.id,
      ]
    );
    return row;
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (Number(req.params.id) === req.userId) return reply.code(400).send({ error: 'No puedes borrarte a ti mismo' });
    await q(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.delete('/api/users/portal/:id', async (req) => {
    await q(`DELETE FROM portal_users WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });
}
