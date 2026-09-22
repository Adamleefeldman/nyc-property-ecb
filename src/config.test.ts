import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, parseInterval } from './config.js';

describe('parseInterval', () => {
  it('reads minutes, hours and days', () => {
    assert.equal(parseInterval('30m'), 1_800_000);
    assert.equal(parseInterval('6h'), 21_600_000);
    assert.equal(parseInterval('1d'), 86_400_000);
    assert.equal(parseInterval(' 24h '), 86_400_000);
  });
  it('rejects other shapes and zero', () => {
    for (const bad of ['', '24', '1w', '2.5h', '0h', 'daily']) assert.throws(() => parseInterval(bad), /INGEST_INTERVAL/, bad);
  });
  it('rejects more than 24 days, where a Node timer would wrap and fire continuously', () => {
    assert.equal(parseInterval('24d'), 24 * 86_400_000);
    assert.throws(() => parseInterval('25d'), /24d or less/);
  });
});

describe('loadConfig', () => {
  it('has a working default for everything and reads overrides', () => {
    const c = loadConfig({});
    assert.equal(c.ingestIntervalMs, 86_400_000);
    assert.equal(loadConfig({ INGEST_INTERVAL: '6h', BATCH_SIZE: '100' }).batchSize, 100);
    assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
  });
});
