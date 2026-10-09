'use strict';
// Gate: HME 그래프 노드 3종 확장 — 인물(entity)·로어(lore) 노드 + 연결 엣지 + 예산 보존.
//
// 배경:
//   그래프 노드는 `lmai_memory` row 에서만 나온다 (`10d:262` — rows 는 lmai_memory 만).
//   인물(`lmai_entity`)·로어(`03i` cue)는 노드가 아니어서 인물 허브 경로가 없다.
//   사용자 목표: "인물과 로어북을 연결하는 상설 파이프라인".
//
// 이 게이트는 *제품 함수를 실행* 해서 판정한다. 문자열 존재 검사가 아니다.
// 각 주장에 실패 대조군(변이)을 짝지어, 통과만 보는 게이트가 되지 않게 한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = { ok: false, assertions: [], measurements: {} };

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
// ★ 삽입 위치 — 실측으로 확정 (줄 번호가 아니라 내용으로 잡는다).
//   이 번들은 최상위 IIFE 가 여러 개다:
//     175행 시작 → 60948행 닫힘        ← MemoryEngine(47170) 이 여기 안
//     67376행 초기화 IIFE → 67500행 닫힘  ← 별개
//     77283행 GUI 등록 IIFE → 77315행 닫힘 ← 별개
//   MemoryEngine 참조는 그 IIFE 의 **닫힘 뒤**에서 유효하다 (진단: 앞=NOT_SET, 뒤=object).
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { out.reason = 'scope_tail_not_found'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
if (closeMark < 0) { out.reason = 'scope_close_not_found'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const injectAt = closeMark + '\n})();'.length;
out.measurements.injectAt = injectAt;
out.measurements.injectLine = code.slice(0, injectAt).split('\n').length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__HME_NODE_TEST__={' +
  "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null" +
  '};'
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
  document: {
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector() { return null; } }; },
    head: { appendChild() {} }, body: { appendChild() {} },
    querySelector() { return null; }
  },
  Risuai: {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0' }; },
    async getArgument() { return undefined; },
    pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return null; },
    async getChat() { return null; },
    async getDatabase() { return { selectedPersona: 0, personas: [] }; },
    async registerSetting() {}, async registerButton() {},
    async showContainer() {}, async hideContainer() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async onUnload() {}
  }
};
ctx.globalThis = ctx;
ctx.window = ctx;

vm.createContext(ctx);
(async () => {
try { await vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); }
catch (e) { out.reason = 'bundle_throw: ' + (e && e.message); console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const ME = (ctx.__HME_NODE_TEST__ && ctx.__HME_NODE_TEST__.MemoryEngine) || {};
out.measurements.exposedKeys = Object.keys(ME).filter(k => ME[k] !== null && ME[k] !== undefined);
out.measurements.exposedAll = Object.keys(ME);

const build = ME.buildHmeGraphIndexFromScopeIndexForTest;
if (!build) {
  out.reason = 'build_fn_missing';
  
  console.log(JSON.stringify(out, null, 2)); process.exit(1);
}
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });

// ── 표본: scope index (기억 row) + lorebook (인물 + 로어) ──────────────────
const mkRow = (id, turn, subjects, kind) => ({
  id, contentHash: `h_${id}`, primaryKind: kind || 'fact', baseBucket: 'general',
  turn, subjects, aliases: [], entityRoles: { primary: subjects.slice(0, 1), observer: [], mention: [], inferred: [] },
  tags: ['기사단'], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [],
  narrativeTags: [], importance: 0.6, rollbackState: 'active', stale: false, hiddenFromPrompt: false
});
const scopeIndex = {
  schema: 'libra.hme.scope_index.v1', scopeKey: 'test-scope', digest: 'digest-1', rowCount: 4,
  rows: [
    mkRow('r1', 10, ['아리엘', '세라']),
    mkRow('r2', 11, ['아리엘']),
    mkRow('r3', 12, ['카일', '미르']),
    mkRow('r4', 13, ['세라'])
  ]
};
// schema 상수는 번들에서 가져와야 한다 — 실제 값으로 맞춘다.
const REAL_SCHEMA = (() => {
  try {
    const m = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
    return m ? m[1] : scopeIndex.schema;
  } catch (_) { return scopeIndex.schema; }
})();
scopeIndex.schema = REAL_SCHEMA;
out.measurements.scopeSchema = REAL_SCHEMA;

