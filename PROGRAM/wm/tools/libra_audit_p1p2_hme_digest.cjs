'use strict';
// 감사용 실측 — P1(relationDigest 부재) · P2(incremental 이 nodes 를 digest 에 넘김)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');

console.log('=== P1: graph source 의 digest 목록 ===');
const srcBlocks = [];
for (const m of SRC.matchAll(/hmeScopeIndexDigest:[\s\S]{0,220}?\n/g)) srcBlocks.push(m[0]);
console.log('  source 생성 지점 수:', srcBlocks.length);
for (const b of srcBlocks) {
  const keys = [...b.matchAll(/(\w+Digest)\s*:/g)].map(x => x[1]);
  console.log('   -', keys.join(', ') || '(없음)');
}
const hasRelation = /relationDigest/.test(SRC);
console.log();
console.log('  ★ relationDigest 존재:', hasRelation ? 'O' : 'X ← 부재 (P1 사실)');

// E3 가 relation 을 읽는가
const e3 = /relation_record/.test(SRC) && /lmai_relation/.test(SRC);
console.log('  E3 가 lmai_relation 을 읽나:', e3 ? 'O (relation 을 소비한다)' : 'X');
console.log('  → relation 이 바뀌어도 digest 불변 → E3 edge 가 stale 로 남는다');

console.log();
console.log('=== P2: hmeGraphInputDigest 호출 인자 ===');
const calls = [...SRC.matchAll(/hmeGraphInputDigest\((\w+),\s*'(\w+)'\)/g)];
for (const c of calls) {
  const line = SRC.slice(0, c.index).split('\n').length;
  console.log(`  L${line}: hmeGraphInputDigest(${c[1]}, '${c[2]}')`);
}
const nodeArgs = calls.filter(c => c[1] === 'nodes');
console.log();
console.log('  ★ graph nodes 를 넘기는 호출:', nodeArgs.length, '건 ← P2 사실이면 2건');

// digest 함수가 comment 를 요구하는가 (실행 검증)
const fnBody = SRC.slice(SRC.indexOf('const hmeGraphInputDigest'));
const requiresComment = /entry\?\.comment/.test(fnBody) || /entry\.comment/.test(fnBody);
console.log('  digest 함수가 entry.comment 를 요구하나:', requiresComment ? 'O' : 'X');
console.log('  → graph node 에는 comment 가 없다 → digest 가 빈 문자열이 된다');

// 실제로 계산해 확인 (dist 에서 함수 추출)
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const probe = '\n;globalThis.__auditHme = { hmeGraphInputDigest: (typeof hmeGraphInputDigest !== \'undefined\') ? hmeGraphInputDigest : null };';
const closeIdx = code.lastIndexOf('\n})();');
code = code.slice(0, closeIdx + '\n})();'.length) + probe + code.slice(closeIdx + '\n})();'.length);

const vm = require('vm');
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: globalThis.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const dg = ctx.__auditHme && ctx.__auditHme.hmeGraphInputDigest;
console.log();
if (typeof dg === 'function') {
  const realEntries = [{ comment: 'lmai_entity', content: '{"name":"미라","summary":"a"}' }];
  const graphNodes = [{ id: 'n1', name: '미라', kind: 'entity', summaryHash: 'h1' }];
  const d1 = dg(realEntries, 'entity');
  const d2 = dg(graphNodes, 'entity');
  console.log('  ★ 실행 검증');
  console.log('    digest(실제 lore entries) =', JSON.stringify(d1));
  console.log('    digest(graph nodes)       =', JSON.stringify(d2), d2 === '' ? '← 빈 문자열 (P2 재현)' : '');
} else {
  console.log('  (함수 미노출 — 정적 분석으로 갈음)');
}
