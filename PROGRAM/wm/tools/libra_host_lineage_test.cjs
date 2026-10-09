'use strict';
// Gate: 네이티브 브랜치 감지 — RisuAI 가 채팅에 남긴 분기 표식을 읽어 계보를 세운다.
//
// 배경: Downloads/plugins 의 최신 플러그인이 쓰는 LIBRARIAN HOST LINEAGE SDK v1
// 을 실측했다. RisuAI 는 채팅을 분기할 때 자식 채팅에 **주석 메시지**를 남긴다:
//
//   {{specialcomment::branchedfrom::<parentChatId>::<parentName>::<forkMessageId>::}}
//
//   - isComment === true, disabled === true, role === 'assistant' 인 메시지만 유효
//     (RP 대사 안에 인용된 문자열은 계보를 세우면 안 된다)
//   - 부모/자식의 공통 접두 길이가 표식 위치와 정확히 일치해야 verified
//   - fmIndex(greeting 선택)가 부모와 다르면 diverged
//   - 부모를 찾을 수 없으면 unverified (계보 상속 불가)
//
// LIBRA 는 이 처리가 전혀 없어, 브랜치한 채팅이 부모 기억을 물려받지 못한다.
// 이 게이트가 그 계약을 고정한다.
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
      for (const child of (el.children || [])) stack.push(child);
    }
    return null;
  }
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  // 부모 채팅 (턴 3개)
  const parentChat = {
    id: 'chat-parent', fmIndex: 0,
    message: [
      { role: 'user', data: 'u1', chatId: 'p#1' },
      { role: 'assistant', data: 'a1', chatId: 'p#2' },
      { role: 'user', data: 'u2', chatId: 'p#3' },
      { role: 'assistant', data: 'a2', chatId: 'p#4' },
      { role: 'user', data: 'u3', chatId: 'p#5' },
      { role: 'assistant', data: 'a3', chatId: 'p#6' }
    ]
  };
  // 자식 채팅: 부모의 턴 1~3 을 그대로 이어받고, 표식이 4번째(인덱스 3)에 있다.
  const childMessages = [
    { role: 'user', data: 'u1', chatId: 'p#1' },
    { role: 'assistant', data: 'a1', chatId: 'p#2' },
    { role: 'user', data: 'u2', chatId: 'p#3' },
    { role: 'assistant', data: 'a2', chatId: 'p#4' },
    { role: 'assistant', isComment: true, disabled: true, data: '{{specialcomment::branchedfrom::chat-parent::부모채팅::p#4::}}' },
    { role: 'user', data: 'u4', chatId: 'c#1' },
    { role: 'assistant', data: 'a4', chatId: 'c#2' }
  ];
  const childChat = { id: 'chat-child', fmIndex: 0, message: childMessages };
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [parentChat, childChat], globalLore: [] };
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
    async getCurrentChatIndex() { return 1; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return childChat; },
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

  const hl = context.LibraHostLineage || null;
  assert('host_lineage_module_exported', !!hl, {
    candidates: Object.keys(context).filter(k => /lineage/i.test(k))
  });

  if (!hl) {
    for (const n of ['detects_branch_marker', 'quoted_marker_is_not_lineage',
      'verified_only_when_prefix_matches', 'missing_parent_is_unverified',
      'greeting_change_is_diverged', 'inheritance_eligible_only_when_verified',
      'reports_path_and_common_prefix']) assert(n, false, { reason: 'no module' });
  } else {
    const info = hl.inspect(character, childChat);
    assert('detects_branch_marker',
      info.kind === 'native_branch' && info.parentChatId === 'chat-parent' && info.forkMessageId === 'p#4',
      { kind: info.kind, parent: info.parentChatId, fork: info.forkMessageId });

    assert('reports_path_and_common_prefix',
      info.commonPrefixMessages === 4 && info.commonPrefixPairs === 2 && Array.isArray(info.path) && info.path.length === 2,
      { prefix: info.commonPrefixMessages, pairs: info.commonPrefixPairs, path: info.path });

    assert('verified_only_when_prefix_matches',
      info.status === 'verified' && info.pathVerified === true,
      { status: info.status, reason: info.reason, verified: info.pathVerified });

    assert('inheritance_eligible_only_when_verified', info.inheritanceEligible === true, {
      eligible: info.inheritanceEligible
    });

    // RP 대사 안에 인용된 표식은 계보가 아니다 (isComment/disabled 가 아님)
    const quotedChat = {
      id: 'chat-quoted', fmIndex: 0,
      message: [
        { role: 'user', data: 'u1' },
        { role: 'assistant', data: '대사 중 "{{specialcomment::branchedfrom::x::y::z::}}" 라고 말했다' }
      ]
    };
    const quoted = hl.inspect(character, quotedChat);
    assert('quoted_marker_is_not_lineage',
      quoted.kind === 'independent_chat' && quoted.status === 'independent',
      { kind: quoted.kind, status: quoted.status });

    // 부모가 없으면 unverified (상속 불가)
    const orphanChat = {
      id: 'chat-orphan', fmIndex: 0,
      message: [
        { role: 'assistant', isComment: true, disabled: true, data: '{{specialcomment::branchedfrom::chat-missing::사라진부모::p#9::}}' }
      ]
    };
    const orphan = hl.inspect(character, orphanChat);
    assert('missing_parent_is_unverified',
      orphan.status === 'unverified' && orphan.inheritanceEligible === false,
      { status: orphan.status, reason: orphan.reason });

    // fmIndex 가 다르면 diverged
    const divergedChat = { ...childChat, id: 'chat-child', fmIndex: 1 };
    const diverged = hl.inspect(character, divergedChat);
    assert('greeting_change_is_diverged',
      diverged.status === 'diverged' && diverged.inheritanceEligible === false,
      { status: diverged.status, reason: diverged.reason });

    // ── 브랜치 상속: verified 계보면 자식이 부모 데이터를 물려받는다 ──
    const storage = context.LibraDataStorage;
    if (!storage || typeof storage.inheritFromBranch !== 'function') {
      assert('verified_branch_inherits_parent_data', false, { reason: 'inheritFromBranch 없음' });
      assert('parent_data_is_preserved', false, {});
      assert('non_branch_does_not_inherit', false, {});
    } else {
      // 부모 스코프에 데이터를 심는다
      const parentEntry = { key: 'mem-parent-1', comment: 'lmai_memory', content: '[META:{"t":1,"imp":8}]\n부모의 기억' };
      await storage.save(character, parentChat, [parentEntry]);
      const parentBefore = storage.getShadowEntries(storage.scopeKeyFor(character, parentChat)).length;

      const inheritResult = await storage.inheritFromBranch(character, childChat);
      const childEntries = storage.getShadowEntries(storage.scopeKeyFor(character, childChat));
      assert('verified_branch_inherits_parent_data',
        inheritResult?.ok === true && childEntries.length === 1
        && String(childEntries[0]?.content || '').includes('부모의 기억'),
        { result: inheritResult, childCount: childEntries.length });

      // 브랜치는 분기지 이동이 아니다 — 부모 데이터는 그대로 남아야 한다
      const parentAfter = storage.getShadowEntries(storage.scopeKeyFor(character, parentChat)).length;
      assert('parent_data_is_preserved', parentAfter === parentBefore && parentAfter > 0, {
        before: parentBefore, after: parentAfter
      });

      // 표식 없는 독립 채팅은 상속하지 않는다
      const independentChat = { id: 'chat-independent', fmIndex: 0, message: [{ role: 'user', data: 'x' }] };
      const noneResult = await storage.inheritFromBranch(character, independentChat);
      const noneEntries = storage.getShadowEntries(storage.scopeKeyFor(character, independentChat));
      assert('non_branch_does_not_inherit',
        noneResult?.inherited === 0 && noneEntries.length === 0,
        { result: noneResult, count: noneEntries.length });
    }
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
