import { q, one } from '../db.js';
import { testProvider } from '../services/llm.js';
import { requireAdmin } from '../lib/session.js';

const PRESETS = [
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', default_model: 'google/gemini-2.5-flash-lite', notes: 'Un solo API key para cientos de modelos' },
  { name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', default_model: 'gemini-2.5-flash-lite', notes: 'Endpoint OpenAI-compatible oficial de Google' },
  { name: 'Groq', base_url: 'https://api.groq.com/openai/v1', default_model: 'llama-3.3-70b-versatile', notes: 'Velocidad extrema' },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', default_model: 'gpt-5-mini', notes: '' },
  { name: 'Personalizado', base_url: '', default_model: '', notes: 'Cualquier API compatible con /chat/completions' },
];

function mask(row) {
  const key = String(row.api_key || '');
  return { ...row, api_key_masked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '', api_key: undefined };
}

export default async function providerRoutes(app) {
  // las APIs de IA son solo de administración
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/providers/presets', async () => PRESETS);

  app.get('/api/providers', async () => {
    const rows = await q(`
      SELECT p.*, (SELECT COUNT(*)::int FROM accounts a WHERE a.provider_id = p.id) AS accounts_count
      FROM providers p ORDER BY p.id`);
    return rows.map(mask);
  });

  app.post('/api/providers', async (req, reply) => {
    const { name, base_url, api_key, default_model, notes, price_in, price_out } = req.body || {};
    if (!name || !base_url || !api_key) return reply.code(400).send({ error: 'Faltan nombre, URL base o API key' });
    const row = await one(
      `INSERT INTO providers (name, base_url, api_key, default_model, notes, price_in, price_out) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, String(base_url).replace(/\/+$/, ''), api_key, default_model || '', notes || '', price_in || null, price_out || null]
    );
    return mask(row);
  });

  app.put('/api/providers/:id', async (req, reply) => {
    const existing = await one(`SELECT * FROM providers WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const row = await one(
      `UPDATE providers SET name=$1, base_url=$2, api_key=$3, default_model=$4, notes=$5, price_in=$6, price_out=$7 WHERE id=$8 RETURNING *`,
      [
        b.name || existing.name,
        String(b.base_url || existing.base_url).replace(/\/+$/, ''),
        b.api_key ? b.api_key : existing.api_key,
        b.default_model ?? existing.default_model,
        b.notes ?? existing.notes,
        b.price_in !== undefined ? b.price_in || null : existing.price_in,
        b.price_out !== undefined ? b.price_out || null : existing.price_out,
        existing.id,
      ]
    );
    return mask(row);
  });

  app.delete('/api/providers/:id', async (req) => {
    await q(`DELETE FROM providers WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.post('/api/providers/:id/test', async (req, reply) => {
    const provider = await one(`SELECT * FROM providers WHERE id = $1`, [req.params.id]);
    if (!provider) return reply.code(404).send({ error: 'No existe' });
    try {
      const out = await testProvider(provider, req.body?.model);
      return { ok: true, respuesta: out };
    } catch (err) {
      return reply.code(400).send({ ok: false, error: err.message });
    }
  });
}
