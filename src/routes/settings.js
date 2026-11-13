import crypto from 'node:crypto';
import { q, getSetting, setSetting } from '../db.js';
import { config, scopesOAuth, OAUTH_SCOPE_PEDIDOS } from '../config.js';
import { requireAdmin } from '../lib/session.js';
import { DEFAULT_GUARDRAIL, invalidateGuardrailCache } from '../services/agent.js';
import { DEFAULT_ARCHITECT, DEFAULT_CORRECTOR } from './promptEditor.js';
import { agencyKey } from './portal.js';
import {
  leerPlantilla, sanearPlantilla, TEST_TAG_POR_DEFECTO, leerCorreosNoClub, validarNoClub, guardarCorreosNoClub, conexionesConCorreoNoClub,
} from '../services/club.js';
import {
  AJUSTES_POR_DEFECTO as AJUSTES_DEVOLUCIONES_POR_DEFECTO, leerAjustes as leerAjustesDevoluciones,
  validarAjustes as validarAjustesDevoluciones, guardarAjustes as guardarAjustesDevoluciones, listarSolicitudes, enviarAGhl,
} from '../services/devoluciones.js';

// md5 de las generaciones VIEJAS de los prompts por defecto (los mismos de la migración 046, ver
// scripts/hashes-defaults.mjs). Guardar uno de estos textos también almacena '' — cubre la pestaña
// de Configuración abierta desde ANTES de un deploy: su textarea trae el default viejo prefilled y
// un «Guardar» lo re-congelaría como «personalización» justo después de que 046 descongelara.
const HASHES_DEFAULTS_VIEJOS = new Set([
  'c97555b02207a87ca0fbe0438cb9e6bd', // DEFAULT_ARCHITECT gen. «élite»
  '57f1b4d9a658a19eb7b690a9375775bc', // DEFAULT_ARCHITECT gen. «experto»
  '57342d09c8a366bbbe337732e88c1d3f', // DEFAULT_CORRECTOR gen. «élite»
  '424227373cd33d60d3e23cd3f7a8a174', // DEFAULT_CORRECTOR gen. anterior
  '75d7fe14b905d73e1d4c63d62687a978', // DEFAULT_GUARDRAIL 1ª generación
]);
const esDefaultViejo = (texto) =>
  HASHES_DEFAULTS_VIEJOS.has(crypto.createHash('md5').update(texto.replace(/\r/g, ''), 'utf8').digest('hex'));

