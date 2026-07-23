import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { debounceQueue, sendQueue, followupQueue, reactivateQueue } from '../queues.js';
import { generateReply, shouldFollowup } from './agent.js';
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
const ctaKey = (id) => `ctawait:${id}`; // instante (ms) hasta el que el setter espera por un CTA
const activarKey = (id) => `activar:${id}`; // activación externa pendiente (el setter escribe él solo)
const insFreshKey = (id) => `insfresh:${id}`; // pendiente de re-leer etiquetas frescas tras la inserción
const ctagsKey = (conv) => `ctags:${conv.account_id}:${conv.ghl_contact_id}`; // caché de etiquetas del contacto

export function normalizeChannel(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'IG' || s.includes('INSTAGRAM') || /(^|_)IG$/.test(s)) return 'IG'; // cubre TYPE_IG del historial

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
          await recordUsage(account.id, null, provider, account.vision_model || provider.default_model, r.usage, 'vision', null, account.setter_id || null);
          continue;
        }
      }
      if (kind === 'audio' && account.audio_enabled && account.audio_provider_id) {
        const provider = await one(`SELECT * FROM providers WHERE id = $1`, [account.audio_provider_id]);
        if (provider) {
          const audioModel = account.audio_model || provider.default_model;
          const r = await transcribeAudio({ provider, model: audioModel, audioUrl: url });
          parts.push(`[nota de voz del lead, transcrita: "${r.text}"]`);
          await recordUsage(account.id, null, provider, audioModel, r.usage, 'audio', null, account.setter_id || null);
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

// ─── Setters: varios bots por conexión, enrutados por etiqueta ───────────────

// Aplica el "cerebro" de un setter sobre la conexión (lo que el setter no defina, hereda).
export function mergeSetter(account, s) {
  if (!s) return account;
  return {
    ...account,
    setter_id: s.id,
    setter_name: s.name,
    // el interruptor de la conexión manda a nivel global; el del setter es individual
    bot_enabled: Boolean(account.bot_enabled && s.bot_enabled),
    prompt_identity: s.prompt_identity,
    prompt_business: s.prompt_business,
    prompt_flow: s.prompt_flow,
    provider_id: s.provider_id || account.provider_id,
    model: s.model || account.model,
    temperature: s.temperature,
    max_msgs: s.max_msgs,
    debounce_seconds: s.debounce_seconds,
    followups: Array.isArray(s.followups) && s.followups.length ? s.followups : account.followups,
    followup_ai_check: s.followup_ai_check !== false, // por defecto ON
    // modo test: el de la CONEXIÓN aplica a todos; el del setter solo a él (misma test_tag de la conexión)
    test_mode: Boolean(account.test_mode || s.test_mode),
    // canales de atención del setter (si no tiene, hereda los de la conexión — setters legacy)
    channels: Array.isArray(s.channels) && s.channels.length ? s.channels : account.channels,
    // tiempo de inserción: el del setter manda si lo tiene (>0); si no, el de la conexión
    insertion_wait_seconds: Number(s.insertion_wait_seconds) > 0 ? Number(s.insertion_wait_seconds) : (Number(account.insertion_wait_seconds) || 0),
    insertion_idle_hours: Number(s.insertion_idle_hours) > 0 ? Number(s.insertion_idle_hours) : (Number(account.insertion_idle_hours) || 0),
    // calendarios "agenda" del setter (sin respaldo: vacío = este setter no mide agendas)
    calendar_ids: Array.isArray(s.calendar_ids) ? s.calendar_ids : [],
    required_tags: s.required_tags,
    required_tags_mode: s.required_tags_mode,
    excluded_tags: s.excluded_tags, // filtro negativo del setter (exclude_tag sigue siendo de la conexión)
    // visión/audio SON del setter: se aplican al procesar los adjuntos con su config
    vision_enabled: s.vision_enabled,
    vision_provider_id: s.vision_provider_id,
    vision_model: s.vision_model,
    audio_enabled: s.audio_enabled,
    audio_provider_id: s.audio_provider_id,
    audio_model: s.audio_model,
  };
}

// ¿Este setter atiende este canal? Usa la lista EFECTIVA (los canales del setter, o los de la
// conexión si el setter no define ninguno) — la MISMA que aplica mergeSetter/allowedByTags, para que
// SELECCIÓN y RESPUESTA nunca discrepen (evita asignar-y-mutear). Si tampoco hay conexión: no filtra.
function servesChannel(s, channel, account) {
  const ch = (Array.isArray(s.channels) && s.channels.length)
    ? s.channels
    : (Array.isArray(account?.channels) ? account.channels : []);
  if (!ch.length) return true;
  return !channel || ch.includes(channel);
}

function setterMatches(s, tags) {
  const req = Array.isArray(s.required_tags) ? s.required_tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];
  if (!req.length) return true; // sin requisito de etiqueta → catch-all
  if (tags === null) return false; // no pudimos leer etiquetas → los que exigen no casan
  const mode = s.required_tags_mode === 'all' ? 'all' : 'any';
  return mode === 'all' ? req.every((t) => tags.includes(t)) : req.some((t) => tags.includes(t));
}

function pickByWeight(pool) {
  const total = pool.reduce((sum, s) => sum + Math.max(0, s.weight || 0), 0);
  if (total <= 0) return pool[0];
  let r = Math.random() * total;
  for (const s of pool) { r -= Math.max(0, s.weight || 0); if (r <= 0) return s; }
  return pool[pool.length - 1];
}

// Elige el setter que atiende a este lead: primero los de etiqueta específica que casan,
// si ninguno los catch-all (sin etiqueta), y como último recurso el setter por defecto.
// Entre varios elegibles, desempata por peso (la "batalla").
// Devuelve { setter, hasSetters }:
//   setter=<fila>          → ese setter atiende
//   setter=null,hasSetters → la conexión SÍ tiene setters pero ninguno aplica → no responder
//   setter=null,!hasSetters→ conexión sin setters (legacy) → usar config de la cuenta / campañas
// ¿Un versus activo gobierna esta conexión para este lead? Devuelve el setter elegido
// (repartido por peso entre los setters del versus que pertenecen a esta conexión),
// { defer:true } si depende de etiquetas que no se pudieron leer, o null si no aplica.
async function activeVersusFor(account, conv) {
  const vlist = await q(
    `SELECT v.id, v.audience, v.audience_tag
     FROM versus v
     WHERE v.status = 'active'
       AND EXISTS (SELECT 1 FROM versus_setters vs JOIN setters s ON s.id = vs.setter_id
                   WHERE vs.versus_id = v.id AND s.account_id = $1 AND s.bot_enabled)
     ORDER BY v.id DESC`,
    [account.id]
  );
  if (!vlist.length) return null;
  let tags = null, fetched = false, unresolvedTag = false;
  for (const v of vlist) {
    let matches = false;
    if (v.audience === 'all') {
      matches = true;
    } else {
      if (!fetched) { tags = await getContactTags(account, conv); fetched = true; }
      if (tags === null) { unresolvedTag = true; continue; } // no se pudo leer: probar los demás (un 'all' sí aplica)
      matches = tags.includes(String(v.audience_tag || '').trim().toLowerCase());
    }
    if (!matches) continue;
    const rows = await q(
      `SELECT s.*, vs.weight AS vweight FROM versus_setters vs JOIN setters s ON s.id = vs.setter_id
       WHERE vs.versus_id = $1 AND s.account_id = $2 AND s.bot_enabled AND s.test_mode = false ORDER BY s.id`,
      [v.id, account.id]
    );
    const cands = rows.filter((s) => servesChannel(s, conv.channel, account)); // solo setters que atienden este canal
    if (!cands.length) continue; // (si ninguno aplica —test/canal—, el versus no gobierna → ruta normal)
    return { versusId: v.id, setter: pickByWeight(cands.map((c) => ({ ...c, weight: c.vweight }))) };
  }
  // ninguno casó, pero había un versus por etiqueta que no pudimos evaluar → aplazar
  if (unresolvedTag) return { defer: true };
  return null;
}

async function selectSetter(account, conv) {
  const all = await q(`SELECT * FROM setters WHERE account_id = $1 ORDER BY id`, [account.id]);
  if (!all.length) return { setter: null, hasSetters: false };
  // Un versus activo manda sobre el enrutado normal (ignora las etiquetas del setter).
  const vr = await activeVersusFor(account, conv);
  if (vr?.defer) return { setter: null, hasSetters: true, defer: true };
  if (vr?.setter) return { setter: vr.setter, hasSetters: true, versusId: vr.versusId };
  // candidatos a leads NUEVOS: encendidos, que aceptan leads y que atienden ESTE canal
  const setters = all.filter((s) => s.bot_enabled && s.accepts_leads !== false && servesChannel(s, conv.channel, account));
  if (!setters.length) return { setter: null, hasSetters: true };
  // Atajo de un solo setter SOLO si no está en test; si lo está, pasa por el filtro de test de abajo
  // (para no asignarle un lead real y dejarlo mudo).
  if (setters.length === 1 && !setters[0].test_mode) return { setter: setters[0], hasSetters: true };
  const tags = await getContactTags(account, conv);
  const norm = (a) => (Array.isArray(a) ? a.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : []);
  const hasReq = (s) => norm(s.required_tags).length > 0;
  const hasExcl = (s) => norm(s.excluded_tags).length > 0;
  const generalExclude = String(account.exclude_tag || '').trim().toLowerCase();
  const anyTest = setters.some((s) => s.test_mode);
  // si dependemos de etiquetas y no se pudieron leer, aplazamos (no fijar asignación equivocada).
  if (tags === null && (generalExclude || anyTest || setters.some((s) => hasReq(s) || hasExcl(s)))) return { setter: null, hasSetters: true, defer: true };
  // exclusión general de la conexión → ningún setter responde
  if (generalExclude && tags && tags.includes(generalExclude)) return { setter: null, hasSetters: true };
  // Un setter en test SOLO capta leads de PRUEBA (con la etiqueta de test de la conexión). Los leads
  // reales NO se le asignan (irían a los setters vivos) para no quedarse mudos durante la prueba.
  const testTag = String(account.test_tag || 'hermes-test').trim().toLowerCase();
  const leadIsTest = Boolean(tags && testTag && tags.includes(testTag));
  const passesTest = (s) => !s.test_mode || leadIsTest;
  // fuera los que excluyen a este lead por sus etiquetas, y los setters en test para leads reales
  const cands = setters.filter((s) => passesTest(s) && !(hasExcl(s) && tags && norm(s.excluded_tags).some((t) => tags.includes(t))));
  if (!cands.length) return { setter: null, hasSetters: true };
  let pool = cands.filter((s) => hasReq(s) && setterMatches(s, tags));
  if (!pool.length) pool = cands.filter((s) => !hasReq(s));
  if (!pool.length) pool = cands.filter((s) => s.is_default);
  // Fuera de un versus el reparto es a partes iguales (el peso proporcional se usa en Versus).
  return { setter: pool.length ? pool[Math.floor(Math.random() * pool.length)] : null, hasSetters: true };
}

// CTAs: si el primer mensaje contiene una palabra/frase clave, el setter espera un
// plazo antes de entrar. Devuelve la espera en SEGUNDOS o null si no aplica.
// Casan primero las CTAs con keyword; una keyword vacía es el "cualquiera" (catch-all).
function matchCtaWait(account, body) {
  const ctas = Array.isArray(account.ctas) ? account.ctas : [];
  if (!ctas.length) return null;
  const text = String(body || '').toLowerCase();
  let catchAll = null;
  for (const c of ctas) {
    const kw = String(c?.keyword || '').trim().toLowerCase();
    const w = Number(c?.wait_seconds);
    if (!Number.isFinite(w) || w < 0) continue;
    if (!kw) { if (catchAll === null) catchAll = w; continue; }
    if (text.includes(kw)) return w;
  }
  return catchAll;
}

export async function cancelBotJobs(conversationId) {
  await redis.del(debKey(conversationId));
  await redis.del(fuKey(conversationId));
  await redis.del(reactKey(conversationId));
  // También la activación externa pendiente: si la dejamos, al reanudar el bot el SIGUIENTE mensaje
  // del lead se trataría como «activación» (saltándose modo test y etiquetas requeridas) y entraría
  // con el contexto de una etiqueta vieja.
  await redis.del(activarKey(conversationId));
}

// Invalida la caché de etiquetas del contacto (p. ej. tras excluir/incluir manualmente).
export async function invalidateContactTags(accountId, contactId) {
  await redis.del(`ctags:${accountId}:${contactId}`);
}

// Registra tokens y coste de cada llamada al LLM. OpenRouter devuelve el coste
// real (usage.cost, USD); para el resto se estima con los precios opcionales
// del proveedor ($ por 1M de tokens).
export async function recordUsage(accountId, conversationId, provider, model, usage, source, variantId = null, setterId = null) {
  if (!usage) return;
  try {
    // el audio reporta input_tokens/output_tokens; el chat prompt_tokens/completion_tokens
    const pt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    const ct = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
    // pg devuelve NUMERIC como string → normalizamos a número (>0) o null
    const numOr = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    let cost = typeof usage.cost === 'number' ? usage.cost : null;
    // el AUDIO no se cobra por tokens de texto: su estimación por tokens queda excluida
    // (los precios price_in/out son del CHAT; el audio usa su coste por minuto/transcripción)
    if (cost === null && source !== 'audio' && provider && (numOr(provider.price_in) || numOr(provider.price_out))) {
      cost = (pt * (numOr(provider.price_in) || 0) + ct * (numOr(provider.price_out) || 0)) / 1_000_000;
    }
    // audio/imagen se cobran distinto (por minuto/por imagen): si no hubo coste,
    // usa el coste plano editable del proveedor para esa unidad.
    if (cost === null && provider) {
      if (source === 'audio' && numOr(provider.price_audio_min)) cost = numOr(provider.price_audio_min);
      else if (source === 'vision' && numOr(provider.price_image)) cost = numOr(provider.price_image);
    }
    // FACTURADO al cliente: precio explícito del proveedor (por unidad o por 1M tokens de CHAT) o,
    // si no hay, margen % sobre el coste. Sin nada configurado → facturado = coste.
    let billed = null;
    if (provider) {
      const billIn = numOr(provider.bill_in);
      const billOut = numOr(provider.bill_out);
      if (source === 'vision' && numOr(provider.bill_image)) billed = numOr(provider.bill_image);
      else if (source === 'audio' && numOr(provider.bill_audio_min)) billed = numOr(provider.bill_audio_min);
      else if (source !== 'audio' && (billIn || billOut) && (pt || ct)) {
        billed = (pt * (billIn || 0) + ct * (billOut || 0)) / 1_000_000;
      } else if (Number(provider.markup_percent) > 0 && cost !== null) {
        billed = cost * (1 + Number(provider.markup_percent) / 100);
      }
    }
    if (billed === null) billed = cost;
    await q(
      `INSERT INTO llm_usage (account_id, conversation_id, variant_id, setter_id, model, prompt_tokens, completion_tokens, cost_usd, billed_usd, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [accountId, conversationId, variantId, setterId, model || '', pt, ct, cost, billed, source]
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
  // Los canales son POR SETTER (quién responde dónde se decide al enrutar/responder);
  // aquí se archiva todo canal conocido para que el cliente vea sus mensajes.

  // recaudación desactivada y bot apagado → no guardamos nada (ni procesamos adjuntos)
  if (!(await shouldCollect(account))) return null;

  const textBody = String(evt.body || '').trim();
  const attachments = Array.isArray(evt.attachments) ? evt.attachments : [];
  if (!textBody && !attachments.length) return null; // nada que procesar

  // Última actividad ANTES de esta entrada (el upsert de abajo pisa last_inbound_at), para saber si
  // el lead vuelve tras un periodo de inactividad y reaplicar el tiempo de inserción.
  const prevAct = await one(
    `SELECT GREATEST(COALESCE(last_inbound_at, 'epoch'::timestamptz), COALESCE(last_outbound_at, 'epoch'::timestamptz)) AS at
       FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 AND channel = $3`,
    [account.id, evt.contactId, channel]
  );

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

  // Enrutado al setter de la conexión que casa por etiqueta. Se reintenta mientras el
  // lead no tenga setter (por si se etiqueta más tarde). Si hay setters pero ninguno
  // aplica a este lead, NO se responde (respetar el filtro de etiquetas del setter).
  let respond = true;
  let recienAsignado = false; // el setter se fija EN esta llamada (1er mensaje o uno posterior)
  if (!conv.setter_id && account.ai_enabled) {
    const { setter, hasSetters, defer, versusId } = await selectSetter(account, conv);
    if (setter) {
      await q(`UPDATE conversations SET setter_id = $1, versus_id = $2 WHERE id = $3`, [setter.id, versusId || null, conv.id]);
      conv.setter_id = setter.id;
      conv.versus_id = versusId || null;
      account = mergeSetter(account, setter);
      recienAsignado = true;
      await logEvent('lead_asignado_setter', { conv: conv.id, setter: setter.id, nombre: setter.name, versus: versusId || null });
    } else if (defer) {
      respond = false; // no se pudieron leer etiquetas: no fijamos setter, se reintenta luego
    } else if (hasSetters) {
      respond = false;
      await logEvent('sin_setter_para_lead', { conv: conv.id, contacto: conv.ghl_contact_id });
    } else if (!conv.variant_id) {
      // legacy (conexión sin setters): reparto por campaña/variante antigua
      const pick = await pickVariant(account);
      if (pick) {
        await q(`UPDATE conversations SET campaign_id = $1, variant_id = $2 WHERE id = $3`, [pick.campaignId, pick.variant.id, conv.id]);
        conv.variant_id = pick.variant.id;
        conv.campaign_id = pick.campaignId;
        if (pick.variant.debounce_seconds) account = { ...account, debounce_seconds: pick.variant.debounce_seconds };
        await logEvent('lead_asignado_campana', { conv: conv.id, campana: pick.campaignId, agente: pick.variant.name });
      }
    }
  }

  // Conversación ya asignada (mensaje posterior): fusionar su setter para visión/audio/debounce.
  if (conv.setter_id && account.setter_id !== conv.setter_id) {
    const s = await one(`SELECT * FROM setters WHERE id = $1`, [conv.setter_id]);
    if (s) account = mergeSetter(account, s);
  }

  // Procesar adjuntos (imágenes/audio) con la config del SETTER. Si aún no hay setter
  // asignado (aplazado/legacy), se usa el setter principal de la conexión para leerlos.
  let body = textBody;
  if (attachments.length) {
    let ma = account;
    if (!ma.setter_id) {
      const def = await one(`SELECT * FROM setters WHERE account_id = $1 ORDER BY is_default DESC, id LIMIT 1`, [conv.account_id]);
      if (def) ma = mergeSetter(account, def);
    }
    const mediaText = await processAttachments(ma, attachments, textBody);
    body = [textBody, mediaText].filter(Boolean).join('\n');
  }
  if (!body) body = '[adjunto]';

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

  if ((!conv.lead_name || !conv.lead_email) && (account.location_id || account.pit_token)) {
    ghl.getContact(account, evt.contactId)
      .then((c) => {
        const name = [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.name || c?.contactName || '';
        const email = c?.email || '';
        if (name || email) {
          return q(
            `UPDATE conversations SET
               lead_name = CASE WHEN lead_name = '' THEN $1 ELSE lead_name END,
               lead_email = CASE WHEN lead_email = '' THEN $2 ELSE lead_email END
             WHERE id = $3`,
            [name, email, conv.id]
          );
        }
      })
      .catch(() => {});
  }

  if (respond && account.ai_enabled && account.bot_enabled && !conv.bot_paused) {
    // usar el debounce del setter asignado también en mensajes posteriores (el bloque de
    // arriba solo fusiona al asignar; aquí cubrimos la conversación ya asignada).
    if (conv.setter_id && account.setter_id !== conv.setter_id) {
      const s = await one(`SELECT * FROM setters WHERE id = $1`, [conv.setter_id]);
      if (s) account = mergeSetter(account, s);
    }
    // Espera antes de procesar. Se aplica al ENTRAR el lead (primer mensaje) o cuando vuelve tras un
    // periodo de inactividad: se retiene el mensaje unos segundos (tiempo de INSERCIÓN) para que las
    // etiquetas/automatizaciones de GHL asienten y las reglas de filtrado se validen luego con la info
    // completa. Un 🎯 CTA que case suma su propia espera (se toma la mayor). La activación por etiqueta
    // no pasa por aquí, así que salta esta espera por diseño.
    const insWait = Math.min(Math.max(0, Number(account.insertion_wait_seconds) || 0), 3600);
    const idleHours = Math.min(Math.max(0, Number(account.insertion_idle_hours) || 0), 720);
    const prevMs = prevAct?.at ? new Date(prevAct.at).getTime() : 0;
    const volvioTrasInactividad = insWait > 0 && idleHours > 0 && prevMs > 0 && (Date.now() - prevMs) >= idleHours * 3600_000;
    // También cuenta como "entrada" cuando el setter se acaba de asignar en esta llamada (el 1er
    // mensaje pudo no asignar por un hipo de GHL, y el setter se fija en el 2º): así la re-lectura
    // fresca de etiquetas también protege ese camino.
    const esEntrada = conv.is_new || volvioTrasInactividad || recienAsignado;

    let delayMs = null;
    if (esEntrada) {
      const ctaWait = matchCtaWait(account, body);
      const wait = Math.max(insWait, ctaWait || 0);
      if (wait > 0) {
        delayMs = wait * 1000;
        await redis.set(ctaKey(conv.id), String(Date.now() + delayMs), 'EX', wait + 300);
        await logEvent(insWait >= (ctaWait || 0) ? 'insercion_espera' : 'cta_espera', { conv: conv.id, segundos: wait, reaplicada: volvioTrasInactividad });
        // La espera de inserción existe para dar tiempo a que las etiquetas asienten: marcamos la
        // conversación para que, al procesar, se RE-LEAN las etiquetas frescas (la caché de etiquetas
        // dura 60 s y selectSetter la pobló con el estado ANTERIOR a la etiqueta).
        if (insWait > 0) await redis.set(insFreshKey(conv.id), '1', 'EX', wait + 120);
      }
    } else {
      // mensajes posteriores durante una espera en curso: respetar el mínimo que falta
      const target = Number(await redis.get(ctaKey(conv.id)));
      const remaining = target ? target - Date.now() : 0;
      if (remaining > 0) delayMs = Math.max(remaining, Math.max(5, account.debounce_seconds || 35) * 1000);
    }
    await scheduleDebounce(account, conv.id, delayMs);
  }
  return conv;
}

// ⚡ ACTIVADOR EXTERNO: un workflow de GHL (p. ej. al asignar una etiqueta) activa a ESTE setter
// para un contacto: importa el historial (entrantes y salientes) desde GHL, reclama la conversación
// y programa una respuesta proactiva (instrucción de activación en processDebounce).
export async function activateSetterForContact(account, setter, contactId, waitSeconds = 0, contexto = '') {
  const merged = mergeSetter(account, setter);
  if (!account.ai_enabled || !merged.bot_enabled) {
    await logEvent('activador_apagado', { setter: setter.id, contactId, ai: account.ai_enabled, bot: merged.bot_enabled });
    return;
  }
  // historial del contacto en GHL (si falla o no hay, se sigue con lo que tengamos local)
  let ghlHistory = { conversationId: null, messages: [], lastInboundAt: null };
  try {
    ghlHistory = await ghl.listContactMessages(account, contactId, 20);
  } catch (err) {
    await logEvent('activador_sin_historial', { setter: setter.id, contactId, error: String(err.message).slice(0, 200) });
  }
  const last = ghlHistory.messages[ghlHistory.messages.length - 1];
  const channel = normalizeChannel(last?.type) || (Array.isArray(merged.channels) && merged.channels[0]) || 'IG';

  const conv = await one(
    `INSERT INTO conversations (account_id, ghl_contact_id, ghl_conversation_id, channel, lead_name, updated_at)
     VALUES ($1, $2, $3, $4, '', now())
     ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET
       ghl_conversation_id = COALESCE(EXCLUDED.ghl_conversation_id, conversations.ghl_conversation_id),
       updated_at = now()
     RETURNING *`,
    [account.id, String(contactId), ghlHistory.conversationId, channel]
  );
  if (conv.bot_paused || conv.stage === 'atencion_humana') {
    await logEvent('activador_bloqueado', { conv: conv.id, setter: setter.id, motivo: conv.stage === 'atencion_humana' ? 'atencion_humana' : 'pausado' });
    return;
  }
  // la activación RECLAMA la conversación para este setter
  if (conv.setter_id !== setter.id) {
    await q(`UPDATE conversations SET setter_id = $1 WHERE id = $2`, [setter.id, conv.id]);
    conv.setter_id = setter.id;
  }
  // La activación toma el control: descartamos cualquier espera de inserción en curso de esta
  // conversación (ctaKey = instante objetivo, insFreshKey = re-lectura pendiente). Si no, un mensaje
  // posterior del lead se retendría hasta el target de inserción original aunque la activación ya respondió.
  // Invalidamos también la caché de etiquetas: la activación SÍ respeta el exclude_tag («sin-ia»), y su
  // debounce (≥3 s) debe re-leerlas frescas por si se añadió una justo al activar (no heredamos la
  // re-lectura del insFreshKey que acabamos de borrar).
  await redis.del(ctaKey(conv.id));
  await redis.del(insFreshKey(conv.id));
  await redis.del(ctagsKey(conv));

  // importar el historial que no tengamos (con fecha real y sin duplicar/re-etiquetar los propios)
  await saveGhlMessages(conv, ghlHistory.messages);

  // La conversación puede nacer AQUÍ (todo su historial viene de GHL, no de un webhook entrante), y
  // entonces last_inbound_at quedaría NULL → windowBlocked daría "cerrada" SIEMPRE en IG/FB/WhatsApp
  // y el setter no llegaría a escribir nunca. Lo fijamos con la fecha REAL del último entrante que
  // trajimos (nunca now(): falsear la ventana de 24 h de Meta sería mentirle a la política).
  // lastInboundAt lo calcula ghl.listContactMessages sobre los mensajes CRUDOS (incluye los que solo
  // llevan adjuntos, que el filtro por texto descarta) y solo con el dateAdded real de GHL.
  const fechaEntrante = ghlHistory.lastInboundAt ? new Date(ghlHistory.lastInboundAt) : null;
  if (fechaEntrante && !Number.isNaN(fechaEntrante.getTime())) {
    await q(
      `UPDATE conversations SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, 'epoch'::timestamptz), $2::timestamptz)
        WHERE id = $1`,
      [conv.id, fechaEntrante.toISOString()]
    );
  }
  // El valor guarda el CONTEXTO de esta activación (por qué la etiqueta lo activó ahora), para que
  // processDebounce se lo pase a la IA. '1' = activación sin contexto (comportamiento por defecto).
  // TTL HOLGADO y por encima de la espera: si caduca antes de que corra el debounce, la activación
  // se perdería en silencio (y con espera=3600 caducaba justo al ejecutarse).
  const ttlActivar = Math.max(86400, (Number(waitSeconds) || 0) * 2 + 3600);
  await redis.set(activarKey(conv.id), String(contexto || '').trim().slice(0, 1500) || '1', 'EX', ttlActivar);
  await logEvent('activador_externo', { conv: conv.id, setter: setter.id, contactId, canal: channel, mensajes_importados: ghlHistory.messages.length, espera_s: waitSeconds });
  // espera configurable tras la etiqueta antes de que el setter entre (mín. 3 s para que no sea instantáneo)
  const delayMs = Math.max(3, Math.min(Number(waitSeconds) || 0, 3600)) * 1000;
  await scheduleDebounce(merged, conv.id, delayMs);
}

// Guarda en `messages` los mensajes traídos de GHL (entrantes y salientes) que falten, dedupe por
// ghl_message_id, preservando su fecha real y sin duplicar/re-etiquetar los que ya teníamos.
// Recibe los mensajes ya traídos (no vuelve a llamar a GHL). Devuelve cuántos insertó de nuevo.
async function saveGhlMessages(conv, messages) {
  let imported = 0;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m.id) continue;
    try {
      // Fecha REAL del mensaje en GHL (para ordenar cronológico, no por id de inserción).
      const t = m.dateAdded ? new Date(m.dateAdded) : null;
      const when = t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;

      // (B) ¿ya teníamos ESTE mensaje guardado sin ghl_message_id? (bot cuando GHL no devolvió
      // messageId, inbound de la ruta workflow-token, etc.) → lo ENLAZAMOS conservando su source
      // original en vez de insertar un duplicado que se re-etiquetaría como 'humano'. Guardas:
      //  · mismo (conv, dirección) y body normalizado con btrim (tolera espacios sobrantes),
      //  · COTA TEMPORAL: la fila debe ser del MISMO momento que el mensaje de GHL (±10 min sobre su
      //    fecha real, o «reciente» si GHL no la trae) para no tragarse un mensaje NUEVO que casualmente
      //    repita un texto viejo ('hola', '¿sigues ahí?'),
      //  · nunca pisamos un id ya existente.
      const linked = await q(
        `UPDATE messages SET ghl_message_id = $1
           WHERE id = (
             SELECT id FROM messages
              WHERE conversation_id = $2 AND direction = $3 AND btrim(body) = btrim($4) AND ghl_message_id IS NULL
                AND (
                  ($5::timestamptz IS NOT NULL AND created_at BETWEEN $5::timestamptz - interval '10 minutes' AND $5::timestamptz + interval '10 minutes')
                  OR ($5::timestamptz IS NULL AND created_at >= now() - interval '30 minutes')
                )
              ORDER BY id DESC LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM messages WHERE ghl_message_id = $1)
         RETURNING id`,
        [String(m.id), conv.id, m.direction, m.body, when]
      );
      if (linked.length) continue; // era un mensaje que ya teníamos (propio o ya capturado)

      // (A) mensaje NUEVO que no teníamos → insertar con su fecha real para que el orden sea correcto
      const r = await q(
        `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id, created_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [conv.id, m.direction, m.direction === 'inbound' ? 'lead' : 'humano', m.body, String(m.id), when]
      );
      if (r.length) imported++;
    } catch (err) {
      await logEvent('sync_historial_msg_error', { conv: conv.id, error: String(err.message).slice(0, 120) });
    }
  }
  return imported;
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
  if (evt.userId && account.auto_handoff) {
    if (!conv.bot_paused) {
      await q(`UPDATE conversations SET bot_paused = true, paused_by = 'humano', updated_at = now() WHERE id = $1`, [conv.id]);
      await cancelBotJobs(conv.id);
      await logEvent('handoff_humano', { conversation: conv.id, userId: evt.userId });
    }
    // reprograma la reactivación en cada mensaje humano (el reloj se reinicia)
    await scheduleReactivate(account, conv.id);
  }
}

