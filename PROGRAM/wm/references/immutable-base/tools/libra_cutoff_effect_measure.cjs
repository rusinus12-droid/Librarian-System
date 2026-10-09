'use strict';
// 측정: cutoffTurn 이 기존 필터보다 **더 잡는 결함**이 있는가 (추측 금지 — 실행으로 확인)
//   가설: 노드 기록이 사라진(트림·미기록) 상태에서 기존 필터는 롤백된 턴을 못 막는다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
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

const WL = ctx.LibraTurnWorldline;
const pair = (t, tag) => ({ pairIndex: t, userText: 'u' + t + tag, assistantText: 'a' + t + tag });
const memAt = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });
const relAt = (turn, id) => ({ id, entityA: 'A', entityB: 'B', meta: { created: turn, sourceTurn: turn } });

(async () => {
  const scope = 'trim-measure';
  await WL.observe(scope, [1, 2, 3, 4, 5, 6, 7].map(t => pair(t, 'a')), { now: 1000 });
  const s = await WL.observe(scope, [1, 2, 3, 4].map(t => pair(t, 'a')), { now: 2000 });
  console.log('cutoffTurn =', s.cutoffTurn, '| 노드 턴 =', s.nodes.map(n => n.pairIndex).sort((a, b) => a - b).join(','));

  const report = (label, state) => {
    const st = WL.buildSupersededTurnSet(state);
    const fm = WL.filterSupersededMemories([memAt(6, '롤백된 턴6 기억')], state);
    const fe = WL.filterSupersededEntityRecords([relAt(6, 'r6')], state);
    console.log(`\n[${label}]`);
    console.log('  superseded          =', [...st.superseded].sort((a, b) => a - b).join(',') || '(빈 집합)');
    console.log('  기억(턴6) 걸러짐     =', fm.excluded > 0 ? 'O' : 'X ← 결함');
    console.log('  엔티티(턴6) 걸러짐   =', fe.excluded > 0 ? 'O' : 'X ← 결함');
    console.log('  isTurnBeyondCutoff(6)=', WL.isTurnBeyondCutoff(6, state), '(경계는 알고 있다)');
    console.log('  turnsBeyondCutoff    =', JSON.stringify(WL.turnsBeyondCutoff(state)));
  };

  report('정상 상태 (롤백 노드 5·6·7 이 기록에 남아 있음)', s);

  // ★ 노드가 사라진 상태 — 저장 트림·미기록·구 데이터 마이그레이션 등
  const trimmed = JSON.parse(JSON.stringify(s));
  trimmed.nodes = trimmed.nodes.filter(n => n.pairIndex <= 4);
  report('노드 소실 상태 (cutoffTurn 은 4 로 남아 있음)', trimmed);

  // 리롤 케이스 — cutoff 는 5, 노드는 5a(superseded) + 5b(active)
  const scope2 = 'reroll-measure';
  await WL.observe(scope2, [1, 2, 3, 4, 5].map(t => pair(t, 'a')), { now: 3000 });
  const s5 = await WL.observe(scope2, [1, 2, 3, 4, pair(5, 'b')], { now: 4000 });
  const fmR = WL.filterSupersededMemories([memAt(5, '턴5 기억')], s5);
  console.log('\n[리롤]  cutoffTurn =', s5.cutoffTurn, '| 턴5 기억 걸러짐 =', fmR.excluded > 0 ? 'O ← 오판(살아있는 턴)' : 'X (정상 — 리롤은 유지)');
  console.log('  isTurnBeyondCutoff(5) =', WL.isTurnBeyondCutoff(5, s5), '(false 여야 정상)');
})();
