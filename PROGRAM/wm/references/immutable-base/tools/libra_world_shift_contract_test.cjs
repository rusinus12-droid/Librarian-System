'use strict';
// Gate: 세계 분기 계약 — dimensionalShifts 가 프롬프트에 있고, 소비 경로가 실제로 노드를 만든다.
//
// 배경(실측):
//   - 노드 생성 경로는 05k:200 단 하나이고 조건은 ① channel==='scene'
//     ② worldMutationPolicy.allowDimensionalShift (= payload.dimensionalShifts 가 비지 않을 때)
//   - 정책(resolveStructuredWorldMutationPolicy)과 소비(05k:184-216)는 이미 있다.
//   - 그런데 추출 프롬프트(12 EntityExtractionPrompt)의
//     "World patch fields may include:" 목록에 dimensionalShifts 가 **없다**.
//   - 실모델 3턴(차원 이동이 명시적으로 일어난 장면 포함) 전부 dimensionalShifts 0건.
//   → 프롬프트가 요구하지 않으니 LLM 이 낼 이유가 없다. 그래서 97턴에도 노드가 1개(루트뿐).
//
// 이 게이트가 고정하는 계약:
//   D1 프롬프트가 world.dimensionalShifts 를 이름으로 요구한다
//   D2 프롬프트가 그 모양(to/from/type)을 말한다
//   D3 프롬프트가 발명을 금지한다 (명시적 전환만)
//   D4 소비 경로가 실제로 노드를 만든다 (모델 출력 → 정책 → createNode → activePath)
//   D5 전환이 없으면 노드를 만들지 않는다 (오작동 방지)
//   D6 새 세계는 루트의 자식으로 붙는다 (계층 유지)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probe = { HierarchicalWorldManager, EntityExtractionPrompt: EntityExtractionPrompt, resolveStructuredWorldMutationPolicy, classifyNarrativeTurnChannel };\n' + code.slice(idx);

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

  const P = context.__probe;
  assert('probe_exported', !!P && !!P.HierarchicalWorldManager, {});

  if (!P) {
    for (const n of ['prompt_requires_dimensional_shifts', 'prompt_states_shift_shape',
      'prompt_forbids_inventing_shifts', 'consumer_creates_node_from_shifts',
      'no_shift_means_no_node', 'new_world_is_child_of_root']) assert(n, false, { reason: 'no probe' });
  } else {
    const prompt = String(P.EntityExtractionPrompt || '');
    assert_d1(prompt);
    assert_d2(prompt);
    assert_d3(prompt);

    // ── D4: 소비 경로가 실제로 노드를 만드는가 (모델 출력 → 정책 → createNode → activePath) ──
    const W = P.HierarchicalWorldManager;
    W.loadWorldGraph([], true);
    const rootId = W.getProfile().rootId;

    const modelWorld = {
      exists: { magic: true },
      dimensionalShifts: [
        { from: '주요 세계', to: '아르카디아', type: 'portal' }
      ]
    };
    const policy = P.resolveStructuredWorldMutationPolicy(modelWorld);
    const channel = P.classifyNarrativeTurnChannel('제단에 손을 얹었다.', '눈앞이 바뀌었다. 다른 세계에 서 있었다.');
    let createdId = null;
    const beforeCount = W.getProfile().nodes.size;

    if (channel.channel === 'scene' && policy.allowDimensionalShift) {
      for (const shift of modelWorld.dimensionalShifts) {
        const targetName = String(shift?.to || shift?.target || shift?.world || '').trim();
        if (!targetName) continue;
        let targetNode = null;
        for (const [, node] of W.getProfile().nodes) {
          const nm = String(node?.name || '').trim();
          if (nm && (nm === targetName || nm.includes(targetName) || targetName.includes(nm))) { targetNode = node; break; }
        }
        if (!targetNode) {
          const r = W.createNode({ name: targetName, layer: 'dimension', parent: W.getProfile().rootId, source: 'llm_structured_world_payload' });
          if (r.success) { targetNode = r.node; createdId = r.node.id; }
        }
        if (targetNode) W.changeActivePath(targetNode.id, { method: String(shift?.type || shift?.method || 'llm_structured') });
      }
    }
    const afterCount = W.getProfile().nodes.size;
    assert('consumer_creates_node_from_shifts',
      !!createdId && afterCount === beforeCount + 1 && W.getProfile().activePath.includes(createdId),
      { channel: channel.channel, allowShift: policy.allowDimensionalShift, createdId, beforeCount, afterCount,
        activePath: W.getProfile().activePath });

    // ── D5: 전환이 없으면 노드를 만들지 않는다 ──
    // 주의: 여기서 loadWorldGraph 로 초기화하면 D6 이 볼 createdId 가 사라진다 —
    //       D6 을 먼저 판정하고 초기화한다.
    const created = W.getProfile().nodes.get(createdId);
    const rootChildren = W.getProfile().nodes.get(W.getProfile().rootId)?.children || [];
    assert('new_world_is_child_of_root',
      created?.parent === W.getProfile().rootId || rootChildren.includes(createdId),
      { parent: created?.parent, rootId: W.getProfile().rootId, createdId });

    W.loadWorldGraph([], true);
    const root2 = W.getProfile().rootId;
    const noShiftWorld = { exists: { magic: true }, setting: { places: ['왕도'] } };
    const policy2 = P.resolveStructuredWorldMutationPolicy(noShiftWorld);
    const before2 = W.getProfile().nodes.size;
    if (policy2.allowDimensionalShift) {
      // 만들면 안 되는데 만들어진 경우
      W.createNode({ name: '발명된세계', parent: root2, layer: 'dimension' });
    }
    assert('no_shift_means_no_node',
      W.getProfile().nodes.size === before2 && policy2.allowDimensionalShift === false,
      { allowShift: policy2.allowDimensionalShift, nodes: W.getProfile().nodes.size, note: '전환 없으면 정책이 차단' });
  }

  function assert_d1(prompt) {
    const has = /dimensionalShifts|dimensional_shifts/i.test(prompt);
    assert('prompt_requires_dimensional_shifts', has, { found: has, prompt_chars: prompt.length });
  }
  function assert_d2(prompt) {
    // 소비부가 읽는 키: to/target/world + from + type/method
    const shapeOk = /dimensionalShifts/.test(prompt)
      && /\bto\b/.test(prompt) && /\bfrom\b/.test(prompt) && /\btype\b/.test(prompt);
    assert('prompt_states_shift_shape', shapeOk, { shapeOk });
  }
  function assert_d3(prompt) {
    // "명시적 전환만" — 발명 금지. 없으면 모델이 아무 장면에서나 세계를 만든다.
    const forbids = /only\s+(?:an?\s+)?explicit|never\s+infer|do not invent.{0,80}shift|not\s+infer.{0,60}(shift|world)/i.test(prompt);
    assert('prompt_forbids_inventing_shifts', forbids, { forbids });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
