// 💸 TOPE DE GASTO MENSUAL por conexión (accounts.tope_mensual_usd, migración 059).
//
// NULL = sin tope (lo de siempre). Con tope, la puerta de atender (marketplace.puedeAtender) comprueba el consumo del
// MES NATURAL en la zona horaria de la conexión: si llega al tope, no se llama a la IA (mismo trato que «sin saldo»:
// se reprograma y, pasado el plazo, se descarta con traza) y queda el evento «tope_mensual_alcanzado».
// El consumo es el PRECIO AL CLIENTE congelado en llm_usage.billed_usd (coste × multiplicador): lo mismo que se le
// cobra. Las pruebas (simulador aparte, Probar agente, editor de prompts) van a 0 y no cuentan.
// Sin dependencias de Redis ni del pipeline: se prueba con una base en memoria (test/club.test.mjs).

import { pool as poolReal } from '../db.js';

const ZONA_POR_DEFECTO = 'Europe/Madrid';

export function zonaValida(tz) {
  const z = String(tz || '').trim();
  if (!z) return ZONA_POR_DEFECTO;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return ZONA_POR_DEFECTO;
  }
}

// Desfase (ms) de la zona en un instante: hora de pared leída como UTC − instante real.
function desfase(tz, instante) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instante));
  const v = Object.fromEntries(partes.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(instante / 1000) * 1000;
}

/** Instante (Date) en que empezó el mes natural actual en la zona `tz` (día 1 a las 00:00 de esa zona). */
export function inicioMes(tz, ahora = new Date()) {
  const zona = zonaValida(tz);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit' }).formatToParts(ahora);
  const anio = Number(f.find((p) => p.type === 'year').value);
  const mes = Number(f.find((p) => p.type === 'month').value);
  const pared = Date.UTC(anio, mes - 1, 1, 0, 0, 0);
  // dos pasadas: el desfase puede cambiar entre la conjetura y el resultado (horario de verano)
  let t = pared - desfase(zona, pared);
  t = pared - desfase(zona, t);
  return new Date(t);
}

/** Tope válido en USD o null (sin tope). Acepta el NUMERIC de pg (texto). */
export function topeDe(account) {
  const v = account?.tope_mensual_usd;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normaliza lo que manda el admin. Devuelve { ok:true, valor } (valor null = sin tope) o { ok:false, error }.
 */
export function sanearTope(v) {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, valor: null };
  const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'El tope de gasto mensual tiene que ser un importe mayor que 0 (o vacío para no poner tope).' };
  if (n > 100000) return { ok: false, error: 'El tope de gasto mensual no puede pasar de 100.000 USD.' };
  return { ok: true, valor: Math.round(n * 100) / 100 };
}

export async function consumoMes(accountId, desde, pg = poolReal) {
  const r = await pg.query(
    `SELECT COALESCE(SUM(billed_usd), 0) AS c FROM llm_usage WHERE account_id = $1 AND created_at >= $2 AND billed_usd > 0`,
    [accountId, desde]
  );
  return Number(r.rows[0]?.c) || 0;
}

/**
 * ¿Ha llegado la conexión a su tope del mes? { alcanzado, tope, consumo, desde }.
 * Sin tope → { alcanzado:false } sin tocar la base.
 */
export async function comprobarTope(account, pg = poolReal, ahora = new Date()) {
  const tope = topeDe(account);
  if (tope === null || !account?.id) return { alcanzado: false, tope: null };
  const desde = inicioMes(account.timezone, ahora);
  const consumo = await consumoMes(account.id, desde, pg);
  return { alcanzado: consumo >= tope, tope, consumo: Math.round(consumo * 10000) / 10000, desde };
}
