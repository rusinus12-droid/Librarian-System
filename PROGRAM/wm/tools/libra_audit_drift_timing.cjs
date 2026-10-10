'use strict';
// 감사 실측 — P1-잠재: fire-and-forget drift 확인과 recall 사이의 **stale worldline** 가능성
//
// 리뷰 주장:
//   13c:169 `void checkTurnDriftForActiveChat(char, chat)` 는 결과를 기다리지 않는다(fire-and-forget).
//   그 안에서 `Utils.confirmEx`(사용자 대화상자)를 await 하므로, 사용자가 응답할 때까지 `observe` 가
//   실행되지 않는다. 그 사이 같은 beforeRequest 의 recall(906·921)이 **옛 worldline state** 를 읽으면
//   폐기된 variant 의 기억이 한 번 더 들어갈 수 있다.
//
// 이 도구가 답할 것:
//   Q1 순서 — drift 확인이 recall **앞**에 있는가 (예약만 되고 늦게 완료되는가)
//   Q2 지연이 없을 때(즉시 confirm)는 안전한가
//   Q3 지연이 있을 때(느린 confirm) 옛 상태로 필터가 돌아 **stale 기억이 통과**하는가
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_13C = fs.readFileSync(path.join(ROOT, 'src/parts/13c-before-request-injection.js'), 'utf8');

const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const noop = () => {};
const mk = () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, set innerHTML(v) {}, get innerHTML() { return ''; }, setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), addEventListener: noop };
const store = new Map();
const R = { apiVersion: '3.0', getRuntimeInfo: async () => ({}), pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => [...store.keys()] }, getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {}, addRisuScriptHandler: noop, onUnload: noop };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, globalThis: null, window: null, document, Risuai: R, risuai: R, structuredClone: globalThis.structuredClone, fetch: async () => { throw new Error('x'); }, AbortController, performance: { now: () => Date.now() } };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 30000 });

const WL = ctx.LibraTurnWorldline;
const LS = ctx.LibraDataStorage;

console.log('=== Q1: 순서 (소스) ===');
const lineOf = (needle) => { const i = SRC_13C.indexOf(needle); return i < 0 ? null : SRC_13C.slice(0, i).split('\n').length; };
const L169 = lineOf('void checkTurnDriftForActiveChat(char, chat)');
const L906 = lineOf('let memories = await MemoryEngine.retrieveMemories');
const L921 = lineOf('const worldlineState = worldlineScope && typeof LibraTurnWorldline?.get');
console.log('  drift 확인 예약 :', L169, '(await 하지 않음 — fire-and-forget)');
console.log('  recall         :', L906);
console.log('  worldline 읽기  :', L921);
console.log('  → drift 확인이 recall 보다 **앞**에서 예약되지만 결과는 안 기다린다:', L169 < L906);
console.log();

// ── 시나리오: 리롤 후 즉시 새 요청 ──
const scope = 'stale-test';
const pairs = (turns) => turns.map(t => ({ pairIndex: t, userText: `u${t}`, assistantText: `a${t}` }));
const memAt = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });

