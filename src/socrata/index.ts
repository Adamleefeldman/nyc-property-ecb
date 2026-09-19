import { config } from '../config.js';
import { createSocrataClient } from './fetch.js';

/** The app-wide client. Tests build their own with a fake fetch. */
export const socrata = createSocrataClient({
  appToken: config.socrataAppToken,
  timeoutMs: config.socrataTimeoutMs,
  attempts: config.maxAttempts,
  minMsBetweenCalls: config.minMsBetweenCalls,
});
