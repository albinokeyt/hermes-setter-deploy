import crypto from 'node:crypto';
import { one, q, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, GHL_ED25519_KEY, GHL_RSA_KEY } from '../config.js';
import { handleInbound, handleOutboundEvent, handleAppointmentEvent, accountByLocation, logEvent, activateSetterForContact } from '../services/pipeline.js';

const APPOINTMENT_TYPES = ['AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete'];

function tryVerify(algo, pem, raw, sigB64) {
  try {
    return crypto.verify(algo, Buffer.from(raw), crypto.createPublicKey(pem), Buffer.from(String(sigB64), 'base64'));
  } catch {
    return false;
  }
}

function verifySignature(req) {
  if (config.allowUnsignedWebhooks) return true;
  const raw = req.rawBody || '';
  const ed = req.headers['x-ghl-signature'];
  if (ed && tryVerify(null, GHL_ED25519_KEY, raw, ed)) return true;
  const rsa = req.headers['x-wh-signature'];
  if (rsa && tryVerify('sha256', GHL_RSA_KEY, raw, rsa)) return true;
  return false;
}

function freshTimestamp(p) {
  if (!p.timestamp) return true;
  const ts = new Date(p.timestamp).getTime();
  if (Number.isNaN(ts)) return true;
  return Math.abs(Date.now() - ts) < 5 * 60_000;
}

// Clave GLOBAL del webhook de comentarios: la MISMA URL para todos los clientes.
// El sistema detecta la conexión por el location.id que viene en el payload de GHL.
// Generación ATÓMICA: INSERT ... ON CONFLICT DO NOTHING y RE-LEER, para que dos peticiones
// concurrentes en frío no generen claves distintas (una quedaría sin persistir → URL 404).
export async function commentKey() {
  const existing = await getSetting('comment_webhook', null);
  if (existing?.key) return existing.key;
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ('comment_webhook', $1, now())
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ key: crypto.randomBytes(20).toString('hex') })]
  );
  const persisted = await getSetting('comment_webhook', null);
  return persisted?.key || '';
}

// Ingesta de un comentario de Instagram para una conexión concreta (parseo + dedupe + guardado).
async function ingestComment(account, req) {
  try {
    const h = req.headers || {};
    const p = (req.body && typeof req.body === 'object') ? req.body : {};
    const c = p.customData || p.custom_data || {};
    const qy = req.query || {};
    const dec = (v) => { if (v == null) return ''; try { return decodeURIComponent(String(v)); } catch { return String(v); } };
    // Trigger nativo de GHL para comentarios de Instagram (igCommentOnPost): ya trae todo.
    const ig = (p.triggerData && p.triggerData.igCommentOnPost && p.triggerData.igCommentOnPost.ig) || {};
    // solo acepta primitivos: un objeto/array daría "[object Object]" o "1,2" (basura truthy)
    const first = (...vals) => {
      for (const v of vals) {
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return '';
    };
    // texto: nativo (ig.body) → customData/header/query → body plano
    const text = first(ig.body, ig.body_exact_match, dec(h['x-comment']), c['x-comment'], c.comment, c.text, c.message, dec(qy['x-comment']), p.body);
    // autor visible
    const author = first(p.full_name, [p.first_name, p.last_name].filter(Boolean).join(' '), dec(h['x-author']), c['x-author'], c.author, c.username, c.from);
    // id del autor: contacto de GHL (para poder responderle) o, si no, su igSid de Instagram
    const igSid = first(p.contact?.attributionSource?.igSid, p.contact?.lastAttributionSource?.igSid);
    const authorId = first(p.contact_id, p.contactId, dec(h['x-author-id']), c['x-author-id'], c.author_id) || igSid;
    // post (enlace o id)
    const post = first(ig.permalinkUrl, ig.postId, dec(h['x-post']), c['x-post'], c.post, c.permalink, c.post_url);
    // referencia única del comentario para deduplicar reenvíos del webhook
    const commentRef = first(ig.commentId, p.triggerData?.igCommentOnPost?.messageId);
    const channel = first(dec(h['x-channel']), c['x-channel'], c.channel) || 'IG';
    // registro para depurar cómo llega (headers propios x-* + body); se omiten los de infraestructura
    const xh = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('x-') && !k.startsWith('x-forwarded') && k !== 'x-real-ip'));
    const meta = { headers: xh, body: p };
    if (!text) {
      await logEvent('comentario_incompleto', { account: account.id, ...meta });
      return;
    }
    const res = await q(
      `INSERT INTO comments (account_id, author, author_id, text, post_ref, channel, comment_ref, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (account_id, comment_ref) WHERE comment_ref <> '' DO NOTHING
       RETURNING id`,
      [account.id, author, authorId, text, post, channel, commentRef, JSON.stringify(meta)]
    );
    if (!res.length) {
      await logEvent('comentario_duplicado', { account: account.id, comment_ref: commentRef, texto: text.slice(0, 200) });
      return;
    }
    await logEvent('comentario_recibido', { account: account.id, autor: author, texto: text.slice(0, 200), post, contact_id: authorId, comment_ref: commentRef, ...meta });
  } catch (err) {
    console.error('[webhook comment]', err);
    await logEvent('error_webhook', { error: err.message }).catch(() => {});
  }
}

