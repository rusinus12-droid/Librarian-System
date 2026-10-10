'use strict';
// 실측: 세계 계층이 실제 주입에서 기억과 얼마나 중복되는가.
//
// 사용자 진단: "템플릿 방식은 오작동, 메모리 방식은 중복이었다."
//   → ① 오작동은 별도 프로브에서 확정(heuristic probe).
//     ② 중복은 아직 미측정이다. 이 스크립트가 그걸 잰다.
//
// 배경(정적): 13c 는 세계 관련 주입을 5개 슬롯으로 따로 넣는다 —
//   worldPrompt(HierarchicalWorld) / worldStatePrompt(WorldStateTracker) /
//   sectionWorldPrompt(SectionWorldInference) / narrativePrompt(NarrativeTracker) /
//   worldAdditionalPrompt(WorldAdditionalCore).
//   그리고 1128행에서 worldCodexPrompt 가 그 5개 전체를 uniqueAgainst 로 받는다.
//
// 측정: 실제 beforeRequest 를 돌려 주입 텍스트를 얻고, 어절 겹침으로 중복을 센다.
//   판정 기준은 소스 정규식이 아니라 실제 문자열이다(스킬: 판정은 실행으로).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, WorldStateTracker, NarrativeTracker,
        WorldAdditionalCore, SectionWorldInferenceManager,
        getActiveManagedRuntimeScopeKey
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

const tokens = (s) => String(s || '')
  .replace(/[\[\]【】(){}"'`·•\-—–:：,，.。/]/g, ' ')
  .split(/\s+/)
  .map(t => t.trim())
  .filter(t => t.length >= 2);

const overlap = (a, b) => {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  const shared = [...A].filter(t => B.has(t));
  return { shared: shared.length, aSize: A.size, bSize: B.size, ratio: A.size ? shared.length / A.size : 0, sample: shared.slice(0, 12) };
};

(async () => {
  const document = new FakeDocument();
  const pluginStorage = new Map();
  const character = { id: 'char-1', chaId: 'char-1', name: 'T', chats: [], globalLore: [] };
  const chat = { id: 'chat-1', localLore: [], msgs: [], message: [], bindedPersona: 'p1' };
  character.chats = [chat];
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument() { return undefined; },
    pluginStorage: {
      async getItem(k) { return pluginStorage.has(k) ? pluginStorage.get(k) : null; },
      async setItem(k, v) { pluginStorage.set(k, String(v)); },
      async removeItem(k) { pluginStorage.delete(k); },
      async keys() { return Array.from(pluginStorage.keys()); }
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
    crypto,
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
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }

  const W = P.HierarchicalWorldManager;
  const lore = [];
  W.loadWorldGraph(lore, true);
  const rootId = W.getProfile().rootId;

  // 실제와 같은 세계 규칙을 넣는다 — 사용자가 세계관 화면에서 넣는 값 (15b:1860-1885)
  W.updateNode(rootId, {
    rules: {
      setting: { places: ['검은 탑', '아르카디아'], organizations: ['마력 등록국'], socialRules: ['마법 사용은 등록제'] },
      physics: { special_phenomena: ['빛이 사라진다'], gravity: 'normal', time_flow: 'linear' },
      exists: { mythical_creatures: ['드래곤'] },
      custom: { rule_1: '마력은 저주받은 자만 쓴다' }
    },
    meta: { worldSummary: '마력이 일상인 세계. 두 개의 달이 뜬다.', classification: 'dark-fantasy' }
  });

  // 세계 계층 5개의 주입 텍스트 (13c:748/991/992/1070/1126 과 같은 호출)
  const layers = {
    worldPrompt: W.formatForPrompt(),
    worldStatePrompt: P.WorldStateTracker.formatForPrompt(),
    narrativePrompt: P.NarrativeTracker.formatForPrompt(),
    worldAdditionalPrompt: P.WorldAdditionalCore.formatForPrompt?.({}) || '',
    worldCodexPrompt: P.WorldAdditionalCore.formatWorldCodexForPrompt?.(900, {
      uniqueAgainst: [W.formatForPrompt(), P.WorldStateTracker.formatForPrompt(), P.NarrativeTracker.formatForPrompt()].join('\n\n'),
      maxItems: 8
    }) || '',
    sectionWorldPrompt: (() => {
      try { return P.SectionWorldInferenceManager?.getLastMeta?.() ? '' : ''; } catch { return ''; }
    })()
  };

  out.layer_chars = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, String(v || '').length]));
  out.layer_texts = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, String(v || '').slice(0, 500)]));

  // 기억 텍스트 — 같은 세계 사실이 기억에도 들어가는지 (정본 경로: lmai_memory 의 기록 본문)
  // 하네스가 만드는 턴 본문과 같은 형태로 넣는다.
  const memoryLikeTexts = [
    '아르카디아에서 두 개의 달이 떠 있는 하늘을 보았다. 공중에 떠 있는 섬들 사이로 빛나는 다리가 이어져 있었다.',
    '거리의 행인들이 손끝에서 불꽃을 피워 담배에 불을 붙였다. 이 세계에서는 마력이 일상적인 도구로 쓰이는 듯했다.',
    '경비병이 마력 등록증을 제시하라고 외쳤다. 검은 탑 근처에서 마력 등록국 직원을 만났다.'
  ];
  out.memory_overlap = {};
  for (const [name, text] of Object.entries(layers)) {
    if (!String(text || '').trim()) continue;
    const perMemory = memoryLikeTexts.map(m => overlap(text, m));
    out.memory_overlap[name] = {
      layer_chars: String(text).length,
      max_shared_tokens: Math.max(...perMemory.map(o => o.shared)),
      per_memory: perMemory.map(o => ({ shared: o.shared, ratio: Number(o.ratio.toFixed(3)), sample: o.sample }))
    };
  }

  // 세계 레이어끼리의 중복 (13c:1128 이 uniqueAgainst 로 막는 대상)
  const names = Object.keys(layers).filter(k => String(layers[k] || '').trim());
  out.layer_to_layer = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const o = overlap(layers[names[i]], layers[names[j]]);
      if (o.shared > 0) out.layer_to_layer.push({ a: names[i], b: names[j], shared: o.shared, ratio: Number(o.ratio.toFixed(3)), sample: o.sample });
    }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