(async () => {
  // 1) 턴 1~5 저장 (월드라인 기준 상태)
  await WL.observe(scope, pairs([1, 2, 3, 4, 5]), { now: 1000 });
  const stored = WL.get(scope);
  console.log('=== Q2: 옛 상태(=월드라인 기준, 리롤 반영 전) ===');
  console.log('  저장된 노드 턴:', stored.nodes.map(n => n.pairIndex).sort((a, b) => a - b).join(','));
  console.log('  cutoffTurn:', stored.cutoffTurn);

  // 2) 사용자가 **롤백** (턴 4·5 를 대화에서 삭제)
  //   ★ 리롤이 아니라 롤백이어야 한다 — 턴이 **잘리는** 경우에만 cutoff 경계가 움직인다.
  const liveAfterRollback = [{ pairIndex: 1, userText: 'u1', assistantText: 'a1' },
    { pairIndex: 2, userText: 'u2', assistantText: 'a2' },
    { pairIndex: 3, userText: 'u3', assistantText: 'a3' }];
  const drift = WL.detectDrift(scope, liveAfterRollback);
  console.log();
  console.log('=== 롤백 직후 — recall 이 읽는 상태 ===');
  console.log('  detectDrift.changed =', drift.changed, '| rolledBack =', drift.rolledBack.length, '건',
    '| 턴:', drift.rolledBack.map(x => x.pairIndex).join(','));
  console.log('  ※ 이 시점에 사용자 confirm 대화상자가 떠 있고 `observe` 는 **아직 안 돌았다**');

  // 3) BEFORE: 옛 저장 상태를 recall 이 읽는다
  const staleState = WL.get(scope);
  const staleMemories = [memAt(4, '턴4 기억'), memAt(5, '턴5 기억')];
  const staleFiltered = WL.filterSupersededMemories(staleMemories, staleState);
  console.log();
  console.log('  [옛 상태] cutoffTurn =', staleState.cutoffTurn);
  console.log('             걸러진 기억:', staleFiltered.excluded, '건',
    '| 남은 턴:', staleFiltered.entries.map(e => (e.content.match(/"turn":(\d+)/) || [])[1]).join(',') || '(없음)');

  // 4) AFTER: observe 가 돌아 롤백이 반영됨
  await WL.observe(scope, liveAfterRollback, { now: 2000 });
  const freshState = WL.get(scope);
  const freshFiltered = WL.filterSupersededMemories(staleMemories, freshState);
  console.log();
  console.log('  [observe 후] cutoffTurn =', freshState.cutoffTurn);
  console.log('             걸러진 기억:', freshFiltered.excluded, '건',
    '| 남은 턴:', freshFiltered.entries.map(e => (e.content.match(/"turn":(\d+)/) || [])[1]).join(',') || '(없음)');

  console.log();
  console.log('=== 판정 ===');
  const staleLeaks = staleFiltered.excluded === 0 && freshFiltered.excluded > 0;
  console.log('  옛 상태에서 롤백된 턴 기억이 **통과**하나:', staleFiltered.excluded === 0 ? 'O ← 리뷰 주장 재현' : 'X');
  console.log('  observe 후 걸러지나:', freshFiltered.excluded > 0 ? 'O' : 'X');
  console.log();
  console.log('  ★★ 리뷰 주장 재현 여부:', staleLeaks ? '재현됨 — window 가 실재한다' : '재현 안 됨');

  // 5) ★ 수리 검증 — ephemeral 제외 집합을 **동기 판정**으로 만들면 옛 상태에서도 막히는가
  //   (이것이 리뷰가 제안한 방식: 영속화는 비동기로 두고 이번 요청만 보정)
  const SRC_13C = fs.readFileSync(path.join(ROOT, 'src/parts/13c-before-request-injection.js'), 'utf8');
  const hasSyncEphemeral = /ephemeralDriftExclusion/.test(SRC_13C);
  console.log();
  console.log('=== 수리 검증 (ephemeral 동기 제외) ===');
  console.log('  소스에 ephemeral 판정이 있나:', hasSyncEphemeral ? 'O' : 'X');

  //   실제 수리 로직을 흉내: detectDrift 를 **동기로** 돌려 제외 집합을 만들고,
  //   옛 저장 상태로 필터한 뒤 그 집합을 적용한다.
  await WL.observe(scope, pairs([1, 2, 3, 4, 5]), { now: 5000 });   // 옛 상태로 되돌린다
  const backToOld = WL.get(scope);
  const liveRolled = [{ pairIndex: 1, userText: 'u1', assistantText: 'a1' },
    { pairIndex: 2, userText: 'u2', assistantText: 'a2' },
    { pairIndex: 3, userText: 'u3', assistantText: 'a3' }];
  const syncDrift = WL.detectDrift(scope, liveRolled);
  const ephemeralTurns = new Set((syncDrift.rolledBack || []).map(x => Number(x.pairIndex) || 0).filter(Boolean));
  const beforeRepair = WL.filterSupersededMemories(staleMemories, backToOld);
  const afterRepair = beforeRepair.entries.filter(entry => {
    const turn = Number(WL.memoryEntryTurn?.(entry) || 0) || 0;
    return !(turn && ephemeralTurns.has(turn));
  });
  console.log('  옛 cutoffTurn =', backToOld.cutoffTurn, '| 동기 감지된 롤백 턴:', Array.from(ephemeralTurns).sort((a, b) => a - b).join(','));
  console.log('  [수리 전] 남은 기억:', beforeRepair.entries.length, '건');
  console.log('  [수리 후] 남은 기억:', afterRepair.length, '건');
  console.log();
  console.log('  ★★ 수리 효과:', (beforeRepair.entries.length > afterRepair.length)
    ? 'O — 응답 지연 없이 stale 기억이 차단된다' : 'X — 차단되지 않음');
})();
