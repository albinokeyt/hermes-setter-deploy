// Rutas de la API que se saltan el login (authHook de lib/session.js).
//
// · EXACTAS: se comparan con la ruta SIN la query (?…), carácter a carácter. Las del Club van aquí: con un prefijo,
//   cualquier ruta futura que empezase igual (/api/club/estadoX, /api/club/devolucion/lo-que-sea…) quedaría abierta
//   sin sesión. Una variante (barra final, mayúsculas, %-codificada) NO es exacta → pide sesión (falla cerrado).
// · Por PREFIJO: las de siempre (webhooks con su token o firma, OAuth, SSO…).
// Sin dependencias (ni Redis ni Postgres): se prueba sola (test/rutas-publicas.test.mjs).

export const RUTAS_PUBLICAS_EXACTAS = Object.freeze(['/api/club/estado', '/api/club/devolucion']);

export const PREFIJOS_PUBLICOS = Object.freeze([
  '/api/auth/login',
  '/api/webhooks/',
  '/api/oauth/callback',
  '/api/health',
  '/api/portal/register',
  '/api/portal/sso',
]);

export function rutaSinQuery(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return i === -1 ? s : s.slice(0, i);
}

// Destino en forma absoluta («POST http://host/api/… HTTP/1.1», válido en HTTP/1.1): Fastify lo enruta igual que
// «/api/…», pero el texto no empieza por /api/ y el login se lo saltaba. Se mira siempre la ruta (sin esquema ni host).
// (Detrás de Traefik no pasa: convierte el destino a «/api/…» antes de llegar aquí; esto es por si cambia el proxy.)
export function rutaDeUrl(url) {
  const s = String(url || '');
  if (s.startsWith('/')) return s;
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  return m ? s.slice(m[0].length) || '/' : s;
}

export function esRutaPublica(url) {
  const u = String(url || '');
  if (RUTAS_PUBLICAS_EXACTAS.includes(rutaSinQuery(u))) return true;
  return PREFIJOS_PUBLICOS.some((p) => u.startsWith(p));
}
