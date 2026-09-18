import pg from 'pg';
import { config } from '../config.js';

// DATE columns come back as the plain 'YYYY-MM-DD' string, not a JS Date
// shifted into the server's timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** Cheap round trip used by /health and by the migration runner's readiness wait. */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}
