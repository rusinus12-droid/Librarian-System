'use strict';
// 실측: 세계(08a)와 HME 연상 그래프(10c)를 어떻게 조화시킬 수 있는가.
//
// 사용자 지시: "0번 바로 수정하고 hme랑 조화시킬 방법을 찾아봐."
//
// HME 그래프 구조 (실측으로 확인된 것):
//   노드 3종 — memory(`g_node_<hash>`), entity(`g_ent_<hash>`), lore(`g_lore_<hash>`)
//   엣지 6종 — E1 mentions_entity(memory→entity), E2 described_by_lore(entity→lore),
//             E3 relation_record(entity→entity), E4 shares_lore_ref(memory→lore),
//             shared_entity, turn_proximity (memory↔memory)
//   layer 2단 — 'meaning'(score>=0.72 + 강증거) / 'signal'(경로는 되지만 약함)
//   노드 ID = stableHash 기반 결정적  (08a 는 이제 같은 관례)
//
// 질문: 세계(계층 트리)가 HME(평면 연상 그래프)와 어떻게 만나는가.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = { HierarchicalWorldManager, stableHash: (typeof stableHash === 'function' ? stableHash : null) };
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
  if (!P?.HierarchicalWorldManager) { console.log(JSON.stringify({ ok: false }, null, 2)); process.exit(1); }
  const W = P.HierarchicalWorldManager;

  // ── ① 두 그래프의 구조 대조 ──
  out.structure_comparison = {
    world: {
      storage: 'lmai_world_graph (노드 배열 [id, node])',
      id_convention: 'node_<stableHash> (이번에 수정)',
      topology: '부모-자식 트리 (parent + children)',
      node_types: ['(단일 — layer 필드로 dimension 등)'],
      edges: 'parent/children 암묵 + connections(생산자 0)',
      traversal: 'activePath (단일 경로) → getEffectiveRules 상속',
      lifecycle: '턴 무관 영속 (규칙은 누적)'
    },
    hme: {
      storage: 'lmai_hme_graph_index (localPluginStorage 파생)',
      id_convention: 'g_node_/g_ent_/g_lore_ + stableHash — **결정적**',
      topology: '평면 그래프 (엣지 목록)',
      node_types: ['memory', 'entity', 'lore'],
      edges: 'E1 mentions_entity / E2 described_by_lore / E3 relation_record / E4 shares_lore_ref / shared_entity / turn_proximity',
      traversal: '시드 → BFS(maxHops 2) → 가중 전파',
      lifecycle: '턴별 재구축 (파생 캐시, 버리고 다시 만든다)'
    }
  };

  // ── ② 공통 접점 — 이미 있는 것 ──
  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;
  const a = W.createNode({ name: '왕도', parent: root, layer: 'dimension' });
  const b = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
  out.id_convention_alignment = {
    world_node_ids: [root, a.node.id, b.node.id],
    world_uses_hash: /^node_[a-z0-9]+$/i.test(a.node.id),
    hme_uses_hash: 'g_node_/g_ent_/g_lore_ + stableHash',
    now_aligned: '두 그래프 모두 stableHash 기반 결정적 ID — 같은 노드를 두 그래프에서 같은 키로 가리킬 수 있다',
    note: '이번 수정 전에는 world 만 Date.now() 라 재구축마다 ID 가 바뀌었다 → HME 가 가리킬 수 없었다'
  };

  // ── ③ 공유 토큰 — 두 그래프가 만나는 축 ──
  out.shared_tokens = {
    hme_has_world_fields_already: {
      worldSignature: 'HME memory 노드에 있음 (10c:471)',
      worldChanges: 'HME memory 노드에 있음 (10c:470)',
      worldRuleHighlights: 'HME memory 노드에 있음 (10c:472)',
      sharedWorldSignature: "E5 엣지 판정에 쓰임 (10c:922) — 'sharedWorldSignature'"
    },
    world_side_lacks: [
      'world 노드에 entity/lore 참조가 없다 (E1/E2 의 역방향 없음)',
      'world 노드에 turn 이 없다 (HME 는 turn 기반)',
      'world 는 파생 캐시가 아니라 영속 정본'
    ],
    natural_bridge: 'HME memory 노드가 이미 worldSignature/worldRuleHighlights 를 갖는다 → 세계 노드를 4번째 타입(g_world_)으로 추가하면 기존 엣지 판정(sharedWorldSignature)이 그대로 작동한다'
  };

  // ── ④ 조화 방식 3안 ──
  out.harmonization_options = [
    {
      id: 'A',
      name: '세계 노드를 HME 의 4번째 노드 타입으로 추가 (g_world_)',
      how: '10c 의 byType 에 world 를 추가하고, HME memory 노드의 worldSignature/worldRuleHighlights 로 엣지(E5 world_scope)를 만든다',
      pros: ['기존 sharedWorldSignature 판정이 재사용된다', 'HME 회상이 세계별로 기억을 거를 수 있다', '세계 계층이 회상에 참여한다'],
      cons: ['HME 는 파생 캐시(매번 재구축) — 세계의 영속 규칙을 매번 복사해야 한다(중복 재발 위험)', '노드 상한(800)에서 world 노드가 밀릴 수 있다'],
      duplicate_risk: '높음 — 세계 규칙을 HME 노드에 다시 넣으면 기억 중복과 같은 형태'
    },
    {
      id: 'B',
      name: 'HME 가 세계 정본을 읽기만 한다 (단방향 참조)',
      how: 'HME 가 그래프를 만들 때 08a 에서 활성 노드/규칙을 가져와 worldTags 로만 쓴다. 역방향(HME→세계)은 없다',
      pros: ['복사가 아니라 참조 — 중복 없음', 'HME 재구축 비용이 그대로', '08a 가 정본으로 남는다'],
      cons: ['HME 회상이 세계를 "이해"하지는 못한다(태그 수준)', '양방향 탐색 불가'],
      duplicate_risk: '낮음'
    },
    {
      id: 'C',
      name: '두 그래프를 별도로 두고, 회상 단계에서만 결합',
      how: '10i(회상)가 HME 후보와 세계 스코프를 각각 계산해 점수를 합친다. 그래프 자체는 안 섞는다',
      pros: ['각 계층의 수명이 그대로(영속 vs 파생)', '중복 0', '어느 쪽도 상대를 오염시키지 않는다'],
      cons: ['"세계가 인물과 만나는" 시각화가 안 된다', '결합 규칙을 새로 정해야 한다'],
      duplicate_risk: '없음'
    }
  ];

  // ── ⑤ 판정 — 실측 근거로 추천 ──
  out.recommendation = {
    pick: 'B 우선, 그 다음 C',
    why: [
      'A 는 중복 위험이 높다 — 세계 규칙을 HME 노드에 다시 넣는 것은 방금 확인한 기억 중복과 같은 형태다',
      'B 는 이미 있는 재료(worldSignature/worldRuleHighlights 가 HME memory 노드에 있음)를 정본에서 읽게 바꾸는 것뿐이다',
      'C 는 그래프는 안 섞고 회상에서만 결합 — 두 계층의 수명 차이(영속/파생)를 건드리지 않는다',
      'A 가 주는 것(세계별 회상 거르기)은 C 로도 얻을 수 있다'
    ],
    order: 'B → C → (A 는 "세계별 시각화"가 실제로 필요해질 때만)'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