// Reactivación del bot tras intervención humana, si pasa el tiempo configurado sin mensajes humanos.
const reactKey = (id) => `reacttoken:${id}`;
const MAX_HANDOFF_MIN = 7 * 24 * 60; // 7 días

export async function scheduleReactivate(account, conversationId) {
  const mins = Math.min(Math.max(0, Number(account.auto_handoff_minutes) || 0), MAX_HANDOFF_MIN);
  if (mins <= 0) return; // 0 = queda pausado hasta reactivar a mano
  const token = crypto.randomUUID();
  // TTL del token estrictamente mayor que el delay del job (margen de 1 día)
  await redis.set(reactKey(conversationId), token, 'EX', mins * 60 + 86400);
  await reactivateQueue.add('reactivate', { conversationId, token }, { delay: mins * 60_000 });
}

// Cancela una reactivación pendiente (al pausar/reactivar a mano).
export async function cancelReactivate(conversationId) {
  await redis.del(reactKey(conversationId));
}

export async function processReactivate(job) {
  const { conversationId, token } = job.data;
  // consumo atómico del token: solo reactiva si este job sigue siendo el vigente
  const script = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]) return 1 else return 0 end`;
  const ok = token && (await redis.eval(script, 1, reactKey(conversationId), token)) === 1;
  if (!ok) return; // reprogramado o cancelado
  const conv = await one(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
  if (!conv || !conv.bot_paused || conv.paused_by !== 'humano') return;
  await q(`UPDATE conversations SET bot_paused = false, paused_by = '', updated_at = now() WHERE id = $1`, [conversationId]);
  await logEvent('bot_reactivado', { conversation: conversationId, motivo: 'tiempo sin mensaje humano' });
}

// ─── Citas del calendario (AppointmentCreate / Update / Delete) ─────────────

export async function handleAppointmentEvent(account, type, p) {
  const appt = p.appointment || p;
  const ghlId = appt.id || p.appointmentId || null;
  const contactId = String(appt.contactId || p.contactId || '');
  const calendarId = appt.calendarId || appt.calendar_id || p.calendarId || '';
  const statusRaw = String(appt.appointmentStatus || appt.status || '').toLowerCase();
  const cancelled = type === 'AppointmentDelete' || ['cancelled', 'canceled', 'noshow', 'no_show', 'invalid'].includes(statusRaw);
  const status = cancelled ? 'cancelado' : 'agendado';
  const startTime = appt.startTime || appt.start_time || null;

  // ¿Ya teníamos registrada esta cita? Entonces es un update/cancel: se reconcilia contra la
  // conversación/setter con que se RECLAMÓ al crearla (sticky). NO se re-filtra por calendario ni se
  // re-deriva por "más reciente" — así una cancelación siempre cierra y no marca a otro setter
  // (contactos con varias conversaciones: IG + WhatsApp, etc.).
  const existing = ghlId
    ? await one(`SELECT id, conversation_id FROM appointments WHERE ghl_appointment_id = $1`, [String(ghlId)])
    : null;

  let convId = existing?.conversation_id || null;

  if (existing) {
    await q(
      `UPDATE appointments SET status = $2, start_time = COALESCE($3, start_time), updated_at = now() WHERE id = $1`,
      [existing.id, status, startTime]
    );
  } else {
    // Cita NUEVA: solo se registra si el setter que ATENDIÓ la reclama (su calendario). SIN respaldo:
    // sin conversación, o setter sin calendarios (su objetivo NO es agendar), o calendario ajeno → NO cuenta.
    const conv = contactId
      ? await one(`SELECT id, setter_id FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 ORDER BY updated_at DESC LIMIT 1`, [account.id, contactId])
      : null;
    let setterCals = [];
    if (conv?.setter_id) {
      const st = await one(`SELECT calendar_ids FROM setters WHERE id = $1`, [conv.setter_id]);
      setterCals = Array.isArray(st?.calendar_ids) ? st.calendar_ids.filter(Boolean) : [];
    }
    const cuenta = setterCals.length > 0 && calendarId && setterCals.includes(calendarId);
    if (!cuenta) {
      await logEvent('cita_no_cuenta', {
        account: account.id, contactId, calendarId, setter: conv?.setter_id || null,
        motivo: !conv ? 'sin_conversacion' : (!conv.setter_id ? 'sin_setter' : (!setterCals.length ? 'setter_no_agenda' : (!calendarId ? 'sin_calendario_en_evento' : 'otro_calendario'))),
      });
      return;
    }
    convId = conv.id;
    if (ghlId) {
      await q(
        `INSERT INTO appointments (account_id, conversation_id, setter_id, ghl_appointment_id, ghl_contact_id, calendar_id, title, status, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL DO UPDATE SET
           status = EXCLUDED.status,
           start_time = COALESCE(EXCLUDED.start_time, appointments.start_time),
           conversation_id = COALESCE(appointments.conversation_id, EXCLUDED.conversation_id),
           setter_id = COALESCE(appointments.setter_id, EXCLUDED.setter_id),
           updated_at = now()`,
        [account.id, conv.id, conv.setter_id, String(ghlId), contactId, calendarId || null, appt.title || '', status, startTime]
      );
    } else {
      await q(
        `INSERT INTO appointments (account_id, conversation_id, setter_id, ghl_contact_id, calendar_id, title, status, start_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [account.id, conv.id, conv.setter_id, contactId, calendarId || null, appt.title || '', status, startTime]
      );
    }
  }

  // Aplicar el estado a la conversación ACREDITADA (la que reclamó la cita), no a la más reciente.
  if (convId) {
    const conv = await one(`SELECT * FROM conversations WHERE id = $1`, [convId]);
    if (conv) {
      await applyStage(conv, account, cancelled ? 'agenda_cancelada' : 'agendado',
        cancelled ? 'cita cancelada en el calendario de GHL' : 'cita agendada en el calendario de GHL');
      if (!cancelled) await redis.del(fuKey(conv.id)); // ya agendó: fuera seguimientos pendientes
    }
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
  let setterId = null;
  // el "cerebro" (prompt, modelo, seguimientos) es el del SETTER asignado a la conversación
  if (conv.setter_id && account) {
    const s = await one(`SELECT * FROM setters WHERE id = $1`, [conv.setter_id]);
    if (s) { account = mergeSetter(account, s); setterId = s.id; }
  } else if (conv.variant_id && account) {
    // legacy: conversaciones asignadas a una variante de campaña antes del modelo de setters
    const v = await one(`SELECT * FROM campaign_variants WHERE id = $1`, [conv.variant_id]);
    if (v) {
      variantId = v.id;
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
    await q(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`, [conversationId])
  ).reverse();
  return { conv, account, provider, history, variantId, setterId };
}

// Modo test: el bot solo responde a contactos de GHL que tengan la etiqueta de prueba.
// Se consulta el contacto en GHL (con caché de 60 s) y ante cualquier duda NO se responde.
// Etiquetas del contacto en GHL (minúsculas), cacheadas 60s.
async function getContactTags(account, conv) {
  const cacheKey = ctagsKey(conv);
  const cached = await redis.get(cacheKey);
  if (cached !== null) { try { return JSON.parse(cached); } catch { return []; } }
  let tags = [];
  try {
    const contact = await ghl.getContact(account, conv.ghl_contact_id);
    tags = Array.isArray(contact?.tags) ? contact.tags.map((t) => String(t).trim().toLowerCase()) : [];
  } catch (err) {
    await logEvent('error_contact_tags', { conv: conv.id, error: err.message });
    return null; // error al consultar: NO cachear (evita envenenar 60s y misenrutar); se reintenta
  }
  await redis.setex(cacheKey, 60, JSON.stringify(tags));
  return tags;
}

// El bot solo responde si pasa el canal del setter, el modo test Y el filtro de etiquetas.
// activacion=true (activador externo): el workflow ya eligió este setter → se saltan las etiquetas
// requeridas y el modo test, pero SÍ se respetan canal, "sin-ia" (exclude_tag) y el bloqueo humano.
async function allowedByTags(account, conv, activacion = false) {
  // Canal: el setter (ya fusionado en account) solo responde en SUS canales. Cubre también las
  // conversaciones ya asignadas (sticky): si le quitan un canal, deja de responder ahí al instante.
  const chans = Array.isArray(account.channels) ? account.channels : [];
  if (chans.length && conv.channel && !chans.includes(conv.channel)) {
    return false;
  }
  const needTest = Boolean(account.test_mode) && !activacion;
  const norm = (arr) => (Array.isArray(arr) ? arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : []);
  // En un versus o una activación externa, las etiquetas requeridas del setter NO aplican.
  const inVersus = Boolean(conv.versus_id) || activacion;
  const required = inVersus ? [] : norm(account.required_tags);
  const excluded = inVersus ? [] : norm(account.excluded_tags); // del setter (via merge)
  const generalExclude = String(account.exclude_tag || '').trim().toLowerCase(); // de la conexión
  if (!needTest && !required.length && !excluded.length && !generalExclude) return true; // sin filtros
  if (!(account.location_id || account.pit_token)) return true; // sin GHL no podemos consultar etiquetas

  const tags = await getContactTags(account, conv);
  if (tags === null) return false; // error consultando → no respondemos (seguro)

  // Exclusión: si el contacto tiene la etiqueta de exclusión general, o una del setter, no se responde.
  if (generalExclude && tags.includes(generalExclude)) return false;
  if (excluded.length && excluded.some((t) => tags.includes(t))) return false;

  if (needTest) {
    const tt = String(account.test_tag || 'hermes-test').trim().toLowerCase();
    if (tt && !tags.includes(tt)) return false;
  }
  if (required.length) {
    const mode = account.required_tags_mode === 'all' ? 'all' : 'any';
    const ok = mode === 'all' ? required.every((t) => tags.includes(t)) : required.some((t) => tags.includes(t));
    if (!ok) return false;
  }
  return true;
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

  const { conv, account, provider, history, variantId, setterId } = await loadContext(conversationId);
  if (!conv || !account) return;

  // ¿activación externa pendiente? → el setter escribe él solo (aunque el último mensaje sea nuestro).
  // El valor lleva su contexto ('1' = sin contexto). Se lee ANTES de los cortes de abajo para poder
  // CONSUMIRLA si el bot no puede atenderla: si la dejáramos viva, al reanudar el bot el siguiente
  // mensaje del lead se trataría como activación (saltándose modo test y etiquetas requeridas).
  const activarRaw = await redis.get(activarKey(conversationId));
  const activacion = Boolean(activarRaw);
  const activContexto = activarRaw && activarRaw !== '1' ? activarRaw : '';
  const descartarActivacion = async (motivo) => {
    if (!activacion) return;
    await redis.del(activarKey(conversationId));
    await logEvent('activacion_descartada', { conv: conv.id, motivo });
  };

  if (!account.ai_enabled || !account.bot_enabled || conv.bot_paused) {
    await descartarActivacion(conv.bot_paused ? 'conversacion_pausada' : 'ia_o_bot_apagado');
    return;
  }
  if (conv.stage === 'atencion_humana') { // requiere atención humana → el bot no responde
    await descartarActivacion('atencion_humana');
    return;
  }
  if (!provider) {
    await logEvent('error_config', { conv: conv.id, msg: 'la cuenta o el agente no tiene proveedor de IA configurado' });
    await descartarActivacion('sin_proveedor');
    return;
  }
  // nada nuevo que responder (el último mensaje ya es nuestro)
  const lastMsg = history[history.length - 1];
  if (!activacion && (!lastMsg || lastMsg.direction === 'outbound')) return;

  // Si venimos de una espera de INSERCIÓN, invalidamos la caché de etiquetas para leerlas FRESCAS:
  // el objetivo de la espera era dar tiempo a que la etiqueta se asignara, y la caché (60 s) la pobló
  // selectSetter con el estado anterior. Sin esto, una espera < 60 s no vería la etiqueta nueva.
  if (await redis.get(insFreshKey(conversationId))) {
    await redis.del(ctagsKey(conv));
    await redis.del(insFreshKey(conversationId));
  }

  if (!(await allowedByTags(account, conv, activacion))) {
    await logEvent('respuesta_omitida_por_etiqueta', { conv: conv.id, contacto: conv.ghl_contact_id, test_mode: account.test_mode, required_tags: account.required_tags, activacion });
    if (activacion) await redis.del(activarKey(conversationId));
    return;
  }

  const windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0) {
    // Fuera del horario activo aplazamos hasta la apertura (puede ser ~24 h). Hay que RENOVAR la
    // activación pendiente: si no, la clave caduca durante la espera y la activación (y su contexto)
    // se pierden en silencio — el setter nunca entraría.
    // EXPIRE (no SET): solo renueva el TTL sin tocar el valor. Si reescribiéramos con el valor leído
    // arriba, una activación NUEVA llegada entretanto quedaría pisada por el contexto viejo; y si la
    // clave ya se consumió, EXPIRE no la resucita (devuelve 0).
    if (activacion) {
      await redis.expire(activarKey(conversationId), Math.ceil(windowDelay / 1000) + 3600);
      await logEvent('activacion_aplazada_por_horario', { conv: conv.id, minutos: Math.round(windowDelay / 60000) });
    }
    await scheduleDebounce(account, conversationId, windowDelay);
    return;
  }

  // Ventana de 24 h de Meta (IG/FB/WhatsApp): si está cerrada, el envío se descartaría igualmente
  // en processSend. Cortamos ANTES de gastar la llamada al LLM y, si había una activación, la
  // descartamos con traza (dejarla viva haría que un mensaje posterior del lead se tratase como
  // activación, saltándose modo test y etiquetas requeridas).
  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    await descartarActivacion('ventana_cerrada');
    return;
  }

  const snapshotId = await lastInboundId(conversationId);
  let result;
  try {
    result = await generateReply({
      account, provider, conversation: conv, history,
      followupInstruction: activacion
        ? 'ACTIVACIÓN EXTERNA: el negocio te activó para esta conversación (p. ej. tras asignar una etiqueta en su flujo). Lee el historial y escribe tú el mensaje adecuado para iniciar o retomar según tu FLUJO — natural, breve, sin sonar automático. Si no hay historial, preséntate según tu identidad.'
          + (activContexto
            ? `\n\nCONTEXTO DE ESTA ACTIVACIÓN (qué pasó justo antes de que te activaran — es lo que marca CÓMO debes entrar; tenlo muy en cuenta y NO lo contradigas): ${activContexto}`
            : '')
        : null,
    });
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
      // Nadie va a reprogramar ya: si dejáramos viva la activación, el siguiente mensaje del lead
      // (horas después) se trataría como activación y se saltaría modo test y etiquetas requeridas.
      await descartarActivacion('llm_agotado');
    }
    return;
  }
  await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, 'reply', variantId, setterId);

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
  if (activacion) await redis.del(activarKey(conversationId)); // activación consumida

  if (result.handoff) {
    // Etiqueta VISIBLE «Requiere atención humana» + pausa; mientras la tenga, el bot no responde.
    await applyStage(conv, account, 'atencion_humana', result.motivo || 'la IA pidió atención humana');
    await q(`UPDATE conversations SET bot_paused = true, paused_by = 'ia', updated_at = now() WHERE id = $1`, [conv.id]);
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
  if ((conv.bot_paused && !bypassPause) || !account.bot_enabled || !account.ai_enabled) return;
  if (snapshotId && (await lastInboundId(conversationId)) !== snapshotId) return; // el lead volvió a escribir
  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    return;
  }
  const res = await ghl.sendMessage(account, { channel: conv.channel, contactId: conv.ghl_contact_id, message: body });
  await redis.setex(sentKey, 3600, '1').catch(() => {});
  try {
    // Guardamos SIEMPRE que se pueda el id real de GHL: es lo que evita que el import de la activación
    // reimporte nuestro propio mensaje y lo re-etiquete como 'humano'. Cubrimos las variantes del payload.
    const ghlMessageId = res?.messageId || res?.messageIds?.[0] || res?.msg?.id || res?.message?.id || null;
    if (!ghlMessageId) await logEvent('envio_sin_message_id', { conv: conv.id, keys: Object.keys(res || {}) });
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

  const { conv, account, provider, history, variantId, setterId } = await loadContext(conversationId);
  if (!conv || !account || !provider) return;
  if (!account.ai_enabled || !account.bot_enabled || conv.bot_paused) return;
  if (conv.stage === 'atencion_humana') return; // requiere atención humana → sin seguimientos

  // Gate duro por estado (sin coste): descartado (fuera) o agendado (objetivo cumplido) → nunca.
  // El resto (en_conversion, calificado, etc.) lo decide el chequeo IA leyendo los mensajes,
  // porque un lead que pidió el enlace pero se quedó callado sí conviene retomarlo.
  if (['descartado', 'agendado'].includes(conv.stage)) {
    await redis.del(fuKey(conv.id)); // cortar la cadena de seguimientos
    return;
  }
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const step = conv.followup_step || 0;
  const stepConf = steps[step];
  if (!stepConf) return;

  // si el lead respondió después del último envío, el ciclo normal ya se encarga
  if (conv.last_inbound_at && conv.last_outbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) return;

  if (!(await allowedByTags(account, conv))) return;

  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    return;
  }
  const windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0) {
    await rearmFollowup(conversationId, windowDelay);
    return;
  }

  // Chequeo con IA: mira los últimos mensajes y decide si aún conviene el seguimiento
  // (p.ej. el lead ya agendó/compró, dijo que no, se despidió). Ante fallo, no bloquea.
  if (account.followup_ai_check) {
    let decision = { seguir: true };
    try {
      decision = await shouldFollowup({ account, provider, conversation: conv, history });
    } catch (err) {
      await logEvent('followup_check_error', { conv: conv.id, error: err.message });
    }
    if (decision.usage) await recordUsage(conv.account_id, conv.id, provider, decision.model, decision.usage, 'seguimiento', variantId, setterId);
    if (!decision.seguir) {
      await logEvent('followup_omitido_ia', { conv: conv.id, stage: conv.stage, motivo: decision.motivo || '' });
      await q(`UPDATE conversations SET followup_state = 'detenido_ia', updated_at = now() WHERE id = $1`, [conv.id]);
      await redis.del(fuKey(conv.id)); // parar la cadena (el ciclo normal la reanuda si el lead escribe)
      return;
    }
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
  await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, 'seguimiento', variantId, setterId);

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
  if (conv.stage === 'calificado' || conv.stage === 'seguimiento_calificado') {
    // estaba calificado pero no agendó → seguimiento específico de calificación
    await applyStage(conv, account, 'seguimiento_calificado', `seguimiento #${newStep} (calificado sin agendar)`);
  } else if (!['en_conversion', 'descartado', 'agendado', 'agenda_cancelada'].includes(conv.stage)) {
    await applyStage(conv, account, 'en_seguimiento', `seguimiento #${newStep} enviado`);
  }
  await scheduleNextFollowup(account, { ...conv, followup_step: newStep }, cursor);
}
