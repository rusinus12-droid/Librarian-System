'use strict';
// Gate: Turn Worldline — 턴을 노드로 기록해 리롤·브랜치·롤백을 추적한다.
//
// 배경: Downloads/plugins 의 최신 플러그인들이 쓰는 턴 추적 구조를 실측했다.
// LIBRA 는 종전에 턴을 평면 목록으로만 저장해, 같은 턴이 리롤되면 이전 응답을
// 덮어썼다(이력 소실). 이 게이트는 그 구조를 노드 체인으로 만든다.
//
// 실측한 정체성 공식 (Flashback/HAYAKU 공통):
//   logicalTurnId = hash(`turn\x01${scopeKey}\x01${pairIndex}\x01${userHash}`)
//   variantId     = hash(`variant\x01${logicalTurnId}\x01${assistantHash}`)
//   turnNodeId    = hash(`node\x01${scopeKey}\x01${logicalTurnId}\x01${variantId}`)
//
// 핵심 성질:
//   - 같은 턴을 리롤하면 logicalTurnId 는 같고 variantId 가 달라진다
//     → 형제 노드가 되고, 이전 노드는 superseded 로 남는다 (이력 보존 · 정본 어휘)
//   - 라이브 대화에서 사라진 노드는 orphaned / detached 로 표시된다 (정본 어휘)
//   - 노드 체인은 parentTurnNodeId 로 이어져 브랜치 분기를 표현한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

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

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], message: [], bindedPersona: 'p1' };
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
    async getLocalPluginStorage() {
      return { async getItem() { return null; }, async setItem() {}, async removeItem() {} };
    },
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
  assert('worldline_module_exported', !!wl, {
    candidates: Object.keys(context).filter(k => /worldline|Worldline/i.test(k))
  });

  if (!wl) {
    for (const n of ['node_identity_is_deterministic', 'reroll_creates_sibling_node',
      'reroll_preserves_old_node_as_superseded', 'branch_chain_links_parent',
      'missing_node_becomes_orphaned', 'worldline_roundtrips_via_storage']) {
      assert(n, false, { reason: 'no module' });
    }
  } else {
    const scopeKey = 'char:char-1|chat:chat-1|persona:p1';
    const pair = (i, user, assistant) => ({ pairIndex: i, userText: user, assistantText: assistant });

    const id1 = wl.identityFor(scopeKey, pair(1, 'u1', 'a1'));
    const id1again = wl.identityFor(scopeKey, pair(1, 'u1', 'a1'));
    assert('node_identity_is_deterministic',
      id1.turnNodeId === id1again.turnNodeId && !!id1.logicalTurnId && !!id1.variantId,
      { a: id1.turnNodeId, b: id1again.turnNodeId });

    // 리롤: 같은 턴, 다른 응답 → logicalTurnId 동일, variantId 다름
    const id1reroll = wl.identityFor(scopeKey, pair(1, 'u1', 'a1-REROLLED'));
    assert('reroll_keeps_logical_turn', id1.logicalTurnId === id1reroll.logicalTurnId, {
      a: id1.logicalTurnId, b: id1reroll.logicalTurnId
    });
    assert('reroll_creates_sibling_node', id1.variantId !== id1reroll.variantId && id1.turnNodeId !== id1reroll.turnNodeId, {
      v1: id1.variantId, v2: id1reroll.variantId
    });

    // 관찰 1: 두 턴을 기록
    let state = await wl.observe(scopeKey, [pair(1, 'u1', 'a1'), pair(2, 'u2', 'a2')]);
    assert('observe_records_nodes', Array.isArray(state.nodes) && state.nodes.length === 2, {
      count: state.nodes?.length
    });

    // 관찰 2: 턴 1을 리롤 → 이전 노드는 superseded 로 남아야 한다 (정본 어휘)
    state = await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLLED'), pair(2, 'u2', 'a2')]);
    const rerolled = state.nodes.find(n => n.variantId === id1.variantId);
    const activeNow = state.nodes.find(n => n.status === 'active' && n.pairIndex === 1);
    // ★ 이름만 정본으로 갱신한다 — 계약(리롤 시 이전 노드가 이력으로 남고 새 variant 가 활성)은 그대로다.
    //   옛 이름도 **읽기**는 허용되므로, 저장 데이터가 옛 이름이어도 통과하도록 둘 다 받는다.
    assert('reroll_preserves_old_node_as_superseded',
      !!rerolled && ['superseded', 'inactive_variant'].includes(rerolled.status)
      && !!activeNow && activeNow.variantId === id1reroll.variantId,
      { oldStatus: rerolled?.status, newActive: activeNow?.variantId });

    // 브랜치 체인: parentTurnNodeId 로 이어진다
    const n2 = state.nodes.find(n => n.pairIndex === 2 && n.status === 'active');
    assert('branch_chain_links_parent', !!n2?.parentTurnNodeId, { parent: n2?.parentTurnNodeId });

    // 라이브에서 사라진 턴 (롤백/리롤로 잘림) → orphaned
    state = await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLLED')]);
    const dropped = state.nodes.find(n => n.pairIndex === 2);
    assert('missing_node_becomes_orphaned',
      !!dropped && ['orphaned', 'detached', 'detached_branch'].includes(dropped.status),
      { status: dropped?.status });

    // 저장 왕복
    const saved = await wl.save(scopeKey);
    const loaded = await wl.load(scopeKey);
    assert('worldline_roundtrips_via_storage',
      Array.isArray(loaded?.nodes) && loaded.nodes.length === state.nodes.length,
      { saved: saved?.nodes?.length, loaded: loaded?.nodes?.length });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
