'use strict';
// Gate: 월드라인(세계선) GUI 노출 — 턴 노드·리롤 이력·브랜치 계보를 화면에 보여준다.
//
// 배경: Turn Worldline 은 이미 저장·감지까지 동작하지만 화면에 전혀 보이지 않는다.
// 사용자가 "내 기억이 어떻게 쌓였고 리롤로 무엇이 바뀌었는지" 확인할 수 없으면
// 이력 보존의 가치가 없다.
//
// 이 게이트가 고정하는 계약:
//   A. 마크업에 세계선 탭과 컨테이너가 있다
//   B. 렌더 함수가 노드 목록을 만든다 (활성/비활성 구분)
//   C. 비활성 노드(리롤로 물러난 것)를 이력으로 보여준다
//   D. 브랜치 계보 상태(verified/diverged/unverified)를 보여준다
//   E. 빈 상태에서도 깨지지 않는다
//   F. 상태 라벨이 사용자 언어(한국어)다 — 내부 용어를 노출하지 않는다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const read = (f) => fs.readFileSync(path.join(PARTS, f), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const gui = read('15-gui-and-exports.js');
const content = read('15b-gui-content-world-dlc.js');

// ── A. 마크업 ────────────────────────────────────────────────────────────
assert('worldline_view_tab_exists',
  /data-view-tab="worldline"/.test(gui) && /세계선/.test(gui),
  { note: 'view-tabs 에 세계선 탭' });
assert('worldline_container_exists',
  /id="wl-view"/.test(gui) && /id="wl-lineage"/.test(gui),
  { found: (gui.match(/id="wl-[\w-]+"/g) || []) });

// ── B~F. 렌더 함수 (소스 수준) ───────────────────────────────────────────
assert('worldline_renderer_exists',
  /const renderWorldline\w* = /.test(content) || /const renderWorldline\w* = /.test(gui),
  {});
const rendererSource = read('01f-lore-consolidation.js');
assert('renderer_distinguishes_active_and_history',
  /activeNodes\(/.test(rendererSource) && /supersededNodes\(/.test(rendererSource)
  && /inactive_variant/.test(rendererSource), {
  note: '활성 노드와 물러난(이력) 노드를 구분해야 한다'
});
assert('renderer_shows_branch_lineage',
  /LibraHostLineage|host_lineage|계보|branch/i.test(content), {});
assert('renderer_is_korean_facing',
  /세계선|턴|리롤|이력/.test(content), { note: '사용자 언어로 표시' });

// ── 런타임: 빈 상태에서 깨지지 않는가 ────────────────────────────────────
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this._id = ''; this.className = ''; this.style = {}; this.attributes = {};
    this.listeners = {}; this._innerHTML = ''; this._html = ''; this.textContent = ''; this.dataset = {};
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); }
  get innerHTML() { return this._html; }
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

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const chat = { id: 'chat-1', localLore: [], message: [], bindedPersona: 'p1' };
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [chat], globalLore: [] };
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); },
      async keys() { return Array.from(store.keys()); }
    },
    async getLocalPluginStorage() { return { async getItem() { return null; }, async setItem() {}, async removeItem() {} }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai, risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  assert('dist_runs_without_error', !runError, { error: runError });

  const wl = context.LibraTurnWorldline || null;
  const render = wl && typeof wl.renderWorldlineView === 'function' ? wl.renderWorldlineView
    : (context.LibraWorldlineView && typeof context.LibraWorldlineView.render === 'function' ? context.LibraWorldlineView.render : null);
  assert('worldline_renderer_exported', typeof render === 'function', {
    worldlineKeys: wl ? Object.keys(wl) : null,
    globals: Object.keys(context).filter(k => /worldline|Worldline/i.test(k))
  });

  if (typeof render !== 'function') {
    assert('renders_empty_state_safely', false, {});
    assert('renders_nodes_with_history', false, {});
    assert('shows_branch_lineage_status', false, {});
  } else {
    // 빈 상태
    let emptyOk = false;
    let emptyHtml = '';
    try { emptyHtml = String(render(null) || ''); emptyOk = emptyHtml.length > 0 && !/undefined|\[object/.test(emptyHtml); } catch (_) {}
    assert('renders_empty_state_safely', emptyOk, { html: emptyHtml.slice(0, 120) });

    // 실제 데이터 (턴 2개 + 리롤로 물러난 노드 1개)
    const scopeKey = 'char:char-1|chat:chat-1|persona:p1';
    const pair = (i, u, a) => ({ pairIndex: i, userText: u, assistantText: a });
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1'), pair(2, 'u2', 'a2')]);
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLL'), pair(2, 'u2', 'a2')]);
    const state = wl.get(scopeKey);

    let html = '';
    try { html = String(render(state) || ''); } catch (_) {}
    assert('renders_nodes_with_history',
      /2/.test(html) && html.length > 100 && !/undefined/.test(html),
      { htmlLength: html.length, sample: html.slice(0, 200) });

    // 물러난(비활성) 노드가 이력으로 표시되는가
    const hasHistoryLabel = /이력|물러|비활성|이전/.test(html);
    assert('shows_history_label', hasHistoryLabel, { sample: html.slice(0, 250) });

    // 브랜치 계보 상태 표시
    const withLineage = render(state, { lineage: { status: 'verified', parentChatId: 'chat-parent', commonPrefixPairs: 2 } });
    assert('shows_branch_lineage_status',
      /분기|브랜치|계보|부모/.test(String(withLineage || '')),
      { sample: String(withLineage || '').slice(0, 250) });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
