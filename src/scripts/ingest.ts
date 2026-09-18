// `npm run ingest` — run the ECB pipeline once for every tracked property.

import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { formatSummary, runIngestion } from '../pipeline/ingest.js';
import { socrata } from '../socrata/index.js';

await migrate(pool);
const summary = await runIngestion(pool, socrata, {
  trigger: 'cli',
  pageSize: config.ecbPageSize,
  maxPages: config.maxPagesPerBatch,
});
console.log(formatSummary(summary));
await pool.end();
process.exit(summary.status === 'failed' ? 1 : 0);
