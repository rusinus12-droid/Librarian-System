'use strict';
// Gate: 브랜치 상속은 **fork 지점까지만**이다 (#2).
//
// 실측된 결함 (01f:261):
//   const inherited = parentEntries.map(entry => cloneData(entry));
// → 부모 엔트리 **전체**를 복제한다. forkTurn 필터가 없다.
//
// 시나리오(제안서 §14):
//   Parent T1~40 ── fork ──> Child (T40 에서 갈라짐)
//                 └ Parent T41~100 계속 진행
//   Child 가 받아야 하는 것은 **T1~40** 뿐이다. 지금은 부모의 현재(T100)까지 복제된다.
//
// 제안서 §24 필수 테스트: "T40 fork, parent T100까지 진행. child: <= T40 only. post-fork leakage = 0"
//
// 이 게이트가 고정하는 계약:
//   B1 상속이 lineage 의 fork 지점(commonPrefixPairs)을 본다
//   B2 fork 이후 턴의 엔트리가 실제로 빠진다 (실행)
//   B3 fork 이전 엔트리는 남는다 (과잉 제거 금지)
//   B4 턴을 알 수 없는 엔트리는 **버리지 않는다** (정보 손실 방지 — 보수적)
//   B5 fork 지점을 못 구하면 종전과 동일하게 전체 상속 (fail-open, 하위 호환)
//   B6 lineage 는 그대로 둔다 (부모 데이터 삭제 금지 — 브랜치는 분기지 이동이 아니다)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = {
        LibraTurnWorldline,
        memoryEntryTurn: (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline) ? LibraTurnWorldline.memoryEntryTurn : null,
        filterBranchInheritanceByFork: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage && typeof LibraDataStorage.filterBranchInheritanceByFork === 'function')
            ? LibraDataStorage.filterBranchInheritanceByFork : null,
        // ★ 실제 호출 경로를 실행하기 위해 상속 진입점을 노출한다.
        //   filter 만 직접 부르면 배선이 죽어 있어도 통과한다(실제로 그랬다 —
        //   ReferenceError: filterBranchInheritanceByFork is not defined 를 게이트가 못 봤다).
        inheritFromBranch: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage && typeof LibraDataStorage.inheritFromBranch === 'function')
            ? LibraDataStorage.inheritFromBranch : null,
        LibraDataStorage: (typeof LibraDataStorage !== 'undefined') ? LibraDataStorage : null
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
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => store.set(k, String(v)), removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
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
  assert('probes_exported', !!P?.LibraTurnWorldline, { worldline: !!P?.LibraTurnWorldline });
  if (!P?.LibraTurnWorldline) { console.log(JSON.stringify({ ok: false, assertions }, null, 2)); process.exit(1); }

  // ── B1: 01f 상속 경로가 fork 지점을 보는가 (소스 계약) ──
  //   ★ 종전에는 **고정 3600자 창**으로 잘랐다. 그 결과 G4 주석 몇 줄이 함수 뒤쪽의
  //     `filterBranchInheritanceByFork` 를 창 밖으로 밀어내 **거짓 실패**를 냈다
  //     (실측: 상속 동작은 정상이었고 B5 실행 검사도 통과 — 프록시만 취약했다).
  //     함수 **본문 전체**를 중괄호 균형으로 뽑는다.
  const inheritBlock = (() => {
    const marker = 'const inheritFromBranch = async (char = null, chat = null, options = {}) => {';
    let i = SRC_01F.indexOf(marker);
    if (i < 0) i = SRC_01F.indexOf('const inheritFromBranch = async (');
    if (i < 0) return '';
    //   ★ 본문 중괄호는 **`=> {` 뒤**의 것이다. 그냥 첫 `{` 를 잡으면 시그니처의
    //     `options = {}` 빈 객체를 본문으로 오인해 71자만 뽑는다(실측으로 밟았다).
    const arrowBrace = SRC_01F.indexOf('=> {', i);
    const open = arrowBrace >= 0 ? arrowBrace + 3 : SRC_01F.indexOf('{', i);
    if (open < 0) return '';
    let depth = 0, j = open;
    for (; j < SRC_01F.length; j += 1) {
      if (SRC_01F[j] === '{') depth += 1;
      else if (SRC_01F[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return SRC_01F.slice(i, j + 1);
  })();
  const usesFork = /commonPrefixPairs|forkMessageIndex|filterBranchInheritanceByFork/.test(inheritBlock);
  const clonesAll = /parentEntries\.map\(entry => cloneData\(entry\)\)/.test(inheritBlock);
  assert('inheritance_considers_fork_point', usesFork,
    { uses_fork: usesFork, still_clones_all_blindly: clonesAll, blockLength: inheritBlock.length });

  // ── B2/B3/B4/B5: 필터를 **실행**해 판정 ──
  // ★ 엔트리마다 **다른 턴 키**를 쓴다 — 실제 저장 형태가 하나로 고정돼 있지 않으므로,
  //   한 키만 보는 독자가 조용히 턴을 놓치는 결함을 드러낸다(M5 가 겨냥하는 지점).
  const TURN_KEYS = ['turn', 't', 'turnAnchorTurn', 'finalizedTurn'];
  const mkEntry = (turn, text, key = 'turn') => ({
    comment: 'lmai_memory',
    content: `[META:${JSON.stringify({ [key]: turn, imp: 5 })}]\n${text}`
  });
  const parentEntries = [
    mkEntry(10, 'T10 부모 사건', 'turn'),
    mkEntry(38, 'T38 부모 사건', 't'),
    mkEntry(40, 'T40 포크 직전', 'turnAnchorTurn'),
    mkEntry(45, 'T45 포크 이후', 't'),
    mkEntry(99, 'T99 부모 미래', 'finalizedTurn'),
    { comment: 'lmai_memory', content: 'no meta at all — 턴 불명' }
  ];
  // lineage: child 가 T40 에서 갈라짐 → commonPrefixPairs = 40
  const lineage = { status: 'verified', commonPrefixPairs: 40, commonPrefixMessages: 80, parentChatId: 'p1' };

  const fn = P.filterBranchInheritanceByFork;
  assert('fork_filter_function_exists', typeof fn === 'function', { type: typeof fn });

  if (typeof fn === 'function') {
    const out = fn(parentEntries, lineage);
    // 엔트리 텍스트: META 줄을 떼고 나머지를 본다(턴 불명 엔트리는 META 가 아예 없어 줄이 하나뿐이다).
    const keptTexts = (out?.entries || []).map(e => String(e.content || '').replace(/^\[META:[^\]]*\]\s*/,'').trim());
    const excludedTurns = out?.excludedTurns || [];
    assert('post_fork_entries_are_dropped',
      !keptTexts.some(t => /T45|T99/.test(t)) && excludedTurns.includes(45) && excludedTurns.includes(99),
      { kept: keptTexts, excludedTurns, result: { inherited: out?.inherited, excluded: out?.excluded } });
    // 턴 키가 여러 형태여도 **전부** 읽어야 한다 (한 키만 보면 조용히 놓친다)
    assert('all_turn_key_shapes_are_read',
      excludedTurns.includes(45) && excludedTurns.includes(99),
      { excludedTurns, turn_keys_used: TURN_KEYS, note: 't·turn·turnAnchorTurn·finalizedTurn 어느 형태든 읽어야 한다' });
    assert('pre_fork_entries_are_kept',
      keptTexts.some(t => /T10/.test(t)) && keptTexts.some(t => /T38/.test(t)) && keptTexts.some(t => /T40/.test(t)),
      { kept: keptTexts });
    assert('unknown_turn_entries_are_not_dropped',
      keptTexts.some(t => /턴 불명/.test(t)),
      { kept: keptTexts, note: '턴을 알 수 없으면 버리지 않는다 (정보 손실 방지)' });
    assert('no_fork_point_keeps_everything', (() => {
      const noFork = fn(parentEntries, { status: 'verified' });
      const kept = (noFork?.entries || []).length;
      return kept === parentEntries.length;
    })(), { note: 'fork 지점을 못 구하면 종전과 동일(전체 상속)' });
  } else {
    assert('post_fork_entries_are_dropped', false, { reason: '함수 없음' });
    assert('pre_fork_entries_are_kept', false, { reason: '함수 없음' });
    assert('unknown_turn_entries_are_not_dropped', false, { reason: '함수 없음' });
    assert('no_fork_point_keeps_everything', false, { reason: '함수 없음' });
  }

  // ── B7: **실제 호출 경로**(inheritFromBranch)가 살아서 fork 를 자르는가 ──
  //   이것이 없으면 배선(스코프) 오류를 못 잡는다 — 필터만 직접 부르면 통과한다.
  const ib = P?.inheritFromBranch;
  assert('inherit_entrypoint_exists', typeof ib === 'function', { type: typeof ib });
  if (typeof ib === 'function') {
    const parentChatId = 'parent-chat-1';
    const parentEntries = [
      mkEntry(10, 'T10 부모 사건'), mkEntry(38, 'T38 부모 사건'),
      mkEntry(40, 'T40 포크 직전'), mkEntry(45, 'T45 포크 이후'), mkEntry(99, 'T99 부모 미래')
    ];
    // 부모 대화를 스토리지에 심고, 자식에서 상속을 실행한다.
    const parentChat = { id: parentChatId, name: 'parent', msg: [], isBranch: false };
    const parentChar = { id: 'c1', name: 'T', chats: [parentChat] };
    // 로어 스코프 키: worldlineKeyFor 가 쓰는 규칙과 동일하게 만든다.
    const key = (() => {
      try { return ctx.LibraTurnWorldline.worldlineKeyFor('c1', parentChatId); } catch (_) { return null; }
    })();
    // 로어를 직접 심는다(스토리지 계층).
    const seeded = (() => {
      try {
        const LS = ctx.LibraDataStorage;
        if (LS && key) { LS.__seed?.(key, parentEntries); }
        return !!LS;
      } catch (_) { return false; }
    })();
    // lineage 를 주입할 수 없으므로(실제 inspect 가 대화를 본다) 여기서는 **필터가 상속 경로에서
    //   참조되는지**를 함수 소스로 확인하고, 실행은 위 B2~B5 가 담당한다.
    const ibSrc = String(ib);
    assert('inherit_entrypoint_calls_fork_filter',
      /filterBranchInheritanceByFork\s*\(/.test(ibSrc) || /forked\.entries/.test(ibSrc),
      { calls: /filterBranchInheritanceByFork\s*\(/.test(ibSrc), uses_forked: /forked\.entries/.test(ibSrc) });
    // 실행: inheritFromBranch 를 부모 대화 없이 불러도 **예외 없이** 끝나야 한다(배선 생존).
    const ran = (async () => { try { return await ib(parentChar, parentChat); } catch (e) { return { __err: String(e.message).slice(0, 200) }; } })();
    globalThis.__ibResult = ran;
  } else {
    assert('inherit_entrypoint_calls_fork_filter', false, { reason: '진입점 없음' });
  }

  // ── B6: 부모 데이터는 그대로 (삭제 금지) ──
  //   상속은 `shadow.set(targetScope, …)` 만 한다 — 부모 스코프를 건드리지 않는다.
  const touchesParent = /shadow\.(delete|set)\(\s*parentScope/.test(SRC_01F);
  assert('parent_data_is_preserved', !touchesParent, { touches_parent_scope: touchesParent });

  // 실제 호출 경로가 **예외 없이** 끝났는지 (배선 생존)
  if (globalThis.__ibResult && typeof globalThis.__ibResult.then === 'function') {
    globalThis.__ibResult.then(res => {
      assert('inherit_entrypoint_runs_without_error', !(res && res.__err), { error: res && res.__err, result: res });
      const allOk = assertions.every(a => a.ok);
      console.log(JSON.stringify({ ok: allOk, assertions }, null, 2));
      process.exit(allOk ? 0 : 1);
    });
    return;
  }

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
}, 250);
