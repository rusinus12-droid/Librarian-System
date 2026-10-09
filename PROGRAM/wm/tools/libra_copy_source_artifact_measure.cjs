'use strict';
// 도구: **복제 상속(G1) 후 부모 스코프 식별자가 복제본에 남는가** (G4) — JSON 출력.
//
// 정본 원리 (`HAYAKU_Locator_Continuity.js detachNativeChatCopySourceStorageArtifacts`):
//   복사본은 **부모 저장소를 가리키는 산출물**을 남기면 안 된다(청소한다).
//
// 왜 해로운가 — 소비처가 **payload 의 scopeKey 로 엔트리를 찾는다**:
//   `08e:721 getManagedScopedEntryScope` → `payload.scopeKey || … || entry.meta.scopeKey`
//   `08e:753 findManagedScopedEntryIndex` → `exact = scope === normalizedScope` / `legacy = !scope`
//   상속 엔트리는 **부모 스코프**라 `exact` 도 `legacy` 도 아니어서 **-1(못 찾음)** 이 된다.
//
// 사용: node tools/libra_copy_source_artifact_measure.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

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
try { vm.runInContext(code, ctx, { timeout: 30000 }); } catch (e) { console.log(JSON.stringify({ error: String(e.message).slice(0, 200) })); process.exit(1); }

const D = ctx.LibraDataStorage;
const I = ctx.LIBRA_IntegrityMetaManager;

const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant', data: `${prefix} ${Math.floor(i / 2)}`,
  chatId: `${prefix}-m${i}`, isComment: false, disabled: false
}));
const PARENT_ROWS = rows('부모', 8);
const PARENT = { id: 'parent-1', name: '관측소', fmIndex: 0, message: PARENT_ROWS.map(r => ({ ...r })) };
const COPY = { id: 'copy-1', name: '관측소 (Copy)', fmIndex: 0, message: PARENT_ROWS.map(r => ({ ...r })) };
const CHAR = { id: 'c1', name: 'T', chats: [PARENT, COPY] };

//   `08e:721 / 08e:753` 규칙을 그대로 재현한다 (소비처 매칭).
const getManagedScopedEntryScope = (entry) => {
  let parsed = null;
  try { parsed = JSON.parse(entry?.content || '{}'); } catch (_) {}
  const content = String(entry?.content || '');
  //   `[META:{…}]` 접두 형식도 소비처는 payload 로 읽는다 — 여기선 최상위 scopeKey 만 본다.
  return String(parsed?.scopeKey || parsed?.scopeId || parsed?.runtimeScopeId
    || parsed?.engineState?.scopeKey || entry?.scopeKey || entry?.meta?.scopeKey || '').trim();
};
const findManagedScopedEntryIndex = (lorebook, comment, scopeKey) => {
  const want = String(scopeKey || '').trim();
  const matches = [];
  for (let i = 0; i < (Array.isArray(lorebook) ? lorebook.length : 0); i++) {
    const entry = lorebook[i];
    if (String(entry?.comment || '').trim() !== String(comment || '').trim()) continue;
    matches.push({ index: i, scope: getManagedScopedEntryScope(entry) });
  }
  const exact = matches.find(item => item.scope === want);
  if (exact) return exact.index;
  const legacy = matches.find(item => !item.scope);
  return legacy ? legacy.index : -1;
};

