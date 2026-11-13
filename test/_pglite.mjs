// Postgres REAL en memoria (PGlite, WASM) con las migraciones de verdad, para probar sin servidor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');

export async function baseDePruebas({ hasta = null, antesDe = null } = {}) {
  const db = new PGlite();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (antesDe && f >= antesDe) break;
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (hasta && f.startsWith(hasta)) break;
  }
  // adaptador con la forma de pg.Pool que usan services/club.js y services/tope.js
  let cola = Promise.resolve();
  const pool = {
    query: (text, params) => db.query(text, params),
    connect: async () => {
      // PGlite es una sola conexión: las transacciones se serializan
      let liberar;
      const turno = new Promise((r) => { liberar = r; });
      const previo = cola;
      cola = previo.then(() => turno);
      await previo;
      return { query: (text, params) => db.query(text, params), release: () => liberar() };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
  return pool;
}
