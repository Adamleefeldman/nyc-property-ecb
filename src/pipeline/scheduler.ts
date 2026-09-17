// Runs the ingestion pipeline every INGEST_INTERVAL. Until the pipeline exists
// (step 8 wires it in) each tick only logs, so the process shape is in place.

import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';

await migrate(pool);
console.log(`scheduler: interval ${config.ingestInterval} (${config.ingestIntervalMs} ms)`);

const timer = setInterval(() => {
  console.log(`scheduler: tick at ${new Date().toISOString()} (pipeline not wired yet)`);
}, config.ingestIntervalMs);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  });
}
