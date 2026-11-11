'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, installedSdkVariants:variants } = require('./storage_global_allchat_job_test.cjs');

const methods = [
  ['handoff', (bridge, scope) => bridge.ensureHandoffReady({ scope })],
  ['native source durability', (bridge, scope) => bridge.verifyNativeBranchSourceDurability({ scope })]
];
const busy = error => error.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS';
async function legacyPausedFixture(variant) {
  const [namespace] = variant;
  const journalKey = `__memory_suite_internal_sync_job_v1__:${namespace}`;
  const original = await fixture(variant);
  const now = Date.now();
  original.values.set(journalKey, JSON.stringify({
    schema: 'memory-suite.sync-job.v1', namespace, jobId: 'legacy-paused', id: 'legacy-paused',
    kind: 'global_mode', scopeId: '__memory_suite_global__', status: 'paused', phase: 'recovery_pending',
    targetMode: 'server_only', sourceMode: 'plugin_only', effectsStarted: true, startedAt: now, updatedAt: now
  }));
  return original;
}

for (const variant of variants) {
  for (const [name, invoke] of methods) {
    test(`${variant[0]} ${name} refuses an active fast transfer and admits reads after stop`, async () => {
      let enterBatch, releaseBatch;
      const entered = new Promise(resolve => { enterBatch = resolve; });
      const held = new Promise(resolve => { releaseBatch = resolve; });
      const f = await fixture(variant, { current: 'C', transportFactory: base => async (url, init) => {
        if (new URL(url).pathname === '/v1/kv/batch') {
          enterBatch();
          await held;
        }
        return base(url, init);
      } });
      const transferring = f.bridge.setGlobalMode('server_only');
      try {
        await Promise.race([entered, transferring.then(() => { throw Error('Transfer completed before the first batch'); })]);
        for (const scopeId of ['C', 'NEW']) {
          await assert.rejects(() => invoke(f.bridge, { scopeId, scopeKey: scopeId }), busy);
        }
        await f.bridge.cancelSyncJob();
        releaseBatch();
        await assert.rejects(transferring, error => error.code === 'MEMORY_SUITE_TRANSFER_STOPPED');
        assert.equal((await f.bridge.getGlobalMode()).mode, 'plugin_only');
        assert.equal((await invoke(f.bridge, { scopeId: 'A', scopeKey: 'A' })).verified, true);
      } finally {
        releaseBatch();
        await transferring.catch(() => {});
        await f.close();
      }
    });

    test(`${variant[0]} ${name} refuses a restored legacy pause in selected and new scopes`, async () => {
      const original = await legacyPausedFixture(variant);
      let fresh;
      try {
        fresh = await fixture(variant, { app: original.app, values: original.values, current: 'C' });
        const before = [...fresh.values];
        for (const scopeId of ['C', 'NEW']) {
          await assert.rejects(() => invoke(fresh.bridge, { scopeId, scopeKey: scopeId }), busy);
        }
        assert.deepEqual([...fresh.values], before, 'readiness cannot modify data, routes, or the legacy journal');
      } finally { await fresh?.close(); await original.close(); }
    });
  }

  test(`${variant[0]} completed aggregate migration permits both readiness APIs`, async () => {
    const f = await fixture(variant);
    try {
      await f.bridge.setGlobalMode('server_only');
      assert.equal(f.bridge.getSyncJob().status, 'completed');
      for (const [, invoke] of methods) {
        assert.equal((await invoke(f.bridge, { scopeId: 'A', scopeKey: 'A' })).verified, true);
      }
    } finally { await f.close(); }
  });

  test(`${variant[0]} pending per-scope connection configuration blocks its scope and preserves unrelated readiness`, async () => {
    const original = await fixture(variant);
    let fresh;
    try {
      await original.bridge.setGlobalMode('server_only');
      const key = `__memory_suite_internal_sync_job_v1__:${variant[0]}`;
      const journal = JSON.parse(original.values.get(key));
      journal.kind = 'connection_config';
      delete journal.engine;
      journal.status = 'paused';
      journal.scopeId = 'B';
      original.values.set(key, JSON.stringify(journal));
      await original.bridge.dispose();
      fresh = await fixture(variant, { app: original.app, values: original.values });
      for (const [, invoke] of methods) {
        await assert.rejects(() => invoke(fresh.bridge, { scopeId: 'B', scopeKey: 'B' }), busy);
        assert.equal((await invoke(fresh.bridge, { scopeId: 'A', scopeKey: 'A' })).verified, true);
      }
    } finally { if (fresh) await fresh.close(); await original.close(); }
  });
}
