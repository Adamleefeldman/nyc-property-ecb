// GET /properties/:id/ecb-violations — served from Postgres only, never Socrata.

import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getProperty } from '../resolver/properties.js';
import { coverageFor } from './coverage.js';
import { badRequest, notFound } from './errors.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const listQuery = {
  type: 'object',
  properties: {
    open: { type: 'boolean' },
    unpaid: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    cursor: { type: 'string' },
  },
  additionalProperties: false,
} as const;

interface ListQuery {
  open?: boolean;
  unpaid?: boolean;
  limit: number;
  cursor?: string;
}

interface ViolationRow {
  ecb_violation_number: string;
  bin: string | null;
  bbl: string | null;
  status: string | null;
  issue_date: string | null;
  served_date: string | null;
  hearing_date: string | null;
  hearing_status: string | null;
  certification_status: string | null;
  severity: string | null;
  violation_type: string | null;
  violation_description: string | null;
  respondent_name: string | null;
  penalty_imposed: string | null;
  amount_paid: string | null;
  balance_due: string | null;
  dob_violation_number: string | null;
  infraction_code: string | null;
  section_law_description: string | null;
  aggravated_level: string | null;
  absent_since_run_id: string | null;
  updated_at: Date;
}

const money = (v: string | null) => (v === null ? null : Number(v));

/** SQL snake_case → JSON camelCase; NUMERIC text → number. */
function toItem(r: ViolationRow) {
  return {
    ecbViolationNumber: r.ecb_violation_number,
    bin: r.bin,
    bbl: r.bbl,
    status: r.status,
    issueDate: r.issue_date,
    servedDate: r.served_date,
    hearingDate: r.hearing_date,
    hearingStatus: r.hearing_status,
    certificationStatus: r.certification_status,
    severity: r.severity,
    violationType: r.violation_type,
    violationDescription: r.violation_description,
    respondentName: r.respondent_name,
    penaltyImposed: money(r.penalty_imposed),
    amountPaid: money(r.amount_paid),
    balanceDue: money(r.balance_due),
    dobViolationNumber: r.dob_violation_number,
    infractionCode: r.infraction_code,
    sectionLawDescription: r.section_law_description,
    aggravatedLevel: r.aggravated_level,
    /** Set when the city stopped returning this row; we keep and flag it rather than delete. */
    absentSinceRunId: r.absent_since_run_id === null ? null : Number(r.absent_since_run_id),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Today's cursor is the offset as text; step 9 replaces it with a keyset cursor. */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw badRequest('invalid cursor');
  return n;
}

export async function violationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    '/properties/:id/ecb-violations',
    { schema: { params: idParams, querystring: listQuery } },
    async (req) => {
      const property = await getProperty(pool, req.params.id);
      if (!property) throw notFound('property');

      const coverage = await coverageFor(pool, property);
      const offset = parseCursor(req.query.cursor);
      const { limit } = req.query;

      const where = ['bin = ANY($1)'];
      if (req.query.open) where.push(`status = 'ACTIVE'`);
      if (req.query.unpaid) where.push('balance_due > 0');

      const { rows } = await pool.query<ViolationRow>(
        `SELECT * FROM ecb_violations
          WHERE ${where.join(' AND ')}
          ORDER BY issue_date DESC NULLS LAST, ecb_violation_number DESC
          LIMIT $2 OFFSET $3`,
        [property.bins, limit, offset],
      );

      return {
        coverage,
        items: rows.map(toItem),
        nextCursor: rows.length === limit ? String(offset + limit) : null,
      };
    },
  );
}
