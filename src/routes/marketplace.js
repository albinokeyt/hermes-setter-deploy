import { q, one } from '../db.js';
import { requireAdmin } from '../lib/session.js';
import { chargeQueue } from '../queues.js';
import {
  mdConfig, mdActivo, accesoDe, hayFondos, cobrar, consultarCobro,
  listarTarifas, eventIdDe, diaNatural, barrerPendientes, cerrarLotesConsumo, corteCobroIa, finanzasMd,
} from '../services/marketplace.js';
import { getFacturacion, guardarFacturacion, FUENTES } from '../services/facturacion.js';
import { cuentaOpenRouter, gastoClavesHermes, alertaOpenRouter } from '../services/openrouter.js';
import { diaValido } from '../lib/fechas.js';

// Comisión de OpenRouter al comprar créditos (5,5 %, mínimo 0,80 $ por compra). La API no la da: es una estimación.
const COMISION_OPENROUTER_PCT = 5.5;

// Rango de días de las tarjetas Rentabilidad y Dinero real (día natural de la zona del cobro). UNA sola regla para
// las dos, para que siempre hablen del mismo periodo: lo que falte, venga mal escrito o no exista (2026-02-30) →
// del día 1 del mes en curso a hoy. Ninguna fecha imposible llega a un `::date` de Postgres.
const rangoPanel = (query) => {
  const hoy = diaNatural();
  return {
    desde: diaValido(query?.desde) ? query.desde : `${hoy.slice(0, 8)}01`,
    hasta: diaValido(query?.hasta) ? query.hasta : hoy,
  };
};
// «Desde» después de «Hasta» (pasa a menudo mientras se cambia de mes). No se intercambian sin avisar: se dice.
const AVISO_RANGO_INVERTIDO = 'La fecha «Desde» es posterior a «Hasta»: no hay cifras de ese periodo. Cambia una de las dos.';

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
    const desde = (await corteCobroIa()) ?? 2147483647; // sin corte: nada pendiente de cobro (id es int4)
    // lo cobrado de verdad (sin los cargos de prueba del marketplace)
    const [hoy, mes, porEstado, cuentas] = await Promise.all([
      one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS usd
             FROM marketplace_charges WHERE dia = $1::date AND estado = 'cobrado' AND NOT test_mode`, [diaNatural()]),
      one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS usd
             FROM marketplace_charges WHERE dia >= date_trunc('month', $1::date) AND estado = 'cobrado' AND NOT test_mode`, [diaNatural()]),
      q(`SELECT estado, COUNT(*)::int AS n FROM marketplace_charges GROUP BY estado`),
      // por_cobrar = precio al cliente del consumo que aún no ha entrado en ningún lote
      q(`SELECT a.id, a.name, a.location_id, a.md_acceso, a.md_acceso_at, a.md_sin_fondos_at,
                COALESCE((SELECT SUM(u.billed_usd) FROM llm_usage u
                           WHERE u.account_id = a.id AND u.md_charge_id IS NULL AND u.id > $1 AND u.billed_usd > 0 AND NOT u.incluido), 0)::float AS por_cobrar
           FROM accounts a ORDER BY a.name`, [desde]),
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

  // ── 💰 Facturación por consumo de IA: multiplicador, umbral del lote y qué se cobra ──
  app.get('/api/marketplace/facturacion', async () => ({ facturacion: await getFacturacion(), fuentes: FUENTES }));
  app.put('/api/marketplace/facturacion', async (req) => ({ facturacion: await guardarFacturacion(req.body || {}), fuentes: FUENTES }));

  // Cerrar YA los lotes de todo lo acumulado (≥ 0,01 USD), sin esperar al umbral ni a las 24 h. Opcional: una conexión.
  app.post('/api/marketplace/lotes/cerrar', async (req) => cerrarLotesConsumo({ forzar: true, accountId: numId(req.body?.account_id) }));

  // ── 📊 Rentabilidad por cliente en un rango de fechas ([desde, hasta] en días naturales de la zona del cobro) ──
  // coste = lo que nos ha costado su IA (TODO: también pruebas y editor de prompts) · precio = lo que se le cobra por
  // ese consumo (coste × multiplicador, solo trabajo con leads) · cobrado = cargos confirmados (sin los de prueba) ·
  // incluido = lotes de clientes con el uso incluido (prueba/plan: no se les cobra) · pendiente = lotes aún sin cobrar.
  app.get('/api/marketplace/rentabilidad', async (req) => {
    const { desde, hasta } = rangoPanel(req.query);
    // zona del cobro; si estuviera mal escrita, UTC (y se avisa) para que el panel no se caiga
    let zona = mdConfig().zona_horaria;
    let zonaValida = true;
    try { new Intl.DateTimeFormat('sv-SE', { timeZone: zona }); } catch { zona = 'UTC'; zonaValida = false; }
    // rango al revés: ni se consulta (saldría vacío sin decir por qué) ni se intercambia; se avisa
    if (desde > hasta) {
      return {
        desde, hasta, zona, zona_valida: zonaValida, facturacion: await getFacturacion(), clientes: [], totales: null,
        rango_invalido: true, aviso_rango: AVISO_RANGO_INVERTIDO,
      };
    }
    const corte = (await corteCobroIa()) ?? 2147483647;
    // Todo se cuenta por la FECHA DE CADA LLAMADA (el lote se cierra después y su día es el del cierre): así el coste
    // y lo cobrado de esa misma IA caen en el mismo periodo. Precio y cobro solo del consumo posterior al cambio a cobro
    // por consumo (antes la fórmula era otra y se cubría con la prueba gratuita).
    const filas = await q(
      `WITH uso AS (
         SELECT u.account_id,
                COALESCE(SUM(u.cost_usd), 0)::float AS coste,
                COALESCE(SUM(u.billed_usd) FILTER (WHERE u.billed_usd > 0 AND u.id > $4), 0)::float AS precio,
                COALESCE(SUM(u.billed_usd) FILTER (WHERE u.id > $4 AND c.estado = 'cobrado' AND NOT c.test_mode), 0)::float AS cobrado,
                COALESCE(SUM(u.billed_usd) FILTER (WHERE u.id > $4 AND u.billed_usd > 0 AND (u.incluido OR c.estado = 'incluido')), 0)::float AS incluido,
                COALESCE(SUM(u.billed_usd) FILTER (WHERE u.id > $4 AND u.billed_usd > 0 AND NOT u.incluido
                           AND (u.md_charge_id IS NULL OR c.estado IN ('pendiente','sin_confirmar','error','cortado','sin_saldo'))), 0)::float AS pendiente,
                COALESCE(SUM(u.billed_usd) FILTER (WHERE u.id > $4 AND u.billed_usd > 0 AND NOT u.incluido AND u.md_charge_id IN (0, -1)), 0)::float AS no_cobrable,
                COUNT(*)::int AS llamadas,
                COUNT(*) FILTER (WHERE u.cost_usd IS NULL)::int AS sin_coste
           FROM llm_usage u LEFT JOIN marketplace_charges c ON c.id = u.md_charge_id
          WHERE u.source <> 'archivo'
            AND (u.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
          GROUP BY u.account_id),
       cob AS (
         SELECT account_id, COUNT(*) FILTER (WHERE estado = 'error')::int AS con_error
           FROM marketplace_charges
          WHERE tipo = 'consumo_ia' AND dia BETWEEN $1::date AND $2::date
          GROUP BY account_id)
       SELECT COALESCE(a.id, 0) AS id, COALESCE(a.name, '(conexiones borradas)') AS name, a.location_id, a.md_acceso, a.md_sin_fondos_at,
              COALESCE(uso.coste, 0) AS coste, COALESCE(uso.precio, 0) AS precio, COALESCE(uso.llamadas, 0) AS llamadas,
              COALESCE(uso.sin_coste, 0) AS sin_coste, COALESCE(uso.no_cobrable, 0) AS no_cobrable,
              COALESCE(uso.cobrado, 0) AS cobrado, COALESCE(uso.incluido, 0) AS incluido,
              COALESCE(uso.pendiente, 0) AS pendiente, COALESCE(cob.con_error, 0) AS con_error
         FROM (SELECT account_id FROM uso UNION SELECT account_id FROM cob) k
         LEFT JOIN accounts a ON a.id = k.account_id
         LEFT JOIN uso ON uso.account_id IS NOT DISTINCT FROM k.account_id
         LEFT JOIN cob ON cob.account_id IS NOT DISTINCT FROM k.account_id
        ORDER BY COALESCE(uso.coste, 0) DESC`,
      [desde, hasta, zona, corte]
    );
    const r2 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
    const clientes = filas.map((f) => ({
      ...f,
      // beneficio REAL: lo cobrado menos lo que nos costó su IA en el rango
      beneficio: r2(f.cobrado - f.coste),
      // beneficio si se cobrara todo lo que su consumo vale (lo de los clientes con prueba gratuita incluido)
      beneficio_previsto: r2(f.precio - f.coste),
    }));
    const suma = (k) => r2(clientes.reduce((s, c) => s + (Number(c[k]) || 0), 0));
    const sinCliente = await one(
      `SELECT COALESCE(SUM(cost_usd), 0)::float AS coste FROM llm_usage
        WHERE source = 'archivo' AND (created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`,
      [desde, hasta, zona]
    );
    return {
      desde, hasta, zona, zona_valida: zonaValida, facturacion: await getFacturacion(), clientes,
      totales: {
        coste: suma('coste'), precio: suma('precio'), cobrado: suma('cobrado'), incluido: suma('incluido'),
        pendiente: suma('pendiente'), no_cobrable: suma('no_cobrable'), beneficio: suma('beneficio'), beneficio_previsto: suma('beneficio_previsto'),
        coste_sin_cliente: r2(sinCliente?.coste || 0),
      },
    };
  });

  // ── 💵 Dinero real: lo que el dueño ha pagado a OpenRouter y lo que le han pagado los clientes ──
  // ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (el rango de la tarjeta de Rentabilidad, con su MISMA regla: rangoPanel) &refrescar=1
  // (salta la caché de 5 min de OpenRouter). Sin ninguna de las dos claves no hay rango (solo lo histórico).
  // Junta tres fuentes que fallan por separado (ninguna tumba la respuesta):
  //  · OpenRouter: cuenta entera (con OPENROUTER_MANAGEMENT_KEY) y gasto de cada clave de Proveedores. Nunca claves en claro.
  //  · Marketplace (GET /api/v1/finanzas): dinero real y cortesía de cada cliente, regla «cortesía primero».
  //  · Hermes (llm_usage): lo que nos ha costado la IA (sin el Archivo, que no es de ningún cliente).
  app.get('/api/marketplace/finanzas', async (req) => {
    // el panel manda siempre las dos claves (aunque vayan vacías): así recibe exactamente el rango de Rentabilidad
    const pideRango = Boolean(req.query) && ('desde' in req.query || 'hasta' in req.query);
    const pedido = pideRango ? rangoPanel(req.query) : { desde: null, hasta: null };
    // «Desde» después de «Hasta»: lo histórico se sigue viendo, pero sin cifras del rango (y se avisa)
    const rangoInvalido = Boolean(pedido.desde && pedido.hasta && pedido.desde > pedido.hasta);
    const desde = rangoInvalido ? null : pedido.desde;
    const hasta = rangoInvalido ? null : pedido.hasta;
    const hayRango = Boolean(desde || hasta);
    const refrescar = ['1', 'true', 'si', 'sí'].includes(String(req.query?.refrescar || '').trim().toLowerCase());
    // misma zona que Rentabilidad (la del cobro); mal escrita → UTC para que el panel no se caiga
    let zona = mdConfig().zona_horaria;
    try { new Intl.DateTimeFormat('sv-SE', { timeZone: zona }); } catch { zona = 'UTC'; }

    const r6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
    const [cuenta, clavesHermes, md, coste, cuentas] = await Promise.all([
      cuentaOpenRouter({ refrescar }).catch(() => ({ configurada: true, total_credits: null, total_usage: null, saldo: null, claves: [], error: 'No se pudo consultar OpenRouter.' })),
      gastoClavesHermes({ refrescar }).catch(() => []),
      finanzasMd({ desde, hasta, zona }),
      // Coste de la IA del rango con la MISMA referencia de día que el dinero del marketplace, que cuenta cada lote el
      // día en que se cobró (su entrada en el libro): la IA de un lote ya cobrado (y real) cuenta ese mismo día; el resto
      // del coste (uso incluido o de prueba, lotes pendientes o sin saldo, lo no cobrable, lo anterior al corte), el día
      // de cada llamada. Cada llamada cuenta UNA vez y la suma de varios rangos sigue dando el histórico.
      // updated_at del lote no se mueve una vez 'cobrado' (todos los UPDATE que lo tocan llevan la guarda de estado).
      one(
        `SELECT COALESCE(SUM(u.cost_usd) FILTER (WHERE u.source <> 'archivo'), 0)::float AS historico,
                COALESCE(SUM(u.cost_usd) FILTER (WHERE u.source = 'archivo'), 0)::float AS archivo,
                COALESCE(SUM(u.cost_usd) FILTER (WHERE u.source <> 'archivo'
                           AND ($1::date IS NULL OR (COALESCE(c.updated_at, u.created_at) AT TIME ZONE $3)::date >= $1::date)
                           AND ($2::date IS NULL OR (COALESCE(c.updated_at, u.created_at) AT TIME ZONE $3)::date <= $2::date)), 0)::float AS rango
           FROM llm_usage u
           LEFT JOIN marketplace_charges c ON c.id = u.md_charge_id
                AND c.tipo = 'consumo_ia' AND c.estado = 'cobrado' AND NOT c.test_mode`,
        [desde, hasta, zona]
      ).catch(() => null), // sin la base no hay coste: se enseña «—», nunca un 0 que infle el resultado
      q(`SELECT id, COALESCE(NULLIF(alias, ''), name) AS name, location_id FROM accounts WHERE COALESCE(location_id, '') <> ''`)
        .catch(() => []),
    ]);

    // ── clientes: cada subcuenta del marketplace, cruzada con su conexión de Hermes por location_id ──
    const porLoc = new Map(cuentas.map((a) => [a.location_id, a]));
    const disponible = md.disponible === true;
    const filas = disponible
      ? (md.locations || []).map((l) => {
          const a = porLoc.get(l.location_id);
          return {
            account_id: a?.id ?? null,
            name: a?.name || l.name || l.location_id,
            location_id: l.location_id,
            saldo: l.saldo || null,
            historico: l.historico || null,
            rango: hayRango ? l.rango ?? null : null,
          };
        }).sort((x, y) => (Number(y.historico?.real_recargado) || 0) - (Number(x.historico?.real_recargado) || 0)
          || (Number(y.historico?.cortesia_concedida) || 0) - (Number(x.historico?.cortesia_concedida) || 0)
          || String(x.name).localeCompare(String(y.name), 'es'))
      : [];
    const totales = disponible ? md.totales || null : null;
    const H = totales?.historico || null;
    const R = hayRango ? totales?.rango || null : null;
    const S = totales?.saldo || null;

    // ── Hermes: lo que nos ha costado la IA (null = no se ha podido leer) ──
    const hermes = coste
      ? {
          coste_ia_historico: r6(coste.historico),
          coste_ia_rango: hayRango ? r6(coste.rango) : null,
          coste_ia_archivo_historico: r6(coste.archivo),
        }
      : { coste_ia_historico: null, coste_ia_rango: null, coste_ia_archivo_historico: null };

    // ── resumen ──
    const sumaUsage = (campo) => {
      const vals = clavesHermes.map((c) => c[campo]).filter((v) => Number.isFinite(v));
      return vals.length ? r6(vals.reduce((s, v) => s + v, 0)) : null;
    };
    const pagado = cuenta?.configurada && Number.isFinite(cuenta.total_credits) ? cuenta.total_credits : null;
    const siH = (fn) => (H ? r6(fn(H)) : null);
    const n = (v) => Number(v) || 0;
    // dinero real gastado en Hermes: lo pagado con el saldo real más lo cobrado directamente del monedero de GHL
    // (cobros antiguos y suscripciones de Hermes), que es dinero real aunque no pase por el saldo
    const realHermes = (b) => n(b.consumo_app_real) + n(b.cobrado_monedero_app);
    const resumen = {
      pagado_openrouter: pagado,
      comision_estimada: pagado !== null ? r6(pagado * COMISION_OPENROUTER_PCT / 100) : null,
      gastado_openrouter_cuenta: cuenta?.configurada && Number.isFinite(cuenta.total_usage) ? cuenta.total_usage : null,
      saldo_openrouter: cuenta?.configurada && Number.isFinite(cuenta.saldo) ? cuenta.saldo : null,
      gastado_claves_hermes: sumaUsage('usage'),
      gastado_claves_hermes_mes: sumaUsage('usage_monthly'),
      te_han_pagado: siH((h) => n(h.real_recargado) + n(h.cobrado_monedero_app)),
      cortesia_regalada: siH((h) => n(h.cortesia_concedida) - n(h.cortesia_retirada)),
      consumido_hermes_real: siH(realHermes),
      // su desglose, para que el panel enseñe de dónde sale cada cifra
      consumido_hermes_real_saldo: siH((h) => n(h.consumo_app_real)),
      cobrado_monedero_hermes: siH((h) => n(h.cobrado_monedero_app)),
      consumido_hermes_cortesia: siH((h) => n(h.consumo_app_cortesia)),
      // el dinero REAL gastado en Hermes (saldo real + monedero de GHL) menos lo que nos ha costado toda la IA de Hermes
      resultado_real_hermes: H && hermes.coste_ia_historico !== null ? r6(realHermes(H) - hermes.coste_ia_historico) : null,
      saldo_clientes_real: S ? r6(S.real) : null,
      saldo_clientes_cortesia: S ? r6(S.cortesia) : null,
      // lo mismo, solo en el rango elegido (el dinero cuenta el día en que se cobró cada lote; el coste, ver arriba)
      consumido_hermes_real_rango: R ? r6(realHermes(R)) : null,
      cobrado_monedero_hermes_rango: R ? r6(R.cobrado_monedero_app) : null,
      consumido_hermes_cortesia_rango: R ? r6(R.consumo_app_cortesia) : null,
      resultado_real_rango: R && hermes.coste_ia_rango !== null ? r6(realHermes(R) - hermes.coste_ia_rango) : null,
      alerta_openrouter: alertaOpenRouter(cuenta, clavesHermes),
    };

    return {
      openrouter: { cuenta, claves_hermes: clavesHermes, comision_pct: COMISION_OPENROUTER_PCT },
      clientes: { disponible, motivo: disponible ? null : md.motivo || 'No se pudo consultar el marketplace.', filas, totales },
      hermes,
      resumen,
      desde, hasta, zona,
      rango_invalido: rangoInvalido,
      aviso_rango: rangoInvalido ? AVISO_RANGO_INVERTIDO : null,
    };
  });

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
    const units = b.forzar_error ? 0 : 1;
    const PRECIO_PRUEBA = 0.01; // el mínimo de la tarifa: la prueba mueve como mucho un céntimo

    // misma disciplina de outbox que en producción: la fila se crea ANTES de llamar
    await q(
      `INSERT INTO marketplace_charges (event_id, account_id, conversation_id, location_id, dia, units, price)
       VALUES ($1,$2,NULL,$3,$4::date,$5,$6) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, cuenta.id, cuenta.location_id, dia, units, PRECIO_PRUEBA]
    );

    const r = await cobrar({
      locationId: cuenta.location_id,
      units,
      eventId,
      price: PRECIO_PRUEBA,
      soloSaldo: true, // igual que los lotes reales: solo del saldo del marketplace
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
      nota: !r.ok
        ? `Cobro RECHAZADO (${r.estado}): ${r.error || 'sin detalle'}. ${r.estado === 'error' ? 'Es la rama «registra y para»: no se reintenta.' : 'Lo recoge el barrido con el mismo event_id.'}`
        : r.idempotente
          ? 'Idempotencia CONFIRMADA: ese event_id ya estaba cobrado y no se ha duplicado.'
          : r.test_mode
            ? 'Cobro en MODO PRUEBA: registrado sin tocar wallet ni crédito. Repite la llamada para comprobar la idempotencia.'
            : 'Cobro REAL ejecutado. Repite la llamada para comprobar que no se duplica.',
    };
  });
}
