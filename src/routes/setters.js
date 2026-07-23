import { q, one } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, requireManageAgents, canAccessAccount } from '../lib/session.js';
import * as ghl from '../services/ghl.js';

// El admin edita todo; un usuario del portal solo el cerebro de su setter (no el proveedor/modelo de IA).
const ADMIN_EDITABLE = [
  'name', 'bot_enabled', 'accepts_leads', 'test_mode', 'channels', 'required_tags', 'required_tags_mode', 'excluded_tags',
  'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'followup_ai_check',
  'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
  'calendar_ids', 'activation_enabled', 'activation_tags', 'insertion_wait_seconds', 'insertion_idle_hours',
];
const USER_EDITABLE = [
  'name', 'bot_enabled', 'test_mode', 'channels', 'required_tags', 'required_tags_mode', 'excluded_tags',
  'prompt_identity', 'prompt_business', 'prompt_flow',
  'temperature', 'debounce_seconds', 'max_msgs', 'followups', 'followup_ai_check',
  // pestaña IA: el usuario elige sus APIs (solo las habilitadas para usuarios; se valida abajo)
  'provider_id', 'model', 'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
  'calendar_ids', 'activation_enabled', 'activation_tags', 'insertion_wait_seconds', 'insertion_idle_hours',
];
const JSON_FIELDS = new Set(['required_tags', 'followups', 'excluded_tags', 'calendar_ids', 'channels', 'activation_tags']);

// Solo aceptamos enlaces http/https: el link se renderiza como <a> en el panel, así que un
// "javascript:..." sería ejecución de código al pulsarlo. Cualquier otro esquema se descarta.
function safeLink(v) {
  const s = String(v || '').trim().slice(0, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? s : '';
  } catch {
    return '';
  }
}

// Lista de CTAs vinculados a una etiqueta: [{ url, name }]. Cada url solo http/https. Acepta el campo
// antiguo `link` (una sola URL string) por compatibilidad y lo convierte en un elemento.
function sanitizeLinks(links, legacy) {
  let arr = Array.isArray(links) ? links : (legacy ? [{ url: legacy, name: '' }] : []);
  return arr
    .map((l) => ({ url: safeLink(typeof l === 'string' ? l : l?.url), name: String(l?.name || '').trim().slice(0, 60) }))
    .filter((l) => l.url)
    .slice(0, 10);
}

// Lista de etiquetas activadoras: { tag, contexto, espera, links }. Se normaliza entera para que no
// entre basura al prompt ni al panel (claves desconocidas fuera, longitudes y espera acotadas).
function sanitizeActivationTags(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => ({
      tag: String(e?.tag || '').trim().slice(0, 100),
      contexto: String(e?.contexto || '').trim().slice(0, 1500),
      espera: Math.min(Math.max(0, Math.round(Number(e?.espera) || 0)), 3600),
      links: sanitizeLinks(e?.links, e?.link),
    }))
    .filter((e) => e.tag)
    .slice(0, 20);
}

async function loadSetterScoped(req, setterId) {
  const setter = await one(`SELECT * FROM setters WHERE id = $1`, [setterId]);
  if (!setter) return { code: 404, error: 'Setter no encontrado' };
  if (!(await canAccessAccount(req, setter.account_id))) return { code: 403, error: 'Sin acceso a este setter' };
  return { setter };
}

