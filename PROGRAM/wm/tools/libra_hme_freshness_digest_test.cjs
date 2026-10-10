'use strict';
// Gate: HME 그래프의 freshness 판정이 **엔티티·로어 변경도 감지**해야 한다 (#6).
//
// 실측된 결함:
//   `10c:1311` 의 `source` 에는 `hmeScopeIndexDigest` **하나만** 있다.
//   그 digest 는 `10d:267` 에서 **기억 row 만** 반영한다:
//     simpleHash(rows.map(row => `${row.id}:${row.contentHash}:${row.rollbackState}:${row.stale}`))
//   → 엔티티(`lmai_entity`)·로어(`lmai_character_lore_cues`)가 바뀌어도 digest 가 같다.
//   → 재구축 판정(`10c:1670`)이 "변경 없음"으로 보고 **E1/E2 엣지가 stale 로 남는다**.
//
// 왜 중요한가: E1(memory→entity)·E2(entity→lore) 엣지의 입력은 **엔티티·로어** 다.
//   기억이 그대로여도 인물이 개명·병합·삭제되면 엣지가 가리키는 대상이 사라진다.
//
// 계약:
//   F1 `source` 가 엔티티 입력을 식별하는 digest 를 갖는다
//   F2 `source` 가 로어 입력을 식별하는 digest 를 갖는다
//   F3 엔티티가 바뀌면 그 digest 가 바뀐다 (실행)
//   F4 로어가 바뀌면 그 digest 가 바뀐다 (실행)
//   F5 기억이 바뀌면 종전 digest 도 바뀐다 (회귀 금지)
//   F6 엔티티·로어가 그대로면 digest 도 그대로다 (불필요 재구축 금지)
//   F7 재사용 판정이 그 digest 들을 **본다** (배선 — source 만 채우고 안 보면 무의미)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC10C = fs.readFileSync(path.join(ROOT, 'src/parts/10c-hme-associative-graph.js'), 'utf8');

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL, code.indexOf('const MemoryEngine = (() => {'));
if (tailAt < 0) { console.log(JSON.stringify({ ok: false, reason: 'scope_tail_not_found' }, null, 2)); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__F6__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null" + '};'
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
(async () => {
let runErr = '';
try { await vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); } catch (e) { runErr = String(e.message).slice(0, 300); }

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

const ME = (ctx.__F6__ && ctx.__F6__.MemoryEngine) || {};
const build = ME.buildHmeGraphIndexFromScopeIndexForTest;

assert('dist_runs_without_error', !runErr, { error: runErr });
assert('probe_exported', !!build, { note: '그래프 빌더가 노출돼야 판정 가능' });

const mkEntity = (name, aliases, summary) => ({
  comment: 'lmai_entity', key: `lmai_entity::${name}`, secondkey: '',
  content: JSON.stringify({
    id: name, name, type: 'character',
    identity: { aliases: aliases || [], summary: summary || `${name} 요약`, roleInStory: '기사' },
    meta: { aliases: aliases || [], hiddenNameKeys: [] }
  })
});
const mkLore = (cues) => ({
  comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-1', secondkey: '',
  content: JSON.stringify({
    schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-1', cueCount: cues.length,
    cues: cues.map((c, i) => ({
      id: `cue_${i}`, sourceType: 'character_lorebook', sourceId: c.entity,
      sourceLabel: `Character Lorebook: ${c.entity}`, chunkIndex: 0, buckets: ['world'],
      entityRefs: [c.entity], tags: [], text: c.text || `${c.entity} 로어`, sourceHash: `h${i}`, priority: 6, updatedAt: 1
    }))
  })
});
const mkRow = (id, turn, subjects) => ({
  id, contentHash: `h_${id}`, primaryKind: 'fact', baseBucket: 'general',
  turn, subjects, aliases: [], entityRoles: { primary: subjects.slice(0, 1), observer: [], mention: [], inferred: [] },
  tags: [], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [], narrativeTags: [],
  importance: 0.6, rollbackState: 'active', stale: false, hiddenFromPrompt: false
});

const buildWith = (lorebook, rows) => {
  const si = { schema: 'libra.hme.scope_index.v1', scopeKey: 'f6-scope', digest: 'digest-base', rowCount: rows.length, rows };
  const m = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
  if (m) si.schema = m[1];
  return build(si, { scopeKey: 'f6-scope', lorebook, entries: lorebook });
};

if (build) {
  const ROWS = [mkRow('r0', 10, ['아리엘']), mkRow('r1', 11, ['세라'])];
  const baseLore = [mkEntity('아리엘'), mkEntity('세라'), mkLore([{ entity: '아리엘' }, { entity: '세라' }])];
  const g = buildWith(baseLore, ROWS);
  const src = g?.source || {};

  // ── F1/F2: source 가 엔티티·로어 식별자를 갖는다 ──
  const entityKeys = Object.keys(src).filter(k => /entity/i.test(k));
  const loreKeys = Object.keys(src).filter(k => /lore/i.test(k));
  assert('source_has_entity_digest', entityKeys.length > 0, { source_keys: Object.keys(src), entity_keys: entityKeys });
  assert('source_has_lore_digest', loreKeys.length > 0, { source_keys: Object.keys(src), lore_keys: loreKeys });

  // ── F3: 엔티티가 바뀌면 digest 가 바뀐다 ──
  const renamedLore = [mkEntity('아리엘', [], '완전히 다른 요약'), mkEntity('세라'), mkLore([{ entity: '아리엘' }, { entity: '세라' }])];
  const g2 = buildWith(renamedLore, ROWS);
  const changedEntity = entityKeys.some(k => String(g2?.source?.[k] || '') !== String(src[k] || ''));
  assert('entity_change_changes_digest', changedEntity,
    { before: entityKeys.map(k => `${k}=${src[k]}`), after: entityKeys.map(k => `${k}=${g2?.source?.[k]}`) });

  // ── F4: 로어가 바뀌면 digest 가 바뀐다 ──
  const changedLore = [mkEntity('아리엘'), mkEntity('세라'), mkLore([{ entity: '아리엘' }, { entity: '세라' }, { entity: '카일' }])];
  const g3 = buildWith(changedLore, ROWS);
  const changedLoreDigest = loreKeys.some(k => String(g3?.source?.[k] || '') !== String(src[k] || ''));
  assert('lore_change_changes_digest', changedLoreDigest,
    { before: loreKeys.map(k => `${k}=${src[k]}`), after: loreKeys.map(k => `${k}=${g3?.source?.[k]}`) });

  // ── F8 (P1): **관계가 바뀌면** relation digest 가 바뀐다 ──
  const relKeys = Object.keys(src).filter(k => /relation/i.test(k));
  assert('source_has_relation_digest_key', relKeys.length > 0, { source_keys: Object.keys(src), relation_keys: relKeys });
  const mkRelation = (a, b, closeness, trust) => ([{
    comment: 'lmai_relation',
    content: JSON.stringify({ entityA: a, entityB: b, metrics: { closeness, trust } })
  }]);
  const withRelation = (rel) => {
    const { execFileSync } = require('child_process');
    return null;   // placeholder — 실제 빌드는 아래 buildWith 를 쓴다
  };
  //   buildWith 가 lore 항목만 받으므로 relation 항목을 섞어 넘긴다.
  const gRelA = buildWith([...baseLore, ...mkRelation('아리엘', '세라', 0.2, 0.3)], ROWS);
  const gRelB = buildWith([...baseLore, ...mkRelation('아리엘', '세라', 0.9, 0.95)], ROWS);
  const relDigestA = String(gRelA?.source?.relationDigest || '');
  const relDigestB = String(gRelB?.source?.relationDigest || '');
  assert('relation_change_changes_digest',
    relDigestA.length > 0 && relDigestA !== relDigestB,
    { a: relDigestA, b: relDigestB,
      note: '★ P1 — relation closeness/trust 만 바뀌어도 E3 edge 가 stale 이면 안 된다' });
  //   관계가 그대로면 digest 도 그대로다 (불필요 재구축 금지)
  const gRelA2 = buildWith([...baseLore, ...mkRelation('아리엘', '세라', 0.2, 0.3)], ROWS);
  assert('unchanged_relation_keeps_digest',
    String(gRelA2?.source?.relationDigest || '') === relDigestA,
    { note: '같은 relation 이면 digest 불변' });

  // ── F5: 기억이 바뀌면 종전 digest 도 바뀐다 (회귀 금지) ──
  const otherRows = [mkRow('r0', 10, ['아리엘']), mkRow('r1', 11, ['세라']), mkRow('r2', 12, ['카일'])];
  const g4 = buildWith(baseLore, otherRows);
  //   scopeIndex.digest 를 바꿔서 판정 (실제 제품은 10d 가 digest 를 다시 계산한다)
  const si2 = { schema: 'libra.hme.scope_index.v1', scopeKey: 'f6-scope', digest: 'digest-changed', rowCount: otherRows.length, rows: otherRows };
  const m2 = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
  if (m2) si2.schema = m2[1];
  const g5 = build(si2, { scopeKey: 'f6-scope', lorebook: baseLore, entries: baseLore });
  assert('memory_change_still_changes_scope_digest',
    String(g5?.source?.hmeScopeIndexDigest || '') !== String(src.hmeScopeIndexDigest || '') ||
    String(g5?.source?.hmeScopeIndexDigest || '') === 'digest-changed',
    { before: src.hmeScopeIndexDigest, after: g5?.source?.hmeScopeIndexDigest });

  // ── F6: 엔티티·로어가 그대로면 digest 도 그대로 ──
  const g6 = buildWith([mkEntity('아리엘'), mkEntity('세라'), mkLore([{ entity: '아리엘' }, { entity: '세라' }])], ROWS);
  const stable = [...entityKeys, ...loreKeys].every(k => String(g6?.source?.[k] || '') === String(src[k] || ''));
  assert('unchanged_inputs_keep_digest', stable,
    { before: entityKeys.concat(loreKeys).map(k => `${k}=${src[k]}`), after: entityKeys.concat(loreKeys).map(k => `${k}=${g6?.source?.[k]}`) });

  // ── F6b: 입력 **순서**가 바뀌어도 digest 는 같다 (불필요 재구축 금지) ──
  //   정렬이 없으면 엔트리 순서만 바뀌어도(예: 로어 재정렬) 재구축이 일어난다.
  const reorderedLore = [mkEntity('세라'), mkEntity('아리엘'), mkLore([{ entity: '세라' }, { entity: '아리엘' }])];
  const g7 = buildWith(reorderedLore, ROWS);
  const orderStable = [...entityKeys, ...loreKeys].every(k => String(g7?.source?.[k] || '') === String(src[k] || ''));
  assert('input_order_does_not_change_digest', orderStable,
    { before: entityKeys.concat(loreKeys).map(k => `${k}=${src[k]}`),
      after: entityKeys.concat(loreKeys).map(k => `${k}=${g7?.source?.[k]}`),
      note: '정렬이 없으면 순서만 바뀌어도 재구축된다' });

  // ── F8: 같은 입력으로 두 번 만들면 digest 가 같다 (결정적 — 가변값 혼입 금지) ──
  const g8 = buildWith([mkEntity('아리엘'), mkEntity('세라'), mkLore([{ entity: '아리엘' }, { entity: '세라' }])], ROWS);
  const deterministic = [...entityKeys, ...loreKeys].every(k => String(g8?.source?.[k] || '') === String(src[k] || ''));
  assert('digest_is_deterministic', deterministic,
    { note: 'Date.now() 같은 가변값이 섞이면 같은 입력에도 매번 재구축된다' });

  // ── F7: 재사용 판정이 crossType digest 를 **실제로 태운다** (배선) ──
  //   source 만 채우고 판정에서 안 보면 stale 엣지가 그대로 남는다. 문자열 존재만 보면
  //   `crossTypeFresh = true` 같은 죽은 배선도 통과한다(대조군 M3 가 그 지점을 겨냥했다).
  const reuseBlock = (() => {
    const i = SRC10C.indexOf('const existing = options.force ? null :');
    return i < 0 ? '' : SRC10C.slice(i, i + 3200);
  })();
  const gatesOnCrossType = /const\s+reusableExisting\s*=\s*crossTypeFresh\s*\?\s*existing\s*:\s*null/.test(reuseBlock);
  const computesFresh = /cachedEntity\s*===\s*hmeGraphInputDigest/.test(reuseBlock)
    && /cachedLore\s*===\s*hmeGraphInputDigest/.test(reuseBlock);
  assert('reuse_check_consumes_cross_type_digests',
    reuseBlock.length > 0 && gatesOnCrossType && computesFresh,
    { block_found: reuseBlock.length > 0, gates_on_cross_type: gatesOnCrossType,
      computes_fresh_digest: computesFresh,
      note: 'digest 를 계산만 하고 재사용 판정에 안 걸면 무의미하다' });

  // ── P1: relation digest — E3(entity→entity)가 `lmai_relation` 을 읽으므로 필요하다 ──
  //   지적: relation 만 바뀌면(graph source 에 relationDigest 부재) E3 edge 가 stale 로 남는다.
  assert('source_has_relation_digest',
    /relationDigest\s*:/.test(SRC10C),
    { note: 'P1 — `lmai_relation` 의 closeness/trust 변경을 감지해야 E3 edge 가 stale 로 안 남는다' });
  assert('digest_function_handles_relation_kind',
    /kind === 'relation'\s*&&\s*comment !== 'lmai_relation'/.test(SRC10C),
    { note: 'digest 함수가 relation 종류를 인식해야 값이 의미를 갖는다' });
  assert('reuse_check_consumes_relation_digest',
    /cachedRelation\s*===\s*hmeGraphInputDigest\([^)]*'relation'\)/.test(reuseBlock)
      || /cachedRelation\s*===\s*hmeGraphInputDigest/.test(reuseBlock),
    { computed: /cachedRelation/.test(reuseBlock), note: '계산만 하고 안 보면 무의미하다' });

  // ── P2: 증분 패치가 **graph nodes** 를 digest 에 넘기지 않는다 ──
  //   `hmeGraphInputDigest` 는 `entry.comment` 를 찾는데 그래프 노드에는 그 필드가 없다
  //   → digest 가 `''` 가 되고 다음 ensure 에서 불일치 → **full rebuild churn**.
  const incrementalBlock = (() => {
    const i = SRC10C.indexOf('incrementallyPatchedAt');
    return i < 0 ? '' : SRC10C.slice(Math.max(0, i - 900), i + 60);
  })();
  assert('incremental_patch_preserves_cross_type_digests',
    incrementalBlock.length > 0
      && !/hmeGraphInputDigest\(nodes/.test(SRC10C)
      && /entityDigest:\s*String\(runtimeExisting/.test(incrementalBlock),
    { block_found: incrementalBlock.length > 0,
      passes_nodes: /hmeGraphInputDigest\(nodes/.test(SRC10C),
      preserves: /entityDigest:\s*String\(runtimeExisting/.test(incrementalBlock),
      note: 'P2 — 그래프 노드에는 `comment` 가 없어 빈 digest 가 된다' });
} else {
  for (const n of ['source_has_entity_digest', 'source_has_lore_digest', 'entity_change_changes_digest',
    'lore_change_changes_digest', 'memory_change_still_changes_scope_digest',
    'unchanged_inputs_keep_digest', 'reuse_check_considers_entity_and_lore_digests']) {
    assert(n, false, { reason: '선행 조건 실패' });
  }
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);

})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
