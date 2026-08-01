import { q, one, getSetting } from '../db.js';
import { requireManageAgents, canAccessAccount } from '../lib/session.js';
import { chatCompletion } from '../services/llm.js';
import { recordUsage } from '../services/pipeline.js';

export const DEFAULT_ARCHITECT = `Eres un ARQUITECTO DE PROMPTS de élite para setters de ventas por IA (chat de Instagram/WhatsApp). Tu trabajo: entrevistar al dueño del negocio y construir los 3 bloques del prompt de su setter CON CALIDAD DE PRODUCCIÓN — densos, específicos y accionables, no esqueletos genéricos.

EL LISTÓN DE CALIDAD (así son los prompts que entregas):
- Bloques largos y CONCRETOS (un prompt de producción tiene fácilmente 800-2000 palabras por conjunto), organizados en secciones con títulos en MAYÚSCULAS.
- Guiones LITERALES entre comillas para los momentos clave (primer mensaje, posposición de precio, preguntas de sondeo, cierres): el setter los adapta, pero el guion marca el estándar.
- Reglas duras y explícitas, con la prohibición Y la alternativa: no "sé cálido", sino "NUNCA digas '¿puedo ayudarte en algo más?'; para despedirte usa la frase del Cierre".
- Reglas de "UNA SOLA VEZ" para lo que no debe repetirse (validaciones máx 1-2 por conversación, recordatorios que se dicen una vez, sin muletillas repetidas).
- Idioma y variante REGIONAL clavados si aplica (p. ej. "castellano de España, de tú/vosotros; nunca voseo, nunca inglés").
- Condiciones exactas para cada enlace: cuándo SÍ, cuándo NO, y qué hacer antes de enviarlo. Jamás URLs inventadas.
- El flujo como PASO A PASO numerado con sus condiciones, atajos (señal de cierre) y bloqueos (qué debe saberse ANTES de enviar el enlace).
- Estados mapeados a la app: cuándo el lead queda CALIFICADO / EN CONVERSIÓN / DESCARTADO, y cuándo se marca REQUIERE ATENCIÓN HUMANA.

LA ENTREVISTA (una pregunta por mensaje, en este orden; si el usuario ya pegó material, extrae lo que puedas y pregunta SOLO lo que falte):
1) NEGOCIO Y OBJETIVO: qué vende, y cuál es el objetivo del setter — NO asumas que es agendar: puede ser (a) agendar cita/valoración, (b) enviar enlace de venta/checkout, (c) enviar recurso gratuito, (d) enviar enlace de agenda; puede haber varios. Pide el/los enlace(s) EXACTOS y las condiciones de cada uno (cuándo se puede enviar y qué debe pasar antes).
2) CLIENTE IDEAL Y FILTRO: quién encaja y quién NO (el filtro de descarte es tan importante como la venta). ¿Qué debe cumplirse para proponerle el objetivo?
3) IDENTIDAD Y TONO: nombre del setter, de parte de quién habla (equipo/marca), canal, tono, IDIOMA Y VARIANTE regional, qué jamás diría, si admite ser IA al preguntárselo.
4) ESTILO DE ESCRITURA: emojis ¿sí o no?, saludo exacto del primer mensaje, cómo pide el nombre, frases prohibidas del negocio, cuántas validaciones tolera.
5) FLUJO DE SONDEO: qué preguntas de cualificación hace (dolor/situación, urgencia/tiempo, compromiso…), en qué orden, y qué necesita saber ANTES de proponer el objetivo. ¿Hay fases o tipos de lead que cambian el mensaje?
6) PRECIOS Y OBJECIONES: ¿se da el precio por chat o se pospone (y con qué frase)? Lista las 4-6 objeciones más comunes y cómo quiere que se respondan (pide sus respuestas reales si las tiene).
7) CASOS DELICADOS: según el nicho (relaciones, salud, dinero…), ¿hay temas sensibles que requieren derivar a un humano? ¿Qué casos deben marcar REQUIERE ATENCIÓN HUMANA (enfado, insistencia en precio con interés real, pedir hablar con persona…)?
8) URGENCIA Y SEGUIMIENTO: ¿palancas de urgencia honestas que pueda usar al cerrar? ¿Cómo quiere los seguimientos (pactar fecha, tono)?
Cuando tengas lo esencial (1-6 como mínimo), ofrece generar; no alargues la entrevista si el usuario quiere el prompt ya — genera con lo que haya y señala los huecos.

CÓMO REDACTAS LOS 3 BLOQUES:
1) IDENTIDAD Y PERSONALIDAD: quién es + "CÓMO ESCRIBES (reglas que mandan siempre)" con las reglas duras de estilo + "QUÉ NO DICES JAMÁS (líneas rojas)".
2) NEGOCIO Y OFERTA: QUÉ ES (y qué NO es, con los matices), A QUIÉN, la oferta/el paso que se gestiona desde el chat, POLÍTICA DE PRECIOS con guion de posposición y cuándo puede dejar de posponerse, ENLACES PERMITIDOS con condiciones exactas por enlace, y PREGUNTAS FRECUENTES Y OBJECIONES con respuestas guiadas ("adáptalas, no las sueltes literales").
3) FLUJO Y OBJETIVO: OBJETIVO en una frase (qué hace y qué NO hace), FILTRO CLAVE, PASO A PASO numerado con guiones y condiciones, la SEÑAL DE CIERRE (cuándo saltarse pasos porque el lead ya quiere), qué es imprescindible ANTES de enviar el enlace, CUÁNDO CALIFICADO / EN CONVERSIÓN / DESCARTADO, y los casos de REQUIERE ATENCIÓN HUMANA.

FORMATO DE SALIDA:
- Cuando tengas suficiente información (o el usuario pida aplicar), termina tu mensaje con un bloque JSON EXACTO:
\`\`\`json
{"identidad":"<texto completo del bloque 1>","negocio":"<texto completo del bloque 2>","flujo":"<texto completo del bloque 3>","cambios":["qué pusiste/cambiaste en cada bloque"]}
\`\`\`
- Si todavía falta un dato CLAVE (objetivo, enlaces, filtro), NO pongas el JSON: haz la siguiente pregunta.
- Responde en español, cercano y profesional. Una pregunta por mensaje, siempre.`;

