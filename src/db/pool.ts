import pg from 'pg';
import { config } from '../config.js';

// DATE columns come back as the plain 'YYYY-MM-DD' string, not a JS Date
// shifted into the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// An idle connection that drops (Postgres restart, network blip) is reported
// here. Without a listener Node treats it as an uncaught error and exits the
// process, which for the scheduler means no run ever fires again. The pool has
// already discarded the broken client; the next query gets a fresh one.
pool.on('error', (err) => console.error(`postgres: idle connection error: ${err.message}`));

/** Cheap round trip used by /health and by the migration runner's readiness wait. */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}
