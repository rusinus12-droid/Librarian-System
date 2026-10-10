'use strict';
// Gate: 실시간 작업 표시가 팝업이 아니라 GUI 헤더에 나타나는가.
//
// 배경 (실측): ActivityDashboardCore(02b+02c+02d, 단일 IIFE 1,578줄) 의 약
// 447줄이 화면 좌측 상단에 뜨는 자체 DOM 팝업(#libra-activity-overlay,
// position:fixed, --lra-safe-top, lra-card/lra-shell/lra-top 스타일 60줄)을 그린다.
// 사용자 요청: "팝업으로 표시되는 건 삭제하고 기능을 변형해서 gui 헤더에 현재
// 실시간 작업을 표시되게끔 하는 게 좋을 거 같아."
//
// 이 게이트가 단언하는 계약:
//   A. 팝업이 사라졌다 — 배포본에 팝업 전용 심볼·CSS·노드 id 가 없다
//   B. 추적 API 는 살아 있다 — 14개 파일이 쓰는 update/finish/recordLLM 등 유지
//   C. 헤더 표시가 있다 — GUI 헤더의 #libra-global-status 를 갱신하는 경로가 있다
//   D. 실제로 갱신된다 — beginRequest/update/finish 후 헤더 텍스트가 작업을 반영한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rawCode = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
// 주석은 코드가 아니다 — "제거했다"를 단언할 때 주석에 남은 설명을 결함으로
// 오진하지 않도록 // 주석을 벗겨낸 뒤 스캔한다 (앞서 같은 실수를 한 적이 있다).
const code = rawCode.replace(/^\s*\/\/.*$/gm, '');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── A. 팝업 제거 ─────────────────────────────────────────────────────────
const popupMarkers = [
  'libra-activity-overlay', 'lra-card', 'lra-shell', 'lra-safe-top',
  'renderMainDomDashboard', 'ensureMainDomDashboardNode',
  'buildMainDomDashboardHtml', 'applyDashboardPlacement', 'hideMainDomDashboard',
  'ACTIVITY_DASHBOARD_NODE_ID', 'activityDashboardCssText',
  'updateMainDomElapsed', 'ensureDirectDomDashboardNode'
];
const found = popupMarkers.filter(m => code.includes(m));
assert('popup_symbols_removed', found.length === 0, { remaining: found });
assert('popup_surface_style_removed', !/--lra-surface/.test(code) && !/--lra-safe-top/.test(code), {});
assert('popup_never_requests_plugin_overlay', !/showContainer/.test(code) || !/activity/i.test(String(code.match(/.{0,80}showContainer.{0,80}/) || '')), {});

// ── B. 추적 API 보존 (소스 수준 — 14개 파일이 의존) ──────────────────────
const requiredApi = ['beginRequest', 'update', 'finish', 'recordLLM', 'recordEmbedding',
  'recordCacheReuse', 'recordSkippedCall', 'recordInjection', 'updateFeatureAnalysis',
  'updateBackground', 'updateQueues', 'updateHealthSummary', 'getState', 'hide', 'reset', 'refresh', 'selfCheck'];
const missingInSource = requiredApi.filter(k => !new RegExp(`\\b${k}\\b`).test(code));
assert('tracking_api_preserved', missingInSource.length === 0, { missing: missingInSource });

// 호출부가 남아 있는가 (14개 파일)
const callerFiles = ['04f-cold-start-structured-merge', '04h-cold-start-reanalysis', '04i-cold-start-entrypoints',
  '05g-commit-guard-maintenance-records', '05h-turn-maintenance-worker', '05i-turn-maintenance-scheduler-analysis',
  '07-token-recall-embedding-emotion', '09c-turn-maintenance-optimizer', '10f-hybrid-shortlist-lore-embedding',
  '13c-before-request-injection', '13d-after-request-worker-unload', '15a-gui-session-data', '15b-gui-content-world-dlc'];
const callersOk = callerFiles.every(f => {
  try { return /ActivityDashboardCore/.test(fs.readFileSync(path.join(ROOT, 'src', 'parts', f + '.js'), 'utf8')); }
  catch (_) { return false; }
});
assert('all_callers_still_present', callersOk, {});

