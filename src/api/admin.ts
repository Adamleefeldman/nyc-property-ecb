// Operational endpoints: run the pipeline now, and read the run log.
// No authentication: out of scope for the assignment, noted in the README.

import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { RunInProgressError, runIngestion } from '../pipeline/ingest.js';
import { listRuns } from '../pipeline/store.js';
import { socrata } from '../socrata/index.js';
import { HttpError } from './errors.js';

const listQuery = {
  type: 'object',
  properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } },
  additionalProperties: false,
} as const;

export async function adminRoutes(app: FastifyInstance) {
  app.post('/admin/ingest/run', async () => {
    try {
      return await runIngestion(pool, socrata, {
        trigger: 'api',
        pageSize: config.ecbPageSize,
        maxPages: config.maxPagesPerBatch,
        batchSize: config.batchSize,
      });
    } catch (err) {
      if (err instanceof RunInProgressError) throw new HttpError(409, 'run_in_progress', err.message);
      throw err;
    }
  });

  app.get<{ Querystring: { limit: number } }>('/admin/ingest/runs', { schema: { querystring: listQuery } }, async (req) => {
    const runs = await listRuns(pool, req.query.limit);
    return {
      items: runs.map((r) => ({
        runId: r.id,
        status: r.status,
        trigger: r.trigger,
        startedAt: r.started_at.toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
        sourceUpdatedAt: r.source_rows_updated_at?.toISOString() ?? null,
        socrataCalls: r.socrata_calls,
        batchesTotal: r.batches_total,
        batchesFailed: r.batches_failed,
        rowsFetched: r.rows_fetched,
        rowsStored: r.rows_stored,
        rowsNew: r.rows_new,
        rowsChanged: r.rows_changed,
        propertiesChecked: r.properties_checked,
        error: r.error,
      })),
    };
  });
}
