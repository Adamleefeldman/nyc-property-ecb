// `npm run seed` — register the sample addresses in seed/addresses.json through
// the same resolver POST /properties uses, so the seed can never drift from real
// behaviour. Idempotent: a second run reports every address as existing.

import { readFile } from 'node:fs/promises';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { resolverDeps } from '../resolver/index.js';
import { registerByAddress } from '../resolver/resolve.js';

interface SeedEntry {
  address: string;
  why: string;
}

const file = new URL('../../seed/addresses.json', import.meta.url);
const entries = JSON.parse(await readFile(file, 'utf8')) as SeedEntry[];

await migrate(pool);
const counts = { created: 0, existing: 0, pending: 0, failed: 0 };
for (const e of entries) {
  try {
    const { property, httpStatus } = await registerByAddress(pool, resolverDeps, e.address);
    const outcome = httpStatus === 201 ? 'created' : httpStatus === 202 ? 'pending' : 'existing';
    counts[outcome] += 1;
    const bins = property.bins.length ? property.bins.join('+') : '-';
    console.log(
      `${outcome.padEnd(8)} ${e.address.padEnd(42)} ${(property.bbl ?? '-').padEnd(10)} ${property.resolution.status.padEnd(14)} bins ${bins}` +
        (property.resolution.reason ? `  (${property.resolution.reason})` : ''),
    );
  } catch (err) {
    counts.failed += 1;
    console.error(`failed   ${e.address.padEnd(42)} ${(err as Error).message}`);
  }
}
console.log(
  `seed: ${entries.length} addresses → ${counts.created} created, ${counts.existing} existing, ${counts.pending} pending, ${counts.failed} failed`,
);
await pool.end();
process.exit(counts.failed ? 1 : 0);
