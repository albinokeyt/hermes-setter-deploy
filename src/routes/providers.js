import { q, one } from '../db.js';
import { testProvider } from '../services/llm.js';
import { requireAdmin } from '../lib/session.js';

const VALID_KINDS = ['text', 'image', 'audio'];

const PRESETS = [
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', default_model: 'google/gemini-2.5-flash-lite', notes: 'Un solo API key: chat, visión y audio (Whisper)', kinds: ['text', 'image', 'audio'] },
  { name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', default_model: 'gemini-2.5-flash-lite', notes: 'Chat y visión (OpenAI-compatible oficial)', kinds: ['text', 'image'] },
  { name: 'Groq', base_url: 'https://api.groq.com/openai/v1', default_model: 'llama-3.3-70b-versatile', notes: 'Chat rápido y audio (Whisper)', kinds: ['text', 'audio'] },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', default_model: 'gpt-5-mini', notes: 'Chat, visión y audio', kinds: ['text', 'image', 'audio'] },
  { name: 'Personalizado', base_url: '', default_model: '', notes: 'Cualquier API compatible con /chat/completions', kinds: ['text'] },
];

function cleanKinds(kinds, fallback) {
  if (!Array.isArray(kinds)) return fallback;
  const out = kinds.filter((k) => VALID_KINDS.includes(k));
  return out.length ? out : fallback;
}

function mask(row) {
  const key = String(row.api_key || '');
  return { ...row, api_key_masked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '', api_key: undefined };
}

// Cache en memoria del catálogo de OpenRouter (con precios), 10 min por lista.
const _orCache = {};
async function openRouterModels(query = '') {
  const key = query || 'chat';
  const hit = _orCache[key];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.models;
  const res = await fetch(`https://openrouter.ai/api/v1/models${query}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter /models → ${res.status}`);
  const data = await res.json();
  const models = Array.isArray(data.data) ? data.data : [];
  _orCache[key] = { at: Date.now(), models };
  return models;
}

export default async function providerRoutes(app) {
  // las APIs de IA son solo de administración
  app.addHook('preHandler', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
  });

  app.get('/api/providers/presets', async () => PRESETS);

  // Cada categoría del buscador mapea a un filtro real de OpenRouter (coincide con sus pestañas).
  const CATEGORY_QUERY = {
    text: '?output_modalities=text',
    vision: '?input_modalities=image',          // modelos que LEEN imágenes (visión)
    transcription: '?output_modalities=transcription', // audio → texto
    image: '?output_modalities=image',           // generar imagen
    speech: '?output_modalities=speech',         // texto → voz
    audio: '?output_modalities=audio',
    video: '?output_modalities=video',
  };

  // Los modelos de transcripción NO se cobran por token sino por audio, y la unidad
  // (minuto / hora / segundo) varía por modelo — OpenRouter no la expone en su API,
  // así que la mapeamos según lo que muestra su web (verificado modelo a modelo).
  function audioUnit(id) {
    const s = String(id).toLowerCase();
    if (s.includes('whisper-large-v3-turbo')) return 'hour';
    if (s.includes('mai-transcribe')) return 'hour';
    if (s.includes('qwen3-asr') || s.includes('asr-flash')) return 'second';
    if (s.includes('whisper') || s.includes('chirp') || s.includes('parakeet') || s.includes('voxtral')) return 'minute';
    return 'audio'; // desconocido: mostramos el valor crudo sin afirmar la unidad
  }

  // Lista de modelos de OpenRouter en vivo (con precios), por categoría.
  app.get('/api/providers/models', async (req, reply) => {
    const category = String(req.query?.category || 'text').toLowerCase();
    const query = CATEGORY_QUERY[category] || CATEGORY_QUERY.text;
    try {
      const models = await openRouterModels(query);
      const per1M = (v) => (v ? Math.round(Number(v) * 1_000_000 * 1000) / 1000 : 0);
      const list = models
        .map((m) => {
          const prompt = m.pricing?.prompt || '0';
          const completion = m.pricing?.completion || '0';
          // en transcripción, los modelos sin precio de salida se cobran por audio (tiempo)
          if (category === 'transcription' && Number(completion) === 0) {
            return { id: m.id, name: m.name || m.id, unit: audioUnit(m.id), price: String(prompt) };
          }
          return { id: m.id, name: m.name || m.id, unit: 'token', price_in: per1M(prompt), price_out: per1M(completion) };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models: list };
    } catch (err) {
      return reply.code(502).send({ error: `No pude consultar OpenRouter: ${err.message}` });
    }
  });

  // Consulta el precio de un modelo en OpenRouter y lo devuelve en $ por 1M de tokens.
  app.get('/api/providers/price', async (req, reply) => {
    const model = String(req.query?.model || '').trim();
    if (!model) return reply.code(400).send({ error: 'Escribe primero el modelo' });
    try {
      const models = await openRouterModels();
      const low = model.toLowerCase();
      const m =
        models.find((x) => x.id === model) ||
        models.find((x) => String(x.id).toLowerCase() === low) ||
        models.find((x) => String(x.id).toLowerCase().endsWith('/' + low)) ||
        models.find((x) => String(x.canonical_slug || '').toLowerCase() === low);
      if (!m || !m.pricing) {
        return reply.code(404).send({ error: `No encontré "${model}" en OpenRouter. Escríbelo como aparece allí (ej. openai/gpt-4o-mini).` });
      }
      const per1M = (v) => (v ? Math.round(Number(v) * 1_000_000 * 1000) / 1000 : 0);
      return { found: true, name: m.name || m.id, price_in: per1M(m.pricing.prompt), price_out: per1M(m.pricing.completion) };
    } catch (err) {
      return reply.code(502).send({ error: `No pude consultar OpenRouter: ${err.message}` });
    }
  });

  app.get('/api/providers', async () => {
    const rows = await q(`
      SELECT p.*, (SELECT COUNT(*)::int FROM accounts a WHERE a.provider_id = p.id) AS accounts_count
      FROM providers p ORDER BY p.id`);
    return rows.map(mask);
  });

  app.post('/api/providers', async (req, reply) => {
    const { name, base_url, api_key, default_model, notes, price_in, price_out } = req.body || {};
    if (!name || !base_url || !api_key) return reply.code(400).send({ error: 'Faltan nombre, URL base o API key' });
    const kinds = cleanKinds(req.body?.kinds, ['text']);
    const row = await one(
      `INSERT INTO providers (name, base_url, api_key, default_model, notes, price_in, price_out, kinds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [name, String(base_url).replace(/\/+$/, ''), api_key, default_model || '', notes || '', price_in || null, price_out || null, JSON.stringify(kinds)]
    );
    return mask(row);
  });

  app.put('/api/providers/:id', async (req, reply) => {
    const existing = await one(`SELECT * FROM providers WHERE id = $1`, [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'No existe' });
    const b = req.body || {};
    const kinds = cleanKinds(b.kinds, existing.kinds);
    const row = await one(
      `UPDATE providers SET name=$1, base_url=$2, api_key=$3, default_model=$4, notes=$5, price_in=$6, price_out=$7, kinds=$8::jsonb WHERE id=$9 RETURNING *`,
      [
        b.name || existing.name,
        String(b.base_url || existing.base_url).replace(/\/+$/, ''),
        b.api_key ? b.api_key : existing.api_key,
        b.default_model ?? existing.default_model,
        b.notes ?? existing.notes,
        b.price_in !== undefined ? b.price_in || null : existing.price_in,
        b.price_out !== undefined ? b.price_out || null : existing.price_out,
        JSON.stringify(kinds),
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
