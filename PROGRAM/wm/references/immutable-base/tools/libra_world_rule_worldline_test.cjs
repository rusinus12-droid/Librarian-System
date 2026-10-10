'use strict';
// Gate: 세계 규칙도 리롤·롤백을 탄다 (§5-6 — 쓰기 guard 의 대칭 확장)
//
// 실측된 결함:
//   `13c:748`  worldPrompt = HierarchicalWorldManager.formatForPrompt()   ← 세계 규칙을 프롬프트에 넣는다
//   `08a:761`  customRules = compactCustomRules(currentRules.custom, 10)  ← 규칙 본문만 낸다
//   `08a:848`  updateNode(nodeId, { rules: { custom: { [nextKey]: text } } })  ← 턴 도장이 없다
//   → 승격된 세계 규칙은 **출처 턴을 모른다**. 그 턴이 리롤·롤백돼도 규칙은 영원히 남는다.
//
// 대칭성 대조 (같은 결함이 계층마다 반복돼 왔다):
//   기억     = filterSupersededMemories      (#1)
//   RP-LTM   = filterSupersededRpItems       (#1)
//   엔티티·관계 = filterSupersededEntityRecords (§5-5)
//   **세계 규칙 = 없음**                     ← 이 게이트
//
// 계약:
//   R1 승격이 출처 턴을 노드에 기록한다 (ruleMeta.promotedRules — 텍스트→턴)
//   R2 그 턴이 superseded 면 **프롬프트에서 빠진다** (실행)
//   R3 살아있는 턴의 규칙은 남는다 (과잉 제거 금지)
//   R4 턴을 알 수 없는 규칙(사용자 직접 편집·구 데이터)은 **버리지 않는다**
//   R5 월드라인 상태가 없으면 종전과 **완전히 동일**하다 (fail-open, 하위 호환)
//   R6 리롤(같은 턴에 살아있는 variant)은 제거하지 않는다 — 롤백과 구분한다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_08A = fs.readFileSync(path.join(ROOT, 'src/parts/08a-world-graph.js'), 'utf8');
const SRC_13C = fs.readFileSync(path.join(ROOT, 'src/parts/13c-before-request-injection.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const idx = code.lastIndexOf('\n})();');
if (idx === -1) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found' })); process.exit(1); }
code = code.slice(0, idx) + `
    globalThis.__probe = {
        HierarchicalWorldManager, WorldPromotionBridge, LibraTurnWorldline, LibraDataStorage,
        applyRuleWorldlineFilter: (typeof HierarchicalWorldManager !== 'undefined' && HierarchicalWorldManager)
            ? HierarchicalWorldManager.applyRuleWorldlineFilter : null
    };
` + code.slice(idx);

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const store = new Map();
const mk = () => ({
  _v: '', style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) { this._v = String(v); }, get innerHTML() { return this._v || ''; },
  set textContent(v) { this._v = String(v); }, get textContent() { return this._v || ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
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

let done = false;
const finish = () => {
  if (done) return; done = true;
  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
};

setTimeout(() => {
  const P = ctx.__probe;
  assert('dist_runs_without_error', !runErr, { error: runErr });
  const H = P?.HierarchicalWorldManager;
  const PB = P?.WorldPromotionBridge;
  assert('world_manager_exported', !!H && typeof H.formatForPrompt === 'function',
    { keys: H ? Object.keys(H).slice(0, 26) : null });
  assert('promotion_bridge_exported', !!PB && typeof PB.promote === 'function', { keys: PB ? Object.keys(PB) : null });
  if (!H || !PB) { finish(); return; }

  // ── R1: 승격이 출처 턴을 **노드에** 기록한다 (소스 계약 + 실행) ──
  const marksTurn = /promotedRules/.test(SRC_08A);
  assert('promotion_records_source_turn', marksTurn,
    { note: 'custom 키는 정화기가 재부여하므로 **텍스트로** 매핑해야 한다(08a:848 은 텍스트만 넘겼다)' });

  //   노드를 만들고 승격한다. memoryMeta.turn 이 출처 턴이다.
  const node = H.createNode({ name: '테스트 세계', layer: 'root' });
  const nodeId = node?.id || (H.getProfile()?.rootId) || '';
  assert('node_created', !!nodeId, { nodeId, keys: node ? Object.keys(node).slice(0, 20) : null });
  if (!nodeId) { finish(); return; }

  const promoteAt = (turn, text) => PB.promote({
    nodeId, text, memoryMeta: { turn, imp: 7, canonicalMemoryId: `m${turn}` }
  });

  const r10 = promoteAt(10, '룰: 마법은 존재한다 (살아있는 턴)');
  const r12 = promoteAt(12, '룰: 왕은 죽었다 (롤백된 턴)');
  const r15 = promoteAt(15, '룰: 성문은 닫혔다 (롤백된 턴)');
  assert('promotions_succeeded', [r10, r12, r15].every(r => r?.ok === true),
    { r10: r10?.ok, r12: r12?.ok, r15: r15?.ok, reasons: [r10?.reason, r12?.reason, r15?.reason] });

  //   ★ 노드에 턴이 기록됐는가 (R1 실행 확인)
  const nodeNow = H.getProfile()?.nodes instanceof Map ? H.getProfile().nodes.get(nodeId) : null;
  const promotedRules = nodeNow?.rules?.ruleMeta?.promotedRules || null;
  assert('node_stores_promoted_rule_turns',
    !!promotedRules && Object.keys(promotedRules).length >= 3,
    { promotedRules, note: '텍스트 → 출처 턴 매핑이 노드에 남아야 한다' });

  // ── R2/R3/R6: 월드라인 상태를 주고 프롬프트에서 걸러지는가 (실행) ──
  //   턴 10 = 살아있음(active), 턴 12 = 롤백(orphaned, 살아있는 variant 없음),
  //   턴 15 = 리롤(superseded 이지만 같은 턴에 active variant 가 있음) → **남아야 한다**
  const state = {
    nodes: [
      { turnNodeId: 'n10', logicalTurnId: 'L10', variantId: 'a', pairIndex: 10, status: 'active' },
      { turnNodeId: 'n12a', logicalTurnId: 'L12', variantId: 'a', pairIndex: 12, status: 'orphaned' },
      { turnNodeId: 'n15a', logicalTurnId: 'L15', variantId: 'a', pairIndex: 15, status: 'superseded' },
      { turnNodeId: 'n15b', logicalTurnId: 'L15', variantId: 'b', pairIndex: 15, status: 'active' }
    ],
    headTurnNodeId: 'n15b'
  };

  const plain = H.formatForPrompt();
  assert('prompt_contains_all_rules_without_worldline',
    /마법은 존재한다/.test(plain) && /왕은 죽었다/.test(plain) && /성문은 닫혔다/.test(plain),
    { sample: String(plain).slice(0, 320), note: '월드라인 없이는 종전과 동일하게 전부 들어간다' });

  const filtered = typeof H.formatForPromptWithWorldline === 'function'
    ? H.formatForPromptWithWorldline(state) : null;
  assert('worldline_aware_prompt_exists', typeof filtered === 'string' && filtered.length > 0,
    { type: typeof filtered, note: '게이트가 실행할 수 있는 자리에 판정이 있어야 한다' });

  if (typeof filtered === 'string') {
    // ★ 여기서 **턴 15 를 넣으면 안 된다** — 턴 15 는 리롤(같은 턴에 active variant 있음)이라
    //   남는 게 맞다. 처음에 둘 다 넣어 아래 `rerolled_turn_rule_is_kept` 와 **모순**이었다(자기오류).
    assert('rolled_turn_rule_is_dropped',
      !/왕은 죽었다/.test(filtered),
      { sample: String(filtered).slice(0, 320), note: '롤백으로 잘려나간 턴(12, 살아있는 variant 없음)의 규칙은 빠진다' });
    assert('live_turn_rule_is_kept', /마법은 존재한다/.test(filtered), { sample: String(filtered).slice(0, 320) });
    // ★ R6: 리롤(같은 턴에 살아있는 variant)은 제거하면 안 된다 — 롤백과 구분한다.
    //   위에서 턴 15 는 리롤이다(active variant 있음) → 살아남아야 한다.
    assert('rerolled_turn_rule_is_kept',
      /성문은 닫혔다/.test(filtered),
      { sample: String(filtered).slice(0, 320),
        note: '턴 15 는 리롤(같은 턴에 active variant 있음)이다 — 롤백과 구분해 남긴다' });
  }

  // ── R5: 월드라인 상태가 없으면 완전히 동일 (fail-open) ──
  const noState = typeof H.formatForPromptWithWorldline === 'function' ? H.formatForPromptWithWorldline(null) : null;
  assert('no_worldline_is_identical', noState === plain,
    { identical: noState === plain, note: 'worldline 이 없으면 종전과 바이트 단위로 같아야 한다' });

  // ── R4: 턴을 알 수 없는 규칙은 버리지 않는다 ──
  //   turn 없는 승격(사용자 직접 편집 경로) + 외부 병합으로 들어온 키 없는 규칙
  const rNoTurn = PB.promote({ nodeId, text: '룰: 사용자가 직접 쓴 규칙', memoryMeta: {} });
  const filtered2 = typeof H.formatForPromptWithWorldline === 'function' ? H.formatForPromptWithWorldline(state) : '';
  assert('unstamped_rule_is_kept',
    /사용자가 직접 쓴 규칙/.test(filtered2),
    { ok: rNoTurn?.ok, sample: String(filtered2).slice(0, 340), note: '턴을 모르면 버리지 않는다(정보 손실 방지)' });

  // ── R7: 주입 경로(13c)가 실제로 그 함수를 쓴다 ──
  //   ★ 계층을 나눠 본다: 13c 는 **조회→전달**을, 08a 는 **판정**을 담당한다.
  //     판정만 게이트가 실행하고 배선은 안 보면, 배선이 죽어도 통과한다(#1·#2 에서 겪었다).
  const c13 = (() => {
    const i = SRC_13C.indexOf('const worldPrompt = memorySuppressionPlan.suppressActiveContext');
    return i < 0 ? '' : SRC_13C.slice(i, i + 1100);
  })();
  // ★ 문자열 **존재**만 보면 `if (false && …)` 같은 죽은 가드도 통과한다 — 대조군 M3 이 그 지점을 겨냥했다.
  //   **가드 조건 자체**를 본다(§5-5 에서 같은 함정을 밟았다).
  assert('injection_path_uses_worldline_aware_prompt',
    /if\s*\(\s*worldlineState\s*&&[^)]*formatForPromptWithWorldline/.test(c13)
    && /LibraTurnWorldline\?\.get|LibraTurnWorldline\.get/.test(c13),
    { got: c13.length > 0,
      usesAware: /formatForPromptWithWorldline/.test(c13),
      readsWorldline: /LibraTurnWorldline/.test(c13),
      note: '13c 는 worldlineState 를 조회해 넘긴다 — 판정은 08a 가 한다' });
  assert('injection_path_keeps_fallback',
    /formatForPrompt\)\s*;/.test(c13) || /return HierarchicalWorldManager\.formatForPrompt\(\)/.test(c13),
    { note: '월드라인이 없거나 실패하면 종전 경로로 폴백해야 한다' });

  finish();
}, 250);
