export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/hermes',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'cambiame',
  appBaseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  // Escape hatch por si GHL rota claves y aún no actualizaste (no recomendado)
  allowUnsignedWebhooks: process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true',
  isProd: process.env.NODE_ENV === 'production',
};

// Claves públicas oficiales de HighLevel para verificar la firma de los webhooks
// (docs: marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide)
// Header actual: X-GHL-Signature (Ed25519). Header legacy: X-WH-Signature (RSA, se deprecia el 2026-09-01).
export const GHL_ED25519_KEY = process.env.GHL_WEBHOOK_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export const GHL_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

export const GHL_API = 'https://services.leadconnectorhq.com';

export const STAGES = [
  { key: 'nuevo', label: 'Nuevo', color: '#64748b' },
  { key: 'en_conversacion', label: 'En conversación', color: '#3b82f6' },
  { key: 'en_seguimiento', label: 'En seguimiento', color: '#f59e0b' },
  { key: 'calificado', label: 'Calificado', color: '#8b5cf6' },
  { key: 'en_conversion', label: 'En conversión', color: '#10b981' },
  { key: 'agendado', label: 'Agendado', color: '#14b8a6' },
  { key: 'agenda_cancelada', label: 'Agenda cancelada', color: '#fb7185' },
  { key: 'descartado', label: 'Descartado', color: '#ef4444' },
];

// Etiquetas que pone el sistema con los webhooks del calendario, nunca la IA.
export const SYSTEM_STAGES = ['agendado', 'agenda_cancelada'];

export const STAGE_KEYS = STAGES.map((s) => s.key);

// Canales con ventana de mensajería de Meta (24 h desde el último mensaje del lead).
// SMS y Live_Chat no tienen ventana.
export const WINDOWED_CHANNELS = ['IG', 'FB', 'WhatsApp'];

export const OAUTH_SCOPES = [
  'conversations/message.readonly',
  'conversations/message.write',
  'conversations.readonly',
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
  'calendars/events.readonly',
];
