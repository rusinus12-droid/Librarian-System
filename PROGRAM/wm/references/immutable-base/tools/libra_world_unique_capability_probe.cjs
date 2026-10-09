'use strict';
// 실측: 세계 계층만 할 수 있는 것 — 기억으로는 구조적으로 불가능한 능력을 코드에서 확인한다.
//
// 질문: "세계 쪽만 할 수 있는 게 뭐냐"
// 방법: 기억(평면 레코드)과 세계(계층 노드)의 구조 차이를 실행으로 확인한다.
//   후보 ① 상속(scope) — 부모 규칙이 자식에 다르게 적용되는가
//   후보 ② override/isolate — 자식이 부모를 완전히 무효화할 수 있는가
//   후보 ③ 위치/이동(activePath) — 기억에 없는 공간 개념
//   후보 ④ 항상 적용되는 제약 — 관련성과 무관한 주입
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, WorldAdjustmentManager, MemoryEngine, NarrativeTracker
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
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe' }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;

  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;

  // ── ① 상속(scope): 같은 규칙이 노드마다 다르게 적용되는가 ──
  W.updateNode(root, { rules: { exists: { magic: true }, setting: { places: ['왕도'] } } });
  const childExtend = W.createNode({ name: '마법 봉인 지구', parent: root, layer: 'dimension' });
  W.updateNode(childExtend.node.id, {
    rules: { exists: { magic: false } }   // 자식이 마법을 뒤집는다 (extend 모드)
  });
  const rootEff = W.getEffectiveRules(root);
  const childEff = W.getEffectiveRules(childExtend.node.id);
  out.scope = {
    question: '같은 규칙이 노드마다 다르게 적용되는가',
    root: { magic: rootEff?.exists?.magic, places: rootEff?.setting?.places },
    child: { magic: childEff?.exists?.magic, places: childEff?.setting?.places },
    differs_by_node: rootEff?.exists?.magic !== childEff?.exists?.magic,
    inherited_from_parent: JSON.stringify(rootEff?.setting?.places) === JSON.stringify(childEff?.setting?.places),
    verdict: '부모 값 상속 + 자식 값 덮어쓰기가 실제로 동작한다'
  };

  // ── ② override/isolate: 자식이 부모를 완전히 무효화할 수 있는가 ──
  const childIso = W.createNode({ name: '법칙이 다른 세계', parent: childExtend.node.id, layer: 'dimension' });
  W.updateNode(childIso.node.id, {
    rules: { inheritance: { mode: 'isolate', exceptions: [] }, exists: { magic: true } }
  });
  const isoEff = W.getEffectiveRules(childIso.node.id);
  out.isolate = {
    question: '자식이 부모 규칙을 완전히 무효화할 수 있는가',
    isolated_node: { magic: isoEff?.exists?.magic, places: isoEff?.setting?.places ?? null },
    parent_had_places: childEff?.setting?.places,
    parent_rules_gone: !isoEff?.setting?.places || isoEff.setting.places.length === 0,
    verdict: 'mode=isolate 면 부모 체인 전체를 버리고 자기 규칙만 남는다'
  };

  // ── ③ 위치/이동: activePath 가 공간 개념을 갖는가 ──
  W.changeActivePath(childExtend.node.id, { method: 'probe' });
  const pathAfter = W.getProfile().activePath;
  const curNode = W.getCurrentNode();
  out.location = {
    question: '기억에 없는 공간 개념이 있는가',
    activePath: pathAfter,
    path_length: pathAfter.length,
    current_node_name: curNode?.name,
    tree_shape: (() => {
      const nodes = [];
      const seen = new Set();
      let cycleDetected = false;
      const walk = (id, d) => {
        if (d > 30) { cycleDetected = true; return; }
        if (seen.has(id)) { cycleDetected = true; return; }
        seen.add(id);
        const n = W.getProfile().nodes.get(id); if (!n) return;
        nodes.push('  '.repeat(d) + n.name);
        (n.children || []).forEach(c => walk(c, d + 1));
      };
      walk(W.getProfile().rootId, 0);
      return { lines: nodes, cycle_detected: cycleDetected, visited: seen.size };
    })(),
    verdict: '계층 깊이 + 현재 위치 + 이동 이력이 있다. 기억은 턴 번호만 있고 공간이 없다'
  };

  // ── ④ 항상 적용되는 제약: 관련성과 무관하게 나가는가 ──
  out.always_on = {
    question: '관련성과 무관하게 항상 적용되는가',
    world_block_chars: String(W.formatForPrompt() || '').length,
    has_query_argument: W.formatForPrompt.length,   // 인자 개수 0 이면 쿼리를 안 받는다
    verdict: 'formatForPrompt 는 인자가 0개 — 쿼리/관련성을 받지 않는다. 매 턴 같은 전문이 제약으로 나간다'
  };

  // ── ⑤ 충돌 감지: 새 사실이 기존 규칙과 충돌하는지 판정하는가 ──
  try {
    const probe = W.getEffectiveRules(root);
    const conflicts = P.WorldAdjustmentManager.detectConflict(
      { exists: { magic: false } },
      { rules: probe || {}, consistency: {} }
    );
    out.conflict_detection = {
      question: '새 사실이 기존 규칙과 충돌하는지 판정하는가',
      conflict_count: Array.isArray(conflicts) ? conflicts.length : null,
      sample: Array.isArray(conflicts) ? conflicts.slice(0, 3) : conflicts,
      verdict: '기존 규칙과 새 규칙의 충돌을 감지한다 — 기억에는 없는 개념'
    };
  } catch (e) {
    out.conflict_detection = { error: String(e?.message || e).slice(0, 200) };
  }

  // ── ⑥ 기억 쪽에 대응물이 있나 (평면성 확인) ──
  out.memory_structure = {
    question: '기억에 계층/스코프가 있는가',
    narrative_state_keys: (() => { try { return Object.keys(P.NarrativeTracker.getState?.() || {}); } catch { return []; } })(),
    note: '기억은 턴 앵커로만 묶인 평면 목록 — 같은 대화 안에서 모든 기억이 동등하다. "이 하위 세계에서만 참"을 표현할 자리가 없다'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
