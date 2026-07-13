import { chatCompletion } from './llm.js';
import { STAGE_KEYS, SYSTEM_STAGES } from '../config.js';

function stageGuide() {
  return `ETIQUETAS DISPONIBLES (elige la que mejor describa al lead DESPUÉS de tu respuesta):
- "nuevo": acaba de llegar, todavía no hay diálogo real.
- "en_conversacion": hay conversación activa y aún estás cualificando.
- "en_seguimiento": el lead dejó de responder y estás retomando (normalmente la pone el sistema).
- "calificado": cumple el filtro definido en el FLUJO y mostró interés real.
- "en_conversion": dio el paso clave (agendó, pidió el enlace, aceptó la propuesta).
- "descartado": no cumple el filtro, no le interesa, o es spam.
(Las etiquetas "agendado" y "agenda_cancelada" las pone el sistema automáticamente con el calendario: NO las uses tú; si el lead dice que ya reservó, usa "en_conversion".)`;
}

function styleRules(account) {
  return `REGLAS DE ESTILO (obligatorias):
- Escribes como una persona real por ${account.channels?.join(' y ') || 'chat'}: cercano, natural, en el idioma del lead (por defecto español).
- Mensajes CORTOS, como se chatea de verdad. Nada de párrafos largos, listas, negritas ni markdown.
- Divide tu respuesta en 1 a ${account.max_msgs || 3} mensajes según fluya natural (saludo aparte, idea aparte). Casi siempre 2 o 3.
- El lead puede haber enviado varios mensajes seguidos: respóndelos como un TODO, no uno por uno.
- Máximo UNA pregunta por turno.
- Emojis con mucha moderación (0 o 1), solo si encajan.
- Jamás digas que eres una IA salvo que te lo pregunten directamente; si te lo preguntan, no mientas.
- Nunca inventes datos, precios ni enlaces que no estén en tu contexto.
- Si el lead pide hablar con una persona, se molesta, o el caso es delicado: responde breve y marca "handoff": true.`;
}

function outputSpec() {
  return `FORMATO DE SALIDA — devuelve ÚNICAMENTE un JSON válido, sin texto fuera del JSON:
{
  "mensajes": ["primer mensaje", "segundo mensaje"],
  "etiqueta": "en_conversacion",
  "motivo": "una frase corta de por qué esa etiqueta",
  "memoria": { "campo": "solo datos NUEVOS o cambiados del lead (nombre, negocio, dolor, presupuesto, objeciones, acuerdos)" },
  "handoff": false
}`;
}

export function buildSystemPrompt(account, conversation, opts = {}) {
  const memoria = conversation?.memory && Object.keys(conversation.memory).length
    ? JSON.stringify(conversation.memory, null, 2)
    : '(aún sin datos)';
  const parts = [
    `Eres el setter comercial del negocio descrito abajo. Conversas por ${conversation?.channel || 'chat'} con un lead. Tu trabajo: conectar, cualificar y llevarlo al objetivo del FLUJO.`,
    `=== 1. IDENTIDAD Y PERSONALIDAD ===\n${account.prompt_identity || '(sin definir)'}`,
    `=== 2. NEGOCIO Y OFERTA ===\n${account.prompt_business || '(sin definir)'}`,
    `=== 3. FLUJO Y OBJETIVO ===\n${account.prompt_flow || '(sin definir)'}`,
    `=== MEMORIA DEL LEAD (lo que ya sabes de él) ===\n${memoria}`,
    styleRules(account),
    stageGuide(),
  ];
  if (opts.followupInstruction) {
    parts.push(`=== TAREA ESPECIAL: SEGUIMIENTO #${opts.followupNumber || 1} ===
El lead dejó de responder. Retoma la conversación de forma natural, sin sonar insistente ni desesperado.
Instrucción para este seguimiento: ${opts.followupInstruction}
Genera 1 o 2 mensajes como máximo. Etiqueta sugerida: "en_seguimiento".`);
  }
  parts.push(outputSpec());
  return parts.join('\n\n');
}

export function historyToMessages(history) {
  return history.map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));
}

export function parseAgentJson(content, account) {
  let text = String(content).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') {
    // fallback: el modelo respondió texto plano → lo troceamos por párrafos
    const chunks = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
    parsed = { mensajes: chunks.length ? chunks : [text], etiqueta: null, memoria: {}, handoff: false, motivo: '' };
  }
  let mensajes = Array.isArray(parsed.mensajes) ? parsed.mensajes : [String(parsed.mensajes || '')];
  mensajes = mensajes.map((m) => String(m || '').trim()).filter(Boolean);
  const max = account.max_msgs || 3;
  if (mensajes.length > max) {
    const keep = mensajes.slice(0, max - 1);
    keep.push(mensajes.slice(max - 1).join(' '));
    mensajes = keep;
  }
  const etiqueta = STAGE_KEYS.includes(parsed.etiqueta) && !SYSTEM_STAGES.includes(parsed.etiqueta) ? parsed.etiqueta : null;
  const memoria = parsed.memoria && typeof parsed.memoria === 'object' && !Array.isArray(parsed.memoria) ? parsed.memoria : {};
  return {
    mensajes,
    etiqueta,
    motivo: String(parsed.motivo || '').slice(0, 300),
    memoria,
    handoff: Boolean(parsed.handoff),
  };
}

export async function generateReply({ account, provider, conversation, history, followupInstruction = null, followupNumber = 1 }) {
  const system = buildSystemPrompt(account, conversation, { followupInstruction, followupNumber });
  const messages = [{ role: 'system', content: system }, ...historyToMessages(history)];
  if (messages.length === 1 || messages[messages.length - 1].role !== 'user') {
    messages.push({
      role: 'user',
      content: followupInstruction
        ? '(el lead no ha respondido; genera ahora el mensaje de seguimiento)'
        : '(continúa la conversación de forma natural)',
    });
  }
  const modelUsed = account.model || provider.default_model;
  const { content, usage } = await chatCompletion({
    provider,
    model: modelUsed,
    temperature: account.temperature ?? 0.8,
    messages,
    maxTokens: 900,
    json: true,
  });
  const parsed = parseAgentJson(content, account);
  if (!parsed.mensajes.length) throw new Error('el agente no generó mensajes');
  return { ...parsed, usage, model: modelUsed };
}
