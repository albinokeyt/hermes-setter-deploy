// 🧪 SIMULADOR (laboratorio del setter). Dos laboratorios:
//  1) Etiquetas y seguimientos: se crea un lead FICTICIO («sim:…») que recorre el motor REAL de producción:
//     el mismo webhook de etiquetas (contexto del CTA, activación con su espera), el mismo debounce y la misma
//     generación, la misma ventana de 24 h de Meta y los mismos seguimientos. Lo único distinto: los mensajes
//     no salen hacia GHL/Meta (se guardan y se ven aquí) y las esperas largas se pueden acelerar a unos
//     segundos. 💳 Si la prueba usa IA se COBRA del crédito del marketplace igual que una conversación real
//     (una conversación por día); sin saldo, no se atiende. Así se comprueba que el setter coge bien las etiquetas, el contexto
//     de cada CTA, y que los seguimientos y las respuestas salen con ese contexto.
//  2) Preguntas sobre lead magnets: tanda de preguntas (con o sin etiqueta de CTA) contra el setter, con
//     comprobaciones automáticas (¿menciona el material correcto?, ¿pregunta «cuál»?, ¿confunde con otro?).
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { redis } from '../lib/redis.js';
import { esSim, nuevoIdSim, getSimTags, setSimTags, borrarSimTags } from '../lib/sim.js';
import { normTag, tagsDeLeadMagnet } from '../lib/tags.js';
import { handleTagActivation } from './webhooks.js';
import { handleInbound, mergeSetter, forzarSeguimientoAhora, acelerarRespuesta, logEvent, recordUsage, filtrarRepetidos } from '../services/pipeline.js';
import { generateReply } from '../services/agent.js';
// 💳 Las pruebas que usan IA se cobran del crédito del marketplace como una conversación real.
import { puedeAtender, registrarConsumo } from '../services/marketplace.js';
import { requireManageAgents, canAccessAccount } from '../lib/session.js';

const VENTANAS = { nunca: null, abierta: "now() - interval '5 minutes'", cerrada: "now() - interval '25 hours'" };

function fichaLm(l) {
  return [l.name ? `El lead pidió «${l.name}»${l.keyword ? ` (comentó «${l.keyword}»)` : ''}.` : '', l.promise, l.details].filter(Boolean).join(' ').slice(0, 1500);
}
function resumenSetter(s) {
  return {
    id: s.id, name: s.name, is_default: s.is_default, bot_enabled: s.bot_enabled, activation_enabled: s.activation_enabled,
    activation_tags: (Array.isArray(s.activation_tags) ? s.activation_tags : []).map((e) => ({ tag: String(e?.tag || ''), espera: Number(e?.espera) || 0, contexto: String(e?.contexto || '').slice(0, 300) })).filter((e) => e.tag),
    followups: (Array.isArray(s.followups) ? s.followups : []).map((f) => ({ hours: Number(f?.hours) || 0, instruction: String(f?.instruction || '').slice(0, 200) })),
    test_mode: Boolean(s.test_mode), test_tag: String(s.test_tag || 'hermes-test'), test_by_setter: Boolean(s.test_by_setter),
    required_tags: Array.isArray(s.required_tags) ? s.required_tags : [], excluded_tags: Array.isArray(s.excluded_tags) ? s.excluded_tags : [],
    channels: Array.isArray(s.channels) ? s.channels : [], followup_ai_check: Boolean(s.followup_ai_check),
  };
}

const numId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };

