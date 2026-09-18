// `npm run resolve:pending` — retry every property whose lookup failed
// (GeoSearch or Footprints down). Same code path as POST /properties.

import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { resolverDeps } from '../resolver/index.js';
import { listPending } from '../resolver/properties.js';
import { registerByAddress, registerByBbl } from '../resolver/resolve.js';

await migrate(pool);
const pending = await listPending(pool);
let resolved = 0;
let stillPending = 0;
for (const p of pending) {
  const { property } =
    p.kind === 'bbl' ? await registerByBbl(pool, resolverDeps, p.rawInput) : await registerByAddress(pool, resolverDeps, p.rawInput);
  if (property.resolution.status === 'pending') stillPending += 1;
  else resolved += 1;
  console.log(`${p.kind.padEnd(7)} ${p.rawInput.padEnd(40)} → ${property.resolution.status}${property.bbl ? ` (${property.bbl})` : ''}`);
}
console.log(`resolve:pending: ${pending.length} pending, ${resolved} settled, ${stillPending} still pending`);
await pool.end();
