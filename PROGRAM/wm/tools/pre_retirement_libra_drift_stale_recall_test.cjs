'use strict';
// Gate: fire-and-forget drift 확인과 recall 사이의 **stale worldline 창**을 막는다 (감사 P1-잠재)
//
// 리뷰 주장(재현됨):
//   `13c:169` `void checkTurnDriftForActiveChat(char, chat)` 는 `Utils.confirmEx`(사용자 대화상자)를
//   await 하므로 `observe` 가 늦게 돈다. 그 사이 recall(906·921)이 **옛 worldline** 을 읽으면
//   롤백된 턴의 기억이 한 번 더 들어간다.
//
// 실측 재현: 옛 cutoff 5 → 롤백된 턴 4·5 기억 **0건 걸러짐(통과)**. observe 후 cutoff 3 → 2건 걸러짐.
//
// 계약:
//   D1 drift 확인은 **동기로도** 판정된다 (대화상자를 기다리지 않는다)
//   D2 롤백(잘려나간 턴)만 대상이다 — 리롤은 같은 위치에 살아있는 variant 가 있으므로 제외 대상이 아니다
//   D3 제외 집합은 **이번 요청에만** 적용된다 (영속 상태를 바꾸지 않는다 — 사용자 확인이 담당)
//   D4 기억 필터가 그 집합을 **소비**한다 (만들어 놓고 안 쓰면 무의미)
//   D5 저장 상태가 이미 신선하면(경계가 맞으면) **추가 제외가 없다** (과잉 제거 금지)
//   D6 롤백이 없으면 집합이 비어 있다 (오작동 금지)
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
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const WL = ctx.LibraTurnWorldline;
assert('dist_runs_without_error', !runErr, { error: runErr });
assert('worldline_exported', !!WL, { keys: WL ? Object.keys(WL).slice(0, 10) : null });

// ── D1·D3·D4: 소스 계약 (동기 판정 + 소비 + 비영속) ──
const syncBlock = (() => {
  const i = SRC_13C.indexOf('const ephemeralDriftExclusion = (() => {');
  return i < 0 ? '' : SRC_13C.slice(i, i + 900);
})();
assert('sync_ephemeral_judgement_exists', syncBlock.length > 0,
  { note: '대화상자를 기다리지 않고 동기로 판정해야 창이 닫힌다' });
//   ★★ 판정·적용 로직은 `LibraTurnWorldline` export 에 있어 **게이트가 실행**할 수 있다.
//      소스 문자열만 보면 `if (false && …)` 같은 죽은 코드를 통과시킨다(대조군 M1·M4 가 그 지점이었다).
assert('exclusion_builder_exported',
  typeof WL.buildDriftExclusion === 'function',
  { type: typeof (WL && WL.buildDriftExclusion), note: '게이트가 실행할 수 있는 자리에 있어야 한다' });
assert('exclusion_applier_exported',
  typeof WL.applyDriftExclusion === 'function',
  { type: typeof (WL && WL.applyDriftExclusion) });
assert('injection_path_delegates_to_exports',
  /buildDriftExclusion/.test(SRC_13C) && /applyDriftExclusion/.test(SRC_13C),
  { builds: /buildDriftExclusion/.test(SRC_13C), applies: /applyDriftExclusion/.test(SRC_13C),
    note: '배선이 export 를 실제로 써야 한다(규칙 복제 금지)' });

