// Generador de ZIP mínimo, sin dependencias, método STORE (sin compresión): lo que se empaqueta
// aquí son capturas JPEG/PNG (ya comprimidas) y textos pequeños, así que comprimir no aporta y
// evitamos meter una librería solo para esto. Formato: local file headers + central directory +
// EOCD, nombres en UTF-8 (flag bit 11). Límite práctico: todo en memoria — el llamador debe acotar
// el tamaño total ANTES de llamar (ver /api/bugs/exportar).

// CRC-32 (polinomio estándar 0xEDB88320), tabla precalculada una vez.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fecha/hora en el formato DOS que exige el ZIP (resolución de 2 s, años desde 1980).
function dosDateTime(fecha) {
  const d = fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha : new Date();
  const anio = Math.max(1980, d.getFullYear());
  const date = ((anio - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

/**
 * Construye un ZIP en memoria. entries = [{ name: 'carpeta/fichero.txt', data: Buffer|string, mtime?: Date }].
 * Devuelve un Buffer listo para servir con content-type application/zip.
 */
export function zipStore(entries) {
  const locales = [];
  const centrales = [];
  let offset = 0;

  for (const e of entries) {
    const nombre = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const crc = crc32(data);
    const { date, time } = dosDateTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma local file header
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // flags: nombres UTF-8
    local.writeUInt16LE(0, 8); // método STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // comprimido = original (STORE)
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28); // sin extra field
    locales.push(local, nombre, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // firma central directory
    central.writeUInt16LE(20, 4); // versión creada por
    central.writeUInt16LE(20, 6); // versión necesaria
    central.writeUInt16LE(0x0800, 8); // flags UTF-8
    central.writeUInt16LE(0, 10); // STORE
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    // extra(30)=0, comment(32)=0, disco(34)=0, atributos internos(36)=0, externos(38)=0
    central.writeUInt32LE(offset, 42); // offset del local header
    centrales.push(Buffer.concat([central, nombre]));

    offset += local.length + nombre.length + data.length;
  }

  const dirCentral = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // firma EOCD
  eocd.writeUInt16LE(entries.length, 8); // entradas en este disco
  eocd.writeUInt16LE(entries.length, 10); // entradas totales
  eocd.writeUInt32LE(dirCentral.length, 12);
  eocd.writeUInt32LE(offset, 16); // offset del central directory
  return Buffer.concat([...locales, dirCentral, eocd]);
}
