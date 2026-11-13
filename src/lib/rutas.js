// Rutas de la API que se saltan el login (authHook de lib/session.js). Se comparan SIEMPRE sin la query (?…).
//
// · EXACTAS: carácter a carácter. Las del Club van aquí: con un prefijo, cualquier ruta futura que empezase igual
//   (/api/club/estadoX, /api/club/devolucion/lo-que-sea…) quedaría abierta sin sesión. Una variante (barra final,
//   mayúsculas, %-codificada) NO es exacta → pide sesión (falla cerrado).
// · Con LÍMITE DE SEGMENTO: la ruta es IGUAL al prefijo o empieza por prefijo + «/». Antes bastaba con que el texto
//   empezase igual: /api/healthz, /api/auth/loginX o /api/portal/ssoX habrían quedado abiertas si alguien creaba esas
//   rutas. Hoy ninguna de estas tiene subrutas (son rutas sueltas: listado de todas las rutas registradas, fase C).
// · WEBHOOKS: todo lo que cuelga de /api/webhooks/ (cada webhook comprueba su token o la firma de GHL).
// Sin dependencias (ni Redis ni Postgres): se prueba sola (test/rutas-publicas.test.mjs).

export const RUTAS_PUBLICAS_EXACTAS = Object.freeze(['/api/club/estado', '/api/club/devolucion']);

export const PREFIJOS_PUBLICOS = Object.freeze([
  '/api/auth/login',
  '/api/oauth/callback',
  '/api/health',
  '/api/portal/register',
  '/api/portal/sso',
]);

export const PREFIJO_WEBHOOKS = '/api/webhooks/';

export function rutaSinQuery(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return i === -1 ? s : s.slice(0, i);
}

export function esRutaPublica(url) {
  const ruta = rutaSinQuery(url);
  if (RUTAS_PUBLICAS_EXACTAS.includes(ruta)) return true;
  if (ruta.startsWith(PREFIJO_WEBHOOKS)) return true;
  return PREFIJOS_PUBLICOS.some((p) => ruta === p || ruta.startsWith(`${p}/`));
}
