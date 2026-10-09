'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const prototype = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'HAYAKU_GUI_UX_Prototype.html'), 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));

for (const tab of ['overview', 'packets', 'worldline', 'recovery', 'server', 'settings', 'logs']) {
  assert.ok(source.includes(`data-hayaku-viewer-tab="${tab}"`), `missing ${tab} navigation tab`);
  assert.ok(source.includes(`data-hayaku-viewer-panel="${tab}"`), `missing ${tab} viewer panel`);
}

assert.ok(source.includes('role="tablist" aria-label="HAYAKU 화면"'), 'top-level navigation must expose tab semantics');
assert.ok(source.includes("['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']"), 'top-level tabs need keyboard navigation');
assert.ok(source.includes("node.setAttribute('aria-selected', selected ? 'true' : 'false')"), 'active tab must update aria-selected');
assert.ok(source.includes("node.setAttribute('tabindex', selected ? '0' : '-1')"), 'active tab must use roving tabindex');

for (const id of [
  'hayakuOverviewHealth',
  'hayakuOverviewPackets',
  'hayakuOverviewCoverage',
  'hayakuOverviewJournal',
  'hayakuOverviewRecallRows',
  'hayakuOverviewActivity'
]) assert.ok(source.includes(`id="${id}"`), `missing overview field ${id}`);
assert.ok(source.includes('const viewerRenderOverview = () => {'), 'overview must render live runtime data');

assert.ok(source.includes('class="hv-ledger-layout"'), 'packet ledger must use master-detail layout');
assert.ok(source.includes('id="hayakuViewerRecords" class="hv-records"'), 'packet list remains the existing event boundary');
assert.ok(source.includes('id="hayakuViewerRecordDetail"'), 'packet inspector is required');
assert.ok(source.includes('data-hayaku-record-select='), 'packet rows must select an inspector record');
for (const detail of ['summary', 'axes', 'evidence', 'binding', 'json']) {
  assert.ok(source.includes(`data-hayaku-record-detail-tab="${detail}"`), `missing packet detail tab ${detail}`);
}
assert.ok(source.includes('data-hayaku-regenerate-record='), 'record regeneration action must remain available');
assert.ok(source.includes('data-hayaku-select-variant='), 'replacement variant action must remain available');

assert.ok(source.includes('id="hayakuWorldlineTimeline"'), 'worldline timeline is required');
assert.ok(source.includes('id="hayakuWorldlineDetail"'), 'worldline inspector is required');
assert.ok(source.includes('const viewerRenderWorldlineInner = () => {') && source.includes('() => viewerRenderWorldlineInner(...args)'), 'worldline must render from the loaded ledger');
assert.ok(source.includes("const unbound = records.filter(record => record?.recordState === 'unbound');"), 'overview must distinguish binding-pending packets from active worldline nodes');
assert.ok(source.includes('id="hayakuWorldlineStateBadge"'), 'worldline must expose a dynamic active or pending badge');
assert.ok(source.includes('미결속은 대기 상태로 표시'), 'worldline copy must not call unbound packet rows active worldline turns');
assert.ok(!source.includes('현재 패킷 결속을 원장 기준으로 표시합니다.'), 'worldline must not retain the redundant status banner');
assert.ok(!source.includes('<button class="hv-btn" data-hayaku-viewer-goto="recovery" type="button">복구 상태</button>'), 'worldline must not retain the redundant recovery shortcut');
assert.ok(!source.includes('현재 채팅의 패킷 coverage, 세계선, Recovery Journal과 최근 회상을 한눈에 확인합니다.'), 'overview must not retain the redundant coverage description');
assert.ok(!source.includes('>패킷 원장 열기</button>'), 'overview must not retain the packet-ledger shortcut');
assert.ok(!source.includes('>세계선 확인</button>'), 'overview must not retain the worldline shortcut');
assert.ok(!prototype.includes('Worldline A가 활성 정본입니다.'), 'prototype must also lead directly into the worldline board');
assert.ok(!prototype.includes('>세계선 확인</button>'), 'prototype overview must not retain the worldline shortcut');
assert.ok(!prototype.includes('class="card worldline-board section-gap"'), 'prototype must not leave banner spacing above the worldline board');
assert.ok(source.includes('data-hayaku-open-record='), 'worldline selection must link to packet detail');

