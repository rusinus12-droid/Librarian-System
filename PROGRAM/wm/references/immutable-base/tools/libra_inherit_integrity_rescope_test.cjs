'use strict';
// Gate: 상속·전환으로 넘어온 기록의 **integrity 스코프를 목적 스코프로 접는다** (감사 G3)
//
// 왜 필요한가 — 같은 교훈이 리포에 이미 두 번 적혀 있었는데 **스토리지 경로만 빠져 있었다**:
//   `04j:257`  "부모 섀도를 그대로 복사하면 부모 스코프 무결성 메타가 남아 검증 실패·중복이 생긴다
//               — 실측: memMax 98→97, 턴 1·2·97 중복"
//   `04j:112`  `_rescopeInheritedIntegrity` — 세션 전환에서 **손으로** 리스코프 (JSON 만, `[META:]` 는 못 다룸)
//   `01f:149`  `normalizeEntries` — **clone 만 하고 리스코프 안 함** ← 결함
//
// 소비처가 실제로 **버린다**:
//   `08e:376`  EntityManager.rebuildCache  → `!integrity.ok` 면 `continue` (엔티티 소실)
//   `08e:459`  repairLegacyFieldMappings   → 동일
//   `08:117`   expectedScope !== actualScope → `scope_mismatch`
//
// 실측 (도구 `libra_audit_inherit_integrity_measure.cjs`):
//   부모 스코프로 찍힌 엔티티를 자식 스코프로 검증 → { ok:false, reason:'scope_mismatch' }
//   scopeKey 만 바꾼 뒤 검증                      → { ok:true }   ← 수리 유효
//   체크섬은 스코프를 보지 않는다(동일 checksum)  → 재계산 부담 없음
//
// 고정하는 계약:
//   C1 `rescopeEntriesIntegrity` 가 게이트가 실행할 수 있는 자리에 있다
//   C2 순수 JSON 기록(엔티티)이 자식 스코프로 접힌다 (실행)
//   C3 `[META:]` 기록(lmai_memory)도 접힌다 (실행) ← 04j 사각지대
//   C4 리스코프 후 소비처 검증이 **통과**한다 (실행 — 이게 진짜 목적)
//   C5 이미 맞는 스코프는 **안 건드린다** (과잉 변경 금지)
//   C6 무결성 메타 없는 레거시는 **안 건드린다** (하위 호환)
//   C7 `hydrate` 가 실제로 배선했다 (실행 — 상속 경로)
//   C8 `04j` 도 공용 함수를 쓴다 (규칙 복제 금지)
//   C9 체크섬이 보존된다 (스코프 변경이 무결성을 깨지 않는다)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_01F = fs.readFileSync(path.join(ROOT, 'src/parts/01f-lore-consolidation.js'), 'utf8');
const SRC_04J = fs.readFileSync(path.join(ROOT, 'src/parts/04j-session-transition.js'), 'utf8');
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
let activeCharacter = { id: 'c1', name: 'T', chats: [] };
let activeChat = { id: 'ch1', msg: [] };
const Risuai = {
  apiVersion: '3.0', getRuntimeInfo: async () => ({}), getArgument: async () => undefined,
  pluginStorage: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => { store.set(k, String(v)); return true; }, removeItem: async (k) => store.delete(k), keys: async () => Array.from(store.keys()) },
  getLocalPluginStorage: async () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
  getCharacter: async () => activeCharacter, getChatFromIndex: async () => activeChat,
  getDatabase: async () => ({ personas: [] }), registerSetting: async () => {}, showContainer: async () => {}, hideContainer: async () => {},
  addRisuScriptHandler: noop, onUnload: noop
};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise, Set, Map, TextEncoder, TextDecoder,
  globalThis: null, window: null, document, Risuai, risuai: Risuai, structuredClone: global.structuredClone,
  fetch: async () => { throw new Error('no'); }, AbortController, performance: { now: () => Date.now() }
};
const contextSeed = { ...ctx };
const close = code.lastIndexOf('})();');
const testCode = code.slice(0, close) + 'globalThis.__rescopeTest = { EntityManager, MemoryState, getChatRuntimeScopeKey };' + code.slice(close);
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
let runErr = '';
let runtimeReady;
try { runtimeReady = vm.runInContext(testCode, ctx, { timeout: 30000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }
assert('runtime_boots', !runErr, { runErr });

const D = ctx.LibraDataStorage || {};
const I = ctx.LIBRA_IntegrityMetaManager || null;
const PARENT = 'char:c1|chat:parent-1|persona:default';
const CHILD = 'char:c1|chat:branch-1|persona:default';

// ── C1: 게이트가 실행할 수 있는 자리 ──
assert('rescope_helpers_exported',
  typeof D.rescopeEntriesIntegrity === 'function' && typeof D.rescopeRecordIntegrity === 'function',
  { entries: typeof D.rescopeEntriesIntegrity, record: typeof D.rescopeRecordIntegrity });
assert('integrity_api_available', !!I && typeof I.validateIntegrityMeta === 'function');

// ── 픽스처 빌더 ──
//   엔티티(순수 JSON) — 부모 스코프로 찍는다
const mkEntityEntry = (name, scopeKey) => {
  const record = { id: `e_${name}`, name, aliases: [], state: { notes: ['부모 단서'] }, meta: { created: 1, updated: 2, confidence: 0.7, source: 'parent', m_ids: ['m1'], aliases: [] } };
  I.applyIntegrityMeta(record, { domain: 'entity', recordSchema: 'libra.entity.entry.v1', recordId: name, scopeKey, turn: 3, source: 'parent' });
  return { key: `e_${name}`, comment: 'lmai_entity', content: JSON.stringify(record), mode: 'normal', insertorder: 100, alwaysActive: false };
};
//   기억(`[META:]` 접두) — 부모 스코프로 찍는다
const mkMemoryEntry = (turn, text, scopeKey) => {
  const meta = { imp: 5, t: turn, ttl: -1, cat: 'system' };
  I.annotateMemoryMeta(meta, text, { domain: 'memory', recordSchema: 'libra.memory.entry.v1', recordId: `m${turn}`, scopeKey, turn, source: 'parent' });
  return { key: `mem_${turn}`, comment: 'lmai_memory', content: `[META:${JSON.stringify(meta)}]\n${text}`, mode: 'normal', insertorder: 100, alwaysActive: false };
};
//   레거시 — 무결성 메타 없음
const mkLegacyEntry = (name) => ({
  key: `legacy_${name}`, comment: 'lmai_entity',
  content: JSON.stringify({ id: `e_${name}`, name, aliases: [], state: { notes: [] }, meta: { created: 0, updated: 0, confidence: 0.5, source: '' } }),
  mode: 'normal', insertorder: 100, alwaysActive: false
});

const readEntityScope = (entry) => { try { return String(JSON.parse(entry.content)?.meta?.integrity?.scopeKey || ''); } catch (_) { return ''; } };
const readMemoryScope = (entry) => {
  const content = String(entry.content || ''); const end = content.indexOf('\n');
  const line = content.slice(0, end);
  try { return String(JSON.parse(line.slice(6, line.endsWith(']') ? -1 : undefined))?.integrity?.scopeKey || ''); } catch (_) { return ''; }
};

// ── C2: 순수 JSON 이 자식 스코프로 접힌다 (실행) ──
const entityIn = mkEntityEntry('아린', PARENT);
const memIn = mkMemoryEntry(2, '부모 기억', PARENT);
const legacyIn = mkLegacyEntry('유물');
const list = [entityIn, memIn, legacyIn];
const beforeScopeEntity = readEntityScope(entityIn);

const r = D.rescopeEntriesIntegrity(list, CHILD);
const outEntity = r.entries[0]; const outMem = r.entries[1]; const outLegacy = r.entries[2];
assert('json_record_rescoped',
  outEntity && readEntityScope(outEntity) === CHILD && beforeScopeEntity === PARENT,
  { before: beforeScopeEntity, after: readEntityScope(outEntity), note: '순수 JSON 엔티티가 자식 스코프로 접혀야 한다' });

// ── C3: `[META:]` 도 접힌다 (실행) ← 04j 가 건너뛰던 형식 ──
assert('meta_prefix_rescoped',
  outMem && readMemoryScope(outMem) === CHILD,
  { after: readMemoryScope(outMem), body: String(outMem && outMem.content || '').slice(0, 60),
    note: '★ `[META:]` 접두 형식이 04j 의 JSON.parse 로는 건너뛰어졌다' });
assert('meta_prefix_body_preserved',
  outMem && String(outMem.content || '').includes('부모 기억'),
  { content: String(outMem && outMem.content || '').slice(0, 80), note: '리스코프가 본문을 잃으면 안 된다' });

// ── C4: 리스코프 후 소비처 검증이 통과한다 (실행 — 이게 진짜 목적) ──
//   08e:376 이 하는 것과 같은 호출. 리스코프 **전**에는 실패해야 한다.
const rawValidate = I.validateIntegrityMeta(JSON.parse(JSON.stringify(JSON.parse(entityIn.content))), { domain: 'entity', recordId: '아린', scopeKey: CHILD });
const fixedValidate = I.validateIntegrityMeta(JSON.parse(outEntity.content), { domain: 'entity', recordId: '아린', scopeKey: CHILD });
assert('consumer_validation_recovers',
  rawValidate.ok === false && rawValidate.reason === 'scope_mismatch' && fixedValidate.ok === true,
  { before: rawValidate.reason, after: fixedValidate.reason,
    note: '★ 리스코프 전에는 버려지고(scope_mismatch), 후에는 통과해야 한다' });

// ── C5: 이미 맞는 스코프는 안 건드린다 (과잉 변경 금지) ──
const alreadyChild = mkEntityEntry('이미맞음', CHILD);
const beforeExact = String(alreadyChild.content);
const r2 = D.rescopeEntriesIntegrity([alreadyChild], CHILD);
assert('already_correct_untouched',
  r2.changed === 0 && String(r2.entries[0].content) === beforeExact,
  { changed: r2.changed, note: '같은 스코프면 손대지 않는다 (불필요한 쓰기 금지)' });

// ── C6: 무결성 메타 없는 레거시는 안 건드린다 (하위 호환) ──
assert('legacy_untouched',
  String(outLegacy && outLegacy.content || '') === String(legacyIn.content),
  { note: '무결성 메타가 없으면 그대로 둔다 (레거시 보존)' });

(async () => {
  await runtimeReady;
  const initDeadline = Date.now() + 5000;
  while (!ctx.__rescopeTest.MemoryState.isInitialized && Date.now() < initDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert('runtime_initialization_settles', ctx.__rescopeTest.MemoryState.isInitialized === true);
  // ── C7: `hydrate` 는 **일부러** 리스코프하지 않는다 (실행 + 회귀 방지) ──
  //   ★ 실측으로 알게 된 것:
  //     01f 의 스코프 키(`scopeKeyFor` = `char:…|chat:…|persona:…`)는 소비처가 검증에 쓰는 키
  //     (`getChatRuntimeScopeKey` = `character:…::chat:…`, 01a)와 **형식이 다르다**.
  //     01f 는 01a 헬퍼에 접근할 수 없다(IIFE 경계). 여기서 01f 형식을 찍으면
  //     **맞는 기록을 깨뜨린다** — 실측: 97턴 `transition_destination_continues_accumulating`
  //     (narrativeTurnLog 상속 9 → 계속 1) 회귀. A/B 로 HEAD 37/37 vs 변경 36/37 확인.
  //     올바른 키를 가진 `04j`(세션 전환)가 공용 헬퍼로 접는다(C8).
  const CHILD_CHAT = { id: 'branch-1', name: '자식', fmIndex: 0, message: [] };
  const CHILD_CHAR = { id: 'c1', name: 'T', chats: [CHILD_CHAT] };
  const storageKey = D.storageKeyFor(CHILD);
  store.set(storageKey, JSON.stringify({
    version: '1.0', scopeKey: CHILD, entryCount: 2, updatedAt: Date.now(),
    entries: [mkEntityEntry('상속아린', PARENT), mkMemoryEntry(3, '상속 기억', PARENT)]
  }));

  const foreignRawBefore = store.get(storageKey);
  const hydrateResult = await D.hydrate(CHILD_CHAR, CHILD_CHAT);
  const shadowNow = D.getShadowEntries(CHILD);
  assert('hydrate_rejects_foreign_records_without_lineage',
    hydrateResult?.ok === false && hydrateResult.reason === 'canonical_provenance_unverified'
    && shadowNow.length === 0 && D.getHydrationDiagnostics(CHILD).readOnly,
    { result: hydrateResult, count: shadowNow.length });
  assert('hydrate_does_not_write_local_lore',
    store.get(storageKey) === foreignRawBefore,
    { note: 'Ordinary hydration preserves the original foreign signature in durable storage.' });

  // ── C8: 04j 도 공용 함수를 쓴다 (규칙 복제 금지) ──
  assert('transition_uses_shared_helper',
    /const shared = LibraDataStorage\?\.rescopeEntriesIntegrity\?\.\(inheritedLore, newScopeKey, newChat\?\.id \|\| ''\);/.test(SRC_04J),
    { note: '세션 전환의 `[META:]` 사각지대를 공용 함수로 덮는다' });

  // ── C9: 체크섬 보존 (스코프 변경이 무결성을 깨지 않는다) ──
  const entityInAgain = mkEntityEntry('체크섬', PARENT);
  const csBefore = JSON.parse(entityInAgain.content).meta.integrity.checksum;
  const r3 = D.rescopeEntriesIntegrity([entityInAgain], CHILD);
  const csAfter = JSON.parse(r3.entries[0].content).meta.integrity.checksum;
  const csValidate = I.validateIntegrityMeta(JSON.parse(r3.entries[0].content), { domain: 'entity', recordId: '체크섬', scopeKey: CHILD });
  assert('checksum_preserved',
    csBefore === csAfter && csValidate.ok === true,
    { before: String(csBefore).slice(0, 12), after: String(csAfter).slice(0, 12), validate: csValidate.reason,
      note: '체크섬은 meta.integrity 를 제외하고 계산된다 — 전체 레코드를 넘겨야 보존된다' });

  // A payload-only repair must keep a previously valid integrity stamp valid.
  const E = ctx.__rescopeTest.EntityManager;
  const storedChat = { id: 'stored-child', name: 'Stored child', message: [], localLore: [{ key: 'custom', comment: 'custom', content: 'preserve local lore' }] };
  const storedChar = { id: 'c1', name: 'T', chats: [storedChat], chatPage: 0 };
  const runtimeScope = ctx.__rescopeTest.getChatRuntimeScopeKey(storedChat, storedChar);
  const storageScope = await D.scopeKeyFor(storedChar, storedChat, null);
  const record = E.normalizeEntityRecord({ id: 'e_Arin', name: 'Arin', scopeKey: PARENT, chatId: 'parent-1', state: { notes: ['durable clue'] }, meta: { created: 1, updated: 2 } });
  I.applyIntegrityMeta(record, { domain: 'entity', recordSchema: 'libra.entity.entry.v1', recordId: 'Arin', scopeKey: runtimeScope, turn: 2, source: 'test' });
  const storedEntry = { key: 'e_Arin', comment: 'lmai_entity', content: JSON.stringify(record), mode: 'normal', insertorder: 100, alwaysActive: false };
  const payloadOnly = D.rescopeEntriesIntegrity([storedEntry], runtimeScope, storedChat.id);
  const repaired = JSON.parse(payloadOnly.entries[0].content);
  const repairedValidation = I.validateIntegrityMeta(repaired, { domain: 'entity', scopeKey: runtimeScope });
  ctx.__rescopeTest.MemoryState._activeScopeKey = runtimeScope;
  E.rebuildCache(payloadOnly.entries);
  assert('payload_only_rescope_preserves_consumer_validation',
    I.validateIntegrityMeta(record, { domain: 'entity', scopeKey: runtimeScope }).ok
    && payloadOnly.changed === 1 && repairedValidation.ok && E.getEntityCache().size === 1
    && repaired.scopeKey === runtimeScope && repaired.chatId === storedChat.id,
    { reason: repairedValidation.reason, cacheCount: E.getEntityCache().size });

  // Save to the real storage API, then boot a fresh VM through production initialization.
  const saved = await D.save(storedChar, storedChat, [storedEntry]);
  const localLoreBefore = JSON.stringify(storedChat.localLore);
  const rawBefore = store.get(D.storageKeyFor(storageScope));
  activeCharacter = storedChar; activeChat = storedChat;
  const boot = async () => {
    const fresh = { ...contextSeed }; fresh.globalThis = fresh; fresh.window = fresh;
    vm.createContext(fresh);
    await vm.runInContext(testCode, fresh, { timeout: 30000 });
    const deadline = Date.now() + 5000;
    while (!fresh.__rescopeTest.MemoryState.isInitialized && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert('fresh_runtime_initialization_settles', fresh.__rescopeTest.MemoryState.isInitialized === true);
    return fresh;
  };
  const firstBoot = await boot();
  const loaded = firstBoot.LibraDataStorage.getShadowEntries(storageScope);
  const loadedRecord = loaded[0] ? JSON.parse(loaded[0].content) : null;
  assert('stored_conflicting_payload_is_readonly_on_fresh_boot',
    saved.ok && loaded.length === 0 && firstBoot.__rescopeTest.EntityManager.getEntityCache().size === 0
    && firstBoot.LibraDataStorage.getHydrationDiagnostics(storageScope).readOnly,
    { count: loaded.length, cacheCount: firstBoot.__rescopeTest.EntityManager.getEntityCache().size });
  assert('storage_hydrate_preserves_persistent_data_and_local_lore',
    store.get(D.storageKeyFor(storageScope)) === rawBefore && JSON.stringify(storedChat.localLore) === localLoreBefore);
  const hydrateAgain = await firstBoot.LibraDataStorage.hydrate(storedChar, storedChat, { runtimeScopeKey: runtimeScope, runtimeChatId: storedChat.id });
  assert('stored_conflict_hydrate_reports_readonly', !hydrateAgain.ok && hydrateAgain.reason === 'canonical_provenance_unverified', { hydrateAgain });
  const resaved = await firstBoot.LibraDataStorage.save(storedChar, storedChat, loaded);
  const secondBoot = await boot();
  assert('readonly_scope_cannot_erase_rejected_data_on_save',
    !resaved.ok && store.get(D.storageKeyFor(storageScope)) === rawBefore
    && secondBoot.LibraDataStorage.getShadowEntries(storageScope).length === 0
    && secondBoot.__rescopeTest.EntityManager.getEntityCache().size === 0);

  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, passed: assertions.filter(a => a.ok).length, total: assertions.length, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})();
