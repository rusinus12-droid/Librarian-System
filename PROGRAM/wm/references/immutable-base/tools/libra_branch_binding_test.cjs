'use strict';
// Gate: 브랜치 상속 **바인딩**이 크로스플러그인 정본과 같다.
//
// 정본 대조 (`C:\Users\rusin\Desktop\plugins\LIBRA.js` v2.3.144):
//   36112  HOST_WORLDLINE_META_SCHEMA = { worldlineId, scopeKey, parentWorldlineId, forkTurn, forkFingerprint, createdAt }
//   36141  forkTurn: hostLineage.commonPrefixPairs / forkFingerprint: hostLineage.prefixDigest.slice(0,256)
//   37479  storedBinding = `${parentWorldlineId}|${forkTurn}|${forkFingerprint}`
//          if (storedBinding !== expectedBinding) → native_branch_worldline_binding_conflict
//   61122  worldlines.main = { id, parentId, forkTurn, cutoffTurn, active }
//
// 실측 결함 (내 리포, 수리 전):
//   `01f:314` 상속 기록이 `{ version, scopeKey, entryCount, updatedAt, inheritedFrom, entries }` 뿐이었다.
//   → **부모 월드라인이 바뀌어도 알 방법이 없었고**, `01f:278` 은 이미 채워진 스코프를
//     무조건 `already_populated` 로 돌려보내 **잘못된 상속을 그대로 남겼다**.
//
// 이 게이트가 고정하는 계약:
//   C1 메타 계약(정본 스키마)이 있고 6개 필드를 갖는다
//   C2 forkTurn/forkFingerprint 가 lineage 의 commonPrefixPairs/prefixDigest 에서 온다 (새 축 발명 금지)
//   C3 결합 키가 정본과 같은 형태(`parent|forkTurn|fingerprint`)다
//   C4 상속 기록에 hostWorldlineMeta 가 실제로 실린다 (실행)
//   C5 **부모가 바뀌면 충돌을 잡는다** (실행 — rebindRequired) ← 종전엔 조용히 통과했다
//   C6 바인딩이 그대로면 종전대로 통과한다 (과잉 경보 금지)
//   C7 바인딩 정보가 없는 구 저장 데이터는 **막지 않는다** (하위 호환)
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
        LibraHostLineage, LibraDataStorage,
        inheritFromBranch: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage && typeof LibraDataStorage.inheritFromBranch === 'function') ? LibraDataStorage.inheritFromBranch : null,
        readInheritanceMeta: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage && typeof LibraDataStorage.readInheritanceMeta === 'function') ? LibraDataStorage.readInheritanceMeta : null,
        scopeKeyFor: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage) ? LibraDataStorage.scopeKeyFor : null,
        storageKeyFor: (typeof LibraDataStorage !== 'undefined' && LibraDataStorage) ? LibraDataStorage.storageKeyFor : null
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
// 스토리지를 **공유 Map** 으로 둔다 — 상속 기록을 넣고 다시 읽어 검사해야 한다.
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

let P = null;   // ctx.__probe — 픽스처 헬퍼가 쓴다 (콜백에서 채운다)

// ── 네이티브 브랜치 대화 픽스처 ──
//   계보 판정은 `inspect` 가 하고, 실패 사유가 촘촘하다(fork_position_mismatch 등).
//   정확히 맞춰야 하므로 규칙을 그대로 따른다:
//     · 자식 markerIndex 직전 메시지가 forkMessageId 여야 한다
//     · commonPrefixMessages === markerIndex, commonPrefixPairs = 접두의 완성 쌍 수
const P_MESSAGES = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant', data: `부모 ${i}`, chatId: `pm${i}`,
  isComment: false, disabled: false
}));
const PAIR = (a, b) => ([
  { role: 'user', data: `추가 유저 ${a}`, chatId: `pu${a}`, isComment: false, disabled: false },
  { role: 'assistant', data: `추가 어시 ${b}`, chatId: `pa${b}`, isComment: false, disabled: false }
]);
const markerFor = (forkMsgId) => ({ role: 'assistant', data: `{{specialcomment::branchedfrom::parent-1::부모chat::${forkMsgId}::}}`, chatId: 'cm', isComment: true, disabled: true });

