'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

for (const mode of ['plugin_only','server_only','mirror']) for (const mutation of ['bookkeeping', 'remove_sources']) test(`${mode}: classic recall verifies a concurrent manifest write: ${mutation}`, async () => {
  const x = await fixture({ mode, transformSource: source => source.replace('let lensRecall = null;', `
    if (globalThis.__concurrentManifestMutation) {
      const publish = async () => {
        const latest = await loadManifest(context.scope, 6);
        if (globalThis.__concurrentManifestMutation === 'remove_sources') latest.memories = {};
        else latest.stats = { ...latest.stats, fixtureReadCount: 1 };
        await saveManifest(context.scope, latest);
        globalThis.__concurrentManifestWriteCompleted = true;
      };
      if (globalThis.__concurrentManifestMutation === 'remove_sources') await publish();
      else globalThis.__concurrentManifestWrite = enqueue(context.scope.scopeKey, publish);
    }
    let lensRecall = null;`) });
  try {
    await x.f.r.api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
    x.f.r.context.__concurrentManifestMutation = mutation;
    const out = await x.f.control.hooks.beforeRequest([{ role: 'user', content: QUOTE }], 'model');
    const meta = x.f.r.api.getRuntime().lastMemoryInjectionMeta;
    if (mutation === 'bookkeeping') {
      assert.equal(meta.injected, true, JSON.stringify(meta));
      assert.ok(out.some(row => String(row.content).includes('LIBRA')));
      await x.f.r.context.__concurrentManifestWrite;
      assert.equal(x.f.r.context.__concurrentManifestWriteCompleted, true, 'deferred writer must finish');
    } else {
      assert.equal(x.f.r.context.__concurrentManifestWriteCompleted, true);
      assert.notEqual(meta.injected, true, 'changed source inventory must still refuse delivery');
      assert.equal(out.length, 1);
    }
  } finally { await x.cleanup(); }
});
