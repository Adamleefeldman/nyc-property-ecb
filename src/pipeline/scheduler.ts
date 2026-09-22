// Runs the ingestion pipeline every INGEST_INTERVAL. Dumb on purpose: it
// calls runIngestion and reports what happened. The lock inside runIngestion
// is what stops it colliding with the API or the CLI, and the resume logic
// inside runIngestion is what makes a crashed run finish on the next tick.

import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { socrata } from '../socrata/index.js';
import { formatSummary, RunInProgressError, runIngestion } from './ingest.js';
import { findUnfinishedRun, lastSuccessfulRunAt } from './store.js';

const log = (msg: string) => console.log(`scheduler ${new Date().toISOString()} ${msg}`);

async function tick(reason: string): Promise<void> {
  try {
    const summary = await runIngestion(pool, socrata, {
      trigger: 'scheduler',
      pageSize: config.ecbPageSize,
      maxPages: config.maxPagesPerBatch,
      batchSize: config.batchSize,
    });
    log(`${reason}: ${formatSummary(summary)}`);
  } catch (err) {
    // A failed tick must not take the scheduler down; the next tick still fires.
    if (err instanceof RunInProgressError) log(`${reason}: skipped, a run is already in progress`);
    else log(`${reason}: failed: ${(err as Error).message}`);
  }
}

await migrate(pool);
log(`interval ${config.ingestInterval} (${config.ingestIntervalMs} ms)`);

// Catch up on boot. A run left unfinished by a crash should not wait a whole
// interval, and neither should data older than the interval: the clock is the
// last successful run in the database, not this process's start time, so a
// restart never skips a run.
const last = await lastSuccessfulRunAt(pool);
const overdue = last === null || Date.now() - last.getTime() >= config.ingestIntervalMs;
const anyProperties = (await pool.query<{ any: boolean }>('SELECT EXISTS (SELECT 1 FROM properties) AS any')).rows[0]!.any;
if (await findUnfinishedRun(pool)) await tick('resume on boot');
else if (last === null && !anyProperties) log('nothing tracked yet; first run at the next tick or on demand');
else if (overdue) await tick(last ? `last run ${last.toISOString()} is older than the interval` : 'no run yet');
else log(`last run ${last!.toISOString()}; next in ${Math.round((config.ingestIntervalMs - (Date.now() - last!.getTime())) / 60_000)} min`);

const timer = setInterval(() => void tick('tick'), config.ingestIntervalMs);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  });
}
