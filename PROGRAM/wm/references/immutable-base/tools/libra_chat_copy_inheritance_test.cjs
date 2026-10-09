'use strict';
// Gate: **RisuAI 네이티브 채팅 복제**를 감지해 부모 기억을 물려받는다 (감사 G1)
//
// 왜 필요한가 — 네이티브 복제는 **분기 표식을 남기지 않는다**:
//   `01f inspect` 는 표식(`branchedfrom`)이 있어야 `native_branch` 로 본다 → 복제는
//   `independent_chat` 으로 떨어져 **부모 기억을 한 건도 물려받지 못했다**.
//   실측(수리 전, `tools/libra_audit_chat_copy_measure.cjs`): 복제 0건 / 브랜치 3건(대조군).
//
// 정본 규칙 (`HAYAKU_Locator_Continuity.js:11090-11152 inferCopiedChatSource`):
//   ① 후보 메시지가 대상의 **접두**여야 한다 (후보 길이 ≤ 대상 길이, 모든 서명 일치)
//   ② 후보가 **데이터를 가져야** 한다 — 없으면 복제원이 아니다(결정적 필터)
//   ③ 정렬: 메시지 수 desc → 제목 유사도 desc → chatId asc → **최상위 하나만** 채택
//   ※ 새 축을 만들지 않는다 — 기존 `commonPrefix`/`fingerprint`/`countPairs` 재사용.
//
// 고정하는 계약:
//   D1 `inferCopiedChatSource` 가 게이트가 실행할 수 있는 자리에 있다
//   D2 복제를 **찾아낸다** (실행 — 수리 전 0건)
//   D3 복제 채팅이 `hydrate` 로 **기억을 물려받는다** (실행 — 이게 진짜 목적)
//   D4 **무관한 채팅은 복제로 보지 않는다** (과잉 금지)
//   D5 **데이터 없는 후보는 제외**한다 (정본의 결정적 필터)
//   D6 후보가 여럿이면 **메시지가 많은 쪽**을 고른다 (정본 정렬 규칙)
//   D7 복제는 **컷오프 없음** — 스냅샷 전체를 물려받는다 (브랜치와 구분되는 점)
//   D8 **표식이 있으면 표식이 우선**한다 (기존 브랜치 판정 회귀 금지)
//   D9 자기 자신·빈 채팅은 복제로 보지 않는다
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const noop = () => {};
const mk = () => ({
  style: {}, dataset: {}, tagName: 'DIV',
  classList: { toggle: noop, add: noop, remove: noop },
  set innerHTML(v) {}, get innerHTML() { return ''; },
  setAttribute: noop, getAttribute: () => null, appendChild: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => []
});
const document = { createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null, getElementById: () => null, head: mk(), body: mk(), readyState: 'complete', addEventListener: noop };
const store = new Map();
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
assert('runtime_boots', !runErr, { runErr });

const D = ctx.LibraDataStorage || {};
const H = ctx.LibraHostLineage || {};

// ── D1: 게이트가 실행할 수 있는 자리 ──
assert('copy_inference_exported',
  typeof D.inferCopiedChatSource === 'function' && typeof D.inspectWithCopy === 'function'
  && typeof H.inferCopiedChatSource === 'function',
  { viaStorage: typeof D.inferCopiedChatSource, viaLineage: typeof H.inferCopiedChatSource, inspectWithCopy: typeof D.inspectWithCopy });

// ── 픽스처 ──
//   HAYAKU/Flashback 은 `chatId` 로 메시지를 식별한다. 서명이 그것을 포함하므로 고유해야 한다.
const rows = (prefix, count) => Array.from({ length: count }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  data: `${prefix} ${Math.floor(i / 2)}`,
  chatId: `${prefix}-m${i}`,
  isComment: false, disabled: false
}));

