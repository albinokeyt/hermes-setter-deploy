import crypto from 'node:crypto';
import { redis } from './redis.js';
import { one, q } from '../db.js';
import { config } from '../config.js';

const SESSION_TTL = 60 * 60 * 24 * 7;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export async function seedAdmin() {
  const existing = await one(`SELECT id FROM users LIMIT 1`);
  if (existing) return;
  await q(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')`, [
    config.adminUser,
    hashPassword(config.adminPassword),
  ]);
  console.log(`[auth] usuario inicial creado: ${config.adminUser}`);
}

// La sesión guarda un JSON: { userId?, portalUserId?, role, accountId, portal }
export async function createSession(payload) {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.setex(`sess:${token}`, SESSION_TTL, JSON.stringify(payload));
  return token;
}

export function setSessionCookie(reply, token, opts = {}) {
  // El portal se abre embebido en un iframe de GHL → necesita SameSite=None; Secure.
  const portal = opts.portal === true;
  reply.setCookie('hermes_session', token, {
    path: '/',
    httpOnly: true,
    sameSite: portal ? 'none' : 'lax',
    secure: portal ? true : config.isProd,
    maxAge: SESSION_TTL,
  });
}

export async function destroySession(token) {
  if (token) await redis.del(`sess:${token}`);
}

const PUBLIC_PREFIXES = ['/api/auth/login', '/api/webhooks/', '/api/oauth/callback', '/api/health', '/api/portal/register', '/api/portal/sso'];

export function authHook() {
  return async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const token = req.cookies?.hermes_session;
    const raw = token ? await redis.get(`sess:${token}`) : null;
    if (!raw) {
      reply.code(401).send({ error: 'no_autenticado' });
      return reply;
    }
    let auth = null;
    try { auth = JSON.parse(raw); } catch { auth = null; }
    if (!auth || typeof auth !== 'object') {
      // compatibilidad con sesiones antiguas (guardaban solo el id numérico)
      const user = await one(`SELECT * FROM users WHERE id = $1`, [Number(raw) || 0]);
      if (!user) {
        reply.code(401).send({ error: 'no_autenticado' });
        return reply;
      }
      auth = { userId: user.id, role: user.role || 'admin', accountId: user.account_id || null, portal: false };
    }
    req.auth = auth;
    req.userId = auth.userId || null;
    await redis.expire(`sess:${token}`, SESSION_TTL);
  };
}

// Devuelve false (y responde 403) si el usuario no es admin.
export function requireAdmin(req, reply) {
  if (req.auth?.role !== 'admin') {
    reply.code(403).send({ error: 'Solo para administradores' });
    return false;
  }
  return true;
}

// Devuelve false (y responde 403) si el usuario NO puede gestionar agentes.
// Admin siempre puede; un usuario restringido (can_manage_agents=false) no.
export async function requireManageAgents(req, reply) {
  if (req.auth?.role === 'admin') return true;
  const u = req.userId ? await one(`SELECT can_manage_agents FROM users WHERE id = $1`, [req.userId]) : null;
  if (u && u.can_manage_agents === false) {
    reply.code(403).send({ error: 'Tu usuario solo tiene acceso a los mensajes, no a configurar los agentes' });
    return false;
  }
  // La IA debe estar activada en su conexión (modelo SaaS: el admin la habilita).
  const accId = req.auth?.accountId;
  if (accId) {
    const acc = await one(`SELECT ai_enabled FROM accounts WHERE id = $1`, [accId]);
    if (acc && acc.ai_enabled === false) {
      reply.code(403).send({ error: 'La IA no está activada en esta conexión' });
      return false;
    }
  }
  return true;
}

// Alcance de datos de una petición. FAIL-CLOSED: un no-admin sin cuenta asignada
// no ve NADA (denied), en lugar de verlo todo.
//   admin           → { all: true }
//   user con cuenta → { all: false, accountId }
//   user sin cuenta → { all: false, denied: true }
export function accountScope(req) {
  if (req.auth?.role === 'admin') return { all: true, accountId: null, denied: false };
  const accountId = req.auth?.accountId || null;
  if (!accountId) return { all: false, accountId: null, denied: true };
  return { all: false, accountId, denied: false };
}

// Conjunto de conexiones a las que un NO-admin tiene acceso: su cuenta de sesión MÁS
// las conexiones que POSEE por correo (owner_email) — para clientes con varias subcuentas.
// admin → null (todas). Devuelve array (vacío = sin acceso). Async.
export async function accessibleAccountIds(req) {
  if (req.auth?.role === 'admin') return null;
  const ids = new Set();
  if (req.auth?.accountId) ids.add(Number(req.auth.accountId));
  if (req.auth?.portalUserId) {
    const pu = await one(`SELECT email FROM portal_users WHERE id = $1`, [req.auth.portalUserId]);
    const email = String(pu?.email || '').trim().toLowerCase();
    if (email) {
      const rows = await q(`SELECT id FROM accounts WHERE lower(owner_email) = $1`, [email]);
      for (const r of rows) ids.add(Number(r.id));
    }
  }
  return [...ids];
}

// ¿este no-admin puede acceder a esta cuenta? admin siempre. Async.
export async function canAccessAccount(req, accountId) {
  const ids = await accessibleAccountIds(req);
  if (ids === null) return true;
  return ids.includes(Number(accountId));
}

// Compat: id de cuenta al que está limitado un no-admin (para filtros WHERE).
// admin → null (sin filtro). user sin cuenta → -1 (no existe → resultado vacío).
export function scopedAccountId(req) {
  const s = accountScope(req);
  if (s.all) return null;
  return s.accountId || -1;
}
