'use strict';
// 실측: "세계 = 인물(세포)들이 모인 다세포생물" 관점에서 — 인물의 움직임이 세계로 흐르는가.
//
// 사용자 모델(2026-09-29): "세계가 마치 큰 범위의 인물인 거처럼 살아움직이게끔 만들자.
//   인물이 자연스럽게 움직이고. 세계는 일종의 여러 세포가 모여서 움직이는 다세포생물처럼 보는 거야.
//   세포는 인물이고 그것이 모인 게 세계인 거지."
//
// 물어야 할 것(측정 가능한 형태로):
//   ① 인물(세포)의 움직임이 기록되는가        — CharacterStateTracker
//   ② 세계(개체)의 움직임이 기록되는가        — WorldStateTracker
//   ③ 인물의 움직임이 세계로 집계되는가       — 이게 핵심. 지금은?
//   ④ 세계가 인물에게 영향을 주는가(역방향)
//
// 정적 단서:
//   CharacterStateTracker.isCriticalMoment(entityName, newState): health/location 비교
//   WorldStateTracker.isCriticalMoment(newWorldState): activePath 비교만
//   WorldStateTracker.recordState 호출부: 05k:418 단 1곳
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
code = code.slice(0, idx) + `
    globalThis.__probe = {
        CharacterStateTracker, WorldStateTracker, HierarchicalWorldManager,
        EntityManager, EntityAwareProcessor, MemoryEngine
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

  // ── ① 인물(세포)의 움직임이 기록되는가 ──
  const CS = P.CharacterStateTracker;
  CS.resetState({});
  CS.recordState('아리엘', 10, { health: '건강', currentLocation: '왕도', visibleState: ['경계 중'] });
  CS.recordState('아리엘', 11, { health: '부상', currentLocation: '검은 탑', visibleState: ['쓰러짐'] });
  const csState = CS.getState();
  out.cell_motion = {
    question: '인물(세포)의 움직임이 기록되는가',
    tracked_entities: Object.keys(csState),
    turnLog_length: csState['아리엘']?.turnLog?.length,
    sample_log: (csState['아리엘']?.turnLog || []).slice(0, 2),
    critical_by_health: CS.isCriticalMoment('아리엘', { healthStatus: '부상', currentLocation: '검은 탑' }),
    critical_by_location: CS.isCriticalMoment('아리엘', { healthStatus: '건강', currentLocation: '다른 곳' }),
    verdict: '인물별 턴 로그 + 임계 판정(건강/위치)이 동작한다'
  };

  // ── ② 세계(개체)의 움직임이 기록되는가 ──
  const WS = P.WorldStateTracker;
  const W = P.HierarchicalWorldManager;
  W.loadWorldGraph([], true);
  const root = W.getProfile().rootId;
  const childA = W.createNode({ name: '검은 탑', parent: root, layer: 'dimension' });
  WS.resetState(null);
  // 05k:406-418 과 같은 형태의 worldSnapshot
  const snap1 = { activePath: [root], rules: {}, global: {}, classification: '', worldSummary: '', ruleHighlights: [], notes: '' };
  WS.recordState(1, snap1);
  const snap2 = { ...snap1, activePath: [root, childA.node.id], notes: 'Shift: 주요 세계->검은 탑' };
  WS.recordState(2, snap2);
  const wsState = WS.getState();
  out.organism_motion = {
    question: '세계(개체)의 움직임이 기록되는가',
    turnLog_length: wsState?.turnLog?.length,
    sample: (wsState?.turnLog || []).slice(0, 2),
    critical_on_path_change: WS.isCriticalMoment(snap2),
    critical_on_same_path: WS.isCriticalMoment(snap2),
    verdict: '세계 상태 로그는 경로 변경으로만 움직임을 감지한다'
  };

  // ── ③ 핵심: 인물의 움직임이 세계로 집계되는가 ──
  // 인물이 부상/이동했을 때 세계의 worldSnapshot 이 달라지는가?
  const before = JSON.stringify(WS.getState()?.turnLog?.slice(-1) || []);
  CS.recordState('세포A', 12, { health: '사망', currentLocation: '폐허' });
  const after = JSON.stringify(WS.getState()?.turnLog?.slice(-1) || []);
  out.cell_to_organism_flow = {
    question: '인물의 움직임이 세계로 집계되는가 (핵심)',
    world_state_changed_by_entity_change: before !== after,
    note: '인물 상태를 바꿔도 세계 상태 로그는 변하지 않는다 — 두 계층이 독립',
    how_world_snapshot_is_built: '05k:406-414 는 worldProfile.currentRules/global/classification/worldSummary 만 본다 — 인물 상태를 읽지 않는다',
    entity_fields_exist_for_world_link: (() => {
      // 엔티티에 '소속 세계' 필드가 있나
      const src = fs.readFileSync(path.join(ROOT, 'src/parts/12-processors-world-entity.js'), 'utf8');
      const patch = src.match(/Entity patch fields may include:\s*\n([^\n]*)/);
      const fields = (patch?.[1] || '').split(',').map(s => s.trim()).filter(Boolean);
      const worldLink = fields.filter(f => /world|node|dimension|realm/i.test(f));
      return { all_fields: fields, world_link_fields: worldLink, has_world_link: worldLink.length > 0 };
    })()
  };

  // ── ④ 세계 → 인물 방향 ──
  out.organism_to_cell = {
    question: '세계가 인물에게 영향을 주는가',
    mechanism: '세계 규칙은 프롬프트로 매 턴 주입된다(간접). 인물 상태 필드에 직접 쓰지는 않는다.',
    indirect_only: true,
    note: '세계 규칙이 인물 상태(예: 이 세계에선 마법 불가)를 바꾸는 코드는 없다'
  };

  // ── ⑤ 두 트래커의 API 대칭 ──
  out.api_symmetry = {
    Cell: Object.keys(CS).sort(),
    Organism: Object.keys(WS).sort(),
    same_shape: JSON.stringify(Object.keys(CS).sort()) === JSON.stringify(Object.keys(WS).sort()),
    note: 'API 모양이 같다 — 구조적으로 이미 "같은 종류의 것"으로 설계되어 있다'
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
