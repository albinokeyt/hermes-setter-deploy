import { q, one, getSetting } from '../db.js';
import { requireManageAgents, canAccessAccount } from '../lib/session.js';
import { chatCompletion } from '../services/llm.js';
import { recordUsage } from '../services/pipeline.js';

export const DEFAULT_ARCHITECT = `Eres un ARQUITECTO DE PROMPTS experto para setters de ventas por IA (chat de Instagram/WhatsApp). Ayudas al dueño del setter a construir los 3 bloques de su prompt:
1) IDENTIDAD Y PERSONALIDAD — quién es el setter, tono, idioma, cómo escribe (mensajes cortos, 1 pregunta por mensaje, humano, sin sonar robótico), qué jamás diría.
2) NEGOCIO Y OFERTA — qué se vende, a quién, precios/condiciones (o que no se dan por chat), beneficios, objeciones y respuestas, enlaces permitidos.
3) FLUJO Y OBJETIVO — el paso a paso de la conversación: cómo cualifica, el FILTRO de encaje, el OBJETIVO, y cuándo el lead está calificado / en conversión / descartado.

MUY IMPORTANTE SOBRE EL OBJETIVO: NO asumas que hay que agendar una cita. El objetivo puede ser: (a) agendar una cita/valoración en un calendario, (b) enviar un enlace de venta/checkout, (c) enviar un enlace de recurso gratuito (lead magnet), o (d) enviar el enlace de agenda. Pregunta SIEMPRE cuál es el objetivo (puede haber más de uno) y con qué enlace(s), y redacta el flujo para ese objetivo concreto. Si es un enlace, el flujo debe indicar cuándo y cómo enviarlo (nunca inventes URLs: usa las que dé el usuario).

CÓMO TRABAJAS:
- Entrevistas con preguntas claras y UNA a la vez. No abrumes. Si el usuario ya te dio contexto o pega material, aprovéchalo.
- Entre tus primeras preguntas, aclara el OBJETIVO (agendar / enviar link de venta / recurso gratis / agenda) y pide el/los enlace(s) exactos.
- Escribes prompts EXCELENTES: concretos, accionables, con reglas de estilo humano y de humanización.
- Cuando tengas suficiente información (o el usuario pida aplicar), termina tu mensaje con un bloque JSON EXACTO:
\`\`\`json
{"identidad":"<texto completo del bloque 1>","negocio":"<texto completo del bloque 2>","flujo":"<texto completo del bloque 3>","cambios":["qué pusiste/cambiaste en cada bloque"]}
\`\`\`
- Si todavía te falta un dato clave, NO pongas el JSON: haz la siguiente pregunta.
- Responde en español, cercano y profesional.`;

export const DEFAULT_CORRECTOR = `Eres un INGENIERO/CORRECTOR DE PROMPTS para setters de ventas por IA (chat de Instagram/WhatsApp). NO creas el prompt desde cero: tomas el prompt ACTUAL del setter (sus 3 bloques: Identidad, Negocio, Flujo) y le aplicas los CAMBIOS que te pide el usuario (que puede adjuntar imágenes como referencia).

CÓMO TRABAJAS:
- Ediciones QUIRÚRGICAS: cambia SOLO lo que el usuario pide y CONSERVA intacto todo lo demás (no reescribas bloques enteros ni cambies el tono/idioma si no te lo piden).
- Respeta el OBJETIVO del setter tal como esté (agendar una cita, o enviar un enlace de venta / recurso gratuito / agenda). NUNCA inventes datos, precios ni URLs: usa solo lo que el usuario indique.
- Si una instrucción es ambigua o falta un dato, aplícala de la forma más razonable y conservadora, y dilo en una línea.
- Si adjunta imágenes, úsalas como referencia de lo que quiere cambiar.

TU RESPUESTA:
1) Explica en 1-3 líneas qué vas a cambiar y en qué bloque(s).
2) Termina SIEMPRE con un bloque JSON EXACTO con los 3 textos COMPLETOS ya actualizados (los 3, incluso los que no cambian):
\`\`\`json
{"identidad":"<bloque 1 completo>","negocio":"<bloque 2 completo>","flujo":"<bloque 3 completo>","cambios":["qué cambiaste en cada bloque"]}
\`\`\`
Responde en español, cercano y profesional.`;

