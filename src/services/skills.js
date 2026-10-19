// 🧩 SKILLS del setter: acciones que el setter puede EJECUTAR en el CRM además de conversar (no solo
// contestar). Cada skill se enciende por setter (pestaña «Skills», todas apagadas por defecto). El modelo
// las pide en el campo "acciones" del JSON; aquí se validan y se ejecutan contra GHL ANTES de enviar sus
// mensajes, para que el setter nunca diga «ya está cambiado» si GHL no lo cambió.
import { q } from '../db.js';
import { redis } from '../lib/redis.js';
import { esSim } from '../lib/sim.js';
import * as ghl from './ghl.js';

export const SKILLS = {
  cambiar_email: {
    nombre: 'Cambiar el correo del contacto',
    descripcion: 'Si el lead dice que ese no es su correo (o que no le llegan los correos), el setter le ofrece cambiarlo, se lo confirma y Hermes actualiza el correo del contacto en GHL.',
  },
};

const MAX_CAMBIOS_EMAIL = 3; // por conversación: más que eso huele a abuso o a bucle → a una persona

// Normaliza lo que llega del panel: solo skills conocidas, campos acotados.
export function sanitizeSkills(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const out = {};
  for (const key of Object.keys(SKILLS)) {
    const s = src[key];
    if (!s || typeof s !== 'object') continue;
    out[key] = {
      activo: Boolean(s.activo),
      etiqueta: String(s.etiqueta || '').trim().slice(0, 100),
      instrucciones: String(s.instrucciones || '').trim().slice(0, 800),
    };
  }
  return out;
}

export function skillsActivas(account) {
  const s = account?.skills && typeof account.skills === 'object' ? account.skills : {};
  return Object.keys(SKILLS).filter((k) => s[k]?.activo);
}

// Bloque del prompt: SOLO si el setter tiene alguna skill encendida (los demás setters no cambian ni una coma).
export function bloqueSkills(account, conversation) {
  const activas = skillsActivas(account);
  if (!activas.length) return '';
  const partes = [];
  if (activas.includes('cambiar_email')) {
    const cfg = account.skills.cambiar_email || {};
    const actual = String(conversation?.lead_email || '').trim();
    partes.push(`· CAMBIAR EL CORREO DEL CONTACTO → acción "cambiar_email"
Correo que tenemos ahora guardado: ${actual || '(ninguno)'}
Cuándo: el lead dice que ese correo no es el suyo, que se equivocó al escribirlo, que no le llegan los correos o que quiere usar otro.
Cómo:
1. Ofrécele cambiarlo y pídele el correo correcto (si aún no lo ha escrito).
2. Cuando lo escriba completo, repíteselo TAL CUAL y pídele que te confirme que está bien escrito. Todavía NO pongas la acción.
3. Cuando lo confirme (o si en un mismo mensaje lo escribe y te pide sin dudas que lo cambies), pon "acciones": [{"tipo": "cambiar_email", "email": "el correo exacto"}] y dile que ya queda cambiado.
Usa EXACTAMENTE el correo que escribió el lead: nunca lo inventes ni lo «arregles» tú; si ves una errata clara (p. ej. «gmial.com»), pregúntale antes. Si ya lo cambiaste en esta conversación y no pide otro distinto, no repitas la acción.${cfg.instrucciones ? `\nDespués de cambiarlo: ${cfg.instrucciones}` : ''}`);
  }
  return `=== SKILLS: ACCIONES QUE PUEDES EJECUTAR EN EL CRM ===
Además de conversar, puedes ejecutar estas acciones con el campo "acciones" del JSON de salida. Úsalas SOLO cuando se cumpla su condición; si no, "acciones": [].
${partes.join('\n\n')}`;
}