// Enruta un comentario a su conexión por el location.id del payload y lo ingiere.
async function handleGlobalComment(req) {
  try {
    const p = (req.body && typeof req.body === 'object') ? req.body : {};
    const loc = String(p.location?.id || p.locationId || p.location_id || '').trim();
    if (!loc) {
      await logEvent('comentario_sin_subcuenta', { nota: 'el payload no trae location.id', keys: Object.keys(p) });
      return;
    }
    const account = await one(`SELECT id FROM accounts WHERE location_id = $1`, [loc]);
    if (!account) {
      await logEvent('comentario_subcuenta_desconocida', { locationId: loc });
      return;
    }
    await ingestComment(account, req);
  } catch (err) {
    console.error('[webhook comentarios]', err);
    await logEvent('error_webhook', { error: err.message }).catch(() => {});
  }
}

// ContactTagUpdate del marketplace: si el contacto tiene la etiqueta activadora de algún setter,
// ese setter lee el historial y escribe él solo. Dedupe por setter+contacto: dispara UNA vez por
// «añadido» de la etiqueta (al quitarse la etiqueta se resetea, así un re-añadido vuelve a disparar).
async function handleTagActivation(account, p) {
  const contactId = String(p.id || p.contact_id || p.contactId || p.contact?.id || '');
  // ¿el payload trae DE VERDAD la lista de etiquetas? (para no confundir "sin lista" con "sin la etiqueta")
  const tagsArray = Array.isArray(p.tags) ? p.tags : (Array.isArray(p.contact?.tags) ? p.contact.tags : null);
  const tags = (tagsArray || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const setters = await q(
    `SELECT * FROM setters WHERE account_id = $1 AND activation_enabled = true`,
    [account.id]
  );
  // Cada setter puede tener VARIAS etiquetas activadoras, y cada una lleva su propio contexto
  // (la misma etiqueta tras un CTA o tras un IF hace que entre hablando distinto). Las aplanamos.
  const entradas = [];
  for (const s of setters) {
    const lista = Array.isArray(s.activation_tags) ? s.activation_tags : [];
    for (const e of lista) {
      const tag = String(e?.tag || '').trim().toLowerCase();
      if (!tag) continue;
      entradas.push({ setter: s, tag, contexto: String(e?.contexto || ''), espera: Number(e?.espera) || 0 });
    }
  }
  // Sin ninguna etiqueta activadora configurada → no hay nada que hacer. No registramos nada para
  // no inundar la traza (ContactTagUpdate se dispara con CADA cambio de etiqueta de la subcuenta).
  if (!entradas.length) return;
  const evaluados = [];
  // Un setter entra UNA sola vez por evento aunque casen varias de sus etiquetas: si no, la segunda
  // activación pisaría el contexto de la primera y el agente entraría con el contexto equivocado.
  // Un setter entra UNA sola vez por evento; si varias de sus etiquetas casan a la vez, prevalece la
  // ÚLTIMA (por orden de la lista), que es la más reciente. Entre eventos distintos, la más nueva
  // también gana porque activateSetterForContact reescribe la activación pendiente.
  const frescasPorSetter = new Map(); // setterId -> { setter, list: [entradas frescas] }
  if (contactId) {
    for (const en of entradas) {
      const s = en.setter;
      const dedupe = `tagact:${s.id}:${en.tag}:${contactId}`;
      if (tags.includes(en.tag)) {
        const fresh = await redis.set(dedupe, '1', 'EX', 86400, 'NX');
        if (!fresh) { evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'ya_activado' }); continue; }
        if (!frescasPorSetter.has(s.id)) frescasPorSetter.set(s.id, { setter: s, list: [] });
        frescasPorSetter.get(s.id).list.push(en);
      } else {
        // SOLO si el payload trae la lista real y la etiqueta no está → resetear (re-añadido re-dispara).
        // Si el payload venía sin lista (parcial), NO tocamos el dedupe (evita doble activación).
        if (tagsArray) await redis.del(dedupe);
        evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'sin_coincidir' });
      }
    }
    // Activar cada setter con su ÚLTIMA etiqueta fresca (last wins); las demás quedan marcadas (no re-disparan).
    for (const { setter: s, list } of frescasPorSetter.values()) {
      const elegida = list[list.length - 1];
      for (const en of list) if (en !== elegida) evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'omitida_por_otra_etiqueta' });
      await logEvent('activador_etiqueta', { account: account.id, setter: s.id, contactId, etiqueta: elegida.tag, con_contexto: Boolean(elegida.contexto.trim()) });
      try {
        await activateSetterForContact(account, s, contactId, elegida.espera, elegida.contexto, elegida.tag);
        evaluados.push({ setter: s.id, nombre: s.name, etiqueta: elegida.tag, estado: 'activado' });
      } catch (err) {
        // Si falló, liberamos su dedupe: un error pasajero no debe quemar la etiqueta 24 h.
        await redis.del(`tagact:${s.id}:${elegida.tag}:${contactId}`).catch(() => {});
        evaluados.push({ setter: s.id, nombre: s.name, etiqueta: elegida.tag, estado: 'error', error: String(err.message).slice(0, 120) });
      }
    }
  }
  // Traza para el panel «🧪 Probar». ContactTagUpdate se dispara con CADA cambio de etiqueta de la
  // subcuenta, así que no podemos loguear siempre (inundaría el webhook_log global, cap 2000).
  //  · Si CASÓ una etiqueta de activación → registramos siempre (volumen bajo, acotado por el dedupe).
  //  · Si NO casó (típico typo al montar) → registramos ACOTADO a máx 1/min por cuenta, para que el
  //    panel confirme «el webhook llega» durante el setup sin saturar la traza compartida.
  const huboMatch = evaluados.some((e) => e.estado !== 'sin_coincidir');
  if (huboMatch) {
    await logEvent('etiqueta_recibida', { account: account.id, contactId: contactId || null, tags, evaluados });
  } else {
    const fresh = await redis.set(`etlog:${account.id}`, '1', 'EX', 60, 'NX');
    if (fresh) await logEvent('etiqueta_recibida', { account: account.id, contactId: contactId || null, tags, evaluados, sin_match: true });
  }
}

