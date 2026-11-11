'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, installedSdkVariants:variants } = require('./storage_global_allchat_job_test.cjs');

const savedUrl = async (f, namespace) =>
  await f.host.pluginStorage.getItem('__memory_suite_internal_server_url_v1__:' + namespace)
  || await f.host.getArgument('memory_suite_server_url');

for (const variant of variants) {
  const [namespace] = variant;
  test(namespace + ': reapply after stopping discovers and transfers the current source', async () => {
    const f = await fixture(variant);
    let stopped = false;
    const unsubscribe = f.bridge.subscribeSyncJob(job => {
      if (stopped || job?.engine !== 'fast' || job.phase !== 'copy') return;
      stopped = true;
      void f.bridge.cancelSyncJob();
    });
    try {
      await assert.rejects(() => f.bridge.setGlobalMode('server_only'),
        error => error.code === 'MEMORY_SUITE_TRANSFER_STOPPED');
      const old = f.bridge.getSyncJob();
      assert.equal(old.status, 'cancelled');
      await f.proxy.setItem(namespace + '.B', 'NEW_SOURCE');
      const result = await f.bridge.setGlobalMode('server_only');
      assert.equal(result.completeKnownScopes, true);
      assert.notEqual(f.bridge.getSyncJob().jobId, old.jobId);
      assert.equal(f.app.repositories[namespace].get('plugin', namespace + '.B').value, 'NEW_SOURCE');
      assert.equal((await f.bridge.inspectModePublication()).status, 'observed');
    } finally { unsubscribe(); await f.close(); }
  });

  test(namespace + ': URL preview is read-only and Apply rejects changing a live server route', async () => {
    const f = await fixture(variant);
    const url = 'http://127.0.0.1:47632';
    try {
      const before = [...f.values];
      const preview = await f.bridge.previewGlobalMode('server_only', { url });
      assert.equal(preview.completeKnownScopes, true);
      assert.equal(preview.targetUrl, url);
      assert.deepEqual([...f.values], before);
      assert.equal(await savedUrl(f, namespace), 'http://127.0.0.1:47631');
      const result = await f.bridge.setGlobalMode('server_only', { url });
      assert.equal(result.completeKnownScopes, true);
      assert.equal(await savedUrl(f, namespace), url);
      assert.equal(f.bridge.getSyncJob().targetUrl, url);
      assert.equal((await f.bridge.inspectModePublication()).status, 'observed');
      await assert.rejects(() => f.bridge.setGlobalMode('server_only', { url: 'http://127.0.0.1:47633' }),
        error => error.code === 'MEMORY_SUITE_SERVER_URL_IN_USE');
      assert.equal(await savedUrl(f, namespace), url);
    } finally { await f.close(); }
  });

  test(namespace + ': Apply includes a chat added after a read-only preview', async () => {
    const catalog = { characters: [{ chaId: 'one', chats: [{ id: 'A' }] }, { chaId: 'two', chats: [{ id: 'B' }] }] };
    const f = await fixture(variant, { catalogRead: async () => structuredClone(catalog) });
    try {
      const preview = await f.bridge.previewGlobalMode('server_only');
      assert.equal(preview.discoveredScopes, 2);
      catalog.characters[1].chats.push({ id: 'ADDED' });
      f.values.set(namespace + '.ADDED', 'ADDED_SOURCE');
      const result = await f.bridge.setGlobalMode('server_only');
      assert.equal(result.discoveredScopes, 3);
      assert.equal(f.app.repositories[namespace].get('plugin', namespace + '.ADDED').value, 'ADDED_SOURCE');
      assert.equal((await f.bridge.getScopeMode({ scopeId: 'ADDED' })).mode, 'server_only');
    } finally { await f.close(); }
  });
}
