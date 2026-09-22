// `npm run import -- file.csv` — register BBLs from a file. The file is a CSV
// with a `bbl` column (other columns ignored), or one BBL per line. Goes
// through the same bulk path as POST /properties/bulk, in chunks of 1,000.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { chunk, registerBulkByBbl } from '../resolver/bulk.js';
import { socrata } from '../socrata/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run import -- <file.csv>');
  process.exit(2);
}

function parseBblFile(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) return [];
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const col = header.indexOf('bbl');
  if (col >= 0) return lines.slice(1).map((l) => l.split(',')[col]?.trim() ?? '').filter(Boolean);
  return lines.map((l) => l.split(',')[0]!.trim()).filter(Boolean); // no header: first column
}

await migrate(pool);
const bbls = parseBblFile(await readFile(file, 'utf8'));
const totals = { received: 0, created: 0, existing: 0, failed: 0, resolved: 0, not_applicable: 0, unresolved: 0, pending: 0, plutoCalls: 0, footprintsCalls: 0 };
const started = Date.now();
for (const part of chunk(bbls, 1000)) {
  const r = await registerBulkByBbl(pool, socrata, part, { footprintsBatchSize: config.footprintsBatchSize });
  totals.received += r.received;
  totals.created += r.created;
  totals.existing += r.existing;
  totals.failed += r.failed;
  totals.plutoCalls += r.plutoCalls;
  totals.footprintsCalls += r.footprintsCalls;
  for (const k of ['resolved', 'not_applicable', 'unresolved', 'pending'] as const) totals[k] += r.byStatus[k];
  for (const f of r.failures) console.error(`  line ${f.index + 1}: ${f.error}`);
  console.log(`  chunk: ${r.received} received, ${r.created} created, ${r.existing} existing, ${r.failed} failed, ${r.plutoCalls} PLUTO + ${r.footprintsCalls} Footprints calls`);
}
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `import ${file}: ${totals.received} BBLs in ${secs}s → ${totals.created} created, ${totals.existing} existing, ${totals.failed} invalid; ` +
    `${totals.resolved} resolved, ${totals.not_applicable} not_applicable, ${totals.unresolved} unresolved, ${totals.pending} pending; ` +
    `${totals.plutoCalls} PLUTO + ${totals.footprintsCalls} Footprints calls`,
);
await pool.end();