function normalizeMarketplaceEvent(p) {
  return {
    contactId: p.contactId,
    conversationId: p.conversationId,
    channel: p.messageType,
    body: p.body || '',
    messageId: p.messageId,
    userId: p.userId || null,
    attachments: Array.isArray(p.attachments) ? p.attachments : [],
    contactName: p.contactName || '',
  };
}

export default async function webhookRoutes(app) {
  // Webhook de la app de Marketplace (todas las subcuentas, una sola URL).
  // La ruta pública no lleva "ghl" (el validador del marketplace rechaza URLs
  // con referencias a HighLevel); /api/webhooks/ghl queda como alias legado.
  const marketplaceHandler = async (req, reply) => {
    const p = req.body || {};

    if (!verifySignature(req)) {
      await logEvent('firma_invalida', { type: p.type, locationId: p.locationId });
      return reply.code(401).send({ error: 'firma inválida' });
    }
    reply.send({ ok: true }); // responder rápido; procesamos después

    try {
      if (!freshTimestamp(p)) {
        await logEvent('timestamp_viejo', { type: p.type, timestamp: p.timestamp });
        return;
      }
      const dedupeKey = p.webhookId || p.messageId;
      if (dedupeKey) {
        const fresh = await redis.set(`wh:${dedupeKey}`, '1', 'EX', 172800, 'NX');
        if (!fresh) return; // reintento duplicado de GHL
      }

      const type = p.type;
      if (type !== 'InboundMessage' && type !== 'OutboundMessage' && type !== 'ContactTagUpdate' && !APPOINTMENT_TYPES.includes(type)) {
        await logEvent('evento_otro', { type, locationId: p.locationId });
        return;
      }
      const account = await accountByLocation(p.locationId);
      if (!account) {
        await logEvent('subcuenta_desconocida', { type, locationId: p.locationId, messageType: p.messageType });
        return;
      }
      if (type === 'ContactTagUpdate') {
        await handleTagActivation(account, p);
        return;
      }
      if (APPOINTMENT_TYPES.includes(type)) {
        await handleAppointmentEvent(account, type, p);
        return;
      }
      await logEvent(type === 'InboundMessage' ? 'mensaje_recibido' : 'mensaje_saliente', {
        locationId: p.locationId, messageType: p.messageType, contactId: p.contactId, body: String(p.body || '').slice(0, 200),
      });
      const evt = normalizeMarketplaceEvent(p);
      if (type === 'InboundMessage') await handleInbound(account, evt);
      else await handleOutboundEvent(account, evt);
    } catch (err) {
      console.error('[webhook ghl]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  };
  app.post('/api/webhooks/inbox', marketplaceHandler);
  app.post('/api/webhooks/ghl', marketplaceHandler);

  // ⚡ Webhook DEDICADO para ContactTagUpdate: URL APARTE del inbox de mensajes/citas, para no
  // mezclar el activador por etiqueta con el resto del pipeline. Se pega en Marketplace →
  // Advanced Settings → Webhooks → fila «ContactTagUpdate» → «Custom webhook URL». La MISMA URL
  // para todas las subcuentas (se detecta por el locationId del payload). Va firmado igual que el
  // resto de webhooks del marketplace, así que verificamos la firma.
  const tagWebhookHandler = async (req, reply) => {
    const p = req.body || {};
    if (!verifySignature(req)) {
      await logEvent('etiqueta_firma_invalida', { locationId: p.locationId });
      return reply.code(401).send({ error: 'firma inválida' });
    }
    reply.send({ ok: true });
    try {
      if (!freshTimestamp(p)) return;
      if (p.webhookId) {
        const fresh = await redis.set(`wh:${p.webhookId}`, '1', 'EX', 172800, 'NX');
        if (!fresh) return; // reintento duplicado de GHL
      }
      // La URL es dedicada a etiquetas; si por error pegan otro evento aquí, lo ignoramos.
      if (p.type && p.type !== 'ContactTagUpdate') {
        await logEvent('etiqueta_evento_otro', { type: p.type, locationId: p.locationId });
        return;
      }
      const account = await accountByLocation(p.locationId);
      if (!account) {
        await logEvent('etiqueta_subcuenta_desconocida', { locationId: p.locationId });
        return;
      }
      await handleTagActivation(account, p);
    } catch (err) {
      console.error('[webhook etiquetas]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  };
  app.post('/api/webhooks/etiquetas', tagWebhookHandler);

  // Webhook GLOBAL de comentarios: la MISMA URL LIMPIA para TODOS los clientes (sin token).
  // El sistema detecta a qué conexión pertenece por el location.id del payload del trigger de GHL.
  app.post('/api/webhooks/comentarios', async (req, reply) => {
    reply.send({ ok: true });
    await handleGlobalComment(req);
  });

  // Variante con clave (compat con URLs ya copiadas antes de la versión limpia).
  app.post('/api/webhooks/comments/:key', async (req, reply) => {
    if (String(req.params.key) !== (await commentKey())) return reply.code(404).send({ error: 'clave desconocida' });
    reply.send({ ok: true });
    await handleGlobalComment(req);
  });

  // Webhook de comentarios POR CONEXIÓN (legado): sigue funcionando para automatizaciones ya montadas.
  app.post('/api/webhooks/comment/:token', async (req, reply) => {
    const account = await one(`SELECT id FROM accounts WHERE comment_token = $1`, [req.params.token]);
    if (!account) return reply.code(404).send({ error: 'token desconocido' });
    reply.send({ ok: true });
    await ingestComment(account, req);
  });

  // ⚡ ACTIVADOR EXTERNO por setter: workflow de GHL (p. ej. "etiqueta asignada") → nodo Webhook
  // (POST) a esta URL → el setter lee el historial del contacto y escribe él solo.
  app.post('/api/webhooks/activar/:token', async (req, reply) => {
    const setter = await one(`SELECT * FROM setters WHERE activation_token = $1`, [req.params.token]);
    if (!setter) return reply.code(404).send({ error: 'activador desconocido' });
    reply.send({ ok: true });
    try {
      if (!setter.activation_enabled) {
        await logEvent('activador_deshabilitado', { setter: setter.id });
        return;
      }
      const p = (req.body && typeof req.body === 'object') ? req.body : {};
      const c = p.customData || p.custom_data || {};
      const contactId = p.contact_id || p.contactId || c.contact_id || p.contact?.id;
      if (!contactId) {
        await logEvent('activador_sin_contacto', { setter: setter.id, keys: Object.keys(p) });
        return;
      }
      const account = await one(`SELECT * FROM accounts WHERE id = $1`, [setter.account_id]);
      if (!account) return;
      // Alternativa avanzada (nodo Webhook). El contexto NO se acepta como texto libre: esta ruta se
      // autentica solo con el token (que viaja en URLs de workflows y logs de terceros), así que un
      // texto libre acabaría inyectando instrucciones en el prompt del agente. El workflow manda el
      // NOMBRE de la etiqueta y resolvemos su contexto desde la lista del setter, ya saneada.
      const tagPedida = String(c.tag || c.etiqueta || '').trim().toLowerCase();
      const lista = Array.isArray(setter.activation_tags) ? setter.activation_tags : [];
      const entrada = tagPedida ? lista.find((e) => String(e?.tag || '').trim().toLowerCase() === tagPedida) : null;
      await activateSetterForContact(
        account, setter, String(contactId),
        entrada ? Number(entrada.espera) || 0 : 0,
        entrada ? String(entrada.contexto || '') : '',
        entrada ? String(entrada.tag || '') : tagPedida
      );
    } catch (err) {
      console.error('[webhook activar]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  });

  app.post('/api/webhooks/workflow/:token', async (req, reply) => {
    const account = await one(`SELECT * FROM accounts WHERE webhook_token = $1`, [req.params.token]);
    if (!account) return reply.code(404).send({ error: 'token desconocido' });
    reply.send({ ok: true });

    try {
      const p = req.body || {};
      const custom = p.customData || p.custom_data || {};
      const contactId = custom.contact_id || p.contact_id || p.contactId || p.contact?.id;
      const body = custom.message || p.message?.body || (typeof p.message === 'string' ? p.message : '') || p.body || '';
      const channel = custom.channel || p.message?.type || p.channel || p.messageType || 'IG';
      if (!contactId || !String(body).trim()) {
        await logEvent('workflow_payload_incompleto', { account: account.id, keys: Object.keys(p) });
        return;
      }
      await logEvent('mensaje_recibido_workflow', { account: account.id, contactId, channel, body: String(body).slice(0, 200) });
      await handleInbound(account, {
        contactId: String(contactId),
        conversationId: null,
        channel,
        body: String(body),
        messageId: null,
        contactName: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name || '',
        hasAttachments: false,
      });
    } catch (err) {
      console.error('[webhook workflow]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  });
}
