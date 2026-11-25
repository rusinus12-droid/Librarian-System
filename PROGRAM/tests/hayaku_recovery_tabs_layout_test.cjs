'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');

test('HAYAKU recovery subtabs: 복구·복원 isolates shared cards, 재분석 puts tag filter first and omits full rebuild, Cold Start omits shared cards', () => {
  const recoveryStart = source.indexOf('const recoveryPage = `');
  const scopeStart = source.indexOf('const serverSection = `', recoveryStart);
  assert.ok(recoveryStart >= 0 && scopeStart > recoveryStart, 'recoveryPage slice found');
  const recoveryHtml = source.slice(recoveryStart, scopeStart);

  assert.match(recoveryHtml, /data-subtab="miss"[^>]*data-recovery-view="missing"[^>]*>복구·복원<\/button>/, 'first subtab is labeled 복구·복원');
  assert.doesNotMatch(recoveryHtml, /data-subtab="miss"[^>]*>누락 복구<\/button>/, 'old 누락 복구 tab label removed');

  const missStart = recoveryHtml.indexOf('<section data-recovery-panel="missing"');
  const reanaStart = recoveryHtml.indexOf('<section data-recovery-panel="reanalysis"');
  const coldStart = recoveryHtml.indexOf('<section data-recovery-panel="cold"');
  const tailEnd = recoveryHtml.lastIndexOf('</section>');
  assert.ok(missStart > 0 && reanaStart > missStart && coldStart > reanaStart && tailEnd > coldStart, 'three subpanels appear in order');

  const missPanel = recoveryHtml.slice(missStart, reanaStart);
  const reanaPanel = recoveryHtml.slice(reanaStart, coldStart);
  const afterCold = recoveryHtml.slice(coldStart);

  for (const needle of ['id="hayakuRecoverySettingsLink"', 'data-portable-backup-host="hayaku_locator_continuity"', 'id="hayakuMaintenanceRun"']) {
    assert.ok(missPanel.includes(needle), `${needle} lives inside 복구·복원 panel`);
    assert.ok(!reanaPanel.includes(needle), `${needle} is absent from 재분석 panel`);
    assert.ok(!afterCold.includes(needle), `${needle} does not appear inside or after Cold Start panel`);
  }

  assert.ok(!reanaPanel.includes('id="hayakuRebuildCard"'), '전체 턴 재구성 card is removed from 재분석');
  assert.ok(!reanaPanel.includes('id="runHayakuRebuild"'), '전체 턴 재구성 button is removed from 재분석');

  const tagFilterPos = reanaPanel.indexOf('id="hayakuTagFilterFold"');
  const consentPos = reanaPanel.indexOf('id="hayakuSourceEditConsent"');
  assert.ok(tagFilterPos > 0 && consentPos > tagFilterPos, '원문 태그 필터 appears strictly before 개별 턴 재분석');
  assert.match(reanaPanel.slice(tagFilterPos, consentPos), /<summary>원문 태그 필터<\/summary>/);

  assert.match(
    source,
    /<details class="fold" data-reanalysis-fold open><summary id="hayakuSourceEditConsentTitle">개별 턴 재분석<\/summary>/,
    '개별 턴 재분석 fold is titled accurately and open by default'
  );
  assert.match(
    source,
    /기존 기억을 다시 만들려면 재분석의 개별 턴 재분석을 쓰세요\./,
    'Cold Start guidance references 개별 턴 재분석 instead of 전체 턴 재구성'
  );
});