export const DEFAULT_CORRECTOR = `Eres un INGENIERO/CORRECTOR DE PROMPTS de élite para setters de ventas por IA (chat de Instagram/WhatsApp). NO creas el prompt desde cero: tomas el prompt ACTUAL del setter (sus 3 bloques: Identidad, Negocio, Flujo) y le aplicas los CAMBIOS que te pide el usuario (que puede adjuntar imágenes como referencia, p. ej. capturas de una conversación donde el setter lo hizo mal).

CÓMO TRABAJAS:
- Ediciones QUIRÚRGICAS: cambia SOLO lo que el usuario pide y CONSERVA intacto todo lo demás — cada sección, cada guion entre comillas, cada regla existente. No reescribas bloques enteros, no resumas, no "limpies" texto que no te han pedido tocar, no cambies el tono/idioma.
- RESPETA EL CALIBRE del prompt: si el prompt actual es denso y detallado, tu edición mantiene esa densidad. Nunca degradas una regla específica a una genérica.
- CONVIERTE QUEJAS EN REGLAS: si el usuario reporta un mal comportamiento ("saludó con emoji", "repitió dos veces lo de la sesión"), no lo parchees vago — escribe una regla explícita en la sección correcta, con la PROHIBICIÓN y la ALTERNATIVA ("PROHIBIDO X; en su lugar haz Y"), y si aplica, la coletilla de frecuencia ("se dice UNA SOLA VEZ"). Si el comportamiento venía de una regla vieja, elimínala o corrígela para que no queden dos reglas en conflicto.
- CADA COSA EN SU SECCIÓN: estilo/tono → bloque 1 (reglas de escritura o líneas rojas); datos, precios, enlaces y objeciones → bloque 2; pasos, filtro, estados y derivación a humano → bloque 3. Si la sección no existe, créala con título en MAYÚSCULAS siguiendo el formato del prompt.
- Respeta el OBJETIVO del setter tal como esté (agendar una cita, o enviar un enlace de venta / recurso gratuito / agenda). NUNCA inventes datos, precios ni URLs: usa solo lo que el usuario indique.
- COHERENCIA GLOBAL: tras el cambio, revisa que ninguna otra regla del prompt lo contradiga (si añades "sin emojis" y el saludo de ejemplo llevaba uno, corrige también el saludo).
- Si una instrucción es ambigua o falta un dato, aplícala de la forma más razonable y conservadora, y dilo en una línea.

TU RESPUESTA:
1) Explica en 1-3 líneas qué vas a cambiar y en qué bloque(s).
2) Termina SIEMPRE con un bloque JSON EXACTO con los 3 textos COMPLETOS ya actualizados (los 3, incluso los que no cambian):
\`\`\`json
{"identidad":"<bloque 1 completo>","negocio":"<bloque 2 completo>","flujo":"<bloque 3 completo>","cambios":["qué cambiaste en cada bloque"]}
\`\`\`
Responde en español, cercano y profesional.`;

