'use strict';
// 실측: 중복 제거의 정확한 범위(blast radius) — 무엇을 끊으면 무엇이 깨지는가.
//
// 사용자 정정(2026-09-29): "5.28에서 오작동한 건 휴리스틱으로 작동하던 템플릿이야.
//   그래서 LLM이 규칙을 발명하는 구조로 간 거고 그건 괜찮았다 보고 있어.
//   다만 기억이랑 중복이 발생됐던 게 문제였던 거고."
//
// → 유지: LLM 이 규칙을 발명해 정본(08a updateNode)에 쓰는 경로 (12:2533)
// → 제거: 그 규칙이 **기억 레코드에도 복사되는 것** (05e:299-309 payload.world)
//
// 05e 의 payload.world 가 하는 일이 "복사"뿐인지, 아니면 고유 기능이 있는지 가른다.
//   - worldSignature: 스냅샷 중복 방지 키 (고유 기능?)
//   - ruleHash/activePathHash/correctionHash: "규칙이 바뀌었나" 판정 (고유 기능)
//   - exists/systems/physics/custom/ruleHighlights: 정본과 같은 값 (복사)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, MemoryEngine, CompactMemoryCodec,
        extractWorldRuleHighlights, normalizeWorldRuleUpdate,
        TokenizerEngine
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

const tokens = (s) => String(s || '').replace(/[\[\]【】(){}"'`·•\-—–:：,，.。/]/g, ' ').split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);

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
  W.updateNode(rootId, {
    rules: { setting: { places: ['검은 탑'] }, custom: { rule_1: '마력은 저주받은 자만 쓴다' } },
    meta: { worldSummary: '마력이 일상인 세계', classification: 'dark-fantasy' }
  });
  const rules = W.getCurrentRules();
  const norm = P.normalizeWorldRuleUpdate(rules);
  const highlights = P.extractWorldRuleHighlights(norm, 6);

  // ── 05e payload.world 의 각 필드가 "복사"인가 "고유"인가 ──
  const payloadWorld = {
    signature: 'sig-abc',                                   // 파생 (규칙 해시)
    classification: { primary: 'dark-fantasy' },             // meta 에도 있음 → 복사
    exists: norm.exists,                                     // 정본과 동일 → 복사
    systems: norm.systems,                                   // 복사
    physics: norm.physics,                                   // 복사
    custom: norm.custom,                                     // 복사
    activePath: ['world_main'],                              // profile 에도 있음 → 복사
    ruleHighlights: highlights,                              // 정본에서 파생 → 복사
    userCorrection: ''                                       // meta 에도 있음 → 복사
  };
  out.payload_world_fields = Object.fromEntries(Object.entries(payloadWorld).map(([k, v]) => [k, {
    value_chars: JSON.stringify(v || '').length,
    is_derived_from_canon: ['exists', 'systems', 'physics', 'custom', 'ruleHighlights', 'classification', 'activePath', 'userCorrection'].includes(k),
    note: ['exists', 'systems', 'physics', 'custom', 'ruleHighlights'].includes(k)
      ? '정본 rules 와 동일값 — 복사'
      : (k === 'signature' ? '규칙 해시(파생)' : 'meta/profile 에도 있는 값 — 복사')
  }]));

  // ── 세계 규칙 텍스트가 기억 회상에 실제로 들어가는지 (03d:224 경로 재현) ──
  const recallText = [...payloadWorld.ruleHighlights, 'magic is registered'].join(' ');
  const worldBlockText = W.formatForPrompt();
  const A = new Set(tokens(worldBlockText)), B = new Set(tokens(recallText));
  const shared = [...A].filter(t => B.has(t));
  out.duplication = {
    world_block_chars: worldBlockText.length,
    memory_recall_chars: recallText.length,
    shared_tokens: shared,
    share: B.size ? Number((shared.length / B.size).toFixed(3)) : 0,
    world_block_text: worldBlockText,
    memory_recall_text: recallText
  };

  // ── 중복 제거 시 남는 것: 고유 판정 기능만 ──
  out.after_removal = {
    kept: {
      signature: '스냅샷 중복 방지 키 — 규칙 해시에서 파생, 값 복사 아님',
      ruleHash: '규칙 변경 감지용 해시(파생)',
      activePathHash: '경로 변경 감지용 해시(파생)',
      correctionHash: '사용자 교정 감지용 해시(파생)',
      worldSummary: 'meta.worldSummary 와 같은 값 → 이것도 복사'
    },
    removed_raw_copies: ['exists', 'systems', 'physics', 'custom', 'ruleHighlights', 'classification', 'activePath', 'userCorrection'],
    effect_on_recall_text: '03d:224 의 pushArray(payloadWorld.ruleHighlights) 가 빈손이 된다 → 회상 텍스트에서 세계 규칙 사라짐'
  };

  // ── 회상 텍스트에서 사라지는 비율 ──
  out.recall_text_impact = {
    before_chars: recallText.length,
    after_chars: [...['magic is registered']].join(' ').length,
    note: '세계 규칙이 회상 텍스트에서 빠진다 — 정본이 이미 매 턴 주입하므로 손실 아님'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
