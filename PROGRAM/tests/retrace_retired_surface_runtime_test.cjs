'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime, createStore } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createDocument } = require('./fixtures/retrace_gui_dom_fixture.cjs');

// A reintroduced legacy API, handler, or renderer must fail this contract.
const retiredApi = ['backupHayakuLedger', 'listHayakuLedgerBackups', 'lastHayakuBackup',
  'deleteHayakuRecord', 'jumpToHayakuTurn', 'readFlashbackViewer', 'readHayakuViewer', 'readLibraViewer'];
const retiredCode = ['backupHayakuLedger', 'listHayakuLedgerBackups', 'readFlashbackViewer',
  'readHayakuViewerSource', 'refreshLibra', 'refreshFlashback', 'refreshHayaku',
  'renderLibra', 'renderFlashback', 'renderHayaku', 'deleteHayakuRecord', 'jumpToHayakuTurn'];
const retiredIds = ['backupHayaku', 'exportHayaku', 'exportFlashback', 'exportLibra',
  'refreshHayaku', 'refreshFlashback', 'refreshLibra', 'hayakuBody', 'flashbackBody', 'libraBody',
  'hayakuTurnInput', 'jumpHayakuTurn'];
const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');

(async () => {
  const document = createDocument();
  const pluginStorage = createStore();
  const preservedKey = 'memory_session_bridge:hayaku_ledger_backup:old-scope:old-backup';
  const preservedCatalogKey = 'memory_session_bridge:hayaku_ledger_backup_catalog:old-scope';
  await pluginStorage.setItem(preservedKey, 'preserve old backup bytes');
  await pluginStorage.setItem(preservedCatalogKey, 'preserve old catalog bytes');
  const runtime = await createHayakuRuntime({ autoRepair: false, loadRetrace: true, pluginStorage,
    beforeRetraceLoad(host, context) { context.document = document; host.showContainer = async () => true; }
  });
  try {
    for (const alias of ['__RETRACE', '__LihaflBridge', '__MemorySessionBridge']) {
      const api = runtime.context[alias];
      assert.ok(api, `${alias}: existing handoff alias remains`);
      for (const key of retiredApi) assert.equal(key in api, false, `${alias}.${key} must be retired`);
      for (const key of ['showUi', 'inspectTransition', 'continueToNextSession', 'resumeNextSessionHandoff',
        'inspectCompatibility', 'inspectPendingNextSessionHandoff', 'debugSnapshot']) {
        assert.equal(typeof api[key], 'function', `${alias}.${key} remains functional`);
      }
    }
    for (const key of retiredCode) assert.equal(new RegExp(`\\b${key}\\b`).test(source), false, `${key}: no dead implementation remains`);
    await runtime.retrace.showUi();
    const root = document.querySelector('#flashback-hayaku-bridge-root');
    assert.ok(root?.isConnected, 'real plugin UI mounted');
    assert.deepEqual(root.querySelectorAll('[data-tab]').map(node => node.getAttribute('data-tab')),
      ['overview', 'session', 'serverdata', 'serverconnection', 'diagnostics']);
    for (const id of retiredIds) assert.equal(root.querySelector('#' + id), null, `${id}: no retired control`);
    for (const id of ['createSession', 'refreshTransition', 'serverDataBody', 'refreshServerData', 'serverResetBegin']) {
      assert.ok(root.querySelector('#' + id), `${id}: existing handoff/server control remains`);
    }
    for (const namespace of ['flashback', 'hayaku', 'libra', 'lia', 'retrace']) {
      assert.ok(root.querySelector(`[data-control-namespace][value="${namespace}"]`), `${namespace}: server restore scope retained`);
    }
    await runtime.retrace.inspectTransition();
    assert.equal(await pluginStorage.getItem(preservedKey), 'preserve old backup bytes');
    assert.equal(await pluginStorage.getItem(preservedCatalogKey), 'preserve old catalog bytes');
    assert.equal(runtime.llmCalls.length, 0, 'retirement never starts recovery models');
    console.log('retrace_retired_surface_runtime_test: PASS (real API/UI, five server scopes, handoff inspection, old bytes retained)');
  } finally { await runtime.dispose(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
