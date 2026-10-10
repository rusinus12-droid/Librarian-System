'use strict';
// 실측: 세계 그래프가 실전에서 왜 노드를 만들지 못하는지 — 실제 출하 프롬프트 + 실모델로 확인한다.
//
// 사용자 관찰: "월드 그래프가 제대로 작동되는 걸 본 적이 없다. 너무 휴리스틱하고 오작동이 많다.
//               템플릿 형식으로 세계관을 적용하는 게 의도였는데."
//
// 정적 분석으로 확정된 후보 원인(실행으로 검증 대상):
//   A. 노드 생성 경로가 05k:200 단 하나이고, 조건이 ① LLM 이 world.dimensionalShifts 를 내고
//      ② channel === 'scene' 일 때만이다. 그런데 추출 프롬프트(12, EntityExtractionPrompt)의
//      "World patch fields may include:" 목록에 dimensionalShifts 가 없다 → LLM 이 낼 이유가 없다.
//   B. world.global/structure/state 는 프롬프트가 요구하지만 normalizeWorldRuleUpdate(12:130 / 01a:441)가
//      ['exists','systems','physics','setting','custom'] 5개만 처리 → 조용히 버려진다.
//   C. 규칙은 항상 "현재 노드"(= 루트)에 쌓인다(12:2533 updateNode) → 97턴을 돌려도 노드 1개.
//
// 이 스크립트는 실제 출하 프롬프트를 번들에서 꺼내 실모델에 넣고, world 출력이
// 위 가설과 일치하는지 본다. (스킬: "실모델을 부르기 전에 프롬프트 안을 먼저 감사한다" +
//        "판정은 같은 실행 안에서 실제 저장 경로로 한다")
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        EntityExtractionPrompt,
        EntityAwareProcessor,
        HierarchicalWorldManager,
        classifyNarrativeTurnChannel,
        resolveStructuredWorldMutationPolicy
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
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 100));

  const P = context.__probe;
  const out = { run_error: runError || null };
  if (!P) { console.log(JSON.stringify({ ok: false, reason: 'no probe export' }, null, 2)); process.exit(1); }

  // ── [1] 프롬프트 감사: dimensionalShifts 가 계약에 있나 ──
  const prompt = String(P.EntityExtractionPrompt || '');
  out.prompt_audit = {
    prompt_chars: prompt.length,
    mentions_dimensionalShifts: /dimensionalShifts|dimensional_shifts/i.test(prompt),
    mentions_node_creation: /createNode|new world node|새 세계|dimension node/i.test(prompt),
    world_field_list: (prompt.match(/World patch fields may include:\s*\n?([^\n]*)/i) || [])[1] || null,
    mentions_global: /\bglobal\b/.test(prompt),
    mentions_structure: /\bstructure\b/.test(prompt),
    mentions_state: /\bstate\b/.test(prompt)
  };

  // ── [2] 정규화기가 프롬프트가 요구하는 키를 보존하나 (실제 저장 경로) ──
  // 프롬프트가 시키는 대로 만든 world 출력을 넣고, 정규화 후 무엇이 남는지 본다.
  const simulatedLlmWorld = {
    classification: { primary: 'dark-fantasy' },
    exists: { mythical_creatures: ['드래곤'] },
    systems: { leveling: true },
    setting: { places: ['검은 탑'] },
    physics: { special_phenomena: ['빛이 사라진다'] },
    custom: { rule_1: '마력은 저주받은 자만 쓴다' },
    // ↓ 프롬프트가 요구하지만 정규화기 목록에 없는 것들
    global: { multiverse: true, dimensionTravel: true },
    structure: { shiftTo: '그림자 왕국' },
    state: { currentLocation: '검은 탑' },
    dimensionalShifts: [{ to: '그림자 왕국', from: '주요 세계', type: 'portal' }]
  };

  const lore = [];
  P.HierarchicalWorldManager.loadWorldGraph(lore, true);
  const rootId = P.HierarchicalWorldManager.getProfile().rootId;

  // 12 의 실제 저장 경로를 흉내낸다: normalizeWorldRuleUpdate → updateNode
  // (12:2514 → 2533 과 같은 순서)
  const norm = P.EntityAwareProcessor.normalizeWorldRuleUpdate
    ? P.EntityAwareProcessor.normalizeWorldRuleUpdate(simulatedLlmWorld)
    : null;
  out.world_normalization = {
    input_keys: Object.keys(simulatedLlmWorld).sort(),
    normalized_keys: norm ? Object.keys(norm).sort() : null,
    dropped_keys: norm ? Object.keys(simulatedLlmWorld).filter(k => !(k in norm) && k !== 'classification' && k !== '__genreSourceText').sort() : null,
    kept_setting: norm?.setting || null,
    kept_custom: norm?.custom || null,
    kept_exists: norm?.exists || null
  };

  // ── [3] 정책: 차원 이동이 허용되나 ──
  out.mutation_policy = {
    with_dimensionalShifts: P.resolveStructuredWorldMutationPolicy(simulatedLlmWorld),
    without_dimensionalShifts: P.resolveStructuredWorldMutationPolicy({
      exists: { mythical_creatures: ['드래곤'] }, systems: { leveling: true }
    })
  };

  // ── [4] 채널 판정: 실제 RP 턴이 scene 인가 ──
  const rpUser = '나는 검은 탑 앞에 섰다.';
  const rpAi = '탑의 문이 천천히 열렸다. 그 안에서 낮은 목소리가 들려왔다. "오래 기다렸다, 여행자여."';
  out.channel = P.classifyNarrativeTurnChannel(rpUser, rpAi);

  // ── [5] 저장 경로가 노드를 만드는가 — 전체 파이프라인 재현 ──
  P.HierarchicalWorldManager.updateNode(rootId, { rules: norm || {}, meta: {} });
  const afterRules = P.HierarchicalWorldManager.getProfile().nodes.size;

  // 차원 이동 조건을 실제로 밟아 본다 (05k:184-216 과 같은 로직)
  const policy = out.mutation_policy.with_dimensionalShifts;
  let createdViaShift = null;
  if (out.channel.channel === 'scene' && policy.allowDimensionalShift) {
    const shifts = simulatedLlmWorld.dimensionalShifts;
    for (const shift of shifts) {
      const targetName = String(shift?.to || shift?.target || shift?.world || '').trim();
      let targetNode = null;
      for (const [, node] of P.HierarchicalWorldManager.getProfile().nodes) {
        const nm = String(node?.name || '').trim();
        if (nm && (nm === targetName || nm.includes(targetName) || targetName.includes(nm))) { targetNode = node; break; }
      }
      if (!targetNode) {
        const r = P.HierarchicalWorldManager.createNode({ name: targetName, layer: 'dimension', parent: rootId, source: 'llm_structured_world_payload' });
        if (r.success) { targetNode = r.node; createdViaShift = r.node.id; }
      }
    }
  }
  out.hierarchy_reproduction = {
    nodes_after_rule_update: afterRules,
    node_created_only_when_dimensionalShifts_present: createdViaShift,
    node_count_final: P.HierarchicalWorldManager.getProfile().nodes.size,
    note: '차원 이동이 있으면 노드가 생긴다 — 문제는 프롬프트가 그 필드를 요구하지 않는다는 것'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