export default async function simuladorRoutes(app) {
  // Carga una simulación comprobando que es simulada y que el usuario puede ver su conexión.
  async function cargarSim(req, reply) {
    const id = numId(req.params.id);
    const conv = id ? await one(`SELECT * FROM conversations WHERE id = $1`, [id]) : null;
    if (!conv || !conv.simulada || !esSim(conv.ghl_contact_id)) { reply.code(404).send({ error: 'Simulación no encontrada' }); return null; }
    if (!(await canAccessAccount(req, conv.account_id))) { reply.code(403).send({ error: 'Sin acceso a esta cuenta' }); return null; }
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [conv.account_id]);
    if (!account) { reply.code(404).send({ error: 'Cuenta no encontrada' }); return null; }
    return { conv, account };
  }
  // Qué hay en cola y para cuándo (los instantes objetivo los deja el motor en debat:/fuat:). Un seguimiento
  // programado para dentro de horas NO es «en cola»: el panel lo enseña como programado y no sondea sin fin.
  const pendientes = async (convId) => {
    const [act, deb, fu, debat, fuat] = await Promise.all([`activar:${convId}`, `debtoken:${convId}`, `futoken:${convId}`, `debat:${convId}`, `fuat:${convId}`].map((k) => redis.get(k).catch(() => null)));
    const en = (v) => (v ? Math.max(0, Math.round((Number(v) - Date.now()) / 1000)) : null);
    return { activacion: Boolean(act), respuesta: Boolean(deb), seguimiento: Boolean(fu), respuesta_en: deb ? en(debat) : null, seguimiento_en: fu ? en(fuat) : null };
  };

  // Qué hay para simular en una conexión: setters (etiquetas activadoras, seguimientos, filtros), catálogo, horario.
  app.get('/api/simulador/opciones', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const accountId = numId(req.query?.account_id);
    if (!accountId) return reply.code(400).send({ error: 'account_id inválido' });
    if (!(await canAccessAccount(req, accountId))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const setters = await q(`SELECT * FROM setters WHERE account_id = $1 ORDER BY is_default DESC, id`, [accountId]);
    const lms = (Array.isArray(account.lead_magnets) ? account.lead_magnets : []).map((l) => ({ name: l.name || '', keyword: l.keyword || '', tag: l.tag || '', tags: tagsDeLeadMagnet(l), url: l.url || '' }));
    return {
      account: { id: account.id, name: account.alias || account.name, ai_enabled: Boolean(account.ai_enabled), bot_enabled: Boolean(account.bot_enabled), exclude_tag: account.exclude_tag || '', active_hours: account.active_hours || {}, timezone: account.timezone || 'Europe/Madrid', tiene_proveedor: Boolean(account.provider_id), ctas: Array.isArray(account.ctas) ? account.ctas : [] },
      setters: setters.map(resumenSetter),
      lead_magnets: lms,
    };
  });

  app.get('/api/simulador', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const accountId = numId(req.query?.account_id);
    if (!accountId) return reply.code(400).send({ error: 'account_id inválido' });
    if (!(await canAccessAccount(req, accountId))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    return q(
      `SELECT c.id, c.lead_name, c.channel, c.stage, c.followup_state, c.followup_step, c.cta_tag, c.created_at, c.updated_at, c.setter_id, s.name AS setter_name,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS n
         FROM conversations c LEFT JOIN setters s ON s.id = c.setter_id
        WHERE c.account_id = $1 AND c.simulada AND c.ghl_contact_id NOT LIKE 'sim:lab-%' ORDER BY c.id DESC LIMIT 100`,
      [accountId]
    );
  });

  // Crear un lead simulado. ventana: 'nunca' (no ha escrito por DM: el caso real de quien solo comentó),
  // 'abierta' (escribió hace 5 min) o 'cerrada' (escribió hace 25 h).
  app.post('/api/simulador', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { account_id, setter_id, nombre, canal, ventana } = req.body || {};
    if (!(await canAccessAccount(req, account_id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [account_id]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const setter = await one(`SELECT * FROM setters WHERE id = $1 AND account_id = $2`, [setter_id, account.id]);
    if (!setter) return reply.code(404).send({ error: 'Ese setter no existe en esta conexión' });
    const chans = Array.isArray(setter.channels) && setter.channels.length ? setter.channels : ['IG'];
    const channel = chans.includes(canal) ? canal : chans[0];
    const v = Object.prototype.hasOwnProperty.call(VENTANAS, ventana) ? ventana : 'nunca';
    const contactId = nuevoIdSim();
    const conv = await one(
      `INSERT INTO conversations (account_id, ghl_contact_id, channel, lead_name, setter_id, simulada, last_inbound_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, ${VENTANAS[v] || 'NULL'}, now()) RETURNING *`,
      [account.id, contactId, channel, String(nombre || 'Lead de prueba').slice(0, 60), setter.id]
    );
    const avisos = [];
    const m = mergeSetter(account, setter); // lo que de verdad aplica el motor (modo test de la conexión o del setter)
    // Modo test: sin su etiqueta de test el setter no respondería. Se la ponemos para que la prueba sea útil.
    const tagsIniciales = [];
    if (m.test_mode) { tagsIniciales.push(String(m.test_tag || 'hermes-test').trim()); avisos.push(`El setter está en modo test${account.test_mode ? ' (lo impone la conexión)' : ''}: se le ha puesto al lead la etiqueta «${tagsIniciales[0]}» para que responda.`); }
    if (!account.ai_enabled || !account.bot_enabled) avisos.push('La conexión tiene la IA o el bot APAGADOS: en producción este lead no recibiría respuesta (aquí tampoco).');
    else if (!m.bot_enabled) avisos.push('Este setter está APAGADO: en producción no respondería (aquí tampoco).');
    if (!m.provider_id) avisos.push('Sin proveedor de IA configurado: no puede generar respuestas.');
    await setSimTags(account.id, contactId, tagsIniciales);
    // Foto inicial de etiquetas: así la PRIMERA que se ponga cuenta como «recién puesta», igual que en un contacto real.
    await redis.set(`tagset:${account.id}:${contactId}`, JSON.stringify(tagsIniciales.map(normTag)), 'EX', 30 * 86400).catch(() => {});
    await redis.set(`simentrada:${conv.id}`, '1', 'EX', 30 * 86400).catch(() => {}); // su primer mensaje será ENTRADA (espera de inserción/CTA)
    // Las trazas del laboratorio no las poda el cap global del registro: se podan aquí por edad (7 días).
    await q(`DELETE FROM webhook_log WHERE created_at < now() - interval '7 days'
              AND (COALESCE(payload->>'contactId', '') LIKE 'sim:%' OR COALESCE(payload->>'contacto', '') LIKE 'sim:%'
                   OR payload->>'conv' IN (SELECT id::text FROM conversations WHERE simulada))`).catch(() => {});
    await logEvent('sim_creada', { conv: conv.id, contactId, setter: setter.id, canal: channel, ventana: v, nombre: conv.lead_name });
    return { ...conv, tags: tagsIniciales, avisos };
  });

  app.get('/api/simulador/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const { conv, account } = ctx;
    const setter = conv.setter_id ? await one(`SELECT * FROM setters WHERE id = $1`, [conv.setter_id]) : null;
    const messages = await q(`SELECT id, direction, source, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [conv.id]);
    const activaciones = await q(`SELECT id, tag, contexto, wait_seconds, respond_at, status, message, motivo, created_at, updated_at FROM activation_log WHERE conversation_id = $1 ORDER BY id`, [conv.id]);
    const eventos = await q(
      `SELECT id, kind, payload, created_at FROM webhook_log
        WHERE created_at >= $3 AND (payload->>'conv' = $1 OR payload->>'contactId' = $2 OR payload->>'contacto' = $2)
        ORDER BY id LIMIT 300`,
      [String(conv.id), conv.ghl_contact_id, conv.created_at]
    );
    const etapas = await q(`SELECT from_stage, to_stage, reason, created_at FROM stage_history WHERE conversation_id = $1 ORDER BY id`, [conv.id]);
    return {
      conv: {
        id: conv.id, lead_name: conv.lead_name, channel: conv.channel, stage: conv.stage, bot_paused: conv.bot_paused, paused_by: conv.paused_by,
        followup_step: conv.followup_step, followup_state: conv.followup_state, last_inbound_at: conv.last_inbound_at, last_outbound_at: conv.last_outbound_at,
        cta_tag: conv.cta_tag, cta_context: conv.cta_context, cta_at: conv.cta_at, memory: conv.memory, created_at: conv.created_at, setter_id: conv.setter_id,
      },
      setter: setter ? resumenSetter(setter) : null,
      cuenta: { ai_enabled: Boolean(account.ai_enabled), bot_enabled: Boolean(account.bot_enabled), followup_fit_window: Boolean(account.followup_fit_window) },
      tags: await getSimTags(account.id, conv.ghl_contact_id),
      pendientes: await pendientes(conv.id),
      cta_pendiente: Boolean(await redis.get(`ctapend:${account.id}:${conv.ghl_contact_id}`)),
      messages, activaciones, eventos, etapas,
    };
  });

  // Poner/quitar etiquetas «en GHL» del lead simulado. Se manda la lista COMPLETA (como hace el
  // ContactTagUpdate real) y pasa por el mismo webhook: contexto del CTA + activación con su espera.
  app.post('/api/simulador/:id/etiquetas', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const { conv, account } = ctx;
    const b = req.body || {};
    const norm = (a) => (Array.isArray(a) ? a : []).map((t) => String(t || '').trim()).filter(Boolean);
    let lista = Array.isArray(b.tags) ? norm(b.tags) : null; // «reemplazar todo» explícito
    if (!lista) { // operaciones (add/remove) sobre lo que hay en Redis: dos clics seguidos no se pisan con una lista vieja
      const actuales = await getSimTags(account.id, conv.ghl_contact_id);
      const quitar = new Set(norm(b.remove).map((t) => t.toLowerCase()));
      lista = [...actuales.filter((t) => !quitar.has(t.toLowerCase())), ...norm(b.add)];
    }
    const tags = await setSimTags(account.id, conv.ghl_contact_id, lista);
    const acelerar = req.body?.acelerar !== false;
    await logEvent('sim_etiquetas', { conv: conv.id, contactId: conv.ghl_contact_id, tags });
    await handleTagActivation(account, { contactId: conv.ghl_contact_id, tags });
    let acelerada = false;
    if (acelerar && (await redis.get(`activar:${conv.id}`))) acelerada = await acelerarRespuesta(conv.id, 2500);
    if (acelerada) await logEvent('sim_espera_acelerada', { conv: conv.id, nota: 'la espera configurada de la activación queda trazada en Activaciones; aquí el setter entra en unos segundos' });
    return { tags, pendientes: await pendientes(conv.id), acelerada };
  });

  // El lead escribe: mismo camino que un InboundMessage real (dedupe, espera de inserción/CTA, debounce).
  app.post('/api/simulador/:id/mensaje', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const { conv, account } = ctx;
    const text = String(req.body?.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'Escribe el mensaje del lead' });
    const acelerar = req.body?.acelerar !== false;
    await handleInbound(account, { channel: conv.channel, contactId: conv.ghl_contact_id, conversationId: null, body: text, messageId: 'sim-' + crypto.randomUUID(), contactName: conv.lead_name, attachments: [] });
    let acelerada = false;
    if (acelerar && (await redis.get(`debtoken:${conv.id}`))) acelerada = await acelerarRespuesta(conv.id, 2500);
    return { pendientes: await pendientes(conv.id), acelerada };
  });

  app.post('/api/simulador/:id/seguimiento', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const r = await forzarSeguimientoAhora(ctx.conv.id);
    await logEvent('sim_seguimiento_forzado', { conv: ctx.conv.id, ...r });
    return { ...r, pendientes: await pendientes(ctx.conv.id) };
  });

  // Mover el reloj de la ventana de Meta: cuándo «escribió» el lead por última vez.
  app.post('/api/simulador/:id/ventana', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const v = String(req.body?.estado || '');
    if (!Object.prototype.hasOwnProperty.call(VENTANAS, v)) return reply.code(400).send({ error: 'estado: nunca | abierta | cerrada' });
    await q(`UPDATE conversations SET last_inbound_at = ${VENTANAS[v] || 'NULL'} WHERE id = $1`, [ctx.conv.id]);
    await logEvent('sim_ventana', { conv: ctx.conv.id, estado: v });
    return { ok: true, estado: v };
  });

  app.post('/api/simulador/:id/pausa', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const pausar = Boolean(req.body?.pausado);
    await q(`UPDATE conversations SET bot_paused = $1, paused_by = $2 WHERE id = $3`, [pausar, pausar ? 'manual' : '', ctx.conv.id]);
    return { ok: true, bot_paused: pausar };
  });

  app.delete('/api/simulador/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const ctx = await cargarSim(req, reply); if (!ctx) return;
    const { conv, account } = ctx;
    await q(`DELETE FROM activation_log WHERE conversation_id = $1`, [conv.id]).catch(() => {});
    await q(`DELETE FROM conversations WHERE id = $1`, [conv.id]); // cascada: mensajes + historial de etapas
    const claves = ['activar', 'debtoken', 'futoken', 'ctawait', 'insfresh', 'rescconv', 'fuadj', 'llmretry', 'furetry'].map((k) => `${k}:${conv.id}`)
      .concat([`ctags:${account.id}:${conv.ghl_contact_id}`, `tagset:${account.id}:${conv.ghl_contact_id}`, `ctapend:${account.id}:${conv.ghl_contact_id}`]);
    await redis.del(...claves).catch(() => {});
    await borrarSimTags(account.id, conv.ghl_contact_id);
    // candados de activación por etiqueta (tagact:<setter>:<tag>:<contacto>)
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `tagact:*:${conv.ghl_contact_id}`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } catch { /* best-effort */ }
    return { ok: true };
  });

  // ── Laboratorio 2: preguntas sobre lead magnets ──────────────────────────────────────────────
  // Genera la tanda sugerida a partir del catálogo (sin IA): con y sin etiqueta de CTA.
  app.get('/api/simulador/preguntas/sugeridas', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const accountId = numId(req.query?.account_id);
    if (!accountId) return reply.code(400).send({ error: 'account_id inválido' });
    if (!(await canAccessAccount(req, accountId))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const lms = (Array.isArray(account.lead_magnets) ? account.lead_magnets : []).filter((l) => l && (l.name || l.keyword));
    const max = Math.min(Math.max(1, Number(req.query?.max) || 6), 20);
    const conPalabra = lms.filter((l) => l.keyword).slice(0, max);
    const sinPalabra = lms.filter((l) => !l.keyword).slice(0, Math.max(1, Math.floor(max / 3)));
    const out = [];
    for (const l of conPalabra) {
      const tag = l.tag || tagsDeLeadMagnet(l)[0] || '';
      out.push({ texto: 'Hola! Lo acabo de abrir, ¿de qué va exactamente?', cta_tag: tag, ficha: l.name, tipo: 'con_cta', espera: `Sabe que pidió «${l.name}» sin preguntar cuál` });
      out.push({ texto: 'No me ha llegado nada', cta_tag: tag, ficha: l.name, tipo: 'con_cta', espera: 'Reenvía o explica cómo conseguirlo, sin preguntar qué pidió' });
      out.push({ texto: `¿De qué va lo de ${String(l.keyword).toLowerCase()}?`, cta_tag: '', ficha: l.name, tipo: 'sin_cta', espera: `Explica «${l.name}» con la ficha del catálogo` });
    }
    for (const l of sinPalabra) out.push({ texto: `¿Qué es ${l.name}?`, cta_tag: '', ficha: l.name, tipo: 'sin_cta', espera: 'Lo describe con el catálogo (sin inventar)' });
    out.push({ texto: '¿Tenéis alguna guía gratis?', cta_tag: '', ficha: '', tipo: 'general', espera: 'Menciona materiales reales del catálogo' });
    out.push({ texto: 'Hola, ¿qué hacéis exactamente?', cta_tag: '', ficha: '', tipo: 'general', espera: 'Se presenta según su identidad y abre conversación' });
    return out;
  });

  // Ejecuta la tanda contra el setter (mismo generateReply que producción, sin guardar nada).
  app.post('/api/simulador/preguntas', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { account_id, setter_id, preguntas } = req.body || {};
    if (!(await canAccessAccount(req, account_id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    let account = await one(`SELECT * FROM accounts WHERE id = $1`, [account_id]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const setter = await one(`SELECT * FROM setters WHERE id = $1 AND account_id = $2`, [setter_id, account.id]);
    if (!setter) return reply.code(404).send({ error: 'Ese setter no existe en esta conexión' });
    const merged = { ...mergeSetter(account, setter), bot_enabled: true, lead_magnets: account.lead_magnets };
    const provider = merged.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [merged.provider_id]) : null;
    if (!provider) return reply.code(400).send({ error: 'Este setter no tiene proveedor de IA configurado (sección APIs)' });
    // 💳 Puerta de saldo ANTES de gastar IA, y cobro como «una conversación por día»: la tanda de preguntas
    // se apunta a una conversación de laboratorio (simulada, una por setter) que se cobra una vez al día.
    const puerta = await puedeAtender(account).catch(() => ({ atender: true }));
    if (!puerta.atender) return reply.code(402).send({ error: 'Sin saldo en el marketplace: recarga para usar la IA en el laboratorio.' });
    const labContact = `sim:lab-preguntas-${setter.id}`;
    const labConv = await one(
      `INSERT INTO conversations (account_id, ghl_contact_id, channel, lead_name, setter_id, simulada, updated_at)
       VALUES ($1, $2, 'IG', $3, $4, true, now())
       ON CONFLICT (account_id, ghl_contact_id, channel) DO UPDATE SET updated_at = now() RETURNING id`,
      [account.id, labContact, `Laboratorio de preguntas · ${setter.name}`, setter.id]
    );
    const lms = (Array.isArray(account.lead_magnets) ? account.lead_magnets : []).filter((l) => l && (l.name || l.keyword));
    const lista = (Array.isArray(preguntas) ? preguntas : []).slice(0, 40);
    const lmPorTag = new Map(lms.flatMap((l) => tagsDeLeadMagnet(l).map((t) => [t, l]))); // misma regla que el webhook: gana la última ficha
    let usoIa = false;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const palabra = (k) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}\\p{N}])`, 'u');
    const out = [];
    for (const p of lista) {
      const texto = String(p?.texto || '').trim(); if (!texto) continue;
      const ctaTag = normTag(p?.cta_tag);
      const lm = ctaTag ? (lmPorTag.get(ctaTag) || null) : null;
      const fakeConv = { channel: 'IG', memory: {}, lead_name: 'Lead de prueba', cta_tag: ctaTag ? String(p.cta_tag) : '', cta_context: lm ? fichaLm(lm) : (ctaTag ? '' : ''), cta_at: ctaTag ? new Date().toISOString() : null };
      const previos = (Array.isArray(p?.historial) ? p.historial : []).slice(-10).map((m) => ({ direction: m.role === 'lead' ? 'inbound' : 'outbound', body: String(m.text || '') })).filter((m) => m.body);
      const history = [...previos, { direction: 'inbound', body: texto }];
      let r;
      try {
        r = await generateReply({ account: merged, provider, conversation: fakeConv, history });
      } catch (err) {
        out.push({ ...p, error: err.message }); continue;
      }
      await recordUsage(account.id, labConv.id, provider, r.model, r.usage, 'simulador', null, setter.id).catch(() => {});
      usoIa = true;
      const mensajes = filtrarRepetidos(r.mensajes, []).unicos;
      const resp = normTag(mensajes.join(' \n '));
      const menciona = (l) => [l.keyword, l.name].map(normTag).filter((k) => k && k.length >= 4).some((k) => palabra(k).test(resp));
      // «otros»: solo por NOMBRE de ficha (las palabras clave suelen ser palabras corrientes: email, cliente, precio…)
      const mencionaNombre = (l) => { const n = normTag(l.name); return n.length >= 8 && palabra(n).test(resp); };
      const objetivo = lm || (p?.ficha ? lms.find((l) => l.name === p.ficha) : null);
      const otros = lms.filter((l) => l !== objetivo && mencionaNombre(l)).map((l) => l.name).slice(0, 3);
      const checks = {
        menciona_material: objetivo ? menciona(objetivo) : null,
        pregunta_cual: /(a )?(cu[aá]l|qu[eé]) (gu[ií]a|material|recurso|de ellos|te refieres|pediste|pidi[oó])|a qu[eé] te refieres/i.test(mensajes.join(' ')),
        da_enlace: /https?:\/\//i.test(mensajes.join(' ')),
        pide_nombre: /c[oó]mo te llamas|tu nombre/i.test(mensajes.join(' ')),
        menciona_otros: otros,
      };
      out.push({ ...p, cta_tag: fakeConv.cta_tag, ficha: objetivo?.name || p?.ficha || '', mensajes, etiqueta: r.etiqueta, motivo: r.motivo, handoff: Boolean(r.handoff), checks, modelo: r.model, coste: req.auth?.role === 'admin' ? (r.usage?.cost ?? null) : null });
    }
    if (usoIa) await registrarConsumo({ account, conversationId: labConv.id }).catch(() => {}); // 💳 una vez al día por setter
    return out;
  });
}