// Lo que el modelo pidió → lista validada (solo skills encendidas, sin duplicados, tope 3).
export function parseAcciones(raw, account) {
  const activas = new Set(skillsActivas(account));
  if (!activas.size || !Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 3)) {
    const tipo = String(a?.tipo || '').trim();
    if (!activas.has(tipo)) continue;
    if (tipo === 'cambiar_email') {
      const email = String(a?.email || '').trim().toLowerCase().slice(0, 254);
      if (!out.some((x) => x.tipo === tipo)) out.push({ tipo, email });
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z]{2,}$/i;

// ¿Salió ese correo en la conversación? Defensa contra un correo alucinado: solo vale si aparece literal (sin
// mayúsculas) en los últimos mensajes: escrito por el lead, o propuesto por el setter («¿es ana@gmail.com?», p. ej.
// al corregir una errata) y confirmado por el lead justo después.
function loEscribioElLead(email, history) {
  const ult = (Array.isArray(history) ? history : []).slice(-12);
  return ult.some((m) => String(m.body || '').toLowerCase().includes(email));
}

/**
 * Ejecuta las acciones de una respuesta. Devuelve { reemplazo, handoff, motivo } cuando hay que cambiar lo
 * que iba a decir el setter (la acción no se pudo hacer: no puede afirmar que está hecha), o null si todo fue bien.
 */
export async function ejecutarAcciones({ account, conv, acciones, history, logEvent }) {
  let salida = null;
  for (const a of acciones) {
    if (a.tipo !== 'cambiar_email') continue;
    const base = { conv: conv.id, setter: account.setter_id || null, email_nuevo: a.email, email_antes: conv.lead_email || '' };
    if (!EMAIL_RE.test(a.email) || !loEscribioElLead(a.email, history)) {
      await logEvent('skill_email_rechazado', { ...base, motivo: !EMAIL_RE.test(a.email) ? 'formato' : 'no_lo_escribio_el_lead' });
      salida = { reemplazo: ['Para cambiarlo bien, ¿me escribes aquí tu correo completo, tal cual?'], handoff: false };
      continue;
    }
    if (String(conv.lead_email || '').trim().toLowerCase() === a.email) {
      await logEvent('skill_email_ya_estaba', base);
      continue; // ya es ese: el «ya está» del setter es verdad
    }
    const n = await redis.incr(`skillmail:${conv.id}`);
    await redis.expire(`skillmail:${conv.id}`, 30 * 86400);
    if (n > MAX_CAMBIOS_EMAIL) {
      await logEvent('skill_email_tope', { ...base, cambios: n - 1 });
      salida = { reemplazo: ['Le paso tu correo al equipo para que lo revisen y lo dejen bien 🙏'], handoff: true, motivo: `pide cambiar el correo otra vez (${a.email}) tras ${MAX_CAMBIOS_EMAIL} cambios` };
      continue;
    }
    const cfg = account.skills?.cambiar_email || {};
    if (esSim(conv.ghl_contact_id)) {
      // 🧪 simulador: mismo recorrido, sin tocar GHL
      await q(`UPDATE conversations SET lead_email = $1, updated_at = now() WHERE id = $2`, [a.email, conv.id]);
      await logEvent('skill_email_cambiado', { ...base, simulado: true, etiqueta: cfg.etiqueta || '' });
      continue;
    }
    try {
      await ghl.updateContact(account, conv.ghl_contact_id, { email: a.email });
    } catch (err) {
      const duplicado = /duplicat|already exists|ya existe/i.test(String(err.message));
      await logEvent('skill_email_fallo', { ...base, motivo: duplicado ? 'correo_de_otro_contacto' : 'error_ghl', error: String(err.message).slice(0, 200) });
      await ghl.addNote(account, conv.ghl_contact_id, `Hermes (${account.setter_name || 'setter'}): el lead pidió cambiar su correo a ${a.email}, pero GHL no lo dejó cambiar${duplicado ? ' (ese correo ya es de otro contacto)' : ''}. Correo actual: ${conv.lead_email || '(ninguno)'}.`).catch(() => {});
      salida = { reemplazo: ['Uy, no he podido cambiarlo desde aquí 🙏 Le paso tu correo nuevo al equipo para que lo cambien ellos.'], handoff: true, motivo: `no se pudo cambiar el correo a ${a.email}` };
      continue;
    }
    await q(`UPDATE conversations SET lead_email = $1, memory = memory || $2::jsonb, updated_at = now() WHERE id = $3`, [a.email, JSON.stringify({ email: a.email }), conv.id]);
    conv.lead_email = a.email;
    await ghl.addNote(account, conv.ghl_contact_id, `Hermes (${account.setter_name || 'setter'}): correo cambiado a petición del lead. Antes: ${base.email_antes || '(ninguno)'} · Ahora: ${a.email}.`).catch(() => {});
    if (cfg.etiqueta) {
      await ghl.addTags(account, conv.ghl_contact_id, [cfg.etiqueta]).catch(async (err) => {
        await logEvent('skill_email_etiqueta_fallo', { ...base, etiqueta: cfg.etiqueta, error: String(err.message).slice(0, 200) });
      });
    }
    await logEvent('skill_email_cambiado', { ...base, etiqueta: cfg.etiqueta || '' });
  }
  return salida;
}

