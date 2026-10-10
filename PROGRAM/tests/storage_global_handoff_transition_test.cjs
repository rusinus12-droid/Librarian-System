'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, variants } = require('./storage_global_allchat_job_test.cjs');

const methods = [
  ['handoff', (bridge, scope) => bridge.ensureHandoffReady({ scope })],
  ['native source durability', (bridge, scope) => bridge.verifyNativeBranchSourceDurability({ scope })]
];
const busy = error => error.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS';
const sources = f => [...f.values].filter(([key]) => key.startsWith(f.namespace + '.'));

async function pausedFixture(variant) {
  let injected = false;
  const f = await fixture(variant, { writeFault: async (key, value) => {
    if (key === `__memory_suite_internal_sync_job_v1__:${variant[0]}`
      && !injected && JSON.parse(value).checkpoints?.A) {
      injected = true;
      throw new Error('synthetic_pause_after_first_scope');
    }
  } });
  f.namespace = variant[0];
  try {
    await assert.rejects(() => f.bridge.setGlobalMode('server_only'));
    assert.equal(injected, true);
    assert.equal(f.bridge.getSyncJob().kind, 'global_mode');
    assert.equal(f.bridge.getSyncJob().status, 'paused');
    assert.equal((await f.bridge.getGlobalMode()).mode, 'plugin_only');
    f.setCurrent('C');
    return f;
  } catch (error) { await f.close(); throw error; }
}

for (const variant of variants) {
  for (const [name, invoke] of methods) {
    for (const restarted of [false, true]) {
      test(`${variant[0]} ${name} refuses ${restarted ? 'restored' : 'live'} aggregate pause in selected and new scopes`, async () => {
        const original = await pausedFixture(variant);
        let fresh;
        try {
          if (restarted) {
            await original.bridge.dispose();
            fresh = await fixture(variant, { app: original.app, values: original.values, current: 'C' });
            fresh.namespace = variant[0];
          }
          const f = fresh || original;
          const before = sources(f);
          const registry = f.values.get(f.registryKey);
          const journalKey = `__memory_suite_internal_sync_job_v1__:${variant[0]}`;
          const journal = f.values.get(journalKey);
          for (const scopeId of ['C', 'NEW']) {
            await assert.rejects(() => invoke(f.bridge, { scopeId, scopeKey: scopeId }), busy);
          }
          assert.deepEqual(sources(f), before, 'refusal preserves source payloads');
          assert.equal(f.values.get(f.registryKey), registry, 'refusal cannot publish a route');
          assert.equal(f.values.get(journalKey), journal, 'readiness does not resume or rewrite the job');
        } finally { if (fresh) await fresh.close(); await original.close(); }
      });
    }
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
