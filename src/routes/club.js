// 🏛️ Interruptor del CLUB DE SISTEMAS: POST /api/club/estado
//
// Lo llama un nodo «Webhook personalizado» de los workflows del Club en GoHighLevel (alta, baja, impago, pago
// recuperado). Protegido por una cabecera secreta: X-Club-Secret: <CLUB_WEBHOOK_SECRET> (también vale
// «Authorization: Bearer <secreto>»). Si la variable de entorno no está puesta (o es demasiado corta), responde 503 y
// no hace nada.
//
// Cuerpo JSON: { location_id?: string, email?: string, activo: boolean, motivo?: string }
//   · location_id → ai_enabled = activo en TODAS las conexiones nuevas de esa subcuenta (si no hay, queda pendiente: 202).
//   · solo email  → la ÚNICA conexión NUEVA cuyo RESPONSABLE (owner_email, certificado por el SSO de GHL) es ese correo.
//                   Ninguna → pendiente (202, se aplica cuando ese responsable entra por SSO); varias → ambiguo, no se
//                   toca nada (202). Los «correos autorizados» no cuentan (los edita el propio cliente).
//   · Las conexiones ANTERIORES al Club (creadas antes de la migración 059) nunca se tocan desde aquí («protegida»).
// Respuestas: 200 aplicado/sin_cambios · 202 pendiente/ambiguo/protegida · 400 cuerpo no válido · 401 secreto ·
// 429 (solo tras muchos intentos con secreto MALO; un secreto bueno pasa siempre) · 503 sin configurar.

import { aplicarEstadoClub, validarCuerpoClub, secretoValido } from '../services/club.js';

const LONGITUD_MINIMA = 24;
const FALLOS_POR_MINUTO = 20;

export default async function clubRoutes(app, opts = {}) {
  const pg = opts.pool; // undefined → el pool real (services/club.js)
  let redisCli = opts.redis || null;
  const getRedis = async () => {
    if (!redisCli) redisCli = (await import('../lib/redis.js')).redis;
    return redisCli;
  };
  const secretoEnv = () => String((opts.secreto !== undefined ? opts.secreto : process.env.CLUB_WEBHOOK_SECRET) || '').trim();

  // bodyLimit propio: la ruta es pública (el global de 20 MB es para el arquitecto de prompts)
  app.post('/api/club/estado', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const secreto = secretoEnv();
    if (secreto.length < LONGITUD_MINIMA) {
      return reply.code(503).send({ error: 'club_no_configurado', nota: 'Falta CLUB_WEBHOOK_SECRET en el servidor: no se ha hecho nada.' });
    }
    const ip = String(req.ip || '');
    const auth = String(req.headers.authorization || '');
    const recibido = String(req.headers['x-club-secret'] || '') || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
    if (!secretoValido(recibido, secreto)) {
      // Freno a quien prueba secretos. Solo frena peticiones SIN secreto válido: la IP sale de X-Forwarded-For (se
      // puede falsificar), así que nadie puede bloquear las llamadas buenas de GHL haciéndose pasar por su IP.
      const r = await getRedis().catch(() => null);
      const claveFallos = `club:fallos:${ip}`;
      if (r) {
        const n = Number(await r.incr(claveFallos).catch(() => 0)) || 0;
        if (n === 1) await r.expire(claveFallos, 60).catch(() => {});
        if (n > FALLOS_POR_MINUTO) return reply.code(429).send({ error: 'demasiados_intentos' });
      }
      return reply.code(401).send({ error: 'no_autorizado' });
    }
    const v = validarCuerpoClub(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    try {
      const res = await aplicarEstadoClub({ ...v.datos, ip }, pg);
      return reply.code(res.code).send(res.body);
    } catch (err) {
      req.log.error({ err: err.message }, '[club] error aplicando el estado');
      return reply.code(500).send({ error: 'error_interno' });
    }
  });
}
