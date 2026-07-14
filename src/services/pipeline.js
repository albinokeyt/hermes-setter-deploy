import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { debounceQueue, sendQueue, followupQueue } from '../queues.js';
import { generateReply } from './agent.js';
import { describeImage, transcribeAudio } from './llm.js';
import * as ghl from './ghl.js';
import { typingDelayMs, delayToActiveWindow, metaWindowOpen } from './humanize.js';
import { STAGE_KEYS, WINDOWED_CHANNELS } from '../config.js';

// SMS y Live_Chat no tienen ventana de 24 h de Meta
function windowBlocked(conv) {
  return WINDOWED_CHANNELS.includes(conv.channel) && !metaWindowOpen(conv);
}

const TAG_PREFIX = 'setter-';

// Los jobs de debounce/seguimiento no se pueden "reemplazar" por jobId desde dentro
// de un job activo (BullMQ los deduplica). Usamos tokens de vigencia en Redis:
// cada programación escribe un token nuevo; los jobs viejos se despiertan, ven que
// su token ya no es el vigente y mueren en silencio.
const debKey = (id) => `debtoken:${id}`;
const fuKey = (id) => `futoken:${id}`;

export function normalizeChannel(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'IG' || s.includes('INSTAGRAM')) return 'IG';
  if (s.includes('WHATSAPP')) return 'WhatsApp';
  if (s === 'FB' || s.includes('FACEBOOK') || s.includes('MESSENGER')) return 'FB';
  if (s.includes('LIVE')) return 'Live_Chat';
  if (s.includes('SMS')) return 'SMS';
  return null;
}

export async function logEvent(kind, payload) {
  try {
    await q(`INSERT INTO webhook_log (kind, payload) VALUES ($1, $2)`, [kind, JSON.stringify(payload)]);
    await q(`DELETE FROM webhook_log WHERE id < (SELECT COALESCE(MAX(id),0) FROM webhook_log) - 2000`);
  } catch (err) {
    console.error('[log]', err.message);
  }
}

export async function accountByLocation(locationId) {
  return one(`SELECT * FROM accounts WHERE location_id = $1`, [locationId]);
}

// Recaudación de mensajes: interruptor global, cacheado. Funciona esté el bot
// activo o no. Si está apagada Y el bot también, no se guarda nada.
let _archiveCache = { at: 0, val: true };
export function invalidateArchiveCache() {
  _archiveCache = { at: 0, val: _archiveCache.val };
}
async function archiveEnabled() {
  if (Date.now() - _archiveCache.at < 30_000) return _archiveCache.val;
  const s = await getSetting('archive', { enabled: true });
  _archiveCache = { at: Date.now(), val: s?.enabled !== false };
  return _archiveCache.val;
}
// ¿guardamos este mensaje? Sí si la recaudación está activa, o si el bot lo necesita.
async function shouldCollect(account) {
  return (await archiveEnabled()) || Boolean(account.bot_enabled);
}

// ─── Adjuntos: imágenes (visión) y audios (transcripción) ───────────────────

function classifyMedia(url) {
  const clean = String(url).split('?')[0].toLowerCase();
  if (/\.(jpg|jpeg|png|webp|gif|bmp|heic)$/.test(clean)) return 'image';
  if (/\.(mp3|ogg|oga|opus|m4a|wav|amr|aac|mpeg|mp4|weba)$/.test(clean)) return 'audio';
  return 'other';
}

async function processAttachments(account, attachments, context) {
  const parts = [];
  for (const a of attachments.slice(0, 4)) {
    const url = typeof a === 'string' ? a : a?.url || a?.href || a?.link || '';
    if (!url) continue;
    const kind = classifyMedia(url);
    try {
      if (kind === 'image' && account.vision_enabled && account.vision_provider_id) {
        const provider = await one(`SELECT * FROM providers WHERE id = $1`, [account.vision_provider_id]);
        if (provider) {
          const r = await describeImage({ provider, model: account.vision_model || provider.default_model, imageUrl: url, context });
          parts.push(`[imagen recibida — ${r.text}]`);
          await recordUsage(account.id, null, provider, account.vision_model || provider.default_model, r.usage, 'vision');
          continue;
        }
      }
      if (kind === 'audio' && account.audio_enabled && account.audio_provider_id) {
        const provider = await one(`SELECT * FROM providers WHERE id = $1`, [account.audio_provider_id]);
        if (provider) {
          const r = await transcribeAudio({ provider, model: account.audio_model || provider.default_model, audioUrl: url });
          parts.push(`[nota de voz del lead, transcrita: "${r.text}"]`);
          continue;
        }
      }
      parts.push(kind === 'image' ? '[el lead envió una imagen]' : kind === 'audio' ? '[el lead envió una nota de voz]' : '[el lead envió un adjunto]');
    } catch (err) {
      await logEvent('error_media', { account: account.id, kind, error: err.message });
      parts.push(kind === 'image' ? '[el lead envió una imagen (no se pudo leer)]' : '[el lead envió un audio (no se pudo transcribir)]');
    }
  }
  return parts.join('\n');
}

