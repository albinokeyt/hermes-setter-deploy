import crypto from 'node:crypto';
import { q, one, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';
import { normTag } from '../lib/tags.js';
// 🧪 Simulador: contactos «sim:…» recorren este motor sin tocar GHL ni cobrar (ver lib/sim.js)
import { esSim, getSimTags } from '../lib/sim.js';
import { quitarPresentacionRepetida } from './agent.js';
import { debounceQueue, sendQueue, followupQueue, reactivateQueue } from '../queues.js';
import { generateReply, shouldFollowup } from './agent.js';
// 💳 Marketplace Disruptivo: puerta de acceso antes de atender y registro de consumo al entregar.
import { puedeAtender, registrarConsumo } from './marketplace.js';
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
// El acuerdo de tiempo con el lead se recortó por la ventana de Meta: el seguimiento debe
// reconocer que escribe ANTES de lo pactado. Se ata al token del job para que la nota no se
// aplique a un seguimiento posterior que ya no tiene nada que ver con aquel acuerdo.
const fuAdjKey = (id) => `fuadj:${id}`;
const olvidarAjuste = (id) => redis.del(fuAdjKey(id)).catch(() => {});
const fuKey = (id) => `futoken:${id}`;
const ctaKey = (id) => `ctawait:${id}`; // instante (ms) hasta el que el setter espera por un CTA
const activarKey = (id) => `activar:${id}`; // activación externa pendiente (el setter escribe él solo)
const rescConvKey = (id) => `rescconv:${id}`; // la activación pendiente es un RESCATE (re-chequear al disparar)
const activarAtKey = (id) => `activarat:${id}`; // cuándo se puso la activación pendiente (para juntar solo las «casi a la vez»)
// Un saliente ajeno está pendiente de saber si lo escribió una persona (consulta a GHL): el setter espera a saberlo.
const outPendKey = (id) => `outpendset:${id}`; // SET de messageIds cuyo origen se está resolviendo
async function esperarOrigenPendiente(conversationId, maxMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs && Number(await redis.scard(outPendKey(conversationId)).catch(() => 0)) > 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
// Reactivación EXPLÍCITA (panel o reactivación por tiempo): los mensajes humanos anteriores ya no vuelven a pausar.
export const manualOnKey = (id) => `manualon:${id}`;
export const marcarReactivado = (id) => redis.set(manualOnKey(id), String(Date.now()), 'EX', 7 * 86400).catch(() => {});
const insFreshKey = (id) => `insfresh:${id}`; // pendiente de re-leer etiquetas frescas tras la inserción
// Marca de "este texto lo enviamos NOSOTROS": se pone ANTES de enviar, para reconocer el eco que nos
// devuelve el webhook aunque el envío falle después y no lleguemos a guardar nada.
const ecoKey = (convId, body) => `eco:${convId}:${crypto.createHash('sha1').update(String(body || '')).digest('hex')}`;
const ctagsKey = (conv) => `ctags:${conv.account_id}:${conv.ghl_contact_id}`; // caché de etiquetas del contacto

// ¿El origen que da GHL es una AUTOMATIZACIÓN? ('workflow', 'campaign', 'bulk_actions', 'api'…). 'app' es una
// persona escribiendo desde el panel o el móvil.
export const esOrigenAutomatico = (src) => /workflow|campaign|bulk|automation|automatizacion|trigger|api/.test(String(src || '').toLowerCase());
// Hasta este despliegue los DMs de workflow se guardaban como 'humano' (no se distinguía el origen): las redes de
// seguridad «una persona escribió hace poco» solo cuentan mensajes humanos a partir de aquí.
// El valor real es el PRIMER arranque de este código (migración 053, lo carga index.js); la fecha fija es solo un suelo.
export let HUMANO_FIABLE_DESDE = Date.parse('2026-09-24T12:00:00Z');
export async function cargarHumanoFiableDesde() {
  const v = await getSetting('humano_fiable_desde').catch(() => null);
  const t = Date.parse(v?.at || '');
  if (Number.isFinite(t)) HUMANO_FIABLE_DESDE = Math.max(HUMANO_FIABLE_DESDE, t);
}
const esHumanoFiable = (m) => m && m.direction === 'outbound' && m.source === 'humano' && new Date(m.created_at).getTime() >= HUMANO_FIABLE_DESDE;

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
    await q(`DELETE FROM webhook_log WHERE id < (SELECT COALESCE(MAX(id),0) FROM webhook_log) - 2000
                AND COALESCE(payload->>'contactId', '') NOT LIKE 'sim:%' AND COALESCE(payload->>'contacto', '') NOT LIKE 'sim:%'
                AND NOT EXISTS (SELECT 1 FROM conversations s WHERE s.simulada AND s.id::text = webhook_log.payload->>'conv')`); // 🧪 las trazas del simulador se podan por edad
  } catch (err) {
    console.error('[log]', err.message);
  }
}

// ── Registro de activaciones por etiqueta (para el panel en vivo de la sección Activaciones) ──
async function activationLogStart(account, setter, conv, { tag = '', contexto = '', waitSeconds = 0, motivoPrevia = 'reemplazada' }) {
  try {
    // una activación nueva reemplaza a la anterior pendiente de esta conversación (last-wins)
    await q(`UPDATE activation_log SET status = 'descartado', motivo = $2, updated_at = now() WHERE conversation_id = $1 AND status = 'esperando'`, [conv.id, motivoPrevia]);
    // $8::int en las DOS posiciones: sin el cast, Postgres no sabe de qué tipo es el parámetro dentro
    // de «$8 * interval» y rechaza el INSERT entero. Fallaba en silencio (lo tragaba el catch de
    // abajo), así que la tabla llevaba VACÍA desde que se creó y el panel de Activaciones no mostraba
    // nada en ninguna cuenta: el cliente no tenía forma de ver si sus campañas activaban al setter.
    await q(
      `INSERT INTO activation_log (account_id, setter_id, conversation_id, contact_id, contact_name, tag, contexto, wait_seconds, respond_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int, now() + ($8::int * interval '1 second'))`,
      [account.id, setter.id, conv.id, conv.ghl_contact_id, conv.lead_name || '', String(tag || '').slice(0, 100), String(contexto || '').slice(0, 1500), Math.max(0, Number(waitSeconds) || 0)]
    );
    await q(`DELETE FROM activation_log WHERE id < (SELECT COALESCE(MAX(id),0) FROM activation_log) - 3000`);
  } catch (err) {
    // Se traza además en el registro visible: un fallo aquí deja el panel ciego y nadie se entera.
    console.error('[activation_log start]', err.message);
    await logEvent('activation_log_error', { conv: conv.id, setter: setter.id, error: String(err.message).slice(0, 200) }).catch(() => {});
  }
}
// Llamado desde el worker cuando un job de debounce FALLA (excepción no capturada): resuelve la fila
// para que no quede 'esperando' con temporizador infinito. Idempotente (solo toca filas 'esperando').
export async function markActivationFailed(conversationId) {
  await activationLogDone(conversationId, 'descartado', 'error');
}
async function activationLogDone(conversationId, status, extra = '') {
  try {
    if (status === 'respondido') {
      await q(`UPDATE activation_log SET status = 'respondido', message = $2, updated_at = now() WHERE conversation_id = $1 AND status = 'esperando'`, [conversationId, String(extra || '').slice(0, 4000)]);
    } else {
      await q(`UPDATE activation_log SET status = 'descartado', motivo = $2, updated_at = now() WHERE conversation_id = $1 AND status = 'esperando'`, [conversationId, String(extra || '').slice(0, 200)]);
    }
  } catch (err) {
    console.error('[activation_log done]', err.message);
  }
}
// Reprograma la hora objetivo (p. ej. aplazada por horario) para que el temporizador sea correcto.
async function activationLogReschedule(conversationId, seconds) {
  try {
    await q(`UPDATE activation_log SET respond_at = now() + ($2 * interval '1 second'), updated_at = now() WHERE conversation_id = $1 AND status = 'esperando'`, [conversationId, Math.max(0, Math.round(Number(seconds) || 0))]);
  } catch (err) {
    console.error('[activation_log resched]', err.message);
  }
}

// Marca un saliente como PROPIO (lo mandamos nosotros, o un humano desde NUESTRO panel) para que el eco
// que devuelve el webhook de GHL no se tome por intervención externa (que pausaría el bot y duplicaría
// el mensaje en el chat). markOwnOutbound se llama ANTES de enviar; markSentMessage, con el id que
// devuelva GHL.
export async function markOwnOutbound(conversationId, body) {
  await redis.set(ecoKey(conversationId, body), '1', 'EX', 300).catch(() => {});
}
export async function markSentMessage(messageId) {
  if (messageId) await redis.setex(`sent:${messageId}`, 86400, '1').catch(() => {});
}

export async function accountByLocation(locationId) {
  // Determinista y a prueba de DUPLICADOS: si una reinstalación (p. ej. tras la desinstalación
  // masiva de GHL) creó una segunda fila para la misma location — nacida apagada por el default —
  // el SELECT sin orden podía entregar la fila muerta y los leads "entraban con el setter apagado".
  // Gana la conexión ENCENDIDA y, a igualdad, la ORIGINAL (id más bajo).
  const rows = await q(
    `SELECT * FROM accounts WHERE location_id = $1 ORDER BY ai_enabled DESC, bot_enabled DESC, id ASC`,
    [locationId]
  );
  if (rows.length > 1) {
    const fresh = await redis.set(`dupacc:${locationId}`, '1', 'EX', 3600, 'NX').catch(() => null);
    if (fresh) await logEvent('location_duplicada', { locationId, cuentas: rows.map((r) => r.id), usando: rows[0].id }).catch(() => {});
  }
  return rows[0] || null;
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
    // El modelo va ATADO a su proveedor: SOLO cuando el setter elige un proveedor DISTINTO al de la
    // conexión no hereda su model (sería el string de otra API) → con model vacío, generateReply cae al
    // default_model del proveedor elegido. Si usa el mismo proveedor (o ninguno propio), sí hereda el
    // model de la conexión como respaldo (es válido, misma API).
    model: (s.provider_id && s.provider_id !== account.provider_id) ? (s.model || '') : (s.model || account.model),
    temperature: s.temperature,
    max_msgs: s.max_msgs,
    // tope de palabras: el del setter manda si lo tiene; si no lo define, hereda el de la conexión
    // (a diferencia de max_msgs/temperature, que son de siempre y ahí el setter gana aunque sea nulo)
    max_words: Number(s.max_words) > 0 ? s.max_words : account.max_words,
    // igual que max_words: el setter manda si lo tiene encendido; si no, hereda el de la conexion
    followup_fit_window: Boolean(s.followup_fit_window || account.followup_fit_window),
    debounce_seconds: s.debounce_seconds,
    followups: Array.isArray(s.followups) && s.followups.length ? s.followups : account.followups,
    followup_ai_check: s.followup_ai_check !== false, // por defecto ON
    // modo test: el de la CONEXIÓN aplica a todos (con la etiqueta de la conexión); el del setter solo
    // a él, con SU propia etiqueta de test (si no tiene, cae a la de la conexión).
    test_mode: Boolean(account.test_mode || s.test_mode),
    test_tag: account.test_mode ? account.test_tag : (String(s.test_tag || '').trim() || account.test_tag),
    // prueba de ESTE setter (no test "en bloque" de la conexión): durante ella la etiqueta de test es la
    // llave y las etiquetas REQUERIDAS del setter no aplican (si no, capta el lead de prueba y queda mudo).
    test_by_setter: Boolean(s.test_mode && !account.test_mode),
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
  if (setters.length === 1 && !setters[0].test_mode && !account.test_mode) return { setter: setters[0], hasSetters: true };
  const tags = await getContactTags(account, conv);
  const norm = (a) => (Array.isArray(a) ? a.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : []);
  const hasReq = (s) => norm(s.required_tags).length > 0;
  const hasExcl = (s) => norm(s.excluded_tags).length > 0;
  const generalExclude = String(account.exclude_tag || '').trim().toLowerCase();
  // modo test: la CONEXIÓN aplica a todos con su etiqueta; un setter solo, con la SUYA (o la de la
  // conexión si no tiene). enTest(s) = ese setter está en prueba; testTagOf(s) = qué etiqueta le toca.
  const connTest = Boolean(account.test_mode);
  const connTag = String(account.test_tag || 'hermes-test').trim().toLowerCase();
  const enTest = (s) => connTest || s.test_mode;
  const testTagOf = (s) => connTest ? connTag : (String(s.test_tag || '').trim().toLowerCase() || connTag);
  const anyTest = setters.some(enTest);
  // si dependemos de etiquetas y no se pudieron leer, aplazamos (no fijar asignación equivocada).
  if (tags === null && (generalExclude || anyTest || setters.some((s) => hasReq(s) || hasExcl(s)))) return { setter: null, hasSetters: true, defer: true };
  // exclusión general de la conexión → ningún setter responde
  if (generalExclude && tags && tags.includes(generalExclude)) return { setter: null, hasSetters: true };
  // Un setter en test SOLO capta leads de PRUEBA (con SU etiqueta de test). Los leads reales NO se le
  // asignan (irían a los setters vivos) para no quedarse mudos durante la prueba.
  const passesTest = (s) => !enTest(s) || Boolean(tags && testTagOf(s) && tags.includes(testTagOf(s)));
  // fuera los que excluyen a este lead por sus etiquetas, y los setters en test para leads reales
  const cands = setters.filter((s) => passesTest(s) && !(hasExcl(s) && tags && norm(s.excluded_tags).some((t) => tags.includes(t))));
  if (!cands.length) return { setter: null, hasSetters: true };
  // PRUEBA por setter: si hay setters con su PROPIO test que casan (el contacto tiene su etiqueta), el
  // MÁS NUEVO (id mayor) gana la propiedad — así se pueden probar varios a la vez. No aplica al test
  // "en bloque" de la conexión (ahí el enrutado es el normal, solo filtrado por su etiqueta).
  if (!connTest) {
    const testCands = cands.filter((s) => s.test_mode);
    if (testCands.length) return { setter: testCands.reduce((a, b) => (b.id > a.id ? b : a)), hasSetters: true };
  }
  let pool = cands.filter((s) => hasReq(s) && setterMatches(s, tags));
  if (!pool.length) pool = cands.filter((s) => !hasReq(s));
  // Respaldo: el setter por defecto, PERO solo si el lead casa sus etiquetas requeridas (si no, lo
  // reclamaría y luego el gate de respuesta lo silenciaría, dejándolo pegado y mudo).
  if (!pool.length) pool = cands.filter((s) => s.is_default && (!hasReq(s) || setterMatches(s, tags)));
  // Fuera de un versus el reparto es a partes iguales (el peso proporcional se usa en Versus).
  return { setter: pool.length ? pool[Math.floor(Math.random() * pool.length)] : null, hasSetters: true };
}

