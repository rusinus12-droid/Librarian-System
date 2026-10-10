'use strict';
// Gate: 리롤·롤백된 턴의 **엔티티·관계가 저장에 남지 않는다** (§5-5 쓰기 시점 guard).
//
// 실측된 결함:
//   · `08e:497 saveToLorebook` 이 `entityCache` / `relationCache` **전체**를 무조건 기록한다.
//     → 리롤·롤백된 턴에서 만들어진 엔티티·관계도 그대로 저장된다.
//   · 엔티티/관계 저장 경로(`08d`·`08e`·`08h`)에 worldline 검사가 **0곳**.
//   · 반면 엔티티는 `quality.lastUpdatedTurn`·`meta.created/sourceTurn` 을 갖고,
//     관계는 `meta.created`·`relationTimeline.baseline.turn` 을 갖는다 → **턴으로 판정할 수 있다**.
//
// 다른 계층은 이미 필터를 탄다(비대칭):
//   기억 `13c:908 filterSupersededMemories` · RP-LTM `filterSupersededRpItems`(#1) · 세계선 노드.
//   엔티티·관계만 안 탄다.
//
// 계약 (새 축을 만들지 않는다 — 기존 턴 도장과 worldline 상태를 쓴다):
//   W1 저장 직전에 worldline 상태를 본다 (배선)
//   W2 리롤·롤백된 턴에 **생성**된 엔티티는 저장되지 않는다
//   W3 리롤·롤백된 턴에 **생성**된 관계는 저장되지 않는다
//   W4 살아있는 턴의 엔티티·관계는 그대로 저장된다 (과잉 제거 금지)
//   W5 turn 도장이 없는 항목은 버리지 않는다 (정보 손실 방지 — 보수적)
//   W6 worldline 상태가 없으면 종전과 동일 (fail-open, 하위 호환)
(async () => {
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC08E = fs.readFileSync(path.join(ROOT, 'src/parts/08e-entity-prompt-cache-persistence.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const injectAt = code.lastIndexOf('})();');
if (injectAt < 0) throw new Error('portable_factory_closure_tail_not_found');
code = code.slice(0, injectAt)
  + '\n;globalThis.__W5__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,"
  + "LibraTurnWorldline: typeof LibraTurnWorldline !== 'undefined' ? LibraTurnWorldline : null"
  + '};'
  + code.slice(injectAt);

const ctx = {
  console: { log() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
  structuredClone, AbortController, Buffer, TextEncoder, TextDecoder,
  crypto: { randomUUID: () => 'x' },
  fetch: async () => { throw new Error('no network'); },
  process: { env: {} },
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  performance: { now: () => Date.now() },
  document: { getElementById() { return null; }, createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector() { return null; } }; }, head: { appendChild() {} }, body: { appendChild() {} }, querySelector() { return null; } },
  Risuai: {
    apiVersion: '3.0', async getRuntimeInfo() { return { apiVersion: '3.0' }; }, async getArgument() { return undefined; },
    pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
    async getCharacter() { return null; }, async getChat() { return null; }, async getDatabase() { return { selectedPersona: 0, personas: [] }; },
    async registerSetting() {}, async registerButton() {}, async showContainer() {}, async hideContainer() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async onUnload() {}
  }
};
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
try { await vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

assert('dist_runs_without_error', !runErr, { error: runErr });

// ── W1: 저장 경로가 worldline 을 보는가 (배선) ──
const saveBlock = (() => {
  const i = SRC08E.indexOf('const saveToLorebookSync = (char, chat, lorebook) => {');
  if (i < 0) return '';
  // 저장 루프(엔티티·관계)까지 포함해야 배선을 실행 기반으로 볼 수 있다.
  const end = SRC08E.indexOf('const saveToLorebook = async (...args) =>', i);
  return SRC08E.slice(i, end > i ? end : i + 14000);
})();
//   문자열 존재만 보면 `if (false && writeFilter …)` 같은 **죽은 배선**도 통과한다
//   (대조군 M5 가 그 지점을 겨냥했다). 실제로 **쓰이는지**까지 본다.
const consultsWorldline = /LibraTurnWorldline/.test(saveBlock);
const callsWriteFilter = /writeFilter\(\s*liveEntities/.test(saveBlock) && /writeFilter\(\s*liveRelations/.test(saveBlock);
const guardsOnState = /if\s*\(\s*writeFilter\s*&&\s*worldlineState\s*\)/.test(saveBlock);
assert('save_path_consults_worldline',
  saveBlock.length > 0 && consultsWorldline && callsWriteFilter && guardsOnState,
  { block_found: saveBlock.length > 0, consults: consultsWorldline,
    calls_filter: callsWriteFilter, guards_on_state: guardsOnState,
    note: '저장 직전에 worldline 상태를 **실제로** 조회·적용해야 한다' });

// 저장 루프가 제외 목록을 **반영**하는가 (캐시에서 빼고 continue)
// ★ 존재만 보면 `if (false && droppedEntityNames.has(…))` 같은 **죽은 가드**도 통과한다
//   (대조군 M6 이 그 지점을 겨냥했다). **가드 조건 자체**를 본다.
const dropsEntities = /if\s*\(\s*droppedEntityNames\.has\(/.test(saveBlock) && /entityCache\.delete\(name\)/.test(saveBlock);
const dropsRelations = /if\s*\(\s*droppedRelationIds\.has\(/.test(saveBlock) && /relationCache\.delete\(id\)/.test(saveBlock);
assert('save_loop_applies_exclusions', dropsEntities && dropsRelations,
  { drops_entities: dropsEntities, drops_relations: dropsRelations,
    note: '제외 목록을 만들어도 저장 루프에서 안 쓰면 무의미하다' });

// ── W2~W6: 판정 함수를 **실행**해 확인 ──
//   저장 루프 안의 필터는 직접 부를 수 없으므로, 같은 계약을 판정하는 공개 함수를 찾는다.
assert('public_async_save_calls_the_guarded_sync_implementation',
  /const saveToLorebook = async \(\.\.\.args\) => saveToLorebookSync\(\.\.\.args\)/.test(SRC08E));
const WL = (ctx.__W5__ && ctx.__W5__.LibraTurnWorldline) || null;
assert('worldline_exported', !!WL, { keys: WL ? Object.keys(WL).slice(0, 20) : null });

const filterFn = WL && (WL.filterSupersededEntityRecords || WL.filterSupersededWriteRecords || null);
assert('write_filter_exists', typeof filterFn === 'function',
  { type: typeof filterFn, note: '저장 필터가 게이트가 실행할 수 있는 자리에 있어야 한다' });

if (typeof filterFn === 'function') {
  const state = {
    nodes: [
      { turnNodeId: 't10a', logicalTurnId: 'L10', variantId: 'a', pairIndex: 10, status: 'superseded', supersededBy: 't10b' },
      { turnNodeId: 't10b', logicalTurnId: 'L10', variantId: 'b', pairIndex: 10, status: 'active', supersededBy: '' },
      { turnNodeId: 't12a', logicalTurnId: 'L12', variantId: 'a', pairIndex: 12, status: 'orphaned', supersededBy: '' }
    ],
    headTurnNodeId: 't10b'
  };
  const entities = [
    { name: '살아있음', meta: { created: 10, updated: 10, sourceTurn: 10 } },
    { name: '리롤됨', meta: { created: 12, updated: 12, sourceTurn: 12 } },
    { name: '도장없음', meta: {} }
  ];
  const relations = [
    { id: 'r-live', entityA: 'A', entityB: 'B', meta: { created: 10, sourceTurn: 10 } },
    { id: 'r-rolled', entityA: 'C', entityB: 'D', meta: { created: 12, sourceTurn: 12 } }
  ];

  const outE = filterFn(entities, state);
  const keptE = (outE?.items || outE?.entries || []).map(e => e.name);
  assert('rolled_turn_entity_is_dropped', !keptE.includes('리롤됨'),
    { kept: keptE, note: '롤백(orphaned)된 턴에 생성된 엔티티는 저장되면 안 된다' });
  assert('live_turn_entity_is_kept', keptE.includes('살아있음'), { kept: keptE });
  // ★ includes 만 보면 **다른 항목이 사라진 것**을 못 본다(M2 변이가 그 지점을 통과했다).
  //   기대 집합과 **정확히 같은지** 본다.
  assert('unstamped_entity_is_kept',
    keptE.length === 2 && keptE.includes('살아있음') && keptE.includes('도장없음'),
    { kept: keptE, expected: ['살아있음', '도장없음'],
      note: 'turn 을 알 수 없으면 버리지 않는다(보수적) — 집합 전체를 맞춘다' });

  const outR = filterFn(relations, state);
  const keptR = (outR?.items || outR?.entries || []).map(r => r.id);
  assert('rolled_turn_relation_is_dropped', !keptR.includes('r-rolled'), { kept: keptR });
  assert('live_turn_relation_is_kept', keptR.includes('r-live'), { kept: keptR });

  // W6: 상태가 없으면 전부 유지 (두 형태 모두 — null·undefined)
  const noState = filterFn(entities, null);
  const noState2 = filterFn(entities, undefined);
  const keptNo = (noState?.items || noState?.entries || []).length;
  const keptNo2 = (noState2?.items || noState2?.entries || []).length;
  // ★ 개수만 보면 "다른 것이 사라지고 다른 것이 남은" 경우를 못 본다(M3 변이).
  //   이름 집합이 **정확히 전부**인지 본다.
  const keptNoNames = (noState?.items || noState?.entries || []).map(e => e.name).sort();
  const allNames = entities.map(e => e.name).sort();
  assert('no_worldline_keeps_everything',
    keptNo === entities.length && keptNo2 === entities.length
    && JSON.stringify(keptNoNames) === JSON.stringify(allNames),
    { kept_null: keptNo, kept_undefined: keptNo2, names: keptNoNames, expected: allNames,
      note: 'worldline 이 없으면 **이름까지** 종전과 동일해야 한다(fail-open)' });

  // W7: worldline 상태가 **있지만 비어 있으면**(노드 0) 아무것도 버리지 않는다.
  //   상태가 있다고 무조건 거르면, 턴 정보가 아직 없는 초기 턴에서 저장이 사라진다.
  const emptyState = filterFn(entities, { nodes: [], headTurnNodeId: '' });
  const keptEmpty = (emptyState?.items || emptyState?.entries || []).length;
  const keptEmptyNames = (emptyState?.items || emptyState?.entries || []).map(e => e.name).sort();
  assert('empty_worldline_keeps_everything',
    keptEmpty === entities.length && JSON.stringify(keptEmptyNames) === JSON.stringify(allNames),
    { kept: keptEmpty, names: keptEmptyNames, expected: allNames,
      note: 'superseded 집합이 비면 전부 유지 — 상태 유무만 보고 거르면 안 된다' });

  // W8: 도장 없는 항목만 따로 확인 (턴 0 항목이 다른 항목 때문에 끌려가지 않는다)
  const mixed = [
    { name: '도장없음1', meta: {} },
    { name: '도장없음2', meta: { created: 0 } },
    { name: '리롤됨2', meta: { created: 12, sourceTurn: 12 } }
  ];
  const outMixed = filterFn(mixed, state);
  const keptMixed = (outMixed?.items || outMixed?.entries || []).map(e => e.name);
  assert('unstamped_kept_while_rolled_dropped',
    keptMixed.includes('도장없음1') && keptMixed.includes('도장없음2') && !keptMixed.includes('리롤됨2'),
    { kept: keptMixed, note: '도장 없는 항목은 남기고, 롤백된 항목만 버린다' });
} else {
  for (const n of ['rolled_turn_entity_is_dropped', 'live_turn_entity_is_kept', 'unstamped_entity_is_kept',
    'rolled_turn_relation_is_dropped', 'live_turn_relation_is_kept', 'no_worldline_keeps_everything']) {
    assert(n, false, { reason: '필터 함수 없음' });
  }
}

async function verifyActualSavePath() {
  const nodeAssert = require('node:assert/strict');
  const { load } = require('./libra_management_storage_verified_test.cjs');
  const f = await load({ artifact:true, extraExports:'EntityManager,MemoryState,LibraTurnWorldline,IntegrityMetaManager' });
  const a = f.api, chat = { id:'write-worldline-chat', bindedPersona:'persona-a', localLore:[] };
  const char = { id:'write-worldline-char', chatPage:0, chats:[chat] };
  const admission = await a.LibraDataStorage.preparePersonaContext(char, chat);
  nodeAssert.equal(admission.ok, true);
  a.MemoryState._activeScopeKey = admission.runtimeScopeKey;
  a.MemoryState._activeChatId = chat.id;
  a.MemoryState.currentTurn = 13;
  const lore = [], entities = ['Live Archivist','Rolled Archivist','Timeless Archivist','Other Archivist']
    .map(name => a.EntityManager.getOrCreateEntity(name, lore));
  entities[0].meta = { created:10, sourceTurn:10 };
  entities[1].meta = { created:12, sourceTurn:12 };
  entities[2].meta = {}; entities[3].meta = {};
  const liveRelation = a.EntityManager.getOrCreateRelation('Live Archivist','Timeless Archivist',lore);
  const rolledRelation = a.EntityManager.getOrCreateRelation('Live Archivist','Other Archivist',lore);
  liveRelation.meta = { created:10, sourceTurn:10 }; rolledRelation.meta = { created:12, sourceTurn:12 };
  const cacheBefore = JSON.stringify([...a.EntityManager.getEntityCache()]);
  nodeAssert.throws(() => a.EntityManager.saveToLorebookSync({ ...char }, { ...chat }, lore), /entity_persistence_target_unverified/);
  assert('actual_save_rejects_unadmitted_target_before_mutating_lore_or_cache', lore.length === 0
    && JSON.stringify([...a.EntityManager.getEntityCache()]) === cacheBefore && f.writes.length === 0);
  const worldline = { nodes:[
    { turnNodeId:'t10', logicalTurnId:'L10', variantId:'a', pairIndex:10, status:'active' },
    { turnNodeId:'t12', logicalTurnId:'L12', variantId:'a', pairIndex:12, status:'orphaned' }
  ], headTurnNodeId:'t10' };
  const foreignScope = admission.scopeKey.replace('persona:persona-a', 'persona:persona-b');
  await a.LibraTurnWorldline.put(foreignScope, worldline);
  a.EntityManager.saveToLorebookSync(char, chat, lore);
  assert('actual_save_does_not_borrow_another_personas_worldline',
    lore.filter(row => row.comment === 'lmai_entity').length === 4
    && lore.filter(row => row.comment === 'lmai_relation').length === 2);
  await a.LibraTurnWorldline.put(admission.scopeKey, worldline);
  await a.EntityManager.saveToLorebook(char, chat, lore);
  const entityNames = lore.filter(row => row.comment === 'lmai_entity').map(row => JSON.parse(row.content).name);
  const relationIds = lore.filter(row => row.comment === 'lmai_relation').map(row => JSON.parse(row.content).id);
  assert('actual_save_excludes_orphaned_turn_from_existing_lore_and_runtime_cache',
    !entityNames.includes('Rolled Archivist') && !a.EntityManager.getEntityCache().has('Rolled Archivist')
    && !relationIds.includes(rolledRelation.id) && !a.EntityManager.getRelationCache().has(rolledRelation.id),
    { entityNames, relationIds, rolledRelationId:rolledRelation.id });
  assert('actual_save_retains_live_turn_and_unstamped_records_with_admitted_integrity',
    entityNames.length === 3 && ['Live Archivist','Timeless Archivist','Other Archivist'].every(name => entityNames.includes(name))
    && relationIds.length === 1 && relationIds.includes(liveRelation.id)
    && lore.every(row => a.IntegrityMetaManager.validateIntegrityMeta(JSON.parse(row.content), { scopeKey:admission.runtimeScopeKey }).ok),
    { entityNames, relationIds });
  a.EntityManager.saveToLorebookSync(char, chat, lore);
  assert('actual_save_cannot_resurrect_excluded_cached_records',
    lore.filter(row => row.comment === 'lmai_entity').length === 3
    && lore.filter(row => row.comment === 'lmai_relation').length === 1);
}
verifyActualSavePath().catch(error => assert('actual_save_runtime_check_completed', false, { error:error.stack || String(error) }))
  .then(() => {
    const ok = assertions.every(a => a.ok);
    console.log(JSON.stringify({ ok, assertions }, null, 2));
    process.exit(ok ? 0 : 1);
  });

})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
