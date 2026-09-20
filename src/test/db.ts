// Integration-test databases: `app_test_<suite>` on the same server as
// DATABASE_URL, one per test file (the runner executes files in parallel),
// created on first use, migrated with our own runner, truncated between
// tests. Never touches the `app` database. If no server is reachable the
// suite skips itself, so `npm test` still passes on a laptop without Docker.
//
// Import this module FIRST in a test file: it points DATABASE_URL at the
// test database before config.ts reads it. The suite name comes from the
// test file's name (api.integration.test.ts → app_test_api).

import path from 'node:path';
import pg from 'pg';

const base = new URL(process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app');
const suite = path.basename(process.argv[1] ?? 'suite').split('.')[0]!.replace(/[^a-z0-9]/gi, '_').toLowerCase();
export const TEST_DB_NAME = `app_test_${suite}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${TEST_DB_NAME}`;
process.env.DATABASE_URL = testUrl.toString();

const adminUrl = new URL(base.toString());
adminUrl.pathname = '/postgres';

async function ensureDatabase(): Promise<boolean> {
  const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 1500 });
  try {
    await admin.connect();
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    return true;
  } catch {
    return false;
  } finally {
    await admin.end().catch(() => {});
  }
}

export interface TestDb {
  pool: pg.Pool;
  /** Empty every application table (migrations bookkeeping stays). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Null when Postgres is not reachable: callers skip their suite. */
export async function getTestDb(): Promise<TestDb | null> {
  if (!(await ensureDatabase())) return null;
  const { pool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  await migrate(pool);
  return {
    pool,
    reset: async () => {
      await pool.query(
        `TRUNCATE ecb_violations, ecb_violations_raw, ingestion_batches, property_coverage, ingestion_runs,
                  property_bins, property_inputs, properties RESTART IDENTITY CASCADE`,
      );
    },
    close: () => pool.end(),
  };
}

export const SKIP_REASON = 'no Postgres reachable (run inside docker compose, or start the stack)';
