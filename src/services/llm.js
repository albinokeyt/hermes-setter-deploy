export class LlmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Adaptador OpenAI-compatible: sirve para OpenRouter, Gemini (endpoint compat),
// Groq, Together, DeepSeek o cualquier proveedor con /chat/completions.
// Devuelve { content, usage } y reintenta solo (3 intentos) ante respuestas
// vacías, errores 429/5xx o fallos de red — el lead nunca se queda sin respuesta
// por un fallo puntual del proveedor.
export async function chatCompletion({ provider, model, temperature = 0.8, messages, maxTokens = 900, json = true }) {
  const baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
  const isOpenRouter = baseUrl.includes('openrouter.ai');

  const doRequest = async (withJsonFormat) => {
    const payload = { model, temperature, messages, max_tokens: maxTokens };
    if (withJsonFormat) payload.response_format = { type: 'json_object' };
    if (isOpenRouter) payload.usage = { include: true }; // OpenRouter devuelve el coste real en USD
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { res, data, text };
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let { res, data, text } = await doRequest(json);
      if (!res.ok && json && (res.status === 400 || res.status === 422)) {
        // algunos proveedores no soportan response_format → reintento sin él
        ({ res, data, text } = await doRequest(false));
      }
      if (!res.ok) {
        const err = new LlmError(`LLM ${provider.name} → ${res.status}: ${text.slice(0, 400)}`, res.status, data);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) throw err;
        lastErr = err;
      } else {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.trim()) {
          return { content, usage: data?.usage || null };
        }
        lastErr = new LlmError(`LLM ${provider.name} devolvió una respuesta vacía`, 502, data);
      }
    } catch (err) {
      if (err instanceof LlmError && !(err.status === 429 || err.status >= 500)) throw err;
      lastErr = err instanceof LlmError ? err : new LlmError(`LLM ${provider.name}: ${err.message}`, 0, null);
    }
    if (attempt < 2) await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

export async function testProvider(provider, model) {
  const { content } = await chatCompletion({
    provider,
    model: model || provider.default_model,
    temperature: 0,
    maxTokens: 50,
    json: false,
    messages: [{ role: 'user', content: 'Responde únicamente con la palabra: ok' }],
  });
  return content.trim().slice(0, 100);
}
