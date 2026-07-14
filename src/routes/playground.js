import { one } from '../db.js';
import { generateReply } from '../services/agent.js';
import { typingDelayMs } from '../services/humanize.js';
import { recordUsage, mergeSetter } from '../services/pipeline.js';
import { requireManageAgents, canAccessAccount } from '../lib/session.js';

export default async function playgroundRoutes(app) {
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
      return {
        ...result,
        memoria_final: { ...fakeConv.memory, ...result.memoria },
        delays: result.mensajes.map((m, i) => typingDelayMs(m, i)),
      };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });
}
