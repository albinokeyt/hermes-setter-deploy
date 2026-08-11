import { q, one } from '../db.js';
import { accessibleAccountIds, requireAdmin } from '../lib/session.js';
import { zipStore } from '../lib/zip.js';

// 🐞 Reportes de errores: cualquier usuario reporta (texto + hasta 5 capturas); ve los SUYOS
// (los de su conexión). El admin los ve todos (fecha, usuario, subcuenta, tipo), responde,
// los marca resueltos y puede VACIAR todas las capturas para liberar espacio en disco.
const TIPOS = new Set(['sistema', 'setter', 'facturacion', 'otro']);
const ESTADOS = new Set(['abierto', 'en_curso', 'resuelto']);
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
      `SELECT b.id, b.account_id, b.reporter, b.tipo, b.tipo_original, b.descripcion, b.status, b.created_at,
              b.respuesta, b.respondida_at, b.resuelto_at,
              (jsonb_array_length(b.imagenes) + CASE WHEN b.imagen <> '' THEN 1 ELSE 0 END) AS n_imagenes,
              COALESCE(NULLIF(a.alias, ''), a.name) AS account_name
         FROM bug_reports b LEFT JOIN accounts a ON a.id = b.account_id
        ${ids ? 'WHERE b.account_id = ANY($1::int[])' : ''}
        ORDER BY b.id DESC LIMIT 200`,
      ids ? [ids] : []
    );
    return { bugs: rows };
  });

  // 📈 gráfico del admin: incidencias (creadas) y resoluciones por día — o por HORAS si el rango
  // es un solo día. Las fechas llegan como YYYY-MM-DD en la zona horaria del panel (param tz).
  app.get('/api/bugs/stats', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const from = String(req.query?.from || '');
    const to = String(req.query?.to || '');
    if (!okDate(from) || !okDate(to) || from > to) return reply.code(400).send({ error: 'Rango de fechas inválido' });
    const tz = /^[A-Za-z0-9_/+-]{1,50}$/.test(String(req.query?.tz || '')) ? String(req.query.tz) : 'UTC';
    const porHoras = from === to;
    const unit = porHoras ? 'hour' : 'day';
    const fmt = porHoras ? 'HH24:00' : 'YYYY-MM-DD';
    // filtro opcional por conexion: numero = esa cuenta; 'sin' = reportes sin conexion (del admin)
    const accRaw = String(req.query?.account_id || '');
    const accSql = accRaw === 'sin' ? 'AND account_id IS NULL' : /^\d+$/.test(accRaw) ? 'AND account_id = $6' : '';
    const params = [unit, tz, fmt, from, to, ...(accSql.includes('$6') ? [Number(accRaw)] : [])];
    const bucketsDe = (col) => q(
      `SELECT to_char(date_trunc($1, ${col} AT TIME ZONE $2), $3) AS bucket, COUNT(*)::int AS n
         FROM bug_reports
        WHERE ${col} IS NOT NULL
          AND (${col} AT TIME ZONE $2) >= $4::timestamp
          AND (${col} AT TIME ZONE $2) < (($5::date + 1)::timestamp)
          ${accSql}
        GROUP BY bucket`,
      params
    );
    try {
      const [incidencias, resoluciones] = await Promise.all([bucketsDe('created_at'), bucketsDe('resuelto_at')]);
      return { por_horas: porHoras, incidencias, resoluciones };
    } catch {
      // una tz con forma valida pero inexistente ('Foo/Bar') hace que Postgres lance: 400, no 500
      return reply.code(400).send({ error: 'Zona horaria no válida' });
    }
  });

  // ⬇️ Exportación completa (solo admin): un ZIP con TODOS los reportes — resumen.csv en la raíz
  // y una carpeta por reporte con su texto y sus capturas. Descarga por enlace directo (la sesión
  // va en cookie same-origin), así que responde el fichero, no JSON.
  const ETIQUETA_ESTADO = { abierto: 'abierto', en_curso: 'en curso', resuelto: 'resuelto' };
  const EXT_MIME = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
  const fechaTxt = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
  // campo CSV: comillas dobladas; los valores que empiezan por = + - @ se prefijan con apóstrofe
  // para que Excel no los ejecute como fórmula (inyección CSV: la descripción la escribe el usuario)
  const campoCsv = (v) => {
    let s = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (/[",;\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const MAX_ZIP_BYTES = 150_000_000; // todo el ZIP se arma en memoria: hay que acotarlo

  app.get('/api/bugs/exportar', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    // el tamaño se comprueba ANTES de cargar las capturas en memoria
    const { bytes } = (await one(
      `SELECT COALESCE(SUM(length(imagen)), 0) + COALESCE(SUM(length(imagenes::text)), 0) AS bytes FROM bug_reports`
    )) || { bytes: 0 };
    if (Number(bytes) > MAX_ZIP_BYTES) {
      return reply.code(413).send({
        error: `Las capturas ocupan ${(Number(bytes) / 1e6).toFixed(0)} MB y el ZIP se arma en memoria. Libera espacio con 🧹 (los textos se conservan) y vuelve a exportar.`,
      });
    }

    const rows = await q(
      `SELECT b.*, COALESCE(NULLIF(a.alias, ''), a.name) AS account_name
         FROM bug_reports b LEFT JOIN accounts a ON a.id = b.account_id
        ORDER BY b.id`
    );

    const entries = [];
    const lineasCsv = [['id', 'fecha', 'conexion', 'reportado_por', 'tipo', 'tipo_original', 'estado', 'capturas', 'respondida', 'resuelto', 'descripcion', 'respuesta'].join(';')];
    for (const b of rows) {
      const imgs = [
        ...(Array.isArray(b.imagenes) ? b.imagenes.filter((x) => typeof x === 'string') : []),
        ...(b.imagen ? [b.imagen] : []),
      ];
      const carpeta = `reporte-${String(b.id).padStart(4, '0')}`;
      const creado = b.created_at ? new Date(b.created_at) : new Date();

      const texto = [
        `Reporte #${b.id}`,
        `Fecha: ${fechaTxt(b.created_at)}`,
        `Conexión: ${b.account_name || '—'}`,
        `Reportado por: ${b.reporter || '—'}`,
        `Tipo: ${b.tipo}${b.tipo_original ? ` (llegó como: ${b.tipo_original})` : ''}`,
        `Estado: ${ETIQUETA_ESTADO[b.status] || b.status}${b.resuelto_at ? ` (resuelto el ${fechaTxt(b.resuelto_at)})` : ''}`,
        `Capturas: ${imgs.length}`,
        '',
        '--- Descripción ---',
        b.descripcion || '',
        ...(b.respuesta ? ['', `--- Respuesta del equipo (${fechaTxt(b.respondida_at)}) ---`, b.respuesta] : []),
        '',
      ].join('\r\n');
      entries.push({ name: `${carpeta}/reporte.txt`, data: texto, mtime: creado });

      imgs.forEach((dataUri, i) => {
        const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUri);
        if (!m) return;
        const ext = EXT_MIME[m[1].toLowerCase()] || 'bin';
        try {
          entries.push({ name: `${carpeta}/captura-${i + 1}.${ext}`, data: Buffer.from(m[2], 'base64'), mtime: creado });
        } catch { /* base64 corrupto: se salta esa captura, el texto va igual */ }
      });

      lineasCsv.push([
        campoCsv(b.id), campoCsv(fechaTxt(b.created_at)), campoCsv(b.account_name || ''), campoCsv(b.reporter || ''),
        campoCsv(b.tipo), campoCsv(b.tipo_original || ''), campoCsv(ETIQUETA_ESTADO[b.status] || b.status),
        campoCsv(imgs.length), campoCsv(fechaTxt(b.respondida_at)), campoCsv(fechaTxt(b.resuelto_at)),
        campoCsv(b.descripcion || ''), campoCsv(b.respuesta || ''),
      ].join(';'));
    }
    // BOM delante: sin él Excel abre el UTF-8 con los acentos rotos
    entries.unshift({ name: 'resumen.csv', data: '﻿' + lineasCsv.join('\r\n') + '\r\n', mtime: new Date() });

    const nombre = `reportes-errores-${new Date().toISOString().slice(0, 10)}.zip`;
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${nombre}"`)
      .header('cache-control', 'no-store')
      .send(zipStore(entries));
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
    if ('status' in b) {
      if (!ESTADOS.has(b.status)) return reply.code(400).send({ error: 'Estado no válido' });
      vals.push(b.status);
      sets.push(`status = $${vals.length}`);
      // resuelto_at alimenta el gráfico de resoluciones: se fija al resolver y se limpia al reabrir
      sets.push(`resuelto_at = CASE WHEN $${vals.length} = 'resuelto' THEN COALESCE(resuelto_at, now()) ELSE NULL END`);
    }
    // reclasificar: el admin corrige el tipo (p. ej. llegó como "sistema" y era "setter").
    // La PRIMERA vez se guarda el tipo original para que se vea que se cambió.
    if ('tipo' in b) {
      if (!TIPOS.has(b.tipo)) return reply.code(400).send({ error: 'Tipo de error no válido' });
      vals.push(b.tipo);
      sets.push(`tipo_original = CASE WHEN tipo_original = '' AND tipo <> $${vals.length} THEN tipo ELSE tipo_original END`);
      sets.push(`tipo = $${vals.length}`);
    }
    if ('respuesta' in b) {
      vals.push(String(b.respuesta || '').trim().slice(0, 4000));
      sets.push(`respuesta = $${vals.length}`);
      sets.push(`respondida_at = CASE WHEN $${vals.length} = '' THEN NULL ELSE now() END`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nada que actualizar' });
    const row = await one(`UPDATE bug_reports SET ${sets.join(', ')} WHERE id = $1 RETURNING id, status, tipo, tipo_original, respuesta, respondida_at, resuelto_at`, vals);
    if (!row) return reply.code(404).send({ error: 'No encontrado' });
    return row;
  });
}
