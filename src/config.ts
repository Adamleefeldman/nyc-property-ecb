// All runtime settings come from the environment. Every value has a default so
// `docker compose up` works on a clean machine; invalid values fail at startup.

const INTERVAL_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Node timers cannot count past 2^31-1 ms (~24.8 days); above that setInterval silently fires every millisecond. */
const MAX_INTERVAL_MS = 24 * 86_400_000;

/** Parse "30m" | "6h" | "24h" | "1d" into milliseconds. Throws on anything else, or on more than 24d. */
export function parseInterval(raw: string): number {
  const match = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!match) {
    throw new Error(`INGEST_INTERVAL must look like 30m, 6h or 1d (got "${raw}")`);
  }
  const amount = Number(match[1]);
  const unit = INTERVAL_UNITS[match[2]!]!;
  if (amount <= 0) throw new Error(`INGEST_INTERVAL must be positive (got "${raw}")`);
  const ms = amount * unit;
  if (ms > MAX_INTERVAL_MS) throw new Error(`INGEST_INTERVAL must be 24d or less (got "${raw}")`);
  return ms;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return n;
}

export interface Config {
  databaseUrl: string;
  port: number;
  socrataAppToken: string | undefined;
  socrataTimeoutMs: number;
  geosearchTimeoutMs: number;
  geosearchAttempts: number;
  ecbPageSize: number;
  maxPagesPerBatch: number;
  batchSize: number;
  footprintsBatchSize: number;
  maxAttempts: number;
  minMsBetweenCalls: number;
  /** Test knobs, off by default: exit after batch n / make batch n fail. */
  ingestKillAfterBatch: number | undefined;
  ingestFailBatch: number | undefined;
  ingestInterval: string;
  ingestIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ingestInterval = env.INGEST_INTERVAL ?? '24h';
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://app:app@localhost:5433/app', // 5433: the port docker compose publishes
    port: parsePort(env.PORT ?? '3000'),
    socrataAppToken: env.SOCRATA_APP_TOKEN || undefined,
    socrataTimeoutMs: parsePositiveInt('SOCRATA_TIMEOUT_MS', env.SOCRATA_TIMEOUT_MS ?? '15000'),
    geosearchTimeoutMs: parsePositiveInt('GEOSEARCH_TIMEOUT_MS', env.GEOSEARCH_TIMEOUT_MS ?? '10000'),
    geosearchAttempts: parsePositiveInt('GEOSEARCH_ATTEMPTS', env.GEOSEARCH_ATTEMPTS ?? '2'),
    ecbPageSize: parsePositiveInt('ECB_PAGE_SIZE', env.ECB_PAGE_SIZE ?? '5000'),
    maxPagesPerBatch: parsePositiveInt('MAX_PAGES_PER_BATCH', env.MAX_PAGES_PER_BATCH ?? '50'),
    batchSize: parsePositiveInt('BATCH_SIZE', env.BATCH_SIZE ?? '600'),
    footprintsBatchSize: parsePositiveInt('FOOTPRINTS_BATCH_SIZE', env.FOOTPRINTS_BATCH_SIZE ?? '300'),
    maxAttempts: parsePositiveInt('MAX_ATTEMPTS', env.MAX_ATTEMPTS ?? '4'),
    minMsBetweenCalls: parseNonNegativeInt('MIN_MS_BETWEEN_CALLS', env.MIN_MS_BETWEEN_CALLS ?? '250'),
    ingestKillAfterBatch: env.INGEST_KILL_AFTER_BATCH ? parsePositiveInt('INGEST_KILL_AFTER_BATCH', env.INGEST_KILL_AFTER_BATCH) : undefined,
    ingestFailBatch: env.INGEST_FAIL_BATCH ? parsePositiveInt('INGEST_FAIL_BATCH', env.INGEST_FAIL_BATCH) : undefined,
    ingestInterval,
    ingestIntervalMs: parseInterval(ingestInterval),
  };
}

export const config: Config = loadConfig();
