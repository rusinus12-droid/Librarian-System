'use strict';
// Verifies that a paused or stalled background sync job exposes interactive
// retry and cancel controls in mountConnectionPanel, and that clicking cancel
// successfully marks the job as cancelled, clears the persisted journal, and unlocks UI controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const sources = [
  { name: 'Standard (Flashback / HAYAKU)', file: 'PROGRAM/sdk/MemorySuiteStorageClient.source.js', namespace: 'flashback' },
  { name: 'LIBRA Variant', file: 'PROGRAM/sdk/MemorySuiteStorageClient.libra.source.js', namespace: 'libra' }
];

(async () => {
  for (const target of sources) {
    const filePath = path.resolve(__dirname, '..', target.file.replace(/^PROGRAM\//, ''));
    const sourceCode = fs.readFileSync(filePath, 'utf8');

    const dom = new JSDOM('<!doctype html><html><body><div id="panel-host"></div></body></html>', {
      url: 'https://offline.invalid',
      pretendToBeVisual: true
    });
    const doc = dom.window.document;
    const container = doc.getElementById('panel-host');

    const values = new Map();
    const jobKey = `__memory_suite_internal_sync_job_v1__:${target.namespace}`;
    const pausedJob = {
      schema: 'memory-suite.sync-job.v1',
      namespace: target.namespace,
      pluginId: `${target.namespace}_memory`,
      pluginVersion: '1.0.0',
      jobId: `job_${target.namespace}_test_stalled`,
      id: `job_${target.namespace}_test_stalled`,
      kind: 'connection_config',
      scopeId: '',
      sourceMode: 'plugin_only',
      targetMode: 'server_only',
      requestedMode: 'server_only',
      effectiveMode: 'plugin_only',
      targetUrl: 'http://127.0.0.1:47630',
      status: 'paused',
      phase: 'waiting_for_server',
      message: '서버 연결이 일시적으로 끊겼습니다.',
      error: 'ECONNREFUSED',
      startedAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
      lastActivityAt: Date.now() - 30000,
      retryCount: 3,
      failures: 3
    };
    values.set(jobKey, JSON.stringify(pausedJob));

    const mockPluginStorage = {
      getItem: async k => values.get(String(k)) ?? null,
      setItem: async (k, v) => { values.set(String(k), v); return true; },
      removeItem: async k => { values.delete(String(k)); return true; },
      keys: async () => [...values.keys()]
    };

    const context = vm.createContext({
      document: doc,
      window: dom.window,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      JSON,
      Set,
      Map,
      Promise,
      Error,
      URL,
      TextEncoder,
      TextDecoder,
      console
    });

    const runner = `
      ${sourceCode}
      globalThis.bridge = createMemorySuiteStorageBridge({
        namespace: '${target.namespace}',
        pluginId: '${target.namespace}_memory',
        pluginVersion: '1.0.0',
        pluginStorage: mockPluginStorage,
        defaultUrl: 'http://127.0.0.1:47630'
      });
    `;
    context.mockPluginStorage = mockPluginStorage;
    vm.runInContext(runner, context);
    const bridge = context.bridge;

    // 1. Mount connection panel with paused job
    await bridge.mountConnectionPanel(container);

    // 2. Cancel and retry buttons should be visible in paused state
    const cancelBtn = container.querySelector('button[data-job-cancel]') || container.querySelector('button[data-mscx-job-cancel]');
    assert.ok(cancelBtn, `${target.name}: cancel button rendered`);
    const stalledActions = container.querySelector('[data-job-stalled-actions]');
    if (stalledActions) {
      assert.equal(stalledActions.style.display !== 'none', true, `${target.name}: stalled actions container should be visible when job is paused`);
    } else {
      assert.equal(cancelBtn.style.display !== 'none', true, `${target.name}: cancel button should be visible when job is paused`);
    }

    const retryBtn = container.querySelector('button[data-job-retry]') || container.querySelector('button[data-mscx-job-retry]');
    assert.ok(retryBtn, `${target.name}: retry button rendered`);
    if (!stalledActions) {
      assert.equal(retryBtn.style.display !== 'none', true, `${target.name}: retry button should be visible when job is paused`);
    }

    // 3. Server URL input should NOT be disabled when paused (allow correcting URL)
    const urlInput = container.querySelector('[data-url]') || container.querySelector('[data-mscx-url]');
    assert.ok(urlInput, `${target.name}: URL input exists`);
    assert.equal(urlInput.disabled, false, `${target.name}: URL input should be editable when job is paused`);

    // 4. Click cancel button
    assert.ok(typeof cancelBtn.onclick === 'function', `${target.name}: cancel button click handler exists`);
    await cancelBtn.onclick();

    // 5. Job should be cancelled and journal cleared
    const currentJob = bridge.getSyncJob();
    assert.equal(currentJob?.status, 'cancelled', `${target.name}: sync job status should be cancelled`);
    assert.equal(values.has(jobKey), false, `${target.name}: job journal should be removed from pluginStorage`);

    // 6. UI controls should be fully unlocked
    const applyBtn = container.querySelector('[data-apply]') || container.querySelector('[data-mscx-apply]');
    assert.ok(applyBtn, `${target.name}: apply button exists`);
    assert.equal(applyBtn.disabled, false, `${target.name}: apply button should be enabled after cancelling job`);

    console.log(`PASS ${target.name}: retry/cancel buttons active on paused job, and cancel unlocks controls`);

    // A global migration can have published transition-pending scope routes.
    // A legacy/corrupt job without its original routing plan cannot be rolled
    // back safely. Refuse cancellation and retain its recovery journal.
    const globalValues = new Map();
    const globalJobKey = `__memory_suite_internal_sync_job_v1__:${target.namespace}`;
    const globalJob = {
      schema: 'memory-suite.sync-job.v1', namespace: target.namespace,
      pluginId: `${target.namespace}_memory`, pluginVersion: '1.0.0',
      jobId: `job_${target.namespace}_global_cancel`, kind: 'global_mode', scopeId: '__global__',
      status: 'paused', phase: 'paused_resumable', effectsStarted: true,
      checkpoints: { scope_a: { verified: true } }, pauseRequested: false,
      startedAt: Date.now() - 30000, updatedAt: Date.now() - 1000, lastActivityAt: Date.now() - 1000
    };
    globalValues.set(globalJobKey, JSON.stringify(globalJob));
    globalValues.set('owner-record-preserved', 'source-data');
    const globalStorage = {
      getItem: async key => globalValues.get(String(key)) ?? null,
      setItem: async (key, value) => { globalValues.set(String(key), value); return true; },
      removeItem: async key => { globalValues.delete(String(key)); return true; },
      keys: async () => [...globalValues.keys()]
    };
    const globalContext = vm.createContext({
      mockPluginStorage: globalStorage, document: doc, window: dom.window,
      navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement, setTimeout, clearTimeout,
      setInterval, clearInterval, Date, Math, Number, String, Boolean, Array,
      Object, JSON, Set, Map, Promise, Error, URL, TextEncoder, TextDecoder, console
    });
    vm.runInContext(`${sourceCode} globalThis.bridge = createMemorySuiteStorageBridge({namespace:'${target.namespace}',pluginId:'${target.namespace}_memory',pluginVersion:'1.0.0',pluginStorage:mockPluginStorage,defaultUrl:'http://127.0.0.1:47630'});`, globalContext);
    const globalBridge = globalContext.bridge;
    await assert.rejects(() => globalBridge.cancelSyncJob(), error => error.code === 'MEMORY_SUITE_GLOBAL_ROLLBACK_PLAN_INVALID');
    assert.equal(globalBridge.getSyncJob()?.status, 'paused', `${target.name}: invalid-plan cancellation remains paused`);
    assert.equal(globalValues.has(globalJobKey), true, `${target.name}: global migration recovery journal remains persisted`);
    assert.equal(JSON.parse(globalValues.get(globalJobKey)).pauseRequested, true, `${target.name}: global migration records the stop request`);
    assert.equal(globalValues.get('owner-record-preserved'), 'source-data', `${target.name}: source data remains intact`);
    console.log(`PASS ${target.name}: cancellation with no routing plan refuses rollback and preserves recovery evidence`);
  }
  console.log('ALL STORAGE JOB CANCELLATION TESTS PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
