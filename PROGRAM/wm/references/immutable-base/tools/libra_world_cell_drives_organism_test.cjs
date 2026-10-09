'use strict';
// Gate: 세포의 움직임이 개체를 움직인다 (3단계 — LLM 판단, 하드코딩 임계 금지).
//
// 사용자 결정(승인 A): 집단 임계는 **LLM 판단**. 하드코딩("3명 이상 이동") 금지 —
//   그것이 5.2.8 오작동의 형태다.
//
// 실측된 현재 상태:
//   - WorldStateTracker.isCriticalMoment 는 **경로 변경만** 본다(인물은 건강·위치를 본다).
//   - 인물(세포)의 집단 움직임이 세계(개체)의 중요 순간이 되는 경로가 없다.
//   - 09d StateConsolidationBundler 는 인물+세계를 한 프롬프트로 보내지만
//     세계가 "인물들의 움직임 때문에 변했는가"를 **묻지 않는다**.
//
// 이 게이트가 고정하는 계약:
//   T1 번들이 "개체가 세포 때문에 변했는가"를 묻는다
//   T2 번들 출력 shape 에 그 판정 필드가 있다
//   T3 applyConsolidationResult 가 그 판정을 받아 중요 순간으로 기록한다
//   T4 하드코딩 임계가 없다 (인원 수·횟수 같은 숫자 규칙 금지)
//   T5 판정이 false 거나 없으면 기록하지 않는다 (오작동 방지)
//   T6 기록된 순간에 근거(어느 세포들)가 남는다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + '\n    globalThis.__probeWST = WorldStateTracker;\n' + code.slice(idx);

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

  const WS = context.__probeWST;
  assert('world_state_tracker_exported', !!WS, {});
  const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/09d-section-character-world-state.js'), 'utf8');

  if (!WS) {
    for (const n of ['bundle_asks_organism_change', 'bundle_separates_personal_from_world',
      'bundle_shape_has_critical_field', 'apply_records_organism_critical', 'no_hardcoded_threshold',
      'false_verdict_is_not_recorded', 'critical_records_evidence']) assert(n, false, { reason: 'no module' });
  } else {
    // ── T1/T2: 번들이 개체 변화를 묻고 shape 에 필드가 있다 ──
    const bundleStart = SRC.indexOf('You are LIBRA State Consolidation Bundler');
    const bundleEnd = bundleStart >= 0 ? SRC.indexOf("].join('\\n')", bundleStart) : -1;
    const bundleSystem = (bundleStart >= 0 && bundleEnd > bundleStart) ? SRC.slice(bundleStart, bundleEnd) : '';
    const asksOrganismChange = /charactersChangeWorld|whether the characters|did the characters|characters' movement.*world|world.*changed because/i.test(bundleSystem);
    assert('bundle_asks_organism_change', asksOrganismChange, { bundle_chars: bundleSystem.length, head: bundleSystem.slice(0, 300) });

    // ── T1b: 개인 변화와 세계 변화를 **명시적으로 갈라 말하는가** ──
    // 실측 회귀: 첫 프롬프트는 개인 부상을 세계 변화로 오판했다
    //   ("아리엘의 부상으로 인해 세계 내 건강 상태가 변경됨" → true).
    //   개인 조건 변화를 세계 변화가 아니라고 **명시**해야 모델이 가른다.
    const separatesPersonal = /injury, health, mood, emotion, personal gain or loss|is NOT a world change|belongs to the character, not to the world/i.test(bundleSystem);
    assert('bundle_separates_personal_from_world', separatesPersonal, { found: separatesPersonal });

    const shapeHasField = /"world":\{[^}]*"(criticalChange|charactersChangeWorld|worldShifted)"/.test(bundleSystem)
      || /"criticalChange"|"charactersChangeWorld"|"worldShifted"/.test(bundleSystem);
    assert('bundle_shape_has_critical_field', shapeHasField, { shapeOk: shapeHasField });

    // ── T3/T5/T6: applyConsolidationResult 가 판정을 받아 기록한다 ──
    WS.resetState(null);
    WS.recordState(10, { activePath: ['world_main'], rules: {}, global: {}, ruleHighlights: [], notes: '' });
    WS.applyConsolidationResult(11, {
      summary: '세 인물이 함께 왕도를 떠나 검은 탑으로 향했다.',
      significantChanges: ['집단 이동'],
      criticalChange: true,
      criticalReason: '여러 세포가 함께 이동해 세계의 무게중심이 옮겨갔다',
      criticalEntities: ['아리엘', '카일', '미르']
    });
    const st = WS.getState();
    const crit = (st.consolidated || []).filter(x => x.type === 'critical');
    assert('apply_records_organism_critical', crit.length === 1, {
      consolidated: (st.consolidated || []).map(x => ({ type: x.type, description: String(x.description || '').slice(0, 60) }))
    });
    assert('critical_records_evidence',
      crit.length === 1 && Array.isArray(crit[0].entities) && crit[0].entities.length === 3,
      { entities: crit[0]?.entities, reason: crit[0]?.reason });

    // ── T5: false 거나 없으면 기록하지 않는다 ──
    WS.resetState(null);
    WS.recordState(10, { activePath: ['world_main'], rules: {}, global: {}, ruleHighlights: [], notes: '' });
    // charactersChangeWorld 를 **명시적으로 false** 로 넘긴다 — 이게 실제 제품 경로다
    // (applyParsedBundle 이 항상 boolean 을 전달한다). 변이 M4 는 이 값을 기록으로 뒤집는다.
    WS.applyConsolidationResult(12, {
      summary: '평범한 하루', significantChanges: [],
      charactersChangeWorld: false, criticalChange: false,
      criticalReason: '', criticalEntities: []
    });
    const st2 = WS.getState();
    const crit2 = (st2.consolidated || []).filter(x => x.type === 'critical');
    const periodic2 = (st2.consolidated || []).filter(x => x.type === 'periodic');
    assert('false_verdict_is_not_recorded', crit2.length === 0 && periodic2.length === 1,
      { critical: crit2.length, periodic: periodic2.length });

    // ── T4: 하드코딩 임계가 없다 ──
    // 인원 수·횟수로 판정하는 코드(예: length >= 3, >= 2)를 찾는다.
    const srcNoComments = SRC.replace(/^\s*\/\/.*$/gm, '');
    // 하드코딩 임계의 실제 형태: **개체 변화 판정**을 개수로 하는 것.
    // (예: criticalEntities.length >= 3 — 이게 5.2.8 오작동의 형태다)
    //
    // 주의: `changes.length > 0` 같은 정상적인 상한·빈값 검사는 임계가 아니다.
    // 그래서 "판정식(worldChangedByCharacters 등) 안에서 개수를 숫자와 비교"만 잡는다 —
    // 전체 .length 비교를 잡으면 오탐이다(실측: 정상 코드 4곳이 걸렸다).
    // 하드코딩 임계의 실제 형태: **개체 변화 판정에 개수 비교가 섞이는 것**.
    // (예: criticalEntities.length >= 3 — 5.2.8 오작동의 형태)
    //
    // 판정에 쓰이는 심볼 주변만 본다. 전체 .length 비교를 잡으면 정상 상한 검사까지
    // 걸려 오탐이 난다(실측: 정상 코드 4곳).
    const judgmentSymbols = /(?:worldChangedByCharacters|charactersChangeWorld|criticalChange|worldShifted)/;
    let numericRule = false;
    let hits = [];
    for (const line of srcNoComments.split('\n')) {
      if (!judgmentSymbols.test(line)) continue;
      const m = line.match(/(?:criticalEntities|entities|characters|presentEntities)[\w.]*\.?length\s*(?:>=|>|<=|<)\s*[1-9]/);
      if (m) { numericRule = true; hits.push(m[0]); }
    }
    // 판정식이 개수 비교로 **대체된** 경우도 잡는다 (심볼 없이 길이만 비교하는 형태)
    if (!numericRule) {
      const assign = srcNoComments.match(/worldChangedByCharacters\s*=[\s\S]{0,300}?;/);
      if (assign && /(?:criticalEntities|entities|characters|presentEntities)[\w.]*\.?length\s*(?:>=|>)\s*[1-9]/.test(assign[0])) {
        numericRule = true;
        hits.push(String(assign[0].match(/(?:criticalEntities|entities|characters)[\w.]*\.?length\s*(?:>=|>)\s*[1-9]/)));
      }
    }
    assert('no_hardcoded_threshold', !numericRule,
      { foundNumericRule: numericRule, hits: hits.slice(0, 4) });
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
