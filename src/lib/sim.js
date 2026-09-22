// 🧪 SIMULADOR: contactos ficticios que recorren el motor REAL (webhook de etiquetas, activación,
// debounce, respuesta, seguimientos, ventana de Meta) sin tocar GoHighLevel ni cobrar al cliente.
// El marcador es el id del contacto: «sim:xxxxxxxx». Todo lo que en el pipeline hable con GHL
// (leer etiquetas, historial, nombre, enviar, sincronizar etiquetas, cobrar) consulta esSim() y,
// si es una simulación, usa lo guardado aquí (etiquetas en Redis) o simplemente no lo hace.
import crypto from 'node:crypto';
import { redis } from './redis.js';

export const SIM_PREFIX = 'sim:';
export const esSim = (contactId) => String(contactId || '').startsWith(SIM_PREFIX);
export const nuevoIdSim = () => SIM_PREFIX + crypto.randomBytes(4).toString('hex');

const simTagsKey = (accountId, contactId) => `simtags:${accountId}:${contactId}`;

// Etiquetas «de GHL» del contacto simulado (lo que en un contacto real devolvería getContact).
export async function getSimTags(accountId, contactId) {
  const raw = await redis.get(simTagsKey(accountId, contactId)).catch(() => null);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr.map((t) => String(t)) : []; } catch { return []; }
}
export async function setSimTags(accountId, contactId, tags) {
  const lista = [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t || '').trim()).filter(Boolean))];
  await redis.set(simTagsKey(accountId, contactId), JSON.stringify(lista), 'EX', 30 * 86400);
  return lista;
}
export async function borrarSimTags(accountId, contactId) {
  await redis.del(simTagsKey(accountId, contactId)).catch(() => {});
}
