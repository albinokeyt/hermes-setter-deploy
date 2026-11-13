// 🏛️ Rutas públicas del CLUB DE SISTEMAS (las llaman nodos «Webhook personalizado» de los workflows de GoHighLevel):
//
//  · POST /api/club/estado      → interruptor del Club (alta, baja, impago, pago recuperado). Ver services/club.js.
//  · POST /api/club/devolucion  → evaluador de devoluciones (aprobada / denegada / revision). Ver services/devoluciones.js.
//
// Protegidas por una cabecera secreta: X-Club-Secret: <CLUB_WEBHOOK_SECRET> (también vale «Authorization: Bearer
// <secreto>»). Si la variable de entorno no está puesta (o tiene menos de 24 caracteres), responden 503 y no hacen nada.
// Son rutas EXACTAS en lib/rutas.js (cualquier otra /api/club/… pide sesión).
//
// FRENO a quien prueba secretos: solo cuentan las peticiones con secreto MALO (uno bueno pasa siempre, así nadie puede
// bloquear las llamadas de GHL haciéndose pasar por su IP). Dos contadores por minuto:
//  · por IP REAL (lib/ipReal.js: el último tramo de X-Forwarded-For, el que añade Traefik; el resto lo pone quien
//    llama), agrupando las IPv6 por /64;
//  · GLOBAL (todas las IPs juntas), por si alguien reparte los intentos entre muchas IPs.
// Superado cualquiera → 429. Con un secreto de 64 caracteres aleatorios adivinarlo es inviable: el freno corta el ruido.
//
// /api/club/estado — Cuerpo JSON: { location_id?: string, email?: string, activo: boolean, motivo?: string }
//   · location_id → ai_enabled = activo en TODAS las conexiones nuevas de esa subcuenta (si no hay, queda pendiente: 202).
//   · solo email  → la conexión NUEVA cuyo CORREO DEL CLUB CONFIRMADO (club_email, lo pone soporte al instalar; único)
//                   es ese. Ninguna → pendiente (202, se aplica cuando soporte confirme ese correo en una conexión), con
//                   «sin_confirmar»: las conexiones que lo tienen de responsable o de correo de la subcuenta, que NO se
//                   tocan (son solo una pista). El responsable, el correo de la subcuenta y los «correos autorizados» no
//                   enlazan (soporte puede ser el responsable; los otros dos los edita el cliente).
//   · Las conexiones ANTERIORES al Club (creadas antes de la migración 059) nunca se tocan desde aquí («protegida»).
//   · El correo pasa por la MISMA normalización que el correo del Club (services/club.js · analizarCorreo): con un
//     carácter invisible, de control, un espacio raro, una letra de otro alfabeto (ѕ cirílica…), puntos mal puestos o un
//     signo que un correo no admite → 400 «email no válido: …» (no podría casar con ningún club_email). Si además llega
//     un location_id válido, NO se rechaza: se aplica por la subcuenta (ese camino no usa el correo), el correo no se
//     guarda y la respuesta lleva «aviso». email, location_id y activo tienen que ser texto (o true/false): una lista no.
//   · Los 400 (con el secreto bueno) quedan en club_eventos con resultado «rechazado» y en el registro de eventos
//     («club_estado_rechazado»), con lo recibido escrito de forma visible («ana@x.com<U+200B>»).
//   Respuestas: 200 aplicado/sin_cambios · 202 pendiente/ambiguo/protegida · 400 cuerpo no válido · 401 secreto ·
//   429 freno · 503 sin configurar.
//
// /api/club/devolucion — Cuerpo JSON: { email, contact_id, producto: 'cuenta'|'brain'|'ambos' (o la opción del
//   desplegable: «Cuenta del Club», «Disruptive Brain», «Las dos»), motivo, fecha_cobro?, location_id? }. Responde 200
//   con la decisión por producto (también si ya estaba evaluada: idempotente) y avisa a GHL en segundo plano. 400 solo
//   si no llega ni contact_id ni email válidos; lo demás que falte o no se entienda → «revision».

import { aplicarEstadoClub, validarCuerpoClub, secretoValido, registrarRechazoClub } from '../services/club.js';
import { procesarDevolucion, validarCuerpoDevolucion } from '../services/devoluciones.js';
import { ipReal, claveFreno } from '../lib/ipReal.js';

