'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'RETRACE.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const metadataVersion=source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1]; assert.ok(metadataVersion, 'plugin has valid version metadata');
assert.ok(source.includes("const PLUGIN_VERSION = '"+metadataVersion+"';"), 'runtime version matches metadata');
assert.ok(source.includes("activeTab: 'overview'"), 'overview is the runtime default');
assert.ok(source.includes("RETRACE_GUI_TAB_IDS.includes(text(value).trim()) ? text(value).trim() : 'overview'"), 'unknown tabs fail safely to overview');

const expectedTabs = ['overview', 'session', 'serverdata', 'serverconnection', 'diagnostics'];
let previousTabIndex = -1;
for (const tab of expectedTabs) {
  const tabIndex = source.indexOf(`id="tab-${tab}"`);
  assert.ok(tabIndex > previousTabIndex, `${tab} follows the intended navigation order`);
  previousTabIndex = tabIndex;
  assert.ok(source.includes(`role="tab" aria-controls="panel-${tab}" data-tab="${tab}"`), `${tab} exposes tab semantics`);
  assert.ok(source.includes(`id="panel-${tab}" class="panel" role="tabpanel" aria-labelledby="tab-${tab}" data-panel="${tab}"`), `${tab} panel points back to its tab`);
}

let previousGroupIndex = -1;
for (const label of ['상태', '연속성', '서버', '진단']) {
  const index = source.indexOf(`<div class="nav-group-label">${label}</div>`);
  assert.ok(index > previousGroupIndex, `${label} sidebar group follows the intended order`);
  previousGroupIndex = index;
}

assert.ok(source.includes('const setActiveRetraceTab = (tabValue, options = {}) =>'), 'persistent tab switcher exists');
assert.ok(source.includes("button.setAttribute('aria-selected', active ? 'true' : 'false')"), 'tab selection is exposed to assistive technology');
assert.ok(source.includes('button.tabIndex = active ? 0 : -1'), 'roving tab index is implemented');
assert.ok(source.includes('panel.hidden = !active'), 'inactive panels use native hidden semantics');
for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
  assert.ok(source.includes(`'${key}'`), `${key} keyboard navigation exists`);
}

const bindStart = source.indexOf('const bindUi = () =>');
const bindEnd = source.indexOf('const ensureRoot = () =>', bindStart);
assert.ok(bindStart >= 0 && bindEnd > bindStart, 'UI binding region exists');
const bindSlice = source.slice(bindStart, bindEnd);
assert.ok(bindSlice.includes("const tab = setActiveRetraceTab(button.getAttribute('data-tab'))"), 'tab click uses the persistent switcher');
assert.ok(!bindSlice.includes('renderShell();'), 'tab click never destroys and rebuilds the shell');

const overviewStart = source.indexOf('const refreshOverview = async () =>');
const overviewEnd = source.indexOf('const renderDiagnosticsPanel = () =>', overviewStart);
assert.ok(overviewStart >= 0 && overviewEnd > overviewStart, 'overview refresh region exists');
const overviewSlice = source.slice(overviewStart, overviewEnd);
assert.ok(overviewSlice.includes('const token = ++Runtime.overviewRefreshToken'), 'overview invalidates stale asynchronous responses');
assert.ok(overviewSlice.includes('inspectTransition()'), 'overview uses the canonical transition inspection');
assert.ok(overviewSlice.includes('refreshMemorySuiteOwnerStorageDashboard()'), 'overview uses real Owner storage status');
assert.ok(overviewSlice.includes('inspectCompatibilitySuite(preview, { timeoutMs: 3200 })'), 'overview uses the canonical compatibility suite');
assert.ok(!overviewSlice.includes('includeServerData: true'), 'overview never triggers the full server inventory scan');

assert.ok(source.includes("MEMORY_SUITE_OWNER_STATUS_ORDER = Object.freeze(['flashback', 'hayaku', 'libra', 'lia'])"), 'all four memory storage owners remain in the real dashboard');
assert.ok(source.includes('RE:TRACE는 저장 모드를 소유하거나 변경하지 않습니다.'), 'read-only storage ownership boundary remains visible');
assert.ok(!source.includes('data-tab="lia"'), 'LIA content viewer is not invented');
assert.ok(!source.includes('data-tab="provider"'), 'retired provider UI remains absent');
assert.ok(source.includes('서버 데이터 전체 스캔은 ‘서버 데이터 관리’ 탭을 사용자가 열었을 때만 수행합니다.'), 'diagnostics explains the explicit server scan boundary');
assert.ok(source.includes('자격 증명을 제거하고, 대화·페르소나·스코프 식별자는 해시'), 'privacy-safe export boundary is visible');

assert.ok(source.includes('@media(max-width:980px)'), 'responsive workspace breakpoint exists');
assert.ok(source.includes('.side{grid-row:2;display:flex;flex-direction:row'), 'mobile navigation becomes horizontal');
assert.ok(source.includes('.nav-group{display:contents}'), 'mobile navigation preserves grouped tab order');
assert.ok(source.includes('.nav>span:not(.ic){display:inline}'), 'mobile navigation keeps labels visible');
assert.ok(source.includes('.btn:focus-visible,.nav:focus-visible,.overview-action:focus-visible'), 'keyboard focus is visibly outlined');

for (const id of [
  'refreshTransition', 'createSession',
  'refreshServerData', 'serverDataBody', 'retraceMemorySuiteServerConnectionPanel',
  'exportRetraceDebug', 'closeBridge'
]) {
  assert.ok(source.includes(`id="${id}"`), `existing handler target ${id} remains present`);
}

process.stdout.write('retrace_gui_ux_contract_test: PASS\n');

for(const owner of ['libra','flashback','hayaku']){assert.ok(!source.includes('id="tab-'+owner+'"'));assert.ok(!source.includes('id="panel-'+owner+'"'));}