const PARENT_ROWS = rows('부모', 12);
const PARENT = { id: 'parent-1', name: '관측소 기록', fmIndex: 0, message: PARENT_ROWS.map(r => ({ ...r })) };
//   네이티브 복제 = 부모와 **완전히 같은** 메시지, 새 chatId, **표식 없음**, 제목에 (Copy)
const COPY = { id: 'copy-1', name: '관측소 기록 (Copy)', fmIndex: 0, message: PARENT_ROWS.map(r => ({ ...r })) };
//   무관한 채팅 — **같은 길이**지만 접두가 다르다.
//   ★ 길이를 같게 두는 게 중요하다: 짧으면 후보 필터(`rows.length > target.length`)에 걸려
//     접두 검사가 아예 실행되지 않고, 그러면 접두 검사를 없애는 변이를 게이트가 못 잡는다.
const UNRELATED = { id: 'other-1', name: '다른 이야기', fmIndex: 0, message: rows('무관', 12) };
//   데이터 없는 후보의 복제 — 부모에 아무 데이터도 없다
const EMPTY_PARENT_ROWS = rows('빈방', 6);
const EMPTY_PARENT = { id: 'empty-1', name: '빈 방', fmIndex: 0, message: EMPTY_PARENT_ROWS.map(r => ({ ...r })) };
const COPY_OF_EMPTY = { id: 'copy-empty-1', name: '빈 방 (Copy)', fmIndex: 0, message: EMPTY_PARENT_ROWS.map(r => ({ ...r })) };
//   브랜치(표식 있음) — 기존 판정이 우선해야 한다
const markerFor = (forkMsgId) => ({ role: 'assistant', data: `{{specialcomment::branchedfrom::parent-1::관측소 기록::${forkMsgId}::}}`, chatId: 'mk', isComment: true, disabled: true });
const BRANCH = {
  id: 'branch-1', name: '분기', fmIndex: 0,
  message: [...PARENT_ROWS.slice(0, 6).map(r => ({ ...r })), markerFor('부모-m5'),
    { role: 'user', data: '분기 발화', chatId: 'b-u1', isComment: false, disabled: false },
    { role: 'assistant', data: '분기 응답', chatId: 'b-a1', isComment: false, disabled: false }]
};
//   후보가 여럿 — 더 긴(많은) 쪽을 골라야 한다
const SHORT_PARENT = { id: 'short-1', name: '관측소 기록', fmIndex: 0, message: PARENT_ROWS.slice(0, 8).map(r => ({ ...r })) };
const COPY_OF_LONGER = { id: 'copy-long-1', name: '관측소 기록 (Copy)', fmIndex: 0, message: PARENT_ROWS.map(r => ({ ...r })) };

const memEntry = (turn, text) => ({
  key: `mem_${turn}`, comment: 'lmai_memory',
  content: `[META:${JSON.stringify({ imp: 5, t: turn, ttl: -1, cat: 'system' })}]\n${text}`,
  mode: 'normal', insertorder: 100, alwaysActive: false
});