test('HAYAKU packet page keeps authoring only in list view, removes 원장 JSON, moves 다시 확인, and includes 스코프 정리', () => {
  const packetStart = source.indexOf('const packetPage = `');
  const recoveryStart = source.indexOf('const recoveryPage = `', packetStart);
  assert.ok(packetStart >= 0 && recoveryStart > packetStart, 'packetPage slice found');
  const packetHtml = source.slice(packetStart, recoveryStart);

  assert.ok(!packetHtml.includes('id="exportHayakuViewer"'), '원장 JSON export button is removed');
  assert.ok(!packetHtml.includes('원장 JSON'), '원장 JSON text is removed');

  const actionsStart = packetHtml.indexOf('<div class="page-actions">');
  const listStart = packetHtml.indexOf('<div id="hayakuPacketListView"');
  const worldStart = packetHtml.indexOf('<section id="hayakuPacketWorldlineView"');
  const scopesStart = packetHtml.indexOf('<section id="hayakuPacketScopesView"');
  assert.ok(actionsStart > 0 && listStart > actionsStart && worldStart > listStart && scopesStart > worldStart);

  const actionsHtml = packetHtml.slice(actionsStart, listStart);
  const listHtml = packetHtml.slice(listStart, worldStart);
  const worldHtml = packetHtml.slice(worldStart, scopesStart);
  const scopesHtml = packetHtml.slice(scopesStart);

  assert.ok(actionsHtml.includes('id="refreshHayakuViewer"'), '다시 확인 button sits in page-actions');
  assert.match(actionsHtml, /id="refreshHayakuViewer"[^>]*>[^<]*다시 확인<\/button>/);
  assert.match(actionsHtml, /data-packet-view="list">목록<\/button><button[^>]*data-packet-view="worldline">세계선<\/button><button[^>]*data-packet-view="scopes">스코프 정리<\/button>/);

  const filterStart = listHtml.indexOf('id="hayakuPacketFilterBar"');
  const pkLayoutStart = listHtml.indexOf('<div class="pk-layout"');
  assert.ok(filterStart > 0 && pkLayoutStart > filterStart);
  const filterHtml = listHtml.slice(filterStart, pkLayoutStart);
  assert.ok(!filterHtml.includes('id="refreshHayakuViewer"'), '다시 확인 is removed from filter bar');
  for (const id of ['hayakuViewerState', 'hayakuViewerType', 'hayakuViewerSearch', 'hayakuViewerShowAuditCopies', 'hayakuViewerVisibleCount']) {
    assert.ok(filterHtml.includes(`id="${id}"`), `${id} remains in filter bar`);
  }
  assert.match(filterHtml, /<label class="search grow"[^>]*flex:1 1 260px/);

  assert.ok(listHtml.includes('id="hayakuPacketAuthoring"'), '이번 패킷 작성 lives inside list view');
  assert.ok(!worldHtml.includes('id="hayakuPacketAuthoring"'), '이번 패킷 작성 is excluded from worldline view');
  assert.ok(!scopesHtml.includes('id="hayakuPacketAuthoring"'), '이번 패킷 작성 is excluded from scopes view');

  assert.match(scopesHtml, /<h2 class="card__title">스코프 정리<\/h2>/);
  assert.ok(scopesHtml.includes('id="hayakuScopeDataManagementPanel"'), '스코프 정리 hosts hayakuScopeDataManagementPanel');
  assert.ok(!source.includes('id="hayakuViewerPanelScopes"'), 'standalone Scopes page is removed');
  assert.ok(!source.includes('id="hayakuViewerTabScopes"'), 'standalone Scopes tab is removed');
  assert.ok(!source.includes('스코프 데이터 관리'), 'old 스코프 데이터 관리 label is completely removed');
});

test('HAYAKU recovery sidebar and page title are renamed to 기억 관리', () => {
  assert.ok(source.includes("nav('Recovery','기억 관리'"), 'Recovery sidebar item uses 기억 관리');
  assert.ok(source.includes('<h1 class="page-title">기억 관리</h1>'), 'Recovery page title uses 기억 관리');
  assert.ok(!source.includes('구간 점검 · 복구'), 'old 구간 점검 · 복구 label is completely removed');
});