(async () => {
  const parentScope = await D.scopeKeyFor(CHAR, PARENT, null);
  const copyScope = await D.scopeKeyFor(CHAR, COPY, null);
  const parentKey = D.storageKeyFor(parentScope);

  const mem = (turn, text) => {
    const meta = { imp: 5, t: turn, ttl: -1, cat: 'system' };
    I.annotateMemoryMeta(meta, text, { domain: 'memory', recordSchema: 'libra.memory.entry.v1', recordId: `m${turn}`, scopeKey: parentScope, turn, source: 'parent' });
    return { key: `mem_${turn}`, comment: 'lmai_memory', content: `[META:${JSON.stringify(meta)}]\n${text}`, mode: 'normal', insertorder: 100, alwaysActive: false };
  };
  const ent = (name) => {
    const rec = { id: `e_${name}`, name, aliases: [], state: { notes: [] }, meta: { created: 1, updated: 2, confidence: 0.7, source: 'parent', m_ids: ['m1'], aliases: [] } };
    I.applyIntegrityMeta(rec, { domain: 'entity', recordSchema: 'libra.entity.entry.v1', recordId: name, scopeKey: parentScope, turn: 2, source: 'parent' });
    return { key: `e_${name}`, comment: 'lmai_entity', content: JSON.stringify(rec), mode: 'normal', insertorder: 100, alwaysActive: false };
  };
  const derived = (comment, payload) => ({ key: `${comment}::parent`, comment, content: JSON.stringify(payload), mode: 'normal', insertorder: 100, alwaysActive: false });

  const parentEntries = [
    mem(1, '부모 기억 1'), mem(2, '부모 기억 2'), mem(3, '부모 기억 3'),
    ent('아린'),
    derived('lmai_integrated_packet_journal', { schema: 'libra.integrated_packet_journal.v1', scopeKey: parentScope, chatId: PARENT.id, records: [{ id: 'p1' }] }),
    derived('lmai_recall_feedback', { schema: 'libra.recall_feedback.v1', scopeKey: parentScope, chatId: PARENT.id, records: [] }),
    derived('lmai_entity_knowledge_vault', { schema: 'libra.entity_knowledge_vault.v1', scopeKey: parentScope, chatId: PARENT.id, entities: {} }),
    //   ★ `engineState.scopeKey` 는 **세 번째 자리**다 — `08e:721 getManagedScopedEntryScope` 가
    //     `payload?.engineState?.scopeKey` 를 읽는다. 픽스처에 없으면 그 분기 변이를 못 잡는다(M3 MISS 실측).
    derived('lmai_time_engine', {
      schema: 'libra.time_engine.v1', chatId: PARENT.id,
      engineState: { scopeKey: parentScope, chatId: PARENT.id, currentTime: 'T1', events: [] }
    })
  ];
  const parentText = JSON.stringify(parentEntries);
  await D.save(CHAR, PARENT, parentEntries);

  //   수리 전후를 같은 도구로 볼 수 있게 **두 시나리오**를 측정한다:
  //     ① 저장소에 부모 식별자가 남아 있는 채로 hydrate (= 종전 경로 재현)
  //     ② hydrate 가 리스코프한 뒤
  //   게이트는 ②만 본다. ①은 종전 결함의 크기를 남기기 위한 참고값이다.
  //   ★ 소비처가 쓰는 **런타임 키**(01c:125 = `MemoryState._activeScopeKey`)를 넘긴다.
  //     01f 내부 형식(`char:…|chat:…|persona:…`)으로 접으면 제품에선 여전히 못 찾는다.
  const runtimeScopeKey = 'character:c1::chat:copy-1';
  const hydrate = await D.hydrate(CHAR, COPY, { runtimeScopeKey, runtimeChatId: COPY.id });
  const childEntries = D.getShadowEntries(copyScope);

  const leaks = [];
  let integrityScopeLeaks = 0;
  for (const e of childEntries) {
    const text = String(e.content || '');
    const fields = [];
    if (text.includes(parentScope)) fields.push('scopeKey');
    if (text.includes(String(PARENT.id))) fields.push('chatId');
    if (fields.length) leaks.push({ key: String(e.key || ''), comment: String(e.comment || ''), fields, where: fields.includes('scopeKey') ? 'parent scopeKey' : 'parent chatId', preview: text.slice(0, 130) });
    //   integrity 스코프만 따로 센다 (G3 계약 확인용).
    const m = /"integrity":\{[^}]*"scopeKey":"([^"]*)"/.exec(text);
    if (m && m[1] === parentScope) integrityScopeLeaks += 1;
  }

  //   소비처 매칭 재현 — 파생 도메인 하나를 골라 `08e:753` 규칙으로 찾아본다.
  const derivedComment = 'lmai_entity_knowledge_vault';
  const consumerIndex = findManagedScopedEntryIndex(childEntries, derivedComment, runtimeScopeKey);
  const consumerMatch = {
    comment: derivedComment, expectedScope: runtimeScopeKey,
    found: consumerIndex >= 0, index: consumerIndex,
    resolvedScope: consumerIndex >= 0 ? getManagedScopedEntryScope(childEntries[consumerIndex]) : null,
    rule: '02e: exact(scope 일치) | legacy(scope 없음) — 부모 스코프는 둘 다 아니다'
  };

  //   본문 보존: 리스코프가 넘어온 기억을 지우지 않았는지 (기억 텍스트가 남아 있는가).
  const contentPreserved = childEntries.some(e => String(e.content || '').includes('부모 기억 1'))
    && childEntries.some(e => String(e.content || '').includes('아린'));

  //   대조군: 부모 엔트리는 부모 스코프를 그대로 갖는가.
  const parentShadow = D.getShadowEntries(parentScope);
  const parentStillParent = parentShadow.some(e => String(e.content || '').includes(parentScope))
    && JSON.stringify(parentShadow) === parentText;

  const childKey = D.storageKeyFor(copyScope);
  const childRaw = store.get(childKey);
  const childStoredScope = (() => { try { return JSON.parse(String(childRaw)).scopeKey; } catch (_) { return null; } })();

  console.log(JSON.stringify({
    ok: true,
    parentScope, copyScope,
    parentEntryCount: parentEntries.length,
    childEntryCount: childEntries.length,
    hydrateSource: hydrate?.source || '',
    runtimeScopeKey,
    leaks, leakCount: leaks.length,
    integrityScopeLeaks,
    consumerMatch,
    contentPreserved,
    parentStillParent,
    storageKeyDistinct: childKey !== parentKey,
    childStoredScope,
    activeScopeIsCopy: D.getActiveScope() === copyScope,
    note: '복제본은 부모 저장소를 가리키는 산출물을 남기지 않는다 — 식별자를 목적 스코프로 접는다.'
  }, null, 2));
  process.exit(0);
})().catch(e => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message), stack: String(e && e.stack || '').split('\n').slice(0, 5) }, null, 2));
  process.exit(1);
});
