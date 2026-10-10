'use strict';
// 측정: E2 partial(substring) 엣지가 **실제로 오탐**인가.
//
// 실측된 형태 (10c:910):
//   if (ek && key && (key.includes(ek) || ek.includes(key))) { partial += 1; ... }
//   → 이름 경계를 보지 않으므로 `민아` ⊂ `김민아` 같은 **부분 문자열**이 매칭된다.
//   weight = exact > 0 ? 0.78 : 0.45  이고 light 프리셋 edgeWeightMin = 0.28 이라
//   0.45 > 0.28 → 실제 엣지가 된다.
//
// 이 프로브는 그래프를 실제로 만들어 **어떤 쌍이 엣지가 되는지** 그대로 나열한다.
// 판단하지 않고 사실만 낸다 — 오탐 여부는 그 목록을 보고 정한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__PROBE__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null" + '};'
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
try { vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); }
catch (e) { console.log(JSON.stringify({ ok: false, reason: 'bundle_throw: ' + e.message }, null, 2)); process.exit(1); }

const ME = (ctx.__PROBE__ && ctx.__PROBE__.MemoryEngine) || {};
const build = ME.buildHmeGraphIndexFromScopeIndexForTest;
if (!build) { console.log(JSON.stringify({ ok: false, reason: 'build_fn_missing', keys: Object.keys(ME).slice(0, 40) }, null, 2)); process.exit(1); }

// ── 표본: 경계가 겹치는 이름들 (오탐이면 여기서 엣지가 생긴다) ──
const mkEntity = (name, aliases) => ({
  comment: 'lmai_entity', key: `lmai_entity::${name}`, secondkey: '',
  content: JSON.stringify({
    id: name, name, type: 'character',
    identity: { aliases: aliases || [], summary: `${name} 요약`, roleInStory: '기사' },
    meta: { aliases: aliases || [], hiddenNameKeys: [] }
  })
});
// 경계 사례만 모은다 — 진짜 같은 인물이 아닌 것들
const NAMES = ['민아', '김민아', '아리엘', '리엘', '세라', '세라핌', '카일'];
const lorebook = [
  ...NAMES.map(n => mkEntity(n, [])),
  {
    comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-1', secondkey: '',
    content: JSON.stringify({
      schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-1', cueCount: NAMES.length,
      cues: NAMES.map((n, i) => ({
        id: `cue_${i}`, sourceType: 'character_lorebook', sourceId: n,
        sourceLabel: `Character Lorebook: ${n}`, chunkIndex: 0, buckets: ['world'],
        entityRefs: [n], tags: [n],
        text: `${n} 에 대한 로어 항목이다.`, sourceHash: `h${i}`, priority: 6, updatedAt: 1
      }))
    })
  }
];

const mkRow = (id, turn, subjects) => ({
  id, contentHash: `h_${id}`, primaryKind: 'fact', baseBucket: 'general',
  turn, subjects, aliases: [], entityRoles: { primary: subjects.slice(0, 1), observer: [], mention: [], inferred: [] },
  tags: [], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [],
  narrativeTags: [], importance: 0.6, rollbackState: 'active', stale: false, hiddenFromPrompt: false
});
const scopeIndex = {
  schema: 'libra.hme.scope_index.v1', scopeKey: 'probe-scope', digest: 'digest-p', rowCount: NAMES.length,
  rows: NAMES.map((n, i) => mkRow(`r${i}`, 10 + i, [n]))
};
const m = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
if (m) scopeIndex.schema = m[1];

let graph = null;
try { graph = build(scopeIndex, { scopeKey: 'probe-scope', lorebook, entries: lorebook }); }
catch (e) { console.log(JSON.stringify({ ok: false, reason: 'build_throw: ' + e.message }, null, 2)); process.exit(1); }
if (!graph) { console.log(JSON.stringify({ ok: false, reason: 'graph_null' }, null, 2)); process.exit(1); }

const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
const edges = Array.isArray(graph.edges) ? graph.edges : [];
const byId = new Map(nodes.map(n => [n.id, n]));
const label = (id) => {
  const n = byId.get(id);
  if (!n) return String(id);
  return String(n.name || n.label || n.id || '');
};
const e2 = edges.filter(e => String(e.relation || '') === 'described_by_lore');

console.log('=== E2 (described_by_lore) 엣지 전수 ===');
const rows = [];
for (const e of e2) {
  const a = label(e.from), b = label(e.to);
  const oneIsEntity = String(a).startsWith('lmai_entity') || String(b).startsWith('lmai_entity');
  // 실제 인물 이름 쌍을 뽑는다
  const names = [a, b].map(s => s.replace(/^lmai_entity::/, ''));
  const substr = names[0] && names[1] && names[0] !== names[1] && (names[0].includes(names[1]) || names[1].includes(names[0]));
  rows.push({ from: a, to: b, weight: e.weight, evidence: (e.evidence || []).slice(0, 4), substring_only: !!substr });
  console.log(`  ${a} → ${b}  w=${e.weight}  ${substr ? '★부분문자열' : ''}  ${JSON.stringify((e.evidence || []).slice(0, 3))}`);
}
console.log();
console.log('=== 요약 ===');
console.log('  노드 수:', nodes.length, '| 엣지 수:', edges.length, '| E2:', e2.length);
console.log('  부분 문자열만으로 성립한 엣지:', rows.filter(r => r.substring_only).length);
console.log('  경계 사례 (한쪽이 다른 쪽의 부분 문자열):');
const pairs = [];
for (const x of NAMES) for (const y of NAMES) if (x !== y && x.includes(y)) pairs.push(`${y} ⊂ ${x}`);
console.log('   ', pairs.join(', ') || '(없음)');

console.log();
console.log(JSON.stringify({
  ok: true,
  nodeCount: nodes.length,
  edgeCount: edges.length,
  e2Count: e2.length,
  substring_only_edges: rows.filter(r => r.substring_only).length,
  e2Rows: rows,
  boundary_pairs: pairs
}, null, 2));
