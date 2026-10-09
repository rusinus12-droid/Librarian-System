'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.equal(source.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1], source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1], 'GUI runtime and install versions agree');
assert.ok(source.includes("guiTab: 'overview'"), 'overview is the runtime default');
assert.ok(source.includes("return FLASHBACK_GUI_TAB_IDS.includes(candidate) ? candidate : 'overview';"), 'unknown tabs fall back to overview');
assert.ok(!source.includes("Runtime.guiTab || 'provider'"), 'legacy provider fallback is removed');

const expectedTabs = ['overview', 'import', 'source-edits', 'restore', 'storage', 'worldline', 'provider', 'server', 'activity', 'advanced'];
let previousTabIndex = -1;
for (const tab of expectedTabs) {
  const tabId = `id="tab-${tab}"`;
  const panelId = `id="panel-${tab}"`;
  const tabIndex = source.indexOf(tabId);
  assert.ok(tabIndex > previousTabIndex, `${tab} follows the intended navigation order`);
  previousTabIndex = tabIndex;
  assert.ok(source.includes(`aria-controls="panel-${tab}"`), `${tab} controls its panel`);
  assert.ok(source.includes(panelId), `${tab} panel exists`);
  assert.ok(source.includes(`aria-labelledby="tab-${tab}"`), `${tab} panel points back to the tab`);
}

let previousGroupIndex = -1;
for (const label of ['상태', '기억', '연결', '설정 및 진단']) {
  const index = source.indexOf(`<div class="nav-group-label">${label}</div>`);
  assert.ok(index > previousGroupIndex, `${label} sidebar group follows the intended order`);
  previousGroupIndex = index;
}

assert.equal((source.match(/id="lastRecallPanel"/g) || []).length, 1, 'last recall DOM id is unique');
const overviewSlice = source.slice(source.indexOf('const buildOverviewTab ='), source.indexOf('const buildProviderTab ='));
assert.ok(overviewSlice.includes('id="lastRecallPanel"'), 'last recall detail belongs to overview');
assert.ok(overviewSlice.includes('<details class="card overview-recall-card" open>'), 'recall contact sheet starts open and remains collapsible');
assert.ok(!overviewSlice.includes('await currentScopeStats('), 'overview first paint does not enumerate storage');
assert.ok(source.includes("setNodeHtml('lastRecallPanel', renderLastRecallPanel("), 'existing recall refresh path remains wired');
assert.ok(source.includes("detail: text(item.record.text || '')"), 'last recall state retains the selected record text for inspection');
assert.ok(source.includes('<details class="recall-card-item" id="fb-recall-frame-${index}">'), 'each recalled memory is independently expandable');
assert.ok(source.includes('.recall-card-detail{border-top:1px solid var(--border)'), 'expanded recall text has a dedicated wrapping detail region');
assert.ok(source.includes('.overview-recall-card .last-recall-panel{max-height:none;overflow:visible'), 'overview recall content is not trapped in a nested fixed-height scroller');

assert.equal((source.match(/<div data-portable-backup-host="flashback_memory"/g) || []).length, 1, 'Portable Memory host remains unique');
const importSlice = source.slice(source.indexOf('const buildImportTab ='), source.indexOf('const buildActivityLogTab ='));
const restoreSlice=source.slice(source.indexOf('const buildRestoreTab ='),source.indexOf('const buildImportTab ='));
assert.ok(restoreSlice.includes('data-portable-backup-host="flashback_memory"'),'Portable Memory belongs to its independent restore panel');
assert.ok(!importSlice.includes('data-portable-backup-host="flashback_memory"'),'maintenance no longer owns restore');
const backupHandlerSlice = source.slice(source.indexOf("getGuiNode('overviewBackupBtn')"), source.indexOf("getGuiNode('overviewEmbedTestBtn')"));
assert.ok(backupHandlerSlice.includes("setActiveGuiTab('restore')"), 'overview backup navigates to restore');
assert.ok(backupHandlerSlice.includes("target?.focus?.()"), 'overview backup focuses the existing control');
assert.ok(!backupHandlerSlice.includes("target?.click?.()"), 'overview backup does not create an unsolicited download');

