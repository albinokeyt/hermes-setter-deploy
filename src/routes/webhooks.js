import crypto from 'node:crypto';
import { one, q } from '../db.js';
import { redis } from '../lib/redis.js';
import { config, GHL_ED25519_KEY, GHL_RSA_KEY } from '../config.js';
import { handleInbound, handleOutboundEvent, handleAppointmentEvent, accountByLocation, logEvent } from '../services/pipeline.js';

const APPOINTMENT_TYPES = ['AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete'];

function tryVerify(algo, pem, raw, sigB64) {
  try {
    return crypto.verify(algo, Buffer.from(raw), crypto.createPublicKey(pem), Buffer.from(String(sigB64), 'base64'));
  } catch {
    return false;
  }
}

function verifySignature(req) {
  if (config.allowUnsignedWebhooks) return true;
  const raw = req.rawBody || '';
  const ed = req.headers['x-ghl-signature'];
  if (ed && tryVerify(null, GHL_ED25519_KEY, raw, ed)) return true;
  const rsa = req.headers['x-wh-signature'];
  if (rsa && tryVerify('sha256', GHL_RSA_KEY, raw, rsa)) return true;
  return false;
}

function freshTimestamp(p) {
  if (!p.timestamp) return true;
  const ts = new Date(p.timestamp).getTime();
  if (Number.isNaN(ts)) return true;
  return Math.abs(Date.now() - ts) < 5 * 60_000;
}

function normalizeMarketplaceEvent(p) {
  return {
    contactId: p.contactId,
    conversationId: p.conversationId,
    channel: p.messageType,
    body: p.body || '',
    messageId: p.messageId,
    userId: p.userId || null,
    attachments: Array.isArray(p.attachments) ? p.attachments : [],
    contactName: p.contactName || '',
  };
}

export default async function webhookRoutes(app) {
  // Webhook de la app de Marketplace (todas las subcuentas, una sola URL).
  // La ruta pública no lleva "ghl" (el validador del marketplace rechaza URLs
  // con referencias a HighLevel); /api/webhooks/ghl queda como alias legado.
  const marketplaceHandler = async (req, reply) => {
    const p = req.body || {};

    if (!verifySignature(req)) {
      await logEvent('firma_invalida', { type: p.type, locationId: p.locationId });
      return reply.code(401).send({ error: 'firma inválida' });
    }
    reply.send({ ok: true }); // responder rápido; procesamos después

    try {
      if (!freshTimestamp(p)) {
        await logEvent('timestamp_viejo', { type: p.type, timestamp: p.timestamp });
        return;
      }
      const dedupeKey = p.webhookId || p.messageId;
      if (dedupeKey) {
        const fresh = await redis.set(`wh:${dedupeKey}`, '1', 'EX', 172800, 'NX');
        if (!fresh) return; // reintento duplicado de GHL
      }

      const type = p.type;
      if (type !== 'InboundMessage' && type !== 'OutboundMessage' && !APPOINTMENT_TYPES.includes(type)) {
        await logEvent('evento_otro', { type, locationId: p.locationId });
        return;
      }
      const account = await accountByLocation(p.locationId);
      if (!account) {
        await logEvent('subcuenta_desconocida', { type, locationId: p.locationId, messageType: p.messageType });
        return;
      }
      if (APPOINTMENT_TYPES.includes(type)) {
        await handleAppointmentEvent(account, type, p);
        return;
      }
      await logEvent(type === 'InboundMessage' ? 'mensaje_recibido' : 'mensaje_saliente', {
        locationId: p.locationId, messageType: p.messageType, contactId: p.contactId, body: String(p.body || '').slice(0, 200),
      });
      const evt = normalizeMarketplaceEvent(p);
      if (type === 'InboundMessage') await handleInbound(account, evt);
      else await handleOutboundEvent(account, evt);
    } catch (err) {
      console.error('[webhook ghl]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  };
  app.post('/api/webhooks/inbox', marketplaceHandler);
  app.post('/api/webhooks/ghl', marketplaceHandler);

  // Webhook alternativo por cuenta (workflow "Customer Replied" → Custom Webhook), modo sin app de marketplace
  // Comentarios entrantes de Instagram: automatización de GHL → este webhook (por conexión).
  // Acepta campos flexibles (customData o top-level). Se guardan para el Archivo.
  app.post('/api/webhooks/comment/:token', async (req, reply) => {
    const account = await one(`SELECT id FROM accounts WHERE webhook_token = $1`, [req.params.token]);
    if (!account) return reply.code(404).send({ error: 'token desconocido' });
    reply.send({ ok: true });
    try {
      const p = req.body || {};
      const c = p.customData || p.custom_data || p;
      const text = c.comment || c.text || c.message || p.body || '';
      const author = c.author || c.username || c.from || c.contact_name || c.full_name || '';
      const authorId = c.author_id || c.user_id || p.contact_id || p.contactId || '';
      const post = c.post || c.post_id || c.media_id || c.permalink || c.post_url || '';
      const channel = c.channel || 'IG';
      if (!String(text).trim()) {
        await logEvent('comentario_incompleto', { account: account.id, keys: Object.keys(p) });
        return;
      }
      await q(
        `INSERT INTO comments (account_id, author, author_id, text, post_ref, channel, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [account.id, String(author), String(authorId), String(text), String(post), String(channel), JSON.stringify(p)]
      );
      await logEvent('comentario_recibido', { account: account.id, author: String(author), texto: String(text).slice(0, 200) });
    } catch (err) {
      console.error('[webhook comment]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  });

  app.post('/api/webhooks/workflow/:token', async (req, reply) => {
    const account = await one(`SELECT * FROM accounts WHERE webhook_token = $1`, [req.params.token]);
    if (!account) return reply.code(404).send({ error: 'token desconocido' });
    reply.send({ ok: true });

    try {
      const p = req.body || {};
      const custom = p.customData || p.custom_data || {};
      const contactId = custom.contact_id || p.contact_id || p.contactId || p.contact?.id;
      const body = custom.message || p.message?.body || (typeof p.message === 'string' ? p.message : '') || p.body || '';
      const channel = custom.channel || p.message?.type || p.channel || p.messageType || 'IG';
      if (!contactId || !String(body).trim()) {
        await logEvent('workflow_payload_incompleto', { account: account.id, keys: Object.keys(p) });
        return;
      }
      await logEvent('mensaje_recibido_workflow', { account: account.id, contactId, channel, body: String(body).slice(0, 200) });
      await handleInbound(account, {
        contactId: String(contactId),
        conversationId: null,
        channel,
        body: String(body),
        messageId: null,
        contactName: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.full_name || '',
        hasAttachments: false,
      });
    } catch (err) {
      console.error('[webhook workflow]', err);
      await logEvent('error_webhook', { error: err.message }).catch(() => {});
    }
  });
}
