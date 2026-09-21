// `npm run seed:pluto -- [cd] [count] [out]` — write the first N lots of a
// community district from PLUTO (64uk-42ks) as a CSV for `npm run import`.
// Default: cd 301 (Brooklyn CD 1, Williamsburg/Greenpoint, 14,868 lots),
// 10,000 lots, seed/scale-10k.csv. This is how the committed file was made.

import { writeFile } from 'node:fs/promises';
import { normalizeBbl } from '../resolver/bbl.js';
import { socrata } from '../socrata/index.js';

const cd = process.argv[2] ?? '301';
const count = Number(process.argv[3] ?? 10000);
const out = process.argv[4] ?? new URL('../../seed/scale-10k.csv', import.meta.url).pathname;
const PAGE = 5000;

const bbls: string[] = [];
for (let offset = 0; bbls.length < count; offset += PAGE) {
  const rows = await socrata.get<{ bbl: string }>('64uk-42ks', {
    $select: 'bbl',
    $where: `cd='${cd}'`,
    $order: 'bbl',
    $limit: String(Math.min(PAGE, count - bbls.length)),
    $offset: String(offset),
  });
  if (rows.length === 0) break;
  for (const r of rows) bbls.push(normalizeBbl(r.bbl).bbl);
}

const header = `# PLUTO 64uk-42ks, cd='${cd}', first ${bbls.length} lots ordered by bbl, pulled ${new Date().toISOString().slice(0, 10)}\nbbl\n`;
await writeFile(out, header + bbls.join('\n') + '\n');
console.log(`pull-pluto: cd ${cd} → ${bbls.length} BBLs in ${socrata.stats().calls} Socrata calls → ${out}`);