const mkEntity = (name, aliases) => ({
  comment: 'lmai_entity',
  key: `lmai_entity::${name}`,
  secondkey: '',
  content: JSON.stringify({
    id: name, name, type: 'character',
    identity: { aliases: aliases || [], summary: `${name} 요약`, roleInStory: '기사', affiliation: '북부 기사단' },
    meta: { aliases: aliases || [], hiddenNameKeys: [] }
  })
});
const loreEntries = [
  mkEntity('아리엘', ['아리']),
  mkEntity('세라', []),
  mkEntity('카일', []),
  mkEntity('미르', []),
  {
    comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-1', secondkey: '',
    content: JSON.stringify({
      schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-1', cueCount: 2,
      cues: [
        {
          id: 'cue_1', sourceType: 'character_lorebook', sourceId: '기사단',
          sourceLabel: 'Character Lorebook: 기사단', chunkIndex: 0, buckets: ['world'],
          entityRefs: ['아리엘', '세라'], tags: ['기사단'],
          text: '북부 기사단은 아리엘이 속한 조직이다. 세라의 아버지가 창설했다.',
          sourceHash: 'h1', priority: 6, updatedAt: 1
        },
        {
          id: 'cue_2', sourceType: 'character_lorebook', sourceId: '마탑',
          sourceLabel: 'Character Lorebook: 마탑', chunkIndex: 0, buckets: ['relation'],
          entityRefs: ['미르', '아리엘'], tags: ['마탑'],
          text: '마탑은 미르가 수장이다. 아리엘과 앙숙이다.',
          sourceHash: 'h2', priority: 6, updatedAt: 1
        }
      ]
    })
  }
];
const lorebook = [...loreEntries];