export default async function settingsRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  // Prompts globales: guardarraíl + arquitecto + qué modelo usa el arquitecto y el corrector
  app.get('/api/settings/prompts', async () => {
    const g = (await getSetting('guardrail', null)) || {};
    const a = (await getSetting('architect_prompt', null)) || {};
    const c = (await getSetting('corrector_prompt', null)) || {};
    const am = (await getSetting('architect_model', {})) || {};
    const cm = (await getSetting('corrector_model', {})) || {};
    return {
      guardrail: g.text || DEFAULT_GUARDRAIL,
      guardrail_default: DEFAULT_GUARDRAIL,
      architect: a.text || DEFAULT_ARCHITECT,
      architect_default: DEFAULT_ARCHITECT,
      corrector: c.text || DEFAULT_CORRECTOR,
      corrector_default: DEFAULT_CORRECTOR,
      architect_provider_id: am.provider_id ?? null,
      architect_model: am.model || '',
      corrector_provider_id: cm.provider_id ?? null,
      corrector_model: cm.model || '',
    };
  });

  app.put('/api/settings/prompts', async (req) => {
    const b = req.body || {};
    // Si lo que se guarda es EXACTAMENTE el texto por defecto (el actual O una generación vieja:
    // una pestaña abierta desde antes del deploy trae el viejo prefilled), se guarda vacío: el
    // vacío cae al default en cada lectura, así que futuras mejoras del default llegan solas. Sin
    // esto, pulsar «Guardar» sin tocar nada congelaba una copia del default en la base para siempre.
    const oDefecto = (texto, def) => {
      const t = texto.trim();
      return t === def.trim() || esDefaultViejo(t) ? '' : t;
    };
    if (typeof b.guardrail === 'string') { await setSetting('guardrail', { text: oDefecto(b.guardrail, DEFAULT_GUARDRAIL) }); invalidateGuardrailCache(); }
    if (typeof b.architect === 'string') { await setSetting('architect_prompt', { text: oDefecto(b.architect, DEFAULT_ARCHITECT) }); }
    if (typeof b.corrector === 'string') { await setSetting('corrector_prompt', { text: oDefecto(b.corrector, DEFAULT_CORRECTOR) }); }
    if ('architect_provider_id' in b || 'architect_model' in b) {
      await setSetting('architect_model', { provider_id: b.architect_provider_id || null, model: b.architect_model || '' });
    }
    if ('corrector_provider_id' in b || 'corrector_model' in b) {
      await setSetting('corrector_model', { provider_id: b.corrector_provider_id || null, model: b.corrector_model || '' });
    }
    return { ok: true };
  });

  // 🏛️ Plantilla de CONEXIONES NUEVAS (services/club.js): lo que copia el «Setter principal» de cada conexión que se
  // crea sola. Las conexiones nuevas nacen SIEMPRE en modo prueba con test_tag; esto no toca las que ya existen.
  app.get('/api/settings/plantilla-conexion', async () => {
    const p = await leerPlantilla();
    const prov = p.provider_id ? await q(`SELECT id, name FROM providers WHERE id = $1`, [p.provider_id]) : [];
    return { ...p, provider_name: prov[0]?.name || null, provider_existe: p.provider_id ? Boolean(prov[0]) : null, test_tag_defecto: TEST_TAG_POR_DEFECTO };
  });

  app.put('/api/settings/plantilla-conexion', async (req, reply) => {
    const actual = await leerPlantilla();
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const nueva = sanearPlantilla({
      ...actual,
      ...('provider_id' in b ? { provider_id: b.provider_id } : {}),
      ...('model' in b ? { model: b.model } : {}),
      ...('test_tag' in b ? { test_tag: b.test_tag } : {}),
      ...(b.prompt_partida && typeof b.prompt_partida === 'object' ? { prompt_partida: { ...actual.prompt_partida, ...b.prompt_partida } } : {}),
      origen: 'editada en Configuración',
    });
    if (nueva.provider_id) {
      const p = await q(`SELECT id FROM providers WHERE id = $1`, [nueva.provider_id]);
      if (!p.length) return reply.code(400).send({ error: 'Esa API de IA no existe.' });
    }
    await setSetting('plantilla_conexion', nueva);
    return { ok: true, ...nueva };
  });

  // 🏛️ Registro DURABLE del interruptor del Club (POST /api/club/estado): últimas llamadas y estados pendientes.
  app.get('/api/settings/club-eventos', async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 500);
    const eventos = await q(`SELECT * FROM club_eventos ORDER BY id DESC LIMIT $1`, [limit]);
    const pendientes = await q(`SELECT * FROM club_estado_pendiente ORDER BY updated_at DESC LIMIT 200`);
    return { configurado: String(process.env.CLUB_WEBHOOK_SECRET || '').trim().length >= 24, url: `${config.appBaseUrl}/api/club/estado`, eventos, pendientes };
  });

  // 🏛️ CORREOS QUE NUNCA PUEDEN SER EL «CORREO DEL CLUB» de un cliente (services/club.js · motivoNoClub): siempre los dos
  // de soporte y los admins de Hermes cuyo usuario es un correo; además, los que se añadan aquí (setting club_correos:
  // correos o «@dominio.com»). en_uso = conexiones que YA tienen confirmado uno de ellos (hay que cambiarlo en su ficha).
  app.get('/api/settings/club-correos', async () => {
    const noClub = await leerCorreosNoClub();
    return { ...noClub, en_uso: await conexionesConCorreoNoClub(noClub) };
  });

  app.put('/api/settings/club-correos', async (req, reply) => {
    const v = validarNoClub(req.body?.no_club);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const antes = (await leerCorreosNoClub()).no_club;
    const despues = await guardarCorreosNoClub(v.valor);
    await q(`INSERT INTO webhook_log (kind, payload) VALUES ('club_correos_cambiados', $1::jsonb)`, [JSON.stringify({ antes, despues, por: req.auth?.userId || null })]).catch(() => {});
    const noClub = await leerCorreosNoClub();
    return { ok: true, ...noClub, en_uso: await conexionesConCorreoNoClub(noClub) };
  });

  // 🏛️ DEVOLUCIONES del Club (POST /api/club/devolucion · services/devoluciones.js): ajustes editables por el admin
  // (plazo, límites, URL de uso del Brain y URL del resultado en GHL), solicitudes con su decisión y reenvío a GHL.
  app.get('/api/settings/devoluciones', async (req) => {
    const ajustes = await leerAjustesDevoluciones();
    const { solicitudes, totales } = await listarSolicitudes({ decision: req.query?.decision || null, limit: req.query?.limit });
    return {
      ajustes,
      por_defecto: AJUSTES_DEVOLUCIONES_POR_DEFECTO,
      configurado: String(process.env.CLUB_WEBHOOK_SECRET || '').trim().length >= 24,
      url: `${config.appBaseUrl}/api/club/devolucion`,
      solicitudes,
      totales,
    };
  });

  app.put('/api/settings/devoluciones', async (req, reply) => {
    const antes = await leerAjustesDevoluciones();
    const v = validarAjustesDevoluciones(req.body, antes);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const ajustes = await guardarAjustesDevoluciones(v.valor);
    await q(`INSERT INTO webhook_log (kind, payload) VALUES ('devoluciones_ajustes_cambiados', $1::jsonb)`, [JSON.stringify({ antes, despues: ajustes, por: req.auth?.userId || null })]).catch(() => {});
    return { ok: true, ajustes };
  });

  // Reenvío manual del resultado a GHL (también las «sin URL» y, con confirmación en el panel, las ya enviadas).
  app.post('/api/settings/devoluciones/:id/enviar', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'Solicitud no válida.' });
    const r = await enviarAGhl(id, { forzar: true });
    if (r.estado === 'sin_url') return reply.code(400).send({ error: 'Falta la URL del resultado en GHL (disparador «Webhook entrante»).' });
    if (r.estado === 'ocupado') return reply.code(409).send({ error: 'Esa solicitud no existe o se está enviando ahora mismo.' });
    return { ok: r.estado === 'enviado', ...r };
  });

  app.get('/api/settings/ghl', async () => {
    const app_ = (await getSetting('ghl_app', {})) || {};
    const ak = await agencyKey();
    const installUrl = app_.client_id
      ? 'https://marketplace.gohighlevel.com/oauth/chooselocation' +
        `?response_type=code&redirect_uri=${encodeURIComponent(`${config.appBaseUrl}/api/oauth/callback`)}` +
        `&client_id=${encodeURIComponent(app_.client_id)}` +
        `&scope=${scopesOAuth(app_).map(encodeURIComponent).join('%20')}`
      : '';
    return {
      client_id: app_.client_id || '',
      client_secret_set: Boolean(app_.client_secret),
      sso_secret_set: Boolean(app_.sso_secret),
      app_base_url: config.appBaseUrl,
      install_url: installUrl,
      redirect_url: `${config.appBaseUrl}/api/oauth/callback`,
      marketplace_webhook_url: `${config.appBaseUrl}/api/webhooks/inbox`,
      agency_menu_url: `${config.appBaseUrl}/ghl-app?key=${ak}&location_id={{location.id}}&email={{user.email}}&name={{user.name}}`,
      custom_page_url: `${config.appBaseUrl}/`,
      scopes: scopesOAuth(app_),
      scope_pedidos: Boolean(app_.scope_pedidos),
      scope_pedidos_nombre: OAUTH_SCOPE_PEDIDOS,
      signature_check: !config.allowUnsignedWebhooks,
    };
  });

  app.put('/api/settings/ghl', async (req) => {
    const current = (await getSetting('ghl_app', {})) || {};
    const b = req.body || {};
    const next = {
      client_id: b.client_id !== undefined ? String(b.client_id).trim() : current.client_id || '',
      client_secret: b.client_secret ? String(b.client_secret).trim() : current.client_secret || '',
      sso_secret: b.sso_secret ? String(b.sso_secret).trim() : current.sso_secret || '',
      scope_pedidos: b.scope_pedidos !== undefined ? Boolean(b.scope_pedidos) : Boolean(current.scope_pedidos),
    };
    await setSetting('ghl_app', next);
    return { ok: true };
  });

  app.get('/api/settings/webhook-log', async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    return q(`SELECT * FROM webhook_log ORDER BY id DESC LIMIT $1`, [limit]);
  });
}
