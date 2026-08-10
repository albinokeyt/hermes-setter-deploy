import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, scopedAccountId, requireManageAgents, accessibleAccountIds, canAccessAccount } from '../lib/session.js';
import * as ghl from '../services/ghl.js';
import { activateSetterForContact, logEvent } from '../services/pipeline.js';
import { redis } from '../lib/redis.js';
import { WINDOWED_CHANNELS } from '../config.js';

// URL de comentarios: FIJA y LIMPIA, la misma para todas las conexiones (enruta por location.id).
const COMMENT_WEBHOOK_URL = `${config.appBaseUrl}/api/webhooks/comentarios`;

// OJO: los prompt_* de la conexión son columnas LEGACY (el bot usa SIEMPRE los del setter via
// mergeSetter) — fuera del whitelist para no escribir en una columna muerta sin versionado.
const ADMIN_EDITABLE = [
  'name', 'alias', 'mode', 'pit_token', 'location_id', 'channels',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'active_hours',
  'timezone', 'sync_tags', 'auto_handoff', 'bot_enabled', 'ai_enabled', 'test_mode', 'test_tag', 'exclude_tag',
  'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
  'calendar_id', 'calendar_ids', 'auto_handoff_minutes', 'required_tags', 'required_tags_mode', 'ctas',
  'insertion_wait_seconds', 'insertion_idle_hours',
];

// Un usuario normal solo toca su agente: prompt, comportamiento y seguimientos.
const USER_EDITABLE = [
  'alias',
  'followups', 'debounce_seconds', 'max_msgs',
  'active_hours', 'timezone', 'temperature', 'bot_enabled', 'test_mode', 'test_tag', 'auto_handoff_minutes',
  'required_tags', 'required_tags_mode', 'insertion_wait_seconds', 'insertion_idle_hours',
];

const JSON_FIELDS = new Set(['channels', 'followups', 'active_hours', 'calendar_ids', 'required_tags', 'ctas']);

function stripSecrets(row, req) {
  if (req.auth?.role === 'admin') return row;
  // el token crudo de comentarios no se expone; solo la URL ya montada (comment_webhook_url)
  const { pit_token, webhook_token, webhook_url, portal_key, portal_url, comment_token, ...safe } = row;
  return safe;
}

