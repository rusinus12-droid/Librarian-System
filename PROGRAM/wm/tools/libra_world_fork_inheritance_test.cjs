'use strict';
// Gate: 브랜치 fork 에서 **세계 그래프**도 fork 지점을 지킨다 (#10, §14 와 같은 부류)
//
// 실측된 결함:
//   세계 그래프는 단일 로어 항목(`lmai_world_graph`)이라 **턴 도장이 없다**
//   (`branchEntryTurn(worldEntry)` = 0). 상속 규칙은 "턴을 모르면 버리지 않는다"이므로
//   세계 그래프가 **통째로** 넘어갔다.
//   실측: fork 턴 40 에서 부모가 T99(포크 이후) 추가한 규칙·보정·노드까지 자식이 받았다.
//   기억은 정확히 잘리는데(제외 턴 45·99) 세계만 안 잘리는 **비대칭**이었다.
//
// 계약:
//   W1 fork 이후 **승격된 규칙**은 상속되지 않는다 (규칙별 출처 턴으로 판정)
//   W2 fork 이후 **생성된 노드**는 상속되지 않는다 (노드 생성 턴)
//   W3 fork 이전 노드·규칙은 **남는다** (과잉 제거 금지 — 루트가 통째로 사라지면 안 된다)
//   W4 턴을 알 수 없는 노드·규칙은 **버리지 않는다** (정보 손실 방지 — 상속 규칙과 동일)
//   W5 fork 지점을 못 구하거나 세계 그래프가 없으면 **종전과 동일**하다 (fail-open)
//   W6 필터를 **직접 실행**해 판정한다 (배선이 죽어 있어도 통과하는 게이트 금지)
(async () => {
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');
const SRC_15A = fs.readFileSync(path.join(ROOT, 'src/parts/15a-gui-session-data.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const injectAt = code.lastIndexOf('})();');
if (injectAt < 0) throw Error('portable_factory_closure_tail_not_found');
code = code.slice(0, injectAt) + "\n;globalThis.__probe = { LibraDataStorage };" + code.slice(injectAt);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: global.structuredClone, TextEncoder, TextDecoder, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { await vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const LS = (ctx.__probe && ctx.__probe.LibraDataStorage) || ctx.LibraDataStorage;
const fn = LS && LS.filterBranchInheritanceByFork;

// 실제 제품 형태 픽스처
const memAt = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });
const worldEntry = (nodes) => ({
  key: 'lmai_world_graph::compact', comment: 'lmai_world_graph',
  content: JSON.stringify({ schema: 'libra.world.graph.compact.v2', nodes }),
  mode: 'normal', insertorder: 6, alwaysActive: false
});
// ★★ 픽스처는 **제품이 실제로 쓰는 값**이어야 한다. 이것이 P0 사각지대의 원인이었다 —
//   종전 픽스처는 `meta.created: 40`(턴 값)을 썼지만 제품은 `Date.now()`(ms)를 쓴다.
//   그래서 "정상 노드를 전부 삭제"하는 결함을 게이트가 통과시켰다.
const NOW_MS = Date.now();
const ROOT_NODE = {
  id: 'root', name: '루트',
  rules: {
    custom: { rule_1: 'T40 포크 직전 규칙', rule_2: 'T99 포크 이후 규칙' },
    ruleMeta: { schema: 'libra.world.rule_meta.v2', promotedRules: { 'T40 포크 직전 규칙': 40, 'T99 포크 이후 규칙': 99 } }
  },
  //   `created` = **시각(ms)** (제품 08a:525), `createdTurn` = **턴** (제품이 이제 기록한다).
  //   교정은 `worldCorrectionTurn` 으로 출처 턴을 갖는다(`15a`).
  meta: { created: NOW_MS, createdTurn: 40, userWorldCorrection: 'T99 포크 이후에 쓴 보정', worldCorrectionTurn: 99 }
};
//   포크 이전에 쓴 보정은 남아야 한다.
const EARLY_CORRECTION_NODE = { id: 'early', name: 'T20 보정', rules: { custom: {} }, meta: { created: NOW_MS, createdTurn: 20, userWorldCorrection: 'T20 에 쓴 보정', worldCorrectionTurn: 20 } };
const LATE_NODE = { id: 'late', name: 'T99 신규', rules: { custom: {} }, meta: { created: NOW_MS, createdTurn: 99 } };
const UNSTAMPED_NODE = { id: 'legacy', name: '도장없음', rules: { custom: { rule_1: '출처 불명 규칙' } }, meta: {} };
//   ★ P0 회귀 방지용 — **타임스탬프만** 있고 턴 도장이 없는 노드(= 구 데이터·수동 생성).
//     제품 형태 그대로: 상속에서 **삭제되면 안 된다**.
const TIMESTAMP_ONLY_NODE = { id: 'tsonly', name: '시각만 있는 노드', rules: { custom: { rule_1: '규칙' } }, meta: { created: NOW_MS, updated: 0, source: 'default' } };

assert('dist_runs_without_error', !runErr, { error: runErr });
assert('filter_exported', typeof fn === 'function', { type: typeof fn });

if (typeof fn === 'function') {
  const lineage = { status: 'verified', commonPrefixPairs: 40, commonPrefixMessages: 80, parentChatId: 'p1' };

  // ── W1·W2·W3·W4 ──
  const parent = [memAt(10, 'T10'), memAt(45, 'T45 포크 이후'), worldEntry([ROOT_NODE, LATE_NODE, UNSTAMPED_NODE, EARLY_CORRECTION_NODE, TIMESTAMP_ONLY_NODE])];
  const out = fn(parent, lineage);
  const entry = (out?.entries || []).find(e => e.comment === 'lmai_world_graph');
  assert('world_entry_is_kept', !!entry, { comments: (out?.entries || []).map(e => e.comment) });

  if (entry) {
    const payload = JSON.parse(entry.content);
    const ids = payload.nodes.map(n => n.id);
    const root = payload.nodes.find(n => n.id === 'root') || null;
    const rules = root ? Object.values((root.rules || {}).custom || {}) : [];

    // ── W0: **P0 회귀 방지** — 타임스탬프를 턴으로 읽으면 정상 노드가 전부 삭제된다 ──
    //   실측: `meta.created = Date.now()` 를 forkTurn(40) 과 비교해 `남은 노드 = []` 였다.
    assert('timestamp_only_node_is_kept',
      ids.includes('tsonly'),
      { nodes: ids, note: '★ P0 — `meta.created`(ms)를 턴으로 읽으면 안 된다. 도장 없으면 보존' });
    assert('pre_fork_node_survives_timestamp_confusion',
      ids.includes('root'),
      { nodes: ids, note: '★ P0 — createdTurn(40)이 있어야 정상 판정된다' });

    assert('post_fork_node_is_dropped', !ids.includes('late'),
      { nodes: ids, note: '포크 이후 생성된 노드는 자식 것이 아니다' });
    assert('post_fork_rule_is_dropped', !rules.some(r => /T99/.test(r)),
      { rules, note: '포크 이후 승격된 규칙은 자식 것이 아니다' });
    assert('pre_fork_node_is_kept', ids.includes('root'),
      { nodes: ids, note: '과잉 제거 금지 — 포크 직전 노드가 통째로 사라지면 안 된다' });
    assert('pre_fork_rule_is_kept', rules.some(r => /T40/.test(r)), { rules });
    assert('unstamped_node_is_kept', ids.includes('legacy'),
      { nodes: ids, note: '턴을 알 수 없으면 버리지 않는다 (정보 손실 방지)' });

    // ── W8: 보정도 출처 턴을 본다 (#10 의 마지막 격차) ──
    const rootCorr = (root && root.meta || {}).userWorldCorrection || '';
    assert('post_fork_correction_is_dropped',
      !/T99/.test(rootCorr),
      { correction: rootCorr, note: '포크 이후에 쓴 보정은 자식 것이 아니다' });
    const early = payload.nodes.find(n => n.id === 'early') || null;
    const earlyCorr = (early && early.meta || {}).userWorldCorrection || '';
    assert('pre_fork_correction_is_kept',
      /T20/.test(earlyCorr),
      { correction: earlyCorr, note: '과잉 제거 금지 — 포크 이전 보정은 남는다' });

    // ── W4b: 도장 없는 노드의 규칙도 버리지 않는다 ──
    const legacy = payload.nodes.find(n => n.id === 'legacy') || null;
    const legacyRules = legacy ? Object.values((legacy.rules || {}).custom || {}) : [];
    assert('unstamped_node_rules_are_kept', legacyRules.some(r => /출처 불명/.test(r)),
      { rules: legacyRules });
  }

  // ── W5: fork 지점 없음 / 세계 그래프 없음 → 종전과 동일 ──
  const noFork = fn(parent, { status: 'verified' });
  assert('no_fork_point_keeps_world_intact',
    (noFork?.entries || []).length === parent.length,
    { kept: (noFork?.entries || []).length, expected: parent.length });

  const memOnly = fn([memAt(10, 'T10'), memAt(45, 'T45')], lineage);
  assert('memory_only_still_works',
    (memOnly?.entries || []).length === 1 && (memOnly?.excludedTurns || []).includes(45),
    { kept: (memOnly?.entries || []).length, excluded: memOnly?.excludedTurns });

  // ── W6: 배선 — 실제 호출 경로가 이 필터를 쓴다 ──
  //   ★ 창을 넉넉히 잡는다 — `inheritFromBranch` 앞에 세계 그래프 필터가 들어와
  //     1200자로는 호출부가 창 밖으로 밀렸다(내 첫 시도가 그래서 FAIL).
  const ib = (() => {
    const i = SRC_01F.indexOf('const inheritFromBranch = async');
    if (i < 0) return '';
    const j = SRC_01F.indexOf('const deviceLocal', i);
    return SRC_01F.slice(i, j > i ? j : i + 4000);
  })();
  assert('inherit_path_calls_fork_filter',
    /filterBranchInheritanceByFork\(/.test(ib),
    { note: '판정만 실행하고 배선을 안 보면 배선이 죽어도 통과한다' });

  // ── W9: **쓰기 경로**(15a 교정 저장)가 출처 턴을 기록하는가 ──
  //   ★ 실행으로 못 잡는 지점이다 — GUI 저장은 overlay/DOM 이 필요해 하네스에서 못 돌린다.
  //     대조군 M7 이 정확히 이 구멍을 겨냥했다(게이트가 필터만 봤다).
  //     **계층을 나눠** 본다: 15a = 기록(소스 계약), 01f = 판정(실행).
  //   ★ 함수 경계를 **다음 `const` 정의**로 잡는다 (고정 길이 창은 놓친다 — 첫 시도가 그래서 3 FAIL).
  const writer = (() => {
    const i = SRC_15A.indexOf('const saveWorldCorrectionFromGui = async');
    if (i < 0) return '';
    const rest = SRC_15A.slice(i + 40);
    const m = rest.match(/\n        const [A-Za-z_$]/);
    return m ? SRC_15A.slice(i, i + 40 + m.index) : SRC_15A.slice(i, i + 6000);
  })();
  assert('correction_writer_exists', writer.length > 0, { note: '15a 의 교정 저장 경로를 찾아야 한다' });
  assert('correction_writer_stamps_turn',
    /worldCorrectionTurn/.test(writer) && /correctionTurn/.test(writer),
    { note: '교정을 쓸 때 출처 턴을 남겨야 상속 판정이 동작한다' });
  //   ★ 가드 조건 자체를 본다 — `if (false && correctionTurn > 0)` 같은 죽은 가드를 통과시키지 않는다.
  assert('correction_writer_guard_is_live',
    /if\s*\(\s*correctionTurn\s*>\s*0\s*\)/.test(writer),
    { note: '가드 조건 자체를 검사한다(문자열 존재만 보면 죽은 가드도 통과한다)' });
  assert('correction_turn_reads_current_turn',
    /getCurrentTurn/.test(writer),
    { note: '현재 턴을 읽어야 도장이 의미가 있다' });

  // ── W7: `filter` 로 원소를 바꾸려 하면 무효다 (실측 자기오류 고정) ──
  assert('fork_filter_does_not_rely_on_mutating_filter',
    !/\.filter\(entry => \{[\s\S]{0,400}?entry = trimmed\.entry/.test(SRC_01F),
    { note: '`Array.filter` 는 원소를 변환할 수 없다 — reduce/map 을 써야 한다' });
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);

})().catch(error => { console.error(error); process.exitCode = 1; });
