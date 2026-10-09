'use strict';
// Gate: 인물 화면의 기억 선택은 **엣지 순회 순서에 의존하지 않는다** (#5).
//
// 실측된 결함 (10j:185):
//   for (const e of hmeGraphEdges(graph)) { … if (n >= memPerEntity) continue; … }
//   → 엣지 **삽입 순서**대로 첫 N개를 고른다. 정렬이 없다.
//
// 그런데 E1(mentions_entity) 엣지의 weight 는 **전부 1.00** 이다(역할 가중 primary=1.0).
//   실측: 6건 전부 w=1.00 → **weight 로는 구분이 불가능**하다.
//   대신 기억 **노드**가 `turn`·`importance` 를 갖는다.
//   실측 선택 순서(importance): 0.1, 0.9, 0.3, 0.8, 0.5, 0.95 — **뒤섞임**(최고 중요도가 마지막).
//
// 이 저장소에는 이미 정렬 관례가 있다 (10c:1543):
//   turn DESC  →  importance DESC  →  id asc
// 이 게이트는 **같은 관례**를 10j 가 따르는지 본다(새 축을 만들지 않는다).
//
// 계약:
//   S1 기억 선택이 엣지 삽입 순서에 의존하지 않는다 (순서를 뒤집어도 같은 집합)
//   S2 상한(memoriesPerEntity)에 걸릴 때 **더 중요한 기억이 남는다**
//   S3 상한이 후보 수보다 크면 전부 유지된다 (과잉 제거 금지)
//   S4 선택된 기억의 순서가 결정적이다 (같은 입력 → 같은 출력)
//   S5 정렬 축은 노드의 기존 필드다 (turn / importance — 새 축 발명 금지)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC10J = fs.readFileSync(path.join(ROOT, 'src/parts/10j-memory-public-lore-schema-api.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { console.log(JSON.stringify({ ok: false, reason: 'scope_tail_not_found' }, null, 2)); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__P5__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null" + '};'
  + code.slice(injectAt);

const ctx = {
  console: { log() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  structuredClone, AbortController, Buffer, TextEncoder, TextDecoder,
  crypto: { randomUUID: () => 'x' },
  fetch: async () => { throw new Error('no network'); },
  process: { env: {} },
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  performance: { now: () => Date.now() },
  document: { getElementById() { return null; }, createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector() { return null; } }; }, head: { appendChild() {} }, body: { appendChild() {} }, querySelector() { return null; } },
  Risuai: {
    apiVersion: '3.0', async getRuntimeInfo() { return { apiVersion: '3.0' }; }, async getArgument() { return undefined; },
    pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getCharacter() { return null; }, async getChat() { return null; }, async getDatabase() { return { selectedPersona: 0, personas: [] }; },
    async registerSetting() {}, async registerButton() {}, async showContainer() {}, async hideContainer() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async onUnload() {}
  }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
