'use strict';
// Metadata-only source-ownership contract after the user's 2026-10-06 retirement request.
// Known native disappearance is excluded; unchanged-ID original text edits stay analyzed.
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
  const detect = wl && typeof wl.detectDrift === 'function' ? wl.detectDrift : null;
  assert('drift_detector_exists', typeof detect === 'function', {
    worldlineKeys: wl ? Object.keys(wl) : null
  });

  if (typeof detect !== 'function') {
    for (const n of ['detects_rolled_back_turn', 'detects_reroll_at_same_position',
      'no_false_positive_on_unchanged', 'detection_does_not_delete_data',
      'reports_reason_labels']) assert(n, false, { reason: 'no detector' });
  } else {
    const scopeKey = 'char:char-1|chat:chat-1|persona:p1';
    const pair = (i, u, a) => ({ pairIndex: i, userText: u, assistantText: a, userMessageId: 'u-'+i, assistantMessageId: 'a-'+i });

    // 3턴을 기록
    await wl.observe(scopeKey, [pair(1, 'u1', 'a1'), pair(2, 'u2', 'a2'), pair(3, 'u3', 'a3')], {explicitReanalysis:true,sourceVerified:true});

    // ── 무변경: 아무것도 보고하지 않는다 ──
    const noChange = detect(scopeKey, [pair(1, 'u1', 'a1'), pair(2, 'u2', 'a2'), pair(3, 'u3', 'a3')]);
    assert('no_false_positive_on_unchanged',
      noChange?.changed === false && Array.isArray(noChange?.rolledBack) && noChange.rolledBack.length === 0
      && Array.isArray(noChange?.rerolled) && noChange.rerolled.length === 0,
      { result: noChange && { changed: noChange.changed, rolledBack: noChange.rolledBack?.length, rerolled: noChange.rerolled?.length } });

    // ── 롤백: 턴 2,3 이 사라짐 ──
    const rolledBack = detect(scopeKey, [pair(1, 'u1', 'a1')]);
    assert('detects_rolled_back_turn',
      rolledBack?.changed === true && rolledBack.rolledBack.length === 2
      && rolledBack.rolledBack.every(item => item.pairIndex >= 2),
      { result: rolledBack && { changed: rolledBack.changed, items: rolledBack.rolledBack?.map(i => i.pairIndex) } });

    // ── 리롤: 턴 1 의 응답만 바뀜 (턴 2,3 은 그대로) ──
    const rerolled = detect(scopeKey, [pair(1, 'u1', 'a1-REROLL'), pair(2, 'u2', 'a2'), pair(3, 'u3', 'a3')]);
    assert('same_native_id_text_edit_is_not_automatically_detected',
      rerolled?.changed === false && rerolled.rerolled.length === 0 && rerolled.rolledBack.length === 0,
      { result: rerolled && { rerolled: rerolled.rerolled?.map(i => i.pairIndex), rolledBack: rerolled.rolledBack?.length } });

    const replaced = detect(scopeKey, [pair(1, 'u1', 'a1'), {...pair(2, 'u2', 'a2'), assistantMessageId:'replacement-a2'}, pair(3, 'u3', 'a3')]);
    assert('native_id_replacement_excludes_old_ownership', replaced.changed && replaced.rolledBack.length === 1 && replaced.rolledBack[0].pairIndex === 2);

    // ── 감지는 보고만 한다 (데이터를 지우지 않는다) ──
    const before = wl.get(scopeKey);
    detect(scopeKey, [pair(1, 'u1', 'a1')]);
    const after = wl.get(scopeKey);
    assert('detection_does_not_delete_data',
      before.nodes.length === after.nodes.length,
      { before: before.nodes.length, after: after.nodes.length });

    // ── 사유 라벨 ──
    assert('reports_reason_labels',
      rolledBack.rolledBack.every(item => typeof item.reason === 'string' && item.reason.length > 0)
      && rerolled.rerolled.every(item => typeof item.reason === 'string' && item.reason.length > 0),
      {
        rolledBackReasons: rolledBack.rolledBack.map(i => i.reason),
        rerolledReasons: rerolled.rerolled.map(i => i.reason)
      });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
