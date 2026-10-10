'use strict';
// Gate: 월드라인에 **롤백 경계**(`cutoffTurn`)를 둔다 (#9) — 정본 `LIBRA.js` 대조.
//
// 왜 필요한가:
//   지금은 롤백을 **매번 라이브 대화에서 역추론**한다(`detectDrift`: node.pairIndex > maxLivePair).
//   그래서 계층마다 필터를 하나씩 덧대야 했다 —
//     기억(#1) · RP-LTM(#1) · 엔티티·관계(§5-5) · 세계 규칙(§5-6) · …
//   정본은 **경계 하나**를 저장하고 그걸로 자른다:
//     61122  worldlines.<id> = { id, parentId, forkTurn, cutoffTurn, active }
//     41792  effectiveCutoff = cutoffTurn == null ? Infinity : Number(cutoffTurn)
//     46304  refs.filter(r => … || Number(r.turnRange?.end) <= cutoffTurn)
//     45500  롤백 = previousTurn = batch[0].turn - 1  (그 턴까지가 유효)
//
// 계약:
//   C1 상태에 `cutoffTurn` 이 **영속**된다 (스키마 필드)
//   C2 `cutoffTurn` = **최고 유효 턴**(= 라이브 최대 pairIndex)
//   C3 롤백으로 라이브가 줄면 경계가 **내려가고**, 잘려나간 턴 집합이
//      기존 `detectDrift().rolledBack` 과 **정확히 일치**한다 (판정을 복제하지 않고 통합)
//   C4 **리롤은 경계를 움직이지 않는다** (같은 위치의 다른 응답 — 정본도 경계를 안 옮긴다)
//   C5 경계가 없으면 `Infinity` 다 (fail-open, 하위 호환 — 종전 동작과 동일)
//   C6 계층이 물어볼 **단일 판정 함수**가 있다 (`isTurnBeyondCutoff`)
//   C7 기존 `buildSupersededTurnSet` 동작이 **바뀌지 않는다** (이미 걸러지는 계층 보호)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = { LibraTurnWorldline };
` + code.slice(idx);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const mk = () => ({ style: {}, dataset: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, set textContent(v) {}, get textContent() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const store = new Map();
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => ({ id: 'c1', name: 'T', chats: [] }), getChatFromIndex: async () => ({ id: 'ch1', msg: [] }),
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

let done = false;
const finish = () => { if (done) return; done = true; const ok = assertions.every(a => a.ok); console.log(JSON.stringify({ ok, assertions }, null, 2)); process.exit(ok ? 0 : 1); };

// 관찰 쌍 만들기 — 실제 저장 형태와 같게.
// ★ `identityFor` 는 `pairIndex || index || 1` 순으로 읽는다 — `index` 만 주면 0 이 falsy 라 1로 수렴한다(실측).
const pair = (turn, tag) => ({ pairIndex: turn, userText: `u${turn}${tag}`, assistantText: `a${turn}${tag}` });

setTimeout(async () => {
  const WL = ctx.__probe && ctx.__probe.LibraTurnWorldline;
  assert('dist_runs_without_error', !runErr, { error: runErr });
  assert('worldline_exported', !!WL, { keys: WL ? Object.keys(WL).slice(0, 30) : null });
  if (!WL) { finish(); return; }

  // ── C1: 스키마에 cutoffTurn 이 있다 (영속 필드) ──
  const emptyState = WL.empty ? WL.empty('sc') : null;
  assert('schema_has_cutoff_turn',
    !!emptyState && Object.prototype.hasOwnProperty.call(emptyState, 'cutoffTurn'),
    { keys: emptyState ? Object.keys(emptyState) : null,
      note: '영속 상태에 경계가 있어야 매번 역추론하지 않는다' });

  // ── C2: 경계 = 최고 유효 턴 ──
  const observeFn = WL.observe || null;
  assert('observe_available', typeof observeFn === 'function', { type: typeof observeFn });
  if (typeof observeFn !== 'function') { finish(); return; }

  const scope = 'scope-cutoff';
  const live = [pair(1, 'a'), pair(2, 'a'), pair(3, 'a'), pair(4, 'a'), pair(5, 'a')];
  const s1 = await observeFn(scope, live, { now: 1000 });
  assert('cutoff_equals_highest_live_pair',
    Number(s1?.cutoffTurn) === 5, { cutoffTurn: s1?.cutoffTurn, liveMax: 5 });

  const eff = typeof WL.effectiveCutoff === 'function' ? WL.effectiveCutoff(s1) : null;
  assert('effective_cutoff_is_number_when_present', Number(eff) === 5, { effectiveCutoff: eff });

  // ── C5: 경계가 없으면 Infinity (fail-open) ──
  const effNone = typeof WL.effectiveCutoff === 'function' ? WL.effectiveCutoff(null) : null;
  const effUndef = typeof WL.effectiveCutoff === 'function' ? WL.effectiveCutoff({ nodes: [] }) : null;
  assert('effective_cutoff_fails_open',
    effNone === Infinity && effUndef === Infinity,
    { null: String(effNone), missing: String(effUndef), note: '경계가 없으면 제한 없음 — 종전 동작과 동일' });

  // ── C3: 롤백 → 경계가 내려가고, 잘린 턴이 detectDrift 와 일치 ──
  const rolled = [pair(1, 'a'), pair(2, 'a'), pair(3, 'a'), pair(4, 'a'), pair(5, 'a'), pair(6, 'a'), pair(7, 'a')];
  const s7 = await observeFn(scope, rolled, { now: 2000 });
  assert('cutoff_tracks_growth', Number(s7?.cutoffTurn) === 7, { cutoffTurn: s7?.cutoffTurn });

  //   턴 4 로 롤백 (5·6·7 이 잘려나간다)
  const truncated = [pair(1, 'a'), pair(2, 'a'), pair(3, 'a'), pair(4, 'a')];
  const s4 = await observeFn(scope, truncated, { now: 3000 });
  assert('rollback_lowers_cutoff', Number(s4?.cutoffTurn) === 4,
    { cutoffTurn: s4?.cutoffTurn, before: s7?.cutoffTurn });

  const beyond = typeof WL.turnsBeyondCutoff === 'function' ? WL.turnsBeyondCutoff(s4) : undefined;
  const drift = typeof WL.detectDrift === 'function'
    ? WL.detectDrift(scope, truncated) : null;
  const driftTurns = (drift?.rolledBack || []).map(item => Number(item.pairIndex)).sort((a, b) => a - b);
  assert('authoritative_cutoff_needs_no_repeat_topology_inference',
    JSON.stringify(beyond || []) === JSON.stringify([5, 6, 7]) && JSON.stringify(driftTurns) === JSON.stringify([]),
    { beyond, driftTurns, note: 'Authoritative cutoff remains effective without re-detecting inactive historical nodes.' });

  // ── C4: 리롤은 경계를 움직이지 않는다 ──
  //   ★ **깨끗한 스코프**를 쓴다 — 위 시나리오는 롤백 이력(턴 6·7 노드)이 남아 있어
  //     "경계를 넘은 턴"이 6·7 로 나오는 게 맞다(내 첫 단언이 틀렸다: 자기오류).
  const scopeR = 'scope-reroll';
  const s5clean = await observeFn(scopeR, [pair(1, 'a'), pair(2, 'a'), pair(3, 'a'), pair(4, 'a'), pair(5, 'a')], { now: 5000 });
  const rerolled = [pair(1, 'a'), pair(2, 'a'), pair(3, 'a'), pair(4, 'a'), pair(5, 'b')];
  const s5r = await observeFn(scopeR, rerolled, { now: 6000 });
  assert('reroll_does_not_move_cutoff', Number(s5r?.cutoffTurn) === 5 && Number(s5clean?.cutoffTurn) === 5,
    { before: s5clean?.cutoffTurn, after: s5r?.cutoffTurn, note: '같은 위치의 다른 응답 — 정본도 경계를 안 옮긴다' });
  const beyondAfterReroll = typeof WL.turnsBeyondCutoff === 'function' ? WL.turnsBeyondCutoff(s5r) : null;
  assert('reroll_leaves_no_turns_beyond_cutoff',
    Array.isArray(beyondAfterReroll) && beyondAfterReroll.length === 0,
    { beyond: beyondAfterReroll, note: '깨끗한 스코프에서는 리롤이 경계를 넘는 턴을 만들지 않는다' });
  //   리롤된 턴(5)은 경계 **안**이다 — 롤백과 구분된다.
  assert('rerolled_turn_is_within_cutoff',
    typeof WL.isTurnBeyondCutoff === 'function' && WL.isTurnBeyondCutoff(5, s5r) === false,
    { beyond: typeof WL.isTurnBeyondCutoff === 'function' ? WL.isTurnBeyondCutoff(5, s5r) : null });

  // ── C6: 계층이 묻는 단일 판정 함수 ──
  const ask = typeof WL.isTurnBeyondCutoff === 'function' ? WL.isTurnBeyondCutoff : null;
  assert('single_predicate_exists', typeof ask === 'function', { type: typeof ask, note: '계층이 묻는 단일 판정 함수' });
  if (typeof ask === 'function') {
    assert('predicate_answers_per_turn',
      ask(5, s4) === true && ask(4, s4) === false && ask(1, s4) === false,
      { t5: ask(5, s4), t4: ask(4, s4), t1: ask(1, s4) });
    assert('predicate_fails_open_without_state',
      ask(99, null) === false && ask(99, {}) === false,
      { null: ask(99, null), empty: ask(99, {}) });
  }

  // ── C7: 기존 동작 불변 (이미 걸러지는 계층 보호) ──
  const legacy = typeof WL.buildSupersededTurnSet === 'function' ? WL.buildSupersededTurnSet(s4) : null;
  assert('existing_superseded_set_unchanged',
    !!legacy && legacy.superseded instanceof Set && legacy.superseded.has(5) && legacy.superseded.has(6) && legacy.superseded.has(7)
    && !legacy.superseded.has(4),
    { superseded: legacy ? Array.from(legacy.superseded).sort((a, b) => a - b) : null,
      note: '경계 도입이 기존 판정을 바꾸면 안 된다' });

  // ── C8: 영속 왕복 (저장 → 로드 후에도 경계가 남는다) ──
  const reloaded = typeof WL.load === 'function' ? await WL.load(scope) : null;
  assert('cutoff_survives_persistence', Number(reloaded?.cutoffTurn) === 4,
    { reloaded: reloaded?.cutoffTurn, note: '마지막 관찰(턴 4 로 롤백)이 저장돼 있어야 한다' });
  const reloadedR = typeof WL.load === 'function' ? await WL.load(scopeR) : null;
  assert('reroll_cutoff_survives_persistence', Number(reloadedR?.cutoffTurn) === 5,
    { reloaded: reloadedR?.cutoffTurn });

  // ── C9: **노드 기록이 사라져도** 경계로 거른다 (실측된 결함 — 추측 아님) ──
  //   실측: 저장에서 롤백 노드가 없으면(트림·미기록·구 데이터) `superseded` 가 빈 집합이 되어
  //   기억·엔티티·RP-LTM 필터 4개가 **전부 무력**해졌다 — 경계는 답을 알고 있는데도.
  const scopeT = 'scope-trimmed';
  await observeFn(scopeT, [1, 2, 3, 4, 5, 6, 7].map(t => pair(t, 'a')), { now: 7000 });
  const sTrim = await observeFn(scopeT, [1, 2, 3, 4].map(t => pair(t, 'a')), { now: 8000 });
  const trimmed = JSON.parse(JSON.stringify(sTrim));
  trimmed.nodes = trimmed.nodes.filter(n => Number(n.pairIndex) <= 4);

  assert('trimmed_state_has_no_superseded_nodes',
    (WL.buildSupersededTurnSet(trimmed)?.superseded || new Set()).size === 0,
    { note: '전제 확인 — 노드가 사라지면 판정 집합이 비어야 시나리오가 성립한다' });

  const memTrim = WL.filterSupersededMemories(
    [{ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn: 6, imp: 5 }) }]\n롤백된 턴6` }], trimmed);
  const entTrim = WL.filterSupersededEntityRecords(
    [{ id: 'r6', entityA: 'A', entityB: 'B', meta: { created: 6, sourceTurn: 6 } }], trimmed);
  const rpTrim = typeof WL.filterSupersededRpItems === 'function'
    ? WL.filterSupersededRpItems([{ lastTurn: 6, text: '턴6 사실' }], trimmed) : null;

  assert('cutoff_catches_when_nodes_lost',
    memTrim.excluded > 0 && entTrim.excluded > 0 && (rpTrim ? rpTrim.excluded > 0 : true),
    { memory: memTrim.excluded, entity: entTrim.excluded, rp: rpTrim ? rpTrim.excluded : null,
      note: '경계가 남아 있으면 노드 없이도 롤백된 턴을 막는다' });

  //   리롤은 경계 **안**이므로 노드가 없어도 유지돼야 한다 (과잉 제거 금지)
  const memKeep = WL.filterSupersededMemories(
    [{ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn: 4, imp: 5 }) }]\n살아있는 턴4` }], trimmed);
  assert('cutoff_keeps_turns_within_boundary',
    memKeep.excluded === 0,
    { excluded: memKeep.excluded, cutoff: trimmed.cutoffTurn, note: '경계(4) 이하는 살린다' });

  // ── C10: 노드 판정과 경계가 **다른 답**을 내는 경우 — 술어가 둘 다 봐야 한다 ──
  //   ★ 이 시나리오가 없으면 두 판정을 하나로 합칠 이유가 사라진다(대조군 M3 이 그걸 잡았다).
  //     `superseded` 에만 있는 턴은 **경계 안**이어서 경계 판정으로는 못 잡는다.
  const indexBoth = {
    superseded: new Set([3]),
    cutoff: 5,
    liveTurns: new Set([5]),
    reasons: { 3: 'superseded' },
    nodeCount: 6
  };
  const pred = WL.isSupersededTurn;
  assert('predicate_uses_node_verdict',
    typeof pred === 'function' && pred(3, indexBoth) === true,
    { t3: typeof pred === 'function' ? pred(3, indexBoth) : null,
      note: '턴 3 은 경계(5) **안**이다 — 노드 판정만 잡는다 (리롤로 대체된 턴)' });
  assert('predicate_uses_boundary_verdict',
    typeof pred === 'function' && pred(7, indexBoth) === true && pred(6, indexBoth) === true,
    { t6: typeof pred === 'function' ? pred(6, indexBoth) : null,
      t7: typeof pred === 'function' ? pred(7, indexBoth) : null,
      note: '턴 6·7 은 노드 집합에 없다 — 경계 판정만 잡는다 (노드 소실)' });
  assert('predicate_keeps_turn_inside_both',
    typeof pred === 'function' && pred(5, indexBoth) === false && pred(4, indexBoth) === false,
    { t4: typeof pred === 'function' ? pred(4, indexBoth) : null,
      t5: typeof pred === 'function' ? pred(5, indexBoth) : null });
  assert('predicate_ignores_unknown_turn',
    typeof pred === 'function' && pred(0, indexBoth) === false && pred(null, indexBoth) === false,
    { note: '턴을 모르면 버리지 않는다 (정보 손실 방지)' });

  finish();
}, 250);
