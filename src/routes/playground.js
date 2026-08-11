import { one } from '../db.js';
import { generateReply } from '../services/agent.js';
import { typingDelayMs } from '../services/humanize.js';
import { recordUsage, mergeSetter, filtrarRepetidos } from '../services/pipeline.js';
import { requireManageAgents, canAccessAccount, accessibleAccountIds } from '../lib/session.js';

export default async function playgroundRoutes(app) {
  // Gasto acumulado en pruebas y ajustes (playground + corrector + arquitecto), scoped:
  // admin ve el total; un usuario, solo el de sus conexiones.
  app.get('/api/playground/spend', async (req) => {
    const ids = await accessibleAccountIds(req);
    const row = await one(
      `SELECT COALESCE(SUM(cost_usd), 0) AS costo, COALESCE(SUM(COALESCE(billed_usd, cost_usd)), 0) AS facturado, COUNT(*)::int AS llamadas
       FROM llm_usage WHERE source IN ('playground', 'corrector', 'arquitecto')
       ${ids ? 'AND account_id = ANY($1::int[])' : ''}`,
      ids ? [ids] : []
    );
    if (!row) return { costo: 0, facturado: 0, llamadas: 0 };
    // el COSTO real es solo del admin; al cliente se le muestra lo facturado
    if (req.auth?.role !== 'admin') row.costo = row.facturado;
    return row;
  });

  app.post('/api/playground/reply', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return;
    const { account_id, setter_id, history = [], memory = {} } = req.body || {};
    if (!(await canAccessAccount(req, account_id))) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    let account = await one(`SELECT * FROM accounts WHERE id = $1`, [account_id]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });

    // Probar un setter concreto de la conexión (su prompt, su modelo, su config).
    let setterId = null;
    if (setter_id) {
      const s = await one(`SELECT * FROM setters WHERE id = $1 AND account_id = $2`, [setter_id, account.id]);
      if (!s) return reply.code(404).send({ error: 'Ese setter no existe en esta conexión' });
      account = { ...mergeSetter(account, s), bot_enabled: true }; // en el playground se prueba aunque esté apagado
      setterId = s.id;
    }

    const provider = account.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [account.provider_id]) : null;
    if (!provider) return reply.code(400).send({ error: 'Este setter no tiene proveedor de IA configurado (sección APIs)' });

    const mapped = (Array.isArray(history) ? history : [])
      .slice(-30)
      .map((m) => ({ direction: m.role === 'lead' ? 'inbound' : 'outbound', body: String(m.text || '') }))
      .filter((m) => m.body);

    const fakeConv = { channel: 'IG', memory: memory && typeof memory === 'object' ? memory : {} };
    try {
      const result = await generateReply({ account, provider, conversation: fakeConv, history: mapped });
      await recordUsage(account.id, null, provider, result.model, result.usage, 'playground', null, setterId);
      // mismo filtro que las respuestas normales de producción (solo burbujas duplicadas dentro de
      // la tanda; contra el historial no se filtra): lo que se prueba es lo que saldría de verdad
      const rep = filtrarRepetidos(result.mensajes, []);
      result.mensajes = rep.unicos;
      return {
        ...result,
        repetidos_filtrados: rep.filtrados.length,
        memoria_final: { ...fakeConv.memory, ...result.memoria },
        delays: result.mensajes.map((m, i) => typingDelayMs(m, i)),
      };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });
}