//   extraPairs: fork 직전에 끼워 넣을 쌍 (fork 지점을 뒤로 민다)
const mkChild = (suffix, extraPairs = []) => {
  const prefix = [...P_MESSAGES.slice(0, 6).map(m => ({ ...m })), ...extraPairs.map(m => ({ ...m }))];
  const forkMsgId = prefix[prefix.length - 1].chatId;
  return {
    id: `child-${suffix}`, name: 'child', fmIndex: 0,
    message: [
      ...prefix.map(m => ({ ...m })),
      markerFor(forkMsgId),
      ...extraPairs.length
        ? [{ role: 'user', data: '자식 첫 발화', chatId: `cu${suffix}`, isComment: false, disabled: false },
           { role: 'assistant', data: '자식 응답', chatId: `ca${suffix}`, isComment: false, disabled: false }]
        : [{ role: 'user', data: '자식 첫 발화', chatId: 'cm1', isComment: false, disabled: false },
           { role: 'assistant', data: '자식 응답', chatId: 'cm2', isComment: false, disabled: false }]
    ]
  };
};
const mkParent = (extraPairs = []) => ({
  id: 'parent-1', name: '부모chat', fmIndex: 0,
  message: [
    ...P_MESSAGES.slice(0, 6).map(m => ({ ...m })),
    ...extraPairs.map(m => ({ ...m })),
    ...P_MESSAGES.slice(6).map(m => ({ ...m }))
  ]
});
const makeChar = (suffix, extraPairs = []) => ({
  id: 'c1', name: 'T', chats: [mkParent(extraPairs), mkChild(suffix, extraPairs)]
});
//   부모 데이터는 **스토리지**로 심는다 (inheritFromBranch 289-296 경로).
const seedParent = (char, entries) => {
  const parentChat = char.chats[0];
  const ps = P.scopeKeyFor(char, parentChat, null);
  const pk = P.storageKeyFor(ps);
  store.set(pk, JSON.stringify({ version: '1.0', scopeKey: ps, entryCount: entries.length, updatedAt: Date.now(), entries }));
  return pk;
};
const mkEntry = (turn, text) => ({ comment: 'lmai_memory', content: `[META:${JSON.stringify({ turn, imp: 5 })}]\n${text}` });
const PARENT_ENTRIES = [mkEntry(1, 'T1'), mkEntry(2, 'T2'), mkEntry(3, 'T3'), mkEntry(10, 'T10'), mkEntry(99, 'T99')];

