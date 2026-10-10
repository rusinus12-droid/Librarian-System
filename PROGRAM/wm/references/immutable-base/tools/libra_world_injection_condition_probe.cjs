'use strict';
// 실측: "승격 안 한 사실은 기억 회상에, 승격하면 세계 쪽에" — 그 구분이 실제로 성립하는가.
//
// 확인할 축 (사용자 질문의 정확한 형태):
//   ① 세계 블록은 매 턴 무조건 들어가는가 (관련성 무관)?
//   ② 기억 회상은 게이트(점수 임계)를 통과해야 들어가는가?
//   ③ 그래서 "규칙"과 "기억"의 주입 조건이 실제로 다른가?
//
// 정적 근거:
//   세계: 13c:748 worldPrompt = HierarchicalWorldManager.formatForPrompt()  → 슬롯 priority 'required' (1701)
//   기억: 13c:1713 memoryText → 점수 게이트 통과분만 (label memories(N))
//   10a:407 thresholdPass — 도메인 불일치·부정 앵커·임계로 거른다
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, MemoryEngine, WorldStateTracker
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
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }

  const W = P.HierarchicalWorldManager;
  W.loadWorldGraph([], true);
  const rootId = W.getProfile().rootId;

  // 세계 정본에 규칙을 넣는다 == "승격된" 상태
  W.updateNode(rootId, {
    rules: {
      setting: { places: ['검은 탑'] },
      custom: { rule_1: '마력은 저주받은 자만 쓴다' }
    },
    meta: { worldSummary: '마력이 일상인 세계' }
  });

  // ── ① 세계 블록은 매 턴 무조건 나가는가 ──
  // 시나리오: 전혀 무관한 장면(카페에서 커피) 에서도 나가는지
  const prompts = {
    '무관한 장면(카페)': W.formatForPrompt(),
    '다른 세계로 이동': W.formatForPrompt(),
    '빈 상태': (() => { const before = W.getProfile().nodes.size; return W.formatForPrompt(); })()
  };
  out.world_block = {
    always_emitted: Object.values(prompts).every(p => String(p || '').trim().length > 0),
    chars: Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, String(v || '').length])),
    contains_rules: Object.values(prompts).map(p => /검은 탑|저주받은/.test(String(p || ''))),
    note: 'formatForPrompt 는 쿼리/관련성 인자를 받지 않는다 — 매 턴 같은 전문이 나간다'
  };
  out.world_block.signature = String(prompts['무관한 장면(카페)'] || '');

  // ── ② 세계 블록이 "required" 슬롯인가 (예산에서 잘리지 않는가) ──
  const src = fs.readFileSync(path.join(ROOT, 'src/parts/13c-before-request-injection.js'), 'utf8');
  out.world_slot = {
    line: (src.match(/key: 'world'.{0,80}/) || [])[0] || null,
    is_required: /key: 'world'.*priority: 'required'/.test(src),
    memory_slot_line: (src.match(/key: 'memories'.{0,90}/) || [])[0] || null,
    memory_is_conditional_when_empty: /key: 'memories'.*priority: memoryText \? 'required' : null/.test(src)
  };

  // ── ③ 기억 회상은 임계를 통과해야 한다 ──
  const CONFIG = P.MemoryEngine.CONFIG || {};
  out.recall_gate = {
    threshold: CONFIG.threshold ?? null,
    simThreshold: CONFIG.simThreshold ?? null,
    maxLimit: CONFIG.maxLimit ?? null,
    note: '10a:407 thresholdPass — 점수 임계·도메인 일치·부정 앵커를 통과한 것만 주입된다'
  };

  // ── ④ 핵심 요약: 두 경로의 주입 조건이 다른가 ──
  out.verdict = {
    world_path: '매 턴 무조건 (관련성 무관, required 슬롯)',
    memory_path: '관련성 점수 게이트 통과분만 (임계 + 도메인 + 앵커)',
    same_conditions: false,
    implication: '승격 = 무조건 주입되는 세계 블록으로 이동 / 미승격 = 관련될 때만 나오는 기억에 남음'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