// Extrae { reply, proposal } de la respuesta del modelo (busca el bloque JSON).
function extractProposal(content) {
  const text = String(content || '');
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*"identidad"[\s\S]*"flujo"[\s\S]*\})/i);
  let proposal = null;
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && (parsed.identidad || parsed.negocio || parsed.flujo)) {
        proposal = {
          prompt_identity: String(parsed.identidad || ''),
          prompt_business: String(parsed.negocio || ''),
          prompt_flow: String(parsed.flujo || ''),
          cambios: Array.isArray(parsed.cambios) ? parsed.cambios.map(String) : [],
        };
      }
    } catch {}
  }
  const reply = m ? text.replace(m[0], '').trim() : text.trim();
  return { reply: reply || 'Listo, te dejo la propuesta abajo.', proposal };
}

function toUserContent(text, images) {
  const imgs = Array.isArray(images) ? images.filter((u) => typeof u === 'string' && u.startsWith('data:')).slice(0, 4) : [];
  if (!imgs.length) return text;
  return [{ type: 'text', text }, ...imgs.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

// Ejecuta el chat del arquitecto/corrector sobre un "target" con prompt_identity/business/flow.
// accountId = la conexión (para atribuir gasto); setterId = el setter si aplica.
async function runPromptEditor(target, accountId, setterId, req, reply) {
  const b = req.body || {};
  const mode = b.mode === 'edit' ? 'edit' : 'architect';

  const cfg = (await getSetting(mode === 'edit' ? 'corrector_model' : 'architect_model', {})) || {};
  const provId = cfg.provider_id || target.provider_id;
  const provider = provId ? await one(`SELECT * FROM providers WHERE id = $1`, [provId]) : null;
  if (!provider) return reply.code(400).send({ error: 'No hay modelo de IA para el arquitecto/corrector. Configúralo en Configuración o en la pestaña IA del setter.' });
  const modelUsed = cfg.model || target.model || provider.default_model;

  const base = mode === 'edit'
    ? ((await getSetting('corrector_prompt', null))?.text || DEFAULT_CORRECTOR)
    : ((await getSetting('architect_prompt', null))?.text || DEFAULT_ARCHITECT);

  const current = `=== PROMPT ACTUAL DEL SETTER "${target.name}" ===
[1 · IDENTIDAD]\n${target.prompt_identity || '(vacío)'}\n
[2 · NEGOCIO]\n${target.prompt_business || '(vacío)'}\n
[3 · FLUJO]\n${target.prompt_flow || '(vacío)'}`;

  const system = `${base}\n\n${current}`;
  const history = (Array.isArray(b.history) ? b.history : [])
    .slice(-20)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text || '') }))
    .filter((m) => m.content);

  const messages = [{ role: 'system', content: system }, ...history];
  const lastText = String(b.message || (history.length ? '' : (mode === 'edit' ? 'Aplica los cambios indicados.' : 'Ayúdame a crear el prompt de mi setter.')));
  if (lastText || (b.images && b.images.length)) {
    messages.push({ role: 'user', content: toUserContent(lastText || 'Aplica estos cambios según las imágenes.', b.images) });
  }

  let result;
  try {
    result = await chatCompletion({ provider, model: modelUsed, temperature: 0.5, maxTokens: 2000, json: false, messages });
  } catch (err) {
    return reply.code(502).send({ error: err.message });
  }
  await recordUsage(accountId, null, provider, modelUsed, result.usage, mode === 'edit' ? 'corrector' : 'arquitecto', null, setterId);
  return extractProposal(result.content);
}

export default async function promptEditorRoutes(app) {
  // Disponible para admin Y para el dueño con IA activa (requireManageAgents), cada uno
  // solo sobre SUS conexiones/setters (canAccessAccount).
  app.addHook('preHandler', async (req, reply) => {
    if (!(await requireManageAgents(req, reply))) return reply;
  });

  // Arquitecto/corrector de un SETTER concreto (los prompts viven en el setter, no en la conexión).
  // body: { history, images?, mode:'architect'|'edit', message? }
  app.post('/api/setters/:id/prompt-editor', async (req, reply) => {
    const setter = await one(`SELECT * FROM setters WHERE id = $1`, [req.params.id]);
    if (!setter) return reply.code(404).send({ error: 'Setter no encontrado' });
    if (!(await canAccessAccount(req, setter.account_id))) return reply.code(403).send({ error: 'Sin acceso a este setter' });
    return runPromptEditor(setter, setter.account_id, setter.id, req, reply);
  });
}
