// `npm run resolve:retry` — re-attempt every property that is not settled:
// pending (GeoSearch or Footprints was down) and unresolved (no exact match
// at the time; PAD or our normaliser may have moved on). Same code path as
// POST /properties, so a retry can never produce a different record than a
// fresh request would.

import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { resolverDeps } from '../resolver/index.js';
import { listRetryable } from '../resolver/properties.js';
import { registerByAddress, registerByBbl } from '../resolver/resolve.js';

await migrate(pool);
const candidates = await listRetryable(pool);
const settled = { resolved: 0, not_applicable: 0 };
const still = { pending: 0, unresolved: 0 };
for (const c of candidates) {
  const { property } =
    c.kind === 'bbl' ? await registerByBbl(pool, resolverDeps, c.rawInput) : await registerByAddress(pool, resolverDeps, c.rawInput);
  const s = property.resolution.status;
  if (s === 'resolved' || s === 'not_applicable') settled[s] += 1;
  else still[s] += 1;
  console.log(
    `${c.kind.padEnd(7)} ${c.rawInput.padEnd(44)} ${c.status.padEnd(10)} → ${s}${property.bbl ? ` (${property.bbl})` : ''}`,
  );
}
console.log(
  `resolve:retry: ${candidates.length} tried, ${settled.resolved} resolved, ${settled.not_applicable} not_applicable, ` +
    `${still.pending} still pending, ${still.unresolved} still unresolved`,
);
await pool.end();
