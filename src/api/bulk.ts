import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { registerBulkByBbl } from '../resolver/bulk.js';
import { socrata } from '../socrata/index.js';

const bulkBody = {
  type: 'object',
  required: ['bbls'],
  properties: {
    bbls: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
} as const;

export async function bulkRoutes(app: FastifyInstance) {
  app.post<{ Body: { bbls: string[] } }>('/properties/bulk', { schema: { body: bulkBody } }, async (req) =>
    registerBulkByBbl(pool, socrata, req.body.bbls, { footprintsBatchSize: config.footprintsBatchSize }),
  );
}
