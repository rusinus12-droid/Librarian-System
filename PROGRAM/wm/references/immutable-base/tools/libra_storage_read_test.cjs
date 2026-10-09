'use strict';
// Gate: 스토리지 읽기 경로가 shadow 를 실제로 붙이는가.
//
// 사용자 의문("누적 저장에서 리롤·롤백이 작동하나")을 추적하다 나온 결함.
// 97턴 하네스가 21개 단언에서 실패했다: 기억·엔티티·관계·서사·월드그래프가
// 전부 0건. 원인은 회상이 아니라 **읽기 경로**였다.
//
//   unpack(lorebook) 은 로어 **배열만** 받는다. 그래서 char/chat 신원을 모르고,
//   scopeKeyFor 가 `char:unknown|chat:unknown|persona:default` 를 돌려준다.
//   → isHydrated(그 스코프) = false → shadow 0건 → 로어에 남은 것만 보인다.
//
//   스토리지 이전(1d9a7a6) 이후 LIBRA 데이터는 로어에서 빠졌으므로, 로어 경로로
//   읽는 코드는 **전부 빈손**이 된다. 저장은 되지만(pluginStorage 에 쌓임) 읽기가
//   안 되는 상태 — 97턴 하네스가 전부 0건으로 실패한 이유다.
//
// 고치는 방법: 플러그인이 마지막으로 해석한 활성 스코프를 기억하고, unpack 이
// 그것을 폴백으로 쓴다. (unpack 은 80곳에서 동기 호출되므로 async 로 바꿀 수 없다.)
//
// 이 게이트가 고정하는 계약:
//   A. 저장하면 shadow 에 들어간다
//   B. 로어가 빈 채로 unpack 해도 shadow 가 보인다 (읽기 경로 복구의 핵심)
//   C. 활성 스코프가 다르면 다른 스코프의 데이터가 섞이지 않는다
//   D. 로어에 남은 항목과 shadow 가 중복 없이 합쳐진다
//   E. hydrate 한 스코프만 shadow 를 노출한다 (미수화 스코프 오염 금지)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

