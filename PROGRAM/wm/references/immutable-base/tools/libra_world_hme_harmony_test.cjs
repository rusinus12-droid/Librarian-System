'use strict';
// Gate: HME 가 세계 규칙을 정본에서 읽는다 (6단계 — HME 조화안 B).
//
// 실측된 상황:
//   - HME 그래프(10c)는 세계를 **기억 경유로만** 읽었다:
//     buildHmeGraphRowSignals 가 payload.world.ruleHighlights / payload.worldSignature 를 썼다.
//   - 5단계에서 그 복사를 제거했으므로 **HME 그래프가 세계 규칙을 잃었다**.
//     (10c 는 HierarchicalWorldManager 를 0곳에서 참조한다 — 세계 정본을 모른다)
//
// 조화안 B: HME 가 세계 정본(08a)에서 **읽기만** 한다. 복사하지 않는다.
//   A안(세계를 HME 4번째 노드 타입으로)은 중복 위험이 높아 보류 —
//   세계는 영속 정본인데 HME 는 턴별 재구축이라 매번 복사해야 한다.
//
// 이 게이트가 고정하는 계약:
//   H1 10c 가 세계 정본을 읽을 수 있다 (참조가 있다)
//   H2 정본에서 활성 위치/규칙을 읽어 worldRuleHighlights 를 채운다
//   H3 세계 정본이 비면 기억 경유(레거시)로 되돌아간다 (하위 호환)
//   H4 HME 로 세계를 **쓰지 않는다** (단방향 — 정본은 08a 하나)
//   H5 노드 id 규약이 유지된다 (g_node_/g_ent_/g_lore_ — 세계 노드 타입 추가 안 함)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probe = { HierarchicalWorldManager };\n' + code.slice(idx);

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

  const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');
  const W = context.__probe?.HierarchicalWorldManager;
  assert('world_manager_exported', !!W, {});

  // ── H1: 10c 가 세계 정본을 읽을 수 있는가 ──
  const referencesWorldCanon = /HierarchicalWorldManager|getCurrentRules|getEffectiveRules|getActiveNodes|getActivePath/.test(SRC);
  assert('reads_world_canon', referencesWorldCanon,
    { found: referencesWorldCanon, refs: (SRC.match(/HierarchicalWorldManager|getCurrentRules|getEffectiveRules|getActiveNodes|getActivePath/g) || []).length });

  // ── H2: 정본에서 읽은 값이 실제로 **채워지는가** ──
  // 리더 정의가 아니라 **사용처**(worldRuleHighlights / worldSignature 조립식)를 본다.
  const highlightsBlock = (() => {
    const i = SRC.indexOf('const worldRuleHighlights = normalizeHmeGraphSpecificList([');
    return i < 0 ? '' : SRC.slice(i, i + 600);
  })();
  const signatureBlock = (() => {
    const i = SRC.indexOf('const worldSignature = normalizeHmeGraphSpecificList([');
    return i < 0 ? '' : SRC.slice(i, i + 600);
  })();
  const canonFeedsHighlights = /__canon\?\.ruleHighlights|readWorldCanonSignals\(\)/.test(highlightsBlock);
  const canonFeedsSignature = /__canon\?\.signature/.test(signatureBlock);
  assert('fills_from_canon', canonFeedsHighlights && canonFeedsSignature,
    { highlights_fed: canonFeedsHighlights, signature_fed: canonFeedsSignature,
      highlights_block: highlightsBlock.slice(0, 200) });

  // ── H3: 정본이 비면 기억 경유로 되돌아가는가 (하위 호환) ──
  const keepsLegacyPath = /payloadWorld\?\.ruleHighlights/.test(SRC);
  assert('legacy_fallback_kept', keepsLegacyPath, { found: keepsLegacyPath });

  // ── H4: HME 가 세계를 쓰지 않는가 (단방향) ──
  const writesWorld = /HierarchicalWorldManager\.(updateNode|createNode|setActiveNodes|changeActivePath|addActiveNode|removeActiveNode)/.test(SRC);
  assert('does_not_write_world', !writesWorld, { found_write: writesWorld });

  // ── H5: 노드 id 규약 유지 (세계 노드 타입 추가 안 함) ──
  const hasWorldNodeType = /nodeType:\s*'world'/.test(SRC) || /g_world_/.test(SRC);
  assert('no_world_node_type_added', !hasWorldNodeType,
    { found_world_node_type: hasWorldNodeType });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