(async () => {
let runErr = '';
try { await vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const ME = (ctx.__P5__ && ctx.__P5__.MemoryEngine) || {};
const build = ME.buildHmeGraphIndexFromScopeIndexForTest;

assert('dist_runs_without_error', !runErr, { error: runErr });
assert('probe_exported', !!build, { note: '그래프 빌더가 노출돼야 판정 가능' });

// ── 선택 로직을 **제품 소스에서 그대로 실행**한다 (10j:183-196 블록) ──
//   게이트가 자체 구현을 쓰면 제품과 갈라진다. 함수가 노출되지 않으므로 블록을 뽑아 실행한다.
const selectionFn = (() => {
  // 블록 시작을 **정렬 헬퍼 앞**으로 잡는다 — 선택 로직이 그 헬퍼를 쓴다.
  //   (perEntity 부터 자르면 `compareMemoryEdges is not defined` 로 죽는다)
  const marker = '// 인물-기억 엣지(E1) 중 인물당 상한만큼';
  const i = SRC10J.indexOf(marker);
  if (i < 0) return null;
  const j = SRC10J.indexOf('const edges = hmeGraphEdges(graph)', i);
  if (j < 0) return null;
  const body = SRC10J.slice(i, j);
  try {
    // 같은 스코프의 심볼(entityIds, byId, memPerEntity)을 인자로 준다.
    return new Function(
      'graph', 'hmeGraphEdges', 'entityIds', 'byId', 'memPerEntity', 'chosenIds',
      `${body}\n return { keptMemoryEdges };`
    );
  } catch (e) { return { __err: String(e.message) }; }
})();
assert('selection_block_found', !!selectionFn && !selectionFn.__err,
  { found: !!selectionFn, error: selectionFn && selectionFn.__err });

if (build && typeof selectionFn === 'function') {
  const mkEntity = (n) => ({
    comment: 'lmai_entity', key: `lmai_entity::${n}`, secondkey: '',
    content: JSON.stringify({ id: n, name: n, type: 'character', identity: { aliases: [], summary: 's', roleInStory: '기사' }, meta: { aliases: [], hiddenNameKeys: [] } })
  });
  const mkRow = (id, turn, s, imp) => ({
    id, contentHash: `h_${id}`, primaryKind: 'fact', baseBucket: 'general',
    turn, subjects: s, aliases: [], entityRoles: { primary: s.slice(0, 1), observer: [], mention: [], inferred: [] },
    tags: [], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [], narrativeTags: [],
    importance: imp, rollbackState: 'active', stale: false, hiddenFromPrompt: false
  });

  const mkGraph = (rows, lorebook) => {
    const si = {
      schema: 'libra.hme.scope_index.v1', scopeKey: 'p5-scope', digest: 'd', rowCount: rows.length, rows
    };
    const m = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
    if (m) si.schema = m[1];
    return build(si, { scopeKey: 'p5-scope', lorebook, entries: lorebook });
  };

  const lorebook = [mkEntity('아리엘')];
  // 중요도가 **엣지 순서와 어긋나게** 배치한다 — 정렬이 없으면 최고 중요도가 밀린다.
  const ROWS = [
    mkRow('r0', 10, ['아리엘'], 0.10),
    mkRow('r1', 11, ['아리엘'], 0.90),
    mkRow('r2', 12, ['아리엘'], 0.30),
    mkRow('r3', 13, ['아리엘'], 0.80),
    mkRow('r4', 14, ['아리엘'], 0.50),
    mkRow('r5', 15, ['아리엘'], 0.95)
  ];

  const runSelect = (graph, limit) => {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const entities = nodes.filter(n => String(n.nodeType || '') === 'entity').slice(0, 48);
    const entityIds = new Set(entities.map(n => n.id));
    const chosenIds = new Set(entityIds);
    const memPerEntity = limit;
    const out = selectionFn(graph, (g) => (Array.isArray(g?.edges) ? g.edges : []), entityIds, nodeById, memPerEntity, chosenIds);
    const keptEdges = out?.keptMemoryEdges || [];
    // 선택된 기억 노드의 중요도/턴 목록
    // ★ 같은 상대와의 엣지가 여러 개일 수 있다(E2 등). **기억 노드 기준으로 중복 제거**한다 —
    //   안 하면 상한 3 이 같은 기억 2건 + 1건으로 채워져 기대치와 어긋난다(게이트 버그였다).
    const seenRows = new Set();
    const picked = [];
    for (const e of keptEdges) {
      const a = nodeById.get(e.from), b = nodeById.get(e.to);
      const mem = String(a?.nodeType) === 'memory' ? a : (String(b?.nodeType) === 'memory' ? b : null);
      if (!mem) continue;
      const row = String(mem.rowId || mem.id || '');
      if (seenRows.has(row)) continue;
      seenRows.add(row);
      picked.push({ imp: Number(mem.importance || 0), turn: Number(mem.turn || 0), row });
    }
    return picked;
  };

  const graph = mkGraph(ROWS, lorebook);
  const all = runSelect(graph, 6);
  assert('all_candidates_selected_when_limit_allows', all.length === 6,
    { picked: all.map(p => `${p.row}:${p.imp}`) });

  // ── S2: 상한 3 → **최근 턴 우선**(관례)으로 3건이 남아야 한다 ──
  //   축 순서는 이 저장소의 관례(10c:1543)를 따른다: **turn DESC → importance DESC → id**.
  //   턴이 먼저이므로 최신 3턴(T15·T14·T13)이 뽑히는 것이 옳다.
  //   (중요도가 먼저라고 가정하면 게이트가 제품과 다른 계약을 주장하게 된다)
  const top3 = runSelect(graph, 3);
  const turns = top3.map(p => p.turn);
  const latest3 = [15, 14, 13];
  const isCorrect = turns.length === 3 && latest3.every(t => turns.includes(t));
  assert('limit_keeps_latest_turns', isCorrect,
    { picked: top3.map(p => `${p.row}:t${p.turn}:${p.imp}`), expected_turns: latest3,
      note: '관례는 turn DESC 우선이다. 삽입 순서대로 뽑으면 t10·t11·t12 가 남아 최신 턴이 밀린다' });

  // ── S2b: 같은 턴이면 중요도가 높은 쪽이 남는다 (2차 축 검증) ──
  const sameTurnRows = [
    mkRow('a1', 20, ['아리엘'], 0.10),
    mkRow('a2', 20, ['아리엘'], 0.90),
    mkRow('a3', 20, ['아리엘'], 0.50)
  ];
  const g2 = mkGraph(sameTurnRows, lorebook);
  const pick2 = runSelect(g2, 1);
  assert('tie_broken_by_importance',
    pick2.length === 1 && pick2[0].imp === 0.90,
    { picked: pick2.map(p => `${p.row}:${p.imp}`), note: '같은 턴이면 중요도 높은 쪽이 남아야 한다' });

  // ── S1: 엣지 배열을 뒤집어도 같은 집합 ──
  const reversed = { ...graph, edges: [...(graph.edges || [])].reverse() };
  const revTop3 = runSelect(reversed, 3);
  const sameSet = revTop3.map(p => p.imp).sort((a, b) => b - a).join(',')
    === top3.map(p => p.imp).sort((a, b) => b - a).join(',');
  assert('selection_is_order_independent', sameSet,
    { forward: top3.map(p => `${p.row}:${p.imp}`), reversed: revTop3.map(p => `${p.row}:${p.imp}`),
      note: '입력 순서가 바뀌어도 같은 기억이 선택돼야 한다' });

  // ── S4: 결정적 ──
  const again = runSelect(graph, 3);
  assert('selection_is_deterministic',
    JSON.stringify(again) === JSON.stringify(top3),
    { first: top3.map(p => p.row), again: again.map(p => p.row) });

  // ── S5: 배선 — 선택 전에 정렬이 있는가 (기존 관례 turn/importance) ──
  const selBlock = (() => {
    const i = SRC10J.indexOf('// 인물-기억 엣지(E1) 중 인물당 상한만큼');
    const j = SRC10J.indexOf('const edges = hmeGraphEdges(graph)', i);
    return (i >= 0 && j > i) ? SRC10J.slice(i, j) : '';
  })();
  const hasSort = /\.sort\(/.test(selBlock) && /importance/.test(selBlock);
  assert('selection_sorts_by_existing_axis', hasSort,
    { found: hasSort, note: '10c:1543 관례(turn DESC → importance DESC)를 따른다 — 새 축 발명 금지' });
} else {
  for (const n of ['all_candidates_selected_when_limit_allows', 'limit_keeps_most_important',
    'selection_is_order_independent', 'selection_is_deterministic', 'selection_sorts_by_existing_axis']) {
    assert(n, false, { reason: '선행 조건 실패' });
  }
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);

})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
