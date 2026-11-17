// 📅 Fechas de día ('AAAA-MM-DD') que llegan de los paneles.

// Un día bien escrito Y que exista de verdad (nada de 2026-02-30): la misma regla que fechaValida del marketplace.
// Una fecha imposible no puede llegar a un `$1::date` de Postgres, que la rechaza con «date/time field value out of
// range» y tumbaría la consulta entera.
export function diaValido(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
