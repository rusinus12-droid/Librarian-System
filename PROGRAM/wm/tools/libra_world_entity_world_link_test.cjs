'use strict';
// Gate: 세포↔위치 소속 (4단계) — 인물이 어느 세계에 속하는지 기록되고 인물 컨텍스트에 나타난다.
//
// 사용자 결정(2026-09-29): ① 집단 임계는 LLM 판단(A) ② **인물이 세계에 속한다(A)**
//   — 세계가 인물 관계에서 창발하는(B) 방향이 아니라, 계층 트리에 속한다.
//
// 실측된 부재(수정 전):
//   - 인물 레코드 20개 필드에 "어느 세계 소속"을 담을 자리가 없다(world_link_fields: [])
//   - CharacterStateTracker 의 턴 로그는 location/mood/health/notes 만 기록한다
//   - 05k:361 의 recordState 호출부는 세계 정본을 보지 않는다
//     (worldProfile 은 3줄 뒤 블록에서 const 로 선언되므로 그 자리에서는 TDZ 다)
//   - 04:119 가 "위치는 휘발성"이라고 명시하므로 위치에서 소속을 파생할 수 없다
//     → 소속은 **명시적으로** 기록돼야 한다
//
// 이 게이트가 고정하는 계약:
//   C1 05k 가 인물 상태를 기록할 때 세계 정본에서 소속을 읽는다 (배선)
//   C2 기록된 턴 로그 항목에 소속 세계가 남는다 (실행)
//   C3 저장→정규화 왕복 후에도 소속이 살아남는다 (화이트리스트 함정 방지)
//   C4 인물 컨텍스트(formatForPrompt)가 소속을 낸다 (실행 — 모델이 보는 자리)
//   C5 인물 컨텍스트가 세계 **규칙**을 복사하지 않는다 (5단계 중복의 재발 방지)
//   C6 세계 정본에 소속이 없으면 필드가 비어 있다 (빈 값을 발명하지 않는다)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_05K = fs.readFileSync(path.join(ROOT, 'src/parts/05k-narrative-turn-processing.js'), 'utf8');
const SRC_09D = fs.readFileSync(path.join(ROOT, 'src/parts/09d-section-character-world-state.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probeHWM = HierarchicalWorldManager; globalThis.__probeCST = CharacterStateTracker;\n' + code.slice(idx);

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
  const CST = context.__probeCST;
  assert('probes_exported', !!W && !!CST, { world: !!W, tracker: !!CST });
  if (!W || !CST) { console.log(JSON.stringify({ ok: false, assertions }, null, 2)); process.exit(1); }

  // ── C1: 05k 가 소속을 정본의 해석 함수로 얻어 넘기는가 (배선) ──
  const recordCall = (() => {
    const i = SRC_05K.indexOf('CharacterStateTracker.recordState(canonicalEntityName');
    return i < 0 ? '' : SRC_05K.slice(Math.max(0, i - 3000), i + 300);
  })();
  const usesResolver = /resolveEntityWorldName/.test(recordCall);
  const affiliationPassed = /world:\s*\w/.test(recordCall);
  assert('record_path_reads_world_canon', usesResolver && affiliationPassed,
    { uses_resolver: usesResolver, affiliation_passed: affiliationPassed });

  // ── C1b: 해석 함수 자체를 **실행**해 판정한다 (배선만 보면 "자명한 값" 변이를 못 잡는다) ──
  //   실측: 대조군 M6(루트 이름을 소속으로 냄)이 배선 검사만으로는 MISS 였다.
  W.loadWorldGraph([], true);
  const rootIdB = W.getProfile().rootId;
  const worldA = W.createNode({ name: '아르카디아', parent: rootIdB, layer: 'dimension' });
  const regionB = W.createNode({ name: '그림자 협곡', parent: worldA.node.id, layer: 'region' });
  const resolver = typeof W.resolveEntityWorldName === 'function' ? W.resolveEntityWorldName : null;
  const resolverCases = resolver ? {
    root_only: (() => { const snap = W.getProfile(); return snap.rootId; })(),
    by_location: resolver({ location: '그림자 협곡' }),
    by_location_deep: resolver({ location: '아르카디아' }),
    unknown_location_falls_back_to_active: resolver({ location: '없는 곳' }),
    exact_match_only: (() => { W.changeActivePath(rootIdB, { method: 'probe' }); return resolver({ location: '그림자' }); })(),
    no_active_world: (() => { W.loadWorldGraph([], true); return resolver({ location: '' }); })()
  } : null;
  assert('resolver_is_executable_and_correct',
    !!resolver
      && resolverCases.by_location === '아르카디아'          // 깊은 노드 → 최상위 세계
      && resolverCases.by_location_deep === '아르카디아'
      && resolverCases.exact_match_only === ''               // 부분 일치 거부
      && resolverCases.no_active_world === '',               // 루트뿐이면 빈 값(발명 금지)
    { has_resolver: !!resolver, cases: resolverCases });

  // 이후 단언이 쓸 정본 상태를 복원한다
  W.loadWorldGraph([], true);
  const rootAfter = W.getProfile().rootId;
  const worldA2 = W.createNode({ name: '아르카디아', parent: rootAfter, layer: 'dimension' });
  W.changeActivePath(worldA2.node.id, { method: 'gate' });

  // ── C2: 기록된 턴 로그에 소속이 남는가 (실행) ──
  const nodeName = String(W.getCurrentNode?.()?.name || '').trim();

  CST.resetState(null);
  CST.recordState('아리엘', 11, { currentLocation: '검은 탑', currentMood: '경계', healthStatus: '', world: nodeName });
  const log = CST.getState()?.아리엘?.turnLog || [];
  assert('state_log_records_affiliation',
    log.length === 1 && String(log[0]?.world || '') === nodeName && nodeName === '아르카디아',
    { node_name_from_canon: nodeName, logged_world: log[0]?.world, log_keys: log[0] ? Object.keys(log[0]) : [] });

  // ── C3: 저장→정규화 왕복 후에도 살아남는가 (화이트리스트 함정) ──
  const raw = JSON.parse(JSON.stringify(CST.getState()));
  CST.resetState(raw);
  const roundTripWorld = String(CST.getState()?.아리엘?.turnLog?.[0]?.world || '');
  assert('affiliation_survives_normalization', roundTripWorld === nodeName,
    { after_roundtrip: roundTripWorld, expected: nodeName });

  // ── C4: 인물 컨텍스트가 소속을 내는가 (실행 — 모델이 보는 자리) ──
  const promptText = String(CST.formatForPrompt('아리엘') || '');
  assert('character_context_surfaces_affiliation',
    promptText.includes('아르카디아'),
    { prompt: promptText.slice(0, 400) });

  // ── C5: 인물 컨텍스트가 세계 **규칙**을 복사하지 않는가 (중복 재발 방지) ──
  // 세계 규칙은 세계 블록(13c)이 매 턴 낸다 — 인물 컨텍스트가 또 내면 5단계에서 지운 중복이 돌아온다.
  const rulesInCharContext = /존재\/Exists|장소·시설|현상\/Phenomena|extractWorldRuleHighlights/.test(promptText);
  assert('character_context_does_not_copy_world_rules', !rulesInCharContext,
    { prompt: promptText.slice(0, 400) });

  // ── C6: 정본에 소속이 없으면 빈 값 (발명 금지) ──
  W.loadWorldGraph([], true);   // 루트만 — 그래도 루트 이름은 있다
  CST.resetState(null);
  CST.recordState('아리엘', 12, { currentLocation: '어딘가' });   // world 없이 기록
  const noWorldLog = CST.getState()?.아리엘?.turnLog?.[0] || {};
  assert('no_affiliation_invents_nothing',
    String(noWorldLog.world || '') === '',
    { world: noWorldLog.world, keys: Object.keys(noWorldLog) });

  // ── C7: 09d 정규화기가 소속 필드를 명시적으로 보존하는가 (주석/스프레드 의존 방지) ──
  const normBlock = (() => {
    const i = SRC_09D.indexOf('const normalizeCharacterStateLog = (entry = {}) => ({');
    return i < 0 ? '' : SRC_09D.slice(i, i + 520);
  })();
  assert('normalizer_preserves_affiliation_explicitly',
    /\bworld\s*:/.test(normBlock),
    { block: normBlock.slice(0, 300) });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
