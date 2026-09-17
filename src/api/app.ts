import Fastify from 'fastify';
import { config } from '../config.js';
import { pingDb } from '../db/pool.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async (_req, reply) => {
    try {
      await pingDb();
      return { db: 'ok', ingestInterval: config.ingestInterval };
    } catch (err) {
      reply.code(503);
      return { db: 'error', error: (err as Error).message };
    }
  });

  return app;
}
