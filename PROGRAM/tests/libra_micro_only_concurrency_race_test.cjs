'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const observe = source => source.replace('      getSnapshot: () => clone(state.snapshot),',
  '      ownerReadonlySourceContext, openMemoryGraphReadFrame, ensureMemoryGraphUnifiedSuite, readMemoryGraphProjection, getSnapshot: () => clone(state.snapshot),')
  .replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
  '  globalThis.__stateViewTest = { LibraMemoryCore };\n  const publicApi = Object.freeze({\n    getHostLineageStatus:');

test('microOnly graph projection concurrency and freshness guarantees', { timeout: 60000 }, async () => {
  const fixture = await serverFixture({ mode: 'plugin_only', transformSource: observe });
  try {
    const { f } = fixture;
    await f.run();
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5);

    const core = f.r.context.__stateViewTest.LibraMemoryCore;
    core.ensureMemoryGraphUnifiedSuite();
    const resources = core.state.memoryGraphResources.openMaintenance({}, () => {});

    // 1. Verify microOnly projection read succeeds in steady state
    const initialProjection = await core.readMemoryGraphProjection(
      { expectedScopeKey: f.scopeKey, microOnly: true },
      null,
      resources
    );
    assert.ok(initialProjection.nodes.length > 0, 'microOnly returns projected nodes');

    // 2. Storage mutation during microOnly read frame rejects with body changed check
    const regKey = [...fixture.local.keys()].find(k => k.includes(':entity-registry:v2'));
    assert.ok(regKey, 'entity-registry storage key exists');
    const originalVal = fixture.local.get(regKey);

    const ctx = await core.resolveContext();
    const readFrame = await core.openMemoryGraphReadFrame(ctx.scope);
    await readFrame.readRaw(regKey);

    // Mutate storage
    fixture.local.set(regKey, JSON.stringify({ ...JSON.parse(originalVal), mutated: true }));

    await assert.rejects(
      async () => { await readFrame.assertCurrent(); },
      /LIBRA_GRAPH_READER_BODY_CHANGED/,
      'storage mutation during read frame is rejected by assertCurrent'
    );

    // Restore original storage
    fixture.local.set(regKey, originalVal);

    // 3. Source chat modification causes rejection on stale captured context
    const staleCapture = await core.ownerReadonlySourceContext.capture({
      requestId: 'stale_req_' + Date.now(),
      durationMs: 10000
    });
    assert.ok(await core.ownerReadonlySourceContext.assertCurrent({ handle: staleCapture.handle, requestId: staleCapture.summary.requestId }));

    // Modify source chat
    f.chat.message.push({ role: 'user', data: '새로운 턴 발화', chatId: 'race-turn-u' });
    f.chat.messages = f.chat.message;

    // Stale session must be rejected with NATIVE_IDENTITY_CHANGED or expired
    await assert.rejects(
      async () => { await core.ownerReadonlySourceContext.assertCurrent({ handle: staleCapture.handle, requestId: staleCapture.summary.requestId }); },
      /(?:NATIVE_IDENTITY_CHANGED|READ_CONTEXT_EXPIRED|READ_CONTEXT_BUSY)/,
      'stale source context is rejected when host chat changes'
    );

    // 4. Retry captures a fresh session and succeeds
    const freshCapture = await core.ownerReadonlySourceContext.capture({
      requestId: 'fresh_req_' + Date.now(),
      durationMs: 10000
    });
    assert.ok(await core.ownerReadonlySourceContext.assertCurrent({ handle: freshCapture.handle, requestId: freshCapture.summary.requestId }));

    const retriedProjection = await core.readMemoryGraphProjection(
      { expectedScopeKey: f.scopeKey, microOnly: true },
      null,
      resources
    );
    assert.ok(retriedProjection.nodes.length > 0, 'retried microOnly projection succeeds with fresh session');

    console.log('PASS microOnly concurrency, storage mutation guard, and READ_CONTEXT_EXPIRED renewal');
  } finally {
    await fixture.cleanup();
  }
});
