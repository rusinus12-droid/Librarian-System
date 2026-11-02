'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pages = require('../tools/libra_memory_graph_pages.cjs')({ fingerprint: s => crypto.createHash('sha256').update(s).digest('hex') });
const resourceFactory = require('../tools/libra_memory_graph_resources.cjs');

const makePool = limits => resourceFactory({
  measure: pages.measure,
  encodedSize: pages.encodedSize,
  stageCost: pages.stageCost,
  limits
});

test('parallel source batching preserves sequential determinism and exact accounting', async () => {
  const pool = makePool();
  const resources = pool.open();
  const pinKeys = Array.from({ length: 12 }, (_, i) => `key_${i}`);
  const store = new Map(pinKeys.map((k, i) => [k, `source_content_${i}`]));

  const sourceReadBatchSize = () => {
    const access = resources.inspect();
    return Math.max(1, Math.min(4,
      Math.floor((access.pool.limits.ioBytes - access.pool.ioBytes) / access.limits.maxValueBytes),
      Math.floor((access.limits.maxSourceBytes - access.sourceBytes) / access.limits.maxValueBytes),
      access.pool.limits.reads - access.pool.reads));
  };

  const readRawSource = async key => {
    return await resources.read(async () => store.get(key));
  };

  // Execute dynamic batching identical to LIBRA.js lines 77304-77315
  const pinnedValues = [];
  let offset = 0;
  while (offset < pinKeys.length) {
    const batchSize = Math.max(1, sourceReadBatchSize());
    const chunk = pinKeys.slice(offset, offset + batchSize);
    offset += chunk.length;
    const chunkResults = await Promise.all(chunk.map(async storageKey => {
      const raw = await readRawSource(storageKey);
      return { key: storageKey, raw };
    }));
    for (const item of chunkResults) {
      resources.retain(item.raw, 'pinned_source_body');
      pinnedValues.push(item);
    }
  }

  // 1. Order determinism: every item is in exact original pinKeys order
  assert.equal(pinnedValues.length, pinKeys.length);
  for (let i = 0; i < pinKeys.length; i++) {
    assert.equal(pinnedValues[i].key, pinKeys[i]);
    assert.equal(pinnedValues[i].raw, store.get(pinKeys[i]));
  }

  // 2. Resource accounting verification
  const inspected = resources.inspect();
  assert.equal(inspected.reads, pinKeys.length);
  assert.equal(inspected.pool.reads, 0, 'all I/O leases released');
  assert.equal(inspected.pool.ioBytes, 0, 'all I/O reservations restored');
  resources.close();
});

test('parallel source batching cleans up all leases on mid-batch failure', async () => {
  const pool = makePool();
  const resources = pool.open();
  const pinKeys = ['key_0', 'key_1', 'key_fail', 'key_3'];

  const sourceReadBatchSize = () => 4;
  const readRawSource = async key => {
    return await resources.read(async () => {
      if (key === 'key_fail') throw new Error('simulated_io_failure');
      return `content_${key}`;
    });
  };

  let caught = null;
  try {
    const chunk = pinKeys;
    await Promise.all(chunk.map(async storageKey => {
      const raw = await readRawSource(storageKey);
      return { key: storageKey, raw };
    }));
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.match(caught.message, /simulated_io_failure/);

  // Verification: pool I/O reads and bytes are 0 (no leaked leases despite failure in Promise.all)
  const poolState = pool.inspect();
  assert.equal(poolState.reads, 0);
  assert.equal(poolState.ioBytes, 0);
  resources.close();
});