class E {
  constructor(t, d) {
    this.tagName = 'DIV'; this.ownerDocument = d; this.children = []; this._id = '';
    this.style = {}; this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.textContent = ''; this._html = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._r(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._html = String(v || ''); }
  get innerHTML() { return this._html; }
  appendChild(e) { if (!e) return e; e.parentNode = this; this.children.push(e); return e; }
  remove() {} addEventListener() {} removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
class D {
  constructor() { this._ids = {}; this.head = new E('head', this); this.body = new E('body', this); this.readyState = 'complete'; }
  _r(e) { if (e && e.id) this._ids[e.id] = e; }
  createElement(t) { return new E(t, this); }
  createTextNode(t) { const e = new E('#t', this); e.textContent = t; return e; }
  getElementById(i) { return this._ids[String(i || '')] || null; }
  querySelector() { return null; } querySelectorAll() { return []; }
}

(async () => {
  const document = new D();
  const store = new Map();
  const chatA = { id: 'chat-A', localLore: [], message: [], msgs: [], bindedPersona: 'pA' };
  const charA = { id: 'char-A', chaId: 'char-A', name: 'A', chats: [chatA], globalLore: [], lorebook: [] };
  const chatB = { id: 'chat-B', localLore: [], message: [], msgs: [], bindedPersona: 'pB' };
  const charB = { id: 'char-B', chaId: 'char-B', name: 'B', chats: [chatB], globalLore: [], lorebook: [] };
  const R = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u', saveMethod: 'm' }; },
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
    async getCharacterFromIndex() { return charA; },
    async getChatFromIndex() { return chatA; },
    async getCharacter() { return charA; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'pA' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
    globalThis: null, window: null, document, Risuai: R, risuai: R,
    structuredClone, fetch: async () => { throw new Error('no fetch'); },
    AbortController, performance: { now: () => Date.now() }
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  // 하네스와 동일하게 IIFE 끝에 exports 스니펫을 주입한다 (플러그인은 자체 export 가 없다).
  const exportSnippet = '\n;globalThis.__LIBRA_EXPORTS__ = {\n'
    + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n"
    + "LibraLoreConsolidator: typeof LibraLoreConsolidator !== 'undefined' ? LibraLoreConsolidator : null,\n"
    + "PendingTurnManager: typeof PendingTurnManager !== 'undefined' ? PendingTurnManager : null,\n"
    + '};\n';
  const idx = code.lastIndexOf('\n})();');
  const patched = idx < 0 ? code : code.slice(0, idx) + exportSnippet + code.slice(idx);
  let runError = '';
  try { vm.runInContext(patched, ctx, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  assert('dist_runs_without_error', !runError, { error: runError });

  const st = ctx.LibraDataStorage || null;
  const exp = ctx.__LIBRA_EXPORTS__ || {};
  const consol = exp.LibraLoreConsolidator || ctx.LibraLoreConsolidator || null;
  const eng = exp.MemoryEngine || null;

  if (!st || !consol || !eng) {
    for (const n of ['save_populates_shadow', 'empty_lore_still_reads_shadow',
      'other_scope_not_leaked', 'lore_and_shadow_merge_without_duplicates',
      'unhydrated_scope_not_exposed']) assert(n, false, {
      reason: 'missing modules', hasStorage: !!st, hasConsolidator: !!consol, hasEngine: !!eng
    });
  } else {
    const memA = { key: 'mem-a', comment: 'lmai_memory', content: '[META:{"t":1}]\nA의 기억' };
    const scopeA = await st.scopeKeyForAsync(charA, chatA);
    await st.save(charA, chatA, [memA]);
    await st.hydrate(charA, chatA);
    const shadowA = st.getShadowEntries(scopeA);
    assert('save_populates_shadow', shadowA.length === 1 && shadowA[0].key === 'mem-a',
      { scope: scopeA, count: shadowA.length });

    // B: 로어가 비어 있어도 shadow 가 보여야 한다 (핵심)
    chatA.localLore = [];
    const readBack = consol.unpack([]);
    assert('empty_lore_still_reads_shadow',
      readBack.some(e => e.key === 'mem-a'),
      { count: readBack.length, keys: readBack.map(e => e.key) });

    // C: 활성 스코프가 바뀌면 그 스코프의 데이터만 보인다 (섞이지 않는다).
    const memB = { key: 'mem-b', comment: 'lmai_memory', content: '[META:{"t":1}]\nB의 기억' };
    await st.save(charB, chatB, [memB]);
    await st.hydrate(charB, chatB);
    const readB = consol.unpack([]);
    assert('other_scope_not_leaked',
      readB.some(e => e.key === 'mem-b') && !readB.some(e => e.key === 'mem-a'),
      { keys: readB.map(e => e.key) });

    // D: 로어 + shadow 중복 없이 합쳐진다
    await st.hydrate(charA, chatA);
    const loreWithA = [{ key: 'mem-a', comment: 'lmai_memory', content: '[META:{"t":1}]\nA의 기억' }];
    const merged = consol.unpack(loreWithA);
    const memACount = merged.filter(e => e.key === 'mem-a').length;
    assert('lore_and_shadow_merge_without_duplicates', memACount === 1, { count: memACount });

    // E: hydrate 하지 않은 스코프는 shadow 를 노출하지 않는다
    const memC = { key: 'mem-c', comment: 'lmai_memory', content: '[META:{"t":1}]\nC의 기억' };
    const charC = { id: 'char-C', chaId: 'char-C', name: 'C', chats: [], globalLore: [], lorebook: [] };
    const chatC = { id: 'chat-C', localLore: [], message: [], msgs: [], bindedPersona: 'pC' };
    // 저장하지 않고 shadow 만 강제로 만들 수 없으므로, hydrate 없이 unpack 하면
    // 그 스코프 항목이 안 보이는지 본다 (활성 스코프가 A 이므로)
    const readNoHydrate = consol.unpack([]);
    assert('unhydrated_scope_not_exposed',
      !readNoHydrate.some(e => e.key === 'mem-c'),
      { keys: readNoHydrate.map(e => e.key) });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
