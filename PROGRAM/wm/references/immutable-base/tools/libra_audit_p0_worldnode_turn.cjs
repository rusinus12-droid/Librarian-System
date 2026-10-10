'use strict';
// 감사용 실측 — P0(World node Date.now() vs forkTurn 단위 혼용) 재현
//   주장: `branchWorldGraphTurn` 이 `meta.created`(timestamp) 를 turn ordinal 로 읽어
//         정상 노드를 "포크 이후"로 오판하고 제거한다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: global.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const WL = ctx.LibraTurnWorldline;
const LS = ctx.LibraDataStorage;

// 제품이 실제로 만드는 형태 (08a:72)
const productNode = { id: 'root', name: '루트', rules: { custom: { rule_1: '세계 규칙' } }, meta: { created: Date.now(), updated: 0, source: 'default' } };
const entry = {
  comment: 'lmai_world_graph',
  content: JSON.stringify({ schema: 'libra.world.graph.compact.v2', nodes: [productNode] }),
  key: 'lmai_world_graph::compact', insertorder: 6
};

console.log('=== P0 재현: 제품이 만든 노드 형태 ===');
console.log('  meta.created =', productNode.meta.created, '(timestamp)');
console.log('  typeof        =', typeof productNode.meta.created);
const t = LS && LS.branchWorldGraphTurn ? LS.branchWorldGraphTurn(entry, productNode) : '(함수 없음)';
console.log('  branchWorldGraphTurn() 이 반환한 "턴" =', t);
console.log('  → fork 턴 40 과 비교:', Number(t) > 40 ? '★ 40 초과 → 포크 이후로 오판' : '포크 이전');

const fn = LS && LS.filterBranchInheritanceByFork;
if (typeof fn === 'function') {
  const lineage = { status: 'verified', commonPrefixPairs: 40, parentChatId: 'p1' };
  const out = fn([entry], lineage);
  const kept = (out?.entries || []).find(e => e.comment === 'lmai_world_graph');
  const nodes = kept ? (JSON.parse(kept.content).nodes || []).map(n => n.id) : [];
  console.log();
  console.log('=== 실제 상속 결과 (fork 40) ===');
  console.log('  남은 노드 =', JSON.stringify(nodes));
  console.log('  ★ 정상 노드가 삭제됐나:', nodes.includes('root') ? 'X (보존 — 문제 없음)' : 'O ← 결함 재현 (세계가 통째로 사라짐)');
}
