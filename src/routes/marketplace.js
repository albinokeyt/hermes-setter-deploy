import { q, one } from '../db.js';
import { requireAdmin } from '../lib/session.js';
import { chargeQueue } from '../queues.js';
import {
  mdConfig, mdActivo, accesoDe, hayFondos, cobrar, consultarCobro,
  listarTarifas, eventIdDe, diaNatural, barrerPendientes,
} from '../services/marketplace.js';

// 💳 Panel del administrador para la integración con Marketplace Disruptivo: ver cómo está cada
// subcuenta (uso incluido / por uso / sin saldo), auditar los cobros y disparar una prueba de
// punta a punta. TODO es solo-admin: aquí se ve el dinero de todos los clientes.
export default async function marketplaceRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  const numId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

  // Estado general: configuración efectiva (sin la clave), tarifas que ve nuestra clave y el
  // resumen de lo consumido hoy y este mes.
  app.get('/api/marketplace/estado', async () => {
    const cfg = mdConfig();
    const [hoy, mes, porEstado, cuentas] = await Promise.all([
      one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS usd
             FROM marketplace_charges WHERE dia = $1::date AND estado = 'cobrado'`, [diaNatural()]),
      one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS usd
             FROM marketplace_charges WHERE dia >= date_trunc('month', $1::date) AND estado = 'cobrado'`, [diaNatural()]),
      q(`SELECT estado, COUNT(*)::int AS n FROM marketplace_charges GROUP BY estado`),
      q(`SELECT a.id, a.name, a.location_id, a.md_acceso, a.md_acceso_at, a.md_sin_fondos_at,
                (SELECT COUNT(*)::int FROM marketplace_charges c
                  WHERE c.account_id = a.id AND c.dia = $1::date) AS conversaciones_hoy
           FROM accounts a ORDER BY a.name`, [diaNatural()]),
    ]);
    // las tarifas se piden en vivo: es la forma de comprobar que la clave está viva y con alcance
    const tarifas = mdActivo() ? await listarTarifas().catch(() => ({ status: 0, meters: [], error: 'sin respuesta' })) : null;
    return {
      config: cfg,
      dia_natural: diaNatural(),
      tarifas: tarifas ? { status: tarifas.status, meters: tarifas.meters, error: tarifas.error } : null,
      consumo: { hoy: hoy || { n: 0, usd: 0 }, mes: mes || { n: 0, usd: 0 } },
      por_estado: porEstado,
      cuentas,
    };
  });

  // Auditoría del outbox. Filtros: estado, account_id, dia.
  app.get('/api/marketplace/cobros', async (req) => {
    const where = [];
    const params = [];
    const estado = String(req.query?.estado || '').trim();
    if (estado) { params.push(estado); where.push(`c.estado = $${params.length}`); }
    const accId = numId(req.query?.account_id);
    if (accId) { params.push(accId); where.push(`c.account_id = $${params.length}`); }
    const dia = String(req.query?.dia || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dia)) { params.push(dia); where.push(`c.dia = $${params.length}::date`); }
    const limite = Math.min(Math.max(Number(req.query?.limite) || 100, 1), 500);

    const rows = await q(
      `SELECT c.*, a.name AS account_name
         FROM marketplace_charges c LEFT JOIN accounts a ON a.id = c.account_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.id DESC LIMIT ${limite}`,
      params
    );
    return { cobros: rows };
  });

  // Cómo acabó un cobro dudoso: se lo preguntamos al marketplace por su event_id.
  app.get('/api/marketplace/cobros/:eventId', async (req, reply) => {
    if (!mdActivo()) return reply.code(503).send({ error: 'La integración con el marketplace está apagada (falta MD_API_KEY).' });
    const eventId = String(req.params.eventId || '').slice(0, 190);
    const local = await one(`SELECT * FROM marketplace_charges WHERE event_id = $1`, [eventId]);
    const remoto = await consultarCobro(eventId).catch(() => null);
    return { local, remoto };
  });

  // Reencolar un cobro concreto (pendiente/sin_confirmar/error tras arreglar la configuración).
  // Siempre con el MISMO event_id: jamás se genera uno nuevo «para desatascar».
  app.post('/api/marketplace/cobros/:eventId/reintentar', async (req, reply) => {
    const eventId = String(req.params.eventId || '').slice(0, 190);
    const fila = await one(`SELECT * FROM marketplace_charges WHERE event_id = $1`, [eventId]);
    if (!fila) return reply.code(404).send({ error: 'No existe ese cobro' });
    if (['cobrado', 'incluido'].includes(fila.estado)) {
      return reply.code(409).send({ error: `Ese cobro ya está resuelto (${fila.estado}): reintentarlo podría duplicarlo.` });
    }
    // sin ':' en el jobId (BullMQ lo rechaza) y único: el lock de procesarCobro evita solapes
    await chargeQueue.add('charge', { eventId }, { jobId: `md-${eventId}-m${Date.now()}` });
    return { ok: true, event_id: eventId };
  });

  app.post('/api/marketplace/barrer', async () => barrerPendientes({ limite: 100 }));

  /**
   * 🧪 PRUEBA DE PUNTA A PUNTA (lo que pide el contrato para validar la integración).
   * body: { account_id, etiqueta?, cobrar?, forzar_error? }
   *  - Sin `cobrar` solo diagnostica (access + fondos + tarifas): no mueve un céntimo.
   *  - Con `cobrar: true` ejecuta el ciclo real con un event_id determinista de prueba:
   *      hermes-{locationId}-prueba{etiqueta}-{YYYY-MM-DD}
   *    Repetir la llamada el MISMO día debe devolver idempotente:true (esa es la prueba de que
   *    no se duplica). Para probar otro cobro distinto, cambia `etiqueta`.
   *  - Con `forzar_error: true` manda units:0 (con event_id propio «…-err») para ver la rama 400 «registra y para».
   *  - A un cliente con access:true NUNCA se le cobra, tampoco aquí (prohibición absoluta del contrato).
   * Pide antes al administrador del marketplace el MODO PRUEBA de la app: los cargos quedan con
   * status "test" y no tocan el wallet ni el crédito.
   */
  app.post('/api/marketplace/probar', async (req, reply) => {
    if (!mdActivo()) return reply.code(503).send({ error: 'La integración está apagada: falta la variable de entorno MD_API_KEY.' });
    const b = req.body || {};
    const accId = numId(b.account_id);
    // También se admite un location_id suelto (solo admin): la pasada de validación acordada con el
    // marketplace usa dos subcuentas de pruebas que NO son conexiones de Hermes.
    const locSuelto = String(b.location_id || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!accId && !locSuelto) return reply.code(400).send({ error: 'Indica la conexión (account_id) o un location_id sobre el que probar.' });
    const cuenta = accId
      ? await one(`SELECT id, name, location_id FROM accounts WHERE id = $1`, [accId])
      : { id: null, name: `(sin conexión en Hermes) ${locSuelto}`, location_id: locSuelto };
    if (!cuenta) return reply.code(404).send({ error: 'Esa conexión no existe' });
    if (!cuenta.location_id) return reply.code(400).send({ error: 'Esa conexión no tiene location_id de GHL: no se le puede cobrar.' });

    const pasos = [];
    const cfg = mdConfig();
    pasos.push({ paso: 'configuracion', ...cfg });

    const tarifas = await listarTarifas().catch((e) => ({ status: 0, meters: [], error: e.message }));
    const meterOk = tarifas.meters?.some((m) => m.code === cfg.meter);
    pasos.push({
      paso: 'tarifas', status: tarifas.status, meter_configurado: cfg.meter, meter_disponible: Boolean(meterOk),
      meters: (tarifas.meters || []).map((m) => ({ code: m.code, price_type: m.price_type, min: m.min_price, max: m.max_price })),
      error: tarifas.error || undefined,
    });

    const acceso = await accesoDe(cuenta.location_id);
    pasos.push({ paso: 'acceso', ...(acceso || { access: null, nota: 'sin respuesta y sin caché previa: se seguiría el flujo de cobro normal' }) });

    if (acceso?.access === false) {
      pasos.push({ paso: 'fondos', ...(await hayFondos(cuenta.location_id)) });
    } else {
      pasos.push({ paso: 'fondos', omitido: true, nota: acceso?.access ? 'access:true → uso incluido, no se comprueban fondos ni se cobra' : 'acceso desconocido → el contrato solo permite consultar fondos con access:false; se atendería sin cobrar de momento' });
    }

    if (!b.cobrar) {
      return { ok: true, cuenta, solo_diagnostico: true, pasos, siguiente: 'Repite con {"cobrar": true} para ejecutar un cobro real de prueba.' };
    }
    // Prohibición ABSOLUTA del contrato: a un cliente con acceso incluido no se le cobra, ni en
    // pruebas. Para ver el ciclo de cobro completo se prueba con una subcuenta que tenga access:false.
    if (acceso?.access) {
      return {
        ok: true, cuenta, pasos, cobro: null,
        nota: 'Este cliente tiene el uso INCLUIDO (access:true): el contrato prohíbe cobrarle. No se ha cobrado nada. Prueba el cobro con una conexión cuyo acceso sea «por uso».',
      };
    }
    if (!cfg.cobros_activos) {
      return { ok: true, cuenta, pasos, cobro: null, nota: 'MD_COBROS=false (modo observación): no se ejecutan cobros, ni de prueba.' };
    }

    const dia = diaNatural();
    const etiqueta = String(b.etiqueta || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    // El caso de error va con SU PROPIO event_id: reutilizar el del cobro válido con units distintos
    // lo prohíbe el contrato (y el marketplace respondería 200 idempotente, falseando la prueba).
    const eventId = eventIdDe(cuenta.location_id, `prueba${etiqueta}${b.forzar_error ? '-err' : ''}`, dia);
    const units = b.forzar_error ? 0 : cfg.unidades_por_cobro;

    // misma disciplina de outbox que en producción: la fila se crea ANTES de llamar
    await q(
      `INSERT INTO marketplace_charges (event_id, account_id, conversation_id, location_id, dia, units, price)
       VALUES ($1,$2,NULL,$3,$4::date,$5,$6) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, cuenta.id, cuenta.location_id, dia, units, cfg.precio_unidad]
    );

    const r = await cobrar({
      locationId: cuenta.location_id,
      units,
      eventId,
      price: cfg.precio_unidad,
      description: `Hermes Setter · prueba de integración (${dia})`,
    });
    const ch = r.charge || {};
    await q(
      `UPDATE marketplace_charges
          SET estado = $2, charge_id = COALESCE($3, charge_id), charge_status = $4, test_mode = $5,
              paid_with = $6, amount = $7, intentos = intentos + 1, ultimo_error = $8, updated_at = now()
        WHERE event_id = $1`,
      [eventId, r.estado, Number.isInteger(ch.id) ? ch.id : null, String(ch.status || ''), Boolean(r.test_mode),
       String(ch.paid_with || ''), ch.amount ?? null, String(r.error || '')]
    );

    pasos.push({
      paso: 'cobro', event_id: eventId, estado: r.estado, idempotente: Boolean(r.idempotente),
      reconciliado: Boolean(r.reconciliado), test_mode: Boolean(r.test_mode), charge: ch, error: r.error,
    });
    return {
      ok: r.ok, cuenta, pasos, event_id: eventId,
      nota: r.idempotente
        ? 'Idempotencia CONFIRMADA: ese event_id ya estaba cobrado y no se ha duplicado.'
        : r.test_mode
          ? 'Cobro en MODO PRUEBA: registrado sin tocar wallet ni crédito. Repite la llamada para comprobar la idempotencia.'
          : 'Cobro REAL ejecutado. Repite la llamada para comprobar que no se duplica.',
    };
  });
}
