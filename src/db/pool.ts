import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** Cheap round trip used by /health and by the migration runner's readiness wait. */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}
