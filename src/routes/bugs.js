import { q, one } from '../db.js';
import { accessibleAccountIds } from '../lib/session.js';

// 🐞 Reportes de errores: cualquier usuario reporta (texto + captura opcional); ve los SUYOS
// (los de su conexión). El admin los ve todos (fecha, usuario, subcuenta, tipo) y los marca resueltos.
const TIPOS = new Set(['sistema', 'setter', 'facturacion', 'otro']);

export default async function bugRoutes(app) {
  app.post('/api/bugs', async (req, reply) => {
    const b = req.body || {};
    const descripcion = String(b.descripcion || '').trim().slice(0, 4000);
    if (!descripcion) return reply.code(400).send({ error: 'Cuéntanos qué pasó (la descripción está vacía).' });
    const tipo = TIPOS.has(b.tipo) ? b.tipo : 'otro';
    // captura opcional: solo data URL de imagen, con tope (el cliente ya la comprime)
    let imagen = typeof b.imagen === 'string' && b.imagen.startsWith('data:image/') ? b.imagen : '';
    if (imagen.length > 2_500_000) return reply.code(400).send({ error: 'La captura es demasiado grande. Adjunta una imagen más pequeña.' });

    // quién reporta: nombre/email del usuario si lo tenemos; si no, su rol
    let reporter = req.auth?.role === 'admin' ? 'admin' : 'usuario';
    try {
      const u = req.userId ? await one(`SELECT email, name FROM users WHERE id = $1`, [req.userId]) : null;
      if (u) reporter = u.name || u.email || reporter;
    } catch { /* la tabla puede no tener esas columnas en instalaciones viejas */ }

    const accountId = req.auth?.role === 'admin'
      ? (Number(b.account_id) || null)
      : (req.auth?.accountId || null);

    return one(
      `INSERT INTO bug_reports (account_id, reporter, tipo, descripcion, imagen) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, account_id, reporter, tipo, descripcion, status, created_at`,
      [accountId, reporter, tipo, descripcion, imagen]
    );
  });

  app.get('/api/bugs', async (req) => {
    const ids = await accessibleAccountIds(req); // null = admin (todos)
    const rows = await q(
      `SELECT b.id, b.account_id, b.reporter, b.tipo, b.descripcion, b.status, b.created_at,
              (b.imagen <> '') AS tiene_imagen,
              COALESCE(NULLIF(a.alias, ''), a.name) AS account_name
         FROM bug_reports b LEFT JOIN accounts a ON a.id = b.account_id
        ${ids ? 'WHERE b.account_id = ANY($1::int[])' : ''}
        ORDER BY b.id DESC LIMIT 200`,
      ids ? [ids] : []
    );
    return { bugs: rows };
  });

  // un id no numérico ('abc') daría un 500 de Postgres: se valida antes
  const numId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };

  // la captura se sirve aparte (puede pesar): solo de reportes accesibles
  app.get('/api/bugs/:id/imagen', async (req, reply) => {
    const id = numId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'No encontrado' });
    const ids = await accessibleAccountIds(req);
    const row = await one(`SELECT account_id, imagen FROM bug_reports WHERE id = $1`, [id]);
    if (!row || (ids && !ids.includes(row.account_id))) return reply.code(404).send({ error: 'No encontrado' });
    return { imagen: row.imagen || '' };
  });

  app.put('/api/bugs/:id', async (req, reply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'Solo para administradores' });
    const id = numId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'No encontrado' });
    const status = req.body?.status === 'resuelto' ? 'resuelto' : 'abierto';
    const row = await one(`UPDATE bug_reports SET status = $2 WHERE id = $1 RETURNING id, status`, [id, status]);
    if (!row) return reply.code(404).send({ error: 'No encontrado' });
    return row;
  });
}