// CTAs: si el primer mensaje contiene una palabra/frase clave, el setter espera un
// plazo antes de entrar. Devuelve la espera en SEGUNDOS o null si no aplica.
// Casan primero las CTAs con keyword; una keyword vacía es el "cualquiera" (catch-all).
// Una palabra de CTA tiene que EMPEZAR donde empieza una palabra. Con `includes` a secas, una CTA
// corta como "test" casaba dentro de "contestar" o "raíz" dentro de otra palabra, y el lead se comía
// la espera del CTA sin haber escrito ninguna palabra de campaña. El final se deja libre a propósito
// para que sigan valiendo los plurales y las variantes con sufijo ("señal" casa "señales").
// Se usa \p{L}/\p{N} en vez de \b porque \b no considera letra ni a la enye ni a las acentuadas.
const cacheCta = new Map();
function ctaRegex(kw) {
  let re = cacheCta.get(kw);
  if (!re) {
    const literal = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${literal}`, 'iu');
    cacheCta.set(kw, re);
  }
  return re;
}

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
    if (ctaRegex(kw).test(text)) return w;
  }
  return catchAll;
}

export async function cancelBotJobs(conversationId) {
  await redis.del(debKey(conversationId));
  await redis.del(fuKey(conversationId)); await olvidarAjuste(conversationId);
  await redis.del(reactKey(conversationId));
  // También la activación externa pendiente: si la dejamos, al reanudar el bot el SIGUIENTE mensaje
  // del lead se trataría como «activación» (saltándose modo test y etiquetas requeridas) y entraría
  // con el contexto de una etiqueta vieja.
  await redis.del(activarKey(conversationId));
  await redis.del(rescConvKey(conversationId));
  // y cerramos su registro (idempotente: solo toca filas 'esperando') para que no quede colgado el
  // temporizador del panel al pausar/excluir/hacer handoff/borrar durante la espera de una activación.
  await activationLogDone(conversationId, 'descartado', 'cancelado');
}

// Invalida la caché de etiquetas del contacto (p. ej. tras excluir/incluir manualmente).
export async function invalidateContactTags(accountId, contactId) {
  await redis.del(`ctags:${accountId}:${contactId}`);
}

// Registra tokens y coste de cada llamada al LLM. OpenRouter devuelve el coste
// real (usage.cost, USD); para el resto se estima con los precios opcionales
// del proveedor ($ por 1M de tokens).
// Devuelve { pt, ct, cost, billed } para que el llamador pueda estampar el gasto en el propio
// mensaje (el admin lo ve por burbuja en el chat y decide si el modelo le da la talla).
export async function recordUsage(accountId, conversationId, provider, model, usage, source, variantId = null, setterId = null) {
  if (!usage) return null;
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
    return { pt, ct, cost, billed };
  } catch (err) {
    console.error('[usage]', err.message);
    return null;
  }
}

// 🔍 Detalle completo de la llamada de IA (input íntegro + respuesta cruda): el admin lo abre por
// burbuja para analizar el gasto y entender la respuesta. Se poda a 30 días.
async function saveLlmDebug({ convId, source, result, activacion = '', historyCount = null, cost = null }) {
  try {
    if (!result?.debug) return null;
    const u = result.usage || {};
    const row = await one(
      `INSERT INTO llm_debug (conversation_id, source, model, prompt_tokens, completion_tokens, cost_usd, history_count, activacion, input, output)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
      [
        convId, source, result.model || '',
        Number(u.prompt_tokens ?? u.input_tokens) || null,
        Number(u.completion_tokens ?? u.output_tokens) || null,
        cost, historyCount, String(activacion || '').slice(0, 1500),
        JSON.stringify(result.debug.input || []),
        String(result.debug.raw || '').slice(0, 100_000),
      ]
    );
    // poda en su propio try: si fallara, el id recién insertado se devuelve igual (el enlace vive)
    try { await q(`DELETE FROM llm_debug WHERE created_at < now() - interval '30 days'`); } catch { /* se poda en la siguiente */ }
    return row?.id || null;
  } catch (err) {
    await logEvent('error_debug_ia', { conv: convId, error: err.message }).catch(() => {});
    return null;
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

  // Flags de la CONEXIÓN capturados ANTES de cualquier mergeSetter (que pisa bot_enabled con el
  // AND conexión&&setter): los logs de "nadie responde" deben culpar al culpable correcto.
  const connAi = Boolean(account.ai_enabled);
  const connBot = Boolean(account.bot_enabled);

  // recaudación desactivada y bot apagado → no guardamos nada (ni procesamos adjuntos)
  if (!(await shouldCollect(account))) return null;

  const textBody = String(evt.body || '').trim();
  const attachments = Array.isArray(evt.attachments) ? evt.attachments : [];
  if (!textBody && !attachments.length) return null; // nada que procesar

  // Entrantes SIN messageId (p. ej. la ruta de workflow): sin id no hay ON CONFLICT que pare un
  // reenvío del webhook, y ese reenvío disparaba un SEGUNDO ciclo que re-respondía lo ya respondido.
  // Candado por payload CRUDO (texto + adjuntos tal como llegan, ANTES de visión/transcripción, que
  // no son deterministas) y ANTES del upsert (un descarte no debe tocar last_inbound_at). El TTL se
  // acota al debounce EFECTIVO — el del setter ya asignado a la conversación si lo hay, que es el
  // que usará scheduleDebounce —: así solo se descartan copias que llegan mientras la primera aún
  // espera, y un lead que repite «ok» legítimamente DESPUÉS de nuestra respuesta nunca cae dentro.
  // Con el bot apagado no hay ciclo que proteger: no se aplica (que la repetición se archive).
  if (!evt.messageId && connAi && connBot) {
    const filaDeb = await one(
      `SELECT s.debounce_seconds AS d FROM conversations c
         LEFT JOIN setters s ON s.id = c.setter_id
        WHERE c.account_id = $1 AND c.ghl_contact_id = $2 AND c.channel = $3`,
      [account.id, evt.contactId, channel]
    );
    const debEfectivo = Number(filaDeb?.d) || Number(account.debounce_seconds) || 35;
    const crudo = `${textBody}|${attachments.map((a) => (typeof a === 'string' ? a : a?.url || JSON.stringify(a))).join(',')}`;
    const inbHash = crypto.createHash('md5').update(`${account.id}|${evt.contactId}|${channel}|${crudo}`).digest('hex');
    const ttl = Math.min(30, Math.max(5, debEfectivo));
    const fresco = await redis.set(`inb:${inbHash}`, '1', 'EX', ttl, 'NX');
    if (!fresco) {
      await logEvent('mensaje_duplicado_sin_id', { account: account.id, contacto: evt.contactId, body: textBody.slice(0, 120) });
      return null;
    }
  }

  // Última actividad ANTES de esta entrada (el upsert de abajo pisa last_inbound_at), para saber si
  // el lead vuelve tras un periodo de inactividad y reaplicar el tiempo de inserción.
  const prevAct = await one(
    `SELECT GREATEST(COALESCE(last_inbound_at, 'epoch'::timestamptz), COALESCE(last_outbound_at, 'epoch'::timestamptz)) AS at
       FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 AND channel = $3`,
    [account.id, evt.contactId, channel]
  );

  const conv = await one(
    `INSERT INTO conversations (account_id, ghl_contact_id, ghl_conversation_id, channel, lead_name, last_inbound_at, updated_at, simulada)
     VALUES ($1, $2, $3, $4, $5, now(), now(), $6)
     ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET
       ghl_conversation_id = COALESCE(EXCLUDED.ghl_conversation_id, conversations.ghl_conversation_id),
       lead_name = CASE WHEN conversations.lead_name = '' THEN EXCLUDED.lead_name ELSE conversations.lead_name END,
       last_inbound_at = now(),
       followup_step = 0,
       followup_state = 'ninguno',
       updated_at = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [account.id, evt.contactId, evt.conversationId || null, channel, evt.contactName || '', esSim(evt.contactId)]
  );
  // Si el CTA le llegó ANTES de escribir (comentó, le etiquetaron, y ahora contesta al DM), la
  // conversación nace aquí y hereda ese contexto: el setter responde sabiendo qué pidió.
  await aplicarContextoCtaPendiente(account, conv);
  await enlazarComprasPrevias(account, conv); // 🛒 compró antes de hablar con el setter: se enlaza (no cuenta como venta suya)
  // 🧪 el lead simulado nace en el simulador (no aquí): su primer mensaje debe contar como ENTRADA igualmente
  if (esSim(conv.ghl_contact_id) && (await redis.del(`simentrada:${conv.id}`)) === 1) conv.is_new = true;

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
    // sin messageId el candado por payload crudo del INICIO de esta función ya filtró los reenvíos
    await q(`INSERT INTO messages (conversation_id, direction, source, body) VALUES ($1, 'inbound', 'lead', $2)`, [conv.id, body]);
  }

  await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); // el lead respondió → se cancela la cadena de seguimientos

  if ((!conv.lead_name || !conv.lead_email) && (account.location_id || account.pit_token) && !esSim(evt.contactId)) {
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
      .catch(async (err) => {
        // ANTES esto era silencioso: con los tokens muertos (p. ej. app desinstalada) TODOS los
        // leads quedaban «sin nombre» sin una sola traza. Throttle 1/min por cuenta para no inundar.
        const fresh = await redis.set(`nomerr:${account.id}`, '1', 'EX', 60, 'NX').catch(() => null);
        if (fresh) await logEvent('error_nombre_contacto', { account: account.id, contactId: evt.contactId, error: String(err.message || err).slice(0, 200) }).catch(() => {});
      });
  }

  // Visibilidad: si NADIE va a responder, que quede en el Registro de eventos (1/h por cuenta) y
  // culpando al CULPABLE correcto — `account` aquí puede venir fusionado con el setter (mergeSetter
  // pisa bot_enabled con el AND), así que se usan los flags de la conexión capturados al entrar.
  if (respond && (!connAi || !connBot)) {
    const fresh = esSim(evt.contactId) ? true : await redis.set(`offlog:${account.id}`, '1', 'EX', 3600, 'NX').catch(() => null);
    if (fresh) await logEvent('lead_sin_respuesta_conexion_apagada', { account: account.id, ai: connAi, bot: connBot, contactId: evt.contactId }).catch(() => {});
  } else if (respond && connAi && connBot && !account.bot_enabled) {
    // la conexión está encendida: lo apagado es el SETTER asignado a esta conversación
    const fresh = esSim(evt.contactId) ? true : await redis.set(`offlog:${account.id}`, '1', 'EX', 3600, 'NX').catch(() => null);
    if (fresh) await logEvent('lead_sin_respuesta_setter_apagado', { account: account.id, setter: conv.setter_id || account.setter_id || null, contactId: evt.contactId }).catch(() => {});
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
// 📌 CONTEXTO PERSISTENTE DEL CTA: queda en TODAS las conversaciones del contacto en esta conexión
// (aún no sabemos por qué canal escribirá) y en Redis 14 días para aplicarlo a la conversación que
// nazca después. Es lo que hace que el setter sepa qué material pidió el lead en TODOS los turnos y
// no solo en la entrada proactiva, que puede descartarse (ventana de Meta cerrada, pausa, canal…).
// opts.soloSiVacio: no pisar un CTA ya guardado (se usa cuando no sabemos si la etiqueta es nueva).
// opts.setterId: en el camino de activación, solo las conversaciones de ESE setter (o sin setter);
// el camino informativo de lead magnet no lo pasa y llega a todas las del contacto.
// NO toca updated_at: es la métrica de actividad del panel y un re-etiquetado en lote de GHL no es
// actividad del lead (cta_at ya fecha el CTA).
const ctaPendKey = (accountId, contactId) => `ctapend:${accountId}:${contactId}`;
export async function guardarContextoCta(account, contactId, tag, contexto, opts = {}) {
  const t = normTag(tag);
  if (!contactId || !t) return 0;
  const ctx = String(contexto || '').trim().slice(0, 1500);
  const at = new Date().toISOString();
  // Redis PRIMERO: una conversación que nazca mientras corre el UPDATE la recoge aplicarContextoCtaPendiente.
  const key = ctaPendKey(account.id, contactId);
  const valor = JSON.stringify({ tag: t, contexto: ctx, at });
  if (opts.soloSiVacio) await redis.set(key, valor, 'EX', 14 * 86400, 'NX');
  else await redis.set(key, valor, 'EX', 14 * 86400);
  const cond = ['account_id = $1', 'ghl_contact_id = $2'];
  const vals = [account.id, String(contactId), t, ctx, at];
  if (opts.soloSiVacio) cond.push(`cta_tag = ''`);
  if (opts.setterId) { vals.push(opts.setterId); cond.push(`(setter_id IS NULL OR setter_id = $${vals.length})`); }
  const filas = await q(
    `UPDATE conversations SET cta_tag = $3, cta_context = $4, cta_at = $5::timestamptz WHERE ${cond.join(' AND ')} RETURNING id`,
    vals
  );
  return filas.length;
}
// Le quitaron la etiqueta al contacto en GHL: si era su CTA vigente, se olvida (en la BD y en el pendiente).
export async function limpiarContextoCta(account, contactId, tag) {
  const t = normTag(tag);
  if (!contactId || !t) return;
  await q(`UPDATE conversations SET cta_tag = '', cta_context = '' WHERE account_id = $1 AND ghl_contact_id = $2 AND cta_tag = $3`, [account.id, String(contactId), t]);
  const key = ctaPendKey(account.id, contactId);
  const raw = await redis.get(key).catch(() => null);
  if (raw) { try { if (normTag(JSON.parse(raw).tag) === t) await redis.del(key); } catch { /* nada */ } }
}
// Aplica a una conversación recién creada (o sin CTA) el contexto pendiente del contacto, si lo hay,
// con la fecha REAL en que se puso la etiqueta (no «ahora»).
async function aplicarContextoCtaPendiente(account, conv) {
  if (!conv || conv.cta_tag) return;
  const raw = await redis.get(ctaPendKey(account.id, conv.ghl_contact_id)).catch(() => null);
  if (!raw) return;
  try {
    const { tag, contexto, at } = JSON.parse(raw);
    if (!tag) return;
    const fecha = at && !Number.isNaN(new Date(at).getTime()) ? at : new Date().toISOString();
    await q(`UPDATE conversations SET cta_tag = $2, cta_context = $3, cta_at = COALESCE(cta_at, $4::timestamptz) WHERE id = $1 AND cta_tag = ''`, [conv.id, tag, String(contexto || ''), fecha]);
    conv.cta_tag = tag; conv.cta_context = String(contexto || ''); conv.cta_at = conv.cta_at || fecha;
  } catch { /* pendiente corrupto: se ignora */ }
}

// Devuelve el ESTADO real de la activación: 'activado' | 'apagado' (IA o bot apagados) |
// 'bloqueado' (pausa o atención humana). El webhook lo usa para no quemar la etiqueta 24 h en falso.
export async function activateSetterForContact(account, setter, contactId, waitSeconds = 0, contexto = '', tag = '', opts = {}) {
  const merged = mergeSetter(account, setter);
  if (!account.ai_enabled || !merged.bot_enabled) {
    await logEvent('activador_apagado', { setter: setter.id, contactId, ai: account.ai_enabled, bot: merged.bot_enabled });
    return 'apagado';
  }
  // historial del contacto en GHL (si falla o no hay, se sigue con lo que tengamos local)
  let ghlHistory = { conversationId: null, messages: [], lastInboundAt: null };
  if (!esSim(contactId)) { // 🧪 un contacto simulado no existe en GHL: su historial es solo el local
    try {
      ghlHistory = await ghl.listContactMessages(account, contactId, 20);
    } catch (err) {
      await logEvent('activador_sin_historial', { setter: setter.id, contactId, error: String(err.message).slice(0, 200) });
    }
  }
  const last = ghlHistory.messages[ghlHistory.messages.length - 1];
  // opts.canal ancla la activación a la conversación AUDITADA (rescate): sin esto, un contacto
  // multicanal podía aterrizar en OTRA conversación suya (p. ej. la de WhatsApp ya atendida).
  let channel = normalizeChannel(opts.canal) || normalizeChannel(last?.type) || (Array.isArray(merged.channels) && merged.channels[0]) || 'IG';
  if (esSim(contactId)) { // 🧪 la simulación vive en la conversación que creó el simulador (no abrir otra por canal)
    const simConv = await one(`SELECT channel FROM conversations WHERE account_id = $1 AND ghl_contact_id = $2 AND simulada ORDER BY id LIMIT 1`, [account.id, String(contactId)]);
    if (simConv?.channel) channel = simConv.channel;
  }

  const conv = await one(
    `INSERT INTO conversations (account_id, ghl_contact_id, ghl_conversation_id, channel, lead_name, updated_at, simulada)
     VALUES ($1, $2, $3, $4, '', now(), $5)
     ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET
       ghl_conversation_id = COALESCE(EXCLUDED.ghl_conversation_id, conversations.ghl_conversation_id),
       updated_at = now()
     RETURNING *`,
    [account.id, String(contactId), ghlHistory.conversationId, channel, esSim(contactId)]
  );
  await aplicarContextoCtaPendiente(account, conv); // si la conversación nace aquí, hereda el CTA
  // Una activación por etiqueta es una ORDEN EXPLÍCITA del negocio, así que gana a la AUTO-pausa por
  // intervención externa (paused_by='humano'), que es solo una suposición: si el workflow manda un
  // mensaje y acto seguido pone la etiqueta, sin esto el setter no entraría nunca. Se siguen respetando
  // la pausa MANUAL del panel, la que pide la IA y la etiqueta de atención humana.
  // La etiqueta es la orden MÁS RECIENTE y EXPLÍCITA del negocio: gana a la auto-pausa por
  // intervención externa Y a la pausa manual del panel («si el setter está apagado, la etiqueta lo
  // enciende»). Solo se respetan la exclusión (sin-ia), la pausa pedida por la IA y atención humana.
  let pausaSuperable = conv.bot_paused && conv.stage !== 'atencion_humana'
    && conv.paused_by !== 'excluido' && conv.paused_by !== 'ia';
  // …salvo que la pausa sea porque una PERSONA está atendiendo ahora: si escribió hace menos de 72 h, la etiqueta
  // no la pisa (Georgi contestando desde el móvil y un workflow poniendo una etiqueta a la vez). Vale también para la
  // pausa manual del panel (el operador pausó y sigue escribiendo desde el móvil: paused_by se queda en 'manual').
  // Una reactivación explícita posterior (panel, reactivación por tiempo) deja de contar lo anterior.
  if (pausaSuperable && (conv.paused_by === 'humano' || conv.paused_by === 'manual')) {
    const ultHumano = await one(`SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND source = 'humano' AND created_at >= to_timestamp($2 / 1000.0)`, [conv.id, HUMANO_FIABLE_DESDE]).catch(() => null);
    const manualOn = Number(await redis.get(manualOnKey(conv.id)).catch(() => 0)) || 0;
    if (ultHumano?.at && Date.now() - new Date(ultHumano.at).getTime() < 72 * 3600_000 && new Date(ultHumano.at).getTime() > manualOn) {
      pausaSuperable = false;
      await logEvent('activador_respeta_pausa_humana', { conv: conv.id, setter: setter.id, humano_hace_h: Number(((Date.now() - new Date(ultHumano.at).getTime()) / 3600_000).toFixed(1)) }).catch(() => {});
    }
  }
  if (!opts.respetarPausaHumano && pausaSuperable) {
    await q(`UPDATE conversations SET bot_paused = false, paused_by = '', updated_at = now() WHERE id = $1`, [conv.id]);
    await cancelReactivate(conv.id);
    const eraPausa = conv.paused_by || 'auto';
    conv.bot_paused = false;
    await logEvent('activador_reanuda', { conv: conv.id, setter: setter.id, pausa_anterior: eraPausa, nota: 'la etiqueta manda sobre la pausa' });
  }
  if (conv.bot_paused || conv.stage === 'atencion_humana') {
    const motivo = conv.stage === 'atencion_humana' ? 'atencion_humana' : 'pausado';
    await logEvent('activador_bloqueado', { conv: conv.id, setter: setter.id, motivo });
    await activationLogStart(account, setter, conv, { tag, contexto, waitSeconds });
    await activationLogDone(conv.id, 'descartado', motivo);
    return 'bloqueado';
  }
  // la activación RECLAMA la conversación para este setter
  const setterPrevio = conv.setter_id; // (para no juntar esta activación con una pendiente de OTRO setter)
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

  // NOMBRE DEL LEAD: aquí la conversación puede NACER (no vino de un mensaje entrante), y sin nombre el
  // prompt aplica su «regla fija» de preguntarlo — que se come la única pregunta del turno y pisa las
  // instrucciones de la etiqueta ("entra retomando el precio, sin presentarte"). Lo rellenamos ANTES.
  if (!conv.lead_name && !esSim(contactId)) {
    try {
      const c = await ghl.getContact(account, contactId);
      const nombre = [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.name || c?.contactName || '';
      if (nombre) {
        await q(`UPDATE conversations SET lead_name = CASE WHEN lead_name = '' THEN $1 ELSE lead_name END WHERE id = $2`, [nombre, conv.id]);
        conv.lead_name = nombre;
      }
    } catch (err) {
      // sin bloquear la activación, pero CON rastro (throttle 1/min por cuenta)
      const fresh = await redis.set(`nomerr:${account.id}`, '1', 'EX', 60, 'NX').catch(() => null);
      if (fresh) await logEvent('error_nombre_contacto', { account: account.id, contactId, error: String(err.message || err).slice(0, 200) }).catch(() => {});
    }
  }

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
  // Si ya había una activación PENDIENTE (el lead pidió varias guías casi a la vez), se JUNTAN: un solo mensaje
  // que atiende todo, en vez de uno por petición.
  // Solo se juntan peticiones del MISMO setter que iban a responderse casi a la vez (horas objetivo a menos de 5 min)
  // y que no sean un rescate (el rescate lleva «nadie te respondió…», que no casa con un DM de workflow recién enviado).
  // En los demás casos gana la última, como siempre: una activación vieja de un job que falló no se arrastra, y una
  // instrucción «a la hora» no se ejecuta a los segundos por juntarse con otra.
  // Espera configurable tras la etiqueta antes de que el setter entre (mín. 3 s para que no sea instantáneo). Tope
  // normal 1 h; el GOTEO del rescate necesita esperas de horas → opts.maxEsperaS (el token del debounce vive 3 días y
  // ttlActivar escala con la espera, así que aguantan).
  const topeEsperaS = Math.max(3600, Math.min(Number(opts.maxEsperaS) || 3600, 172_800));
  const delayMs = Math.max(3, Math.min(Number(waitSeconds) || 0, topeEsperaS)) * 1000;
  const dueNueva = Date.now() + delayMs;
  let valorActivar = String(contexto || '').trim().slice(0, 1400);
  let juntada = false;
  const previaActivar = await redis.get(activarKey(conv.id)).catch(() => null);
  const previaDue = Number(await redis.get(activarAtKey(conv.id)).catch(() => 0)) || 0;
  const previaEsRescate = previaActivar ? Boolean(await redis.get(rescConvKey(conv.id)).catch(() => null)) : false;
  const juntable = previaActivar && previaActivar !== '1' && tag !== 'rescate' && !previaEsRescate
    && setterPrevio === setter.id && previaDue > 0 && Math.abs(dueNueva - previaDue) < 5 * 60_000;
  if (juntable) {
    if (!valorActivar || previaActivar.includes(valorActivar)) valorActivar = previaActivar; // nada nuevo: se conserva lo pendiente
    else {
      // se reserva sitio para lo nuevo sin recortar lo pendiente (que puede traer ya dos peticiones juntas)
      valorActivar = `${previaActivar.slice(0, Math.max(800, 3200 - valorActivar.length - 150))}\n\nADEMÁS, casi a la vez llegó otra petición de este mismo lead (atiéndelas JUNTAS en un solo mensaje, sin repetir saludo): ${valorActivar}`;
      juntada = true;
      await logEvent('activaciones_juntadas', { conv: conv.id, setter: setter.id, tag }).catch(() => {});
    }
  }
  await redis.set(activarKey(conv.id), valorActivar.slice(0, 3200) || '1', 'EX', ttlActivar);
  await redis.set(activarAtKey(conv.id), String(dueNueva), 'EX', ttlActivar).catch(() => {}); // hora objetivo de la respuesta
  // los RESCATES se re-chequean al disparar (con goteo de horas, un humano pudo atender entretanto)
  if (tag === 'rescate') await redis.set(rescConvKey(conv.id), '1', 'EX', ttlActivar);
  else await redis.del(rescConvKey(conv.id)).catch(() => {}); // una activación normal posterior pisa el marcador
  await logEvent('activador_externo', { conv: conv.id, setter: setter.id, contactId, canal: channel, mensajes_importados: ghlHistory.messages.length, espera_s: waitSeconds });
  await scheduleDebounce(merged, conv.id, delayMs);
  // registro en vivo (panel de Activaciones): esperando, con la hora objetivo real del temporizador
  await activationLogStart(account, setter, conv, { tag, contexto: juntada ? valorActivar : contexto, waitSeconds: delayMs / 1000, motivoPrevia: juntada ? 'juntada_con_la_siguiente' : 'reemplazada' });
  return 'activado';
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

      // (A) mensaje NUEVO que no teníamos → insertar con su fecha real para que el orden sea correcto.
      // Origen: GHL marca como 'app' tanto a una persona como las burbujas del PROPIO setter; las nuestras se
      // reconocen por la marca `sent:{id}` (24 h, sobrevive a borrar la conversación del panel).
      let origen = 'lead';
      if (m.direction !== 'inbound') {
        const nuestro = await redis.get(`sent:${m.id}`).catch(() => null);
        origen = nuestro ? 'bot' : (esOrigenAutomatico(m.source) ? 'automatizacion' : 'humano');
      }
      const r = await q(
        `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id, created_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
         ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [conv.id, m.direction, origen, m.body, String(m.id), when]
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
  await redis.set(`debat:${conversationId}`, String(Date.now() + delay), 'EX', 60 * 60 * 24 * 3).catch(() => {}); // instante objetivo (informativo)
  await debounceQueue.add('debounce', { conversationId, token }, { delay });
}

// ─── Mensajes salientes vistos por webhook (humano u otra automatización) ────

export async function handleOutboundEvent(account, evt) {
  if (evt.messageId && (await redis.get(`sent:${evt.messageId}`))) return; // lo enviamos nosotros
  if (!(await shouldCollect(account))) return; // recaudación off + bot off
  const channel = normalizeChannel(evt.channel);
  if (!channel) return;

  const body = String(evt.body || '').trim();

  // SIN TEXTO no seguimos, y se sale ANTES de tocar la base: los anti-ecos de abajo son POR TEXTO y
  // la pausa por intervención externa también los necesita. Un saliente sin body (adjunto de una
  // automatización, plantilla, evento fantasma de GHL) se saltaba todos los filtros y PAUSABA
  // conversaciones recién nacidas sin dejar ni una burbuja: el lead "entraba con el bot en pausa" y
  // el setter no hablaba nunca. Cuando esa salida estaba DESPUÉS del insert, cada evento fantasma
  // dejaba además una conversación huérfana —sin entrada, sin salida y sin un solo mensaje— que
  // engordaba el recuento de leads del panel: en Albatros eran 1.055 de 1.200 filas, y con ese
  // denominador la tasa de agenda parecía nueve veces peor de lo que era.
  if (!body) {
    const fresh = await redis.set(`outnobody:${account.id}`, '1', 'EX', 60, 'NX').catch(() => null);
    if (fresh) await logEvent('saliente_sin_texto_ignorado', { contacto: evt.contactId || null, canal: channel, messageId: evt.messageId || null, keys: Object.keys(evt || {}).slice(0, 20) }).catch(() => {});
    return;
  }

  // Si aún NO existe conversación en este canal (p. ej. una automatización escribe ANTES de que el
  // lead conteste, o escribe por un canal distinto al que ya teníamos), la creamos en vez de tirar el
  // mensaje: si no, ese saliente no aparecería en ninguna parte. No fijamos last_inbound_at (no ha
  // escrito el lead), así que la ventana de 24 h de Meta sigue mandando sobre si el bot puede o no.
  const conv = await one(
    `INSERT INTO conversations (account_id, ghl_contact_id, ghl_conversation_id, channel, lead_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET
       ghl_conversation_id = COALESCE(EXCLUDED.ghl_conversation_id, conversations.ghl_conversation_id),
       updated_at = now()
     RETURNING *`,
    [account.id, evt.contactId, evt.conversationId || null, channel, evt.contactName || '']
  );
  if (!conv) return;

  // ANTI-ECO: el guard `sent:` de arriba solo funciona si GHL nos devolvió el messageId al enviar.
  // Cuando no lo devuelve (o el envío falló tras entregar), el eco de NUESTRO PROPIO mensaje llegaría
  // como externo y —al pausar ahora con cualquier intervención externa— el setter se pausaría a sí
  // mismo. Dos redes: (1) la marca que processSend pone ANTES de enviar, consumida de forma atómica;
  // (2) respaldo por texto contra lo ya guardado.
  if (body) {
    // NO se consume la marca: se deja vivir su TTL para absorber TODOS los ecos de ese mismo texto
    // (GHL puede reemitir el evento, y si el envío falló tras entregar el job se reintenta y reenvía).
    // Con consumo de un solo uso, el segundo eco pausaba el bot. El riesgo de tragarse el mismo texto
    // escrito por un humano en esos minutos ya lo asumía el respaldo de abajo, con ventana más amplia.
    if (await redis.get(ecoKey(conv.id, body))) {
      // Era nuestro. El eco hace además de RED CONTABLE del envío ambiguo: si ghl.sendMessage lanzó
      // DESPUÉS de que GHL entregara (timeout/5xx/red), `sentjob` impide el reenvío y la fila nunca
      // se insertó — sin esto la burbuja entregada quedaba invisible (panel sin mensaje,
      // last_outbound_at viejo). Si processSend sí la guardó, el ON CONFLICT lo deja en nada.
      const yaGuardado = evt.messageId
        ? await one(`SELECT id FROM messages WHERE ghl_message_id = $1 LIMIT 1`, [evt.messageId])
        : await one(
            `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'
               AND btrim(body) = btrim($2) AND created_at >= now() - interval '15 minutes' LIMIT 1`,
            [conv.id, body]
          );
      if (!yaGuardado) {
        await q(
          `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id)
           VALUES ($1, 'outbound', 'bot', $2, $3)
           ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING`,
          [conv.id, body, evt.messageId || null]
        );
        await q(`UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
        await logEvent('eco_registro_envio_ambiguo', { conv: conv.id }).catch(() => {});
      }
      return;
    }
    const propio = await one(
      `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'
         AND source IN ('bot', 'seguimiento') AND btrim(body) = btrim($2)
         AND created_at >= now() - interval '15 minutes' LIMIT 1`,
      [conv.id, body]
    );
    if (propio) return;
  }

  // ORIGEN del saliente. OJO: `userId` NO sirve (GHL solo lo manda desde el panel web; desde el MÓVIL no viene).
  // Lo que sí sirve es `source`: el webhook OutboundMessage lo trae ('app' = persona en panel o móvil;
  // 'workflow', 'campaign', 'bulk_actions'… = automatización). Si no viene, se pregunta a GHL por el mensaje; y si
  // tampoco, un texto IDÉNTICO enviado a otros contactos en los últimos 30 días es una plantilla (lo que escribe
  // una persona es casi siempre único). Sin ninguna evidencia de automatización, es una persona.
  let pista = '';
  let esAuto = false;
  // Mientras se averigua el origen (consulta a GHL) y hasta que la pausa esté APLICADA, este saliente frena las
  // respuestas y los envíos del setter: outpendset:{conv} lleva un miembro por mensaje, así que un evento que se
  // resuelve antes no libera la espera de otro que sigue consultando.
  let pendId = null;
  try {
    if (body) {
      pista = String(evt.origen || '').toLowerCase();
      if (!pista && evt.messageId && !esSim(evt.contactId)) {
        // El webhook ya se contestó (se procesa después), así que se puede esperar: si GHL aún no tiene el mensaje
        // guardado cuando llega el evento, un segundo intento a los 3 s.
        pendId = String(evt.messageId);
        await redis.multi().sadd(outPendKey(conv.id), pendId).expire(outPendKey(conv.id), 45).exec().catch(() => {});
        for (let intento = 0; intento < 2 && !pista; intento++) {
          if (intento) await new Promise((r) => setTimeout(r, 3000));
          try { pista = String((await ghl.getMessage(account, evt.messageId))?.source || '').toLowerCase(); } catch { /* sin origen: heurística */ }
        }
        if (!pista) await logEvent('saliente_origen_desconocido', { conv: conv.id, messageId: evt.messageId }).catch(() => {});
      }
      esAuto = esOrigenAutomatico(pista);
      if (!pista && body.length >= 25) {
        const plantilla = await one(
          `SELECT 1 AS ok FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.account_id = $1 AND c.id <> $2 AND m.direction = 'outbound' AND m.source IN ('humano', 'automatizacion')
              AND btrim(m.body) = btrim($3) AND m.created_at >= now() - interval '30 days' LIMIT 1`,
          [account.id, conv.id, body]
        ).catch(() => null);
        if (plantilla) esAuto = true;
      }
      const origen = esAuto ? 'automatizacion' : 'humano';
      await one(
        `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id)
         VALUES ($1, 'outbound', $4, $2, $3)
         ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [conv.id, body, evt.messageId || null, origen]
      );
      await q(`UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
    }

    // PAUSA POR INTERVENCIÓN EXTERNA. Lo que llega aquí ya está filtrado (guard `sent:` + respaldo anti-eco por
    // texto): no lo mandó el setter. Se decide por el ORIGEN calculado arriba.
    if (account.auto_handoff) {
      // Una AUTOMATIZACIÓN (DM de workflow, campaña) no es nadie tomando la conversación: no pausa. Antes, como no
      // se distinguía, se pausaba con cualquier saliente ajeno y se eximía cuando el setter aún no había hablado —
      // y esa exención dejaba a Sofía contestar encima de Georgi cuando él escribía PRIMERO desde el móvil
      // (clientes del programa, leads antiguos, familia: 14 casos en 12 días en Despierta en Pareja).
      if (esAuto) {
        const fresh = await redis.set(`nopause:${conv.id}`, '1', 'EX', 600, 'NX').catch(() => null);
        if (fresh) await logEvent('externo_automatizacion_sin_pausa', { conv: conv.id, origen: pista || 'plantilla' }).catch(() => {});
        return;
      }
      // Una PERSONA escribió (panel o móvil): el setter se aparta SIEMPRE, haya hablado o no.
      // (sobre el estado ACTUAL de la fila: durante la consulta del origen pudo pausarse de otra forma y no se pisa)
      const pausada = await q(`UPDATE conversations SET bot_paused = true, paused_by = 'humano', updated_at = now() WHERE id = $1 AND NOT bot_paused RETURNING id`, [conv.id]);
      if (pausada.length) {
        await cancelBotJobs(conv.id);
        await logEvent('handoff_humano', { conversation: conv.id, userId: evt.userId || null, desde: evt.userId ? 'panel' : 'externo', origen: pista || 'desconocido' });
      }
      // reprograma la reactivación en cada mensaje humano (el reloj se reinicia)
      await scheduleReactivate(account, conv.id);
    }
  } finally {
    if (pendId) await redis.srem(outPendKey(conv.id), pendId).catch(() => {});
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
  await marcarReactivado(conversationId); // que la red de «una persona escribió hace poco» no deshaga esta reactivación
  await logEvent('bot_reactivado', { conversation: conversationId, motivo: 'tiempo sin mensaje humano' });
}

// ─── Citas del calendario (AppointmentCreate / Update / Delete) ─────────────

export async function handleAppointmentEvent(account, type, p) {
  const appt = p.appointment || p;
  const ghlId = appt.id || p.appointmentId || null;
  const contactId = String(appt.contactId || p.contactId || '');
  const calendarId = appt.calendarId || appt.calendar_id || p.calendarId || '';
  const statusRaw = String(appt.appointmentStatus || appt.status || '').toLowerCase();
  // NO ASISTIÓ ≠ CANCELÓ. Antes los dos caían en 'cancelado' y el setter no podía distinguirlos, que
  // es justo la diferencia comercial: quien anula puede haberse arrepentido, pero quien no se
  // presenta YA HABÍA DICHO QUE SÍ y solo hay que proponerle otra hora. En Albatros, de 151 citas
  // hay 100 canceladas y 3 no-shows, y a ninguno de los dos grupos le vuelve a escribir nadie.
  const noAsistio = ['noshow', 'no_show', 'no-show'].includes(statusRaw);
  const cancelled = type === 'AppointmentDelete' || noAsistio || ['cancelled', 'canceled', 'invalid'].includes(statusRaw);
  const status = noAsistio ? 'no_asistio' : (cancelled ? 'cancelado' : 'agendado');
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
    // Un contacto puede tener VARIAS conversaciones (una por canal), incluidas las que nacen de un
    // saliente suelto (un workflow que le escribe por SMS) sin que el lead haya hablado nunca ahí.
    // Elegimos por el criterio que DE VERDAD decide si la cita cuenta: que el setter sea DUEÑO del
    // calendario donde se reservó. Luego, que tenga setter; y por último la más reciente. Ordenar por
    // recencia (o por "tiene mensajes del lead") atribuía la cita a la conversación equivocada y se
    // perdía la agenda: ni entraba en appointments ni la conversación real pasaba a 'agendado'.
    const conv = contactId
      ? await one(
          `SELECT c.id, c.setter_id
             FROM conversations c LEFT JOIN setters s ON s.id = c.setter_id
            WHERE c.account_id = $1 AND c.ghl_contact_id = $2
            ORDER BY COALESCE(s.calendar_ids @> to_jsonb($3::text), false) DESC,
                     (c.setter_id IS NOT NULL) DESC,
                     EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id
                              AND (m.direction = 'inbound' OR m.source = 'bot')) DESC,
                     c.updated_at DESC
            LIMIT 1`,
          [account.id, contactId, calendarId || null]
        )
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
      // Que la cita no cuente como AGENDA del setter no significa que no haya pasado nada: el lead SÍ
      // reservó. Cortamos igualmente sus seguimientos para no perseguir a alguien que ya tiene cita
      // (el stage NO se toca, para no inflar las métricas del setter con una agenda que no es suya).
      if (conv?.id && status === 'agendado') await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id);
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
      const etapa = noAsistio ? 'no_asistio' : (cancelled ? 'agenda_cancelada' : 'agendado');
      await applyStage(conv, account, etapa,
        noAsistio ? 'no se presentó a la cita' : (cancelled ? 'cita cancelada en el calendario de GHL' : 'cita agendada en el calendario de GHL'));
      if (!cancelled) await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); // ya agendó: fuera seguimientos pendientes
    }
  }
  await logEvent(noAsistio ? 'cita_no_asistio' : (cancelled ? 'cita_cancelada' : 'cita_agendada'), {
    account: account.id, contactId, appointmentId: ghlId, startTime, statusRaw, tipo: type,
  });
}

// ─── Etiquetas ───────────────────────────────────────────────────────────────

// ─── 🛒 Compras (OrderStatusUpdate del marketplace / sincronización con la API de pedidos) ─────────
// Una sola definición de «cuenta como venta»: pedido en modo real, pagado y no anulado. Se guarda en la
// columna purchases.cuenta y TODAS las consultas (dashboard, pipeline, listados) usan esa columna.
const ESTADOS_ANULADOS = ['refunded', 'cancelled', 'canceled', 'voided', 'void', 'failed'];
const PAGOS_NO_VALIDOS = ['refunded', 'failed', 'void', 'voided', 'unpaid'];
export function pedidoCuenta(o) {
  if (o?.liveMode === false) return false;
  const est = String(o?.status || '').toLowerCase();
  const pay = String(o?.paymentStatus || '').toLowerCase();
  if (ESTADOS_ANULADOS.includes(est) || PAGOS_NO_VALIDOS.includes(pay)) return false;
  return pay === 'paid' || pay === 'partially_paid' || est === 'completed';
}

// Pedido de la API de GHL o del webhook OrderStatusUpdate → forma única. `source` solo con los campos que
// traen valor (vacío = {} para que un evento sin origen no pise el que ya teníamos).
export function normalizarPedido(o) {
  const items = (Array.isArray(o?.items) ? o.items : []).map((it) => ({
    name: String(it?.name || it?.product?.name || '').slice(0, 160),
    qty: Number(it?.qty) || 1,
    price: Number(it?.price?.amount ?? it?.amount ?? 0) || 0,
    product_id: String(it?.product?._id || it?.product?.id || it?.productId || ''),
  })).filter((i) => i.name || i.product_id);
  const src = {
    type: o?.source?.type || o?.sourceType || '', subType: o?.source?.subType || o?.sourceSubType || '',
    name: o?.source?.name || o?.sourceName || '', id: o?.source?.id || o?.sourceId || '',
  };
  const source = Object.fromEntries(Object.entries(src).filter(([, v]) => v));
  const meta = o?.source?.meta || o?.sourceMeta;
  if (meta && typeof meta === 'object' && Object.keys(meta).length) source.meta = meta;
  return {
    orderId: String(o?._id || o?.orderId || o?.id || ''),
    contactId: String(o?.contactId || o?.contact?.id || o?.contactSnapshot?.id || o?.contactSnapshot?._id || ''),
    status: String(o?.status || '').toLowerCase(),
    paymentStatus: String(o?.paymentStatus || '').toLowerCase(),
    liveMode: o?.liveMode !== false,
    amount: Number(o?.amount) || 0,
    currency: String(o?.currency || '').toUpperCase(),
    items,
    source,
    orderedAt: o?.createdAt || null,
  };
}

// Registra/actualiza un pedido y aplica sus consecuencias en el lead UNA sola vez:
//  · solo cuando el pedido EMPIEZA a contar como venta (o se atribuye por primera vez) se pone «comprador»
//    y se cortan los seguimientos. Un evento repetido o una sincronización no vuelven a sellar el status
//    ni pisan un cambio manual.
//  · si deja de contar (reembolso/cancelación) y el lead no tiene otra venta viva, se revierte a «en conversión».
//  · «atención humana» no se pisa: la compra queda registrada y visible, y lo decide la persona.
// La conversación destino es la ya atribuida al pedido (sticky); si no hay, la del contacto que habló con el
// setter (con mensajes del lead; nunca simulada). `atribuida` = la conversación ya existía cuando compró: es
// la que cuenta como venta del setter en el dashboard (una compra anterior a hablar con él solo informa).
export async function registrarCompra(account, o, opts = {}) {
  const orderId = String(o?.orderId || '');
  const contactId = String(o?.contactId || '');
  if (!orderId || !contactId) return { registrada: false, motivo: 'sin orderId o contactId' };
  const sync = opts.origen === 'sincronizacion';
  const cuenta = pedidoCuenta(o);
  const items = Array.isArray(o.items) ? o.items : [];
  const previa = await one(`SELECT id, conversation_id, cuenta FROM purchases WHERE account_id = $1 AND ghl_order_id = $2`, [account.id, orderId]);
  let conv = previa?.conversation_id ? await one(`SELECT * FROM conversations WHERE id = $1`, [previa.conversation_id]) : null;
  if (!conv) {
    conv = await one(
      `SELECT c.* FROM conversations c
        WHERE c.account_id = $1 AND c.ghl_contact_id = $2 AND NOT c.simulada
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')
        ORDER BY (c.setter_id IS NOT NULL) DESC, c.updated_at DESC
        LIMIT 1`,
      [account.id, contactId]
    );
  }
  const orderedAt = o.orderedAt && !Number.isNaN(new Date(o.orderedAt).getTime()) ? new Date(o.orderedAt) : new Date();
  const atribuida = Boolean(conv && new Date(conv.created_at) <= orderedAt);
  const fila = await one(
    `INSERT INTO purchases (account_id, conversation_id, setter_id, ghl_order_id, ghl_contact_id, amount, currency, status, payment_status, items, source, live_mode, cuenta, atribuida, origen, ordered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)
     ON CONFLICT (account_id, ghl_order_id) DO UPDATE SET
       status = EXCLUDED.status, payment_status = EXCLUDED.payment_status, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
       items = CASE WHEN jsonb_array_length(EXCLUDED.items) > 0 THEN EXCLUDED.items ELSE purchases.items END,
       source = CASE WHEN EXCLUDED.source <> '{}'::jsonb THEN EXCLUDED.source ELSE purchases.source END,
       live_mode = EXCLUDED.live_mode, cuenta = EXCLUDED.cuenta,
       atribuida = CASE WHEN purchases.conversation_id IS NOT NULL THEN purchases.atribuida ELSE EXCLUDED.atribuida END,
       conversation_id = COALESCE(purchases.conversation_id, EXCLUDED.conversation_id),
       setter_id = COALESCE(purchases.setter_id, EXCLUDED.setter_id),
       updated_at = now()
     RETURNING id, conversation_id`,
    [account.id, conv?.id || null, conv?.setter_id || null, orderId, contactId, Number(o.amount) || 0, String(o.currency || ''), String(o.status || ''), String(o.paymentStatus || ''),
     JSON.stringify(items), JSON.stringify(o.source || {}), o.liveMode !== false, cuenta, atribuida, opts.origen || 'webhook', orderedAt.toISOString()]
  );
  const empiezaAContar = cuenta && !previa?.cuenta;
  const recienAtribuida = cuenta && !previa?.conversation_id && Boolean(fila?.conversation_id);
  const dejaDeContar = !cuenta && Boolean(previa?.cuenta);
  // traza: siempre en tiempo real; en la sincronización solo lo que cambia algo (no inundar el registro)
  if (!sync || empiezaAContar || recienAtribuida || dejaDeContar) {
    await logEvent('compra_registrada', {
      account: account.id, contactId, orderId, status: o.status, pago: o.paymentStatus, cuenta, live: o.liveMode !== false,
      amount: Number(o.amount) || 0, currency: o.currency || '', productos: items.map((i) => i.name).filter(Boolean).slice(0, 5),
      conv: conv?.id || null, atribuida, nueva: !previa, origen: opts.origen || 'webhook',
    });
  }
  if (dejaDeContar && conv && conv.stage === 'comprador') {
    const otra = await one(`SELECT 1 AS ok FROM purchases WHERE conversation_id = $1 AND cuenta AND ghl_order_id <> $2 LIMIT 1`, [conv.id, orderId]);
    if (!otra) {
      await applyStage(conv, account, 'en_conversion', `pedido ${o.status || o.paymentStatus || 'anulado'}: venta revertida`.slice(0, 200));
      await logEvent('compra_revertida', { conv: conv.id, orderId, status: o.status, pago: o.paymentStatus });
    }
  }
  if (!cuenta) return { registrada: true, conversationId: conv?.id || null, cuenta: false };
  if (!conv) {
    if (!sync) await logEvent('compra_sin_lead', { account: account.id, contactId, orderId, nota: 'el contacto no ha hablado con el setter: la compra queda registrada y se enlazará si escribe' });
    return { registrada: true, conversationId: null, cuenta: true };
  }
  if (!(empiezaAContar || recienAtribuida)) return { registrada: true, conversationId: conv.id, cuenta: true, ya_aplicada: true };
  if (sync) {
    // Primera sincronización de un pedido ANTIGUO: si el status del lead cambió después de comprar (p. ej.
    // compró hace 80 días y luego agendó), ese status posterior manda y no se toca.
    const ult = await one(`SELECT MAX(created_at) AS at FROM stage_history WHERE conversation_id = $1`, [conv.id]).catch(() => null);
    if (ult?.at && new Date(ult.at) > orderedAt) {
      await logEvent('compra_status_conservado', { conv: conv.id, orderId, stage: conv.stage, nota: 'compra antigua (sincronización): el status del lead cambió después de comprar y se respeta' });
      return { registrada: true, conversationId: conv.id, cuenta: true };
    }
  }
  await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); // ya compró: fuera seguimientos pendientes
  if (conv.stage === 'atencion_humana') {
    await logEvent('compra_status_conservado', { conv: conv.id, orderId, stage: conv.stage, nota: 'compró mientras lo atiende una persona: no se mueve de «atención humana»' });
    return { registrada: true, conversationId: conv.id, cuenta: true };
  }
  const desc = items.map((i) => `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}`).filter(Boolean).join(', ');
  await applyStage(conv, account, 'comprador', `compró ${desc || 'un pedido'} por ${Number(o.amount) || 0} ${o.currency || ''}`.slice(0, 200));
  return { registrada: true, conversationId: conv.id, cuenta: true };
}

// Compra «fría»: el pedido llegó antes de que el contacto hablara con el setter. Cuando escribe, se enlaza a su
// conversación (se ve en el pipeline y el setter sabe que es cliente) pero NO cuenta como venta del setter.
async function enlazarComprasPrevias(account, conv) {
  if (!conv?.id || conv.simulada || esSim(conv.ghl_contact_id)) return;
  const filas = await q(
    `UPDATE purchases SET conversation_id = $1, setter_id = COALESCE(setter_id, $2), atribuida = false, updated_at = now()
      WHERE account_id = $3 AND ghl_contact_id = $4 AND conversation_id IS NULL
      RETURNING cuenta, ghl_order_id`,
    [conv.id, conv.setter_id || null, account.id, conv.ghl_contact_id]
  ).catch(() => []);
  if (!filas.length) return;
  await logEvent('compras_previas_enlazadas', { conv: conv.id, pedidos: filas.map((f) => f.ghl_order_id).slice(0, 10) });
  if (filas.some((f) => f.cuenta) && !['comprador', 'atencion_humana'].includes(conv.stage)) {
    await applyStage(conv, account, 'comprador', 'ya era cliente: compró antes de hablar con el setter');
    conv.stage = 'comprador';
  }
}

// Webhook OrderStatusUpdate (la app del marketplace lo envía con cada cambio de estado del pedido).
export async function handleOrderEvent(account, p) {
  const o = normalizarPedido(p);
  if (!o.orderId || !o.contactId) { await logEvent('compra_ignorada', { account: account.id, motivo: 'sin id de pedido o de contacto', campos: Object.keys(p || {}) }); return; }
  // El evento puede venir sin productos: se piden UNA vez por pedido (permiso payments/orders.readonly). Sin el
  // permiso no se reintenta durante 1 h (cada intento no debe quemar nada ni saturar la API).
  if (!o.items.length && pedidoCuenta(o) && !(await redis.get(`ordperm:${account.id}`).catch(() => null))) {
    const ya = await one(`SELECT jsonb_array_length(items) AS n FROM purchases WHERE account_id = $1 AND ghl_order_id = $2`, [account.id, o.orderId]).catch(() => null);
    if (!(Number(ya?.n) > 0)) {
      try {
        o.items = normalizarPedido(await ghl.getOrder(account, o.orderId)).items;
      } catch (err) {
        const st = Number(err?.status) || 0;
        if (st === 401 || st === 403) {
          await redis.set(`ordperm:${account.id}`, '1', 'EX', 3600).catch(() => {});
          await logEvent('compra_sin_productos', { account: account.id, orderId: o.orderId, status: st, nota: 'la app no tiene el permiso payments/orders.readonly en esta subcuenta: se registra la compra sin productos (vuelve a autorizar la app para verlos)' });
        } else {
          await logEvent('compra_sin_productos', { account: account.id, orderId: o.orderId, status: st, error: String(err.message).slice(0, 160) });
        }
      }
    }
  }
  return registrarCompra(account, o, { origen: 'webhook' });
}

// Lo que ya compró el lead (para que el setter no le venda lo que tiene y lo trate como cliente).
async function comprasDelLead(conv) {
  if (!conv?.ghl_contact_id) return [];
  try {
    return await q(
      `SELECT amount, currency, items, ordered_at FROM purchases
        WHERE account_id = $1 AND ghl_contact_id = $2 AND cuenta
        ORDER BY ordered_at DESC LIMIT 5`,
      [conv.account_id, conv.ghl_contact_id]
    );
  } catch {
    return [];
  }
}

export async function applyStage(conv, account, newStage, reason, syncGhl = true, opts = {}) {
  if (!STAGE_KEYS.includes(newStage) || conv.stage === newStage) return conv.stage;
  if (opts.cas) {
    // Cambio propuesto por el MODELO: compare-and-set sobre el status que se leyó al empezar. Si entretanto el
    // sistema puso otro (p. ej. «comprador» al llegar el pedido mientras el LLM pensaba), no se pisa.
    const noSi = Array.isArray(opts.noSi) ? opts.noSi : [];
    const upd = await q(
      `UPDATE conversations SET stage = $1, updated_at = now() WHERE id = $2 AND stage = $3${noSi.length ? ' AND NOT (stage = ANY($4::text[]))' : ''} RETURNING id`,
      noSi.length ? [newStage, conv.id, conv.stage, noSi] : [newStage, conv.id, conv.stage]
    );
    if (!upd.length) {
      await logEvent('status_no_aplicado', { conv: conv.id, propuesto: newStage, leido: conv.stage, motivo: 'el status cambió mientras se generaba la respuesta' }).catch(() => {});
      return conv.stage;
    }
  } else {
    await q(`UPDATE conversations SET stage = $1, updated_at = now() WHERE id = $2`, [newStage, conv.id]);
  }
  await q(`INSERT INTO stage_history (conversation_id, from_stage, to_stage, reason) VALUES ($1, $2, $3, $4)`, [
    conv.id, conv.stage, newStage, reason || '',
  ]);
  if (syncGhl && account.sync_tags && (account.location_id || account.pit_token) && !esSim(conv.ghl_contact_id)) {
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
  // 🧪 contacto simulado: sus «etiquetas de GHL» son las que puso el simulador (sin llamada ni caché)
  if (esSim(conv.ghl_contact_id)) return (await getSimTags(conv.account_id, conv.ghl_contact_id)).map((t) => String(t).trim().toLowerCase());
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
  // En un versus, una activación externa, o una PRUEBA por-setter, las etiquetas requeridas del setter
  // NO aplican (en la prueba la llave es la etiqueta de test; si no, el setter capta el lead y queda mudo).
  const inVersus = Boolean(conv.versus_id) || activacion;
  const required = (inVersus || account.test_by_setter) ? [] : norm(account.required_tags);
  const excluded = inVersus ? [] : norm(account.excluded_tags); // del setter (via merge) — sí se respeta en test
  const generalExclude = String(account.exclude_tag || '').trim().toLowerCase(); // de la conexión
  if (!needTest && !required.length && !excluded.length && !generalExclude) return true; // sin filtros
  if (!(account.location_id || account.pit_token)) return true; // sin GHL no podemos consultar etiquetas

  const tags = await getContactTags(account, conv);
  // OJO: null NO es "no pasa el filtro", es "no se ha podido comprobar" (GHL caído, límite de tasa,
  // 5xx). Devolverlo como false dejaba al lead mudo PARA SIEMPRE por un fallo de un segundo, sin
  // reintento y sin que nadie se enterara. Se distingue con 'error' para que quien llama reprograme,
  // igual que se hace cuando falta saldo en el marketplace.
  if (tags === null) return 'error';

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

// ── Filtro anti-repetición ───────────────────────────────────────────────────
// Red de seguridad para el caso «el setter contestó dos veces lo mismo»: se tiran las burbujas
// idénticas a otra de la MISMA tanda, o idénticas a un saliente RECIENTE. Reglas que lo mantienen
// inofensivo para las repeticiones LEGÍTIMAS:
//  · Igualdad normalizada (minúsculas, sin puntuación NI signos — «¿Te viene bien?» ≡ «Te viene
//    bien?»); una paráfrasis de verdad no se toca (eso lo cubre la regla de estilo del prompt).
//  · Contra el historial solo cuentan salientes del BOT de los últimos 15 minutos (la doble
//    respuesta ocurre en segundos; re-responder días después es normal) y de ≥15 chars.
//  · Las burbujas con URL nunca se filtran contra el historial: reenviar el enlace cuando el lead
//    lo vuelve a pedir es literal por diseño. (Dentro de su tanda una URL duplicada sí se tira.)
//  · Si TODO saldría filtrado se conserva la primera burbuja: jamás silencio total (la despedida
//    del handoff tiene que salir, y una activación «respondido» sin texto mentiría).
const normRep = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const MIN_REP_HISTORIA = 15;
const VENTANA_REP_MS = 15 * 60_000;
const tieneUrl = (s) => /https?:\/\/|www\./i.test(String(s || ''));
export function filtrarRepetidos(mensajes, history) {
  const ahora = Date.now();
  const recientes = new Set(
    (Array.isArray(history) ? history : [])
      .filter((m) => m.direction === 'outbound' && m.source !== 'humano')
      .filter((m) => !m.created_at || ahora - new Date(m.created_at).getTime() < VENTANA_REP_MS)
      .slice(-12)
      .map((m) => normRep(m.body))
      .filter((t) => t.length >= MIN_REP_HISTORIA)
  );
  const vistos = new Set();
  const unicos = [];
  const filtrados = [];
  const lista = Array.isArray(mensajes) ? mensajes : [];
  for (const msg of lista) {
    // burbujas que normalizan a vacío («...», «!!») se dejan pasar tal cual: no son repetición
    const k = normRep(msg) || `raw:${String(msg).trim()}`;
    const repEnTanda = vistos.has(k);
    const repEnHistoria = !tieneUrl(msg) && k.length >= MIN_REP_HISTORIA && recientes.has(k);
    if (repEnTanda || repEnHistoria) {
      filtrados.push(msg);
      continue;
    }
    vistos.add(k);
    unicos.push(msg);
  }
  if (!unicos.length && lista.length) {
    // todo era repetido: mejor UNA burbuja (la primera) que un silencio que rompe handoff/activación
    unicos.push(lista[0]);
    const i = filtrados.indexOf(lista[0]);
    if (i >= 0) filtrados.splice(i, 1);
  }
  return { unicos, filtrados };
}

// Consume un token de vigencia de forma atómica: solo UNA ejecución puede comprometerse a enviar,
// aunque dos jobs (o una re-ejecución por worker caído/stalled) pasaran la comprobación inicial.
async function consumeToken(key, token) {
  const script = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]) return 1 else return 0 end`;
  return (await redis.eval(script, 1, key, token)) === 1;
}
const consumeDebounceToken = (conversationId, token) => consumeToken(debKey(conversationId), token);

async function processDebounceInner(job) {
  const { conversationId, token } = job.data;
  if (token && token !== (await redis.get(debKey(conversationId)))) return; // job viejo
  await esperarOrigenPendiente(conversationId); // ¿acaba de escribir una persona? (se está consultando a GHL)

  const { conv, account, provider, history, variantId, setterId } = await loadContext(conversationId);
  if (!conv || !account) return;

  // ¿activación externa pendiente? → el setter escribe él solo (aunque el último mensaje sea nuestro).
  // El valor lleva su contexto ('1' = sin contexto). Se lee ANTES de los cortes de abajo para poder
  // CONSUMIRLA si el bot no puede atenderla: si la dejáramos viva, al reanudar el bot el siguiente
  // mensaje del lead se trataría como activación (saltándose modo test y etiquetas requeridas).
  const activarRaw = await redis.get(activarKey(conversationId));
  let activacion = Boolean(activarRaw);
  let activContexto = activarRaw && activarRaw !== '1' ? activarRaw : '';
  const descartarActivacion = async (motivo) => {
    if (!activacion) return;
    await redis.del(activarKey(conversationId));
    await redis.del(rescConvKey(conversationId));
    await logEvent('activacion_descartada', { conv: conv.id, motivo });
    await activationLogDone(conversationId, 'descartado', motivo);
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
  // 📣 RESCATE con goteo de horas: si ALGUIEN (humano o automatización) ya respondió al lead
  // durante la espera, el rescate sobra — sin este corte el setter escribiría encima con el
  // contexto «nunca te respondimos». Solo aplica a rescates: una activación normal por etiqueta
  // SÍ debe entrar aunque el workflow acabe de mandar un mensaje (ese es su flujo de siempre).
  if (activacion && (await redis.get(rescConvKey(conversationId)))) {
    const atendido = await one(`SELECT 1 AS ok FROM messages WHERE conversation_id = $1 AND direction = 'outbound' LIMIT 1`, [conversationId]);
    if (atendido) {
      await descartarActivacion('atendido_entretanto');
      return;
    }
  }
  // 🙋 RED DE SEGURIDAD: si una PERSONA escribió en esta conversación en las últimas 12 h (y nadie reactivó el
  // setter a mano después), el setter no entra aunque la pausa no se hubiera puesto (webhook perdido, mensaje
  // importado del historial…). Se pausa ahora, con rastro.
  if (account.auto_handoff) {
    const ultHumano = [...history].reverse().find(esHumanoFiable);
    if (ultHumano && Date.now() - new Date(ultHumano.created_at).getTime() < 12 * 3600_000) {
      const manualOn = Number(await redis.get(manualOnKey(conversationId)).catch(() => 0)) || 0;
      if (new Date(ultHumano.created_at).getTime() > manualOn) {
        const pausada = await q(`UPDATE conversations SET bot_paused = true, paused_by = 'humano', updated_at = now() WHERE id = $1 AND NOT bot_paused RETURNING id`, [conv.id]);
        if (pausada.length) await scheduleReactivate(account, conv.id); // política de la cuenta (0 min = hasta reactivar a mano)
        await logEvent('pausa_por_humano_reciente', { conv: conv.id, humano_hace_min: Math.round((Date.now() - new Date(ultHumano.created_at).getTime()) / 60000) });
        await descartarActivacion('humano_reciente');
        return;
      }
    }
  }

  // nada nuevo que responder (el último mensaje ya es nuestro)
  const lastMsg = history[history.length - 1];
  // 🔕 ACTIVACIÓN CON LA CONVERSACIÓN VIVA: si el setter habló hace menos de 3 h, una etiqueta nueva (p. ej. «no abrió
  // la guía» que salta cuando el lead ESCRIBIÓ en vez de pulsar el botón, o la 2.ª guía pedida seguida) no debe
  // generar otro mensaje. Si el lead tiene un mensaje sin contestar, se le responde como conversación normal (sin las
  // instrucciones de entrada de la etiqueta). El DATO de la etiqueta no se pierde: las activadoras de lead magnet ya
  // lo guardaron en el contexto del CTA; las demás, si la conversación ya tenía CTA, no (webhook con soloSiVacio),
  // así que se añade aquí al contexto como dato, no como orden.
  if (activacion) {
    const ultBot = [...history].reverse().find((m) => m.direction === 'outbound' && (m.source === 'bot' || m.source === 'seguimiento'));
    const ultLead = [...history].reverse().find((m) => m.direction === 'inbound');
    // «Viva» = el setter habló hace <3 h RESPONDIENDO (o el lead escribió en ese rato). Un seguimiento a un lead callado
    // no cuenta: una etiqueta de negocio que llega después («agendó», «abrió la guía») sí debe entrar.
    const viva = ultBot && Date.now() - new Date(ultBot.created_at).getTime() < 3 * 3600_000
      && (ultBot.source === 'bot' || (ultLead && Date.now() - new Date(ultLead.created_at).getTime() < 3 * 3600_000));
    if (viva) {
      if (activContexto) {
        const act = await one(
          `UPDATE conversations SET cta_context = left(COALESCE(cta_context, '') || $2, 3000)
            WHERE id = $1 AND COALESCE(cta_tag, '') <> '' AND position($3 in COALESCE(cta_context, '')) = 0 RETURNING cta_context`,
          [conv.id, ` Después llegó otra etiqueta del flujo (ya dentro de esta conversación; es un DATO, no la repitas ni vuelvas a presentarte): ${activContexto.slice(0, 1200)}`, activContexto.slice(0, 120)]
        ).catch(() => null);
        if (act) conv.cta_context = act.cta_context;
      }
      const pendiente = lastMsg && lastMsg.direction === 'inbound' && new Date(lastMsg.created_at) >= new Date(ultBot.created_at);
      if (!pendiente) { await descartarActivacion('conversacion_activa'); return; }
      // Absorber = responder como conversación normal. Si el setter solo puede hablar entrando por activación (modo
      // test o etiquetas requeridas), absorberla lo dejaría mudo: entonces sigue siendo activación, como antes.
      // Estricto (=== true): allowedByTags devuelve 'error' si GHL no deja leer las etiquetas, y eso no es permiso.
      if ((await allowedByTags(account, conv, false)) === true) {
        await redis.del(activarKey(conversationId)); await redis.del(rescConvKey(conversationId));
        await logEvent('activacion_absorbida', { conv: conv.id, nota: 'el lead tenía un mensaje sin contestar: se responde normal, sin la entrada de la etiqueta' });
        await activationLogDone(conversationId, 'descartado', 'absorbida_en_la_conversacion');
        activacion = false; activContexto = '';
      }
    }
  }
  if (!activacion && (!lastMsg || lastMsg.direction === 'outbound')) return;

  // Si venimos de una espera de INSERCIÓN, invalidamos la caché de etiquetas para leerlas FRESCAS:
  // el objetivo de la espera era dar tiempo a que la etiqueta se asignara, y la caché (60 s) la pobló
  // selectSetter con el estado anterior. Sin esto, una espera < 60 s no vería la etiqueta nueva.
  if (await redis.get(insFreshKey(conversationId))) {
    await redis.del(ctagsKey(conv));
    await redis.del(insFreshKey(conversationId));
  }

  const permiso = await allowedByTags(account, conv, activacion);
  if (permiso === 'error') {
    // No sabemos si el lead pasa el filtro: GHL no contestó. Antes esto se trataba como un "no" y el
    // lead se quedaba sin respuesta para siempre por un fallo pasajero. Se reprograma este mismo
    // ciclo (1 min, tope ~30 min) y solo se descarta si GHL sigue sin responder tras el tope.
    const intentos = await redis.incr(`tagerr:${conversationId}`);
    await redis.expire(`tagerr:${conversationId}`, 3600);
    if (intentos <= 30) {
      if (activacion) await redis.expire(activarKey(conversationId), 7200); // que no caduque esperando
      await scheduleDebounce(account, conversationId, 60_000);
      return;
    }
    await redis.del(`tagerr:${conversationId}`);
    await logEvent('etiquetas_ilegibles_lead_sin_atender', { conv: conv.id, contacto: conv.ghl_contact_id, nota: '30 min sin poder leer las etiquetas en GHL: se deja de reintentar' });
    await descartarActivacion('etiquetas_ilegibles');
    return;
  }
  await redis.del(`tagerr:${conversationId}`).catch(() => {});
  if (!permiso) {
    await logEvent('respuesta_omitida_por_etiqueta', { conv: conv.id, contacto: conv.ghl_contact_id, test_mode: account.test_mode, required_tags: account.required_tags, activacion });
    await descartarActivacion('filtro_etiqueta'); // borra activarKey + marca el registro (no dejar 'esperando' colgado)
    return;
  }

  // 🧪 en una simulación el horario activo no aplaza (se traza que lo habría hecho): la prueba es ahora
  let windowDelay = delayToActiveWindow(account);
  if (windowDelay > 0 && esSim(conv.ghl_contact_id)) {
    await logEvent('sim_horario_ignorado', { conv: conv.id, minutos: Math.round(windowDelay / 60000), nota: 'en producción esta respuesta esperaría a la apertura del horario activo' });
    windowDelay = 0;
  }
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
      await activationLogReschedule(conversationId, windowDelay / 1000); // temporizador correcto tras el aplazamiento
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

  // 💳 Puerta del Marketplace Disruptivo: si el cliente NO tiene el uso incluido y se ha quedado
  // sin saldo, no se atiende (y queda constancia para que el administrador le avise). Va ANTES de
  // la llamada al LLM: gastar tokens para un mensaje que no se puede cobrar es tirar dinero.
  // Fail-open por diseño: con la integración apagada o el marketplace mudo, se atiende igual.
  {
    const puerta = await puedeAtender(account).catch(() => ({ atender: true }));
    if (!puerta.atender && esSim(conv.ghl_contact_id)) {
      // 🧪 una simulación usa IA y se cobra como una conversación real: sin saldo no se atiende. Pero no
      // se queda 6 h reintentando en silencio: se descarta ya, con traza, para que el laboratorio lo enseñe.
      await q(`UPDATE conversations SET followup_state = 'sin_saldo', updated_at = now() WHERE id = $1`, [conv.id]);
      await logEvent('sim_sin_saldo_marketplace', { conv: conv.id, nota: 'sin saldo en el marketplace: la simulación no puede usar la IA (recarga y repite)' });
      await descartarActivacion('sin_saldo_marketplace');
      return;
    }
    if (!puerta.atender) {
      // El saldo lo comparten TODAS las apps del marketplace y se recarga en caliente: un «sin
      // fondos» suele ser transitorio. NO se descarta el mensaje ni la activación/rescate: se
      // reprograma este mismo ciclo cada 10 min (tope 6 h) y, si el cliente recarga, el lead recibe
      // su respuesta. Solo tras el tope se descarta, con traza.
      const reintentos = await redis.incr(`mdwait:${conversationId}`);
      await redis.expire(`mdwait:${conversationId}`, 12 * 3600);
      if (reintentos <= 36) {
        await q(`UPDATE conversations SET followup_state = 'sin_saldo', updated_at = now() WHERE id = $1`, [conv.id]);
        if (activacion) await redis.expire(activarKey(conversationId), 12 * 3600); // que no caduque esperando
        await scheduleDebounce(account, conversationId, 10 * 60_000);
        return;
      }
      await redis.del(`mdwait:${conversationId}`);
      await logEvent('marketplace_lead_sin_atender', { conv: conv.id, account: account.id, nota: '6 h sin saldo en el marketplace: se deja de reintentar esta respuesta' });
      await descartarActivacion('sin_saldo_marketplace');
      return;
    }
    await redis.del(`mdwait:${conversationId}`).catch(() => {});
  }

  const snapshotId = await lastInboundId(conversationId);
  let result;
  try {
    result = await generateReply({
      account, provider, conversation: conv, history,
      // La activación va por su propio canal (NO como followupInstruction): dentro del bloque de
      // seguimiento sus instrucciones quedaban diluidas y contradichas ("el lead dejó de responder…").
      activation: activacion ? { contexto: activContexto } : null,
      cita: await citaDelLead(conv),
      compras: await comprasDelLead(conv),
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
  const gasto = await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, esSim(conv.ghl_contact_id) ? 'simulador' : 'reply', variantId, setterId);
  const debugId = await saveLlmDebug({
    convId: conv.id,
    source: activacion ? 'activacion' : 'reply',
    result,
    activacion: activacion ? activContexto || '' : '',
    historyCount: Array.isArray(history) ? history.length : null,
    cost: gasto?.cost ?? null,
  });

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
  if (result.etiqueta) {
    // «comprador» y «agendado» los pone el SISTEMA por hechos (pedido pagado, cita reservada): el modelo no
    // los pisa con un «en_conversacion» porque el lead dijo «gracias». Solo un descarte o atención humana los mueven.
    const protegido = ['comprador', 'agendado'].includes(conv.stage) && !['descartado', 'atencion_humana'].includes(result.etiqueta);
    if (protegido) await logEvent('status_protegido', { conv: conv.id, actual: conv.stage, propuesto: result.etiqueta }).catch(() => {});
    else await applyStage(conv, account, result.etiqueta, result.motivo, true, { cas: true, noSi: ['descartado', 'atencion_humana'].includes(result.etiqueta) ? [] : ['comprador', 'agendado'] });
  }

  // 👋 Ya se presentó: fuera el «soy Sofía, la asistente virtual…» repetido (salvo que pregunten si es un bot).
  result.mensajes = quitarPresentacionRepetida(result.mensajes, history);

  // Anti-repetición SOLO dentro de la tanda (burbujas duplicadas de una misma llamada al LLM).
  // Contra el historial NO se filtra aquí a propósito: si el lead re-pregunta («¿cuánto me
  // dijiste?»), la re-respuesta es legítimamente idéntica y tirarla dejaría su pregunta sin
  // contestar — el eco entre tandas (doble ciclo) ya lo cortan las capas de dedupe del entrante.
  // El filtro garantiza al menos UNA burbuja: la despedida del handoff siempre sale.
  {
    const rep = filtrarRepetidos(result.mensajes, []);
    if (rep.filtrados.length) {
      await logEvent('respuesta_repetida_filtrada', {
        conv: conv.id, filtradas: rep.filtrados.length, enviadas: rep.unicos.length,
        ejemplos: rep.filtrados.slice(0, 3).map((t) => String(t).slice(0, 80)),
      });
      result.mensajes = rep.unicos;
    }
  }

  let cursor = 0;
  for (let i = 0; i < result.mensajes.length; i++) {
    cursor += typingDelayMs(result.mensajes[i], i);
    // bypassPause: los mensajes de despedida del handoff deben salir aunque el bot ya esté en pausa.
    // El gasto de la llamada LLM viaja SOLO en el primer mensaje de la tanda (una llamada = una tanda).
    await sendQueue.add(
      'send',
      {
        conversationId, body: result.mensajes[i], snapshotId, source: 'bot', bypassPause: result.handoff,
        gasto: i === 0 && (gasto || debugId) ? { pt: gasto?.pt, ct: gasto?.ct, usd: gasto?.cost, modelo: result.model || '', debugId } : null,
        deActivacion: Boolean(activacion) && i === 0,
      },
      { delay: cursor }
    );
  }
  if (activacion) {
    await redis.del(activarKey(conversationId)); // activación consumida
    await redis.del(rescConvKey(conversationId));
    await activationLogDone(conversationId, 'respondido', result.mensajes.join('\n')); // panel: el mensaje que respondió
  }

  if (result.handoff) {
    // Etiqueta VISIBLE «Requiere atención humana» + pausa; mientras la tenga, el bot no responde.
    await applyStage(conv, account, 'atencion_humana', result.motivo || 'la IA pidió atención humana');
    await q(`UPDATE conversations SET bot_paused = true, paused_by = 'ia', updated_at = now() WHERE id = $1`, [conv.id]);
    await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id);
    await logEvent('handoff_ia', { conv: conv.id, motivo: result.motivo });
  } else if (result.etiqueta === 'descartado') {
    // lead descartado: no programamos seguimientos ni lo perseguimos
    await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id);
  } else {
    await scheduleNextFollowup(account, { ...conv, followup_step: 0 }, cursor, horasAcordadas(result, account.timezone, history));
  }
}

export async function processSend(job) {
  const { conversationId, body, snapshotId, source, bypassPause, gasto, deActivacion } = job.data;

  // idempotencia: sendQueue reintenta (attempts: 2); si ya enviamos en el intento
  // anterior y falló solo la contabilidad, no volvemos a mandar el mensaje al lead
  const sentKey = `sentjob:${job.id}`;
  if (await redis.get(sentKey)) {
    // El mensaje YA salió en el intento anterior (que murió antes de contabilizar): no se reenvía,
    // pero el consumo SÍ se registra — si no, un reinicio del contenedor regalaba la conversación.
    try {
      const ctx = await loadContext(conversationId);
      if (ctx?.conv && ctx?.account) await registrarConsumo({ account: ctx.account, conversationId: ctx.conv.id });
    } catch { /* lo recoge el barrido */ }
    return;
  }

  await esperarOrigenPendiente(conversationId); // si una persona acaba de escribir, la pausa llega antes que la burbuja
  const { conv, account } = await loadContext(conversationId);
  if (!conv || !account) return;
  // Un descarte AQUÍ es silencioso para el resto del sistema: el seguimiento ya se marcó «enviado_N»
  // al encolarse y el panel lo enseña como entregado. Medido en Despierta en Pareja: 55 conversaciones
  // con «seguimiento #1 enviado» y CERO mensajes del bot. Así que todo descarte deja rastro y, si era
  // un seguimiento, corrige el estado a «no_entregado» para que nadie crea que el lead recibió algo.
  const descartado = async (motivo) => {
    await logEvent('envio_descartado', { conv: conv.id, motivo, source: source || 'bot', canal: conv.channel, body: String(body || '').slice(0, 80) }).catch(() => {});
    if (source === 'seguimiento') {
      await q(`UPDATE conversations SET followup_state = 'no_entregado', updated_at = now() WHERE id = $1`, [conv.id]).catch(() => {});
    }
  };
  if ((conv.bot_paused && !bypassPause) || !account.bot_enabled || !account.ai_enabled) { await descartado(conv.bot_paused ? 'conversacion_pausada' : 'ia_o_bot_apagado'); return; }
  if (snapshotId && (await lastInboundId(conversationId)) !== snapshotId) return; // el lead volvió a escribir: el ciclo normal responde
  // Burbuja IDÉNTICA a una que el setter mandó hace menos de 10 min y sin que el lead escribiera entre medias
  // (dos ciclos respondiendo a lo mismo): no se manda dos veces.
  if (source === 'bot' || source === 'seguimiento') {
    const dup = await one(
      `SELECT 1 AS ok FROM messages m WHERE m.conversation_id = $1 AND m.direction = 'outbound' AND m.source IN ('bot', 'seguimiento')
         AND btrim(m.body) = btrim($2) AND m.created_at >= now() - interval '10 minutes'
         AND NOT EXISTS (SELECT 1 FROM messages i WHERE i.conversation_id = $1 AND i.direction = 'inbound' AND i.created_at > m.created_at)
       LIMIT 1`,
      [conv.id, body]
    ).catch(() => null);
    if (dup) { await logEvent('envio_duplicado_evitado', { conv: conv.id, source, body: String(body || '').slice(0, 80) }).catch(() => {}); return; }
  }
  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    await logEvent('envio_descartado', { conv: conv.id, motivo: 'ventana_cerrada_al_enviar', source: source || 'bot', canal: conv.channel }).catch(() => {});
    // una activación al borde de la ventana: el panel ya decía 'respondido' pero el mensaje murió aquí
    if (deActivacion) {
      await activationLogDone(conv.id, 'descartado', 'ventana_cerrada_al_enviar').catch(() => {});
      await logEvent('activacion_ventana_cerrada_al_enviar', { conv: conv.id }).catch(() => {});
    }
    return;
  }
  // Marcamos el eco ANTES de enviar: si ghl.sendMessage LANZA después de que GHL ya entregó el mensaje
  // (timeout de 30 s, 5xx, corte de red) no se escribiría ni `sent:` ni la fila, el webhook nos
  // devolvería nuestro propio texto como intervención externa y el bot SE PAUSARÍA A SÍ MISMO.
  // TTL corto y consumo de un solo uso (si la petición nunca llegó, caduca sola).
  await markOwnOutbound(conv.id, body);
  // `sentjob` se marca ANTES del POST: si el envío entra en un estado AMBIGUO (timeout, 5xx, corte
  // de red — GHL pudo haber entregado), el reintento de BullMQ NO debe re-enviar: el lead recibiría
  // la misma burbuja dos veces. Solo si GHL RECHAZÓ en firme (4xx ≠ 408/429: seguro que no salió)
  // se libera la marca para que el reintento tenga sentido. Perder una burbuja en el caso ambiguo
  // es el precio de no duplicarla — y queda trazado.
  await redis.setex(sentKey, 3600, '1').catch(() => {});
  let res;
  const simulado = esSim(conv.ghl_contact_id);
  if (simulado) {
    // 🧪 SIMULACIÓN: el mensaje «sale» solo hacia la base de datos (nunca a GHL ni al lead) y queda trazado.
    // Todo lo anterior (pausa, ventana de Meta, snapshot) se ha comprobado igual que en producción.
    res = { messageId: null, simulado: true };
    await logEvent('sim_mensaje_enviado', { conv: conv.id, source: source || 'bot', body: String(body || '').slice(0, 160) }).catch(() => {});
  } else try {
    res = await ghl.sendMessage(account, { channel: conv.channel, contactId: conv.ghl_contact_id, message: body });
  } catch (err) {
    const st = Number(err?.status) || 0;
    const rechazoFirme = st >= 400 && st < 500 && st !== 408 && st !== 429;
    if (rechazoFirme || st === 429) {
      await redis.del(sentKey).catch(() => {}); // no salió: el reintento puede volver a intentarlo
      // Rechazo en firme (típico: Meta cierra la ventana aunque nuestro reloj la diera por abierta):
      // queda trazado y, si era un seguimiento, deja de figurar como entregado.
      if (rechazoFirme) await descartado(`rechazado_por_ghl_${st}`);
    } else {
      await logEvent('envio_ambiguo_no_reintentado', { conv: conv.id, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
      // Se asume entregado (por eso no se reintenta): el consumo se registra igual. Si de verdad no
      // salió, el eco del webhook no llegará y el administrador lo ve en el registro de eventos.
      try { await registrarConsumo({ account, conversationId: conv.id }); } catch { /* barrido */ }
    }
    throw err;
  }
  try {
    // Guardamos SIEMPRE que se pueda el id real de GHL: es lo que evita que el import de la activación
    // reimporte nuestro propio mensaje y lo re-etiquete como 'humano'. Cubrimos las variantes del payload.
    const ghlMessageId = res?.messageId || res?.messageIds?.[0] || res?.msg?.id || res?.message?.id || null;
    if (!ghlMessageId && !simulado) await logEvent('envio_sin_message_id', { conv: conv.id, keys: Object.keys(res || {}) });
    if (ghlMessageId) await redis.setex(`sent:${ghlMessageId}`, 86400, '1');
    await q(
      `INSERT INTO messages (conversation_id, direction, source, body, ghl_message_id, gasto_prompt_tokens, gasto_completion_tokens, gasto_usd, gasto_modelo, gasto_debug_id)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (ghl_message_id) WHERE ghl_message_id IS NOT NULL DO NOTHING`,
      [conv.id, source || 'bot', body, ghlMessageId, gasto?.pt ?? null, gasto?.ct ?? null, gasto?.usd ?? null, gasto?.modelo || null, gasto?.debugId ?? null]
    );
    await q(`UPDATE conversations SET last_outbound_at = now(), updated_at = now() WHERE id = $1`, [conv.id]);
  } catch (err) {
    // el mensaje YA salió: no relanzamos el job por un fallo de contabilidad
    await logEvent('error_contabilidad_envio', { conv: conv.id, error: err.message }).catch(() => {});
  }

  // 💳 SERVICIO ENTREGADO → se registra el consumo (Marketplace Disruptivo). Nunca antes de
  // enviar. La unidad es «una conversación por día natural»: el primer mensaje del día crea la
  // fila y encola el cobro; los siguientes no hacen ni una llamada (lo corta el event_id).
  // Va en try/catch mudo: un fallo aquí no puede afectar a un mensaje que el lead YA recibió.
  // 🧪 Las simulaciones que usan IA se cobran IGUAL que una conversación real (una conversación por día).
  try {
    await registrarConsumo({ account, conversationId: conv.id });
  } catch { /* lo recoge el barrido de marketplace.js */ }
}

// Última cita del lead, para que el modelo sepa que ya tiene hora (o que no se presentó) en vez de
// cualificarlo desde cero. Se busca por CONTACTO, no por conversación: la cita pudo reclamarse desde
// otro canal del mismo lead. Si falla, se devuelve null y el prompt sale como siempre.
async function citaDelLead(conv) {
  if (!conv?.ghl_contact_id) return null;
  try {
    return await one(
      `SELECT status, start_time, title FROM appointments
        WHERE account_id = $1 AND ghl_contact_id = $2
        ORDER BY COALESCE(start_time, created_at) DESC LIMIT 1`,
      [conv.account_id, conv.ghl_contact_id]
    );
  } catch {
    return null;
  }
}

// ─── Seguimientos ────────────────────────────────────────────────────────────

/**
 * Red de seguridad para los compromisos de tiempo. El modelo DEBERÍA rellenar proximo_contacto_horas
 * cuando le dice al lead cuándo le escribirá, pero el campo es opcional: si se lo deja en null, el
 * seguimiento cae a la cadencia configurada (8 h en Despierta en Pareja) y el mensaje sale mucho
 * antes de lo prometido — el lead lee «te escribo mañana» y le llegamos a las 8 horas, que es
 * exactamente lo que el cliente reportó una y otra vez. Aquí se lee el texto que se acaba de enviar
 * y se deduce el plazo prometido. Solo actúa como respaldo: si el modelo dio el dato, manda el suyo.
 */
// Promesa del SETTER de volver a escribir: futuro en primera persona dirigido al lead. «te escribo porque/para/por…»
// (el motivo), «hablamos» en pasado («lo que hablamos el martes»), «te aviso/te pregunto/te cuento» no son promesas.
// (?![a-záéíóúñ]) tras «escrib…»: sin la bandera u, «escribiré para…» se colaba por retroceso.
const VERBO_SETTER = /\b(?:(?:te|os)\s+(?:vuelvo\s+a\s+|volver[eé]\s+a\s+)?escrib(?:o|ir[eé]|iremos|ir)(?![a-záéíóúñ])(?!\s+(?:porque|para|por)\b)|vuelvo\s+a\s+escribir(?:te|os)|(?:te|os)\s+(?:contacto|busco|llamo)|(?:te|os)\s+(?:mando|digo)\s+(?:algo|un\s+mensaj)|(?<!(?:como|que|cuando|seg[uú]n)\s)hablamos|nos\s+leemos|retomamos|seguimos\s+hablando)/;
// Lo que pide o promete el LEAD sobre cuándo seguir («escríbeme la semana que viene», «te digo algo en unos días»).
const VERBO_LEAD = /\b(?:escr[ií]beme|escr[ií]bame|escr[ií]benos|me\s+escrib(?:es|as|ir[aá]s)|h[aá]blame|cont[aá]ctame|(?:te|os)\s+(?:digo|escribo|cuento|aviso|contesto|respondo|confirmo)|(?<!(?:como|que|cuando|seg[uú]n)\s)hablamos|lo\s+hablamos)/;
function horasPrometidasEnTexto(mensajes, timeZone, quien = 'setter') {
  const lista = Array.isArray(mensajes) ? mensajes : [String(mensajes || '')];
  // cada burbuja es su propia frase (una burbuja sin punto final no se funde con la siguiente)
  const t = lista.map((x) => String(x || '')).join('\n').toLowerCase();
  if (!t.trim()) return null;
  let horas = null;
  const anota = (h) => { if (Number.isFinite(h) && h > 0 && (horas === null || h > horas)) horas = h; };

  // números en cifra o en letra: «en 3 días», «en tres días», «dentro de un par de días», «en una semana»
  const NUM = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, 'un par de': 2, unos: 3, unas: 3 };
  const n = (s) => (/^\d+$/.test(s) ? Number(s) : NUM[s] ?? null);
  const CANT = '(\\d{1,2}|un par de|unos|unas|una|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
  const cuenta = (texto, unidad, mult, max = Infinity) => {
    for (const x of texto.matchAll(new RegExp(`\\b(?:en|dentro\\s+de)\\s+${CANT}\\s*${unidad}\\b`, 'g'))) { const v = n(x[1]); if (v && v * mult <= max) anota(v * mult); }
  };
  // «mañana» como DÍA («mañana por la tarde» también), no como franja: fuera «por la mañana», «esta mañana»…
  const MANANA = /(?<!por\s|de\s|esta\s|la\s|una\s|pasado\s)\bma[ñn]ana\b/;
  // El plazo cuenta si va en la MISMA cláusula que el verbo (entre comas, dos puntos o punto y coma): «te escribo desde el
  // equipo de Ana, el lunes empieza el reto» no promete nada.
  const clausulas = t.split(/(?<=[.!?])\s+|\n+/).flatMap((f) => f.split(/[,:;]/)).map((c) => c.trim()).filter(Boolean);
  let promesas;
  if (quien === 'lead') promesas = clausulas.filter((c) => VERBO_LEAD.test(c));
  else {
    // «El lunes te escribo para ver…», «Te escribo por aquí la semana que viene»: el plazo PEGADO al verbo es promesa
    // aunque luego venga un «para/por».
    const ESCRIBO = String.raw`(?:te|os)\s+(?:vuelvo\s+a\s+|volver[eé]\s+a\s+)?escrib(?:o|ir[eé]|iremos|ir)(?![a-záéíóúñ])`;
    const PLAZO = String.raw`(?:ma[ñn]ana|esta\s+(?:tarde|noche)|(?:el\s+pr[oó]ximo|este|el)\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|finde|fin\s+de\s+semana)|la\s+(?:semana\s+que\s+viene|pr[oó]xima\s+semana)|(?:en|dentro\s+de)\s+${CANT}\s*(?:horas?|d[ií]as?|semanas?)|(?:los|estos)\s+pr[oó]ximos\s+d[ií]as)`;
    const VERBO_PLAZO = new RegExp(String.raw`\b${PLAZO}\s+${ESCRIBO}|\b${ESCRIBO}(?:\s+por\s+aqu[ií])?\s+${PLAZO}`);
    promesas = clausulas.filter((c) => VERBO_SETTER.test(c) || VERBO_PLAZO.test(c));
  }
  // Una promesa CORTA explícita manda sobre cualquier plazo suelto (es lo único que el prompt deja prometer en los
  // canales con ventana). Dentro de una cláusula manda el MAYOR («¿se lo dices esta noche y te escribo mañana?» = 24:
  // la noche es del lead, la promesa es mañana); entre cláusulas, el menor.
  if (quien !== 'lead') {
    const cortas = promesas.map((f) => (MANANA.test(f) ? 24 : /\besta\s+noche\b/.test(f) ? 8 : /\besta\s+tarde\b/.test(f) ? 5 : null)).filter(Boolean);
    if (cortas.length) return Math.min(...cortas);
  }
  const p = promesas.join(' ; ');
  if (p) {
    cuenta(p, 'horas?', 1);
    cuenta(p, 'd[ií]as?', 24);
    cuenta(p, 'semanas?', 168);
    // rangos «en 2 o 3 días», «en 2-3 días»: manda el mayor
    for (const x of p.matchAll(new RegExp(String.raw`\b(?:en|dentro\s+de)\s+${CANT}\s*(?:o|-|a|y)\s*${CANT}\s*d[ií]as?\b`, 'g'))) { const v = Math.max(n(x[1]) || 0, n(x[2]) || 0); if (v) anota(v * 24); }
    if (/\b(?:los|estos)\s+pr[oó]ximos\s+d[ií]as\b/.test(p)) anota(72);
    // «el lunes», «el próximo viernes», «este finde»: horas hasta ese día, contando el día de HOY en la zona de la cuenta
    // (el contenedor corre en UTC: con getDay() el día cambiaba a las 2:00 en Madrid y a las 20:00 en Caracas)
    const tz = String(timeZone || '').trim() || 'Europe/Madrid';
    let hoy;
    try { hoy = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()).toLowerCase()]; } catch { /* zona inválida */ }
    if (hoy === undefined) hoy = new Date().getDay();
    const DIAS = { domingo: 0, lunes: 1, martes: 2, 'miércoles': 3, miercoles: 3, jueves: 4, viernes: 5, 'sábado': 6, sabado: 6 };
    for (const x of p.matchAll(/\b(el\s+pr[oó]ximo|este|el)\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/g)) {
      let dd = (DIAS[x[2]] - hoy + 7) % 7;
      if (dd === 0) { if (x[1] === 'este') continue; dd = 7; } // «este sábado» dicho en sábado es hoy
      anota(dd * 24);
    }
    const finde = p.match(/\b(este|el)\s+(?:finde|fin\s+de\s+semana)\b/);
    if (finde) {
      if (finde[1] === 'este' && (hoy === 6 || hoy === 0)) { if (hoy === 6) anota(24); } // ya es finde: cabe en hoy/mañana
      else anota((((6 - hoy + 7) % 7) || 7) * 24);
    }
    if (/\bpasado\s+ma[ñn]ana\b/.test(p)) anota(48);
    if (/\b(la\s+semana\s+que\s+viene|la\s+pr[oó]xima\s+semana)\b/.test(p)) anota(168);
  }
  if (quien === 'lead') return horas && horas > 24 ? horas : null; // del lead solo interesan los plazos largos
  // Sueltos (sin verbo de promesa): solo lo que cabe en la ventana, como siempre
  cuenta(t, 'horas?', 1, 24);
  if (MANANA.test(t)) anota(24);
  if (/\besta\s+tarde\b/.test(t)) anota(5);
  if (/\besta\s+noche\b/.test(t)) anota(8);
  return horas;
}

// Plazo acordado con el lead para el siguiente mensaje del setter:
//  · el dato del modelo (proximo_contacto_horas), salvo que el TEXTO que leyó el lead prometa algo más largo
//    («te escribo el lunes» con 24 h del modelo haría escribir el sábado);
//  · si el LEAD pidió o prometió un plazo largo en los mensajes que se acaban de contestar («escríbeme la semana que
//    viene», «te digo algo en unos días»), no se le escribe antes.
function horasAcordadas(result, timeZone, history = null) {
  const m = Number(result?.proximoContactoHoras) || null;
  const t = horasPrometidasEnTexto(result?.mensajes, timeZone);
  let h = m && t > 24 && t > m ? t : (m || t);
  if (Array.isArray(history) && history.length) {
    let i = history.length; while (i > 0 && history[i - 1]?.direction !== 'outbound') i--;
    const delLead = history.slice(i).filter((x) => x && x.direction === 'inbound').map((x) => String(x.body || ''));
    const pedidas = delLead.length ? horasPrometidasEnTexto(delLead, timeZone, 'lead') : null;
    if (pedidas && (!h || pedidas > h)) h = pedidas;
  }
  return h;
}

export async function scheduleNextFollowup(account, conv, extraMs = 0, acordadoHoras = null) {
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const next = steps[conv.followup_step || 0];
  if (!next || !next.hours) {
    // sin paso disponible (sin seguimientos configurados o cadena agotada) el compromiso no se puede
    // programar: al menos que quede TRAZADO — el prompt le prometió al modelo que se cumpliría
    if (acordadoHoras) await logEvent('seguimiento_acuerdo_sin_paso', { conv: conv.id, horas_acordadas: acordadoHoras });
    return;
  }
  let hours = Number(next.hours);
  let recorte = false;
  // La IA acordó un momento con el lead («te escribo mañana» → 24h): ese compromiso MANDA sobre la
  // cadencia configurada — escribir antes de lo prometido delata al bot y quema al lead.
  if (acordadoHoras) {
    let efectivas = acordadoHoras;
    if (WINDOWED_CHANNELS.includes(conv.channel)) {
      // La ventana de Meta (~24h) se mide desde el ÚLTIMO MENSAJE DEL LEAD, no desde ahora: el tope
      // es lo que quede de ventana. Si ya no queda hueco, programar el acuerdo sería un job condenado
      // (processFollowup lo bloquearía por ventana y se perdería en silencio): se cae a la cadencia
      // configurada y queda trazado.
      const desdeInboundH = conv.last_inbound_at ? (Date.now() - new Date(conv.last_inbound_at).getTime()) / 3_600_000 : 0;
      const restante = 23 - desdeInboundH;
      // Lo prometido va MÁS ALLÁ DE MAÑANA («te escribo en 3 días», «el lunes», «pasado mañana»): no cabe en la ventana
      // de Meta y escribir antes (a las 8 o a las 23 h) es incumplir la promesa, que es justo lo que el cliente
      // reporta. No se programa nada y se corta la cadena pendiente: el lead retoma cuando escriba (el prompt ya
      // prohíbe prometer más allá de «mañana»). «Mañana» a cualquier hora («mañana por la tarde» dicho a las 10:00
      // ≈ 30 h) SÍ es una promesa permitida: se programa recortada a la ventana, como siempre.
      let horaLocal = 12;
      try {
        const tz = String(account?.timezone || '').trim() || 'Europe/Madrid';
        const pz = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(new Date()).map((x) => [x.type, x.value]));
        horaLocal = Number(pz.hour) + Number(pz.minute) / 60;
      } catch { /* zona inválida: mediodía */ }
      const topeManana = Math.max(24, 48 - horaLocal); // hasta el final del día de mañana en la zona de la cuenta
      // Lo pactado cae mañana pero la ventana acaba HOY (el último mensaje del lead es de ayer, p. ej. prometiendo desde
      // un seguimiento o una activación): recortar sería escribirle hoy tras decirle «mañana». Tolerancia de 3 h.
      const hastaFinDeHoy = 24 - horaLocal;
      const restanteEnvio = account.followup_fit_window ? restante - 1 : restante; // el ajuste a ventana recorta 1 h más
      const saldriaHoy = acordadoHoras > hastaFinDeHoy && restanteEnvio < hastaFinDeHoy && acordadoHoras - restanteEnvio > 3;
      if (restante < 0.25 || acordadoHoras > topeManana || saldriaHoy) {
        await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); await redis.del(`fuat:${conv.id}`).catch(() => {});
        await logEvent('seguimiento_acuerdo_fuera_ventana', { conv: conv.id, horas_acordadas: acordadoHoras, ventana_restante_h: Number(Math.max(0, restante).toFixed(1)), nota: saldriaHoy ? 'la ventana acaba hoy y se prometió mañana' : 'no se escribe antes de lo prometido' });
        await q(`UPDATE conversations SET followup_state = 'acuerdo_fuera_ventana', updated_at = now() WHERE id = $1`, [conv.id]).catch(() => {});
        return;
      }
      efectivas = Math.min(acordadoHoras, restante);
      // Recorte REAL (más de 3 h antes de lo pactado: por debajo no lo nota nadie y disculparse
      // suena peor que callar). Se anota para que el mensaje no parezca una promesa incumplida.
      recorte = Boolean(efectivas) && acordadoHoras - efectivas > 3;
    }
    if (efectivas) {
      hours = efectivas;
      await logEvent('seguimiento_reprogramado_acuerdo', { conv: conv.id, horas_acordadas: acordadoHoras, horas_efectivas: Number(hours.toFixed(1)) });
    }
  }
  // ¿Cabe este paso en la ventana de mensajeria? Los pasos se cuentan desde el ENVIO anterior del bot
  // y se acumulan, asi que el segundo suele caer fuera de las ~23 h desde el ultimo mensaje del LEAD:
  // processFollowup lo marca 'ventana_cerrada' y muere sin reprogramarse. En Albatros eso son 627
  // primeros toques y CERO segundos. Con la bandera encendida, el paso se adelanta al ultimo hueco
  // util en vez de perderse. Apagada (por defecto en las 12 cuentas), nada cambia.
  if (account.followup_fit_window && WINDOWED_CHANNELS.includes(conv.channel) && conv.last_inbound_at) {
    const desdeInboundH = (Date.now() - new Date(conv.last_inbound_at).getTime()) / 3_600_000;
    const restante = 22 - desdeInboundH; // 22 y no 23: margen para el tecleo y la cola
    if (restante < 2) {
      // Menos de 2 h de hueco: adelantarlo mas seria un «¿sigues ahi?» a los minutos, que delata al
      // bot. Se deja morir, pero TRAZADO y con el estado visible en el panel.
      await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]).catch(() => {});
      await logEvent('seguimiento_no_cabe_en_ventana', { conv: conv.id, paso: conv.followup_step || 0, horas_pedidas: hours, ventana_restante_h: Number(Math.max(0, restante).toFixed(1)) });
      return;
    }
    if (hours > restante) {
      await logEvent('seguimiento_adelantado_a_ventana', { conv: conv.id, paso: conv.followup_step || 0, horas_pedidas: hours, horas_efectivas: Number(restante.toFixed(1)) });
      hours = restante;
      recorte = true; // el mensaje sale antes de lo previsto: que el modelo lo sepa
    }
  }
  const token = crypto.randomUUID();
  const delay = extraMs + hours * 3_600_000;
  // La marca vive atada a ESTE token: si luego se reprograma la cadena (el lead escribe, se agenda,
  // se corta…), el token cambia y la nota deja de aplicar sola. Y si no hay recorte, se limpia
  // cualquier marca vieja para que no la herede el siguiente seguimiento.
  if (recorte) {
    await redis.set(fuAdjKey(conv.id), JSON.stringify({ token }), 'EX', Math.ceil(delay / 1000) + 7200).catch(() => {});
  } else {
    await olvidarAjuste(conv.id);
  }
  // TTL del token en función del delay: con un acuerdo largo («en un mes» = 720h) el TTL fijo de
  // 30 días caducaba justo antes de disparar y el job se descartaba como viejo.
  await redis.set(fuKey(conv.id), token, 'EX', Math.max(60 * 60 * 24 * 30, Math.ceil(delay / 1000) + 86_400));
  await redis.set(`fuat:${conv.id}`, String(Date.now() + delay), 'EX', Math.max(60 * 60 * 24 * 30, Math.ceil(delay / 1000) + 86_400)).catch(() => {});
  await followupQueue.add('followup', { conversationId: conv.id, token }, { delay });
}