export default async function accountRoutes(app) {
  app.get('/api/accounts', async (req) => {
    const ids = await accessibleAccountIds(req); // null = admin (todas)
    const rows = await q(`
      SELECT a.*, p.name AS provider_name,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id) AS conversations_count,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.account_id = a.id AND c.updated_at > now() - interval '24 hours') AS active_24h,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id
      ${ids ? 'WHERE a.id = ANY($1::int[])' : ''}
      ORDER BY a.id`, ids ? [ids] : []);
    return rows.map((r) => {
      r.comment_webhook_url = COMMENT_WEBHOOK_URL; // misma URL fija para todas
      return stripSecrets(r, req);
    });
  });

  app.get('/api/accounts/:id', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const row = await one(`
      SELECT a.*, p.name AS provider_name,
        EXISTS(SELECT 1 FROM ghl_tokens t WHERE t.location_id = a.location_id) AS oauth_connected
      FROM accounts a LEFT JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    row.webhook_url = `${config.appBaseUrl}/api/webhooks/workflow/${row.webhook_token}`;
    row.comment_webhook_url = COMMENT_WEBHOOK_URL;
    if (req.auth?.role === 'admin') {
      row.portal_url = `${config.appBaseUrl}/ghl-portal?key=${row.portal_key}&location_id={{location.id}}&email={{user.email}}&name={{user.name}}`;
    }
    return stripSecrets(row, req);
  });

  app.post('/api/accounts', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'Ponle un nombre a la cuenta' });
    const token = crypto.randomBytes(16).toString('hex');
    const portalKey = crypto.randomBytes(24).toString('hex');
    const row = await one(
      `INSERT INTO accounts (name, webhook_token, portal_key) VALUES ($1, $2, $3) RETURNING *`,
      [String(name).trim(), token, portalKey]
    );
    // Toda conexión arranca con su setter principal (para tener siempre a quién enrutar).
    await q(`INSERT INTO setters (account_id, name, is_default) VALUES ($1, 'Setter principal', true)`, [row.id]);
    return row;
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const existing = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const editable = req.auth?.role === 'admin' ? ADMIN_EDITABLE : USER_EDITABLE;
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const field of editable) {
      if (!(field in b)) continue;
      let value = JSON_FIELDS.has(field) ? JSON.stringify(b[field]) : b[field] === '' && field === 'location_id' ? null : b[field];
      if (field === 'insertion_wait_seconds') value = Math.min(Math.max(0, Math.round(Number(b[field]) || 0)), 3600);
      if (field === 'insertion_idle_hours') value = Math.min(Math.max(0, Math.round(Number(b[field]) || 0)), 720);
      vals.push(value);
      sets.push(`${field} = $${vals.length}${JSON_FIELDS.has(field) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return stripSecrets(existing, req);
    vals.push(existing.id);
    const row = await one(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    return stripSecrets(row, req);
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    await q(`DELETE FROM accounts WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  // Alias (nombre visible): lo cambia el DUEÑO aunque la IA esté apagada — renombrar NO es función
  // de IA, así que NO pasa por requireManageAgents, solo por canAccessAccount.
  app.put('/api/accounts/:id/alias', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const alias = String(req.body?.alias ?? '').trim().slice(0, 80);
    const row = await one(`UPDATE accounts SET alias = $1 WHERE id = $2 RETURNING *`, [alias, req.params.id]);
    if (!row) return reply.code(404).send({ error: 'No existe' });
    return stripSecrets(row, req);
  });

  // Registro reciente del webhook de comentarios de ESTA conexión (para probar que llega).
  // Los recibidos salen de la tabla comments (durable, no se purga); los intentos sin texto o
  // duplicados salen de webhook_log (traza efímera, con tope global de ~2000 filas) solo como ayuda.
  app.get('/api/accounts/:id/comment-log', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const received = await q(
      `SELECT id, author, author_id, text, post_ref, channel, raw, created_at
       FROM comments WHERE account_id = $1 ORDER BY id DESC LIMIT 20`,
      [req.params.id]
    );
    const issues = await q(
      `SELECT id, kind, payload, created_at FROM webhook_log
       WHERE kind IN ('comentario_incompleto', 'comentario_duplicado') AND payload->>'account' = $1
       ORDER BY id DESC LIMIT 10`,
      [String(req.params.id)]
    );
    return { received, issues };
  });

  // Lista de calendarios de la subcuenta (desde GHL; si falta el scope, usa los vistos en citas).
  app.get('/api/accounts/:id/calendars', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    if (!account.location_id) return { calendars: [], source: 'sin_conexion' };
    try {
      const cals = await ghl.listCalendars(account, account.location_id);
      if (cals.length) return { calendars: cals, source: 'ghl' };
    } catch (err) {
      // scope no concedido u otro error → seguimos al fallback
    }
    const seen = await q(
      `SELECT DISTINCT calendar_id AS id FROM appointments WHERE account_id = $1 AND calendar_id IS NOT NULL AND calendar_id <> ''`,
      [account.id]
    );
    return { calendars: seen.map((s) => ({ id: s.id, name: s.id })), source: 'historial' };
  });

  // 🪪 Recuperar nombres: repasa las conversaciones SIN nombre de esta conexión y las rellena desde
  // la API de GHL. Repara el daño de una racha de tokens muertos (p. ej. la app desinstalada): en
  // ese periodo cada getContact fallaba en silencio y los leads quedaban «Lead sin nombre».
  app.post('/api/accounts/:id/recuperar-nombres', async (req, reply) => {
    const accId = Number(req.params.id);
    if (!Number.isInteger(accId) || accId <= 0 || accId > 2147483647) return reply.code(404).send({ error: 'No existe' });
    if (!(await canAccessAccount(req, accId))) return reply.code(403).send({ error: 'Sin acceso' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [accId]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    if (!account.location_id && !account.pit_token) return reply.code(400).send({ error: 'Esta conexión aún no está enlazada con GHL.' });

    const filas = await q(
      `SELECT id, ghl_contact_id FROM conversations
        WHERE account_id = $1 AND lead_name = '' AND ghl_contact_id IS NOT NULL AND ghl_contact_id <> ''
        ORDER BY updated_at DESC LIMIT 500`,
      [account.id]
    );
    let actualizados = 0;
    let sinNombreEnGhl = 0;
    let fallos = 0;
    let fallosSeguidos = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Lotes de 5 CON pausa entre lotes: el burst limit de GHL es ~100 req/10s por subcuenta y sin
    // pausa los 429 encadenados dispararían el corte de abajo con un diagnóstico falso de "token
    // muerto". El 429 se trata aparte (espera extra y NO cuenta como fallo de token); el corte 502
    // queda para fallos reales (401/403/red) seguidos.
    for (let i = 0; i < filas.length; i += 5) {
      const lote = filas.slice(i, i + 5);
      const resultados = await Promise.all(lote.map(async (f) => {
        try {
          const c = await ghl.getContact(account, f.ghl_contact_id);
          const nombre = [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.name || c?.contactName || '';
          const email = c?.email || '';
          if (nombre || email) {
            await q(
              `UPDATE conversations SET
                 lead_name = CASE WHEN lead_name = '' THEN $1 ELSE lead_name END,
                 lead_email = CASE WHEN lead_email = '' THEN $2 ELSE lead_email END
               WHERE id = $3`,
              [nombre, email, f.id]
            );
            return nombre ? 'ok' : 'sin_nombre';
          }
          return 'sin_nombre';
        } catch (err) {
          return err?.status === 429 ? 'rate' : 'fallo';
        }
      }));
      let huboRate = false;
      for (const r of resultados) {
        if (r === 'ok') { actualizados++; fallosSeguidos = 0; }
        else if (r === 'sin_nombre') { sinNombreEnGhl++; fallosSeguidos = 0; }
        else if (r === 'rate') { fallos++; huboRate = true; }
        else { fallos++; fallosSeguidos++; }
      }
      if (i + 5 < filas.length) await sleep(huboRate ? 3000 : 600);
      if (fallosSeguidos >= 10) {
        return reply.code(502).send({
          error: 'GHL no responde para esta conexión (¿token caducado o app sin reinstalar?). Reconecta la subcuenta (pestaña Conexión GHL) y vuelve a intentarlo.',
          actualizados, sin_nombre_en_ghl: sinNombreEnGhl, fallos, pendientes: filas.length - i - lote.length,
        });
      }
    }
    return { total: filas.length, actualizados, sin_nombre_en_ghl: sinNombreEnGhl, fallos };
  });

  // 📣 RESCATE: leads que escribieron y NADIE les respondió jamás (ni bot ni humano) — p. ej. por
  // una racha con la IA apagada. El setter les escribe ÉL, con un contexto del negocio que manda
  // (misma maquinaria que la activación por etiqueta: respeta ventana de Meta, pausas y registro ⚡).
  // rango opcional: solo leads cuyo ÚLTIMO mensaje cayó entre esas fechas (elegir la tanda a rescatar)
  const candidatosRescate = (accId, desde = null, hasta = null) => q(
    `SELECT c.id, c.ghl_contact_id, c.channel, c.setter_id, c.last_inbound_at
       FROM conversations c
      WHERE c.account_id = $1 AND c.bot_paused = false
        AND c.stage NOT IN ('descartado', 'atencion_humana')
        AND ($2::timestamptz IS NULL OR c.last_inbound_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR c.last_inbound_at <= $3::timestamptz)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound')
      ORDER BY c.last_inbound_at DESC NULLS LAST
      LIMIT 500`,
    [accId, desde, hasta]
  );
  // acotada a fechas sensatas: Date.parse acepta años extremos cuyo ISO Postgres rechaza (500)
  const fechaISO = (v) => {
    const t = Date.parse(String(v || ''));
    if (!Number.isFinite(t)) return null;
    return (t >= Date.UTC(2000, 0, 1) && t <= Date.UTC(2100, 0, 1)) ? new Date(t).toISOString() : null;
  };
  // ventana de Meta (~24h desde el último mensaje del lead): fuera de ella es IMPOSIBLE escribirles
  const enVentana = (c) => !WINDOWED_CHANNELS.includes(c.channel)
    || (c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < 23 * 3_600_000);

  app.get('/api/accounts/:id/rescate', async (req, reply) => {
    const accId = Number(req.params.id);
    if (!Number.isInteger(accId) || accId <= 0) return reply.code(404).send({ error: 'No existe' });
    if (!(await requireManageAgents(req, reply))) return;
    if (!(await canAccessAccount(req, accId))) return reply.code(403).send({ error: 'Sin acceso' });
    const filas = await candidatosRescate(accId, fechaISO(req.query?.desde), fechaISO(req.query?.hasta));
    const dentro = filas.filter(enVentana).length;
    return { total: filas.length, dentro_ventana: dentro, fuera_ventana: filas.length - dentro };
  });

  app.post('/api/accounts/:id/rescate', async (req, reply) => {
    const accId = Number(req.params.id);
    if (!Number.isInteger(accId) || accId <= 0) return reply.code(404).send({ error: 'No existe' });
    if (!(await requireManageAgents(req, reply))) return;
    if (!(await canAccessAccount(req, accId))) return reply.code(403).send({ error: 'Sin acceso' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [accId]);
    if (!account) return reply.code(404).send({ error: 'No existe' });
    if (!account.ai_enabled || !account.bot_enabled) return reply.code(400).send({ error: 'La conexión tiene la IA o el bot apagados: enciéndelos antes de rescatar.' });
    // 🧪 MODO TEST: la activación se salta el filtro de test por diseño (orden explícita) — un
    // rescate masivo lo heredaría y escribiría a 150 leads REALES de una conexión "en pruebas".
    if (account.test_mode) return reply.code(400).send({ error: 'La conexión está en 🧪 modo test: desactívalo antes de lanzar un rescate masivo.' });

    const contexto = String(req.body?.contexto || '').trim().slice(0, 1200);
    if (!contexto) return reply.code(400).send({ error: 'Escribe el contexto del rescate (qué debe decir el setter y cómo entrar).' });

    // candado: un solo rescate en curso por conexión (dos pulsaciones o dos admins = tandas dobles
    // a los leads "en vuelo"). El EX cubre un proceso muerto; se libera al completar.
    const lock = await redis.set(`rescate:${accId}`, '1', 'EX', 1800, 'NX');
    if (!lock) return reply.code(409).send({ error: 'Ya hay un rescate en curso para esta conexión. Espera a que termine (mira el Registro de eventos: rescate_completado).' });

    // ⏱️ GOTEO configurable: `lote` mensajes cada `cada_minutos` (dentro del lote, 8s entre leads)
    const lote = Math.min(Math.max(1, Math.round(Number(req.body?.lote) || 5)), 20);
    const cadaMin = Math.min(Math.max(1, Math.round(Number(req.body?.cada_minutos) || 10)), 240);

    const setters = await q(`SELECT * FROM setters WHERE account_id = $1`, [accId]);
    const porId = Object.fromEntries(setters.map((s) => [s.id, s]));
    const porDefecto = setters.find((s) => s.is_default) || setters[0] || null;

    const filas = await candidatosRescate(accId, fechaISO(req.body?.desde), fechaISO(req.body?.hasta));
    const elegibles = [];
    let fueraVentana = 0;
    let sinSetter = 0;
    let setterApagado = 0;
    let fueraPorGoteo = 0;
    let fueraPorTope = 0;
    for (const c of filas) {
      if (!enVentana(c)) { fueraVentana++; continue; }
      const setter = porId[c.setter_id] || porDefecto;
      if (!setter) { sinSetter++; continue; }
      if (!setter.bot_enabled) { setterApagado++; continue; } // se autodescartaría: no contarlo como programado
      // hora REAL de salida con el goteo: si para entonces su ventana de Meta ya cerró, no se
      // programa un envío condenado — se cuenta aparte para que el usuario acelere el goteo
      const i = elegibles.length;
      const waitS = 15 + Math.floor(i / lote) * cadaMin * 60 + (i % lote) * 8;
      // tope duro de programación (48h): sin este corte, pipeline recortaría esperas mayores a 48h
      // y TODOS esos leads dispararian A LA VEZ — justo la ráfaga que el goteo evita
      if (waitS > 172_800) { fueraPorTope++; continue; }
      if (WINDOWED_CHANNELS.includes(c.channel) && c.last_inbound_at
        && (new Date(c.last_inbound_at).getTime() + 23 * 3_600_000) < (Date.now() + waitS * 1000)) {
        fueraPorGoteo++;
        continue;
      }
      elegibles.push({ ...c, setter, waitS });
      if (elegibles.length >= 150) break; // tope por pasada (puede repetirse: cero-outbound es idempotente)
    }

    // Respondemos YA y programamos en segundo plano: cada activación consulta la API de GHL
    // (historial + contacto) y con decenas de leads tardaría minutos. Los envíos salen ESPACIADOS
    // (~8s entre leads) para no parecer una ráfaga; el progreso se ve en ⚡ Activaciones (tag «rescate»).
    const duracionMin = elegibles.length ? Math.ceil(((elegibles[elegibles.length - 1].waitS || 0) / 60)) : 0;
    reply.send({ programados: elegibles.length, fuera_de_ventana: fueraVentana, fuera_por_goteo: fueraPorGoteo, fuera_por_tope: fueraPorTope, sin_setter: sinSetter, setter_apagado: setterApagado, total_sin_respuesta: filas.length, duracion_min: duracionMin, lote, cada_minutos: cadaMin });

    setImmediate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let ok = 0;
      let fallos = 0;
      let atendidosEntretanto = 0;
      await logEvent('rescate_iniciado', { account: accId, leads: elegibles.length }).catch(() => {});
      try {
        for (let i = 0; i < elegibles.length; i++) {
          const c = elegibles[i];
          // la lista se congeló al pulsar y esto tarda minutos: re-verificar que el lead SIGUE sin
          // respuesta y sin pausar (un humano pudo atenderlo entretanto → no escribir encima)
          const sigue = await one(
            `SELECT 1 AS ok FROM conversations c2 WHERE c2.id = $1 AND c2.bot_paused = false
               AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c2.id AND m.direction = 'outbound')`,
            [c.id]
          );
          if (!sigue) { atendidosEntretanto++; continue; }
          try {
            // respetarPausaHumano: el rescate NO levanta la auto-pausa por intervención humana;
            // canal: ancla la activación a la conversación auditada; maxEsperaS: el goteo puede
            // programar envíos a horas vista (el tope normal de 1h los comprimiría todos)
            await activateSetterForContact(account, c.setter, c.ghl_contact_id, c.waitS, contexto, 'rescate', { respetarPausaHumano: true, canal: c.channel, maxEsperaS: 172_800 });
            ok++;
          } catch (err) {
            fallos++;
            await logEvent('rescate_error', { account: accId, contactId: c.ghl_contact_id, error: String(err.message || err).slice(0, 200) }).catch(() => {});
          }
          if ((i + 1) % 25 === 0) await logEvent('rescate_progreso', { account: accId, hechos: i + 1, de: elegibles.length }).catch(() => {});
          await sleep(400); // suave con la API de GHL al programar
        }
      } finally {
        await redis.del(`rescate:${accId}`).catch(() => {});
      }
      await logEvent('rescate_completado', { account: accId, programados: ok, fallos, atendidos_entretanto: atendidosEntretanto }).catch(() => {});
    });
  });
}
