import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { redis } from '../lib/redis.js';
import { debounceQueue, sendQueue, followupQueue } from '../queues.js';
import { generateReply } from './agent.js';
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

export async function cancelBotJobs(conversationId) {
  await redis.del(debKey(conversationId));
  await redis.del(fuKey(conversationId));
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

  const body = String(evt.body || '').trim() || (evt.hasAttachments ? '[el lead envió un adjunto]' : '');
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
     RETURNING *`,
    [account.id, evt.contactId, evt.conversationId || null, channel, evt.contactName || '']
  );

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
  const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
  const provider = account?.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [account.provider_id]) : null;
  const history = (
    await q(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 30`, [conversationId])
  ).reverse();
  return { conv, account, provider, history };
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

  const { conv, account, provider, history } = await loadContext(conversationId);
  if (!conv || !account) return;
  if (!account.bot_enabled || conv.bot_paused) return;
  if (!provider) {
    await logEvent('error_config', { conv: conv.id, msg: 'la cuenta no tiene proveedor de IA configurado' });
    return;
  }
  // nada nuevo que responder (el último mensaje ya es nuestro)
  const lastMsg = history[history.length - 1];
  if (!lastMsg || lastMsg.direction === 'outbound') return;

  const windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0) {
    await scheduleDebounce(account, conversationId, windowDelay);
    return;
  }

  const snapshotId = await lastInboundId(conversationId);
  let result;
  try {
    result = await generateReply({ account, provider, conversation: conv, history });
  } catch (err) {
    await logEvent('error_llm', { conv: conv.id, error: err.message });
    return;
  }

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

  const { conv, account, provider, history } = await loadContext(conversationId);
  if (!conv || !account || !provider) return;
  if (!account.bot_enabled || conv.bot_paused) return;

  const steps = Array.isArray(account.followups) ? account.followups : [];
  const step = conv.followup_step || 0;
  const stepConf = steps[step];
  if (!stepConf) return;

  // si el lead respondió después del último envío, el ciclo normal ya se encarga
  if (conv.last_inbound_at && conv.last_outbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) return;

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
    await logEvent('error_llm_followup', { conv: conv.id, error: err.message });
    return;
  }

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