/**
 * Nota para el modelo cuando este seguimiento sale ANTES de lo que se pactó con el lead (el acuerdo
 * no cabía en la ventana de mensajería). Solo se aplica si la marca corresponde a ESTE job (token).
 * NO borra la marca: eso se hace cuando el envío ya está comprometido, para que un reintento por
 * error del modelo no mande el mensaje sin la nota.
 */
async function instruccionConAjuste(conversationId, token, instruccion) {
  try {
    const raw = await redis.get(fuAdjKey(conversationId));
    if (!raw) return instruccion;
    const marca = JSON.parse(raw);
    if (!token || marca.token !== token) return instruccion; // era de otro acuerdo: se ignora
    return `${instruccion}
AVISO — ESTE LEAD NO TE IGNORÓ: te pidió que le escribieras más adelante y le estás escribiendo ANTES de ese momento. Por eso: (a) NO le reproches silencio ni digas nada parecido a «vi que no me has contestado» ni «como no me decías nada»; (b) lo más seguro es NO mencionar ningún plazo y entrar directo a su tema, con calidez y sin prisa; (c) si aun así lo mencionas, media línea y sin dar explicaciones ni hablar de horarios, sistemas ni límites de la aplicación; (d) jamás digas «como te prometí» ni des por pasado el tiempo que acordasteis.`;
  } catch {
    return instruccion;
  }
}