assert.ok(source.includes('id="hayakuAfterRequestAutoRepairToggle"'), 'afterRequest repair control must be preserved');
assert.ok(source.includes('id="hayakuNativeAutoRepairToggle"'), 'background repair control must be preserved');
assert.ok(source.includes('id="testHayakuAuxiliaryModel"'), 'explicit RisuAI auxiliary model call test is required');
assert.ok(source.includes('id="hayakuAuxiliaryProbeResponse"'), 'auxiliary call test must show a session-only response preview');
assert.ok(source.includes("mode: 'otherAx'"), 'auxiliary call test must use RisuAI Other Ax');
assert.ok(source.includes('writesPacketLedger: false'), 'auxiliary call test must not write the packet ledger');
assert.ok(source.includes('const showIndependentRecoveryConfirmation = async confirmation => {'), 'recovery confirmation must have an independent dialog path');
assert.ok(source.includes('overlay.id = RECOVERY_CONFIRMATION_OVERLAY_ID;'), 'independent recovery confirmation must use a dedicated overlay id');
assert.ok(source.includes("mode: 'independent'"), 'independent recovery confirmation mode must be tracked');
assert.ok(prototype.includes('class="modal-layer independent-recovery-confirmation"'), 'prototype must model the independent recovery confirmation layer');
const recoveryPanelStart = source.indexOf('data-hayaku-viewer-panel="recovery"');
const failedRecoveryPanelStart = source.indexOf('data-hayaku-viewer-panel="server"', recoveryPanelStart);
const settingsPanelStart = source.indexOf('data-hayaku-viewer-panel="settings"');
const logsPanelStart = source.indexOf('data-hayaku-viewer-panel="logs"');
const logsPanelEnd = source.indexOf('</main>', logsPanelStart);
const recoveryStatusIndex = source.indexOf('id="hayakuViewerRecoveryStatus"');
const auxiliaryProbeIndex = source.indexOf('id="testHayakuAuxiliaryModel"');
assert.ok(recoveryPanelStart >= 0 && failedRecoveryPanelStart > recoveryPanelStart, 'recovery panel boundary must exist');
assert.ok(settingsPanelStart > failedRecoveryPanelStart, 'settings panel boundary must exist');
assert.ok(logsPanelStart >= 0 && logsPanelEnd > logsPanelStart, 'Operation Log panel boundary must exist');
assert.ok(recoveryStatusIndex > logsPanelStart && recoveryStatusIndex < logsPanelEnd,
  'Recovery Journal status summary must be rendered inside Operation Logs');
assert.ok(!source.slice(recoveryPanelStart, failedRecoveryPanelStart).includes('id="hayakuViewerRecoveryStatus"'),
  'Recovery Journal status summary must not remain in the primary recovery workflow');
assert.ok(auxiliaryProbeIndex > settingsPanelStart && auxiliaryProbeIndex < logsPanelStart,
  'auxiliary model call test must be rendered inside Settings');
assert.ok(!source.slice(recoveryPanelStart, settingsPanelStart).includes('id="testHayakuAuxiliaryModel"'),
  'auxiliary model call test must not remain in the Recovery panel');
assert.ok(!source.slice(recoveryPanelStart, failedRecoveryPanelStart).includes('id="hayakuNativeRecoveryJson"'),
  'large recovery diagnostics JSON must not remain in the primary recovery workflow');
const logsPanel = source.slice(logsPanelStart, logsPanelEnd);
assert.match(logsPanel, /id="hayakuViewerOperationLog"[\s\S]*<details class="hv-recovery-debug hv-log-recovery-debug">[\s\S]*<summary>[\s\S]*복구 진단 JSON[\s\S]*id="hayakuNativeRecoveryJson"/,
  'collapsed recovery diagnostics must be the final block below the Operation Log list');
const prototypeRecoveryPanelStart = prototype.indexOf('id="panel-recovery"');
const prototypeFailedPanelStart = prototype.indexOf('id="panel-failed"');
const prototypeActivityPanelStart = prototype.indexOf('id="panel-activity"');
assert.ok(prototypeRecoveryPanelStart >= 0 && prototypeFailedPanelStart > prototypeRecoveryPanelStart, 'prototype recovery/failed-recovery panel boundary must exist');
assert.ok(!prototype.slice(prototypeRecoveryPanelStart, prototypeFailedPanelStart).includes('activity-recovery-status'),
  'prototype Recovery Journal status summary must not remain in the recovery panel');
assert.ok(prototype.slice(prototypeActivityPanelStart).includes('class="recovery-card activity-recovery-status"'),
  'prototype Recovery Journal status summary must be rendered in Operation Logs');
assert.ok(!prototype.slice(prototypeRecoveryPanelStart, prototypeFailedPanelStart).includes('보조 모델 호출 테스트'),
  'prototype auxiliary model test must not remain in the runtime recovery panel');
const prototypeSettingsPanelStart = prototype.indexOf('id="panel-settings"');
assert.ok(prototypeSettingsPanelStart > prototypeFailedPanelStart && prototypeActivityPanelStart > prototypeSettingsPanelStart, 'prototype settings/activity panel boundary must exist');
assert.ok(prototype.slice(prototypeSettingsPanelStart, prototypeActivityPanelStart).includes('class="recovery-card auxiliary-test-card"'),
  'prototype auxiliary model call test must be rendered inside Settings');
assert.ok(!logsPanel.includes('<details class="hv-recovery-debug hv-log-recovery-debug" open'),
  'recovery diagnostics disclosure must be collapsed by default');
assert.ok(source.includes('data-portable-backup-host="hayaku_locator_continuity"'), 'Portable Memory host must be preserved');
assert.ok(source.includes('id="hayakuSettingsForm"'), 'transactional settings form must be preserved');
assert.ok(source.includes('const viewerRenderSettingSources = rawSnapshot => {'), 'settings must render raw ARG source badges');
assert.ok(source.includes('기본값 적용'), 'blank raw arguments must be identified as defaults');
assert.ok(source.includes('명시값 · ARG 저장소'), 'stored raw arguments must be identified as explicit ARG values');
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
