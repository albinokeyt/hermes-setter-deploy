import { one } from '../db.js';
import { generateReply } from '../services/agent.js';
import { typingDelayMs } from '../services/humanize.js';
import { recordUsage } from '../services/pipeline.js';
import { scopedAccountId } from '../lib/session.js';

export default async function playgroundRoutes(app) {
  app.post('/api/playground/reply', async (req, reply) => {
    const { account_id, history = [], memory = {} } = req.body || {};
    const scope = scopedAccountId(req);
    if (scope && Number(account_id) !== scope) return reply.code(403).send({ error: 'Sin acceso a esta cuenta' });
    const account = await one(`SELECT * FROM accounts WHERE id = $1`, [account_id]);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const provider = account.provider_id ? await one(`SELECT * FROM providers WHERE id = $1`, [account.provider_id]) : null;
    if (!provider) return reply.code(400).send({ error: 'Esta cuenta no tiene proveedor de IA configurado (sección APIs)' });

    const mapped = (Array.isArray(history) ? history : [])
      .slice(-30)
      .map((m) => ({ direction: m.role === 'lead' ? 'inbound' : 'outbound', body: String(m.text || '') }))
      .filter((m) => m.body);

    const fakeConv = { channel: 'IG', memory: memory && typeof memory === 'object' ? memory : {} };
    try {
      const result = await generateReply({ account, provider, conversation: fakeConv, history: mapped });
      await recordUsage(account.id, null, provider, result.model, result.usage, 'playground');
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
