'use strict';
// Gate: 리롤·롤백된 턴의 정보가 **RP-LTM·State 주입에도** 새지 않는다 (#1).
//
// 실측된 결함 (probe: 13c:895-940):
//   회상 필터는 `memories` 배열에만 걸린다(908줄).
//     memories = LibraTurnWorldline.filterSupersededMemories(memories, worldlineState)
//   그런데 바로 아래 RP-LTM 주입은 **로어에서 직접** 읽어 나간다(935줄):
//     RPContinuityCore.formatForPrompt(lore, { … })
//   → 리롤/롤백으로 물러난 턴의 **지속 사실·약속·미해결 과제·관계 이정표**가
//     그대로 주입된다. 정본 기억은 걸러지는데 RP-LTM 은 안 걸러진다(비대칭).
//
// 제안서 §13 이 지목한 자리이고, 이번 실측으로 우리 리포에서도 확인됐다.
//
// 이 게이트가 고정하는 계약:
//   W1 RP-LTM 주입이 worldline 필터를 탄다 (배선)
//   W2 물러난 턴의 아이템이 실제로 빠진다 (실행)
//   W3 살아있는 턴의 아이템은 남는다 (과잉 제거 금지 — 리롤은 유지)
//   W4 필터가 없거나 실패하면 주입은 **종전과 동일**하다 (fail-open)
//   W5 제외 건수가 진단에 기록된다 (관측성)
//   W6 빈 worldline 이면 아무것도 제거하지 않는다 (하위 호환)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_13C = fs.readFileSync(path.join(ROOT, 'src/parts/13c-before-request-injection.js'), 'utf8');
const SRC_01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');
const SRC_03G = fs.readFileSync(path.join(ROOT, 'src/parts/03g-rp-continuity-persistence-prompt.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = {
        LibraTurnWorldline, RPContinuityCore, LibraDataStorage,
        // filterSupersededRpItems 는 LibraTurnWorldline(Object.freeze) 의 멤버다.
        filterSupersededRpItems: (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline && typeof LibraTurnWorldline.filterSupersededRpItems === 'function')
            ? LibraTurnWorldline.filterSupersededRpItems
            : null
    };
` + code.slice(idx);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const mk = () => ({
  _v: '', _t: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._t = String(v); }, get textContent() { return this._t || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const store = new Map();
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: {
    getItem: async (k) => (store.has(k) ? store.get(k) : null),
    setItem: async (k, v) => store.set(k, String(v)),
    removeItem: async (k) => store.delete(k),
    keys: async () => Array.from(store.keys())
  },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => ({ id: 'c1', name: 'T', chats: [] }), getChatFromIndex: async () => ({ id: 'ch1', msg: [] }),
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

setTimeout(() => {
  const P = ctx.__probe;
  assert('dist_runs_without_error', !runErr, { error: runErr });
  assert('probes_exported', !!P?.LibraTurnWorldline && !!P?.RPContinuityCore, {
    worldline: !!P?.LibraTurnWorldline, rp: !!P?.RPContinuityCore
  });
  if (!P?.LibraTurnWorldline || !P?.RPContinuityCore) {
    console.log(JSON.stringify({ ok: false, assertions }, null, 2)); process.exit(1);
  }

  const WL = P.LibraTurnWorldline;

  const worldlineState = {
    nodes: [
      { pairIndex: 10, status: 'inactive_variant', supersededBy: 'x' },   // 형제가 살아있음 → 유지
      { pairIndex: 10, status: 'active' },
      { pairIndex: 12, status: 'orphaned' },                              // 롤백 → 제외
      { pairIndex: 11, status: 'active' }
    ]
  };


  // ── W1: RP 주입이 **실제로** worldline 상태를 받아 거르는가 (실행) ──
  //   ★ 문자열 존재는 배선의 증거가 아니다(이 세션에서 3번 밟았다).
  //   RPContinuityCore.formatForPrompt 를 실제로 돌려, 물러난 턴이 빠지는지 본다.
  const rpPrompt = (() => {
    try {
      const entry = {
        comment: 'lmai_rp_longterm',
        content: JSON.stringify({
          schema: 'libra.rp_longterm.v1',
          stableFacts: [{ text: '상시 유효 규칙', lastTurn: 5, status: 'open' }],
          commitments: [
            { text: '리롤된 턴 약속 (유지)', lastTurn: 10, status: 'open' },
            { text: '롤백된 턴 약속 (제외)', lastTurn: 12, status: 'open' }
          ],
          openLoops: [{ text: '진행 중 과제', lastTurn: 11, status: 'open' }]
        })
      };
      const lore = [entry];
      const withState = P.RPContinuityCore.formatForPrompt(lore, { currentTurn: 20, worldlineState });
      const without = P.RPContinuityCore.formatForPrompt(lore, { currentTurn: 20 });
      return { withState: String(withState || ''), without: String(without || '') };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })();
  assert('rp_injection_wires_worldline_filter',
    !rpPrompt.error
      && /리롤된 턴 약속/.test(rpPrompt.withState)          // 리롤은 유지
      && !/롤백된 턴 약속/.test(rpPrompt.withState)          // 롤백은 제외
      && /롤백된 턴 약속/.test(rpPrompt.without)             // 상태 없으면 종전과 동일
      && /상시 유효 규칙/.test(rpPrompt.withState),
    { error: rpPrompt.error, with_state: String(rpPrompt.withState || '').slice(0, 420),
      without_has_rollback: /롤백된 턴 약속/.test(String(rpPrompt.without || '')),
      keys: Object.keys(rpPrompt || {}) });

  // ── W2/W3/W6: 필터를 **실행**해 판정한다 ──
  //   리롤 시나리오: 턴 10 은 리롤(옛 variant=inactive_variant, 새 variant=active) → 유지
  //                  턴 12 는 롤백(살아있는 variant 없음) → 제외
  const items = [
    { text: '상시 유효: 마력은 저주받은 자만 쓴다', lastTurn: 5 },
    { text: '리롤된 턴의 약속 (유지되어야 함)', lastTurn: 10 },
    { text: '롤백된 턴의 약속 (빠져야 함)', lastTurn: 12 },
    { text: '현재 진행 중인 미해결 과제', lastTurn: 11 }
  ];

  // ── W1c: 13c 가 worldline 상태를 **조회해** 넘기는가 (계층 분리) ──
  //   위 W1 은 03g(필터)를 실행해 본다. 13c 가 상태를 안 넘기면 그 필터가 무의미해지므로
  //   **조회→전달** 경로를 따로 본다. (M1 이 이 지점을 겨냥한다)
  const rpBlock = (() => {
    const i = SRC_13C.indexOf('const rpContinuityText = (');
    return i < 0 ? '' : SRC_13C.slice(Math.max(0, i - 900), i + 1800);
  })();
  const looksUpState = /LibraTurnWorldline\.get\(/.test(rpBlock) && /rpWorldlineState\s*=/.test(rpBlock);
  const passesState = /worldlineState:\s*rpWorldlineState/.test(rpBlock);
  assert('rp_injection_passes_worldline_state', looksUpState && passesState,
    { looks_up: looksUpState, passes: passesState, block: rpBlock.slice(0, 200) });

  const fn = P.filterSupersededRpItems;
  assert('rp_filter_function_exists', typeof fn === 'function', { type: typeof fn });

  if (typeof fn === 'function') {
    const out = fn(items, worldlineState);
    const keptTexts = (out?.items || out?.entries || []).map(i => String(i.text || ''));
    const excludedTurns = out?.excludedTurns || [];
    assert('superseded_turn_items_are_dropped',
      Array.isArray(keptTexts) && !keptTexts.some(t => /빠져야/.test(t)) && excludedTurns.includes(12),
      { kept: keptTexts, excludedTurns, result: out });
    assert('live_turn_items_are_kept',
      keptTexts.some(t => /유지되어야/.test(t)) && keptTexts.some(t => /상시 유효/.test(t)) && keptTexts.some(t => /미해결/.test(t)),
      { kept: keptTexts });
    assert('empty_worldline_removes_nothing', (() => {
      const noState = fn(items, null);
      const kept = (noState?.items || noState?.entries || []).length;
      const undefinedState = fn(items, undefined);
      const keptU = (undefinedState?.items || undefinedState?.entries || []).length;
      return kept === items.length && keptU === items.length;
    })(), {
      note: 'worldline 이 없으면 종전과 동일해야 한다',
      // state 가 없을 때 **즉시 반환**하는지도 본다 — 안 그러면 buildSupersededTurnSet 이
      // 빈 집합을 내 "우연히 유지"가 되고, 그 우연이 깨지면 조용히 전부 사라진다.
      early_return: /if\s*\(\s*!state\s*\|\|\s*list\.length\s*===\s*0\s*\)/.test(SRC_01F)
    });
  } else {
    assert('superseded_turn_items_are_dropped', false, { reason: '함수 없음' });
    assert('live_turn_items_are_kept', false, { reason: '함수 없음' });
    assert('empty_worldline_removes_nothing', false, { reason: '함수 없음' });
  }

  // ── W4: fail-open — 상태가 망가져도 주입이 나가야 한다 (실행) ──
  const failOpen = (() => {
    try {
      const entry = {
        comment: 'lmai_rp_longterm',
        content: JSON.stringify({ schema: 'libra.rp_longterm.v1', stableFacts: [{ text: '상시 유효 규칙', lastTurn: 5 }] })
      };
      const bad = P.RPContinuityCore.formatForPrompt([entry], { currentTurn: 20, worldlineState: { nodes: 'not-an-array' } });
      const worse = P.RPContinuityCore.formatForPrompt([entry], { currentTurn: 20, worldlineState: { get nodes() { throw new Error('boom'); } } });
      return { bad: String(bad || ''), worse: String(worse || '') };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })();
  assert('filter_failure_is_fail_open',
    !failOpen.error && /상시 유효 규칙/.test(failOpen.bad) && /상시 유효 규칙/.test(failOpen.worse),
    { error: failOpen.error, bad: String(failOpen.bad || '').slice(0, 200), worse: String(failOpen.worse || '').slice(0, 200), keys: Object.keys(failOpen || {}) });

  // ── W5: 제외 건수 진단 기록 ──
  const recordsNote = /worldlineRpFilterNote|rpFilterNote/.test(SRC_13C);
  assert('excluded_count_recorded', recordsNote, { found: recordsNote });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
}, 250);
