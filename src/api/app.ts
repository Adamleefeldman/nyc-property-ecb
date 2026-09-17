import Fastify, { type FastifyError } from 'fastify';
import { config } from '../config.js';
import { pingDb } from '../db/pool.js';
import { InvalidBblError } from '../resolver/bbl.js';
import { HttpError } from './errors.js';
import { propertyRoutes } from './properties.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof InvalidBblError) {
      return reply.code(400).send({ error: { code: 'invalid_bbl', message: err.message } });
    }
    if ('validation' in err && err.validation) {
      return reply.code(400).send({ error: { code: 'validation', message: err.message } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/health', async (_req, reply) => {
    try {
      await pingDb();
      return { db: 'ok', ingestInterval: config.ingestInterval };
    } catch (err) {
      reply.code(503);
      return { db: 'error', error: (err as Error).message };
    }
  });

  app.register(propertyRoutes);

  return app;
}
