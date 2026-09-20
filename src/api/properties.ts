import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { resolverDeps } from '../resolver/index.js';
import { getProperty } from '../resolver/properties.js';
import { registerByAddress, registerByBbl } from '../resolver/resolve.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { badRequest, notFound } from './errors.js';

const createBody = {
  type: 'object',
  properties: {
    bbl: { type: 'string', minLength: 1 },
    address: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const listQuery = {
  type: 'object',
  properties: {
    unpaid: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    cursor: { type: 'string' },
  },
  additionalProperties: false,
} as const;

interface PropertyListRow {
  id: string;
  bbl: string | null;
  normalized_address: string | null;
  resolution_status: string;
  bin_count: number;
  unpaid_count: number;
  unpaid_total: string;
  active_count: number;
}

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

  // The tracked properties, by BBL, with their unpaid position. ?unpaid=true keeps those owing money.
  app.get<{ Querystring: { unpaid?: boolean; limit: number; cursor?: string } }>(
    '/properties',
    { schema: { querystring: listQuery } },
    async (req) => {
      const params: unknown[] = [req.query.limit];
      const where: string[] = [];
      if (req.query.unpaid) where.push('u.unpaid_count > 0');
      if (req.query.cursor) {
        // Keyset on (bbl NULLS LAST, id): lot-less pending / unresolved rows come last.
        const { b, i } = decodeCursor(req.query.cursor, ['b', 'i'] as const);
        if (i === null) throw badRequest('invalid cursor');
        if (b === null) {
          params.push(i);
          where.push(`p.bbl IS NULL AND p.id > $${params.length}`);
        } else {
          params.push(b, i);
          where.push(`(p.bbl > $${params.length - 1} OR (p.bbl = $${params.length - 1} AND p.id > $${params.length}) OR p.bbl IS NULL)`);
        }
      }
      const { rows } = await pool.query<PropertyListRow>(
        `SELECT p.id, p.bbl, p.normalized_address, p.resolution_status,
                (SELECT count(*) FROM property_bins b WHERE b.property_id = p.id AND NOT b.is_placeholder)::int AS bin_count,
                u.unpaid_count, u.unpaid_total, u.active_count
           FROM properties p
           CROSS JOIN LATERAL (
             SELECT count(*) FILTER (WHERE v.balance_due > 0)::int AS unpaid_count,
                    COALESCE(sum(v.balance_due) FILTER (WHERE v.balance_due > 0), 0) AS unpaid_total,
                    count(*) FILTER (WHERE v.status = 'ACTIVE')::int AS active_count
               FROM property_bins b JOIN ecb_violations v ON v.bin = b.bin
              WHERE b.property_id = p.id AND NOT b.is_placeholder
           ) u
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY p.bbl NULLS LAST, p.id LIMIT $1`,
        params,
      );
      const last = rows[rows.length - 1];
      return {
        items: rows.map((r) => ({
          id: r.id,
          bbl: r.bbl,
          normalizedAddress: r.normalized_address,
          resolutionStatus: r.resolution_status,
          bins: r.bin_count,
          activeCount: r.active_count,
          unpaidCount: r.unpaid_count,
          unpaidTotal: Number(r.unpaid_total),
        })),
        nextCursor: rows.length === req.query.limit && last ? encodeCursor({ b: last.bbl, i: last.id }) : null,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/properties/:id', { schema: { params: idParams } }, async (req) => {
    const property = await getProperty(pool, req.params.id);
    if (!property) throw notFound('property');
    return property;
  });
}
