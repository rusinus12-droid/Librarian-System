'use strict';
// Gate: 승격·강등 (개편 마무리) — 기억을 세계 규칙으로 올리고 되돌린다.
//
// 사용자 결정(2026-09-29): 방식 **A(기억 화면에서 승격)** + **승격 취소(강등) 승인**.
//
// 실측된 제약(설계 근거):
//   ① 규칙 삭제 경로가 **0개**다. `08a.deepMerge` 는 배열을 `new Set` 합집합으로 만들므로
//      `updateNode` 로는 규칙을 **제거할 수 없다** → 강등하려면 명시적 제거 경로가 필요하다.
//   ② `getWorldCustomRuleLines` 는 `Object.values(custom)` 을 평탄화하고,
//      `buildGuiWorldCustomRules` 는 저장 시 **`rule_1..N` 으로 키를 재부여**한다.
//      → 승격 키를 기억에 기록해도 GUI 저장 한 번이면 어긋난다.
//      **강등은 키가 아니라 내용으로 찾아 제거해야 한다.**
//   ③ 회상 제외 수단은 이미 있다 — `provenanceStatus='retracted'` → `hbm.rollbackState
//      ='candidate_deleted'` → `10i` 필터가 후보에서 뺀다(새 축을 만들지 않는다).
//
// 이 게이트가 고정하는 계약:
//   P1 08a 에 규칙 제거 경로가 있다 (지금 0개 → 신규)
//   P2 승격이 규칙을 노드 custom 에 넣는다 (실행)
//   P3 승격이 어느 규칙인지 기록한다 (강등이 찾을 수 있게 — 키가 아니라 **내용**)
//   P4 승격된 기억이 회상에서 제외된다 (실행 — 기존 provenanceStatus 경로 재사용)
//   P5 강등이 규칙을 실제로 제거한다 (실행 — deepMerge 로는 불가)
//   P6 강등이 회상 자격을 되돌린다 (실행)
//   P7 승격 실패(노드 없음·빈 내용)에 기억이 회상에서 사라지지 않는다 (원자성)
//   P8 자동 승격이 없다 — 사용자 조작 경로만 (하드코딩 임계·자동 판정 금지)
//   P9 승격 버튼이 기억 카드에 있고 15d 가 배선한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC08A = fs.readFileSync(path.join(ROOT, 'src/parts/08a-world-graph.js'), 'utf8');
const SRC15B = fs.readFileSync(path.join(ROOT, 'src/parts/15b-gui-content-world-dlc.js'), 'utf8');
const SRC15D = fs.readFileSync(path.join(ROOT, 'src/parts/15d-gui-events-finalize.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probeHWM = HierarchicalWorldManager;
    globalThis.__probePromotion = (typeof WorldPromotionBridge !== 'undefined') ? WorldPromotionBridge : null;
` + code.slice(idx);

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

const noop = () => {};
const mk = () => ({
  _v: '', _t: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = new FakeDocument();
const store = new Map();
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
  async getCharacterFromIndex() { return { id: 'c1', name: 'T', chats: [] }; },
  async getChatFromIndex() { return { id: 'ch1', msg: [] }; },
  async getCharacter() { return { id: 'c1', name: 'T', chats: [] }; },
  async getDatabase() { return { selectedPersona: 0, personas: [] }; },
  async registerSetting() {}, async registerButton() {},
  async requestPluginPermission() { return true; },
  async showContainer() {}, async hideContainer() {}, async onUnload() {},
  addRisuScriptHandler: noop
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

(async () => {
  let runError = '';
  try { vm.runInContext(code, context, { timeout: 30000 }); } catch (e) { runError = String(e && e.message || e).slice(0, 400); }
  await new Promise(r => setTimeout(r, 140));
  assert('dist_runs_without_error', !runError, { error: runError });

  const W = context.__probeHWM;
  const P = context.__probePromotion;
  assert('probes_exported', !!W && !!P, { world: !!W, promotion: !!P });
  if (!W) { console.log(JSON.stringify({ ok: false, assertions }, null, 2)); process.exit(1); }

  // ── P1: 규칙 제거 경로가 있는가 (소스 계약 — 실측 0개였다) ──
  const hasRemoval = /const\s+removeWorldRuleByText\s*=/.test(SRC08A)
    || /const\s+removeCustomRuleByText\s*=/.test(SRC08A);
  assert('world_rule_removal_exists', hasRemoval, {
    has_removal: hasRemoval,
    note: 'deepMerge 는 배열을 합집합으로 만들므로 updateNode 로는 규칙을 제거할 수 없다'
  });

  // ── 정본 준비 ──
  W.loadWorldGraph([], true);
  const rootId = W.getProfile().rootId;
  const node = W.createNode({ name: '아르카디아', parent: rootId, layer: 'dimension' });
  const nodeId = node.node.id;
  W.changeActivePath(nodeId, { method: 'probe' });

  const TEXT = '마력은 저주받은 자만 쓴다';
  const memoryMeta = { imp: 7, t: 12, ttl: -1 };

  if (P) {
    // ── P2·P3: 승격 (실행) ──
    const promoted = P.promote({ nodeId, text: TEXT, memoryMeta });
    const afterPromote = W.getProfile().nodes.get(nodeId)?.rules?.custom || {};
    const flatAfter = Object.values(afterPromote).flatMap(v => Array.isArray(v) ? v : [v]).map(String);
    assert('promote_adds_world_rule',
      promoted?.ok === true && flatAfter.includes(TEXT),
      { result: promoted, custom: afterPromote });
    assert('promote_records_locator_by_text',
      String(promoted?.locator?.text || '') === TEXT,
      { locator: promoted?.locator,
        note: 'GUI 저장이 키를 rule_1..N 으로 재부여하므로 키가 아니라 내용으로 찾아야 한다' });

    // ── P4: 승격된 기억이 회상에서 제외되는가 (기존 provenanceStatus 경로 재사용) ──
    const memAfter = promoted?.memoryMeta || {};
    assert('promote_marks_memory_for_recall_exclusion',
      String(memAfter.provenanceStatus || '').toLowerCase() === 'retracted'
        && !!memAfter.promotedTo,
      { provenanceStatus: memAfter.provenanceStatus, promotedTo: memAfter.promotedTo });

    // ── P5: 강등이 규칙을 실제로 제거하는가 (실행) ──
    const demoted = P.demote({ nodeId, locator: promoted?.locator, memoryMeta: memAfter });
    const afterDemote = W.getProfile().nodes.get(nodeId)?.rules?.custom || {};
    const flatDemote = Object.values(afterDemote).flatMap(v => Array.isArray(v) ? v : [v]).map(String);
    assert('demote_removes_world_rule',
      demoted?.ok === true && !flatDemote.includes(TEXT),
      { result: demoted, custom: afterDemote, note: 'deepMerge 로는 제거 불가 — 명시 경로가 있어야 한다' });

    // ── P6: 강등이 회상 자격을 되돌리는가 ──
    const memDemoted = demoted?.memoryMeta || {};
    assert('demote_restores_recall_eligibility',
      String(memDemoted.provenanceStatus || '').toLowerCase() !== 'retracted'
        && !memDemoted.promotedTo,
      { provenanceStatus: memDemoted.provenanceStatus, promotedTo: memDemoted.promotedTo });

    // ── P7: 실패 시 기억이 회상에서 사라지지 않는다 (원자성) ──
    const badNode = P.promote({ nodeId: 'no_such_node', text: TEXT, memoryMeta });
    const badText = P.promote({ nodeId, text: '   ', memoryMeta });
    assert('promote_failure_does_not_strand_memory',
      badNode?.ok === false && badText?.ok === false
        && String(badNode?.memoryMeta?.provenanceStatus || '').toLowerCase() !== 'retracted'
        && String(badText?.memoryMeta?.provenanceStatus || '').toLowerCase() !== 'retracted',
      { badNode, badText });

    // ── P8: 자동 승격 없음 — 승격은 명시 호출로만 일어난다 ──
    //   턴 처리(05k)·유지보수(05h) 어디에서도 promote 를 부르지 않아야 한다.
    const autoCallers = ['05k-narrative-turn-processing.js', '05h-turn-maintenance-worker.js', '05e-canonical-turn-memory-helpers.js']
      .filter(f => {
        try { return /WorldPromotionBridge|\.promote\(/.test(fs.readFileSync(path.join(ROOT, 'src/parts', f), 'utf8')); }
        catch { return false; }
      });
    assert('no_automatic_promotion', autoCallers.length === 0, { auto_callers: autoCallers });
  } else {
    assert('promote_adds_world_rule', false, { reason: 'WorldPromotionBridge 없음' });
    assert('promote_records_locator_by_text', false, { reason: 'WorldPromotionBridge 없음' });
    assert('promote_marks_memory_for_recall_exclusion', false, { reason: 'WorldPromotionBridge 없음' });
    assert('demote_removes_world_rule', false, { reason: 'WorldPromotionBridge 없음' });
    assert('demote_restores_recall_eligibility', false, { reason: 'WorldPromotionBridge 없음' });
    assert('promote_failure_does_not_strand_memory', false, { reason: 'WorldPromotionBridge 없음' });
    assert('no_automatic_promotion', true, { note: '브리지가 없으니 자동 호출도 없다 — 구현 후 재검증' });
  }

  // ── P9: 기억 카드에 승격 버튼 + 15d 배선 ──
  //   ★ 문자열 존재는 배선의 증거가 아니다. 실측: `act-promote-mem` 이
  //     `act-promote-mem-disabled` 의 **부분 문자열**이라 변이가 그대로 통과했다(M6 MISS).
  //     버튼은 **속성 전체**(닫는 따옴표 포함)로 보고, 핸들러는 브리지 **호출**까지 본다.
  const cardHasButton = /class="btn bs act-promote-mem"/.test(SRC15B);
  const cardHasDemote = /class="btn bs act-demote-mem"/.test(SRC15B);
  const cardBadge = /promotedBadge/.test(SRC15B);
  assert('memory_card_has_promote_and_demote_buttons',
    cardHasButton && cardHasDemote && cardBadge,
    { promote_button: cardHasButton, demote_button: cardHasDemote, badge: cardBadge });

  // 핸들러: ① 분기 조건이 실제로 그 클래스를 잡고(죽은 `false &&` 금지)
  //         ② 브리지를 **호출**하고 ③ 재스탬프를 건다.
  const handlerBlock = (() => {
    const i = SRC15D.indexOf("target.classList.contains('act-promote-mem')");
    return i < 0 ? '' : SRC15D.slice(i, i + 3400);
  })();
  const branchIsLive = /else if \(target\.classList\.contains\('act-promote-mem'\)/.test(SRC15D)
    && !/false && \(?target\.classList\.contains\('act-promote-mem'\)/.test(SRC15D);
  const callsBridge = /\.promote\(/.test(handlerBlock) && /\.demote\(/.test(handlerBlock);
  const restamps = /annotateMemoryMeta/.test(handlerBlock);
  const persists = /persistWorldGraphFromGui/.test(handlerBlock);
  assert('event_delegation_wires_promotion',
    branchIsLive && callsBridge && restamps && persists,
    { branch_live: branchIsLive, calls_bridge: callsBridge, restamps, persists,
      handler_len: handlerBlock.length });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
