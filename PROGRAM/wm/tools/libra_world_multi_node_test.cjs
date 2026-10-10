'use strict';
// Gate: 멀티노드 — 세포들이 여러 위치에 있으면 그 위치들이 동시에 활성이다 (2단계).
//
// 사용자 결정: "세계는 복잡하고 세포들이 다양한 위치에 있을 수 있으니까
//               종합적으로 체크할 수 있도록 멀티노드 형식으로 가자"
//
// 실측된 현재 상태(정정 포함):
//   - 규칙은 이미 노드별로 **분리돼 있다**(ID 충돌 수정 후 재측정).
//     앞선 "한 덩어리로 섞인다"는 관측은 ID 충돌 시절의 것이었다.
//   - 진짜 문제는 **동시에 여러 위치를 활성화할 수 없다**는 것:
//     changeActivePath 가 모든 노드 isActive=false 로 밀고 경로만 켠다 → 동시 1곳.
//
// 이 게이트가 고정하는 계약:
//   M1  profile.activeNodes 가 있다 (기본 = activePath)
//   M2  setActiveNodes / addActiveNode / removeActiveNode / getActiveNodes API
//   M3  여러 위치가 동시에 활성일 수 있다 (2곳 이상)
//   M4  node.isActive 가 activeNodes 기준으로 켜진다
//   M5  formatForPrompt 가 위치별 규칙 블록을 낸다 (2곳 활성 시)
//   M6  위치가 1곳이면 기존과 동일한 출력 (하위 호환)
//   M7  직렬화 왕복에서 activeNodes 가 보존된다
//   M8  findNodeByName 은 정확 일치만 (발명 없음)
//   M9  상한이 있다
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
  await new Promise(r => setTimeout(r, 130));
  assert('dist_runs_without_error', !runError, { error: runError });

  const W = context.__probeHWM;
  assert('world_manager_exported', !!W, {});
  if (!W) {
    for (const n of ['profile_has_activeNodes', 'active_node_api_exists', 'two_locations_active_at_once',
      'isActive_reflects_activeNodes', 'prompt_emits_per_location_blocks',
      'single_location_keeps_legacy_prompt', 'activeNodes_roundtrip', 'find_node_by_name_exact_only',
      'active_nodes_capped']) assert(n, false, { reason: 'no module' });
  } else {
    const lore = [];
    W.loadWorldGraph(lore, true);
    const root = W.getProfile().rootId;

    // ── M1: activeNodes 필드 ──
    const prof = W.getProfile();
    const hasField = Object.prototype.hasOwnProperty.call(prof, 'activeNodes');
    assert('profile_has_activeNodes', hasField && Array.isArray(prof.activeNodes),
      { has: hasField, value: prof.activeNodes });

    // ── M2: API ──
    const api = ['setActiveNodes', 'addActiveNode', 'removeActiveNode', 'getActiveNodes', 'findNodeByName'];
    const missing = api.filter(k => typeof W[k] !== 'function');
    assert('active_node_api_exists', missing.length === 0,
      { missing, present: api.filter(k => typeof W[k] === 'function') });

    if (missing.length > 0) {
      // API 미구현 — 나머지 단언을 FAIL 로 기록하고 끝낸다(게이트가 죽지 않게).
      for (const n of ['two_locations_active_at_once', 'isActive_reflects_activeNodes',
        'prompt_emits_per_location_blocks', 'single_location_keeps_legacy_prompt',
        'activeNodes_roundtrip', 'find_node_by_name_exact_only', 'active_nodes_capped']) {
        assert(n, false, { reason: 'api_not_implemented', missing });
      }
    } else {
    // 위치 3곳 생성
    const a = W.createNode({ name: '왕도', parent: root, layer: 'dimension' });
    const b = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
    const c = W.createNode({ name: '북부 변경', parent: root, layer: 'dimension' });
    W.updateNode(b.node.id, { rules: { exists: { magic: true } } });
    W.updateNode(c.node.id, { rules: { physics: { special_phenomena: ['혹한'] } } });

    // ── M3: 두 곳 동시 활성 ──
    W.changeActivePath(b.node.id, { method: 'probe' });
    W.setActiveNodes([b.node.id, c.node.id]);
    const active = W.getActiveNodes();
    assert('two_locations_active_at_once',
      Array.isArray(active) && active.length === 2 && active.includes(b.node.id) && active.includes(c.node.id),
      { active });

    // ── M4: isActive 가 activeNodes 기준 ──
    const bNode = W.getProfile().nodes.get(b.node.id);
    const cNode = W.getProfile().nodes.get(c.node.id);
    const aNode = W.getProfile().nodes.get(a.node.id);
    assert('isActive_reflects_activeNodes',
      bNode?.isActive === true && cNode?.isActive === true && aNode?.isActive === false,
      { 왕도: aNode?.isActive, 검은탑: bNode?.isActive, 북부변경: cNode?.isActive });

    // ── M5: 위치별 규칙 블록 ──
    const multiPrompt = String(W.formatForPrompt() || '');
    const hasPerLocation = /검은 탑/.test(multiPrompt) && /혹한/.test(multiPrompt)
      && /활성 위치|Active Locations|\[위치/.test(multiPrompt);
    assert('prompt_emits_per_location_blocks', hasPerLocation, { prompt: multiPrompt.slice(0, 500) });

    // ── M6: 1곳이면 기존과 동일 ──
    W.changeActivePath(b.node.id, { method: 'probe' });
    W.setActiveNodes([b.node.id]);
    const singlePrompt = String(W.formatForPrompt() || '');
    const legacyShape = /\[현재 위치 \/ Current Location\]/.test(singlePrompt)
      && !/활성 위치|Active Locations/.test(singlePrompt);
    assert('single_location_keeps_legacy_prompt', legacyShape, { prompt: singlePrompt.slice(0, 400) });

    // ── M7: 직렬화 왕복 ──
    W.setActiveNodes([b.node.id, c.node.id]);
    const saveLore = [];
    W.saveWorldGraphUnsafe(saveLore);
    const saved = JSON.parse(saveLore.find(e => e.comment === 'lmai_world_graph')?.content || '{}');
    const reloaded = W.loadWorldGraph(saveLore, true);
    const roundtripOk = Array.isArray(saved.activeNodes) && saved.activeNodes.length === 2
      && Array.isArray(reloaded.activeNodes) && reloaded.activeNodes.length === 2;
    assert('activeNodes_roundtrip', roundtripOk,
      { saved: saved.activeNodes, reloaded: reloaded.activeNodes });

    // ── M8: 이름 매칭은 정확 일치만 (발명 없음) ──
    const exact = W.findNodeByName('검은 탑');
    const partial = W.findNodeByName('검은');
    const absent = W.findNodeByName('존재하지 않는 세계');
    assert('find_node_by_name_exact_only',
      exact?.id === b.node.id && !partial && !absent,
      { exact: exact?.name || null, partial: partial?.name || null, absent: absent?.name || null });

    // ── M9: 상한 ──
    const many = Array.from({ length: 40 }, () => W.createNode({ name: `위치${Math.random().toString(36).slice(2, 8)}`, parent: root, layer: 'dimension' }).node.id);
    W.setActiveNodes([b.node.id, c.node.id, ...many]);
    const capped = W.getActiveNodes().length;
    assert('active_nodes_capped', capped > 0 && capped <= 16, { input: 42, stored: capped });
    }
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
