// Ordered SQL files in ./migrations, applied once each, recorded in `migrations`.
// Safe to run on every boot: already-applied files are skipped, and an advisory
// lock stops two processes (api and scheduler) from racing on the same file.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 7_364_001; // arbitrary, just has to be the same in every process

export async function listMigrationFiles(): Promise<string[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql'));
  return names.sort();
}

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM migrations')).rows.map((r) => r.name),
    );
    for (const name of await listMigrationFiles()) {
      if (done.has(name)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`);
      }
      applied.push(name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    client.release();
  }
  return applied;
}
