'use strict';
// Gate: 리롤 시 이전 응답의 기억이 회상에서 제외되는가.
//
// 사용자 의문으로 측정한 결함 (재현됨):
//   턴 1 커밋(응답 A) → 리롤(응답 B) → 저장소 2건 누적
//   → 회상 필터가 **둘 다 통과시킴** (0건 제외)
//   → "왕이 죽었다"(A)와 "왕은 살아있다"(B)가 동시에 프롬프트에 실린다
//
// 원인: 기억 메타에는 사용자 메시지 해시(sourceHash)만 있고 **어느 응답에서
// 나왔는지(응답 해시)** 가 없다. 월드라인은 노드로 리롤을 알지만, 그 정보를
// 기억까지 끌어내릴 연결고리가 없다.
//
// 고치는 방법: 턴 커밋 시 기억 메타에 **응답 지문(assistantHash)** 을 심고,
// 회상 필터가 그 지문을 현재 살아있는 variant 의 지문과 대조한다.
// 일치하지 않으면 = 다른 응답의 기억 = 리롤로 폐기된 것 → 제외.
//
// 이 게이트가 고정하는 계약:
//   A. 기억 메타에 응답 지문을 심는 API 가 있다
//   B. 리롤 후 옛 응답의 기억이 회상에서 제외된다
//   C. 리롤 후 현재 응답의 기억은 남는다
//   D. 지문이 없는 옛 기억은 제외하지 않는다 (과잉 제외 금지 — 하위 호환)
//   E. 응답이 바뀌지 않았으면 아무것도 제외하지 않는다 (오탐 방지)
//   F. 롤백(턴 잘림) 제외는 계속 동작한다 (기존 계약 유지)
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
  const chat = { id: 'chat-1', localLore: [], message: [], msgs: [], bindedPersona: 'p1' };
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [chat], globalLore: [], lorebook: [] };
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
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getCharacter() { return character; },
    async getDatabase() { return { selectedPersona: 0, personas: [{ id: 'p1' }] }; },
    async setCharacter() {}, async setCharacterToIndex() {}, async setChatToIndex() {},
    async registerSetting() {}, async registerButton() {},
    async requestPluginPermission() { return true; },
    async showContainer() {}, async hideContainer() {}, async onUnload() {}
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    globalThis: null, window: null, document, Risuai: R, risuai: R,
    structuredClone, fetch: async () => { throw new Error('no fetch'); },
    AbortController, performance: { now: () => Date.now() }
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  let runError = '';
  try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  assert('dist_runs_without_error', !runError, { error: runError });

  const wl = ctx.LibraTurnWorldline || null;
  const storage = ctx.LibraDataStorage || null;
  const stamper = wl && typeof wl.stampMemoryVariant === 'function' ? wl.stampMemoryVariant : null;
  assert('memory_variant_stamper_exists', typeof stamper === 'function', {
    worldlineKeys: wl ? Object.keys(wl) : null
  });

  if (typeof stamper !== 'function' || !storage) {
    for (const n of ['reroll_excludes_old_response_memory', 'reroll_keeps_current_response_memory',
      'unstamped_memory_is_not_excluded', 'no_false_positive_when_response_unchanged',
      'rollback_exclusion_still_works']) assert(n, false, { reason: 'no stamper' });
  } else {
    const scopeKey = storage.scopeKeyFor(character, chat, null);
    const pair = (i, u, a) => ({ pairIndex: i, userText: u, assistantText: a });
    const baseMem = (turn, text) => ({ key: `mem_t${turn}`, comment: 'lmai_memory', content: `[META:{"t":${turn},"turn":${turn},"imp":8}]\n${text}` });

    // 턴 1 커밋 (응답 A) — 기억에 응답 지문을 심는다
    await wl.observe(scopeKey, [pair(1, 'u1', '응답A')]);
    const stampA = wl.memoryVariantStamp(scopeKey, 1, '응답A');
    const memA = stamper(baseMem(1, '왕이 죽었다'), stampA);
    log('스탬프 A:', JSON.stringify(stampA));

    let state = wl.get(scopeKey);
    let kept = wl.filterSupersededMemories([memA], state);
    assert('baseline_memory_is_kept', kept.excluded === 0, { excluded: kept.excluded });

    // 리롤: 턴 1 을 응답 B 로
    await wl.observe(scopeKey, [pair(1, 'u1', '응답B')]);
    const stampB = wl.memoryVariantStamp(scopeKey, 1, '응답B');
    const memB = stamper(baseMem(1, '왕은 살아있다'), stampB);
    state = wl.get(scopeKey);

    const filtered = wl.filterSupersededMemories([memA, memB], state);
    assert('reroll_excludes_old_response_memory',
      filtered.entries.length === 1 && filtered.entries[0].key === memB.key,
      { kept: filtered.entries.map(e => e.key), excluded: filtered.excluded });

    assert('reroll_keeps_current_response_memory',
      filtered.entries.some(e => e.key === memB.key), {});

    // 지문 없는 옛 기억은 제외하지 않는다 (하위 호환)
    const legacyMem = baseMem(1, '지문 없는 옛 기억');
    const legacyFiltered = wl.filterSupersededMemories([legacyMem], state);
    assert('unstamped_memory_is_not_excluded',
      legacyFiltered.excluded === 0 && legacyFiltered.entries.length === 1,
      { excluded: legacyFiltered.excluded });

    // 응답이 안 바뀌었으면 아무것도 제외하지 않는다
    const filteredSame = wl.filterSupersededMemories([memB], state);
    assert('no_false_positive_when_response_unchanged',
      filteredSame.excluded === 0, { excluded: filteredSame.excluded });

    // 롤백(턴 잘림) 제외는 계속 동작
    await wl.observe(scopeKey, [pair(1, 'u1', '응답B'), pair(2, 'u2', '응답2')]);
    const mem2 = stamper(baseMem(2, '턴2 기억'), wl.memoryVariantStamp(scopeKey, 2, '응답2'));
    await wl.observe(scopeKey, [pair(1, 'u1', '응답B')]);
    const stateRb = wl.get(scopeKey);
    const filteredRb = wl.filterSupersededMemories([memB, mem2], stateRb);
    assert('rollback_exclusion_still_works',
      filteredRb.excluded === 1 && !filteredRb.entries.some(e => e.key === mem2.key),
      { excluded: filteredRb.excluded, turns: filteredRb.excludedTurns });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);

  function log(...a) { /* 진단 출력은 assert details 로 */ }
})();