assert.ok(source.includes('.sidebar{border-right:0;border-bottom:1px solid var(--border);flex-direction:row;overflow-x:auto}'), 'mobile navigation scrolls horizontally');
assert.ok(source.includes('.nav-group{display:contents}'), 'mobile navigation flattens grouped wrappers');
assert.ok(!source.includes('.scope-chat{display:none}'), 'mobile keeps the current chat visible');
assert.ok(source.includes('id="currentChatText"'), 'chat title has its own durable update target');
assert.ok(source.includes('--text2:#b0bad0;--text3:#7d8aa6;--accent:#7ea5f8'), 'readable secondary, tertiary, and accent tokens remain pinned');
assert.ok(source.includes(':focus-visible{outline:2px solid var(--accent)'), 'keyboard focus remains visibly outlined');

for (const id of ['topMoreBtn', 'topMoreMenu', 'topMenuRefreshBtn', 'topMenuDebugBtn', 'topMenuCloseBtn']) {
  assert.equal((source.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} is unique`);
}
assert.ok(source.includes('aria-haspopup="menu"'), 'mobile more button exposes menu semantics');
assert.ok(source.includes('aria-expanded="false"'), 'mobile more button exposes expansion state');
assert.ok(source.includes('aria-controls="topMoreMenu"'), 'mobile more button points to its menu');
assert.ok(source.includes("getGuiNode('topMenuRefreshBtn')?.addEventListener('click', refreshAction)"), 'mobile menu refresh delegates to the canonical action');
assert.ok(source.includes("getGuiNode('topMenuDebugBtn')?.addEventListener('click', debugExportAction)"), 'mobile menu debug delegates to the canonical action');
assert.ok(source.includes("getGuiNode('topMenuCloseBtn')?.addEventListener('click', closeAction)"), 'mobile menu close delegates to the canonical action');
assert.ok(source.includes("getGuiNode('topMoreBtn')?.getAttribute?.('aria-expanded') === 'true'"), 'Escape closes the mobile menu before the GUI');

const buildUiSlice = source.slice(source.indexOf('const buildUiHtml = async'), source.indexOf('const guiDialog ='));
assert.ok(!buildUiSlice.includes('await currentScopeStats('), 'GUI first paint remains cache/placeholder based');
assert.ok(buildUiSlice.includes('Runtime.guiCurrentStatsCache?.value'), 'GUI first paint retains cached summary support');
assert.ok(source.includes('recall.evidenceBudgetPlan?.actualChars'), 'overview uses actual injected character evidence');
assert.ok(source.includes('기본 저장 상태에서 이상 없음'), 'health copy is scoped to the loaded storage state');
assert.ok(source.includes('전체 무결성은 ‘상태만 진단’에서 확인할 수 있습니다.'), 'health copy directs users to the real diagnostic boundary');

const storageSlice = source.slice(source.indexOf('const buildStorageTab ='), source.indexOf('const buildServerConnectionTab ='));
assert.ok(storageSlice.includes('id="openResponseRecordsBtn"'), 'Storage exposes a direct response-record entry point');
assert.ok(storageSlice.includes('data-open-manual-editor="response"'), 'Storage entry targets the supported response editor');
assert.ok(source.includes('응답 원문 목록 열기'), 'the empty manual editor has its own recovery action');
assert.ok(!source.includes('왼쪽 분포 카테고리를 누르면'), 'the stale nonexistent-navigation instruction is removed');
assert.ok(source.includes('type !== MANUAL_EDITOR_SOURCE_TYPE'), 'derived count rows are rendered without edit affordances');
assert.ok(source.includes("normalizedSourceType !== MANUAL_EDITOR_SOURCE_TYPE"), 'unsupported manual-editor source types fail closed');
assert.ok(source.includes("[{ type: MANUAL_EDITOR_SOURCE_TYPE, label: sourceTypeLabel(MANUAL_EDITOR_SOURCE_TYPE)"), 'empty editor fallback exposes only the supported response category');
assert.ok(source.includes("button[data-open-manual-editor],button[data-edit-source-type],button[data-manual-source-type]"), 'direct and overview editor entry points share one delegated handler');

const inspectIndex = importSlice.indexOf('id="maintenanceInspectBtn" class="btn btn-primary"');
const autoIndex = importSlice.indexOf('id="maintenanceAutoBtn" class="btn"');
assert.ok(inspectIndex >= 0 && autoIndex > inspectIndex, 'non-mutating diagnosis is the primary maintenance action');

for (const id of [
  'saveSettingsBtn', 'clearEmbeddingKeyBtn', 'testEmbedBtn', 'refreshOllamaModelsBtn',
  'multilingualProbeBtn', 'cancelMultilingualProbeBtn', 'multilingualProbeMaintenanceBtn',
  'maintenanceInspectBtn', 'maintenanceAutoBtn', 'maintenanceRunBtn',
  'openResponseRecordsBtn', 'refreshStorageBtn', 'repairScopeRegistryBtn', 'deleteSelectedScopesBtn',
  'deleteCurrentScopeBtn', 'clearActivityLogBtn', 'saveAdvancedSettingsBtn'
]) {
  assert.ok(source.includes(`id="${id}"`), `existing handler target ${id} remains present`);
}

assert.equal((source.match(/id="multilingualProbeStatus"/g) || []).length, 1, 'multilingual probe status is unique');
assert.ok(source.includes('role="status" aria-live="polite"'), 'probe updates use a live status region');
assert.ok(source.includes('사용자 대화는 사용하지 않습니다.'), 'probe privacy boundary is visible');
assert.ok(source.includes('class="multilingual-probe-table-wrap"'), 'direction matrix has its own overflow boundary');
assert.ok(source.includes('.multilingual-probe-table-wrap{max-width:100%;margin-top:8px;overflow-x:auto'), 'matrix scroll does not widen the provider page');
assert.ok(source.includes("getGuiNode('cancelMultilingualProbeBtn')?.addEventListener('click'"), 'probe cancellation is wired');
assert.ok(source.includes("Runtime.multilingualEmbeddingProbeController?.abort('user_cancelled')"), 'cancel action aborts the active provider call');
assert.ok(source.includes("getGuiNode('multilingualProbeMaintenanceBtn')?.addEventListener('click'"), 'profile mismatch guidance links to maintenance');
assert.ok(source.includes("mode.value = 'reembed'"), 'maintenance link selects vector-only refresh without auto-running it');
assert.ok(source.includes("'cancelMultilingualProbeBtn'"), 'the cancel button remains available while GUI busy state is active');
const multilingualCardSlice = source.slice(source.indexOf('const buildMultilingualProbeCard ='), source.indexOf('const buildProviderTab ='));
assert.ok(multilingualCardSlice.includes('다국어 리콜 검증'), 'provider GUI contains a dedicated multilingual verification card');
assert.ok(!multilingualCardSlice.includes('runMultilingualEmbeddingProbe('), 'rendering the card never starts a provider request');
const multilingualHandlerSlice = source.slice(
  source.indexOf("getGuiNode('multilingualProbeBtn')?.addEventListener('click'"),
  source.indexOf("getGuiNode('maintenanceInspectBtn')?.addEventListener('click'")
);
assert.ok(multilingualHandlerSlice.includes('if (probe.verified === true)'), 'memory profile inspection runs only after a verified probe');
assert.ok(!multilingualHandlerSlice.includes('progressivelyReembedRecords('), 'probe completion never starts re-embedding automatically');

process.stdout.write('flashback_gui_ux_contract_test: PASS\n');
