import { q, one } from '../db.js';
import { requireAdmin, scopedAccountId } from '../lib/session.js';

// El admin edita todo; un usuario del portal solo el cerebro de su setter (no el proveedor/modelo de IA).
const ADMIN_EDITABLE = [
  'name', 'bot_enabled', 'accepts_leads', 'weight', 'required_tags', 'required_tags_mode', 'excluded_tags',
  'prompt_identity', 'prompt_business', 'prompt_flow',
  'provider_id', 'model', 'temperature', 'debounce_seconds', 'max_msgs', 'followups',
  'vision_enabled', 'vision_provider_id', 'vision_model', 'audio_enabled', 'audio_provider_id', 'audio_model',
];
const USER_EDITABLE = [
  'name', 'bot_enabled', 'required_tags', 'required_tags_mode', 'excluded_tags',
  'prompt_identity', 'prompt_business', 'prompt_flow',
  'temperature', 'debounce_seconds', 'max_msgs', 'followups',
];
const JSON_FIELDS = new Set(['required_tags', 'followups', 'excluded_tags']);

async function loadSetterScoped(req, setterId) {
  const setter = await one(`SELECT * FROM setters WHERE id = $1`, [setterId]);
  if (!setter) return { code: 404, error: 'Setter no encontrado' };
  const scope = scopedAccountId(req);
  if (scope && setter.account_id !== scope) return { code: 403, error: 'Sin acceso a este setter' };
  return { setter };
}

export default async function setterRoutes(app) {
  // Setters de una conexión (=account) con sus métricas de batalla.
  // Admin ve todas; un usuario, solo la suya.
  app.get('/api/accounts/:id/setters', async (req, reply) => {
    const scope = scopedAccountId(req);
    if (scope && Number(req.params.id) !== scope) return reply.code(403).send({ error: 'Sin acceso' });
    const rows = await q(
      `SELECT s.*, p.name AS provider_name,
        COUNT(c.id)::int AS leads,
        COUNT(c.id) FILTER (WHERE c.stage IN ('calificado', 'seguimiento_calificado'))::int AS calificados,
        COUNT(c.id) FILTER (WHERE c.stage = 'en_conversion')::int AS en_conversion,
        COUNT(c.id) FILTER (WHERE c.stage = 'agendado')::int AS agendados,
        COUNT(c.id) FILTER (WHERE c.stage = 'descartado')::int AS descartados,
        COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u WHERE u.setter_id = s.id), 0) AS gasto
       FROM setters s
       LEFT JOIN providers p ON p.id = s.provider_id
       LEFT JOIN conversations c ON c.setter_id = s.id
       WHERE s.account_id = $1
       GROUP BY s.id, p.name
       ORDER BY s.is_default DESC, s.id`,
      [req.params.id]
    );
    return rows.map((r) => {
      const leads = r.leads || 0;
      const won = r.agendados || 0;
      const conv = (r.en_conversion || 0) + won;
      return {
        ...r,
        conversations_count: leads,
        gasto: Number(r.gasto || 0),
        tasa_agenda: leads ? Math.round((won / leads) * 100) : 0,
        tasa_conversion: leads ? Math.round((conv / leads) * 100) : 0,
        tasa_calificacion: leads ? Math.round(((r.calificados + conv) / leads) * 100) : 0,
      };
    });
  });

  // Crear un setter dentro de una conexión (admin).
  app.post('/api/accounts/:id/setters', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = await one(`SELECT id FROM accounts WHERE id = $1`, [req.params.id]);
    if (!acc) return reply.code(404).send({ error: 'Conexión no encontrada' });
    const name = String(req.body?.name || '').trim() || 'Nuevo setter';
    const hasDefault = await one(`SELECT 1 FROM setters WHERE account_id = $1 AND is_default LIMIT 1`, [req.params.id]);
    return one(
      `INSERT INTO setters (account_id, name, is_default) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, name, !hasDefault]
    );
  });

  app.get('/api/setters/:id', async (req, reply) => {
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const provider_name = setter.provider_id
      ? (await one(`SELECT name FROM providers WHERE id = $1`, [setter.provider_id]))?.name || null
      : null;
    return { ...setter, provider_name };
  });

  app.put('/api/setters/:id', async (req, reply) => {
    const { setter, code, error } = await loadSetterScoped(req, req.params.id);
    if (code) return reply.code(code).send({ error });
    const editable = req.auth?.role === 'admin' ? ADMIN_EDITABLE : USER_EDITABLE;
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const f of editable) {
      if (!(f in b)) continue;
      vals.push(JSON_FIELDS.has(f) ? JSON.stringify(b[f]) : b[f]);
      sets.push(`${f} = $${vals.length}${JSON_FIELDS.has(f) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return setter;
    vals.push(setter.id);
    return one(`UPDATE setters SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  });

  app.delete('/api/setters/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const setter = await one(`SELECT * FROM setters WHERE id = $1`, [req.params.id]);
    if (!setter) return reply.code(404).send({ error: 'No existe' });
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