// ── C. 헤더 표시 배선 ────────────────────────────────────────────────────
const gui = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js'), 'utf8');
assert('gui_header_status_element_exists', /id="libra-global-status"/.test(gui), {});
const headerBind = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15a-gui-session-data.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'src', 'parts', '02c-activity-dashboard-lifecycle.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'src', 'parts', '02d-activity-dashboard-queues-metrics.js'), 'utf8');
assert('header_renderer_bound_to_status_element',
  /libra-global-status/.test(headerBind) || /syncActivityHeader/.test(headerBind),
  { note: '대시보드 상태를 헤더 요소에 반영하는 코드가 있어야 한다' });

// ── D. 런타임: 헤더가 실제로 갱신되는가 ──────────────────────────────────
class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this._id = ''; this.className = ''; this.style = {}; this.attributes = {};
    this.listeners = {}; this._innerHTML = ''; this.textContent = ''; this.dataset = {};
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector(s) { return this.ownerDocument ? this.ownerDocument._queryWithin(this, s) : null; }
  querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() {
    this._ids = Object.create(null);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.readyState = 'complete';
  }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) {
    if (sel === 'head') return this.head;
    if (sel === 'body') return this.body;
    return this._queryWithin({ children: [this.head, this.body] }, sel);
  }
  _queryWithin(root, selector) {
    const idMatch = String(selector || '').match(/^#(.+)$/);
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const el = stack.shift();
      if (idMatch && el.id === idMatch[1]) return el;
      stack.push(...(el.children || []));
    }
    return null;
  }
}
async function runCase(args = {}) {
  const document = new FakeDocument();
  // GUI 헤더 요소를 미리 심는다 (실제 오버레이 마크업에 존재).
  const statusEl = document.createElement('span'); statusEl.id = 'libra-global-status';
  document.body.appendChild(statusEl);
  const store = new Map();
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(k) { return Object.prototype.hasOwnProperty.call(args, k) ? args[k] : undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); }
    },
    async getCharacter() { return null; },
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() { throw new Error('showContainer must not be used (popup removed)'); },
    async hideContainer() {}, async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() },
    getCharacter: () => null, getChatFromIndex: () => null, getChatMain: () => ({})
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 60));
  return { context, document, statusEl, api: context.LIBRA_ActivityDashboard };
}

(async () => {
  let api = null; let document = null; let statusEl = null; let runError = '';
  try {
    const r = await runCase({});
    api = r.api; document = r.document; statusEl = r.statusEl;
  } catch (e) { runError = String(e && e.stack || e).slice(0, 400); }
  assert('dist_runs_without_error', !runError, { error: runError });
  assert('dashboard_core_exported', !!api, { keys: api ? Object.keys(api).length : 0 });

  if (api) {
    const apiKeys = Object.keys(api);
    const missingApi = requiredApi.filter(k => !apiKeys.includes(k));
    assert('tracking_api_exported_at_runtime', missingApi.length === 0, { missing: missingApi });

    // 팝업 노드가 만들어지지 않는가
    await Promise.resolve(api.beginRequest?.({ flow: 'test', title: '헤더 표시 검증', stageLabel: '진행 중' }));
    await Promise.resolve(api.update?.({}, { status: 'running', phase: 'test', message: '실시간 작업 표시 검증', progress: 42, show: true }));
    await new Promise(r => setTimeout(r, 80));
    const popupNode = document.getElementById('libra-activity-overlay');
    assert('no_popup_node_created', !popupNode, { nodeId: popupNode?.id || null });

    // 헤더가 갱신되었는가
    const headerText = String(statusEl.textContent || '');
    assert('header_shows_live_task', headerText.length > 0 && /실시간 작업 표시 검증|진행|작업/.test(headerText),
      { headerText: headerText.slice(0, 120) });

    // 완료 후 헤더가 완료 상태를 반영하는가
    await Promise.resolve(api.finish?.({}, 'ok', '헤더 검증 완료'));
    await new Promise(r => setTimeout(r, 60));
    const afterText = String(statusEl.textContent || '');
    assert('header_reflects_completion', /완료|준비/.test(afterText) || afterText !== headerText,
      { afterText: afterText.slice(0, 120) });
  } else {
    assert('tracking_api_exported_at_runtime', false, {});
    assert('no_popup_node_created', false, {});
    assert('header_shows_live_task', false, {});
    assert('header_reflects_completion', false, {});
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
