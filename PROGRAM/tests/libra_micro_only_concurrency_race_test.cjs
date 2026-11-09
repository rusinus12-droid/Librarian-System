'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const observe = source => source
  .replace(
    'const read = async (keyValue, load) => {',
    'const read = async (keyValue, load) => {\n' +
    '        if (globalThis.__microOnlyRaceTrigger) await globalThis.__microOnlyRaceTrigger(keyValue);\n'
  )
  .replace(
    '      getSnapshot: () => clone(state.snapshot),',
    '      openMemoryGraphReadFrame, ensureMemoryGraphUnifiedSuite, readMemoryGraphProjection, readMemoryGraphProjectionOnce, getSnapshot: () => clone(state.snapshot),'
  )
  .replace(
    '  const publicApi = Object.freeze({\n    getHostLineageStatus:',
    '  globalThis.__stateViewTest = { LibraMemoryCore };\n  const publicApi = Object.freeze({\n    getHostLineageStatus:'
  );

test('microOnly graph projection concurrency and in-flight mutation fail-closed guarantees', { timeout: 60000 }, async () => {
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

    const targetKey = [...fixture.local.keys()].find(k => k.includes(':source-receipt-head:'));
    assert.ok(targetKey, 'source-receipt-head storage key exists');
    const originalVal = fixture.local.get(targetKey);

    // 2. IN-FLIGHT storage mutation during readMemoryGraphProjectionOnce
    // Intercept during mid-read execution: when micro-turn is read, mutate storage key.
    // readFrame.assertCurrent() must catch the discrepancy and reject fail-closed.
    let storageMutationTriggered = false;
    f.r.context.__microOnlyRaceTrigger = async (keyValue) => {
      if (typeof keyValue === 'string' && keyValue.startsWith('micro-turn:') && !storageMutationTriggered) {
        storageMutationTriggered = true;
        fixture.local.set(targetKey, JSON.stringify({ ...JSON.parse(originalVal), mutated: true }));
      }
    };

    await assert.rejects(
      async () => {
        await core.readMemoryGraphProjectionOnce(
          { expectedScopeKey: f.scopeKey, microOnly: true },
          null,
          resources
        );
      },
      /LIBRA_GRAPH_READER_BODY_CHANGED/,
      'in-flight storage mutation during microOnly projection must be rejected fail-closed with LIBRA_GRAPH_READER_BODY_CHANGED'
    );
    assert.ok(storageMutationTriggered, 'storage mutation hook was executed in-flight');

    // Also verify that the outer retry wrapper exhausts retries and fails closed under persistent mutation
    let persistentCount = 0;
    f.r.context.__microOnlyRaceTrigger = async (keyValue) => {
      if (typeof keyValue === 'string' && keyValue.startsWith('micro-turn:')) {
        persistentCount++;
        fixture.local.set(targetKey, JSON.stringify({ ...JSON.parse(originalVal), mutationSeq: persistentCount }));
      }
    };

    await assert.rejects(
      async () => {
        await core.readMemoryGraphProjection(
          { expectedScopeKey: f.scopeKey, microOnly: true },
          null,
          resources
        );
      },
      /LIBRA_GRAPH_READER_BODY_CHANGED/,
      'persistent in-flight storage mutation across retries must fail closed with LIBRA_GRAPH_READER_BODY_CHANGED'
    );

    // Restore original storage
    fixture.local.set(targetKey, originalVal);
    f.r.context.__microOnlyRaceTrigger = null;

    // 3. IN-FLIGHT chat modification during readMemoryGraphProjectionOnce
    // Intercept during mid-read execution: when reading micro turn keys, append a new user message to host chat.
    // sourceContext.assertCurrent() must reject stale context.
    let chatMutationTriggered = false;
    f.r.context.__microOnlyRaceTrigger = async (keyValue) => {
      if (typeof keyValue === 'string' && keyValue.startsWith('micro-turn:') && !chatMutationTriggered) {
        chatMutationTriggered = true;
        f.chat.message.push({ role: 'user', data: '인플라이트 동시성 새 턴 발화', chatId: 'race-inflight-u' });
        f.chat.messages = f.chat.message;
      }
    };

    await assert.rejects(
      async () => {
        await core.readMemoryGraphProjectionOnce(
          { expectedScopeKey: f.scopeKey, microOnly: true },
          null,
          resources
        );
      },
      /(?:NATIVE_IDENTITY_CHANGED|READ_CONTEXT_EXPIRED|READ_CONTEXT_BUSY)/,
      'in-flight chat modification during microOnly projection must be rejected fail-closed with NATIVE_IDENTITY_CHANGED/READ_CONTEXT_EXPIRED'
    );
    assert.ok(chatMutationTriggered, 'chat mutation hook was executed in-flight');

    // 4. Retry without active race trigger captures fresh context and succeeds
    f.r.context.__microOnlyRaceTrigger = null;
    const retriedProjection = await core.readMemoryGraphProjection(
      { expectedScopeKey: f.scopeKey, microOnly: true },
      null,
      resources
    );
    assert.ok(retriedProjection.nodes.length > 0, 'retried microOnly projection succeeds with fresh session');

    console.log('PASS microOnly in-flight storage & chat mutation fail-closed guarantees verified');
  } finally {
    if (fixture.f?.r?.context) fixture.f.r.context.__microOnlyRaceTrigger = null;
    await fixture.cleanup();
  }
});
