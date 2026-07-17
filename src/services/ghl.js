import { GHL_API } from '../config.js';
import { one, q, getSetting } from '../db.js';
import { redis } from '../lib/redis.js';

const V_CONVERSATIONS = '2021-04-15';
const V_CONTACTS = '2021-07-28';

export class GhlError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function oauthTokenRequest(params) {
  const res = await fetch(`${GHL_API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000), // siempre menor que el TTL del lock de refresh
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(`oauth/token fallo (${res.status})`, res.status, body);
  return body;
}

export async function exchangeCode(code) {
  const creds = (await getSetting('ghl_app', {})) || {};
  return oauthTokenRequest({
    client_id: creds.client_id || '',
    client_secret: creds.client_secret || '',
    grant_type: 'authorization_code',
    code,
    user_type: 'Location', // pide token a NIVEL SUBCUENTA (si no, GHL devuelve uno de agencia sin locationId)
  });
}

// Mintea un token de SUBCUENTA a partir de un token de AGENCIA. Necesario cuando la app se
// instala a nivel agencia: el code se cambia por un token de agencia (companyId, sin locationId)
// y con esto se obtiene el de la subcuenta concreta. La respuesta trae su propio refresh_token.
export async function getLocationToken(agencyAccessToken, companyId, locationId) {
  const res = await fetch(`${GHL_API}/oauth/locationToken`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agencyAccessToken}`,
      version: V_CONTACTS,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ companyId, locationId }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(`oauth/locationToken fallo (${res.status})`, res.status, body);
  return body;
}

// Intercambia el code y garantiza un token de SUBCUENTA. Si GHL devuelve uno de agencia
// (sin locationId) y sabemos qué subcuenta es (knownLocationId), lo convierte automáticamente.
export async function exchangeCodeForLocation(code, knownLocationId = '') {
  const tok = await exchangeCode(code);
  if (tok.locationId) return tok;
  const companyId = tok.companyId || tok.company_id;
  if (companyId && knownLocationId && tok.access_token) {
    const locTok = await getLocationToken(tok.access_token, companyId, String(knownLocationId));
    if (locTok.locationId) return locTok;
  }
  return tok; // sigue sin locationId → saveTokens lanza el error explicativo
}

export async function saveTokens(tok) {
  if (!tok.locationId) throw new GhlError('el token recibido no trae locationId (instala la app en una subcuenta, no a nivel agencia)', 400, tok);
  const expiresAt = new Date(Date.now() + (tok.expires_in || 86400) * 1000 - 60_000);
  await q(
    `INSERT INTO ghl_tokens (location_id, access_token, refresh_token, expires_at, company_id, raw, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (location_id) DO UPDATE
     SET access_token = $2, refresh_token = $3, expires_at = $4, company_id = $5, raw = $6, updated_at = now()`,
    [tok.locationId, tok.access_token, tok.refresh_token, expiresAt, tok.companyId || null, JSON.stringify(tok)]
  );
  return tok.locationId;
}

async function refreshTokens(locationId) {
  // lock para que dos workers no quemen el mismo refresh_token (es de un solo uso)
  const lockKey = `ghl:refresh:${locationId}`;
  const gotLock = await redis.set(lockKey, '1', 'EX', 60, 'NX');
  if (!gotLock) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const row = await one(`SELECT * FROM ghl_tokens WHERE location_id = $1`, [locationId]);
      if (row && new Date(row.expires_at).getTime() > Date.now()) return row;
      if (!(await redis.get(lockKey))) break;
    }
    return one(`SELECT * FROM ghl_tokens WHERE location_id = $1`, [locationId]);
  }
  try {
    const row = await one(`SELECT * FROM ghl_tokens WHERE location_id = $1`, [locationId]);
    if (!row) throw new GhlError(`no hay tokens para la subcuenta ${locationId}`, 401);
    if (new Date(row.expires_at).getTime() > Date.now()) return row;
    const creds = (await getSetting('ghl_app', {})) || {};
    const tok = await oauthTokenRequest({
      client_id: creds.client_id || '',
      client_secret: creds.client_secret || '',
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      user_type: 'Location',
    });
    tok.locationId = tok.locationId || locationId;
    await saveTokens(tok);
    return one(`SELECT * FROM ghl_tokens WHERE location_id = $1`, [locationId]);
  } finally {
    await redis.del(lockKey);
  }
}

