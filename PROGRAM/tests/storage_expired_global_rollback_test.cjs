'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, variants } = require('./storage_global_allchat_job_test.cjs');

const jobKey = namespace => `__memory_suite_internal_sync_job_v1__:${namespace}`;
async function expiredPartialJob(variant, options = {}) {
  const original = await fixture(variant, options);
  let requested = false;
  const unsubscribe = original.bridge.subscribeSyncJob(job => {
    if (!requested && job?.checkpoints?.A) {
      requested = true;
      void original.bridge.pauseGlobalModeJob();
    }
  });
  try {
    assert.equal((await original.bridge.setGlobalMode('server_only')).status, 'paused');
    await original.bridge.dispose();
    const job = JSON.parse(original.values.get(jobKey(variant[0])));
    // Reproduce a journal left overnight, rather than bypassing its loader.
    job.updatedAt = Date.now() - 12 * 60 * 60 * 1000;
    if (options.rollback) Object.assign(job, {
      cancelRequested:true, failedPhase:'rollback_routes', error:'MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING',
      errorDetails:{cause:'MEMORY_SUITE_JOB_RESUME_EXPIRED'}, resumeExpired:true
    });
    original.values.set(jobKey(variant[0]), JSON.stringify(job));
    return { original, job };
  } catch (error) {
    await original.close();
    throw error;
  } finally { unsubscribe(); }
}

for (const variant of variants) {
  const namespace = variant[0];
  for (const entry of ['cancelSyncJob', 'resumePendingSyncJob', 'setGlobalMode']) {
    test(`${namespace}: expired rollback completes through ${entry} without resuming payload transfer`, async () => {
      const { original, job } = await expiredPartialJob(variant, {rollback:true});
      let fresh;
      try {
        const remoteBefore = original.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0 ORDER BY key').all();
        const publishedKeys = [];
        fresh = await fixture(variant, {app:original.app, values:original.values, current:'B', transportFactory:base => (url, init = {}) => {
          if (String(url).endsWith('/v1/kv/set')) publishedKeys.push(JSON.parse(init.body).key);
          return base(url, init);
        }});
        const result = entry === 'setGlobalMode'
          ? await fresh.bridge.setGlobalMode('server_only') : await fresh.bridge[entry]();
        assert.equal(result.status, 'cancelled');
        assert.equal(result.rollbackComplete, true);
        assert.equal(result.error, '');
        assert.equal(result.jobId, job.jobId);
        const saved = JSON.parse(original.values.get(jobKey(namespace)));
        assert.deepEqual(saved.globalPlan, job.globalPlan, 'the admitted plan is immutable');
        assert.equal(saved.globalPlanDigest, job.globalPlanDigest);
        assert.equal(saved.resumeExpired, true, 'recovery does not extend transfer admission');
        for (const id of ['A', 'B', 'C', 'NEW']) assert.equal((await fresh.bridge.getScopeMode({scopeId:id})).mode, 'plugin_only');
        assert.equal(original.values.get(namespace+'.A'), 'A_SOURCE');
        assert.equal(original.values.get(namespace+'.B'), 'B_SOURCE');
        const remoteAfter = original.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0 ORDER BY key').all();
        const payloads = rows => rows.filter(row => row.key.startsWith(namespace+'.'));
        assert.deepEqual(payloads(remoteAfter), payloads(remoteBefore), 'existing server memory copies are preserved');
        assert(publishedKeys.length > 0, 'restored routing is published to the original server');
        assert(publishedKeys.every(key => key === `__memory_suite_scope_routes_v1__:${namespace}`), 'only routing metadata is written');
        const calls = fresh.calls.length;
        await fresh.proxy.setItem(namespace+'.A', 'LOCAL_AFTER_RECOVERY');
        assert.equal(await fresh.proxy.getItem(namespace+'.A'), 'LOCAL_AFTER_RECOVERY');
        assert.equal(fresh.calls.length, calls, 'restored owner reads and writes do not reconnect');
      } finally { if (fresh) await fresh.close(); await original.close(); }
    });
  }

  test(`${namespace}: expired forward transfer remains blocked while cancellation is available`, async () => {
    const { original } = await expiredPartialJob(variant);
    let fresh;
    try {
      fresh = await fixture(variant, {app:original.app, values:original.values});
      await assert.rejects(() => fresh.bridge.setGlobalMode('server_only'), error => error.code === 'MEMORY_SUITE_JOB_RESUME_EXPIRED');
      assert(!fresh.calls.some(call => call.path === '/v1/kv/set'));
      await assert.rejects(() => fresh.proxy.setItem(namespace+'.A', 'BLOCKED'), error => error.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
      assert.equal((await fresh.bridge.cancelSyncJob()).rollbackComplete, true);
    } finally { if (fresh) await fresh.close(); await original.close(); }
  });

  test(`${namespace}: expired rollback still refuses replacement DATA before server writes`, async () => {
    const { original } = await expiredPartialJob(variant, {rollback:true});
    let fresh, replacement;
    try {
      replacement = await fixture(variant);
      fresh = await fixture(variant, {app:original.app, values:original.values, transport:replacement.host.nativeFetch});
      await assert.rejects(() => fresh.bridge.cancelSyncJob(), error =>
        error.code === 'MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING' && /SERVER_PIN|DATA_INSTANCE/.test(error.details?.cause));
      assert(!replacement.calls.some(call => call.path === '/v1/kv/set'));
      assert.equal(fresh.bridge.getSyncJob().status, 'paused');
      assert.notEqual(fresh.bridge.getSyncJob().rollbackComplete, true);
      assert.equal(original.values.get(namespace+'.A'), 'A_SOURCE');
    } finally { if (fresh) await fresh.close(); if (replacement) await replacement.close(); await original.close(); }
  });

  test(`${namespace}: expired rollback still refuses a changed immutable plan`, async () => {
    const { original } = await expiredPartialJob(variant, {rollback:true});
    let fresh;
    try {
      const job = JSON.parse(original.values.get(jobKey(namespace)));
      job.globalPlan.registry.entries.A.mode = 'server_only';
      original.values.set(jobKey(namespace), JSON.stringify(job));
      const routes = original.values.get(original.registryKey);
      fresh = await fixture(variant, {app:original.app, values:original.values});
      await assert.rejects(() => fresh.bridge.cancelSyncJob(), error => error.code === 'MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
      assert.equal(original.values.get(original.registryKey), routes);
      assert(!fresh.calls.some(call => call.path === '/v1/kv/set'));
    } finally { if (fresh) await fresh.close(); await original.close(); }
  });
}