const LONGITUD_MINIMA = 24;
const FALLOS_POR_MINUTO_IP = 20;
const FALLOS_POR_MINUTO_GLOBAL = 200;

export default async function clubRoutes(app, opts = {}) {
  const pg = opts.pool; // undefined → el pool real (services/*.js)
  const fetchFn = opts.fetch; // undefined → el fetch global (services/devoluciones.js)
  const limiteIp = Number(opts.limiteIp) || FALLOS_POR_MINUTO_IP;
  const limiteGlobal = Number(opts.limiteGlobal) || FALLOS_POR_MINUTO_GLOBAL;
  const reloj = typeof opts.reloj === 'function' ? opts.reloj : Date.now; // las pruebas fijan el minuto
  let redisCli = opts.redis || null;
  const getRedis = async () => {
    if (!redisCli) redisCli = (await import('../lib/redis.js')).redis;
    return redisCli;
  };
  const secretoEnv = () => String((opts.secreto !== undefined ? opts.secreto : process.env.CLUB_WEBHOOK_SECRET) || '').trim();

  // Cuenta un fallo en una ventana de 1 minuto. El nombre de la clave lleva el minuto: si se perdiese el EXPIRE (caída
  // justo entre las dos órdenes) la clave sobraría, pero nunca bloquearía minutos futuros.
  const contar = async (r, base) => {
    const clave = `${base}:${Math.floor(reloj() / 60_000)}`;
    const n = Number(await r.incr(clave).catch(() => 0)) || 0;
    if (n === 1) await r.expire(clave, 120).catch(() => {});
    return n;
  };

  /** Comprueba el secreto. Devuelve el secreto si vale; si no, responde (503/401/429) y devuelve null. */
  async function autorizar(req, reply) {
    const secreto = secretoEnv();
    if (secreto.length < LONGITUD_MINIMA) {
      reply.code(503).send({ error: 'club_no_configurado', nota: 'Falta CLUB_WEBHOOK_SECRET en el servidor: no se ha hecho nada.' });
      return null;
    }
    const auth = String(req.headers.authorization || '');
    const recibido = String(req.headers['x-club-secret'] || '') || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
    if (secretoValido(recibido, secreto)) return secreto;
    const r = await getRedis().catch(() => null);
    if (r) {
      const ip = ipReal(req);
      const [nIp, nGlobal] = await Promise.all([
        contar(r, `club:fallos:ip:${claveFreno(ip)}`),
        contar(r, 'club:fallos:global'),
      ]);
      if (nGlobal === limiteGlobal + 1) req.log.warn({ ip }, '[club] freno GLOBAL de secretos fallidos activado (este minuto)');
      if (nIp > limiteIp || nGlobal > limiteGlobal) {
        reply.code(429).send({ error: 'demasiados_intentos' });
        return null;
      }
    }
    reply.code(401).send({ error: 'no_autorizado' });
    return null;
  }

  // bodyLimit propio: las rutas son públicas (el global de 20 MB es para el arquitecto de prompts)
  app.post('/api/club/estado', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    if (!(await autorizar(req, reply))) return reply;
    const v = validarCuerpoClub(req.body);
    if (!v.ok) {
      // repaso C3: el 400 ya no se ve solo en GHL (club_eventos «rechazado» + registro de eventos). Nunca lanza.
      await registrarRechazoClub({ body: req.body, error: v.error, ip: ipReal(req) }, pg);
      return reply.code(400).send({ error: v.error });
    }
    try {
      const res = await aplicarEstadoClub({ ...v.datos, ip: ipReal(req) }, pg);
      return reply.code(res.code).send(res.body);
    } catch (err) {
      req.log.error({ err: err.message }, '[club] error aplicando el estado');
      return reply.code(500).send({ error: 'error_interno' });
    }
  });

  app.post('/api/club/devolucion', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const secreto = await autorizar(req, reply);
    if (!secreto) return reply;
    const v = validarCuerpoDevolucion(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    try {
      const res = await procesarDevolucion(v.datos, { pg, fetch: fetchFn, secreto, ip: ipReal(req) });
      // el aviso a GHL va en segundo plano (GHL no espera); en las pruebas se puede esperar
      if (opts.esperarEnvios) await res.envios;
      return reply.code(res.code).send(res.body);
    } catch (err) {
      req.log.error({ err: err.message }, '[club] error evaluando una devolución');
      return reply.code(500).send({ error: 'error_interno' });
    }
  });
}
