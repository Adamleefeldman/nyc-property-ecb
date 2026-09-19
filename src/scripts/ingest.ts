// `npm run ingest` — run the ECB pipeline once (or resume the unfinished run).

import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { formatSummary, RunInProgressError, runIngestion } from '../pipeline/ingest.js';
import { socrata } from '../socrata/index.js';

await migrate(pool);
try {
  const summary = await runIngestion(pool, socrata, {
    trigger: 'cli',
    pageSize: config.ecbPageSize,
    maxPages: config.maxPagesPerBatch,
    batchSize: config.batchSize,
    failBatch: config.ingestFailBatch,
    afterBatch:
      config.ingestKillAfterBatch === undefined
        ? undefined
        : (n) => {
            if (n === config.ingestKillAfterBatch) {
              console.error(`INGEST_KILL_AFTER_BATCH=${n}: exiting mid-run (test knob)`);
              process.exit(137);
            }
          },
  });
  console.log(formatSummary(summary));
  await pool.end();
  process.exit(summary.status === 'failed' ? 1 : 0);
} catch (err) {
  if (err instanceof RunInProgressError) {
    console.error('ingest: a run is already in progress; not starting another');
    await pool.end();
    process.exit(2);
  }
  throw err;
}
