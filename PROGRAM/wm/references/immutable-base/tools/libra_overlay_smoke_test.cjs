'use strict';
// Gate: 실시간 작업 표시의 상태 기계 계약 (팝업 → 헤더 전환 후).
//
// 배경: 종전 이 파일은 화면 좌측 상단 팝업(#libra-activity-overlay)의 DOM·CSS·
// 버튼 동작을 24개 단언으로 고정했다. 사용자 요청으로 팝업을 삭제하고 GUI 헤더
// (#libra-global-status)의 실시간 작업 표시로 바꾸었으므로, 팝업 DOM 단언은
// 의미가 없다. 다만 이 파일이 지키던 **상태 기계 계약**은 여전히 유효하다:
//   - arg off 면 표시하지 않는다 (20개 하네스가 off 로 억제한다)
//   - 플러그인 전체화면 컨테이너를 절대 쓰지 않는다 (showContainer 0회)
//   - 수동 닫기는 그 run 동안 유지된다 (같은 run 재표시 금지)
//   - 완료 후 자동으로 숨는다
//   - 큐가 살아 있으면 자동 숨김을 미룬다
//   - 기능 분석 모듈이 종결된다
// 헤더 표시 자체의 계약(팝업 미생성·헤더 갱신)은 libra_activity_header_test.cjs
// 가 담당한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.className = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; if (this.ownerDocument && this.id) delete this.ownerDocument._ids[this.id]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  removeEventListener() {}
  focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector(selector) { return this.ownerDocument ? this.ownerDocument._queryWithin(this, selector) : null; }
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
  querySelector(selector) {
    if (selector === 'head') return this.head;
    if (selector === 'body') return this.body;
    return this._queryWithin({ children: [this.head, this.body] }, selector);
  }
  _queryWithin(root, selector) {
    const attrMatch = String(selector || '').match(/^\[([^=\]]+)=["']([^"']+)["']\]$/);
    const idMatch = String(selector || '').match(/^#(.+)$/);
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const el = stack.shift();
      if (attrMatch && el.attributes?.[attrMatch[1]] === attrMatch[2]) return el;
      if (idMatch && el.id === idMatch[1]) return el;
      stack.push(...(el.children || []));
    }
    return null;
  }
}

async function runCase(name, args = {}, options = {}) {
  const document = new FakeDocument();
  const calls = { showContainer: 0, hideContainer: 0, permissions: [], registeredButtons: 0, registeredSettings: 0 };
  const store = new Map();
  // GUI 헤더의 실시간 작업 표시 요소 (실제 오버레이 마크업에 존재).
  const statusEl = document.createElement('span');
  statusEl.id = 'libra-global-status';
  statusEl.textContent = '준비 완료';
  document.body.appendChild(statusEl);

  const permissionGranted = options.permissionGranted !== false;
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return Object.prototype.hasOwnProperty.call(args, key) ? args[key] : undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); }
    },
    async getCharacter() { return null; },
    async registerSetting() { calls.registeredSettings += 1; },
    async registerButton() { calls.registeredButtons += 1; },
    async requestPluginPermission(name) { calls.permissions.push(String(name)); return permissionGranted; },
    async showContainer() { calls.showContainer += 1; },
    async hideContainer() { calls.hideContainer += 1; },
    async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 50));

  const api = context.LIBRA_ActivityDashboard;
  const stateBefore = api?.selfCheck?.() || null;
  if (options.healthBeforeShow) api?.updateHealthSummary?.({}, options.healthBeforeShow);

  const showResult = options.skipShow ? null : (api?.show?.({ stageLabel: `${name} 표시 검증`, progress: 25 }) || null);
  await new Promise(r => setTimeout(r, 120));
  const headerTextWhileRunning = String(statusEl.textContent || '');

  // 수동 닫기는 은퇴했다 (사용자 결정). hide() 는 여전히 유효한 API 지만,
  // 은퇴 후에는 "같은 run 재표시 금지" 상태가 존재하지 않는다 — 늦은 작업이
  // 오면 다시 표시되는 것이 정상이다.
  let hiddenByApi = false;
  let lateWorkReopensAfterHide = false;
  if (options.testClose) {
    api?.hide?.();
    await new Promise(r => setTimeout(r, 100));
    hiddenByApi = api?.selfCheck?.()?.visible === false;
    api?.recordLLM?.('primary', { total_tokens: 12 }, { label: 'late same-run update', foreground: true });
    api?.updateFeatureAnalysis?.({ key: 'late:update', label: 'late same-run update', status: 'running', show: true });
    await new Promise(r => setTimeout(r, 120));
    lateWorkReopensAfterHide = api?.selfCheck?.()?.visible === true;
  }

  if (options.staleFeatureAtComplete) {
    api?.updateFeatureAnalysis?.({ key: 'stale:feature', label: 'stale feature', status: 'running', show: true });
  }

  let embeddingProviderSettled = false;
  if (options.embeddingLifecycle) {
    api?.updateFeatureAnalysis?.({ domain: 'embedding', reason: 'voyageai', status: 'running', detail: 'voyage-4-large' });
    api?.recordEmbedding?.({ provider: 'voyageai', label: 'Embedding voyageai' });
    const feature = api?.selfCheck?.()?.featureAnalysis || {};
    embeddingProviderSettled = Number(feature.active || 0) === 0
      && feature.modules?.['embedding:voyageai']?.status === 'done'
      && !feature.modules?.['embedding:provider'];
  }
  if (options.queueActiveAtComplete) api?.updateQueues?.('MaintenanceLLMQueue', 1, 0);
  if (!options.skipShow && !options.testClose) api?.complete?.('분석 완료');
  if (options.queueActiveAtComplete) {
    await new Promise(r => setTimeout(r, 500));
    api?.updateQueues?.('MaintenanceLLMQueue', 0, 0);
  }
  await new Promise(r => setTimeout(r, 1950));
  const stateAfterAutoHide = api?.selfCheck?.() || null;
  const headerTextAfter = String(statusEl.textContent || '');
  // 팝업이 어디에도 만들어지지 않았는지 여러 각도에서 확인한다.
  const popupAnywhere = document.getElementById('libra-activity-overlay')
    || document.getElementById('libra-activity-overlay-style')
    || document.querySelector('[data-lra-progress="true"]');

  return {
    name,
    hasApi: !!api,
    stateBefore,
    showResultMode: showResult?.mode || null,
    headerTextWhileRunning,
    headerTextAfter,
    popupCreated: !!popupAnywhere,
    hiddenByApi,
    lateWorkReopensAfterHide,
    embeddingProviderSettled,
    stateAfterAutoHide,
    showContainerCalls: calls.showContainer,
    hideContainerCalls: calls.hideContainer,
    permissions: calls.permissions,
    registeredSettings: calls.registeredSettings,
    registeredButtons: calls.registeredButtons
  };
}

