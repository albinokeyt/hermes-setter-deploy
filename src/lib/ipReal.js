// IP REAL de quien llama, detrás del proxy de EasyPanel (Traefik), para los frenos por IP.
//
// Traefik deja pasar tal cual las cabeceras X-Forwarded-For y X-Real-Ip que manda el cliente (comprobado desde fuera)
// y AÑADE AL FINAL de X-Forwarded-For la IP que ve en la conexión. Por eso la única IP fiable es el ÚLTIMO tramo de
// X-Forwarded-For. El primero (el que da req.ip con trustProxy:true) y X-Real-Ip los pone quien llama: con ellos un
// freno por IP se esquiva cambiando la cabecera en cada intento.
// Sin la cabecera (petición directa al contenedor o pruebas) → la IP de la conexión.
// Sin dependencias: se prueba sola (test/rutas-publicas.test.mjs).

import net from 'node:net';

function limpiarIp(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  // [2001:db8::1]:443 → 2001:db8::1 · 1.2.3.4:5678 → 1.2.3.4
  const corchetes = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (corchetes) s = corchetes[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  s = s.replace(/%.*$/, ''); // índice de zona IPv6 (fe80::1%eth0)
  const mapeada = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i); // IPv4 dentro de IPv6
  if (mapeada) s = mapeada[1];
  return net.isIP(s) ? s.toLowerCase() : '';
}

/** IP real de la petición (Fastify o http). Nunca lanza; 'desconocida' si no hay forma de saberla. */
export function ipReal(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  const valor = Array.isArray(xff) ? xff.join(',') : String(xff || '');
  const tramos = valor.split(',').map((t) => t.trim()).filter(Boolean);
  const deTraefik = tramos.length ? limpiarIp(tramos[tramos.length - 1]) : '';
  if (deTraefik) return deTraefik;
  const conexion = req?.socket?.remoteAddress || req?.raw?.socket?.remoteAddress || '';
  return limpiarIp(conexion) || 'desconocida';
}

// Expande una IPv6 (con «::») a sus 8 grupos.
function gruposIpv6(ip) {
  const [cabeza, cola] = ip.split('::');
  const a = cabeza ? cabeza.split(':') : [];
  if (cola === undefined) return a;
  const b = cola ? cola.split(':') : [];
  return [...a, ...Array(Math.max(8 - a.length - b.length, 0)).fill('0'), ...b];
}

/**
 * Clave para contar fallos por IP. IPv4 → la IP. IPv6 → su /64 (quien tiene una IPv6 suele disponer de todo un /64:
 * contarlas una a una permitiría rotar de dirección en cada intento).
 */
export function claveFreno(ip) {
  const s = String(ip || '');
  if (net.isIP(s) !== 6) return s || 'desconocida';
  return `${gruposIpv6(s).slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