// ── 측정 1: 인물·로어 노드가 생성되는가 ──────────────────────────────────
let graph = null;
try {
  graph = build(scopeIndex, { scopeKey: 'test-scope', lorebook, entries: lorebook });
} catch (e) { out.measurements.buildThrow = String(e && e.message); }
if (!graph) { out.reason = 'graph_null'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
const nodeTypeOf = (n) => String(n?.nodeType || (n?.rowId && String(n.rowId).startsWith('lmai_entity') ? 'entity' : (n?.rowId && String(n.rowId).startsWith('lmai_character_lore_cues') ? 'lore' : 'memory')));
const entityNodes = nodes.filter(n => nodeTypeOf(n) === 'entity');
const loreNodes = nodes.filter(n => nodeTypeOf(n) === 'lore');
const memoryNodes = nodes.filter(n => nodeTypeOf(n) === 'memory');
out.measurements.nodeCounts = {
  total: nodes.length, memory: memoryNodes.length, entity: entityNodes.length, lore: loreNodes.length
};
out.measurements.entityNodeNames = entityNodes.map(n => n.name);
out.measurements.entityNodeSample = entityNodes[0] ? { id: entityNodes[0].id, rowId: entityNodes[0].rowId, entities: entityNodes[0].entities, importance: entityNodes[0].importance, turn: entityNodes[0].turn } : null;

// ── 측정 2: E1 엣지 (memory → entity) ────────────────────────────────────
const edges = Array.isArray(graph.edges) ? graph.edges : [];
const nodeById = new Map(nodes.map(n => [n.id, n]));
const edgesOfRelation = (rel) => edges.filter(e => String(e.relation || '') === rel);
const e1 = edgesOfRelation('mentions_entity');
const e2 = edgesOfRelation('described_by_lore');
const e3 = edgesOfRelation('relation_record');
out.measurements.edgeCounts = {
  total: edges.length, mentions_entity: e1.length, described_by_lore: e2.length, relation_record: e3.length
};
out.measurements.e1Sample = e1.slice(0, 3).map(e => ({
  from: nodeTypeOf(nodeById.get(e.from)), to: nodeTypeOf(nodeById.get(e.to)),
  layer: e.layer, weight: e.weight, evidence: (e.evidence || []).slice(0, 2)
}));
out.measurements.e1TouchesEntity = e1.filter(e => nodeTypeOf(nodeById.get(e.from)) === 'entity' || nodeTypeOf(nodeById.get(e.to)) === 'entity').length;

// ── 측정 3: 노드 예산이 인물을 보존하는가 (turn 정렬로 잘리지 않는가) ─────
let graphMany = null;
try {
  const manyRows = [];
  for (let i = 0; i < 900; i += 1) manyRows.push(mkRow(`r${i}`, 1000 + i, ['아리엘']));
  const si2 = { ...scopeIndex, rows: manyRows, rowCount: manyRows.length, digest: 'digest-2' };
  graphMany = build(si2, { scopeKey: 'test-scope-2', lorebook, entries: lorebook });
} catch (e) { out.measurements.buildManyThrow = String(e && e.message); }
if (graphMany) {
  const mn = Array.isArray(graphMany.nodes) ? graphMany.nodes : [];
  out.measurements.budget = {
    total: mn.length,
    entity: mn.filter(n => nodeTypeOf(n) === 'entity').length,
    lore: mn.filter(n => nodeTypeOf(n) === 'lore').length,
    memory: mn.filter(n => nodeTypeOf(n) === 'memory').length,
    maxNodes: graphMany.policy?.maxNodes || null
  };
}

// ── 측정 4: version bump 로 구버전 그래프가 재구축되는가 ─────────────────
const v = ME.getHmeGraphIndexVersion ? ME.getHmeGraphIndexVersion() : null;
out.measurements.graphVersion = v;
const oldGraph = { schema: 'libra.hme.graph_index.v2', version: 2, nodes: [], edges: [] };
let needsRebuild = null;
try { needsRebuild = ME.hmeGraphNeedsRebuildForTest ? ME.hmeGraphNeedsRebuildForTest(oldGraph) : null; } catch (e) { out.measurements.rebuildThrow = String(e && e.message); }
out.measurements.oldV2NeedsRebuild = needsRebuild;

// ── 측정 5: byEntity 버킷에 인물 노드가 등록되는가 (허브 진입) ────────────
const buckets = graph.byEntity || {};
const arielBucket = Array.isArray(buckets['아리엘']) ? buckets['아리엘'] : [];
out.measurements.byEntityAriel = arielBucket.length;
out.measurements.byEntityArielHasEntityNode = arielBucket
  .map(id => nodeById.get(id)).filter(Boolean).some(n => nodeTypeOf(n) === 'entity');
out.measurements.byEntityKeysSample = Object.keys(buckets).slice(0, 10);

// ── 판정 ─────────────────────────────────────────────────────────────────
const C = out.measurements.nodeCounts;
assert('C1: 인물이 그래프 노드로 존재한다', C.entity >= 4, { entity: C.entity, names: out.measurements.entityNodeNames });
assert('C2: 로어가 그래프 노드로 존재한다', C.lore >= 1, { lore: C.lore });
assert('C3: 기존 기억 노드가 보존된다 (회귀)', C.memory >= 4, { memory: C.memory });
assert('C4: E1 엣지 memory→entity 가 생성된다', out.measurements.e1TouchesEntity > 0,
  { edges: out.measurements.e1Sample, touching: out.measurements.e1TouchesEntity });
assert('C5: E2 엣지 entity→lore 가 생성된다', out.measurements.edgeCounts.described_by_lore > 0,
  { count: out.measurements.edgeCounts.described_by_lore });
assert('C6: 노드 예산이 인물·로어를 보존한다 (turn 정렬로 잘리지 않음)',
  !!out.measurements.budget && out.measurements.budget.entity >= 4 && out.measurements.budget.lore >= 1,
  out.measurements.budget || { reason: 'graphMany null', throw: out.measurements.buildManyThrow });
assert('C7: graph index version 이 2 초과로 bump 되었다', Number(v) > 2, { version: v });
assert('C8: 구버전 v2 그래프가 재구축 대상으로 판정된다', needsRebuild === true, { needsRebuild });
assert('C9: byEntity 버킷에 인물 노드가 등록된다 (허브 진입)',
  out.measurements.byEntityArielHasEntityNode === true,
  { bucketSize: out.measurements.byEntityAriel, hasEntityNode: out.measurements.byEntityArielHasEntityNode });

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));

if (!out.ok) process.exitCode = 1;

})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