async function rearmFollowup(conversationId, delayMs) {
  const token = crypto.randomUUID();
  await redis.set(fuKey(conversationId), token, 'EX', 60 * 60 * 24 * 30);
  await redis.set(`fuat:${conversationId}`, String(Date.now() + delayMs), 'EX', 60 * 60 * 24 * 30).catch(() => {});
  await followupQueue.add('followup', { conversationId, token }, { delay: delayMs });
}

// 🧪 Simulador: dispara AHORA el siguiente paso de seguimiento de la conversación (mismo processFollowup
// que en producción, con todos sus cortes: lead que ya respondió, ventana de Meta, chequeo IA…). Devuelve
// false si la cadena no puede continuar (sin pasos configurados o cadena agotada).
export async function forzarSeguimientoAhora(conversationId) {
  const { conv, account, provider, history } = await loadContext(conversationId);
  if (!conv || !account) return { ok: false, motivo: 'conversación no encontrada' };
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const step = conv.followup_step || 0;
  if (!steps[step]) return { ok: false, motivo: steps.length ? `cadena agotada (${steps.length} pasos ya enviados)` : 'el setter no tiene seguimientos configurados' };
  // Los cortes DETERMINISTAS de processFollowup, aquí con motivo (allí son returns mudos). Los que dependen del
  // momento (ventana de Meta, chequeo IA, filtro de etiquetas) se dejan al motor para que la traza los enseñe.
  if (!account.ai_enabled || !account.bot_enabled) return { ok: false, motivo: 'la IA o el bot están apagados' };
  if (conv.bot_paused) return { ok: false, motivo: `el bot está en pausa (${conv.paused_by || 'auto'})` };
  if (conv.stage === 'atencion_humana') return { ok: false, motivo: 'la conversación requiere atención humana' };
  if (['descartado', 'agendado', 'comprador'].includes(conv.stage)) return { ok: false, motivo: `estado «${conv.stage}»: la cadena de seguimientos está cortada` };
  if (!provider) return { ok: false, motivo: 'sin proveedor de IA' };
  if (await redis.get(activarKey(conversationId))) return { ok: false, motivo: 'hay una activación en cola: primero tiene que responder' };
  if (await redis.get(debKey(conversationId))) return { ok: false, motivo: 'hay una respuesta en cola: primero tiene que salir' };
  const ultimo = Array.isArray(history) && history.length ? history[history.length - 1] : null;
  if (!ultimo) return { ok: false, motivo: 'la conversación aún no tiene mensajes: un seguimiento retoma algo ya hablado' };
  if (ultimo.direction === 'inbound') return { ok: false, motivo: 'el último mensaje es del lead: eso lo responde el ciclo normal, no un seguimiento' };
  if (conv.last_inbound_at && conv.last_outbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) return { ok: false, motivo: 'el lead respondió después del último mensaje del setter' };
  await olvidarAjuste(conversationId);
  await rearmFollowup(conversationId, 300);
  return { ok: true, paso: step + 1, horas_configuradas: Number(steps[step].hours) || 0 };
}

