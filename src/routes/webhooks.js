import crypto from 'node:crypto';
import { one, q, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, GHL_ED25519_KEY, GHL_RSA_KEY } from '../config.js';
import { handleInbound, handleOutboundEvent, handleAppointmentEvent, accountByLocation, logEvent, activateSetterForContact, guardarContextoCta, limpiarContextoCta } from '../services/pipeline.js';
import { tagsDeLeadMagnet } from '../lib/tags.js';

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
    const account = await one(`SELECT id FROM accounts WHERE location_id = $1 ORDER BY ai_enabled DESC, bot_enabled DESC, id ASC LIMIT 1`, [loc]);
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
// Normaliza una etiqueta para compararla: minúsculas, SIN tildes y con los espacios internos
// colapsados. «cta élite», «CTA  Elite» y «cta elite» son la misma etiqueta para el negocio; antes
// una tilde de más en el panel dejaba muda una campaña entera y el rastro decía «sin coincidir».
const normTag = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function handleTagActivation(account, p) {
  const contactId = String(p.id || p.contact_id || p.contactId || p.contact?.id || '');
  // ¿el payload trae DE VERDAD la lista de etiquetas? (para no confundir "sin lista" con "sin la etiqueta")
  const tagsArray = Array.isArray(p.tags) ? p.tags : (Array.isArray(p.contact?.tags) ? p.contact.tags : null);
  const tags = (tagsArray || []).map(normTag).filter(Boolean);
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
      const tag = normTag(e?.tag);
      if (!tag) continue;
      entradas.push({ setter: s, tag, tagOriginal: String(e?.tag || ''), contexto: String(e?.contexto || ''), espera: Number(e?.espera) || 0 });
    }
  }
  // un lead magnet puede llegar por varias etiquetas (la del CTA del comentario, la de la portada…)
  const lms = (Array.isArray(account.lead_magnets) ? account.lead_magnets : []).filter((l) => l && tagsDeLeadMagnet(l).length);
  const lmPorTag = new Map(lms.flatMap((l) => tagsDeLeadMagnet(l).map((t) => [t, l])));
  // Sin etiquetas activadoras NI lead magnets configurados → no hay nada que hacer (ni foto que guardar).
  // No registramos nada para no inundar la traza (ContactTagUpdate salta con CADA cambio de etiqueta).
  if (!entradas.length && !lms.length) return;

  // Qué etiquetas se acaban de AÑADIR: se compara con la última foto del contacto (Redis, 30 días).
  // ContactTagUpdate salta con cualquier cambio y no dice cuál fue; sin esto, con dos etiquetas
  // activadoras puestas ganaba «la última de la lista del panel», no la recién puesta, y el setter
  // podía entrar hablando del lead magnet equivocado. anadidas === null → no había foto (1er evento).
  const fotoKey = `tagset:${account.id}:${contactId}`;
  let anadidas = null;
  if (contactId && tagsArray) {
    const prevRaw = await redis.get(fotoKey).catch(() => null);
    if (prevRaw) { try { const prev = new Set(JSON.parse(prevRaw)); anadidas = new Set(tags.filter((t) => !prev.has(t))); } catch { anadidas = null; } }
    await redis.set(fotoKey, JSON.stringify(tags), 'EX', 30 * 86400).catch(() => {});
  }

  // Ficha de un lead magnet como contexto de conversación: QUÉ pidió, no una orden de entrada.
  const fichaLm = (l) => [
    l.name ? `El lead pidió «${l.name}»${l.keyword ? ` (comentó «${l.keyword}»)` : ''}.` : '',
    l.promise, l.details,
  ].filter(Boolean).join(' ').slice(0, 1500);

  // 📚 Etiquetas de LEAD MAGNET (pestaña «Lead magnets» de la conexión): si al contacto le acaban de
  // poner la etiqueta de un lead magnet, se guarda como contexto del CTA de su conversación SIN
  // entrada proactiva (esa la deciden solo las etiquetas activadoras). Es lo que hace que «cta ciencia»
  // deje al setter sabiendo qué pidió el lead aunque nadie configure una activación para esa etiqueta.
  // Con foto previa, solo cuenta la RECIÉN puesta; sin foto (primer evento del contacto), la última
  // que case pero SOLO si la conversación aún no tiene CTA (no pisar uno más nuevo con uno viejo).
  if (contactId && tagsArray && lms.length) {
    // pares (etiqueta, lead magnet) que el contacto lleva, en el orden del catálogo
    const candidatos = lms.flatMap((l) => tagsDeLeadMagnet(l).filter((t) => tags.includes(t)).map((t) => ({ t, l })));
    const recienLm = anadidas ? candidatos.filter((c) => anadidas.has(c.t)) : [];
    const par = recienLm[recienLm.length - 1] || (anadidas ? null : candidatos[candidatos.length - 1]);
    if (par) {
      await guardarContextoCta(account, contactId, par.t, fichaLm(par.l), { soloSiVacio: !recienLm.length })
        .catch((err) => logEvent('error_contexto_cta', { contactId, error: String(err.message).slice(0, 120) }));
      await logEvent('contexto_lead_magnet', { account: account.id, contactId, etiqueta: par.t, nombre: par.l.name || '', recien_puesta: recienLm.length > 0 });
    }
  }
  if (!entradas.length) return;

  const evaluados = [];
  // Un setter entra UNA sola vez por evento; si varias de sus etiquetas casan a la vez, prevalece la
  // RECIÉN puesta (o la última de la lista si no hay foto previa). Entre eventos distintos, la más
  // nueva también gana porque activateSetterForContact reescribe la activación pendiente.
  const frescasPorSetter = new Map(); // setterId -> { setter, list: [entradas frescas] }
  if (contactId) {
    for (const en of entradas) {
      const s = en.setter;
      const dedupe = `tagact:${s.id}:${en.tag}:${contactId}`;
      // clave con la grafía ANTERIOR al despliegue (sin normalizar tildes ni espacios): si existe, ya disparó
      const legacy = `tagact:${s.id}:${en.tagOriginal.trim().toLowerCase()}:${contactId}`;
      if (tags.includes(en.tag)) {
        if (legacy !== dedupe && (await redis.exists(legacy).catch(() => 0))) { evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'ya_activado' }); continue; }
        const fresh = await redis.set(dedupe, '1', 'EX', 86400, 'NX');
        if (!fresh) { evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'ya_activado' }); continue; }
        if (!frescasPorSetter.has(s.id)) frescasPorSetter.set(s.id, { setter: s, list: [] });
        frescasPorSetter.get(s.id).list.push(en);
      } else {
        // SOLO si el payload trae la lista real y la etiqueta no está → resetear (re-añadido re-dispara)
        // y, si era el CTA vigente de la conversación, olvidarlo (le quitaron la etiqueta a propósito).
        // Si el payload venía sin lista (parcial), NO tocamos nada (evita doble activación).
        if (tagsArray) {
          await redis.del(dedupe); await redis.del(legacy).catch(() => {});
          await limpiarContextoCta(account, contactId, en.tag).catch(() => {});
        }
        evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'sin_coincidir' });
      }
    }
    for (const { setter: s, list } of frescasPorSetter.values()) {
      const recien = anadidas ? list.filter((en) => anadidas.has(en.tag)) : [];
      // Con foto previa y NINGUNA activadora recién puesta, el evento lo provocó otra etiqueta: no se
      // entra ni se pisa el contexto, y se sueltan los candados recién cogidos para que un añadido
      // real sí dispare. Sin foto (primer evento del contacto), vale la última de la lista.
      if (anadidas && !recien.length) {
        for (const en of list) {
          await redis.del(`tagact:${s.id}:${en.tag}:${contactId}`).catch(() => {});
          evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'etiqueta_no_reciente' });
        }
        continue;
      }
      const elegida = recien.length ? recien[recien.length - 1] : list[list.length - 1];
      for (const en of list) if (en !== elegida) evaluados.push({ setter: s.id, nombre: s.name, etiqueta: en.tag, estado: 'omitida_por_otra_etiqueta' });
      await logEvent('activador_etiqueta', { account: account.id, setter: s.id, contactId, etiqueta: elegida.tag, con_contexto: Boolean(elegida.contexto.trim()), recien_puesta: recien.includes(elegida) });
      // 📌 El contexto del CTA se guarda en la conversación PASE LO QUE PASE con la entrada proactiva:
      // aunque se descarte (ventana de Meta cerrada, bot pausado, canal distinto), cuando el lead
      // escriba el setter sabrá qué pidió. Solo si la etiqueta ES un CTA: casa con un lead magnet o
      // lleva contexto escrito; una etiqueta operativa vacía (IF, reactivación) no se guarda como «pidió».
      const lm = lmPorTag.get(elegida.tag);
      if (lm || elegida.contexto.trim()) {
        const ctx = lm
          ? `${fichaLm(lm)}${elegida.contexto.trim() ? ` Instrucciones de entrada que llevaba la etiqueta: ${elegida.contexto.trim()}` : ''}`
          : elegida.contexto;
        await guardarContextoCta(account, contactId, elegida.tag, ctx, { setterId: s.id }).catch((err) => logEvent('error_contexto_cta', { contactId, error: String(err.message).slice(0, 120) }));
      }
      try {
        const estado = await activateSetterForContact(account, s, contactId, elegida.espera, elegida.contexto, elegida.tag);
        if (estado === 'apagado') {
          // IA o bot apagados: NO se quema la etiqueta 24 h (antes el panel decía «activó» y, al
          // encender el interruptor, esa etiqueta ya no volvía a disparar sobre ese contacto). Solo
          // vuelve a disparar con un añadido REAL de la etiqueta (arriba se exige «recién puesta»).
          await redis.del(`tagact:${s.id}:${elegida.tag}:${contactId}`).catch(() => {});
        }
        evaluados.push({ setter: s.id, nombre: s.name, etiqueta: elegida.tag, estado: estado || 'activado' });
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
    // Señales de ORIGEN de un saliente. GHL NO documenta un campo de origen, así que recogemos las
    // candidatas que pueda traer; se usan solo como evidencia POSITIVA de automatización.
    origen: p.source || p.origin || p.sentBy || p.createdBy || null,
    conversationProviderId: p.conversationProviderId || null,
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
      // Para los eventos de mensaje la clave es el messageId: identifica al MENSAJE, no a la
      // entrega. GHL puede reintentar la misma entrega con un webhookId NUEVO — con el webhookId
      // por delante, ese reintento se colaba y el setter respondía DOS VECES al mismo mensaje.
      const dedupeKey = (p.type === 'InboundMessage' || p.type === 'OutboundMessage')
        ? (p.messageId || p.webhookId)
        : (p.webhookId || p.messageId);
      if (dedupeKey) {
        const fresh = await redis.set(`wh:${dedupeKey}`, '1', 'EX', 172800, 'NX');
        if (!fresh) return; // reintento duplicado de GHL
      } else if ((p.type === 'InboundMessage' || p.type === 'OutboundMessage') && p.timestamp) {
        // Mensaje SIN ningún id: el timestamp del payload es el discriminador — un REINTENTO
        // repite el timestamp original (freshTimestamp lo acepta hasta 5 min), mientras que un
        // lead que repite «ok» de verdad genera un evento con timestamp NUEVO. 10 min de memoria.
        // Sin timestamp NO se aplica (la huella colapsaría mensajes legítimos idénticos): ese caso
        // lo cubre el candado corto por payload crudo del pipeline.
        const huella = crypto.createHash('md5')
          .update(`${p.type}|${p.locationId}|${p.contactId}|${String(p.body || '')}|${p.timestamp}`)
          .digest('hex');
        const fresh = await redis.set(`whts:${huella}`, '1', 'EX', 600, 'NX');
        if (!fresh) return; // reintento duplicado sin id
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
        // Diagnóstico del ORIGEN (solo salientes): GHL no documenta un campo que diga si lo mandó una
        // persona o un workflow. Guardamos las señales candidatas y la LISTA DE CAMPOS del payload
        // real, que es la única forma de descubrir cuál sirve mirando tráfico de verdad.
        ...(type === 'OutboundMessage' ? {
          userId: p.userId || null,
          source: p.source || null,
          conversationProviderId: p.conversationProviderId || null,
          status: p.status || null,
          contentType: p.contentType || null,
          campos: Object.keys(p || {}),
        } : {}),
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
      const tagPedida = normTag(c.tag || c.etiqueta || '');
      const lista = Array.isArray(setter.activation_tags) ? setter.activation_tags : [];
      let entrada = tagPedida ? lista.find((e) => normTag(e?.tag) === tagPedida) : null;
      // Si el workflow no manda la etiqueta (la UI ni lo menciona) o no casa, antes se activaba en
      // silencio SIN el contexto que el dueño escribió — parecía que sus instrucciones se ignoraban.
      // Si el setter tiene una sola etiqueta, usamos la suya; si no, dejamos traza para poder verlo.
      if (!entrada) {
        if (lista.length === 1) entrada = lista[0];
        await logEvent('activador_tag_no_casa', {
          setter: setter.id, pedida: tagPedida || null,
          disponibles: lista.map((e) => e?.tag).filter(Boolean),
          usada: entrada?.tag || null,
        });
      }
      // Mismo contexto persistente que el webhook de etiquetas: solo con una entrada saneada del panel
      // (nunca con tagPedida libre) y solo si lleva contexto escrito.
      if (entrada && String(entrada.contexto || '').trim()) {
        await guardarContextoCta(account, String(contactId), entrada.tag, String(entrada.contexto || ''), { setterId: setter.id })
          .catch((err) => logEvent('error_contexto_cta', { contactId: String(contactId), error: String(err.message).slice(0, 120) }));
      }
      const estado = await activateSetterForContact(
        account, setter, String(contactId),
        entrada ? Number(entrada.espera) || 0 : 0,
        entrada ? String(entrada.contexto || '') : '',
        entrada ? String(entrada.tag || '') : tagPedida
      );
      if (estado && estado !== 'activado') await logEvent('activador_webhook_no_activo', { setter: setter.id, contactId: String(contactId), estado });
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
