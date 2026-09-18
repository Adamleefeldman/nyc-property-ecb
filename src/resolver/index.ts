import { config } from '../config.js';
import { socrata } from '../socrata/index.js';
import { createGeoSearchClient } from './geosearch.js';
import type { ResolverDeps } from './resolve.js';

/** App-wide resolver dependencies. Tests build their own with fake fetches. */
export const geosearch = createGeoSearchClient({
  timeoutMs: config.geosearchTimeoutMs,
  attempts: config.geosearchAttempts,
});

export const resolverDeps: ResolverDeps = { socrata, geosearch };