test('HAYAKU server connection and status/logs live under Settings subtabs and are removed from sidebar', () => {
  const routeIds = source.match(/const HAYAKU_VIEWER_TAB_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.deepEqual([...routeIds.matchAll(/'([^']+)'/g)].map(m => m[1]), ['overview', 'packets', 'recovery', 'settings']);
  assert.ok(!source.includes("nav('Server'"), 'Server sidebar item is removed');
  assert.ok(!source.includes("nav('Logs'"), 'Logs sidebar item is removed');

  const stNavStart = source.indexOf('<div class="st-nav" role="tablist" data-subtabs="st">');
  const stNavEnd = source.indexOf('</div>', stNavStart);
  assert.ok(stNavStart >= 0 && stNavEnd > stNavStart);
  const stNav = source.slice(stNavStart, stNavEnd);
  assert.match(stNav, /data-subtab="server"[^>]*data-hayaku-settings-section-button="server"><b>서버 연결<\/b>/);
  assert.match(stNav, /data-subtab="logs"[^>]*data-hayaku-settings-section-button="logs"><b>디버그 및 로그<\/b>/);

  const serverIdx = source.indexOf('const serverSection = `');
  const logsIdx = source.indexOf('const logsSection = `');
  const renderIdx = source.indexOf("HAYAKU_MOCKUP_SETTINGS_PAGE.replace('<!--HAYAKU_SETTINGS_AUX_SECTIONS-->'");
  assert.ok(serverIdx >= 0 && logsIdx > serverIdx && renderIdx > logsIdx, 'serverSection and logsSection inject into settingsPage');
  const serverHtml = source.slice(serverIdx, logsIdx);
  const logsHtml = source.slice(logsIdx, renderIdx);

  assert.match(serverHtml, /id="hayakuViewerPanelServer"[^>]*data-subpanel="server"[^>]*data-group="st"[^>]*data-hayaku-settings-section="server"[^>]*data-no-track/);
  assert.ok(serverHtml.includes('id="hayakuMemorySuiteServerConnectionPanel"'));
  assert.match(logsHtml, /id="hayakuViewerPanelLogs"[^>]*data-subpanel="logs"[^>]*data-group="st"[^>]*data-hayaku-settings-section="logs"[^>]*data-no-track/);
  for (const needle of ['data-status-view="status"', 'data-status-view="log"', 'id="hayakuViewerOperationLog"', 'id="hayakuNativeRecoveryJson"', 'id="hayakuViewerDebugExportPanel"']) {
    assert.ok(logsHtml.includes(needle), `디버그 및 로그 includes ${needle}`);
  }

  const setTabStart = source.indexOf('const viewerSetTab = tab => {');
  const setTabEnd = source.indexOf('const viewerEnsureRoot = () => {', setTabStart);
  const setTabBody = source.slice(setTabStart, setTabEnd);
  assert.match(setTabBody, /isSettingsSub = tab === 'server' \|\| tab === 'logs'/);
  assert.match(setTabBody, /if \(isSettingsSub\) viewerSetSettingsSection\(tab\);/);

  const easyStart = source.indexOf('const viewerInstallSettingsEasyView = root => {');
  const easyEnd = source.indexOf('const viewerRenderSettingSources = rawSnapshot => {', easyStart);
  const easyBody = source.slice(easyStart, easyEnd);
  assert.ok(easyBody.includes("row.closest?.('[data-no-track]')"), 'easy view skips [data-no-track] rows');
  assert.ok(easyBody.includes("fold.closest?.('[data-no-track]')"), 'easy view skips [data-no-track] folds');
  assert.ok(easyBody.includes("section.hasAttribute('data-no-track')"), 'easy view skips [data-no-track] sections');
});

test('HAYAKU topbar places settings button left of more menu and hides job chip when idle', () => {
  const headerStart = source.indexOf('<header class="topbar">');
  const headerEnd = source.indexOf('</header>', headerStart);
  assert.ok(headerStart >= 0 && headerEnd > headerStart, 'topbar header slice found');
  const headerHtml = source.slice(headerStart, headerEnd);

  const settingsIdx = headerHtml.indexOf('id="hayakuTopSettingsBtn"');
  const menuIdx = headerHtml.indexOf('<div class="menu">');
  assert.ok(settingsIdx > 0 && menuIdx > settingsIdx, 'settings button appears strictly before more menu');
  assert.match(headerHtml.slice(settingsIdx, menuIdx), /data-hayaku-viewer-goto="settings"[^>]*aria-label="설정">\$\{hayakuMockupIcon\('gear'\)\}<\/button>/);

  assert.match(headerHtml, /id="hayakuNativeJobChip"[^>]*\bhidden>/, 'job chip starts hidden when idle');
  const jobRenderStart = source.indexOf('const viewerRenderNativeJob = () => {');
  const jobRenderBranch = source.slice(jobRenderStart, jobRenderStart + 650);
  assert.ok(jobRenderBranch.includes('if (chip) { chip.hidden = true;'), 'viewerRenderNativeJob hides job chip when !job');
});

test('HAYAKU moves health badge and packet mode chip into sidebar current-status footer and preserves them on mount', () => {
  const vm = require('node:vm');
  const headerStart = source.indexOf('<header class="topbar">');
  const headerEnd = source.indexOf('</header>', headerStart);
  const headerHtml = source.slice(headerStart, headerEnd);
  assert.ok(!headerHtml.includes('id="hayakuViewerHealth"'), '#hayakuViewerHealth removed from topbar');
  assert.ok(!headerHtml.includes('id="hayakuHeaderPacketMode"'), '#hayakuHeaderPacketMode removed from topbar');

  const navStart = source.indexOf('<nav class="sidebar"');
  const navEnd = source.indexOf('</nav>', navStart);
  const navHtml = source.slice(navStart, navEnd);
  const sideFootIdx = navHtml.indexOf('<div class="side-foot">');
  assert.ok(sideFootIdx > 0, 'sidebar footer exists');
  const sideFootHtml = navHtml.slice(sideFootIdx);
  const badgesIdx = sideFootHtml.indexOf('id="hayakuSideStatusBadges"');
  const healthIdx = sideFootHtml.indexOf('id="hayakuViewerHealth"');
  const modeIdx = sideFootHtml.indexOf('id="hayakuHeaderPacketMode"');
  assert.ok(badgesIdx > 0 && healthIdx > badgesIdx && modeIdx > healthIdx,
    'sidebar footer hosts #hayakuSideStatusBadges containing #hayakuViewerHealth then #hayakuHeaderPacketMode');

  const factoryStart = source.indexOf('const createMemorySuiteCurrentStatus = (function createMemorySuiteCurrentStatus(options) {');
  const factoryEnd = source.indexOf('/* MEMORY SUITE CURRENT STATUS END */', factoryStart);
  assert.ok(factoryStart > 0 && factoryEnd > factoryStart);
  const factoryCode = source.slice(factoryStart, factoryEnd) + '\nglobalThis.__createStatus = createMemorySuiteCurrentStatus;';

  const makeEl = (tag, id = '') => {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      textContent: '',
      title: '',
      dataset: {},
      style: {},
      children: [],
      attrs: {},
      classList: { add() {}, toggle() {}, contains() { return false; } },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      addEventListener() {},
      appendChild(c) { el.children.push(c); return c; },
      append(...nodes) { el.children.push(...nodes); },
      replaceChildren(...nodes) { el.children = [...nodes]; },
      querySelector(sel) {
        if (sel === '#hayakuSideStatusBadges') return el.children.find(c => c.id === 'hayakuSideStatusBadges') || null;
        if (sel === '[data-current-status]') return null;
        for (const c of el.children) {
          if (sel.startsWith('[data-current-status="') && c.dataset?.currentStatus === sel.slice(22, -2)) return c;
          const nested = c.querySelector?.(sel);
          if (nested) return nested;
        }
        return null;
      },
      isConnected: true
    };
    return el;
  };
  const badgesNode = makeEl('div', 'hayakuSideStatusBadges');
  const foot = makeEl('div');
  foot.className = 'side-foot';
  foot.ownerDocument = { createElement: tag => makeEl(tag) };
  foot.replaceChildren(badgesNode);
  const root = { isConnected: true, querySelector: sel => (sel === '.side-foot' ? foot : null) };
  const ctx = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(factoryCode, ctx);
  const status = ctx.__createStatus({
    bridge: { getConnectionSettings: async () => ({ mode: 'plugin_only' }) },
    getRoot: () => root,
    isVisible: () => true,
    getIdentity: () => 'scope1',
    getRows: () => [{ id: 'recall', text: '동작: 균형', target: 'settings' }],
    navigate: () => {}
  });
  status.sync();
  status.stop();
  assert.equal(foot.children[0].tagName, 'B');
  assert.equal(foot.children[0].textContent, '현재 상태');
  assert.equal(foot.children[1], badgesNode, '#hayakuSideStatusBadges is preserved right under 현재 상태 heading');
  assert.equal(foot.children[2].className, 'current-status-body');
});

test('HAYAKU removes the 8 always-on internal toggles from Settings UI and marks them retired in schema', () => {
  const pageStart = source.indexOf('const HAYAKU_MOCKUP_SETTINGS_PAGE =');
  const specsStart = source.indexOf('const HAYAKU_GUI_SETTING_SPECS =', pageStart);
  const wireStart = source.indexOf('const viewerWireSettingsMarkup =', specsStart);
  assert.ok(pageStart > 0 && specsStart > pageStart && wireStart > specsStart);

  const settingsMarkup = source.slice(pageStart, specsStart);
  const specsBlock = source.slice(specsStart, wireStart);

  assert.match(settingsMarkup, /data-hayaku-settings-section-button="pick"><b>기억 선택<\/b><small>회상 기준 · 문맥 \(6\+5\)<\/small>/);
  assert.match(settingsMarkup, /data-hayaku-settings-section-button="safe"><b>복구 · 안전<\/b><small>누락 · Cold Start \(7\)<\/small>/);

  const retiredKeys = [
    'hayaku_adaptive_context_window',
    'hayaku_multi_query_recall',
    'hayaku_contradiction_bundle',
    'hayaku_multi_resolution_recall',
    'hayaku_recall_stability',
    'hayaku_packet_coverage_audit',
    'hayaku_packet_coverage_fallback_recall',
    'hayaku_display_scrubber'
  ];
  for (const key of retiredKeys) {
    assert.ok(!settingsMarkup.includes(`<span class="argtag">${key}</span>`), `${key} row removed from Settings markup`);
    assert.match(specsBlock, new RegExp(`argument:\\s*'${key}'[^}]*retired:\\s*true`), `${key} marked retired: true in HAYAKU_GUI_SETTING_SPECS`);
  }
});

test('HAYAKU recovery_extra_calls description matches runtime behavior and select avoids clipping', () => {
  const pageStart = source.indexOf('const HAYAKU_MOCKUP_SETTINGS_PAGE =');
  const specsStart = source.indexOf('const HAYAKU_GUI_SETTING_SPECS =', pageStart);
  const settingsMarkup = source.slice(pageStart, specsStart);
  assert.match(
    settingsMarkup,
    /수동 복구\(재시도\)·Cold Start·재분석에서 패킷 형식 오류 시 턴·묶음당 Other Ax를 1회 더 호출합니다\. 기본값: 추가 호출 없음 \(afterRequest 자동 복구 제외\)[\s\S]*id="st-extra" style="width:155px"/
  );
});
