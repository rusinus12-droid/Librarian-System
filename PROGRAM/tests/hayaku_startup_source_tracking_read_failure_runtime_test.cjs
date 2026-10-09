'use strict';

const assert = require('node:assert/strict');
const {
  createStore,
  createHayakuRuntime,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const SOURCE_TRACKING_KEY = 'hayaku.v2.settings.source-tracking.v1';

const sourceTrackingUnavailableStore = () => {
  const store = createStore();
  const getItem = store.getItem.bind(store);
  let unavailable = true;
  store.getItem = async key => {
    if (unavailable && String(key) === SOURCE_TRACKING_KEY) throw new Error('fixture_source_tracking_read_unavailable');
    return getItem(key);
  };
  return { store, recover: () => { unavailable = false; } };
};

(async () => {
  const fixture = sourceTrackingUnavailableStore();
  const pluginStorage = fixture.store;
  const runtime = await createHayakuRuntime({ pluginStorage, autoRepair: false });
  try {
    await waitFor(() => runtime.hayaku.lastDebug().compat.captureBackendRegistered === true,
      'hook registration after unavailable source-tracking preferences');
    const startup = runtime.hayaku.lastDebug();
    assert.equal(startup.compat.beforeRequestRegistered, true,
      'a source-tracking preference read failure must not prevent beforeRequest registration');
    assert.equal(startup.compat.afterRequestRegistered, true,
      'a source-tracking preference read failure must not prevent afterRequest registration');
    assert.equal(startup.compat.chatOutputListenerRegistered, true,
      'a source-tracking preference read failure must not prevent committed-output capture registration');
    assert.equal(startup.compat.captureBackendRegistered, true,
      'packet capture must retain one registered backend while source tracking is unavailable');
    assert.match(startup.sourceTracking.lastError, /SOURCE_TRACKING_READ_UNAVAILABLE/,
      'the startup diagnostic must retain the unavailable preference state');

    await assert.rejects(
      () => runtime.hayaku._test.getHayakuSourceEdits().ready(),
      /SOURCE_TRACKING_READ_UNAVAILABLE/,
      'unread source-tracking preferences must remain unavailable, not become a default authority state'
    );
    assert.equal(pluginStorage.values.has(SOURCE_TRACKING_KEY), false,
      'a failed preference read must not write a default tracking record');

    const request = [{ role: 'user', content: 'Continue the existing scene.' }];
    const storageKeysBeforeDeferredRequest = [...pluginStorage.values.keys()];
    const deferred = await runtime.callBeforeRequest(request);
    assert.deepEqual(deferred, request,
      'a source-tracking preference read failure must defer the request without injecting or changing its messages');
    assert.deepEqual([...pluginStorage.values.keys()], storageKeysBeforeDeferredRequest,
      'a deferred request must not publish an authority-changing ledger write');
    assert.equal(runtime.hayaku.lastDebug().lastBeforeRequest.reason, 'source_tracking_preferences_unavailable');
    assert.equal(await runtime.callAfterRequest('An unchanged assistant response.'), 'An unchanged assistant response.',
      'afterRequest must defer packet repair/capture while source-tracking preferences are unavailable');
    const output = await runtime.hayaku._test.processRisuChatOutputEvent({
      char: runtime.character,
      chat: runtime.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 0
    });
    assert.equal(output.reason, 'source_tracking_preferences_unavailable',
      'the committed-output capture path must not create a packet while source authority is unavailable');
    assert.deepEqual([...pluginStorage.values.keys()], storageKeysBeforeDeferredRequest,
      'none of the deferred request/output paths may write a ledger while preferences are unreadable');

    fixture.recover();
    await runtime.hayaku._test.getHayakuSourceEdits().ready();
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().mode, 'auto',
      'only a later fulfilled missing-key read may establish the default tracking mode');
    await runtime.hayaku.setSourceEditIgnoredTags(['reviewtag']);
    assert.ok(runtime.hayaku.getSourceEditIgnoredTags().includes('reviewtag'),
      'the deferred request lifetime must be released when its deferred afterRequest completes');
    await runtime.callBeforeRequest([{ role: 'user', content: 'Continue after source-tracking storage recovery.' }]);
    await runtime.callAfterRequest('A normal request completed after source-tracking storage recovery.');
    await runtime.hayaku.setSourceEditIgnoredTags(['reviewtag', 'after-normal']);
    assert.ok(runtime.hayaku.getSourceEditIgnoredTags().includes('after-normal'),
      'a subsequent normal request/response must preserve the released source-tracking lifecycle');
    assert.equal(runtime.hayaku.lastDebug().sourceTracking.ready, true,
      'a real later request must leave source tracking ready after storage recovery');
    assert.notEqual(runtime.hayaku.lastDebug().lastBeforeRequest.reason, 'source_tracking_preferences_unavailable',
      'a real later request must resume the normal hook path rather than remain permanently deferred');

    process.stdout.write('hayaku_startup_source_tracking_read_failure_runtime_test: PASS\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
