'use strict';
// Gate: 월드라인이 프롬프트에 반영되는가 — 물러난 턴의 기억을 회상에서 제외한다.
//
// 배경: Turn Worldline 은 리롤로 물러난 턴을 `inactive_variant` / `orphaned` 로
// 보존한다. 그런데 회상(프롬프트 주입)은 아직 월드라인을 보지 않아, **물러난
// 턴의 기억도 그대로 프롬프트에 실린다.** 그러면 모델이 폐기된 응답의 내용을
// 사실로 취급할 수 있다 — 리롤의 의미가 사라진다.
//
// 이 게이트가 고정하는 계약:
//   A. 필터가 있다 — 월드라인 노드 상태로 기억을 걸러내는 순수 함수
//   B. 물러난 턴의 기억을 제외한다 (inactive_variant / orphaned / detached_branch)
//   C. 현재 턴의 기억은 남긴다 (active / quarantined)
//   D. 월드라인에 없는 턴은 남긴다 (기록 전이거나 매핑 불가 — 과잉 제외 금지)
//   E. 기록이 비어 있으면 아무것도 제외하지 않는다 (안전한 기본값)
//   F. 배선되어 있다 — 주입 파이프라인이 이 필터를 호출한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const read = (f) => fs.readFileSync(path.join(PARTS, f), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

// ── F. 배선 (소스 수준) ──────────────────────────────────────────────────
const inj = read('13c-before-request-injection.js');
assert('injection_pipeline_calls_worldline_filter',
  /LibraTurnWorldline\.(filterSupersededMemories|buildSupersededTurnSet|isSupersededMemory)/.test(inj), {
  note: '주입 파이프라인이 월드라인 필터를 호출해야 한다'
});

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
  const filterFn = wl && typeof wl.buildSupersededTurnSet === 'function' ? wl.buildSupersededTurnSet : null;
  assert('superseded_turn_set_builder_exists', typeof filterFn === 'function', {
    worldlineKeys: wl ? Object.keys(wl) : null
  });

  if (typeof filterFn !== 'function') {
    for (const n of ['excludes_superseded_turn', 'keeps_active_turn', 'keeps_unknown_turn',
      'empty_worldline_excludes_nothing', 'filter_returns_counts']) assert(n, false, { reason: 'no fns' });
  } else {
    const scopeKey = 'char:char-1|chat:chat-1|persona:p1';
    const pair = (i, u, a) => ({ pairIndex: i, userText: u, assistantText: a });

    // 턴 1,2 기록 후 턴 1 을 리롤 → 턴 1 의 이전 variant 가 inactive_variant
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1'), pair(2, 'u2', 'a2')]);
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLL'), pair(2, 'u2', 'a2')]);
    const state = wl.get(scopeKey);

    const built = filterFn(state);
    // 주의: VM 경계를 넘으면 instanceof Set 이 깨진다 — 덕타이핑으로 확인한다.
    assert('filter_returns_counts',
      built && typeof built === 'object'
      && built.superseded && typeof built.superseded.has === 'function' && typeof built.superseded.size === 'number'
      && typeof built.liveTurns !== 'undefined',
      { keys: built ? Object.keys(built) : null, supersededSize: built?.superseded?.size });

    // 리롤된 턴 1 에는 **새 응답(active variant)이 살아 있으므로 제외하면 안 된다** —
    // 리롤 후의 응답은 유효한 사실이다. 이력으로 물러난 옛 variant 만 제외 대상이다.
    assert('keeps_rerolled_turn_when_new_variant_is_live', !built.superseded.has(1), {
      superseded: Array.from(built.superseded || []), liveTurns: Array.from(built.liveTurns || [])
    });
    // 현재 살아있는 턴 2 의 기억은 유지
    assert('keeps_active_turn', !built.superseded.has(2), {});
    // 월드라인에 없는 턴 99 는 유지 (과잉 제외 금지)
    assert('keeps_unknown_turn', !built.superseded.has(99), {});

    // ── 진짜 제외 대상: 잘려나간 턴 (롤백) ──
    // 턴 3 을 기록했다가 라이브에서 제거한다 → 그 턴엔 살아있는 variant 가 없다.
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLL'), pair(2, 'u2', 'a2'), pair(3, 'u3', 'a3')]);
    // 실제로 라이브에서 턴 3 을 제거한다 (롤백) — 그제야 orphaned 로 잡힌다.
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1-REROLL'), pair(2, 'u2', 'a2')]);
    const afterTrim = wl.get(scopeKey);
    const builtTrim = filterFn(afterTrim);
    assert('excludes_rolled_back_turn', builtTrim.superseded.has(3), {
      superseded: Array.from(builtTrim.superseded || [])
    });
    assert('keeps_live_turns_after_trim',
      !builtTrim.superseded.has(1) && !builtTrim.superseded.has(2),
      { superseded: Array.from(builtTrim.superseded || []) });

    // ── 기억 엔트리 필터가 실제로 제외하는가 ──
    const mem = (turn, text) => ({ key: `m${turn}`, comment: 'lmai_memory', content: `[META:{"t":${turn},"imp":8}]\n${text}` });
    const memFilter = wl.filterSupersededMemories([mem(1, '턴1기억'), mem(2, '턴2기억'), mem(3, '턴3기억')], afterTrim);
    assert('memory_filter_excludes_only_superseded',
      memFilter.excluded === 1 && memFilter.entries.length === 2
      && memFilter.entries.every(entry => !String(entry.content).includes('턴3기억')),
      { excluded: memFilter.excluded, turns: memFilter.excludedTurns, kept: memFilter.entries.map(e => e.key) });

    // 기록이 없으면 아무것도 제외하지 않는다
    const emptyBuilt = filterFn(wl.empty(scopeKey));
    assert('empty_worldline_excludes_nothing',
      emptyBuilt.superseded.size === 0, { size: emptyBuilt.superseded.size });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
