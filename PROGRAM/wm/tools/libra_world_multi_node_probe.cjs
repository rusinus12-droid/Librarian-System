'use strict';
// 실측: 멀티노드(복수 활성 위치)로 가려면 무엇이 걸리는가 — 단일 경로 가정의 범위.
//
// 사용자 결정(2026-09-29): "세계는 복잡하고 세포들이 다양한 위치에 있을 수 있으니까
//   종합적으로 체크할 수 있도록 멀티노드 형식으로 가자"
//
// 지금 구조: profile.activePath = 단일 노드 경로(배열이지만 "한 줄기")
//   changeActivePath: 모든 노드 isActive=false → 경로 노드만 true  (= 하나만 활성)
// 멀티노드로 가려면 "동시에 여러 위치가 활성"을 표현해야 한다.
//
// 이 스크립트는 ① 단일 경로 가정이 어디에 깔려 있는지 ② 그걸 바꾸면 무엇이 깨지는지
// 실행으로 확인한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = { HierarchicalWorldManager, WorldStateTracker, CharacterStateTracker };
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
  if (!P) { console.log(JSON.stringify({ ok: false }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;

  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;

  // ── 트리 3갈래 구성: 세포들이 서로 다른 위치에 있는 상황 ──
  const a = W.createNode({ name: '왕도', parent: root, layer: 'dimension' });
  const b = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
  const c = W.createNode({ name: '북부 변경', parent: root, layer: 'dimension' });
  W.updateNode(a.node.id, { rules: { setting: { places: ['왕도'] } } });
  W.updateNode(b.node.id, { rules: { setting: { places: ['검은 탑'] }, exists: { magic: true } } });
  W.updateNode(c.node.id, { rules: { setting: { places: ['북부 변경'] }, physics: { special_phenomena: ['혹한'] } } });

  // ── ① 단일 경로: 한 곳만 활성 ──
  W.changeActivePath(b.node.id, { method: 'probe' });
  const prof1 = W.getProfile();
  const activeAfterOne = [...prof1.nodes.entries()].filter(([, n]) => n.isActive).map(([id, n]) => n.name);
  out.single_active = {
    question: '지금은 동시에 몇 곳이 활성인가',
    activePath: prof1.activePath,
    active_nodes: activeAfterOne,
    active_count: activeAfterOne.length,
    // 세 곳을 차례로 옮기면 앞의 것은 꺼진다
    after_switch_to_c: (() => { W.changeActivePath(c.node.id, { method: 'probe' }); return [...W.getProfile().nodes.entries()].filter(([, n]) => n.isActive).map(([, n]) => n.name); })(),
    verdict: '한 번에 한 곳만 활성 — 세포가 여러 위치에 있어도 표현할 수 없다'
  };

  // ── ② 그래도 "여러 위치"를 표현할 자리가 있나 ──
  out.multi_representation = {
    activePath_is_single_chain: true,
    isActive_is_single_boolean: true,
    node_has_coordinates: false,
    node_has_parent_and_children: true,
    profile_has_global: true,
    profile_has_interference: true,
    verdict_without_activePath: '부모-자식 트리 + children 은 여러 갈래를 담을 수 있다. 문제는 "지금 어디가 활성인가"가 단일이라는 것'
  };

  // ── ③ 멀티 활성을 흉내내 보기: rules 상속이 여러 위치에서 동시에 계산되는가 ──
  const effA = W.getEffectiveRules(a.node.id);
  const effB = W.getEffectiveRules(b.node.id);
  const effC = W.getEffectiveRules(c.node.id);
  out.multi_inheritance = {
    question: '여러 위치의 규칙을 동시에 계산할 수 있는가',
    place_a: effA?.setting?.places,
    place_b: { places: effB?.setting?.places, magic: effB?.exists?.magic },
    place_c: { places: effC?.setting?.places, phenomena: effC?.physics?.special_phenomena },
    all_computable: !!(effA && effB && effC),
    verdict: '규칙 계산은 노드별로 독립이라 여러 곳을 동시에 계산할 수 있다 — 막는 것은 activePath 뿐'
  };

  // ── ④ formatForPrompt 가 단일 경로만 내보내는가 ──
  const promptText = W.formatForPrompt();
  out.prompt_output = {
    prompt_text: promptText,
    chars: String(promptText || '').length,
    shows_current_location_only: /현재 위치|Current Location/.test(String(promptText || '')),
    shows_all_places: ['왕도', '검은 탑', '북부 변경'].filter(p => String(promptText || '').includes(p)),
    verdict: '현재 활성 경로만 나간다 — 다른 위치의 규칙은 규칙 목록에 합쳐져 위치 구분이 사라진다'
  };

  // ── ⑤ 그래서 무엇을 바꿔야 하나 ──
  out.change_surface = {
    single_path_readers: [
      '08a changeActivePath (모든 isActive=false → 경로만 true)',
      '08a getCurrentNode / getCurrentRules (경로 마지막 노드)',
      '08a formatForPrompt ([현재 위치] 섹션)',
      '05k:407/501 worldSnapshot.activePath',
      '09a:305 activePath[last] → 노드 id (DLC 적용 대상)',
      '20+ 곳이 activePath 를 읽음(grep 전수)'
    ],
    minimal_extension: {
      keep: 'activePath (하위 호환 — "주 초점" 위치로 유지)',
      add: 'profile.activeNodes: Set/array — 동시에 활성인 복수 노드',
      rules: 'getActiveRulesFor(nodeId) 는 이미 있음(getEffectiveRules)',
      prompt: 'formatForPrompt 가 활성 노드들을 순회해 위치별 규칙 블록을 낸다',
      gui: '세계관 화면이 활성 목록을 보여준다(현재는 activePath 하나만 "활성" 표시)'
    }
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