// ─── Campañas de competencia: reparto de leads por peso ─────────────────────

async function pickVariant(account) {
  const campaign = await one(`SELECT * FROM campaigns WHERE account_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, [account.id]);
  if (!campaign) return null;
  const variants = await q(`SELECT * FROM campaign_variants WHERE campaign_id = $1`, [campaign.id]);
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight || 0), 0);
  if (!variants.length || total <= 0) return null;
  let r = Math.random() * total;
  for (const v of variants) {
    r -= Math.max(0, v.weight || 0);
    if (r <= 0) return { campaignId: campaign.id, variant: v };
  }
  return { campaignId: campaign.id, variant: variants[variants.length - 1] };
}

export async function cancelBotJobs(conversationId) {
  await redis.del(debKey(conversationId));
  await redis.del(fuKey(conversationId));
}

// Registra tokens y coste de cada llamada al LLM. OpenRouter devuelve el coste
// real (usage.cost, USD); para el resto se estima con los precios opcionales
// del proveedor ($ por 1M de tokens).
export async function recordUsage(accountId, conversationId, provider, model, usage, source, variantId = null) {
  if (!usage) return;
  try {
    const pt = Number(usage.prompt_tokens) || 0;
    const ct = Number(usage.completion_tokens) || 0;
    let cost = typeof usage.cost === 'number' ? usage.cost : null;
    if (cost === null && provider && (provider.price_in || provider.price_out)) {
      cost = (pt * Number(provider.price_in || 0) + ct * Number(provider.price_out || 0)) / 1_000_000;
    }
    await q(
      `INSERT INTO llm_usage (account_id, conversation_id, variant_id, model, prompt_tokens, completion_tokens, cost_usd, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, conversationId, variantId, model || '', pt, ct, cost, source]
    );
  } catch (err) {
    console.error('[usage]', err.message);
  }
}

// ─── Entrada de mensajes del lead ────────────────────────────────────────────

export async function handleInbound(account, evt) {
  const channel = normalizeChannel(evt.channel);
  if (!channel) {
    await logEvent('canal_ignorado', { account: account.id, raw: evt.channel });
    return null;
  }
  const channels = Array.isArray(account.channels) ? account.channels : [];
  if (!channels.includes(channel)) return null;

  // recaudación desactivada y bot apagado → no guardamos nada (ni procesamos adjuntos)
  if (!(await shouldCollect(account))) return null;

  const textBody = String(evt.body || '').trim();
  const attachments = Array.isArray(evt.attachments) ? evt.attachments : [];
  let body = textBody;
  if (attachments.length) {
    const mediaText = await processAttachments(account, attachments, textBody);
    body = [textBody, mediaText].filter(Boolean).join('\n');
  }
  if (!body) return null;

  const conv = await one(
    `INSERT INTO conversations (account_id, ghl_contact_id, ghl_conversation_id, channel, lead_name, last_inbound_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET
       ghl_conversation_id = COALESCE(EXCLUDED.ghl_conversation_id, conversations.ghl_conversation_id),
       lead_name = CASE WHEN conversations.lead_name = '' THEN EXCLUDED.lead_name ELSE conversations.lead_name END,
       last_inbound_at = now(),
       followup_step = 0,
       followup_state = 'ninguno',
       updated_at = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [account.id, evt.contactId, evt.conversationId || null, channel, evt.contactName || '']
  );

  // lead nuevo + campaña activa → se delega a un agente de la competencia por peso
  if (conv.is_new && !conv.variant_id) {
    const pick = await pickVariant(account);
    if (pick) {
      await q(`UPDATE conversations SET campaign_id = $1, variant_id = $2 WHERE id = $3`, [pick.campaignId, pick.variant.id, conv.id]);
      conv.variant_id = pick.variant.id;
      conv.campaign_id = pick.campaignId;
      if (pick.variant.debounce_seconds) account = { ...account, debounce_seconds: pick.variant.debounce_seconds };
      await logEvent('lead_asignado_campana', { conv: conv.id, campana: pick.campaignId, agente: pick.variant.name });
    }
  }

  if (evt.messageId) {
    const inserted = await one(
      `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id)
       VALUES ($1, 'inbound', 'lead', $2, $3)
       ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [conv.id, body, evt.messageId]
    );
    if (!inserted) return conv; // duplicado (reintento de GHL)
  } else {
    await q(`INSERT INTO messages (conversation_id, direction, source, body) VALUES ($1, 'inbound', 'lead', $2)`, [conv.id, body]);
  }

  await redis.del(fuKey(conv.id)); // el lead respondió → se cancela la cadena de seguimientos

  if (!conv.lead_name && (account.location_id || account.pit_token)) {
    ghl.getContact(account, evt.contactId)
      .then((c) => {
        const name = [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.name || c?.contactName || '';
        if (name) return q(`UPDATE conversations SET lead_name = $1 WHERE id = $2`, [name, conv.id]);
      })
      .catch(() => {});
  }

  if (account.bot_enabled && !conv.bot_paused) {
    await scheduleDebounce(account, conv.id);
  }
  return conv;
}