// 🧪 Simulador: acelera la respuesta pendiente (debounce o activación) a unos segundos. Reprograma con un
// token nuevo: el job largo original muere solo al despertar. No se salta ninguna comprobación.
export async function acelerarRespuesta(conversationId, delayMs = 2500) {
  const { conv, account } = await loadContext(conversationId);
  if (!conv || !account) return false;
  await redis.del(ctaKey(conversationId)); // la espera de inserción/CTA ya quedó trazada; no la arrastramos
  await scheduleDebounce(account, conversationId, delayMs);
  return true;
}

async function processFollowupInner(job) {
  const { conversationId, token } = job.data;
  if (token && token !== (await redis.get(fuKey(conversationId)))) return; // cancelado o reprogramado

  const { conv, account, provider, history, variantId, setterId } = await loadContext(conversationId);
  if (!conv || !account || !provider) return;
  if (!account.ai_enabled || !account.bot_enabled || conv.bot_paused) return;
  if (conv.stage === 'atencion_humana') return; // requiere atención humana → sin seguimientos

  // Gate duro por estado (sin coste): descartado (fuera) o agendado (objetivo cumplido) → nunca.
  // El resto (en_conversion, calificado, etc.) lo decide el chequeo IA leyendo los mensajes,
  // porque un lead que pidió el enlace pero se quedó callado sí conviene retomarlo.
  if (['descartado', 'agendado', 'comprador'].includes(conv.stage)) {
    await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); // cortar la cadena de seguimientos
    return;
  }
  const steps = Array.isArray(account.followups) ? account.followups : [];
  const step = conv.followup_step || 0;
  const stepConf = steps[step];
  if (!stepConf) return;

  // si el lead respondió después del último envío, el ciclo normal ya se encarga
  if (conv.last_inbound_at && conv.last_outbound_at && new Date(conv.last_inbound_at) > new Date(conv.last_outbound_at)) return;

  // 💳 Puerta del marketplace ANTES de allowedByTags: el gate es barato (cacheado) y la comprobación
  // de etiquetas cuesta una llamada a GHL — no se gasta en un cliente sin saldo. Sin saldo se aplaza
  // el toque 30 min (borrar fuKey mataba la cadena para siempre: el lead, por definición, no va a
  // escribir). Tope de 12 aplazamientos (6 h): un cliente que nunca recarga no puede dejar cientos
  // de seguimientos girando indefinidamente. Al agotarlo se corta la cadena con traza.
  {
    const puerta = await puedeAtender(account).catch(() => ({ atender: true }));
    if (!puerta.atender && esSim(conv.ghl_contact_id)) {
      // 🧪 simulación sin saldo: se corta ya con traza (no 6 h de aplazamientos mudos)
      await q(`UPDATE conversations SET followup_state = 'sin_saldo', updated_at = now() WHERE id = $1`, [conv.id]);
      await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id);
      await logEvent('sim_sin_saldo_marketplace', { conv: conv.id, nota: 'sin saldo en el marketplace: el seguimiento simulado no puede usar la IA' });
      return;
    }
    if (!puerta.atender) {
      const esperas = await redis.incr(`mdfuwait:${conversationId}`);
      await redis.expire(`mdfuwait:${conversationId}`, 24 * 3600);
      await q(`UPDATE conversations SET followup_state = 'sin_saldo', updated_at = now() WHERE id = $1`, [conv.id]);
      if (esperas <= 12) {
        await rearmFollowup(conversationId, 30 * 60_000);
        return;
      }
      await redis.del(`mdfuwait:${conversationId}`);
      await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id);
      await logEvent('marketplace_seguimiento_detenido', { conv: conv.id, account: account.id, nota: '6 h sin saldo en el marketplace: se corta la cadena de seguimientos (se reanuda si el lead escribe)' });
      return;
    }
    await redis.del(`mdfuwait:${conversationId}`).catch(() => {});
  }

  // 🙋 una persona escribió hace menos de 12 h (y nadie reactivó a mano): ningún seguimiento automático encima
  if (account.auto_handoff) {
    const ultHumano = [...history].reverse().find(esHumanoFiable);
    const manualOn = Number(await redis.get(manualOnKey(conversationId)).catch(() => 0)) || 0;
    if (ultHumano && Date.now() - new Date(ultHumano.created_at).getTime() < 12 * 3600_000 && new Date(ultHumano.created_at).getTime() > manualOn) {
      await logEvent('seguimiento_omitido_humano_reciente', { conv: conv.id });
      return;
    }
  }
  const permisoFu = await allowedByTags(account, conv);
  if (permisoFu === 'error') {
    // No se han podido leer las etiquetas: NO se manda a ciegas (el contacto podría llevar "sin-ia"),
    // pero tampoco se mata la cadena por un fallo pasajero de GHL. Se reintenta en 10 min.
    const fallos = await redis.incr(`tagerrfu:${conversationId}`);
    await redis.expire(`tagerrfu:${conversationId}`, 12 * 3600);
    if (fallos <= 6) { await rearmFollowup(conversationId, 10 * 60_000); return; }
    await redis.del(`tagerrfu:${conversationId}`);
    await logEvent('etiquetas_ilegibles_seguimiento_detenido', { conv: conv.id, nota: '1 h sin poder leer las etiquetas en GHL: se corta esta cadena de seguimientos' });
    return;
  }
  await redis.del(`tagerrfu:${conversationId}`).catch(() => {});
  if (!permisoFu) return;

  if (windowBlocked(conv)) {
    await q(`UPDATE conversations SET followup_state = 'ventana_cerrada', updated_at = now() WHERE id = $1`, [conv.id]);
    // trazado: antes era silencioso y un seguimiento (o un compromiso «te escribo mañana») podía
    // perderse sin que nadie lo viera en el Registro de eventos
    await logEvent('seguimiento_ventana_cerrada', { conv: conv.id, canal: conv.channel });
    return;
  }
  const windowDelay = esSim(conv.ghl_contact_id) ? 0 : delayToActiveWindow(account); // 🧪 la simulación no espera al horario
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
    if (decision.usage) await recordUsage(conv.account_id, conv.id, provider, decision.model, decision.usage, esSim(conv.ghl_contact_id) ? 'simulador' : 'seguimiento', variantId, setterId);
    if (!decision.seguir) {
      await logEvent('followup_omitido_ia', { conv: conv.id, stage: conv.stage, motivo: decision.motivo || '' });
      await q(`UPDATE conversations SET followup_state = 'detenido_ia', updated_at = now() WHERE id = $1`, [conv.id]);
      await redis.del(fuKey(conv.id)); await olvidarAjuste(conv.id); // parar la cadena (el ciclo normal la reanuda si el lead escribe)
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
      followupInstruction: await instruccionConAjuste(conversationId, token, stepConf.instruction || 'Retoma la conversación de forma breve y amable.'),
      followupNumber: step + 1,
      cita: await citaDelLead(conv),
      compras: await comprasDelLead(conv),
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
  const gastoFu = await recordUsage(conv.account_id, conv.id, provider, result.model, result.usage, esSim(conv.ghl_contact_id) ? 'simulador' : 'seguimiento', variantId, setterId);
  const debugIdFu = await saveLlmDebug({
    convId: conv.id, source: 'seguimiento', result,
    historyCount: Array.isArray(history) ? history.length : null,
    cost: gastoFu?.cost ?? null,
  });

  // ¿el lead respondió mientras generábamos? → el ciclo normal (debounce) responde; este seguimiento sobra
  if ((await lastInboundId(conversationId)) !== snapshotId) return;

  result.mensajes = quitarPresentacionRepetida(result.mensajes, history); // 👋 ya se presentó

  // Anti-repetición CON historial solo aquí: en un seguimiento el lead NO ha escrito desde nuestro
  // último mensaje, así que un toque que calca el anterior jamás es una re-respuesta pedida — es el
  // modelo repitiéndose. El filtro garantiza al menos UNA burbuja, así que el followup_state
  // «enviado_N» nunca miente.
  {
    const rep = filtrarRepetidos(result.mensajes, history);
    if (rep.filtrados.length) {
      await logEvent('respuesta_repetida_filtrada', {
        conv: conv.id, origen: 'seguimiento', filtradas: rep.filtrados.length, enviadas: rep.unicos.length,
        ejemplos: rep.filtrados.slice(0, 3).map((t) => String(t).slice(0, 80)),
      });
      result.mensajes = rep.unicos;
    }
  }

  // Compromiso de envío ATÓMICO (mismo patrón que el debounce): si el worker cayó tras encolar y
  // BullMQ re-ejecuta este job, el token ya no está y la re-ejecución muere aquí en vez de mandar
  // la tanda de seguimiento DOS veces.
  if (token && !(await consumeToken(fuKey(conversationId), token))) return;
  await olvidarAjuste(conversationId); // el mensaje ya sale: la nota queda consumida

  let cursor = 0;
  for (let i = 0; i < result.mensajes.length; i++) {
    cursor += typingDelayMs(result.mensajes[i], i);
    await sendQueue.add('send', {
      conversationId, body: result.mensajes[i], snapshotId, source: 'seguimiento',
      gasto: i === 0 && (gastoFu || debugIdFu) ? { pt: gastoFu?.pt, ct: gastoFu?.ct, usd: gastoFu?.cost, modelo: result.model || '', debugId: debugIdFu } : null,
    }, { delay: cursor });
  }

  const newStep = step + 1;
  await q(`UPDATE conversations SET followup_step = $1, followup_state = $2, updated_at = now() WHERE id = $3`, [
    newStep, `enviado_${newStep}`, conv.id,
  ]);
  if (conv.stage === 'calificado' || conv.stage === 'seguimiento_calificado') {
    // estaba calificado pero no agendó → seguimiento específico de calificación
    await applyStage(conv, account, 'seguimiento_calificado', `seguimiento #${newStep} (calificado sin agendar)`, true, { cas: true, noSi: ['comprador', 'agendado'] });
  } else if (!['en_conversion', 'descartado', 'agendado', 'agenda_cancelada', 'comprador'].includes(conv.stage)) {
    await applyStage(conv, account, 'en_seguimiento', `seguimiento #${newStep} enviado`, true, { cas: true, noSi: ['comprador', 'agendado'] });
  }
  // un seguimiento también puede prometer tiempo («te escribo mañana») → se respeta en el siguiente
  await scheduleNextFollowup(account, { ...conv, followup_step: newStep }, cursor, horasAcordadas(result, account.timezone, history));
}

