import { q, one } from '../db.js';
import { accessibleAccountIds, requireAdmin } from '../lib/session.js';

// 🐞 Reportes de errores: cualquier usuario reporta (texto + hasta 5 capturas); ve los SUYOS
// (los de su conexión). El admin los ve todos (fecha, usuario, subcuenta, tipo), responde,
// los marca resueltos y puede VACIAR todas las capturas para liberar espacio en disco.
const TIPOS = new Set(['sistema', 'setter', 'facturacion', 'otro']);
const MAX_IMGS = 5;
const MAX_IMG_BYTES = 2_500_000; // por captura (el cliente ya comprime)

export default async function bugRoutes(app) {
  app.post('/api/bugs', async (req, reply) => {
    const b = req.body || {};
    const descripcion = String(b.descripcion || '').trim().slice(0, 4000);
    if (!descripcion) return reply.code(400).send({ error: 'Cuéntanos qué pasó (la descripción está vacía).' });
    const tipo = TIPOS.has(b.tipo) ? b.tipo : 'otro';

    // capturas: acepta `imagenes` (lista) y también la vieja `imagen` suelta (compat)
    const crudas = [
      ...(Array.isArray(b.imagenes) ? b.imagenes : []),
      ...(typeof b.imagen === 'string' && b.imagen ? [b.imagen] : []),
    ];
    const imagenes = [];
    for (const img of crudas) {
      if (typeof img !== 'string' || !img.startsWith('data:image/')) continue;
      if (img.length > MAX_IMG_BYTES) return reply.code(400).send({ error: 'Una de las capturas es demasiado grande. Adjunta imágenes más pequeñas.' });
      imagenes.push(img);
      if (imagenes.length >= MAX_IMGS) break;
    }

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
      `INSERT INTO bug_reports (account_id, reporter, tipo, descripcion, imagen, imagenes) VALUES ($1,$2,$3,$4,'',$5::jsonb)
       RETURNING id, account_id, reporter, tipo, descripcion, status, created_at`,
      [accountId, reporter, tipo, descripcion, JSON.stringify(imagenes)]
    );
  });

  app.get('/api/bugs', async (req) => {
    const ids = await accessibleAccountIds(req); // null = admin (todos)
    const rows = await q(
      `SELECT b.id, b.account_id, b.reporter, b.tipo, b.descripcion, b.status, b.created_at,
              b.respuesta, b.respondida_at,
              (jsonb_array_length(b.imagenes) + CASE WHEN b.imagen <> '' THEN 1 ELSE 0 END) AS n_imagenes,
              COALESCE(NULLIF(a.alias, ''), a.name) AS account_name
         FROM bug_reports b LEFT JOIN accounts a ON a.id = b.account_id
        ${ids ? 'WHERE b.account_id = ANY($1::int[])' : ''}
        ORDER BY b.id DESC LIMIT 200`,
      ids ? [ids] : []
    );
    return { bugs: rows };
  });

  // 🧹 espacio que ocupan las capturas (solo admin) + vaciado total para liberar disco
  app.get('/api/bugs/almacen', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const row = await one(
      `SELECT COALESCE(SUM(length(imagen)), 0) + COALESCE(SUM(length(imagenes::text)), 0) AS bytes,
              COUNT(*) FILTER (WHERE imagen <> '' OR jsonb_array_length(imagenes) > 0) AS reportes_con_fotos
         FROM bug_reports`
    );
    return { bytes: Number(row?.bytes || 0), reportes_con_fotos: Number(row?.reportes_con_fotos || 0) };
  });

  app.delete('/api/bugs/imagenes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const antes = await one(`SELECT COALESCE(SUM(length(imagen)), 0) + COALESCE(SUM(length(imagenes::text)), 0) AS bytes FROM bug_reports`);
    await q(`UPDATE bug_reports SET imagen = '', imagenes = '[]'::jsonb WHERE imagen <> '' OR jsonb_array_length(imagenes) > 0`);
    // sin VACUUM, Postgres deja tuplas muertas y el fichero NO encoge: el disco no se libera.
    // La tabla es pequeña (cientos de filas): el lock de VACUUM FULL dura milisegundos.
    try { await q(`VACUUM FULL bug_reports`); } catch { /* sin permisos: el espacio queda reutilizable igualmente */ }
    return { ok: true, liberado_bytes: Number(antes?.bytes || 0) };
  });

  // un id no numérico ('abc') daría un 500 de Postgres: se valida antes
  const numId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };

  // fila accesible → sus capturas combinadas (nuevas + la vieja suelta si la hubiera)
  const loadImgs = async (req, id) => {
    const ids = await accessibleAccountIds(req);
    const row = await one(`SELECT account_id, imagen, imagenes FROM bug_reports WHERE id = $1`, [id]);
    if (!row || (ids && !ids.includes(row.account_id))) return null;
    const list = Array.isArray(row.imagenes) ? row.imagenes.filter((x) => typeof x === 'string') : [];
    if (row.imagen) list.push(row.imagen);
    return list;
  };

  // todas las capturas de un reporte (pueden pesar: se sirven aparte de la lista)
  app.get('/api/bugs/:id/imagenes', async (req, reply) => {
    const id = numId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'No encontrado' });
    const list = await loadImgs(req, id);
    if (list === null) return reply.code(404).send({ error: 'No encontrado' });
    return { imagenes: list };
  });

  // compat con la ruta vieja (una sola imagen): devuelve la primera
  app.get('/api/bugs/:id/imagen', async (req, reply) => {
    const id = numId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'No encontrado' });
    const list = await loadImgs(req, id);
    if (list === null) return reply.code(404).send({ error: 'No encontrado' });
    return { imagen: list[0] || '' };
  });

  app.put('/api/bugs/:id', async (req, reply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'Solo para administradores' });
    const id = numId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'No encontrado' });
    const b = req.body || {};
    // SET dinámico: cambiar el estado no pisa la respuesta, y responder no pisa el estado.
    const sets = [];
    const vals = [id];
    if ('status' in b) { vals.push(b.status === 'resuelto' ? 'resuelto' : 'abierto'); sets.push(`status = $${vals.length}`); }
    if ('respuesta' in b) {
      vals.push(String(b.respuesta || '').trim().slice(0, 4000));
      sets.push(`respuesta = $${vals.length}`);
      sets.push(`respondida_at = CASE WHEN $${vals.length} = '' THEN NULL ELSE now() END`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nada que actualizar' });
    const row = await one(`UPDATE bug_reports SET ${sets.join(', ')} WHERE id = $1 RETURNING id, status, respuesta, respondida_at`, vals);
    if (!row) return reply.code(404).send({ error: 'No encontrado' });
    return row;
  });
}