export async function scheduleDebounce(account, conversationId, delayMs = null) {
  const token = crypto.randomUUID();
  await redis.set(debKey(conversationId), token, 'EX', 60 * 60 * 24 * 3);
  const delay = delayMs ?? Math.max(5, account.debounce_seconds || 35) * 1000;
  await debounceQueue.add('debounce', { conversationId, token }, { delay });
}

// ─── Mensajes salientes vistos por webhook (humano u otra automatización) ────

export async function handleOutboundEvent(account, evt) {
  if (evt.messageId && (await redis.get(`sent:${evt.messageId}`))) return; // lo enviamos nosotros
  if (!(await shouldCollect(account))) return; // recaudación off + bot off
  const channel = normalizeChannel(evt.channel);
  if (!channel) return;
  const conv = await one(
    `SELECT * FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 AND channel = $3`,
    [account.id, evt.contactId, channel]
  );
  if (!conv) return;

  const body = String(evt.body || '').trim();
  if (body) {
    await one(
      `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id)
       VALUES ($1, 'outbound', 'humano', $2, $3)
       ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING RETURNING id`,
      [conv.id, body, evt.messageId || null]
    );
    await q(`UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
  }

  // Solo pausamos si lo escribió una persona desde GHL (userId presente)
  if (evt.userId && account.auto_handoff && !conv.bot_paused) {
    await q(`UPDATE conversations SET bot_paused = true, updated_at = now() WHERE id = $1`, [conv.id]);
    await cancelBotJobs(conv.id);
    await logEvent('handoff_humano', { conversation: conv.id, userId: evt.userId });
  }
}

// ─── Citas del calendario (AppointmentCreate / Update / Delete) ─────────────

export async function handleAppointmentEvent(account, type, p) {
  const appt = p.appointment || p;
  const ghlId = appt.id || p.appointmentId || null;
  const contactId = String(appt.contactId || p.contactId || '');
  const statusRaw = String(appt.appointmentStatus || appt.status || '').toLowerCase();
  const cancelled = type === 'AppointmentDelete' || ['cancelled', 'canceled', 'noshow', 'no_show', 'invalid'].includes(statusRaw);
  const status = cancelled ? 'cancelado' : 'agendado';
  const startTime = appt.startTime || appt.start_time || null;

  const conv = contactId
    ? await one(
        `SELECT * FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 ORDER BY updated_at DESC LIMIT 1`,
        [account.id, contactId]
      )
    : null;

  if (ghlId) {
    await q(
      `INSERT INTO appointments (account_id, conversation_id, ghl_appointment_id, ghl_contact_id, calendar_id, title, status, start_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL DO UPDATE SET
         status = EXCLUDED.status,
         start_time = COALESCE(EXCLUDED.start_time, appointments.start_time),
         conversation_id = COALESCE(appointments.conversation_id, EXCLUDED.conversation_id),
         updated_at = now()`,
      [account.id, conv?.id || null, String(ghlId), contactId, appt.calendarId || null, appt.title || '', status, startTime]
    );
  } else {
    await q(
      `INSERT INTO appointments (account_id, conversation_id, ghl_contact_id, calendar_id, title, status, start_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [account.id, conv?.id || null, contactId, appt.calendarId || null, appt.title || '', status, startTime]
    );
  }

  if (conv) {
    await applyStage(conv, account, cancelled ? 'agenda_cancelada' : 'agendado',
      cancelled ? 'cita cancelada en el calendario de GHL' : 'cita agendada en el calendario de GHL');
    if (!cancelled) await redis.del(fuKey(conv.id)); // ya agendó: fuera seguimientos pendientes
  }
  await logEvent(cancelled ? 'cita_cancelada' : 'cita_agendada', {
    account: account.id, contactId, appointmentId: ghlId, startTime, statusRaw, tipo: type,
  });
}

// ─── Etiquetas ───────────────────────────────────────────────────────────────

export async function applyStage(conv, account, newStage, reason, syncGhl = true) {
  if (!STAGE_KEYS.includes(newStage) || conv.stage === newStage) return conv.stage;
  await q(`UPDATE conversations SET stage = $1, updated_at = now() WHERE id = $2`, [newStage, conv.id]);
  await q(`INSERT INTO stage_history (conversation_id, from_stage, to_stage, reason) VALUES ($1, $2, $3, $4)`, [
    conv.id, conv.stage, newStage, reason || '',
  ]);
  if (syncGhl && account.sync_tags && (account.location_id || account.pit_token)) {
    const oldTag = TAG_PREFIX + conv.stage;
    const newTag = TAG_PREFIX + newStage;
    ghl.addTags(account, conv.ghl_contact_id, [newTag]).catch((e) => logEvent('error_tags', { conv: conv.id, e: e.message }));
    ghl.removeTags(account, conv.ghl_contact_id, [oldTag]).catch(() => {});
  }
  return newStage;
}

// ─── Generación y envío ──────────────────────────────────────────────────────

async function loadContext(conversationId) {
  const conv = await one(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
  if (!conv) return {};
  let account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
  let variantId = null;
  // si el lead está en una campaña, el "cerebro" (prompt, modelo, seguimientos) es el del agente asignado
  if (conv.variant_id && account) {
    const v = await one(`SELECT * FROM campaign_variants WHERE id = $1`, [conv.variant_id]);
    if (v) {
      variantId = v.id;
      // el agente aporta su cerebro; lo que no defina (proveedor, modelo, seguimientos)
      // hereda de la cuenta para nunca dejar al lead sin respuesta.
      account = {
        ...account,
        prompt_identity: v.prompt_identity, prompt_business: v.prompt_business, prompt_flow: v.prompt_flow,
        provider_id: v.provider_id || account.provider_id,
        model: v.model || account.model,
        temperature: v.temperature,
        max_msgs: v.max_msgs, debounce_seconds: v.debounce_seconds,
        followups: Array.isArray(v.followups) && v.followups.length ? v.followups : account.followups,
      };
    }
  }
  const provider = account?.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [account.provider_id]) : null;
  const history = (
    await q(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 30`, [conversationId])
  ).reverse();
  return { conv, account, provider, history, variantId };
}

// Modo test: el bot solo responde a contactos de GHL que tengan la etiqueta de prueba.
// Se consulta el contacto en GHL (con caché de 60 s) y ante cualquier duda NO se responde.
async function allowedByTestMode(account, conv) {
  if (!account.test_mode) return true;
  const tag = String(account.test_tag || 'hermes-test').trim().toLowerCase();
  if (!tag) return true;
  const cacheKey = `testtag:${conv.account_id}:${conv.ghl_contact_id}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return cached === '1';
  let ok = false;
  try {
    const contact = await ghl.getContact(account, conv.ghl_contact_id);
    const tags = Array.isArray(contact?.tags) ? contact.tags.map((t) => String(t).trim().toLowerCase()) : [];
    ok = tags.includes(tag);
  } catch (err) {
    await logEvent('error_test_tag', { conv: conv.id, error: err.message });
  }
  await redis.setex(cacheKey, 60, ok ? '1' : '0');
  return ok;
}

async function lastInboundId(conversationId) {
  const row = await one(
    `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'inbound' ORDER BY id DESC LIMIT 1`,
    [conversationId]
  );
  return row?.id || 0;
}

// Consume el token de debounce de forma atómica: solo UNA ejecución puede
// comprometerse a enviar, aunque dos jobs pasaran la comprobación inicial.
async function consumeDebounceToken(conversationId, token) {
  const script = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]) return 1 else return 0 end`;
  return (await redis.eval(script, 1, debKey(conversationId), token)) === 1;
}

export async function processDebounce(job) {
  const { conversationId, token } = job.data;
  if (token && token !== (await redis.get(debKey(conversationId)))) return; // job viejo

  const { conv, account, provider, history, variantId } = await loadContext(conversationId);
  if (!conv || !account) return;
  if (!account.bot_enabled || conv.bot_paused) return;
  if (!provider) {
    await logEvent('error_config', { conv: conv.id, msg: 'la cuenta o el agente no tiene proveedor de IA configurado' });
    return;
  }
  // nada nuevo que responder (el último mensaje ya es nuestro)
  const lastMsg = history[history.length - 1];
  if (!lastMsg || lastMsg.direction === 'outbound') return;

  if (!(await allowedByTestMode(account, conv))) {
    await logEvent('test_mode_omitido', { conv: conv.id, contacto: conv.ghl_contact_id, tag: account.test_tag });
    return;
  }

  const windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0) {
    await scheduleDebounce(account, conversationId, windowDelay);
    return;
  }

  const snapshotId = await lastInboundId(conversationId);
  let result;
  try {
    result = await generateReply({ account, provider, conversation: conv, history });
    await redis.del(`llmretry:${conversationId}`);
  } catch (err) {
    // el LLM ya reintentó 3 veces por dentro; si aun así falla, reprogramamos
    // el ciclo completo hasta 2 veces más — el lead no se queda sin respuesta
    const retries = await redis.incr(`llmretry:${conversationId}`);
    await redis.expire(`llmretry:${conversationId}`, 900);
    if (retries <= 2) {
      await logEvent('error_llm_reintentando', { conv: conv.id, intento: retries, error: err.message });
      await scheduleDebounce(account, conversationId, 45_000);
    } else {
      await redis.del(`llmretry:${conversationId}`);
      await logEvent('error_llm', { conv: conv.id, error: err.message, nota: 'agotados los reintentos' });
    }
    return;
  }
  await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, 'reply', variantId);

  // ¿escribió algo nuevo mientras pensábamos? → re-debounce, no enviamos nada
  if ((await lastInboundId(conversationId)) !== snapshotId) {
    await scheduleDebounce(account, conversationId);
    return;
  }
  if (token && !(await consumeDebounceToken(conversationId, token))) return; // otra ejecución ganó

  if (Object.keys(result.memoria).length) {
    await q(`UPDATE conversations SET memory = memory || $1::jsonb, updated_at = now() WHERE id = $2`, [
      JSON.stringify(result.memoria), conv.id,
    ]);
  }
  if (result.etiqueta) await applyStage(conv, account, result.etiqueta, result.motivo);

  let cursor = 0;
  for (let i = 0; i < result.mensajes.length; i++) {
    cursor += typingDelayMs(result.mensajes[i], i);
    // bypassPause: los mensajes de despedida del handoff deben salir aunque el bot ya esté en pausa
    await sendQueue.add(
      'send',
      { conversationId, body: result.mensajes[i], snapshotId, source: 'bot', bypassPause: result.handoff },
      { delay: cursor }
    );
  }

  if (result.handoff) {
    await q(`UPDATE conversations SET bot_paused = true, updated_at = now() WHERE id = $1`, [conv.id]);
    await redis.del(fuKey(conv.id));
    await logEvent('handoff_ia', { conv: conv.id, motivo: result.motivo });
  } else if (result.etiqueta === 'descartado') {
    // lead descartado: no programamos seguimientos ni lo perseguimos
    await redis.del(fuKey(conv.id));
  } else {
    await scheduleNextFollowup(account, { ...conv, followup_step: 0 }, cursor);
  }
}

export async function processSend(job) {
  const { conversationId, body, snapshotId, source, bypassPause } = job.data;

  // idempotencia: sendQueue reintenta (attempts: 2); si ya enviamos en el intento
  // anterior y falló solo la contabilidad, no volvemos a mandar el mensaje al lead
  const sentKey = `sentjob:${job.id}`;
  if (await redis.get(sentKey)) return;

  const { conv, account } = await loadContext(conversationId);
  if (!conv || !account) return;
  if ((conv.bot_paused && !bypassPause) || !account.bot_enabled) return;
  if (snapshotId && (await lastInboundId(conversationId)) !== snapshotId) return; // el lead volvió a escribir
  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    return;
  }
  const res = await ghl.sendMessage(account, { channel: conv.channel, contactId: conv.ghl_contact_id, message: body });
  await redis.setex(sentKey, 3600, '1').catch(() => {});
  try {
    const ghlMessageId = res?.messageId || null;
    if (ghlMessageId) await redis.setex(`sent:${ghlMessageId}`, 86400, '1');
    await q(
      `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id) VALUES ($1, 'outbound', $2, $3, $4)
       ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING`,
      [conv.id, source || 'bot', body, ghlMessageId]
    );
    await q(`UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
  } catch (err) {
    // el mensaje YA salió: no relanzamos el job por un fallo de contabilidad
    await logEvent('error_contabilidad_envio', { conv: conv.id, error: err.message }).catch(() => {});
  }
}