let done = false;
const finish = () => {
  if (done) return; done = true;
  const ok = assertions.every(a => a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
};

setTimeout(async () => {
  P = ctx.__probe;
  assert('dist_runs_without_error', !runErr, { error: runErr });
  const HL = P?.LibraHostLineage;
  assert('lineage_exported', !!HL, { keys: HL ? Object.keys(HL).slice(0, 24) : null });
  if (!HL) { finish(); return; }

  // ── C1: 정본 메타 계약 ──
  const meta0 = HL.hostWorldlineMetaOf({ parentChatId: 'p1', commonPrefixPairs: 40, prefixDigest: 'abc' }, 'sc', 111);
  assert('meta_contract_has_canonical_fields',
    ['schema', 'worldlineId', 'scopeKey', 'parentWorldlineId', 'forkTurn', 'forkFingerprint', 'createdAt'].every(k => k in meta0),
    { meta: meta0 });
  assert('meta_schema_matches_canonical_name',
    String(meta0.schema) === String(HL.HOST_WORLDLINE_META_SCHEMA) && /host\.worldline\.meta/i.test(String(meta0.schema)),
    { schema: meta0.schema });

  // ── C2: lineage 에서 온다 (새 축 발명 금지) ──
  assert('fork_turn_comes_from_lineage',
    Number(meta0.forkTurn) === 40 && String(meta0.forkFingerprint) === 'abc' && String(meta0.parentWorldlineId) === 'p1',
    { forkTurn: meta0.forkTurn, fingerprint: meta0.forkFingerprint, parent: meta0.parentWorldlineId });

  // ── C3: 결합 키 형태가 정본과 같다 ──
  const binding0 = HL.hostWorldlineBindingOf(meta0);
  assert('binding_key_shape_matches_canonical',
    binding0 === 'p1|40|abc',
    { binding: binding0, expected: 'p1|40|abc' });
  assert('binding_empty_for_missing_or_foreign_meta',
    HL.hostWorldlineBindingOf(null) === '' && HL.hostWorldlineBindingOf({ schema: 'other', parentWorldlineId: 'x' }) === '',
    { missing: HL.hostWorldlineBindingOf(null) });

  // ── C4: 실제 상속 → 기록에 hostWorldlineMeta 가 실린다 (실행) ──
  const ib = P?.inheritFromBranch;
  assert('inherit_entrypoint_exists', typeof ib === 'function', { type: typeof ib });
  if (typeof ib !== 'function') { finish(); return; }

  const char1 = makeChar('1');
  const child1 = char1.chats[1];
  const pk1 = seedParent(char1, PARENT_ENTRIES);
  const r1 = await ib(char1, child1);
  assert('inheritance_ran', r1?.ok === true && r1?.inherited > 0,
    { result: r1, note: '부모 스토리지에서 흡수 + fork 이전만' });
  assert('fork_cutoff_still_applies', r1?.inherited === 3,
    { inherited: r1?.inherited, note: 'fork=3쌍 → T1,T2,T3 만 (T10/T99 제외)' });

  const scope1 = P.scopeKeyFor(char1, child1, null);
  const stored1 = await P.readInheritanceMeta(scope1);
  assert('inheritance_record_carries_host_worldline_meta',
    !!stored1?.hostWorldlineMeta && String(stored1.hostWorldlineMeta.schema) === String(HL.HOST_WORLDLINE_META_SCHEMA),
    { hostWorldlineMeta: stored1?.hostWorldlineMeta, inheritedFrom: stored1?.inheritedFrom });

  assert('recorded_binding_matches_lineage',
    String(stored1?.hostWorldlineMeta?.parentWorldlineId) === 'parent-1'
    && Number(stored1?.hostWorldlineMeta?.forkTurn) === 3
    && String(stored1?.hostWorldlineMeta?.forkFingerprint || '').length >= 8,
    { meta: stored1?.hostWorldlineMeta, note: 'lineage.parentChatId + commonPrefixPairs(3쌍) + prefixDigest' });

  // ── C5: 부모 월드라인이 **바뀌면** 충돌을 잡는다 (종전엔 조용히 통과) ──
  //   fork 직전에 쌍을 끼워 fork 지점을 뒤로 민다 → binding 이 달라진다.
  const extra = PAIR('x0', 'y0');
  const char2 = makeChar('2', extra);
  const child2 = char2.chats[1];
  //   먼저 **원래** 바인딩으로 상속 기록을 심는다(끼우기 전 상태를 흉내).
  const ps2 = P.scopeKeyFor(char2, child2, null);
  const staleMeta = HL.hostWorldlineMetaOf(
    { parentChatId: 'parent-1', commonPrefixPairs: 3, prefixDigest: 'stale-fingerprint-value' }, ps2, Date.now());
  store.set(P.storageKeyFor(ps2), JSON.stringify({
    version: '1.0', scopeKey: ps2, entryCount: 3, updatedAt: Date.now(),
    inheritedFrom: 'parent-1', hostWorldlineMeta: staleMeta, entries: PARENT_ENTRIES.slice(0, 3)
  }));
  //   ★ 바인딩 검사는 `current.length > 0`(이미 채워진 스코프)에서만 돈다.
  //     스토리지만 심으면 shadow 가 비어 상속 경로를 타므로 **hydrate 로 캐시를 채운다**.
  let hydrated = null;
  try { hydrated = await ctx.LibraDataStorage.hydrate(char2, child2); } catch (e) { hydrated = { __err: String(e.message).slice(0, 160) }; }
  const r2b = await ib(char2, child2);
  assert('parent_change_is_detected_as_conflict',
    r2b?.reason === 'worldline_binding_conflict' && r2b?.rebindRequired === true,
    { result: r2b, hydrated, note: 'fork 지점이 이동했는데 종전엔 already_populated 로 조용히 통과했다' });

  // ── C6: 바인딩이 그대로면 통과 (과잉 경보 금지) ──
  const char3 = makeChar('3');
  const child3 = char3.chats[1];
  seedParent(char3, PARENT_ENTRIES);
  await ib(char3, child3);
  const r3 = await ib(char3, child3);
  assert('unchanged_binding_still_passes',
    r3?.ok === true && r3?.reason === 'already_populated' && r3?.rebindRequired !== true,
    { result: r3 });

  // ── C7: 메타가 없는 구 저장 데이터는 막지 않는다 (하위 호환) ──
  const char4 = makeChar('4');
  const child4 = char4.chats[1];
  seedParent(char4, PARENT_ENTRIES);
  await ib(char4, child4);
  const scope4 = P.scopeKeyFor(char4, child4, null);
  const k4 = P.storageKeyFor(scope4);
  const parsed4 = JSON.parse(String(store.get(k4)));
  delete parsed4.hostWorldlineMeta;          // 구 데이터로 만든다
  store.set(k4, JSON.stringify(parsed4));
  const r4b = await ib(char4, child4);
  assert('legacy_record_without_meta_is_not_blocked',
    r4b?.ok === true && r4b?.reason === 'already_populated' && r4b?.rebindRequired !== true,
    { result: r4b, note: '바인딩 정보가 없으면 막지 않는다 — 구 데이터 보존' });

  // ── C8: 소스 계약 — 기록에 정말 싣는가 (배선이 죽었는지) ──
  assert('source_writes_host_worldline_meta',
    /hostWorldlineMeta:\s*LibraHostLineage\.hostWorldlineMetaOf\(/.test(SRC_01F),
    { note: '게이트가 실행으로 보지만 소스 계약도 함께 본다' });

  finish();
}, 250);