// 🧪 SIMULADOR: en producción una salida temprana del debounce/seguimiento (bot apagado, filtro, ventana cerrada,
// lead que ya respondió…) deja el token vivo días y no pasa nada. En el laboratorio ese token se leía como
// «en cola» para siempre. Solo en simulaciones: si al terminar el token sigue siendo EL DE ESTE JOB (nadie
// reprogramó ni consumió), se suelta con compare-and-delete y queda trazado. Producción no cambia.
async function esConvSim(conversationId) {
  const row = await one(`SELECT ghl_contact_id FROM conversations WHERE id = $1`, [conversationId]).catch(() => null);
  return Boolean(row && esSim(row.ghl_contact_id));
}
export async function processDebounce(job) {
  await processDebounceInner(job);
  const { conversationId, token } = job.data || {};
  if (!token || !conversationId) return;
  if ((await redis.get(debKey(conversationId))) !== token) return; // reprogramado o consumido: nada que soltar
  if (!(await esConvSim(conversationId))) return;
  if (await consumeToken(debKey(conversationId), token)) {
    await redis.del(`debat:${conversationId}`).catch(() => {});
    await logEvent('sim_respuesta_no_generada', { conv: conversationId, nota: 'el motor terminó este ciclo sin responder (mira el motivo en la traza: apagado, filtro, ventana, sin proveedor, o el último mensaje ya era del setter)' });
  }
}
export async function processFollowup(job) {
  await processFollowupInner(job);
  const { conversationId, token } = job.data || {};
  if (!token || !conversationId) return;
  if ((await redis.get(fuKey(conversationId))) !== token) return;
  if (!(await esConvSim(conversationId))) return;
  if (await consumeToken(fuKey(conversationId), token)) {
    await redis.del(`fuat:${conversationId}`).catch(() => {});
    await olvidarAjuste(conversationId);
    await logEvent('sim_seguimiento_omitido', { conv: conversationId, nota: 'el motor cortó este seguimiento sin enviarlo (lead que ya respondió, estado, filtro de etiquetas, bot en pausa o sin proveedor)' });
  }
}
