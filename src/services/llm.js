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

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // 15 MB: cubre imágenes y notas de voz normales

// Descarga un adjunto con tope de tamaño (streaming) para no agotar la memoria del proceso.
async function fetchMedia(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new LlmError(`no se pudo descargar el adjunto (${res.status})`, res.status, null);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > MAX_MEDIA_BYTES) {
    throw new LlmError(`adjunto demasiado grande (${Math.round(declared / 1e6)} MB)`, 413, null);
  }
  const chunks = [];
  let total = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_MEDIA_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new LlmError('adjunto demasiado grande', 413, null);
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) throw new LlmError('adjunto demasiado grande', 413, null);
    chunks.push(buf);
  }
  const buffer = Buffer.concat(chunks);
  return { buffer, contentType, dataUrl: `data:${contentType};base64,${buffer.toString('base64')}` };
}

function audioExt(url, contentType) {
  const fromUrl = String(url).split('?')[0].split('.').pop()?.toLowerCase();
  if (fromUrl && /^(mp3|ogg|oga|opus|m4a|wav|amr|aac|webm|mp4|mpeg)$/.test(fromUrl)) return fromUrl.replace('mpeg', 'mp3');
  const fromType = (contentType.split('/')[1] || '').split(';')[0].replace('mpeg', 'mp3').replace('x-m4a', 'm4a');
  if (fromType && fromType !== 'octet-stream') return fromType;
  return 'mp3';
}

// Lee una imagen con un modelo de visión (chat OpenAI-compatible con image_url).
export async function describeImage({ provider, model, imageUrl, context }) {
  const media = await fetchMedia(imageUrl);
  const baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
  const prompt =
    'Un lead ha enviado esta imagen en una conversación de ventas por Instagram/WhatsApp. ' +
    'Describe en español, en 1-2 frases, qué se ve y cualquier texto legible que contenga (capturas, documentos, productos, etc.). ' +
    'Sé concreto y útil para que un vendedor entienda qué mandó.' +
    (context ? ` Contexto de la conversación: ${context}` : '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.api_key}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: media.dataUrl } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw new LlmError(`visión ${provider.name} → ${res.status}: ${text.slice(0, 300)}`, res.status, data);
  const out = data?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) throw new LlmError('el modelo de visión no devolvió descripción', 502, data);
  return { text: String(out).trim(), usage: data?.usage || null };
}

// Transcribe un audio con un modelo compatible con /audio/transcriptions (Whisper).
export async function transcribeAudio({ provider, model, audioUrl }) {
  const media = await fetchMedia(audioUrl);
  const baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
  const ext = audioExt(audioUrl, media.contentType);
  const form = new FormData();
  form.append('file', new Blob([media.buffer], { type: media.contentType }), `audio.${ext}`);
  form.append('model', model);
  form.append('response_format', 'json');
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.api_key}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!res.ok) throw new LlmError(`audio ${provider.name} → ${res.status}: ${text.slice(0, 300)}`, res.status, data);
  const out = data?.text;
  if (!out || !String(out).trim()) throw new LlmError('el modelo de audio no devolvió transcripción', 502, data);
  // usage.cost = coste real en USD; usage.seconds = duración del audio
  return { text: String(out).trim(), usage: data?.usage || null };
}
