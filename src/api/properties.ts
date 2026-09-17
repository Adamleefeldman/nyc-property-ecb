import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getProperty, upsertPropertyByBbl } from '../resolver/properties.js';
import { notFound } from './errors.js';

const createBody = {
  type: 'object',
  required: ['bbl'],
  properties: { bbl: { type: 'string', minLength: 1 } },
  additionalProperties: false,
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export async function propertyRoutes(app: FastifyInstance) {
  app.post<{ Body: { bbl: string } }>('/properties', { schema: { body: createBody } }, async (req, reply) => {
    const { property, created } = await upsertPropertyByBbl(pool, req.body.bbl);
    reply.code(created ? 201 : 200);
    return property;
  });

  app.get<{ Params: { id: string } }>('/properties/:id', { schema: { params: idParams } }, async (req) => {
    const property = await getProperty(pool, req.params.id);
    if (!property) throw notFound('property');
    return property;
  });
}
