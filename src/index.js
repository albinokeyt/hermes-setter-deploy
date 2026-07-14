import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db.js';
import { seedAdmin, authHook } from './lib/session.js';
import { startWorkers } from './workers.js';
import authRoutes from './routes/auth.js';
import providerRoutes from './routes/providers.js';
import accountRoutes from './routes/accounts.js';
import conversationRoutes from './routes/conversations.js';
import dashboardRoutes from './routes/dashboard.js';
import playgroundRoutes from './routes/playground.js';
import settingsRoutes from './routes/settings.js';
import ghlOauthRoutes from './routes/ghlOauth.js';
import webhookRoutes from './routes/webhooks.js';
import userRoutes from './routes/users.js';
import portalRoutes from './routes/portal.js';
import campaignRoutes from './routes/campaigns.js';
import archiveRoutes from './routes/archive.js';
import promptEditorRoutes from './routes/promptEditor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await migrate();
  await seedAdmin();

  // bodyLimit alto: el arquitecto de prompts puede enviar imágenes en base64
  const app = Fastify({ logger: { level: 'info' }, trustProxy: true, bodyLimit: 20 * 1024 * 1024 });

  // guardamos el body crudo para poder verificar la firma de los webhooks
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, payload, done) => {
    req.rawBody = payload;
    try {
      done(null, payload ? JSON.parse(payload) : {});
    } catch {
      done(null, {});
    }
  });

  await app.register(fastifyCookie);
  app.addHook('onRequest', authHook());

  app.get('/api/health', async () => ({ ok: true, app: 'hermes-setter' }));

  await app.register(authRoutes);
  await app.register(providerRoutes);
  await app.register(accountRoutes);
  await app.register(conversationRoutes);
  await app.register(dashboardRoutes);
  await app.register(playgroundRoutes);
  await app.register(settingsRoutes);
  await app.register(ghlOauthRoutes);
  await app.register(webhookRoutes);
  await app.register(userRoutes);
  await app.register(portalRoutes);
  await app.register(campaignRoutes);
  await app.register(archiveRoutes);
  await app.register(promptEditorRoutes);

  // frontend compilado (SPA)
  const webDist = path.join(__dirname, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'no encontrado' });
      return reply.sendFile('index.html');
    });
  }

  startWorkers();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[hermes] escuchando en :${config.port}`);
}

main().catch((err) => {
  console.error('Error fatal al arrancar:', err);
  process.exit(1);
});
