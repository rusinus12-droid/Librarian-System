'use strict';
// Gate: 세계 노드 ID 충돌 방지 — 멀티노드의 선행 조건.
//
// 배경: createNode 가 `node_${Date.now()}` 로 ID 를 만들어 같은 밀리초에 같은 ID 가 나왔다.
//   profile.nodes.set() 이 앞 노드를 조용히 덮어쓰고, children 에 유령 참조가 남아
//   트리 순회가 무한 재귀(RangeError)로 죽었다.
//   실측(수정 전): 3갈래 생성 → 고유 ID 1개, 실제 노드 2개(루트 포함).
//   실측(수정 후): 3갈래 생성 → 고유 ID 3개, 노드 4개(루트 포함).
//
// 이 게이트가 고정하는 계약:
//   N1 연속 생성 시 ID 가 전부 고유하다
//   N2 연속 생성 시 노드가 실제로 그만큼 남는다 (조용한 덮어쓰기 없음)
//   N3 부모 children 에 중복이 없다 (유령 참조 없음)
//   N4 트리 순회가 유한하다 (순환/무한 재귀 없음)
//   N5 config.id 를 주면 그걸 존중한다 (하위 호환)
//   N6 기존 `node_<숫자>` 형식 ID 를 가진 저장본을 로드해도 보존된다 (하위 호환)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probeHWM = HierarchicalWorldManager;\n' + code.slice(idx);

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
  await new Promise(r => setTimeout(r, 120));
  assert('dist_runs_without_error', !runError, { error: runError });

  const W = context.__probeHWM;
  assert('world_manager_exported', !!W, {});
  if (!W) {
    for (const n of ['node_ids_are_unique', 'nodes_survive_rapid_creation', 'no_duplicate_children',
      'tree_walk_is_finite', 'explicit_id_respected', 'legacy_numeric_id_preserved']) assert(n, false, { reason: 'no module' });
  } else {
    const lore = [];
    W.loadWorldGraph(lore, true);
    const rootId = W.getProfile().rootId;

    // ── N1·N2: 같은 밀리초에 10개 연속 생성 ──
    const created = [];
    for (let i = 0; i < 10; i++) created.push(W.createNode({ name: `위치${i}`, parent: rootId, layer: 'dimension' }));
    const ids = created.map(r => r.node?.id).filter(Boolean);
    const unique = new Set(ids);
    assert('node_ids_are_unique', ids.length === 10 && unique.size === 10, {
      created: ids.length, unique: unique.size, ids
    });
    const nodeCount = W.getProfile().nodes.size;
    assert('nodes_survive_rapid_creation', nodeCount === 11, {
      expected: 11, actual: nodeCount, note: '루트 + 10개'
    });

    // ── N3: 부모 children 에 중복이 없어야 한다 ──
    const rootChildren = W.getProfile().nodes.get(rootId)?.children || [];
    assert('no_duplicate_children', rootChildren.length === new Set(rootChildren).size && rootChildren.length === 10, {
      children: rootChildren.length, unique: new Set(rootChildren).size
    });

    // ── N4: 트리 순회가 유한해야 한다 (순환/무한 재귀 없음) ──
    let walkCount = 0;
    let stackOverflow = false;
    const seen = new Set();
    try {
      const walk = (id, depth) => {
        if (depth > 100 || seen.has(id)) return;
        seen.add(id); walkCount += 1;
        const n = W.getProfile().nodes.get(id);
        if (!n) return;
        for (const c of (n.children || [])) walk(c, depth + 1);
      };
      walk(rootId, 0);
    } catch (e) { stackOverflow = true; }
    assert('tree_walk_is_finite', !stackOverflow && walkCount === nodeCount, {
      walkCount, nodeCount, stackOverflow
    });

    // ── N5: config.id 를 주면 그걸 존중한다 ──
    const explicit = W.createNode({ id: 'node_custom_fixed', name: '고정 ID', parent: rootId, layer: 'dimension' });
    assert('explicit_id_respected', explicit.success === true && explicit.node?.id === 'node_custom_fixed', {
      id: explicit.node?.id
    });

    // ── N6: 기존 node_<숫자> 형식 저장본이 보존되는가 (하위 호환) ──
    const legacyProfile = {
      schema: 'libra.world.graph.compact.v2', version: '6.1', rootId: 'world_main',
      nodes: [
        ['world_main', { id: 'world_main', name: '주요 세계', layer: 'dimension', parent: null, children: ['node_1700000000000'], rules: {}, meta: {} }],
        ['node_1700000000000', { id: 'node_1700000000000', name: '옛 노드', layer: 'dimension', parent: 'world_main', children: [], rules: {}, meta: {} }]
      ],
      activePath: ['world_main', 'node_1700000000000'], interference: { level: 0, recentEvents: [] }, meta: {}
    };
    const legacyLore = [{ key: 'lmai_world_graph::compact', comment: 'lmai_world_graph', content: JSON.stringify(legacyProfile), mode: 'normal' }];
    const reloaded = W.loadWorldGraph(legacyLore, true);
    assert('legacy_numeric_id_preserved', reloaded.nodes.has('node_1700000000000') && reloaded.nodes.size === 2, {
      has_legacy: reloaded.nodes.has('node_1700000000000'), size: reloaded.nodes.size,
      ids: Array.from(reloaded.nodes.keys())
    });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
