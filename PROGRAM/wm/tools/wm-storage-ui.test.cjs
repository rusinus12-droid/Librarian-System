'use strict';
// B6 basic fake-provider UI lane only. No host/data activation or comprehensive fault matrix.
const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../src/wm-storage-ui.source.js');
const C = require('../src/wm-storage-contracts.source.js');
const G = require('../src/wm-native-host-gate.source.js');
const {fixture: hostFixture} = require('./wm-host-gate-fixture.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => {const end = Date.now() + 3000; while (!condition()) {assert(Date.now() < end, 'basic UI flow reached expected state'); await sleep(5);}};
function fixture({qualified = true} = {}) {
    const host = hostFixture(), route = clone(host.state.route), counts = Object.fromEntries(C.DOMAINS.map(d => [d, 1])), bytes = Object.fromEntries(C.DOMAINS.map(d => [d, 10]));
    const calls = {connection: 0, upload: 0, routeWrites: 0, prepare: [], resume: [], cancel: [], preview: 0}, records = new Map();
    let latest = null;
    const backend = {async checkConnection() {calls.connection++; return {ok: true, backendId: 'fake-server', protocol: C.PROTOCOL, limits: {maxChunkBytes: 262144}};}};
    const router = {async readMigrationRoute() {return clone(route);}, migrationBackend() {return backend;}};
    const migration = {
        async inspect({targetMode}) {calls.preview++; return {previewFingerprint: 'a'.repeat(64), sourceRoute: clone(route), targetMode, targetBackendId: 'fake-server', domainCounts: counts, domainBytes: bytes, requiredStagingBytes: 60, sourcePreserved: true, targetHasExistingData: false, complete: true, canStart: route.mode !== targetMode, blockers: route.mode === targetMode ? ['already_target_mode'] : []};},
        async readState(id) {return clone(id === undefined ? latest : records.get(id) || null);},
        async prepare({operationId}) {calls.prepare.push(operationId); latest = {operationId, requestFingerprint: 'b'.repeat(64), state: 'inventory_frozen', sourceRoute: clone(route), targetRoute: {...clone(route), mode: 'server_only', backendId: 'fake-server', routeGeneration: 'migration-' + operationId}, inventoryDigest: 'c'.repeat(64), domainCounts: counts, domainBytes: bytes, copiedBytes: 0}; records.set(operationId, latest); return clone(latest);},
        async copyNext({operationId}) {assert.equal(operationId, latest.operationId); calls.upload++; latest.copiedBytes = 60; latest.state = 'verifying'; return clone(latest);},
        async verify(id) {assert.equal(id, latest.operationId); latest.state = 'cutover_prepared'; latest.receipt = {schema: 'wm.migration-receipt.v1', operationId: id, requestFingerprint: latest.requestFingerprint, sourceRoute: clone(latest.sourceRoute), targetRoute: clone(latest.targetRoute), inventoryDigest: latest.inventoryDigest, domainCounts: counts, domainBytes: bytes, sourcePreserved: true, cutoverStatus: 'verified', verified: true}; return clone(latest);},
        async cutover(id) {assert.equal(id, latest.operationId); calls.routeWrites++; Object.assign(route, latest.targetRoute); latest.state = 'complete'; latest.receipt.cutoverStatus = 'committed'; return {status: 'committed'};},
        async resume(id) {calls.resume.push(id); latest = records.get(id); latest.state = 'copying'; return clone(latest);},
        async cancel(id) {calls.cancel.push(id); latest = records.get(id); latest.state = 'interrupted'; latest.reason = 'cancelled_source_fence_retained'; return clone(latest);}
    };
    const options = {router, migration, hostGate: qualified ? host.gate : G.createWmNativeHostGate(), backupStatus: async () => ({lastBackup: {state: 'verified', id: 'fake-backup', verifiedAt: '2026-10-08T09:00:00Z', coverage: {wm: true}}, lastRestore: {state: 'absent'}})};
    return {calls, options, migration, route, records, vm: UI.createWmStorageViewModel(options)};
}
function panel(t, f) {
    const dom = new JSDOM('<div id="storage" data-wm-storage-controls></div>'), root = dom.window.document.querySelector('#storage');
    let confirmations = 0;
    const mounted = UI.mountWmStoragePanel({root, viewModel: f.vm, confirm: async message => {assert.match(message, /WM 전체 채팅.*6개/); confirmations++; return true;}, newOperationId: () => 'basic-ui-operation'});
    t.after(() => {mounted.dispose(); dom.window.close();});
    return {root, mounted, dom, confirmations: () => confirmations, button: name => root.querySelector(`[data-wm-storage-action="${name}"]`)};
}
test('wm_connection_success_does_not_switch_or_upload', async () => {
    const f = fixture(), original = clone(f.route);
    const result = await f.vm.checkConnection(), view = await f.vm.inspect();
    assert.deepEqual(Object.keys(result).sort(), ['backendId', 'limits', 'ok', 'protocol']);
    assert.equal(view.connection, 'connected'); assert.equal(view.mode, 'plugin_only'); assert.deepEqual(f.route, original);
    assert.equal(f.calls.upload, 0); assert.equal(f.calls.routeWrites, 0); assert.equal(f.calls.prepare.length, 0);
    assert.equal(view.lastBackup.state, 'verified'); assert.equal(view.lastRestore.state, 'absent');
});
test('wm_unqualified_host_shows_disabled_migration', async t => {
    const f = fixture({qualified: false}), p = panel(t, f); await p.mounted.ready;
    assert(p.button('preview').disabled); assert(p.button('confirm').disabled);
    assert.match(p.root.textContent, /저장 전환 지원: 사용 불가/);
    const preview = await f.vm.previewMigration('server_only'); assert.equal(preview.canStart, false); assert.equal(f.calls.preview, 0);
});
test('wm_ui_repeated_click_resumes_same_operation: basic cancel and resumed happy flow', async t => {
    const f = fixture(), preview = await f.vm.previewMigration('server_only');
    const input = {operationId: 'basic-ui-operation', previewFingerprint: preview.previewFingerprint};
    await Promise.all([f.vm.confirmMigration(input), f.vm.confirmMigration(input)]);
    assert.deepEqual(f.calls.prepare, ['basic-ui-operation']);
    await f.vm.cancelMigration(input.operationId); assert.equal((await f.vm.inspect()).migration.state, 'interrupted');
    const reopened = UI.createWmStorageViewModel(f.options); assert.equal((await reopened.inspect()).migration.operationId, input.operationId);
    const p = panel(t, {...f, vm: reopened}); await p.mounted.ready; p.button('resume').click();
    await until(() => p.root.querySelector('[data-wm-storage-progress]').dataset.state === 'complete');
    assert.deepEqual(f.calls.resume, ['basic-ui-operation']); assert.deepEqual(f.calls.prepare, ['basic-ui-operation']);
    assert.equal(f.calls.upload, 1); assert.equal(f.calls.routeWrites, 1); assert.equal((await reopened.inspect()).savedSuccessVisible, true);
    assert.equal(p.root.querySelector('[data-wm-storage-success]').hidden, false);
});
test('wm_uncertain_is_never_rendered_as_saved', async () => {
    const f = fixture(), preview = await f.vm.previewMigration('server_only');
    await f.vm.confirmMigration({operationId: 'uncertain-ui', previewFingerprint: preview.previewFingerprint});
    const state = f.records.get('uncertain-ui'); state.state = 'uncertain';
    const view = await f.vm.inspect(); assert.equal(view.savedSuccessVisible, false); assert.equal(view.mode, 'plugin_only');
    const dom = new JSDOM(UI.renderWmStoragePanel(view));
    assert(dom.window.document.querySelector('[data-wm-storage-success]').hidden); assert.match(dom.window.document.body.textContent, /결과 확인 필요/); dom.window.close();
});
test('wm_storage_panel_basic_confirm_progress_and_status', async t => {
    const f = fixture(), p = panel(t, f); await p.mounted.ready;
    p.button('preview').click(); await until(() => !p.button('confirm').disabled);
    assert.equal(f.calls.upload, 0); assert.equal(f.calls.routeWrites, 0);
    assert.match(p.root.querySelector('[data-wm-storage-preview]').textContent, /전체 항목 6개.*추가 공간 60 bytes/);
    p.button('confirm').click(); await until(() => p.root.querySelector('[data-wm-storage-progress]').dataset.state === 'complete');
    assert.equal(p.confirmations(), 1); assert.deepEqual(f.calls.prepare, ['basic-ui-operation']);
    assert.equal((await f.vm.inspect()).mode, 'server_only'); assert.equal(f.calls.upload, 1); assert.equal(f.calls.routeWrites, 1);
    if (process.env.WM_UI_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.WM_UI_EVIDENCE_DIR, {recursive: true});
        fs.writeFileSync(path.join(process.env.WM_UI_EVIDENCE_DIR, 'basic-complete-panel.html'), '<!doctype html><meta charset="utf-8">' + p.root.outerHTML);
        fs.writeFileSync(path.join(process.env.WM_UI_EVIDENCE_DIR, 'basic-action-spies.json'), JSON.stringify(f.calls, null, 2));
    }
});
test('wm_storage_panel_preserves_preset_draft_navigation: assembled default UI smoke', async () => {
    const {loadGui} = require('./libra_management_gui_integration_test.cjs'), {profile} = require('./wm-analysis-preset-test-support.cjs');
    const store = new Map([['LMAI_Config', JSON.stringify({useLLM: true, llm: profile('legacy'), llmPresets: {a: profile('A'), b: profile('B')}, llmDefaultPreset: 'a'})]]);
    const f = await loadGui({observeCommonAnalysis: true, nativeInitialization: true, store, args: {use_llm: 'true'}});
    try {
        f.overlay.querySelector('[data-tab="settings"]').click();
        const select = f.overlay.querySelector('#sllmpresetselect'); select.value = 'b'; select.dispatchEvent(new f.w.Event('change', {bubbles: true}));
        const draft = f.overlay.querySelector('#sllmpm'); draft.value = 'B-edited'; draft.dispatchEvent(new f.w.Event('input', {bubbles: true}));
        const root = f.overlay.querySelector('[data-wm-storage-panel]'); assert(root); assert.equal(root.querySelector('[data-wm-storage-action="preview"]').disabled,false);assert.match(root.textContent,/수동 복사·검증·전환/);
        const target = root.querySelector('[data-wm-storage-target]'); target.value = 'server_only'; target.dispatchEvent(new f.w.Event('change', {bubbles: true}));
        await sleep(650); assert.equal(f.calls.writes.filter(row => row.key === 'LMAI_Config').length, 0);
        assert.equal(draft.value, 'B-edited'); assert.match(root.querySelector('[data-wm-storage-mode]').textContent, /플러그인에만 저장/);
        f.overlay.querySelector('#xbtn').click(); assert(f.overlay.querySelector('#common-ai-unsaved-dialog'));
        f.overlay.querySelector('#common-ai-unsaved-cancel').click(); assert(f.overlay.isConnected); assert.equal(draft.value, 'B-edited');
        if (process.env.WM_UI_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.WM_UI_EVIDENCE_DIR, 'assembled-default-settings.html'), '<!doctype html><meta charset="utf-8">' + f.overlay.outerHTML);
    } finally {f.close();}
});
