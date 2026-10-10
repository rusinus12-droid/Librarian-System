'use strict';
// 측정: 브랜치 fork 에서 **세계 그래프(교정 포함)** 가 fork 지점을 지키는가.
//   가설: 세계 그래프는 단일 `lmai_world_graph` 로어 항목이라 턴 도장이 없고,
//         `filterBranchInheritanceByFork` 는 턴을 모르면 **버리지 않으므로** 통째로 상속된다
//         → 자식이 부모의 **post-fork** 세계 상태(규칙·보정)를 받는다 (§14 와 같은 부류).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { console.log('scope_tail_not_found'); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__probe = { LibraDataStorage: typeof LibraDataStorage !== \'undefined\' ? LibraDataStorage : null };'
  + code.slice(injectAt);

const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}),
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop
};
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: global.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const P = ctx.__probe || {};
const LS = P.LibraDataStorage || ctx.LibraDataStorage;
const fn = LS && LS.filterBranchInheritanceByFork;
const turnOf = LS && LS.branchEntryTurn;

// 부모 로어 항목들 — 상속 시 실제로 넘어가는 형태
const memAt = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });
// ★ 실제 제품 형태로 만든다 — 노드에는 `meta.created`(생성 턴)가, 승격 규칙에는
//   `rules.ruleMeta.promotedRules`(텍스트 → 출처 턴)가 붙는다(§5-6 에서 승격이 기록하게 했다).
//   처음엔 도장 없는 픽스처를 써서 "수리했는데 그대로"로 보였다 — 픽스처가 제품 형태가 아니었다(자기오류).
const WORLD_ENTRY = {
  key: 'lmai_world_graph::compact',
  comment: 'lmai_world_graph',
  content: JSON.stringify({
    schema: 'libra.world.graph.compact.v2',
    nodes: [
      { id: 'root', name: '루트',
        rules: {
          custom: { rule_1: 'T40 포크 직전 규칙', rule_2: 'T99 포크 이후 부모가 추가한 규칙' },
          ruleMeta: { schema: 'libra.world.rule_meta.v2', promotedRules: { 'T40 포크 직전 규칙': 40, 'T99 포크 이후 부모가 추가한 규칙': 99 } }
        },
        meta: { created: Date.now(), createdTurn: 40, userWorldCorrection: 'T99 포크 이후 부모가 쓴 보정', worldCorrectionTurn: 99 } },
      //   포크 이후에 **새로 생긴** 노드 (부모가 T99 에 추가)
      { id: 'late', name: 'T99 신규 세계', rules: { custom: {} }, meta: { created: Date.now(), createdTurn: 99 } }
    ]
  }),
  mode: 'normal', insertorder: 6, alwaysActive: false
};

console.log('=== 세계 그래프 항목의 턴 판정 ===');
console.log('  branchEntryTurn(worldEntry) =', turnOf ? turnOf(WORLD_ENTRY) : '(함수 없음)', '← 0 이면 턴 불명');
console.log('  → 턴 불명이면 상속에서 **버리지 않는다**(정보 손실 방지 규칙) → 통째로 넘어간다');

console.log();
console.log('=== fork 턴 40 기준 상속 결과 ===');
const parentEntries = [
  memAt(10, 'T10 기억'),
  memAt(38, 'T38 기억'),
  memAt(40, 'T40 포크 직전 기억'),
  memAt(45, 'T45 포크 이후 부모 기억'),
  memAt(99, 'T99 부모 미래 기억'),
  WORLD_ENTRY
];
const lineage = { status: 'verified', commonPrefixPairs: 40, commonPrefixMessages: 80, parentChatId: 'p1' };
const out = fn(parentEntries, lineage);
const kept = (out?.entries || []);
const keptComments = kept.map(e => e.comment);
console.log('  상속된 항목:', keptComments.join(', '));
console.log('  제외 턴:', JSON.stringify(out?.excludedTurns));
const worldKept = kept.find(e => e.comment === 'lmai_world_graph');
console.log();
console.log('  ★ 세계 그래프 상속됨:', worldKept ? 'O' : 'X');
if (worldKept) {
  const payload = JSON.parse(worldKept.content);
  const allNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  // 노드가 전부 제거됐을 수도 있다(그게 수리 성공의 한 형태).
  const rootNode = allNodes.find(n => n.id === 'root') || allNodes[0] || null;
  const rules = rootNode ? Object.values((rootNode.rules || {}).custom || {}) : [];
  const corr = rootNode ? (rootNode.meta || {}).userWorldCorrection || '' : '';
  console.log('    규칙:', JSON.stringify(rules));
  console.log('    보정:', JSON.stringify(corr));
  const nodes = allNodes.map(n => n.id);
  const ruleContaminated = rules.some(r => /T99/.test(r));
  const corrContaminated = /T99/.test(corr);
  console.log('    노드:', JSON.stringify(nodes));
  console.log();
  console.log('  ★ 규칙 오염:', ruleContaminated ? 'O ← 결함' : 'X (정상 — 포크 이후 규칙 제거됨)');
  console.log('  ★ 노드 오염:', nodes.includes('late') ? 'O ← 결함' : 'X (정상 — 포크 이후 노드 제거됨)');
  console.log('  · 보정(meta.userWorldCorrection) 오염:', corrContaminated ? 'O ← 남은 격차 (턴 도장 없음)' : 'X');
}
