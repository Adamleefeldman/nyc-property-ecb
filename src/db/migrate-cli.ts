import { migrate } from './migrate.js';
import { pool } from './pool.js';

const applied = await migrate(pool);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
await pool.end();