// ── D2·D5·D6: 실행 — 실제 worldline 으로 판정 ──
(async () => {
  if (!WL || typeof WL.observe !== 'function') { assert('worldline_observable', false, {}); 
    const ok0 = assertions.every(a => a.ok); console.log(JSON.stringify({ ok: ok0, assertions }, null, 2)); process.exit(ok0 ? 0 : 1); }

  const scope = 'gate-drift';
  const p = (t, tag = '') => ({ pairIndex: t, userText: `u${t}`, assistantText: `a${t}${tag}` });
  const memAt = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });

  await WL.observe(scope, [p(1), p(2), p(3), p(4), p(5)], { now: 1000 });
  const storedState = WL.get(scope);

  // 롤백: 턴 4·5 가 대화에서 사라졌다 (저장 상태는 아직 옛것)
  const rolledLive = [p(1), p(2), p(3)];
  const drift = WL.detectDrift(scope, rolledLive);
  const ephemeralTurns = new Set((drift.rolledBack || []).map(x => Number(x.pairIndex) || 0).filter(Boolean));

  assert('rollback_detected_synchronously',
    drift.changed === true && ephemeralTurns.has(4) && ephemeralTurns.has(5),
    { changed: drift.changed, turns: Array.from(ephemeralTurns).sort((a, b) => a - b) });

  // 저장 상태가 아직 옛것이므로 필터만으로는 통과한다 (창의 존재)
  const oldFiltered = WL.filterSupersededMemories([memAt(4, '턴4'), memAt(5, '턴5'), memAt(2, '턴2')], storedState);
  assert('window_exists_without_ephemeral_set',
    oldFiltered.excluded === 0,
    { excluded: oldFiltered.excluded, cutoff: storedState.cutoffTurn, note: '★ 이 창이 리뷰가 지적한 결함' });

  // ephemeral 집합을 **제품 함수로** 만들어 적용하면 막힌다 (수리 — 실행)
  const builtExclusion = WL.buildDriftExclusion(scope, rolledLive);
  const applied = WL.applyDriftExclusion(oldFiltered.entries, builtExclusion, scope);
  const repaired = applied.entries;
  assert('ephemeral_set_blocks_stale_memories',
    repaired.length === 1 && /턴2/.test(String(repaired[0]?.content || ''))
    && (builtExclusion?.turns instanceof Set) && builtExclusion.turns.has(4) && builtExclusion.turns.has(5)
    && applied.excluded === 2,
    { before: oldFiltered.entries.length, after: repaired.length, exclusionTurns: builtExclusion ? Array.from(builtExclusion.turns) : null,
      applied: applied.excluded,
      note: '롤백된 턴만 빠지고 살아있는 턴(2)은 남아야 한다' });

  // ── D3-실행: 판정은 **영속하지 않는다** (저장 상태가 바뀌면 사용자 확인이 무의미해진다) ──
  //   ★ 대조군 M3 이 이 지점을 겨냥했다 — 소스 패턴(`.observe(`)만 보면 놓친다.
  //     **저장 상태의 liveHash 가 판정 전후로 같은지** 실행으로 본다.
  const beforeBuild = WL.get(scope);
  const hashBefore = String(beforeBuild.liveHash || '');
  const revisionBefore = Number(beforeBuild.revision || 0);
  WL.buildDriftExclusion(scope, rolledLive);
  await new Promise(resolve => setTimeout(resolve, 30));   // observe 가 돌 시간을 준다(변이면 바뀐다)
  const afterBuild = WL.get(scope);
  assert('exclusion_build_does_not_persist',
    String(afterBuild.liveHash || '') === hashBefore && Number(afterBuild.revision || 0) === revisionBefore,
    { hashBefore, hashAfter: String(afterBuild.liveHash || ''), revisionBefore, revisionAfter: Number(afterBuild.revision || 0),
      note: '★ D3 — 동기 판정이 상태를 바꾸면 뒤이은 확인이 무의미해진다' });

  // ── D2: 리롤은 제외 대상이 아니다 (과잉 제거 금지) ──
  const scopeR = 'gate-drift-reroll';
  await WL.observe(scopeR, [p(1), p(2), p(3)], { now: 4000 });
  const rerollLive = [p(1), p(2), p(3, '-REROLLED')];
  const rerollExclusion = WL.buildDriftExclusion(scopeR, rerollLive);
  const rerollApplied = WL.applyDriftExclusion([memAt(3, '턴3')], rerollExclusion, scopeR);
  assert('reroll_is_not_excluded',
    rerollExclusion === null && rerollApplied.excluded === 0,
    { exclusion: rerollExclusion ? Array.from(rerollExclusion.turns) : null, applied: rerollApplied.excluded,
      note: '★ D2 — 리롤은 같은 위치에 살아있는 variant 가 있다. 제외하면 정상 기억이 사라진다' });

  // ── D3: 다른 스코프에는 적용되지 않는다 (영속 아님 + 안전) ──
  const crossApplied = WL.applyDriftExclusion([memAt(4, '턴4')], builtExclusion, 'other-scope');
  assert('exclusion_is_scope_bound',
    crossApplied.excluded === 0,
    { applied: crossApplied.excluded, note: '★ D3 — 스코프가 다르면 적용하지 않는다' });

  // ── D5/D6: 관찰 후에는 추가 제외가 없다 / 롤백 없으면 집합이 빈다 ──
  await WL.observe(scope, rolledLive, { now: 2000 });
  const freshState = WL.get(scope);
  const freshFiltered = WL.filterSupersededMemories([memAt(4, '턴4'), memAt(5, '턴5'), memAt(2, '턴2')], freshState);
  const stillBeyond = freshFiltered.entries.filter(entry => {
    const turn = Number(WL.memoryEntryTurn?.(entry) || 0) || 0;
    return turn && ephemeralTurns.has(turn);
  }).length;
  assert('no_extra_exclusion_when_state_is_fresh',
    stillBeyond === 0,
    { cutoff: freshState.cutoffTurn, note: '저장 상태가 따라오면 이미 걸러진다 (과잉 제거 금지)' });

  const scope2 = 'gate-drift-clean';
  await WL.observe(scope2, [p(1), p(2), p(3)], { now: 3000 });
  const cleanDrift = WL.detectDrift(scope2, [p(1), p(2), p(3)]);
  const cleanTurns = new Set((cleanDrift.rolledBack || []).map(x => Number(x.pairIndex) || 0).filter(Boolean));
  assert('no_rollback_means_empty_set',
    cleanDrift.changed === false && cleanTurns.size === 0,
    { changed: cleanDrift.changed, turns: Array.from(cleanTurns) });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