// ─── Seguimientos ────────────────────────────────────────────────────────────

export async function scheduleNextFollowup(account, conv, extraMs = 0) {
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const next = steps[conv.followup_step || 0];
  if (!next || !next.hours) return;
  const token = crypto.randomUUID();
  await redis.set(fuKey(conv.id), token, 'EX', 60 * 60 * 24 * 30);
  const delay = extraMs + Number(next.hours) * 3_600_000;
  await followupQueue.add('followup', { conversationId: conv.id, token }, { delay });
}

async function rearmFollowup(conversationId, delayMs) {
  const token = crypto.randomUUID();
  await redis.set(fuKey(conversationId), token, 'EX', 60 * 60 * 24 * 30);
  await followupQueue.add('followup', { conversationId, token }, { delay: delayMs });
}

export async function processFollowup(job) {
  const { conversationId, token } = job.data;
  if (token && token !== (await redis.get(fuKey(conversationId)))) return; // cancelado o reprogramado

  const { conv, account, provider, history, variantId } = await loadContext(conversationId);
  if (!conv || !account || !provider) return;
  if (!account.bot_enabled || conv.bot_paused) return;

  if (conv.stage === 'descartado') return; // lead descartado: cortar la cadena
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const step = conv.followup_step || 0;
  const stepConf = steps[step];
  if (!stepConf) return;

  // si el lead respondió después del último envío, el ciclo normal ya se encarga
  if (conv.last_inbound_at && conv.last_outbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) return;

  if (!(await allowedByTestMode(account, conv))) return;

  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    return;
  }
  const windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0) {
    await rearmFollowup(conversationId, windowDelay);
    return;
  }

  const snapshotId = await lastInboundId(conversationId);
  let result;
  try {
    result = await generateReply({
      account: { ...account, max_msgs: Math.min(account.max_msgs || 2, 2) },
      provider,
      conversation: conv,
      history,
      followupInstruction: stepConf.instruction || 'Retoma la conversación de forma breve y amable.',
      followupNumber: step + 1,
    });
  } catch (err) {
    const retries = await redis.incr(`furetry:${conversationId}`);
    await redis.expire(`furetry:${conversationId}`, 900);
    if (retries <= 2) {
      await logEvent('error_llm_followup_reintentando', { conv: conv.id, intento: retries, error: err.message });
      await rearmFollowup(conversationId, 60_000);
    } else {
      await redis.del(`furetry:${conversationId}`);
      await logEvent('error_llm_followup', { conv: conv.id, error: err.message, nota: 'agotados los reintentos' });
    }
    return;
  }
  await redis.del(`furetry:${conversationId}`);
  await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, 'seguimiento', variantId);

  // ¿el lead respondió mientras generábamos? → el ciclo normal (debounce) responde; este seguimiento sobra
  if ((await lastInboundId(conversationId)) !== snapshotId) return;

  let cursor = 0;
  for (let i = 0; i < result.mensajes.length; i++) {
    cursor += typingDelayMs(result.mensajes[i], i);
    await sendQueue.add('send', { conversationId, body: result.mensajes[i], snapshotId, source: 'seguimiento' }, { delay: cursor });
  }

  const newStep = step + 1;
  await q(`UPDATE conversations SET followup_step = $1, followup_state = $2, updated_at = now() WHERE id = $3`, [
    newStep, `enviado_${newStep}`, conv.id,
  ]);
  if (!['calificado', 'en_conversion', 'descartado'].includes(conv.stage)) {
    await applyStage(conv, account, 'en_seguimiento', `seguimiento #${newStep} enviado`);
  }
  await scheduleNextFollowup(account, { ...conv, followup_step: newStep }, cursor);
}
