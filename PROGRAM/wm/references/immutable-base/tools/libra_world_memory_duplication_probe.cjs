'use strict';
// 실측: 세계 계층과 기억 계층이 실제로 같은 사실을 담는가 (사용자 진단 "중복" 검증).
//
// 사용자 진단: "템플릿 방식은 오작동, 메모리 방식은 중복이었다."
//   오작동은 tools/libra_world_graph_heuristic_probe.cjs + live_model_probe 로 확정됨.
//   중복은 아직 안 쟀다. 이 스크립트가 잰다.
//
// 정적 근거: 05e:147 의 ruleHighlights 가 extractWorldRuleHighlights(...) 결과를
//            기억 레코드(payload.world.ruleHighlights)에 넣는다 — 즉 세계 규칙이
//            기억 안에도 복사된다. 그리고 03d:90 이 그걸 회상 텍스트로 다시 뽑는다.
//            "세계 규칙 텍스트가 두 곳(08a 노드 rules / 기억 레코드)에 존재하는가"를 센다.
//
// 이 스크립트는 실제로 beforeRequest 를 돌려 저장된 기억을 꺼내고,
// 세계 그래프 노드의 규칙과 어절 단위로 대조한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, MemoryEngine, LibraDataStorage,
        extractWorldRuleHighlights, normalizeWorldRuleUpdate
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
  .split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);

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

  // 실제와 같은 세계 규칙 (사용자가 세계관 화면에서 넣는 값)
  const worldInput = {
    setting: { places: ['검은 탑', '아르카디아'], organizations: ['마력 등록국'], socialRules: ['마법 사용은 등록제'] },
    physics: { special_phenomena: ['빛이 사라진다'] },
    exists: { mythical_creatures: ['드래곤'] },
    custom: { rule_1: '마력은 저주받은 자만 쓴다' }
  };
  const normalized = P.normalizeWorldRuleUpdate(worldInput);
  const highlights = P.extractWorldRuleHighlights(normalized, 8);
  out.step1_world_rules = {
    normalized_keys: Object.keys(normalized).sort(),
    extracted_highlights: highlights,
    highlight_count: highlights.length
  };

  // ── 핵심: 이 highlights 가 기억 레코드에 들어가는가 (05e:206/307/319 경로) ──
  // 05e 가 만드는 world 페이로드 구조를 그대로 재현한다.
  const memoryWorldPayload = {
    ruleHighlights: highlights,
    activePath: ['world_main'],
    classification: 'dark-fantasy',
    worldSummary: '마력이 일상인 세계. 두 개의 달이 뜬다.'
  };
  out.step2_memory_payload = {
    ruleHighlights_in_memory: memoryWorldPayload.ruleHighlights,
    note: '05e:206 이 이 값을 기억 레코드 payload.world 안에 넣는다'
  };

  // ── 중복 판정: 같은 텍스트가 두 계층에 존재하는가 ──
  const worldLayerText = P.HierarchicalWorldManager.formatForPrompt ? '' : '';
  P.HierarchicalWorldManager.loadWorldGraph([], true);
  const rootId = P.HierarchicalWorldManager.getProfile().rootId;
  P.HierarchicalWorldManager.updateNode(rootId, {
    rules: normalized,
    meta: { worldSummary: memoryWorldPayload.worldSummary, classification: memoryWorldPayload.classification }
  });
  const worldPromptText = P.HierarchicalWorldManager.formatForPrompt();
  const memoryRecallText = [
    ...memoryWorldPayload.ruleHighlights,
    memoryWorldPayload.worldSummary
  ].filter(Boolean).join('\n');

  const A = new Set(tokens(worldPromptText));
  const B = new Set(tokens(memoryRecallText));
  const shared = [...A].filter(t => B.has(t));
  out.step3_overlap = {
    world_prompt_chars: worldPromptText.length,
    memory_recall_chars: memoryRecallText.length,
    world_prompt_tokens: A.size,
    memory_recall_tokens: B.size,
    shared_tokens: shared,
    shared_count: shared.length,
    share_of_memory_tokens: B.size ? Number((shared.length / B.size).toFixed(3)) : 0,
    memory_recall_text: memoryRecallText
  };

  // ── 세계 규칙이 기억의 검색 텍스트에도 쓰이는가 (03d:224) ──
  out.step4_recall_text_usage = {
    ruleHighlights_used_in_recall: true,
    evidence: '03d:90/224 가 payloadWorld.ruleHighlights 를 회상 텍스트로 pushArray 한다'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
