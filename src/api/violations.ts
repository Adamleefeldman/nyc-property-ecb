// Violation reads. Served from Postgres only, never Socrata.
//
//   GET /properties/:id/ecb-violations   one property, newest issue first
//   GET /ecb-violations?updatedSince=    every property, most recently changed first
//
// Both page with a keyset cursor on their sort key, so pages stay stable
// while the pipeline inserts rows.

import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getProperty } from '../resolver/properties.js';
import { coverageFor } from './coverage.js';
import { cursorDate, cursorText, cursorTimestamp, decodeCursor, encodeCursor } from './cursor.js';
import { badRequest, notFound } from './errors.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const filterProps = {
  open: { type: 'boolean' },
  unpaid: { type: 'boolean' },
  cursor: { type: 'string' },
} as const;

const perPropertyQuery = {
  type: 'object',
  properties: { ...filterProps, limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
  additionalProperties: false,
} as const;

const crossPropertyQuery = {
  type: 'object',
  properties: {
    ...filterProps,
    updatedSince: { type: 'string', format: 'date-time' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
  },
  additionalProperties: false,
} as const;

interface Filters {
  open?: boolean;
  unpaid?: boolean;
  cursor?: string;
  limit: number;
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
  /** updated_at as Postgres text (microsecond precision) for the cursor; a JS Date would truncate to ms. */
  updated_at_text?: string;
  property_ids?: string[] | null;
}

const money = (v: string | null) => (v === null ? null : Number(v));

/** SQL snake_case → JSON camelCase; NUMERIC text → number. */
function toItem(r: ViolationRow) {
  return {
    // (updated_at_text is cursor plumbing, not part of the item)
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
    /** Our clock: when we stored the row or its served values last changed. Not the city's timestamp. */
    updatedAt: r.updated_at.toISOString(),
    ...(r.property_ids !== undefined ? { propertyIds: r.property_ids ?? [] } : {}),
  };
}

/** The open / unpaid filters, as SQL. `unpaid` is strictly positive: negative balances are credits. */
function filterSql(q: Filters): string[] {
  const where: string[] = [];
  if (q.open) where.push(`status = 'ACTIVE'`);
  if (q.unpaid) where.push('balance_due > 0');
  return where;
}

export async function violationRoutes(app: FastifyInstance) {
  // ---- one property: newest issue_date first, violation number as tiebreaker ----
  app.get<{ Params: { id: string }; Querystring: Filters }>(
    '/properties/:id/ecb-violations',
    { schema: { params: idParams, querystring: perPropertyQuery } },
    async (req) => {
      const property = await getProperty(pool, req.params.id);
      if (!property) throw notFound('property');
      const coverage = await coverageFor(pool, property);

      const params: unknown[] = [property.bins, req.query.limit];
      const where = ['bin = ANY($1)', ...filterSql(req.query)];
      if (req.query.cursor) {
        // Rows after the cursor row in (issue_date DESC NULLS LAST, number DESC) order.
        const { d, n } = decodeCursor(req.query.cursor, { d: cursorDate, n: cursorText });
        if (n === null) throw badRequest('invalid cursor');
        if (d === null) {
          params.push(n);
          where.push(`issue_date IS NULL AND ecb_violation_number < $${params.length}`);
        } else {
          params.push(d, n);
          where.push(
            `(issue_date < $${params.length - 1} OR (issue_date = $${params.length - 1} AND ecb_violation_number < $${params.length}) OR issue_date IS NULL)`,
          );
        }
      }
      const { rows } = await pool.query<ViolationRow>(
        `SELECT * FROM ecb_violations WHERE ${where.join(' AND ')}
          ORDER BY issue_date DESC NULLS LAST, ecb_violation_number DESC LIMIT $2`,
        params,
      );
      const last = rows[rows.length - 1];
      return {
        coverage,
        items: rows.map(toItem),
        nextCursor: rows.length === req.query.limit && last ? encodeCursor({ d: last.issue_date, n: last.ecb_violation_number }) : null,
      };
    },
  );

  // ---- every property: rows stored or changed since a time, most recent change first ----
  app.get<{ Querystring: Filters & { updatedSince?: string } }>(
    '/ecb-violations',
    { schema: { querystring: crossPropertyQuery } },
    async (req) => {
      const params: unknown[] = [req.query.limit];
      const where = [...filterSql(req.query)];
      if (req.query.updatedSince) {
        params.push(req.query.updatedSince);
        where.push(`updated_at >= $${params.length}`);
      }
      if (req.query.cursor) {
        const { t, n } = decodeCursor(req.query.cursor, { t: cursorTimestamp, n: cursorText });
        if (t === null || n === null) throw badRequest('invalid cursor');
        params.push(t, n);
        where.push(`(updated_at, ecb_violation_number) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      const { rows } = await pool.query<ViolationRow>(
        `SELECT v.*, v.updated_at::text AS updated_at_text,
                (SELECT array_agg(DISTINCT b.property_id) FROM property_bins b WHERE b.bin = v.bin) AS property_ids
           FROM ecb_violations v ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY updated_at DESC, ecb_violation_number DESC LIMIT $1`,
        params,
      );
      const last = rows[rows.length - 1];
      return {
        items: rows.map(toItem),
        nextCursor:
          rows.length === req.query.limit && last ? encodeCursor({ t: last.updated_at_text!, n: last.ecb_violation_number }) : null,
      };
    },
  );
}