(async () => {
  // 장면 A: 부모에 데이터를 심고 복제를 감지한다
  const charA = { id: 'c1', name: 'T', chats: [PARENT, COPY, UNRELATED] };
  const parentScope = await D.scopeKeyFor(charA, PARENT, null);
  await D.save(charA, PARENT, [memEntry(1, '부모 기억 A'), memEntry(2, '부모 기억 B')]);
  assert('fixture_parent_has_data',
    D.getShadowEntries(parentScope).length === 2, { parentScope, count: D.getShadowEntries(parentScope).length });

  // ── D2: 복제를 찾아낸다 (실행) ──
  const inferred = await D.inferCopiedChatSource(charA, COPY);
  assert('native_copy_is_detected',
    inferred?.sourceChatId === 'parent-1' && inferred?.reason === 'risu_native_chat_copy',
    { inferred, note: '★ 수리 전에는 복제를 전혀 못 찾았다(0건)' });

  // ── D3: 복제 채팅이 기억을 물려받는다 (실행 — 진짜 목적) ──
  const copyScope = await D.scopeKeyFor(charA, COPY, null);
  const copyHydrate = await D.hydrate(charA, COPY);
  const copyShadow = D.getShadowEntries(copyScope);
  assert('native_copy_inherits_memories',
    copyShadow.length === 2 && copyHydrate?.source === 'branch_inheritance',
    { hydrate: copyHydrate, count: copyShadow.length,
      note: '★ 수리 전 0건 → 수리 후 부모 기억이 넘어와야 한다' });

  // ── D4: 무관한 채팅은 복제로 보지 않는다 (과잉 금지) ──
  const unrelatedInfo = await D.inspectWithCopy(charA, UNRELATED);
  const unrelatedInfer = await D.inferCopiedChatSource(charA, UNRELATED);
  assert('unrelated_chat_is_not_a_copy',
    unrelatedInfo?.kind === 'independent_chat' && !unrelatedInfer?.sourceChatId,
    { kind: unrelatedInfo?.kind, reason: unrelatedInfer?.reason,
      note: '★ 접두가 다르면 복제가 아니다 — 과잉 상속은 오염이다' });

  // ── D5: 데이터 없는 후보는 제외한다 (정본의 결정적 필터) ──
  const charEmpty = { id: 'c1', name: 'T', chats: [EMPTY_PARENT, COPY_OF_EMPTY] };
  const emptyInfer = await D.inferCopiedChatSource(charEmpty, COPY_OF_EMPTY);
  const emptyHydrate = await D.hydrate(charEmpty, COPY_OF_EMPTY);
  assert('copy_source_without_data_is_rejected',
    !emptyInfer?.sourceChatId && emptyInfer?.reason === 'copy_source_has_no_data'
    && Number(emptyHydrate?.entryCount || 0) === 0,
    { infer: emptyInfer, hydrate: emptyHydrate,
      note: '★ 정본 HAYAKU 도 데이터 보유를 요구한다 — 없으면 복제원이 아니다' });

  // ── D6: 후보가 여럿이면 메시지가 많은 쪽 (정본 정렬 규칙) ──
  const charMulti = { id: 'c1', name: 'T', chats: [SHORT_PARENT, PARENT, COPY_OF_LONGER] };
  await D.save(charMulti, SHORT_PARENT, [memEntry(1, '짧은 부모')]);
  await D.save(charMulti, PARENT, [memEntry(1, '긴 부모 1'), memEntry(2, '긴 부모 2')]);
  const multi = await D.inferCopiedChatSource(charMulti, COPY_OF_LONGER);
  assert('longest_matching_source_is_preferred',
    multi?.sourceChatId === 'parent-1' && multi?.messageCount === 12,
    { inferred: multi, note: '★ 정본은 메시지 수 desc 로 정렬해 최상위를 쓴다' });

  // ── D7: 복제는 컷오프 없음 (스냅샷 전체) ──
  //   부모가 복제 시점보다 **뒤에** 진행했어도, 복제본은 부모의 전체 스냅샷을 받는다
  const charCut = { id: 'c1', name: 'T', chats: [PARENT, COPY] };
  const copyInfo = await D.inspectWithCopy(charCut, COPY);
  assert('copy_inherits_whole_snapshot',
    copyInfo?.kind === 'native_chat_copy'
    && Number(copyInfo.commonPrefixMessages) === PARENT_ROWS.length
    && Number(copyInfo.commonPrefixPairs || 0) === 6,
    { kind: copyInfo?.kind, commonPrefixMessages: copyInfo?.commonPrefixMessages,
      pairs: copyInfo?.commonPrefixPairs,
      note: '★ 브랜치는 fork 컷오프가 있지만 복제는 스냅샷 전체다' });

  // ── D8: 표식이 있으면 표식이 우선한다 (기존 브랜치 판정 회귀 금지) ──
  const charB = { id: 'c1', name: 'T', chats: [PARENT, BRANCH] };
  await D.save(charB, PARENT, [memEntry(1, '부모 기억')]);
  const branchInfo = await D.inspectWithCopy(charB, BRANCH);
  assert('marker_takes_precedence_over_copy_inference',
    branchInfo?.kind === 'native_branch' && branchInfo?.status === 'verified'
    && branchInfo?.inheritanceEligible === true,
    { kind: branchInfo?.kind, status: branchInfo?.status, reason: branchInfo?.reason,
      note: '★ 표식이 있는 브랜치는 복제 추정으로 덮지 않는다' });

  // ── D9: 대상은 **자기 자신을 복제원으로 돌려주지 않는다** (실행) ──
  const selfInfer = await D.inferCopiedChatSource(charA, PARENT);
  assert('target_is_never_its_own_copy_source',
    selfInfer?.sourceChatId !== 'parent-1',
    { sourceChatId: selfInfer?.sourceChatId, reason: selfInfer?.reason,
      note: '대상 자신은 후보에서 제외된다' });
  //   ※ 길이가 **같은** 전사(부모와 복제)는 방향이 본질적으로 모호하다 — 정본(HAYAKU)도
  //     같은 문제를 **데이터 보유 필터**로 푼다(복제본은 아직 자기 원장이 없다).
  //     이 픽스처에서는 D3 가 이미 복제에 데이터를 채웠으므로 복제가 '원본처럼' 보이는 것이
  //     **정상 동작**이다. 그래서 여기서는 단언하지 않고 사실만 기록한다.
  //     복제를 인정하지 **않는** 경우는 D5(데이터 없는 후보)로 고정한다.

  // ── D11: 채팅이 **하나뿐**이면 복제원이 있을 수 없다 (실행) ──
  //   ★ 자기 자신 제외를 없애면, 단일 채팅 문자의 유일한 후보는 **자기 자신**이 되어
  //     무한 자기상속이 된다. 그 지점을 직접 겨냥한다.
  //   ※ 이 문자에 **id 를 주고 데이터를 심어야** 한다 — 안 그러면 데이터 프로브가 스코프를
  //     못 맞춰 `hasData=false` 로 걸러지고, 데이터 필터가 자기 자신 제외를 **가려버린다**
  //     (그래서 첫 실행에서 이 변이가 MISS 였다).
  const soloChar = { id: 'c1', name: 'T', chats: [PARENT] };
  await D.save(soloChar, PARENT, [memEntry(1, '단독 부모')]);
  const soloInfer = await D.inferCopiedChatSource(soloChar, PARENT);
  assert('single_chat_character_has_no_copy_source',
    !soloInfer?.sourceChatId,
    { sourceChatId: soloInfer?.sourceChatId, reason: soloInfer?.reason,
      note: '★ 유일한 후보가 자기 자신이면 복제원이 아니다' });

  // ── D10: 빈 대상은 판정하지 않는다 (실행) ──
  const emptyTarget = { id: 'blank-1', name: '빈', fmIndex: 0, message: [] };
  const emptyTargetInfer = await D.inferCopiedChatSource({ chats: [PARENT, emptyTarget] }, emptyTarget);
  assert('empty_target_is_not_judged',
    !emptyTargetInfer?.sourceChatId && emptyTargetInfer?.reason === 'target_unavailable',
    { reason: emptyTargetInfer?.reason, note: '메시지가 없는 채팅은 복제 판정 대상이 아니다' });

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, passed: assertions.filter(a => a.ok).length, total: assertions.length, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message), stack: String(e && e.stack || '').split('\n').slice(0, 6) }, null, 2));
  process.exit(1);
});
