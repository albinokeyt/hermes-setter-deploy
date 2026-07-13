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
  await q(`INSERT INTO users (username, password_hash) VALUES ($1, $2)`, [
    config.adminUser,
    hashPassword(config.adminPassword),
  ]);
  console.log(`[auth] usuario inicial creado: ${config.adminUser}`);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.setex(`sess:${token}`, SESSION_TTL, String(userId));
  return token;
}

export async function destroySession(token) {
  if (token) await redis.del(`sess:${token}`);
}

const PUBLIC_PREFIXES = ['/api/auth/login', '/api/webhooks/', '/api/oauth/callback', '/api/health'];

export function authHook() {
  return async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const token = req.cookies?.hermes_session;
    const userId = token ? await redis.get(`sess:${token}`) : null;
    if (!userId) {
      reply.code(401).send({ error: 'no_autenticado' });
      return reply;
    }
    req.userId = Number(userId);
    await redis.expire(`sess:${token}`, SESSION_TTL);
  };
}