export default async function setterRoutes(app) {
  // Proveedores de IA que un usuario NO admin puede elegir (solo los marcados user_available; sin claves).
  app.get('/api/user-providers', async () => {
    return q(`SELECT id, name, base_url, kinds FROM providers WHERE user_available = true ORDER BY id`);
  });

  // Setters de una conexión (=account) con sus métricas de batalla.
  // Admin ve todas; un usuario, solo la suya.
  app.get('/api/accounts/:id/setters', async (req, reply) => {
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const rows = await q(
      `SELECT s.*, p.name AS provider_name,
        COUNT(c.id)::int AS leads,
        COUNT(c.id) FILTER (WHERE c.stage IN ('calificado', 'seguimiento_calificado'))::int AS calificados,
        COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
        COUNT(c.id) FILTER (WHERE c.stage = 'agendado')::int AS agendados,
        COUNT(c.id) FILTER (WHERE c.stage = 'descartado')::int AS descartados,
        COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u WHERE u.setter_id = s.id), 0) AS gasto,
        COALESCE((SELECT SUM(COALESCE(u.billed_usd, u.cost_usd)) FROM llm_usage u WHERE u.setter_id = s.id), 0) AS facturado
       FROM setters s
       LEFT JOIN providers p ON p.id = s.provider_id
       LEFT JOIN conversations c ON c.setter_id = s.id
       WHERE s.account_id = $1
       GROUP BY s.id, p.name
       ORDER BY s.is_default DESC, s.id`,
      [req.params.id]
    );
    const isAdmin = req.auth?.role === 'admin';
    return rows.map((r) => {
      const leads = r.leads || 0;
      const won = r.agendados || 0;
      const conv = (r.en_conversion || 0) + won;
      const facturado = Number(r.facturado || 0);
      return {
        ...r,
        conversations_count: leads,
        // el COSTO real es solo del admin; el cliente ve lo facturado también en "gasto"
        gasto: isAdmin ? Number(r.gasto || 0) : facturado,
        facturado,
        tasa_agenda: leads ? Math.round((won / leads) * 100) : 0,
        tasa_conversion: leads ? Math.round((conv / leads) * 100) : 0,
        tasa_calificacion: leads ? Math.round(((r.calificados + conv) / leads) * 100) : 0,
      };
    });
  });

  // Crear un setter dentro de una conexión (admin o dueño con IA activa).
  app.post('/api/accounts/:id/setters', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    if (!(await canAccessAccount(req, req.params.id))) return reply.code(403).send({ error: 'Sin acceso' });
    const acc = await one(`SELECT id FROM accounts WHERE id = $1`, [req.params.id]);
    if (!acc) return reply.code(404).send({ error: 'Conexión no encontrada' });
    const name = String(req.body?.name || '').trim() || 'Nuevo setter';
    const hasDefault = await one(`SELECT 1 FROM setters WHERE account_id = $1 AND is_default LIMIT 1`, [req.params.id]);
    // Hereda los canales de la conexión (no el default): respeta lo que el cliente ya desactivó.
    return one(
      `INSERT INTO setters (account_id, name, is_default, channels)
       SELECT $1, $2, $3, CASE WHEN jsonb_typeof(a.channels) = 'array' THEN a.channels ELSE '["IG","WhatsApp"]'::jsonb END
       FROM accounts a WHERE a.id = $1 RETURNING *`,
      [req.params.id, name, !hasDefault]
    );
  });

  app.get('/api/setters/:id', async (req, reply) => {
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const provider_name = setter.provider_id
      ? (await one(`SELECT name FROM providers WHERE id = $1`, [setter.provider_id]))?.name || null
      : null;
    return {
      ...setter,
      provider_name,
      // URL DEDICADA para ContactTagUpdate (misma para todos; se pega en el «Custom webhook URL» de esa fila).
      tag_webhook_url: `${config.appBaseUrl}/api/webhooks/etiquetas`,
      // Alternativa avanzada: webhook por setter con token (nodo Webhook dentro de un workflow de GHL).
      activation_webhook_url: `${config.appBaseUrl}/api/webhooks/activar/${setter.activation_token}`,
    };
  });

  // 🧪 Traza reciente del webhook de etiquetas para ESTE setter (probar que ContactTagUpdate llega).
  app.get('/api/setters/:id/tag-log', async (req, reply) => {
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const events = await q(
      `SELECT id, kind, payload, created_at FROM webhook_log
       WHERE kind IN ('etiqueta_recibida', 'activador_etiqueta')
         AND (payload->>'account' = $1 OR payload->>'setter' = $2)
       ORDER BY id DESC LIMIT 20`,
      [String(setter.account_id), String(setter.id)]
    );
    return { events };
  });

  // Guarda la versión ANTERIOR de los 3 prompts antes de sobrescribirlos (historial para volver atrás).
  async function savePromptVersion(setter, source) {
    await q(
      `INSERT INTO prompt_versions (setter_id, prompt_identity, prompt_business, prompt_flow, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [setter.id, setter.prompt_identity || '', setter.prompt_business || '', setter.prompt_flow || '', String(source || 'manual').slice(0, 40)]
    );
    // tope de historial por setter
    await q(
      `DELETE FROM prompt_versions WHERE setter_id = $1 AND id NOT IN
         (SELECT id FROM prompt_versions WHERE setter_id = $1 ORDER BY id DESC LIMIT 30)`,
      [setter.id]
    );
  }

  app.put('/api/setters/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const editable = req.auth?.role === 'admin' ? ADMIN_EDITABLE : USER_EDITABLE;
    const b = req.body || {};

    // Un usuario NO admin solo puede CAMBIAR a una API habilitada para usuarios (user_available): así no
    // asigna por id una API no aprobada. Validamos SOLO los provider que CAMBIAN respecto a lo guardado:
    // si el setter ya tenía una API no-user_available (la fijó el admin, o se desmarcó después), el
    // frontend la reenvía tal cual en cada guardado y NO debe bloquear (si no, no podría ni editar un prompt).
    if (req.auth?.role !== 'admin') {
      const provIds = ['provider_id', 'vision_provider_id', 'audio_provider_id']
        .filter((f) => f in b && Number(b[f]) !== Number(setter[f])) // solo los que cambian
        .map((f) => b[f]).filter((v) => v != null && v !== '').map(Number).filter((n) => Number.isFinite(n));
      if (provIds.length) {
        const ok = await q(`SELECT id FROM providers WHERE user_available = true AND id = ANY($1::int[])`, [provIds]);
        const okSet = new Set(ok.map((r) => r.id));
        if (provIds.some((n) => !okSet.has(n))) {
          return reply.code(400).send({ error: 'Esa API de IA no está disponible para usuarios. Elige una de las habilitadas.' });
        }
      }
    }

    const sets = [];
    const vals = [];
    for (const f of editable) {
      if (!(f in b)) continue;
      // No dejar el setter sin canales (estado ambiguo): si llega vacío/invalido, se ignora el cambio.
      if (f === 'channels' && !(Array.isArray(b[f]) && b[f].length)) continue;
      let val = f === 'activation_tags' ? sanitizeActivationTags(b[f]) : b[f];
      if (f === 'insertion_wait_seconds') val = Math.min(Math.max(0, Math.round(Number(b[f]) || 0)), 3600);
      if (f === 'insertion_idle_hours') val = Math.min(Math.max(0, Math.round(Number(b[f]) || 0)), 720);
      // Un usuario elige la API, no el modelo suelto: se usa el default_model de la API (más seguro y
      // es el mismo UX del panel). El admin sí puede fijar un modelo concreto.
      if (req.auth?.role !== 'admin' && (f === 'model' || f === 'vision_model' || f === 'audio_model')) val = '';
      vals.push(JSON_FIELDS.has(f) ? JSON.stringify(val) : val);
      sets.push(`${f} = $${vals.length}${JSON_FIELDS.has(f) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return setter;
    vals.push(setter.id);
    const row = await one(`UPDATE setters SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    // ¿cambió algún prompt? → guardar la versión ANTERIOR (en memoria) DESPUÉS del update
    // (si el update falla no queda una entrada espuria en el historial). source con whitelist.
    const PROMPTS = ['prompt_identity', 'prompt_business', 'prompt_flow'];
    const promptChanged = PROMPTS.some((f) => f in b && String(b[f] ?? '') !== String(setter[f] ?? ''));
    if (promptChanged) {
      const source = ['corrector', 'arquitecto'].includes(b.prompt_source) ? b.prompt_source : 'manual';
      await savePromptVersion(setter, source).catch(() => {});
    }
    return row;
  });

  // Crea en GHL la etiqueta activadora (para que exista exacta y el workflow la use sin diferencias).
  app.post('/api/setters/:id/create-tag', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [setter.account_id]);
    if (!account?.location_id) return reply.code(400).send({ error: 'Primero conecta esta subcuenta a GHL (pestaña Conexión).' });
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!name) return reply.code(400).send({ error: 'Escribe primero el nombre de la etiqueta.' });
    // Solo la creamos en GHL: la etiqueta vive en la lista activation_tags del setter, que se
    // guarda con el resto del formulario (no la duplicamos en la columna legacy activation_tag).
    try {
      await ghl.createLocationTag(account, name);
      return { ok: true, tag: name };
    } catch (err) {
      // Solo tratamos como éxito el caso real "ya existe" (400 duplicado); el resto
      // (token caducado, sin permiso, red) es un fallo genuino que el operador debe ver.
      const txt = `${err?.message || ''} ${JSON.stringify(err?.body || '')}`.toLowerCase();
      const yaExiste = err?.status === 400 && /(exist|duplicat|already|ya existe)/.test(txt);
      if (yaExiste) return { ok: true, tag: name, nota: 'La etiqueta ya existía en GHL.' };
      return reply.code(502).send({
        error: `GHL no pudo crear la etiqueta (${err?.status || 'sin conexión'}). Revisa la conexión de la subcuenta.`,
      });
    }
  });

  // Historial de versiones de los prompts (admin y dueño): listar y restaurar.
  app.get('/api/setters/:id/prompt-versions', async (req, reply) => {
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    return q(
      `SELECT id, prompt_identity, prompt_business, prompt_flow, source, created_at
       FROM prompt_versions WHERE setter_id = $1 ORDER BY id DESC LIMIT 30`,
      [setter.id]
    );
  });

  app.post('/api/setters/:id/prompt-versions/:vid/restore', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const v = await one(`SELECT * FROM prompt_versions WHERE id = $1 AND setter_id = $2`, [req.params.vid, setter.id]);
    if (!v) return reply.code(404).send({ error: 'Versión no encontrada' });
    // aplica la versión y DESPUÉS guarda lo que había (para deshacer la restauración);
    // si el update falla, no queda entrada espuria en el historial
    const row = await one(
      `UPDATE setters SET prompt_identity = $1, prompt_business = $2, prompt_flow = $3 WHERE id = $4 RETURNING *`,
      [v.prompt_identity, v.prompt_business, v.prompt_flow, setter.id]
    );
    await savePromptVersion(setter, 'previo_restauracion').catch(() => {});
    return row;
  });

  app.delete('/api/setters/:id', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const setter = await one(`SELECT * FROM setters WHERE id = $1`, [req.params.id]);
    if (!setter) return reply.code(404).send({ error: 'No existe' });
    if (!(await canAccessAccount(req, setter.account_id))) return reply.code(403).send({ error: 'Sin acceso' });
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM setters WHERE account_id = $1`, [setter.account_id]);
    if (n <= 1) return reply.code(400).send({ error: 'No puedes borrar el único setter de la conexión' });
    await q(`DELETE FROM setters WHERE id = $1`, [req.params.id]);
    // si borramos el setter por defecto, ascendemos otro para no dejar a la conexión sin default
    if (setter.is_default) {
      await q(
        `UPDATE setters SET is_default = true WHERE id = (SELECT id FROM setters WHERE account_id = $1 ORDER BY id LIMIT 1)`,
        [setter.account_id]
      );
    }
    return { ok: true };
  });
}