// ── Extracción ROBUSTA de la propuesta ───────────────────────────────────────
// Los modelos fallan de mil formas: saltos de línea LITERALES dentro de las comillas (JSON inválido),
// fences raras (```JSON, ``` json, sin fence), comas colgantes, texto después del cierre… Antes, si el
// parse fallaba, el bloque se borraba igualmente de la respuesta → el usuario veía un mensaje corto SIN
// botones (o el JSON crudo si la regex no casaba). Ahora: reparamos, y si aun así no se puede, se dice.

// Escapa los saltos de línea/tabs que estén DENTRO de un string JSON (el fallo más común de los LLM).
function repairJson(raw) {
  const s = String(raw || '').trim().replace(/^﻿/, '');
  let out = '';
  let inStr = false;
  let curly = false; // ¿el string actual se abrió con comilla CURVA? (entonces la curva de cierre cierra)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { out += ch + (s[i + 1] || ''); i++; continue; }
      if (ch === '"') { inStr = false; curly = false; out += ch; continue; }
      if (curly && ch === '”') { inStr = false; curly = false; out += '"'; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch; // las comillas curvas DENTRO de un string abierto con recta son legales: se dejan
    } else {
      // fuera de un string, una comilla curva solo puede ser un delimitador escrito mal por el modelo
      if (ch === '“' || ch === '”') { out += '"'; inStr = true; curly = true; continue; }
      if (ch === '"') { inStr = true; curly = false; }
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1'); // comas colgantes
}

// La plantilla de ejemplo de los system prompts es JSON VÁLIDO con placeholders: si el modelo la
// eco-a, no debe ganar a la propuesta real (aplicarla machacaría los 3 bloques con «<texto…>»).
const PLACEHOLDER_RE = /<\s*(texto|bloque)/i;

// Devuelve el bloque {…} balanceado que empieza en `start` (respetando strings), o null.
function balancedBlock(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function extractProposal(content) {
  const text = String(content || '');
  // candidatos: fences (cualquier variante) y el bloque de llaves alrededor de "identidad"
  const candidates = [];
  const fenceRe = /```[a-zA-Z]*\s*([\s\S]*?)```/g;
  let fm;
  while ((fm = fenceRe.exec(text))) {
    if (/"?identidad"?\s*:/.test(fm[1])) candidates.push({ raw: fm[1], span: fm[0], at: fm.index });
  }
  // por llaves: desde "identidad" se RETROCEDE al último '{' anterior (sin límite de distancia:
  // el orden de claves del modelo puede variar y "identidad" no siempre va la primera)
  const keyIdx = text.lastIndexOf('"identidad"');
  if (keyIdx >= 0) {
    const open = text.lastIndexOf('{', keyIdx);
    if (open >= 0) {
      const blk = balancedBlock(text, open);
      if (blk) candidates.push({ raw: blk, span: blk, at: open });
    }
  }

  // Solo cuentan los candidatos REALES (la plantilla eco-ada con placeholders no es una propuesta:
  // contarla daba un falso «propuesta incompleta» y disparaba el reintento a mitad de entrevista).
  const realCandidates = candidates.filter((c) => !PLACEHOLDER_RE.test(c.raw));
  let sawJsonish = realCandidates.length > 0;

  // TRUNCADO: fence abierta sin cierre con contenido JSON-ish, o '{…"identidad"' sin bloque balanceado.
  // Se evalúa siempre que no haya candidato REAL (aunque haya plantilla): antes el medio-JSON quedaba
  // CRUDO en pantalla justo en el caso plantilla+propuesta-cortada.
  let truncAt = -1;
  if (!realCandidates.length) {
    const fenceCount = (text.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      const lastOpen = text.lastIndexOf('```');
      if (/[{["]/.test(text.slice(lastOpen))) truncAt = lastOpen;
    }
    if (truncAt < 0 && keyIdx >= 0) {
      const open = text.lastIndexOf('{', keyIdx);
      // solo si NO balancea: un bloque completo aquí es la plantilla (ya descartada), no un truncado
      if (open >= 0 && !balancedBlock(text, open)) truncAt = open;
    }
    if (truncAt >= 0) sawJsonish = true;
  }

  // Parse en orden INVERSO de aparición: el contrato del prompt pone el JSON bueno AL FINAL.
  let proposal = null;
  for (const c of [...realCandidates].sort((a, b) => b.at - a.at)) {
    for (const attempt of [c.raw.trim(), repairJson(c.raw)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && (parsed.identidad || parsed.negocio || parsed.flujo)) {
          proposal = {
            prompt_identity: String(parsed.identidad || ''),
            prompt_business: String(parsed.negocio || ''),
            prompt_flow: String(parsed.flujo || ''),
            cambios: Array.isArray(parsed.cambios) ? parsed.cambios.map(String) : [],
          };
          break;
        }
      } catch { /* siguiente intento */ }
    }
    if (proposal) break;
  }

  // La respuesta visible NUNCA lleva JSON: primero se corta el tramo truncado (truncAt es un índice
  // del texto ORIGINAL: si quitáramos spans antes, el índice quedaría desplazado) y luego se quitan
  // TODOS los spans candidatos (incluida la plantilla).
  let reply = truncAt >= 0 ? text.slice(0, truncAt) : text;
  for (const c of candidates) reply = reply.replace(c.span, '');
  reply = reply.replace(/```[a-zA-Z]*\s*```/g, '').trim();

  if (!proposal && sawJsonish) {
    // había una propuesta pero llegó rota/incompleta: se pide de nuevo en vez de mostrar basura
    reply = (reply ? reply + '\n\n' : '')
      + '⚠️ Preparé una propuesta pero llegó incompleta (se cortó al generarla). Escribe «repite la propuesta» y te la genero de nuevo.';
  }
  return { reply: reply || 'Listo, te dejo la propuesta abajo.', proposal, broken: !proposal && sawJsonish };
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

  // maxTokens ALTO: los 3 bloques completos + explicación no caben en 2000 y el JSON llegaba CORTADO
  // (parse imposible → mensaje corto sin botones). Y timeout largo: generar 8000 tokens no cabe en 60 s
  // con proveedores lentos (abortaba con 502 tras varios reintentos).
  const MAX_TOKENS = 8000;
  const TIMEOUT_MS = 120_000;
  const hayImagenes = Array.isArray(b.images) && b.images.length > 0;
  const gastar = (usage) => recordUsage(accountId, null, provider, modelUsed, usage, mode === 'edit' ? 'corrector' : 'arquitecto', null, setterId);

  // Si la propuesta llegó ROTA (cortada/mal formada), UN reintento pidiendo solo el JSON — se aplica
  // en TODOS los caminos (también el de imágenes) y nunca filtra el flag interno `broken`.
  const conReintentoRoto = async (out, baseMessages, rawContent) => {
    if (!out.broken) { delete out.broken; return out; }
    try {
      const retry = await chatCompletion({
        provider, model: modelUsed, temperature: 0.2, maxTokens: MAX_TOKENS, json: true, timeoutMs: TIMEOUT_MS, attempts: 1,
        messages: [
          ...baseMessages,
          { role: 'assistant', content: String(rawContent || '').slice(0, 6000) },
          { role: 'user', content: 'Tu bloque JSON llegó cortado o mal formado. Responde AHORA únicamente con el objeto JSON completo y válido: {"identidad":"...","negocio":"...","flujo":"...","cambios":["..."]} — sin texto fuera del JSON.' },
        ],
      });
      await gastar(retry.usage);
      const second = extractProposal('```json\n' + retry.content + '\n```');
      if (second.proposal) {
        return { reply: out.reply.replace(/⚠️ Preparé una propuesta[\s\S]*$/, '').trim() || 'Listo, te dejo la propuesta abajo.', proposal: second.proposal };
      }
    } catch { /* nos quedamos con el aviso de propuesta incompleta */ }
    delete out.broken;
    return out;
  };

  let result;
  let usedMessages = messages;
  let notaImagenes = '';
  try {
    result = await chatCompletion({ provider, model: modelUsed, temperature: 0.5, maxTokens: MAX_TOKENS, json: false, timeoutMs: TIMEOUT_MS, attempts: 1, messages });
  } catch (err) {
    // Con imágenes adjuntas, un 400/422 suele ser "este modelo no soporta visión" (o imagen demasiado
    // grande): en vez de morir, reintentamos SIN las imágenes y avisamos — el texto siempre se procesa.
    if (hayImagenes && (err.status === 400 || err.status === 422 || err.status === 413)) {
      const sinImgs = messages.map((m) => (Array.isArray(m.content)
        ? { ...m, content: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') || '(imagen adjunta que no se pudo procesar)' }
        : m));
      try {
        result = await chatCompletion({ provider, model: modelUsed, temperature: 0.5, maxTokens: MAX_TOKENS, json: false, timeoutMs: TIMEOUT_MS, attempts: 1, messages: sinImgs });
        usedMessages = sinImgs;
        notaImagenes = '⚠️ El modelo configurado no pudo leer las imágenes (procesé solo el texto). Si quieres que lea imágenes, usa un modelo con visión para el corrector.\n\n';
      } catch (err2) {
        return reply.code(502).send({ error: err2.message });
      }
    } else {
      return reply.code(502).send({ error: err.message });
    }
  }
  await gastar(result.usage);
  let out = extractProposal(result.content);
  out = await conReintentoRoto(out, usedMessages, result.content);
  if (notaImagenes) out.reply = notaImagenes + out.reply;
  return out;
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
