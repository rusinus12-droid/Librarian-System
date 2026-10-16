'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const mockup = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'gui-redesign', 'hayaku.html'), 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));

const routes = ['overview', 'packets', 'recovery', 'server', 'settings', 'logs'];
const routeIds = source.match(/const HAYAKU_VIEWER_TAB_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || '';
assert.deepEqual([...routeIds.matchAll(/'([^']+)'/g)].map(match => match[1]), routes,
  'the product must expose the approved six mockup destinations; Worldline is a Packets view');
assert.match(source, /const nav = \(id,label,short,icon,aria\) => `.*data-hayaku-viewer-tab="\$\{id\.toLowerCase\(\)\}".*role="tab"/,
  'the canonical sidebar item factory must bind route identity and accessible state');
for (const [id, label] of [['Overview', '연속성 관제'], ['Packets', '패킷 · 세계선'], ['Recovery', '구간 점검 · 복구'], ['Server', '서버 연결'], ['Settings', '설정'], ['Logs', '작동 기록']]) {
  assert.ok(source.includes(`nav('${id}','${label}'`), `missing canonical ${id} destination`);
  assert.ok(source.includes(`data-hayaku-viewer-panel="${id.toLowerCase()}"`), `missing ${id} destination panel`);
}
assert.ok(source.includes('<nav class="sidebar" aria-label="HAYAKU 메뉴">'), 'desktop navigation must use the mockup sidebar');
assert.ok(source.includes('<nav class="tabbar" aria-label="HAYAKU 하단 메뉴">'), 'narrow navigation must use the mockup bottom bar');
assert.ok(source.includes('data-more-list'), 'the remaining mobile destinations must use the mockup more sheet');
for (const landmark of ['class="app"', 'class="topbar"', 'class="page-body"', 'class="page-head"']) {
  assert.ok(source.includes(landmark), `missing canonical shell landmark ${landmark}`);
  assert.ok(mockup.includes(landmark), `reference mockup lacks ${landmark}`);
}

for (const tab of routes) {
  assert.ok(source.includes(`data-hayaku-viewer-panel="${tab}"`), `missing ${tab} viewer panel`);
}

assert.ok(source.includes('data-hayaku-viewer-tab="${id.toLowerCase()}"'), 'sidebar destinations must bind the shared route state');
assert.ok(source.includes("node.setAttribute('aria-current', 'page')"), 'active sidebar destination must expose the current page');
assert.ok(source.includes("node.setAttribute('tabindex', selected ? '0' : '-1')"), 'active sidebar destination must use roving tabindex');

for (const id of [
  'hayakuOverviewHealth',
  'hayakuOverviewPackets',
  'hayakuOverviewCoverage',
  'hayakuOverviewJournal',
  'hayakuOverviewRecallRows',
  'hayakuOverviewActivity'
]) assert.ok(source.includes(`id="${id}"`), `missing overview field ${id}`);
assert.ok(source.includes('const viewerRenderOverview = () => {'), 'overview must render live runtime data');

assert.ok(source.includes('class="pk-layout"'), 'packet ledger must use the canonical master-detail layout');
assert.ok(source.includes('id="hayakuViewerRecords" class="list pk-list"'), 'packet list remains the existing event boundary');
assert.ok(source.includes('id="hayakuViewerRecordDetail"'), 'packet inspector is required');
assert.ok(source.includes('data-hayaku-record-select='), 'packet rows must select an inspector record');
for (const detail of ['summary', 'axes', 'binding', 'json']) {
  assert.ok(source.includes(`data-hayaku-record-detail-tab="${detail}"`), `missing packet detail tab ${detail}`);
}
assert.ok(!source.includes('data-hayaku-record-detail-tab="evidence"'), 'provenance belongs to canonical Binding; do not add a fifth detail tab');
assert.ok(source.includes('data-hayaku-regenerate-record='), 'record regeneration action must remain available');
assert.ok(source.includes('data-hayaku-select-variant='), 'replacement variant action must remain available');

assert.ok(source.includes('id="hayakuWorldlineTimeline"'), 'worldline timeline is required');
assert.ok(source.includes('id="hayakuWorldlineDetail"'), 'worldline inspector is required');
assert.ok(source.includes('const viewerRenderWorldlineInner = () => {') && source.includes('() => viewerRenderWorldlineInner(...args)'), 'worldline must render from the loaded ledger');
assert.ok(source.includes("const unboundCount = records.filter(record => record?.recordState === 'unbound').length;"), 'worldline must count binding-pending records from the real ledger');
assert.ok(source.includes('`결속 대기 ${unboundCount.toLocaleString()}개`') && source.includes("'현재 세계선'"), 'worldline status must distinguish pending binding from the active board');
assert.ok(source.includes("state === 'unbound' ? 'pending'"), 'unbound records must render as pending, never active worldline nodes');
assert.ok(source.includes('data-packet-view="worldline"'), 'Worldline remains an internal Packets view, not another destination');
assert.ok(mockup.includes('연속성 노선도'), 'approved mockup reference must include the canonical overview route card');
assert.ok(source.includes('data-hayaku-open-record='), 'worldline selection must link to packet detail');

assert.ok(source.includes('id="st-after"') && source.includes('hayaku_after_request_auto_repair'), 'afterRequest repair setting must remain bound to the canonical control');
assert.ok(!source.includes('id="st-bg"') && !source.includes('id="auto-bg"'), 'retired background repair has no GUI control; afterRequest is the only automatic stage');
assert.ok(source.includes("{ argument: 'risuai_aux_allow_plugins', type: 'boolean' }"), 'the RisuAI-owned auxiliary model permission must remain in the actual settings schema');
assert.ok(source.includes("mode: 'otherAx'"), 'auxiliary call test must use RisuAI Other Ax');
assert.ok(source.includes('writesPacketLedger: false'), 'auxiliary call test must not write the packet ledger');
assert.ok(source.includes('const showIndependentRecoveryConfirmation = async confirmation => {'), 'recovery confirmation must have an independent dialog path');
assert.ok(source.includes('overlay.id = RECOVERY_CONFIRMATION_OVERLAY_ID;'), 'independent recovery confirmation must use a dedicated overlay id');
assert.ok(source.includes("mode: 'independent'"), 'independent recovery confirmation mode must be tracked');
assert.ok(source.includes("dialog.setAttribute('aria-modal', 'true')") && source.includes("dialog.setAttribute('aria-labelledby', 'hayakuRecoveryConfirmationTitle')"), 'independent recovery confirmation must use the accessible dialog structure');
const recoveryPanelStart = source.indexOf('const recoveryPage = `');
const serverPanelStart = source.indexOf('const serverPage = `', recoveryPanelStart);
const settingsMarkupStart = source.indexOf('const HAYAKU_MOCKUP_SETTINGS_PAGE =');
const settingsMarkupEnd = source.indexOf('const HAYAKU_GUI_SETTING_SPECS', settingsMarkupStart);
const logsPanelStart = source.indexOf('const logsPage = `');
const logsPanelEnd = source.indexOf('`;', logsPanelStart);
const logsPanel = source.slice(logsPanelStart, logsPanelEnd);
const recoveryStatusIndex = logsPanel.indexOf('id="hayakuNativeRecoveryJson"');
const auxiliaryPermissionIndex = source.slice(settingsMarkupStart, settingsMarkupEnd).indexOf('risuai_aux_allow_plugins');
assert.ok(recoveryPanelStart >= 0 && serverPanelStart > recoveryPanelStart, 'recovery panel boundary must exist');
assert.ok(serverPanelStart > recoveryPanelStart, 'recovery/server destination boundaries must exist');
assert.ok(settingsMarkupStart > 0 && settingsMarkupEnd > settingsMarkupStart, 'settings must use the separate canonical mockup page body');
assert.ok(logsPanelStart >= 0 && logsPanelEnd > logsPanelStart, 'Operation Log panel boundary must exist');
assert.ok(recoveryStatusIndex > 0 && recoveryStatusIndex < logsPanel.length,
  'Recovery Journal diagnostics must be rendered in the canonical Operation Log destination');
assert.ok(auxiliaryPermissionIndex >= 0,
  'RisuAI auxiliary-model permission must remain in Settings ARG schema');
assert.ok(!source.slice(recoveryPanelStart, serverPanelStart).includes('id="hayakuNativeRecoveryJson"'),
  'large recovery diagnostics JSON must not remain in the primary recovery workflow');
assert.match(logsPanel, /id="hayakuViewerOperationLog"[\s\S]*<details class="fold">[\s\S]*<summary>복구 진단 JSON<\/summary>[\s\S]*id="hayakuNativeRecoveryJson"/,
  'recovery diagnostics must be a collapsed canonical fold below the Operation Log list');
assert.ok(!logsPanel.includes('<details class="fold" open'),
  'recovery diagnostics disclosure must be collapsed by default');
assert.ok(source.includes('data-portable-backup-host="hayaku_locator_continuity"'), 'Portable Memory host must be preserved');
assert.ok(source.includes('id="hayakuSettingsForm"'), 'transactional settings form must be preserved');
assert.ok(source.includes('const viewerRenderSettingSources = rawSnapshot => {'), 'settings must render raw ARG source badges');
assert.ok(source.includes('기본값 적용'), 'blank raw arguments must be identified as defaults');
assert.ok(source.includes('명시값 · GUI와 플러그인 argument 화면이 같은 ARG 저장소를 사용합니다.'), 'stored raw arguments must be identified as explicit shared ARG values');
assert.ok(source.includes('id="hayakuMemorySuiteServerConnectionPanel"'), 'shared Storage owner panel must be preserved');
assert.ok(source.includes("title: 'HAYAKU · 저장 및 연산'"), 'Storage panel must own the derived Compute policy');
assert.ok(source.includes('computeBridge: MemorySuiteHayakuComputeBridge'), 'integrated Storage panel must receive the Compute bridge');
assert.ok(!source.includes('id="hayakuMemorySuiteComputeSettingsPanel"'), 'separate Compute panel must be retired');

const viewerSetTabStart = source.indexOf('const viewerSetTab = tab => {');
const viewerSetTabEnd = source.indexOf('const viewerEnsureRoot = () => {', viewerSetTabStart);
assert.notEqual(viewerSetTabStart, -1, 'viewerSetTab must exist');
assert.notEqual(viewerSetTabEnd, -1, 'viewerSetTab boundary must exist');
const viewerSetTab = source.slice(viewerSetTabStart, viewerSetTabEnd);
assert.match(viewerSetTab, /node\.hidden = !selected;[\s\S]*viewerQueueActiveTabRender\(active\);/,
  'panel visibility must commit before active-panel hydration is deferred');
assert.doesNotMatch(viewerSetTab, /viewerRender(?:Overview|Recall|OperationLog|Records|Worldline)\(/,
  'tab click must not synchronously build a heavy panel');
assert.match(source, /const viewerQueueActiveTabRender = activeValue => \{[\s\S]*setTimeout\(\(\) => \{[\s\S]*viewerRenderActiveTab\(active\);/,
  'active-panel hydration must run in a coalesced later task');
assert.match(source, /active === 'logs'[\s\S]*viewerRenderOperationLog\(\);[\s\S]*viewerRenderDebugExportText\(\);[\s\S]*viewerRenderNativeRecovery\(\);/,
  'opening Operation Log must refresh the moved recovery diagnostic snapshot');
assert.match(source, /root\.dataset\.hayakuViewerMounted = '1';/,
  'the mounted viewer shell must be marked for reuse');
assert.match(source, /root\.dataset\?\.hayakuViewerMounted === '1'[\s\S]*return root;/,
  'reopening HAYAKU must reuse its existing shell');
assert.doesNotMatch(source, /\.hayaku-viewer\.is-busy\{[^}]*pointer-events:none/,
  'background refresh must not disable the whole viewer');
assert.match(source, /void refreshLedgerViewer\(\)\.catch/,
  'durable ledger hydration must not block the first paint');

console.log('PASS hayaku_gui_ux_contract_test');
