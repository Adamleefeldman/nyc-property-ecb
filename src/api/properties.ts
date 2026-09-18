import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { resolverDeps } from '../resolver/index.js';
import { getProperty } from '../resolver/properties.js';
import { registerByAddress, registerByBbl } from '../resolver/resolve.js';
import { badRequest, notFound } from './errors.js';

const createBody = {
  type: 'object',
  properties: {
    bbl: { type: 'string', minLength: 1 },
    address: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export async function propertyRoutes(app: FastifyInstance) {
  app.post<{ Body: { bbl?: string; address?: string } }>('/properties', { schema: { body: createBody } }, async (req, reply) => {
    const { bbl, address } = req.body;
    if ((bbl === undefined) === (address === undefined)) throw badRequest('send exactly one of "bbl" or "address"');
    const { property, httpStatus } =
      bbl !== undefined ? await registerByBbl(pool, resolverDeps, bbl) : await registerByAddress(pool, resolverDeps, address!);
    reply.code(httpStatus);
    return property;
  });

  app.get<{ Params: { id: string } }>('/properties/:id', { schema: { params: idParams } }, async (req) => {
    const property = await getProperty(pool, req.params.id);
    if (!property) throw notFound('property');
    return property;
  });
}