async function tokenFor(account) {
  if (account.mode === 'pit') {
    if (!account.pit_token) throw new GhlError(`la cuenta ${account.name} no tiene Private Integration Token`, 401);
    return account.pit_token;
  }
  if (!account.location_id) throw new GhlError(`la cuenta ${account.name} no tiene subcuenta GHL conectada`, 401);
  let row = await one(`SELECT * FROM ghl_tokens WHERE location_id = $1`, [account.location_id]);
  if (!row) throw new GhlError(`la subcuenta ${account.location_id} no está conectada por OAuth`, 401);
  if (new Date(row.expires_at).getTime() <= Date.now()) row = await refreshTokens(account.location_id);
  if (!row) throw new GhlError(`no se pudo refrescar el token de ${account.location_id}`, 401);
  return row.access_token;
}

export async function ghlApi(account, method, path, { body, version = V_CONVERSATIONS, retry = true } = {}) {
  const token = await tokenFor(account);
  const res = await fetch(`${GHL_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      version,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 && retry && account.mode === 'oauth' && account.location_id) {
    await q(`UPDATE ghl_tokens SET expires_at = now() - interval '1 minute' WHERE location_id = $1`, [account.location_id]);
    return ghlApi(account, method, path, { body, version, retry: false });
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new GhlError(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status, data);
  return data;
}

export async function sendMessage(account, { channel, contactId, message }) {
  return ghlApi(account, 'POST', '/conversations/messages', {
    body: { type: channel, contactId, message },
  });
}

// Historial de mensajes de un contacto (para el ACTIVADOR EXTERNO: el setter lee lo hablado
// antes de escribir). Busca su conversación más reciente en GHL y trae los últimos mensajes.
export async function listContactMessages(account, contactId, limit = 20) {
  const search = await ghlApi(
    account, 'GET',
    `/conversations/search?locationId=${encodeURIComponent(account.location_id)}&contactId=${encodeURIComponent(contactId)}`,
    { version: V_CONVERSATIONS }
  );
  const convs = Array.isArray(search?.conversations) ? search.conversations : [];
  if (!convs.length) return { conversationId: null, messages: [] };
  const convId = convs[0].id;
  const data = await ghlApi(account, 'GET', `/conversations/${encodeURIComponent(convId)}/messages?limit=${limit}`, { version: V_CONVERSATIONS });
  const raw = Array.isArray(data?.messages?.messages) ? data.messages.messages : (Array.isArray(data?.messages) ? data.messages : []);
  const messages = raw
    .filter((m) => m && String(m.body || '').trim())
    .map((m) => ({
      id: m.id || null,
      direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
      body: String(m.body || ''),
      type: m.messageType || m.type || '',
      // hora REAL del mensaje en GHL, para ordenar cronológicamente al importar (no por id de inserción)
      dateAdded: m.dateAdded || m.dateUpdated || null,
    }))
    .reverse(); // GHL devuelve recientes primero → cronológico
  return { conversationId: convId, messages };
}

export async function getContact(account, contactId) {
  const data = await ghlApi(account, 'GET', `/contacts/${contactId}`, { version: V_CONTACTS });
  return data.contact || data;
}

// Crea una etiqueta en la subcuenta (para que exista EXACTA y el workflow la use sin diferencias).
export async function createLocationTag(account, name) {
  return ghlApi(account, 'POST', `/locations/${encodeURIComponent(account.location_id)}/tags`, {
    body: { name: String(name).trim() }, version: V_CONTACTS,
  });
}

export async function addTags(account, contactId, tags) {
  return ghlApi(account, 'POST', `/contacts/${contactId}/tags`, { body: { tags }, version: V_CONTACTS });
}

export async function removeTags(account, contactId, tags) {
  return ghlApi(account, 'DELETE', `/contacts/${contactId}/tags`, { body: { tags }, version: V_CONTACTS });
}

export async function listCalendars(account, locationId) {
  const data = await ghlApi(account, 'GET', `/calendars/?locationId=${encodeURIComponent(locationId)}`, { version: V_CONVERSATIONS });
  const cals = Array.isArray(data?.calendars) ? data.calendars : [];
  return cals.map((c) => ({ id: c.id, name: c.name || c.calendarName || c.id, active: c.isActive !== false }));
}

// Usuarios reales de la subcuenta en GHL (para autorizar el acceso al portal).
// Requiere el scope users.readonly y token de la subcuenta.
export async function listLocationUsers(account, locationId) {
  const data = await ghlApi(account, 'GET', `/users/?locationId=${encodeURIComponent(locationId)}`, { version: V_CONTACTS });
  const users = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : [];
  return users
    .map((u) => ({
      id: u.id,
      email: String(u.email || '').trim().toLowerCase(),
      name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
    }))
    .filter((u) => u.email.includes('@'));
}

export async function getLocationName(account, locationId) {
  try {
    const data = await ghlApi(account, 'GET', `/locations/${locationId}`, { version: V_CONTACTS });
    return data?.location?.name || '';
  } catch {
    return '';
  }
}
