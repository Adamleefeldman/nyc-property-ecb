// `npm run renormalize` — rebuild ecb_violations from ecb_violations_raw.
// No network. Use after changing the normalizer.

import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { normalizeViolation, type NormalizedViolation, type RawViolation } from '../pipeline/normalize.js';
import { upsertNormalized } from '../pipeline/store.js';

const CHUNK = 5000;

await migrate(pool);
let after = '';
let total = 0;
let changed = 0;
for (;;) {
  const { rows } = await pool.query<{ ecb_violation_number: string; payload: RawViolation }>(
    `SELECT ecb_violation_number, payload FROM ecb_violations_raw
      WHERE ecb_violation_number > $1 ORDER BY ecb_violation_number LIMIT $2`,
    [after, CHUNK],
  );
  if (rows.length === 0) break;
  const normalized = rows
    .map((r) => normalizeViolation(r.payload))
    .filter((r): r is NormalizedViolation => r !== null);
  const counts = await upsertNormalized(pool, normalized, null);
  total += counts.stored;
  changed += counts.changed;
  after = rows[rows.length - 1]!.ecb_violation_number;
}
console.log(`renormalized ${total} rows, ${changed} changed`);
await pool.end();