(async () => {
  const results = [];
  results.push(await runCase('default_activity_display', {}, {}));
  results.push(await runCase('full_activity_display', { activity_dashboard: 'full' }));
  results.push(await runCase('arg_off', { activity_dashboard: 'off' }));
  results.push(await runCase('permission_denied', {}, { permissionGranted: false }));
  results.push(await runCase('health_summary_idle', {}, {
    skipShow: true,
    healthBeforeShow: { total: 3, quarantine: 1, conflicts: 1, integrity: 1, severity: 'warn', message: 'idle health warning' }
  }));
  results.push(await runCase('manual_hide', {}, { testClose: true }));
  results.push(await runCase('stale_feature_auto_close', {}, { staleFeatureAtComplete: true }));
  results.push(await runCase('queue_release_auto_close', {}, { queueActiveAtComplete: true }));
  results.push(await runCase('embedding_provider_lifecycle', {}, { embeddingLifecycle: true }));

  const assertions = [
    // ── 상태 기계 계약 (전환 전과 동일하게 유지) ──
    { name: 'default_display_mode_is_compact', ok: results[0].stateBefore?.mode === 'compact' && results[0].showResultMode === 'compact' },
    { name: 'arg_off_hides_display', ok: results[2].stateBefore?.enabled === false && results[2].stateAfterAutoHide?.visible === false },
    { name: 'never_uses_plugin_fullscreen_container', ok: results.every(r => r.showContainerCalls === 0) },
    { name: 'no_permission_requests_for_inline_display', ok: results.every(r => r.permissions.length === 0) },
    { name: 'health_summary_recorded_but_idle_does_not_show', ok: results[4].stateAfterAutoHide?.visible === false && results[4].stateAfterAutoHide?.healthSummary?.total === 3 },
    { name: 'hide_api_still_hides', ok: results[5].hiddenByApi === true },
    { name: 'late_work_reopens_after_hide_retirement', ok: results[5].lateWorkReopensAfterHide === true },
    { name: 'completion_auto_hides', ok: results[0].stateAfterAutoHide?.visible === false },
    { name: 'terminal_finish_settles_stale_feature', ok: results[6].stateAfterAutoHide?.visible === false && Number(results[6].stateAfterAutoHide?.featureAnalysis?.active || 0) === 0 },
    { name: 'terminal_finish_auto_hides_after_active_queue_releases', ok: results[7].stateAfterAutoHide?.visible === false && Number(results[7].stateAfterAutoHide?.queue?.llmActive || 0) === 0 },
    { name: 'embedding_provider_completion_settles_start_module', ok: results[8].embeddingProviderSettled === true },

    // ── 팝업 제거 계약 (신규) ──
    { name: 'popup_never_created_in_any_case', ok: results.every(r => r.popupCreated === false) },

    // ── 헤더 표시 계약 (신규) ──
    { name: 'header_shows_task_while_running',
      ok: /표시 검증|진행|작업/.test(results[0].headerTextWhileRunning || ''),
      detail: { text: results[0].headerTextWhileRunning } },
    { name: 'header_reflects_completion_after_finish',
      ok: results[0].headerTextAfter !== results[0].headerTextWhileRunning || /완료|준비/.test(results[0].headerTextAfter || ''),
      detail: { text: results[0].headerTextAfter } },
    { name: 'header_untouched_when_display_off',
      ok: /준비 완료/.test(results[2].headerTextAfter || ''),
      detail: { text: results[2].headerTextAfter } }
  ];

  const output = { ok: assertions.every(a => a.ok), assertions, results };
  const outPath = path.join(ROOT, 'test-output', 'activity_overlay_smoke_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})();
