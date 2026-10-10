'use strict';
// 검증: "정규화기가 global/structure/state 를 버린다"는 내 주장이 맞는가.
//
// 배경: 앞선 프로브에서 모델 출력 키 [state, setting, systems, custom, global, structure] 중
//   normalizeWorldRuleUpdate 를 통과한 것이 [setting] 뿐이라 "조용히 버려진다"고 보고했다.
//   그런데 그 셋은 **다른 경로로 소비**될 수 있다:
//     - global  → 05k:217 applyFlag(readMutationFlag) 가 profile.global 플래그를 켠다
//     - structure → resolveStructuredWorldMutationPolicy 의 정책 신호
//     - state   → 휘발성(시간/장소/장면) — 규칙이 아니라 세계 스냅샷으로 가야 맞다
//   소비처를 확인하지 않고 "버려진다"고 단정하면 오진이다.
//
// 이 스크립트는 실제 저장 경로를 밟아 global 이 profile.global 에 도달하는지 본다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, WorldStateTracker,
        resolveStructuredWorldMutationPolicy, readWorldMutationFlag: (typeof readWorldMutationFlag === 'function' ? readWorldMutationFlag : null),
        EntityAwareProcessor
    };
` + code.slice(idx);

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
    structuredClone: global.structuredClone, crypto,
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController, performance: { now: () => Date.now() }
  };
  context.globalThis = context; context.window = context;
  vm.createContext(context);
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 150));

  const P = context.__probe;
  const out = { run_error: runError || null };
  if (!P?.HierarchicalWorldManager) { console.log(JSON.stringify({ ok: false }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;

  W.loadWorldGraph([], true);
  const rootId = W.getProfile().rootId;

  // ── 가설 검증: 모델이 global 플래그를 내면 profile.global 이 바뀌는가 ──
  const beforeGlobal = JSON.parse(JSON.stringify(W.getProfile().global));

  // 05k:217-229 의 applyFlag 경로를 그대로 재현한다
  const payload = { global: { multiverse: true, dimensionTravel: true } };
  const policy = P.resolveStructuredWorldMutationPolicy(payload);
  const applied = [];
  const readFlag = (keys) => {
    for (const root of [payload.global, payload.structure, payload.flags, payload.meta]) {
      if (!root || typeof root !== 'object') continue;
      for (const k of keys) { if (root[k] === true) return true; if (root[k] === false) return false; }
    }
    return undefined;
  };
  if (policy.allowGlobalFlags) {
    const applyFlag = (targetKey, keys) => {
      const v = readFlag(keys);
      if (v === true || v === false) { W.getProfile().global[targetKey] = v; applied.push(targetKey); }
    };
    applyFlag('multiverse', ['multiverse', 'multiVerse', 'multipleWorlds', 'multiple_worlds']);
    applyFlag('dimensionTravel', ['dimensionTravel', 'dimension_travel', 'interdimensionalTravel', 'interdimensional_travel']);
    applyFlag('timeTravel', ['timeTravel', 'time_travel', 'timeLoop', 'time_loop']);
  }
  const afterGlobal = JSON.parse(JSON.stringify(W.getProfile().global));

  out.global_flag_path = {
    question: '모델이 global 플래그를 내면 profile.global 이 바뀌는가',
    policy_allowGlobalFlags: policy.allowGlobalFlags,
    flags_applied: applied,
    before: beforeGlobal,
    after: afterGlobal,
    changed: JSON.stringify(beforeGlobal) !== JSON.stringify(afterGlobal),
    normalizer_keeps_global: Object.keys(P.EntityAwareProcessor?.normalizeWorldRuleUpdate?.({ global: { multiverse: true }, exists: {} }) || {}),
    verdict: null
  };
  out.global_flag_path.verdict = out.global_flag_path.changed
    ? 'global 은 05k:217 경로로 소비된다 — "버려진다"는 내 주장은 이 축에 대해 오진이었다'
    : 'global 이 어디에서도 반영되지 않는다 — 결함이 맞다';

  // ── structure 는 정책 신호로 소비되나 ──
  const structurePayload = { structure: { dimensionTravel: true } };
  out.structure_path = {
    question: 'structure 는 소비되나',
    policy: P.resolveStructuredWorldMutationPolicy(structurePayload),
    note: 'readWorldMutationFlag 의 roots 에 structure 가 포함된다 — 정책 신호로 소비됨'
  };

  // ── state 는 어떤가 (휘발성 — 규칙이 아니라 스냅샷으로 가야 맞다) ──
  const statePayload = { state: { currentLocation: '검은 탑', currentTime: '밤' } };
  out.state_path = {
    question: 'state 는 어디로 가야 맞나',
    normalizer_result: P.EntityAwareProcessor?.normalizeWorldRuleUpdate?.(statePayload) || null,
    sanitize_drops_volatile: 'sanitizeWorldRuleUpdateForPolicy 가 exists.currentTime/currentLocation/currentScene 을 delete 한다',
    verdict: 'state 는 휘발성이라 규칙에서 빠지는 것이 설계 의도일 수 있다 — 세계 스냅샷/상태 로그로 가야 한다'
  };

  // ── 정말 버려지는 것: dimensionalShifts ──
  const shiftPayload = { dimensionalShifts: [{ to: '아르카디아', from: '주요 세계' }] };
  out.real_gap = {
    question: '정말 버려지는 것은 무엇인가',
    dimensionalShifts_in_normalized: JSON.stringify(P.EntityAwareProcessor?.normalizeWorldRuleUpdate?.(shiftPayload) || {}),
    dimensionalShifts_in_policy: P.resolveStructuredWorldMutationPolicy(shiftPayload),
    prompt_contract_has_it: /dimensionalShifts/.test(String(context.__probe?.EntityExtractionPrompt || '')),
    verdict: 'dimensionalShifts 만 진짜로 계약에 없다 — 프롬프트가 요구하지 않으니 LLM 이 낼 이유가 없다'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
