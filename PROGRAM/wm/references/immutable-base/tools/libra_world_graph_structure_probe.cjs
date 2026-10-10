'use strict';
// Probe: 월드 그래프(HierarchicalWorldManager, 08a)의 실제 구조를 실행으로 확인한다.
//
// 사용자 요청: "월드 그래프가 어떻게 구성되어 있는지 알려줘"
// 스킬 규칙: "소스 읽기로 끝내지 말고 실행으로 보여준다 — 추측한 입출력 형태를 말하지 않는다."
//
// 확인 항목:
//   1. 기본 프로필 구조 (hydrate 결과의 실제 키)
//   2. 노드 하나의 실제 필드 (createNode 반환값 그대로)
//   3. 부모-자식 체인 · activePath · rules 상속(getEffectiveRules)
//   4. 저장 직렬화 형태 (serializeWorldProfile → 실제 JSON)
//   5. 프롬프트 주입 텍스트 (formatForPrompt 실제 출력)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
// HierarchicalWorldManager 는 최상위 IIFE 지역 상수라 globalThis 에 없다.
// 게이트 관례대로 IIFE 닫는 지점 앞에 관측 export 를 심는다.
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probeHWM = HierarchicalWorldManager;\n' + code.slice(idx);
const out = {};

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
  querySelector() { return null; }
  querySelectorAll() { return []; }
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
  const chat = { id: 'chat-1', localLore: [], message: [], bindedPersona: 'p1' };
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
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 300); }
  await new Promise(r => setTimeout(r, 80));
  out.dist_runs_without_error = !runError;
  if (runError) out.run_error = runError;

  const W = context.__probeHWM || null;
  out.module_exported = !!W;
  out.module_api = W ? Object.keys(W).sort() : [];

  if (W) {
    const lore = [];
    // [1] 기본 프로필
    W.loadWorldGraph(lore, true);
    const prof = W.getProfile();
    out.default_profile_keys = Object.keys(prof).sort();
    out.default_profile_global_keys = Object.keys(prof.global || {}).sort();
    out.default_root_id = prof.rootId;
    out.default_node_count = prof.nodes instanceof Map ? prof.nodes.size : '(Map 아님)';
    out.default_activePath = prof.activePath;

    // [2] 노드 하나의 실제 필드
    const created = W.createNode({
      name: '그림자 왕국', layer: 'dimension', parent: prof.rootId, source: 'probe'
    });
    out.createNode_success = created.success === true;
    out.createNode_reason = created.reason || null;
    const node = created.node || {};
    out.node_keys = Object.keys(node).sort();
    out.node_rules_keys = Object.keys(node.rules || {}).sort();
    out.node_sample = {
      id: node.id, name: node.name, layer: node.layer, parent: node.parent,
      isActive: node.isActive, isPrimary: node.isPrimary,
      accessCondition: node.accessCondition, children: node.children, connections: node.connections
    };

    // [3] 계층: 자식 노드에 rules 를 주고 상속을 확인
    const child = W.createNode({ name: '심연', layer: 'dimension', parent: node.id, source: 'probe' });
    W.updateNode(child.node.id, {
      rules: { setting: { places: ['심연의 문'] }, physics: { special_phenomena: ['빛이 사라진다'] } }
    });
    W.changeActivePath(child.node.id, { method: 'probe' });
    const effective = W.getEffectiveRules(child.node.id);
    out.inheritance_child_effective = effective;
    out.activePath_after_switch = W.getProfile().activePath;
    out.currentNode_name = W.getCurrentNode()?.name;

    // [4] 저장 직렬화 (실제 JSON)
    const saved = W.saveWorldGraphUnsafe(lore);
    const entry = lore.find(e => String(e?.comment) === 'lmai_world_graph');
    out.saved_entry_comment = entry ? entry.comment : '(없음)';
    const parsed = entry ? JSON.parse(entry.content) : null;
    out.serialized_schema = parsed?.schema;
    out.serialized_version = parsed?.version;
    out.serialized_top_keys = parsed ? Object.keys(parsed).sort() : [];
    out.serialized_node_entry_is_pair = Array.isArray(parsed?.nodes?.[0]);
    out.serialized_node_ids = (parsed?.nodes || []).map(p => p[0]);
    out.serialized_bytes = entry ? Buffer.byteLength(entry.content, 'utf8') : 0;

    // [5] 프롬프트 주입 텍스트 (실제 출력)
    const promptText = W.formatForPrompt();
    out.prompt_text = String(promptText || '');
    out.prompt_chars = String(promptText || '').length;

    // 왕복: 저장 → 재로드
    const lore2 = [];
    W.saveWorldGraphUnsafe(lore2);
    const reloaded = W.loadWorldGraph(lore2, true);
    out.roundtrip_node_count = reloaded.nodes.size;
    out.roundtrip_root = reloaded.rootId;
    out.roundtrip_activePath = reloaded.activePath;
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(runError ? 1 : 0);
})();
