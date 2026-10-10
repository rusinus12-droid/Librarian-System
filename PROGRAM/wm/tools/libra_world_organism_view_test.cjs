'use strict';
// Gate: 세계가 인물을 본다 (1단계 — 세포-개체 모델)
//
// 사용자 결정(2026-09-29):
//   "세계가 마치 큰 범위의 인물인 거처럼 살아움직이게끔 만들자.
//    세포는 인물이고 그것이 모인 게 세계인 거지."
//   + 착수 승인: ① 집단 임계는 LLM 판단(A), ② 인물이 세계에 속한다(A)
//
// 실측된 결함(수정 전):
//   - 05k:406-414 의 worldSnapshot 은 규칙·global·분류·요약만 본다 → 인물을 읽지 않는다
//   - 인물 상태를 바꿔도 세계 상태 로그가 변하지 않는다(world_state_changed_by_entity_change: false)
//   - 09d normalizeWorldStateEntry 는 화이트리스트라 모르는 필드를 버린다
//   - 09d 번들 system 은 "각자 요약"만 지시한다 — "둘의 관계"를 요구하지 않는다
//
// 이 게이트가 고정하는 계약:
//   E1 세계 스냅샷이 인물(세포)을 담는다
//   E2 세계 상태 로그 항목이 인물을 보존한다 (화이트리스트 통과)
//   E3 세계 로그 텍스트에 인물이 나타난다 (LLM 이 볼 수 있다)
//   E4 인물이 바뀌면 세계 로그 항목이 달라진다 (개체가 세포를 인식)
//   E5 인물이 없으면 필드가 비어 있다 (빈 값을 만들지 않는다)
//   E6 상한이 있다 (인물이 많아도 로그가 폭발하지 않는다)
//   E7 번들 system 이 "개체 관점"을 요구한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probeHWM = HierarchicalWorldManager; globalThis.__probeWST = WorldStateTracker;\n' + code.slice(idx);

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
  remove() {} addEventListener(n, f) { this.listeners[n] = f; }
  removeEventListener() {} focus() {} blur() {} click() {}
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)]; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); this.readyState = 'complete'; }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(t) { const e = new FakeElement('#text', this); e.textContent = t; return e; }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(sel) { if (sel === 'head') return this.head; if (sel === 'body') return this.body; return null; }
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], msgs: [], message: [], bindedPersona: 'p1' };
  character.chats = [chat];
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
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 130));
  assert('dist_runs_without_error', !runError, { error: runError });

  const W = context.__probeHWM;
  const WS = context.__probeWST;
  assert('trackers_exported', !!W && !!WS, { world: !!W, worldState: !!WS });

  const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/09d-section-character-world-state.js'), 'utf8');
  const SRC05K = fs.readFileSync(path.join(ROOT, 'src/parts/05k-narrative-turn-processing.js'), 'utf8');

  if (!W || !WS) {
    for (const n of ['world_snapshot_carries_entities', 'world_log_entry_preserves_entities',
      'world_log_text_shows_entities', 'entity_change_alters_world_entry',
      'no_entities_means_empty_field', 'entities_are_capped', 'bundle_prompt_asks_for_organism_view']) {
      assert(n, false, { reason: 'no module' });
    }
  } else {
    W.loadWorldGraph([], true);
    const rootId = W.getProfile().rootId;

    // ── E1: 세계 스냅샷이 인물을 담는가 ──
    // 05k 의 worldSnapshot 형태를 그대로 만들어 인물 축을 넣는다.
    const snapshotWithEntities = {
      activePath: [rootId],
      rules: { setting: { places: ['왕도'] } },
      global: {},
      classification: 'dark-fantasy',
      worldSummary: '마력이 일상인 세계',
      ruleHighlights: ['장소/시설: 왕도'],
      notes: '',
      presentEntities: [
        { name: '아리엘', location: '검은 탑', health: '부상' },
        { name: '카일', location: '왕도', health: '건강' }
      ]
    };
    WS.resetState(null);
    WS.recordState(10, snapshotWithEntities);
    const state1 = WS.getState();
    const entry1 = state1?.turnLog?.[0] || {};
    assert('world_log_entry_preserves_entities',
      Array.isArray(entry1.presentEntities) && entry1.presentEntities.length === 2,
      { presentEntities: entry1.presentEntities, entry_keys: Object.keys(entry1) });

    // ── E3: 세계 로그 텍스트에 인물이 나타나는가 (LLM 이 보는 것) ──
    const logText = String(entry1.logText || '') || (() => {
      // describeWorldStateEntry 는 내부 함수 — 로그 텍스트가 항목에 없으면 게이트가 FAIL 해야 한다
      return '';
    })();
    const formatted = (() => { try { return WS.formatForPrompt?.() || ''; } catch { return ''; } })();
    assert('world_log_text_shows_entities',
      /아리엘|카일/.test(logText) || /아리엘|카일/.test(formatted),
      { logText: logText.slice(0, 200), formatted: formatted.slice(0, 300) });

    // ── E4: 인물이 바뀌면 세계 로그 항목이 달라지는가 ──
    WS.recordState(11, {
      ...snapshotWithEntities,
      presentEntities: [
        { name: '아리엘', location: '왕도', health: '건강' },
        { name: '카일', location: '왕도', health: '건강' },
        { name: '미르', location: '북부 변경', health: '건강' }
      ]
    });
    const state2 = WS.getState();
    const entry2 = state2?.turnLog?.[1] || {};
    const differs = JSON.stringify(entry1.presentEntities) !== JSON.stringify(entry2.presentEntities);
    assert('entity_change_alters_world_entry', differs,
      { e1: entry1.presentEntities, e2: entry2.presentEntities });

    // ── E5: 인물이 없으면 빈 값을 만들지 않는다 ──
    WS.resetState(null);
    WS.recordState(12, { activePath: [rootId], rules: {}, global: {}, ruleHighlights: [], notes: '' });
    const entry3 = WS.getState()?.turnLog?.[0] || {};
    assert('no_entities_means_empty_field',
      Array.isArray(entry3.presentEntities) ? entry3.presentEntities.length === 0 : entry3.presentEntities === undefined || entry3.presentEntities === null,
      { presentEntities: entry3.presentEntities });

    // ── E6: 상한이 있는가 ──
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `인물${i}`, location: '왕도', health: '건강' }));
    WS.resetState(null);
    WS.recordState(13, { ...snapshotWithEntities, presentEntities: many });
    const entry4 = WS.getState()?.turnLog?.[0] || {};
    const cap = Array.isArray(entry4.presentEntities) ? entry4.presentEntities.length : 0;
    assert('entities_are_capped', cap > 0 && cap <= 16,
      { input: 40, stored: cap, note: '상한 16 이하' });

    // ── E7: 번들 system 이 개체 관점을 요구하는가 ──
    // "각자 요약" 만 있고 "인물들의 움직임이 세계에 주는 변화" 를 요구하지 않으면 RED.
    // 앵커: 번들 system 배열 시작부터 join 까지 (사이에 주석이 들어갈 수 있으므로 넉넉히).
    const bundleStart = SRC.indexOf('You are LIBRA State Consolidation Bundler');
    const bundleEnd = bundleStart >= 0 ? SRC.indexOf("].join('\\n')", bundleStart) : -1;
    const bundleSystem = (bundleStart >= 0 && bundleEnd > bundleStart) ? SRC.slice(bundleStart, bundleEnd) : '';
    const asksOrganismView = /as an organism|whose cells are the characters|movements change the world|how the characters/i.test(bundleSystem);
    assert('bundle_prompt_asks_for_organism_view', asksOrganismView,
      { found: asksOrganismView, bundle_chars: bundleSystem.length, system_head: bundleSystem.slice(0, 260) });

    // ── E8: 05k 의 worldSnapshot 이 실제로 인물을 담는가 (배선) ──
    // 05k 는 하나의 큰 async 파이프라인이라 단독 호출이 어렵다 — 여기서는 **배선**을 본다.
    // 값이 담기는지는 E1~E4(09d 실행)가 검사하고, 이 단언은 "그 값을 만드는 코드가 있는가"를 본다.
    // (실측 한계를 details 에 밝힌다 — 실행이 아니라 배선 검사다.)
    const snapshotBlock = (() => {
      const i = SRC05K.indexOf('const worldSnapshot = {');
      if (i < 0) return '';
      const j = SRC05K.indexOf('};', i);
      return j > i ? SRC05K.slice(i, j) : '';
    })();
    const wiresEntities = /presentEntities\s*:/.test(snapshotBlock);
    assert('world_snapshot_wires_entities', wiresEntities,
      { wired: wiresEntities, block_chars: snapshotBlock.length,
        note: '배선 검사(실행 아님) — 값 보존은 E1~E4 가 검사한다' });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
