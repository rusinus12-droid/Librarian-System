'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

test('stale replay errors older than state-replay-cache are suppressed in overview/meta and resolved on replay', async t => {
  const seam = '    const rebuildUnifiedStateForWorldline = ';
  const f = await fixture({
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(seam, '    globalThis.__rebuildUnifiedStateForWorldline = (...args) => rebuildUnifiedStateForWorldline(...args);\n' + seam);
    }
  });
  t.after(() => f.r.cleanup());

  await f.run();

  const context = await f.r.core.resolveContext(true);
  const scopeKey = context.scope.scopeKey;
  const cacheKey = `libra:v1:scope:${scopeKey}:state-replay-cache:v1`;
  const errKey = `libra:v1:scope:${scopeKey}:state-replay-errors:v1`;
  const manifest = JSON.parse(f.r.values.get(`libra:v1:scope:${scopeKey}:manifest`));
  const initialReplay = await f.r.context.__rebuildUnifiedStateForWorldline({ context, manifest, reason: 'memory_first_contiguous_state', allowIncompletePrefix: true });
  assert.equal(initialReplay.ok, true);

  const cache = JSON.parse(f.r.values.get(cacheKey));
  const olderAt = new Date(Date.parse(cache.updatedAt) - 60000).toISOString();

  // Seed an unresolved UNIFIED_REPLAY_SOURCE_CHANGED error older than the successful replay cache
  f.r.values.set(errKey, JSON.stringify({
    schema: 'libra.state_replay_error.v1',
    scopeKey,
    records: [{
      errorId: 'state_replay_error_stale_1',
      at: olderAt,
      message: 'UNIFIED_REPLAY_SOURCE_CHANGED',
      code: 'UNIFIED_REPLAY_SOURCE_CHANGED',
      context: { reason: 'memory_first_contiguous_state', worldlineId: 'main', rollbackIncomplete: false },
      resolvedAt: null,
      resolution: null
    }],
    updatedAt: olderAt
  }));

  const overviewSuperseded = await f.r.api.getRecentWorkOverview();
  const stateJobSuperseded = overviewSuperseded.jobs.find(j => j.id === 'state');
  assert.notEqual(stateJobSuperseded.status, 'failed', 'superseded UNIFIED_REPLAY_SOURCE_CHANGED must not fail State projection');
  assert.equal(stateJobSuperseded.error, '');

  const metaSuperseded = await f.r.api.getWorldManagerRuntimeMeta();
  assert.equal(metaSuperseded.lastReplayError, null, 'superseded replay error must not appear as active lastReplayError');

  // A rollbackIncomplete error MUST still surface even if older than replay cache
  f.r.values.set(errKey, JSON.stringify({
    schema: 'libra.state_replay_error.v1',
    scopeKey,
    records: [{
      errorId: 'state_replay_error_rollback_1',
      at: olderAt,
      message: 'ROLLBACK_FAILED',
      code: 'STATE_CORRECTION_ROLLBACK_INCOMPLETE',
      context: { reason: 'state_correction_added', worldlineId: 'main', rollbackIncomplete: true },
      resolvedAt: null,
      resolution: null
    }],
    updatedAt: olderAt
  }));

  const overviewRollback = await f.r.api.getRecentWorkOverview();
  const stateJobRollback = overviewRollback.jobs.find(j => j.id === 'state');
  assert.equal(stateJobRollback.status, 'failed');
  assert.equal(stateJobRollback.error, 'ROLLBACK_FAILED');
  assert.ok((await f.r.api.getWorldManagerRuntimeMeta()).lastReplayError, 'rollbackIncomplete error must remain surfaced');

  // Restore non-rollback error and run rebuildUnifiedStateForWorldline -> resolves error in storage
  f.r.values.set(errKey, JSON.stringify({
    schema: 'libra.state_replay_error.v1',
    scopeKey,
    records: [{
      errorId: 'state_replay_error_stale_2',
      at: '2020-01-01T00:00:00.000Z',
      message: 'UNIFIED_REPLAY_SOURCE_CHANGED',
      code: 'UNIFIED_REPLAY_SOURCE_CHANGED',
      context: { reason: 'memory_first_contiguous_state', worldlineId: 'main', rollbackIncomplete: false },
      resolvedAt: null,
      resolution: null
    }],
    updatedAt: '2020-01-01T00:00:00.000Z'
  }));

  const replayed = await f.r.context.__rebuildUnifiedStateForWorldline({ context, manifest, reason: 'memory_first_contiguous_state', allowIncompletePrefix: true });
  assert.equal(replayed.ok, true);

  const resolvedStore = JSON.parse(f.r.values.get(errKey));
  assert.ok(resolvedStore.records[0].resolvedAt, 'successful rebuildUnifiedStateForWorldline resolves prior UNIFIED_REPLAY_SOURCE_CHANGED');
});
