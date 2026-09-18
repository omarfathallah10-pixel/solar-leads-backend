import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env } from './config/env';
import { logger } from './lib/logger';
import { disconnectPrisma, prisma } from './lib/prisma';
import { installBigIntSerializer } from './lib/serialization';
import { closeQueues } from './queues';
import { analyticsRoutes } from './routes/analytics';
import { complianceRoutes } from './routes/compliance';
import { discoveryRoutes } from './routes/discovery';
import { leadRoutes } from './routes/leads';
import { templateRoutes } from './routes/templates';
import { sesWebhooks } from './webhooks/ses';

export async function buildServer() {
  // Must run before any route can serialise a BigInt id.
  installBigIntSerializer();

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  // Surface the real cause instead of a bare "Internal Server Error". In
  // development the message goes to the client too — chasing a 500 through a
  // terminal in another window is exactly how a whole afternoon disappears.
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      logger.error({ err, url: req.url, method: req.method }, 'request failed');
    }
    return reply.code(status).send({
      error: status >= 500 ? 'Internal Server Error' : err.name,
      message:
        env.NODE_ENV === 'production' && status >= 500
          ? 'Something went wrong. Check the server logs.'
          : err.message,
      code: (err as { code?: string }).code,
    });
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, version: process.env.npm_package_version ?? '0.1.0' };
  });

  // Public, unauthenticated by design: unsubscribe links and provider webhooks
  // must work without a session. Both are protected by signatures instead.
  await app.register(complianceRoutes);
  await app.register(sesWebhooks);

  // TODO: replace with real session/SSO auth before exposing beyond localhost.
  // Left explicit rather than hidden so it cannot ship unnoticed.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/u/') || req.url.startsWith('/webhooks/') || req.url === '/health') {
      return;
    }
    const userId = req.headers['x-user-id'];
    if (typeof userId !== 'string') {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    (req as { userId?: string }).userId = userId;
  });

  await app.register(leadRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(discoveryRoutes, { prefix: '/api' });
  await app.register(templateRoutes, { prefix: '/api' });

  return app;
}

if (require.main === module) {
  void (async () => {
    const app = await buildServer();
    await app.listen({ port: env.PORT, host: env.HOST });

    // Log the URLs that actually work, not just the port. Saves guessing which
    // of localhost / 127.0.0.1 / ::1 the current machine resolves to.
    logger.info(
      { host: env.HOST, port: env.PORT },
      `API listening — http://127.0.0.1:${env.PORT}/health`,
    );

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'shutting down API');
      await app.close();
      await closeQueues();
      await disconnectPrisma();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  })();
}
