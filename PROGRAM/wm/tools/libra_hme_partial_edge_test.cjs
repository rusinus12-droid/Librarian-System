'use strict';
// Gate: E2 (entity → lore) 의 부분 일치는 **단어 경계**를 인식해야 한다.
//
// 실측된 오탐 (10c:910, 프로브 `libra_hme_partial_edge_probe.cjs` 12턴 표본):
//   if (ek && key && (key.includes(ek) || ek.includes(key))) { partial += 1; … }
//   → 경계를 보지 않아 `세라` ⊂ `세라핌` / `민아` ⊂ `김민아` / `리엘` ⊂ `아리엘` 이 매칭됐다.
//   weight = exact > 0 ? 0.78 : 0.45 이고 `light` 의 edgeWeightMin = 0.28 이라
//   0.45 > 0.28 → **실제 엣지**가 된다.
//   실측: E2 엣지 13건 중 **6건이 `exact:0, partial:1`** (46%) — 전부 부분 문자열만으로 성립.
//
// 계약:
//   P1 경계 없는 substring 은 부분 일치로 인정하지 않는다 (`세라` ⊄ `세라핌`)
//   P2 접미 조사는 부분 일치로 인정한다 (`아리엘은` → 아리엘) — 한국어에서 흔한 형태
//   P3 영문은 단어 경계로 판정한다 (`Art` ⊄ `Arthur`), 구분자로 이어진 경우는 인정 (`Art-Arthur`)
//   P4 완전 일치는 그대로 0.78 이다 (회귀 금지)
//   P5 같은 이름은 자기 자신과 부분 일치하지 않는다
//   P6 진짜 같은 인물의 별칭 일치는 여전히 성립한다 (`아리` ↔ 아리엘 은 **이름 목록**에서 확장된다)
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
  + '\n;globalThis.__PWS_HME__={' + "MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null" + '};'
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

const ME = (ctx.__PWS_HME__ && ctx.__PWS_HME__.MemoryEngine) || {};
const build = ME.buildHmeGraphIndexFromScopeIndexForTest;

assert('dist_runs_without_error', !runErr, { error: runErr });
assert('probe_exported', !!build, { keys: Object.keys(ME).filter(k => /hme|Hme|HME/.test(k)).slice(0, 12) });

if (build) {
  const mkEntity = (name, aliases) => ({
    comment: 'lmai_entity', key: `lmai_entity::${name}`, secondkey: '',
    content: JSON.stringify({
      id: name, name, type: 'character',
      identity: { aliases: aliases || [], summary: `${name} 요약`, roleInStory: '기사' },
      meta: { aliases: aliases || [], hiddenNameKeys: [] }
    })
  });
  const mkRow = (id, turn, subjects) => ({
    id, contentHash: `h_${id}`, primaryKind: 'fact', baseBucket: 'general',
    turn, subjects, aliases: [], entityRoles: { primary: subjects.slice(0, 1), observer: [], mention: [], inferred: [] },
    tags: [], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [],
    narrativeTags: [], importance: 0.6, rollbackState: 'active', stale: false, hiddenFromPrompt: false
  });

  const run = (names) => {
    const lorebook = [
      ...names.map(n => mkEntity(n, [])),
      {
        comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-1', secondkey: '',
        content: JSON.stringify({
          schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-1', cueCount: names.length,
          cues: names.map((n, i) => ({
            id: `cue_${i}`, sourceType: 'character_lorebook', sourceId: n,
            sourceLabel: `Character Lorebook: ${n}`, chunkIndex: 0, buckets: ['world'],
            entityRefs: [n], tags: [n],
            text: `${n} 에 대한 로어 항목이다.`, sourceHash: `h${i}`, priority: 6, updatedAt: 1
          }))
        })
      }
    ];
    const scopeIndex = {
      schema: 'libra.hme.scope_index.v1', scopeKey: 'pws-scope', digest: 'd', rowCount: names.length,
      rows: names.map((n, i) => mkRow(`r${i}`, 10 + i, [n]))
    };
    const m = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
    if (m) scopeIndex.schema = m[1];
    const graph = build(scopeIndex, { scopeKey: 'pws-scope', lorebook, entries: lorebook });
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const nameOf = (id) => {
      const n = byId.get(id);
      const raw = String(n?.name || n?.label || '');
      return raw.replace(/^Character Lorebook:\s*/, '');
    };
    const typeOf = (id) => String(byId.get(id)?.nodeType || '');
    const e2 = edges.filter(e => String(e.relation || '') === 'described_by_lore');
    // entity → lore 쌍만 본다 (부분 일치는 E2 에서만 쓴다)
    const pairs = e2.map(e => {
      const a = String(e.from), b = String(e.to);
      const aEnt = typeOf(a) === 'entity', bEnt = typeOf(b) === 'entity';
      const ent = aEnt ? nameOf(a) : nameOf(b);
      const lor = aEnt ? nameOf(b) : nameOf(a);
      return { ent, lore: lor, weight: e.weight, evidence: (e.evidence || []).slice(0, 4) };
    });
    return { nodes, edges, e2, pairs };
  };
  // 엔티티 이름과 로어 이름을 **분리**해 넣는다 (조사 붙은 로어 이름 검증용).
  const runWithLoreNames = (entityNames, loreNames) => {
    const lorebook = [
      ...entityNames.map(n => mkEntity(n, [])),
      {
        comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-p', secondkey: '',
        content: JSON.stringify({
          schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-p', cueCount: loreNames.length,
          cues: loreNames.map((n, i) => ({
            id: `cue_${i}`, sourceType: 'character_lorebook', sourceId: n,
            sourceLabel: `Character Lorebook: ${n}`, chunkIndex: 0, buckets: ['world'],
            entityRefs: [n], tags: [n],
            text: `${n} 관련 로어`, sourceHash: `hp${i}`, priority: 6, updatedAt: 1
          }))
        })
      }
    ];
    const scopeIndex = {
      schema: 'libra.hme.scope_index.v1', scopeKey: 'pws-p', digest: 'dp', rowCount: entityNames.length,
      rows: entityNames.map((n, i) => mkRow(`rp${i}`, 10 + i, [n]))
    };
    const m2 = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
    if (m2) scopeIndex.schema = m2[1];
    const graph = build(scopeIndex, { scopeKey: 'pws-p', lorebook, entries: lorebook });
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const nameOf = (id) => String(byId.get(id)?.name || byId.get(id)?.label || '').replace(/^Character Lorebook:\s*/, '');
    const typeOf = (id) => String(byId.get(id)?.nodeType || '');
    const e2 = edges.filter(e => String(e.relation || '') === 'described_by_lore');
    const pairs = e2.map(e => {
      const a = String(e.from), b = String(e.to);
      const aEnt = typeOf(a) === 'entity';
      return { ent: aEnt ? nameOf(a) : nameOf(b), lore: aEnt ? nameOf(b) : nameOf(a), weight: e.weight, evidence: (e.evidence || []).slice(0, 4) };
    });
    return { nodes, edges, e2, pairs };
  };

  // ── P1: 경계 없는 substring 은 부분 일치가 아니다 ──
  const boundary = ['민아', '김민아', '아리엘', '리엘', '세라', '세라핌'];
  const r1 = run(boundary);
  const falsePairs = r1.pairs.filter(p => {
    const { ent, lore } = p;
    if (!ent || !lore || ent === lore) return false;
    // 진짜 같은 인물이 아님: 한쪽이 다른 쪽의 부분 문자열인데 서로 다른 이름
    return (ent.includes(lore) || lore.includes(ent));
  });
  assert('boundary_substring_is_not_partial_match', falsePairs.length === 0,
    { false_pairs: falsePairs.map(p => `${p.ent}↔${p.lore}(w=${p.weight})`), note: '세라핌↔세라 같은 쌍이 엣지가 되면 안 된다' });

  // ── P4: 완전 일치는 유지 (자기 로어와 0.78) ──
  const exactPairs = r1.pairs.filter(p => p.ent && p.lore && p.ent === p.lore);
  assert('exact_match_still_works',
    exactPairs.length >= boundary.length && exactPairs.every(p => Number(p.weight) === 0.78),
    { exact: exactPairs.map(p => `${p.ent}=${p.weight}`) });

  // ── P5: 자기 자신과 부분 일치하지 않는다 (exact:0, partial:1 자기쌍 금지) ──
  const selfPartial = r1.pairs.filter(p => {
    if (p.ent !== p.lore) return false;
    const ev = (p.evidence || []).join(' ');
    return /exact:0/.test(ev);
  });
  assert('no_self_partial_match', selfPartial.length === 0, { offenders: selfPartial.length });

  // ── P2: 접미 조사는 인정한다 (아리엘은 → 아리엘) ──
  //   ★ 이 단언은 **픽스처가 있어야** 의미가 있다. 조사 붙은 이름이 표본에 없으면
  //     조사 목록을 비우는 변이(M4)를 게이트가 못 잡는다 — 실제로 그랬다.
  //   로어 쪽 이름에 조사를 붙여 부분 일치 경로를 실제로 태운다.
  const r2 = run(['아리엘', '세라']);
  const evAll = r2.pairs.map(p => (p.evidence || []).join(' ')).join(' | ');
  assert('evidence_reports_partial_counts', /partial:/.test(evAll),
    { sample: evAll.slice(0, 200), note: '증거에 exact/partial 계수가 남아야 진단 가능' });

  const rParticle = runWithLoreNames(['아리엘'], ['아리엘은', '아리엘의', '세라']);
  const particlePairs = rParticle.pairs.filter(p => /아리엘은|아리엘의/.test(String(p.lore)));
  // 실측 사실: 조사는 **앞단(entities 추출)** 에서 이미 정규화된다 (`아리엘은` → `entities:["아리엘"]`).
  //   즉 여기 오는 것은 조사가 붙은 이름이 아니라 **정규화된 이름**이고 `exact:1` 로 연결된다.
  //   단언 이름을 실제 기제에 맞춘다 — 아니면 게이트가 하지 않는 일을 한다고 주장하게 된다.
  assert('particle_stripped_upstream_still_links',
    particlePairs.length > 0 && particlePairs.every(p => Number(p.weight) === 0.78),
    { pairs: particlePairs.map(p => `${p.ent}↔${p.lore}(w=${p.weight})`),
      note: '조사가 붙은 로어 이름은 앞단 정규화를 거쳐 완전 일치(0.78)로 연결된다' });

  // ── P3(배선): 판정이 경계 인식 함수를 실제로 쓴다 ──
  const e2Fn = (() => {
    const i = SRC10C.indexOf('const buildHmeGraphCrossTypeEdges = (nodes = [], context = {}) => {');
    return i < 0 ? '' : SRC10C.slice(i, i + 8000);
  })();
  // 문자열 검사는 **정확히** 겨냥한다 — `/boundary/i` 같은 느슨한 패턴은 주석 단어에 걸려
  //   배선이 죽어 있어도 통과할 수 있다(대조군이 이 지점을 겨냥한다).
  const e2Block = (() => {
    const i = e2Fn.indexOf('// ── E2:');
    const j = e2Fn.indexOf('// ── E3:', i);
    return (i >= 0 && j > i) ? e2Fn.slice(i, j) : '';
  })();
  const inlineIncludes = /\(key\.includes\(ek\)\s*\|\|\s*ek\.includes\(key\)\)/.test(e2Block);
  assert('partial_match_is_boundary_aware',
    e2Block.length > 0 && !inlineIncludes,
    { block_found: e2Block.length > 0, inline_includes_remains: inlineIncludes,
      note: 'E2 안에 인라인 includes 두 개가 그대로 있으면 경계를 못 본다' });

  // ── P6: 별칭 확장은 살아 있다 (진짜 같은 인물) ──
  const aliasLore = [
    mkEntity('아리엘', ['아리']),
    {
      comment: 'lmai_character_lore_cues', key: 'lmai_character_lore_cues::src-9', secondkey: '',
      content: JSON.stringify({
        schema: 'libra.character_lore_cues.v1', version: 1, sourceHash: 'src-9', cueCount: 1,
        cues: [{ id: 'cue_0', sourceType: 'character_lorebook', sourceId: '아리', sourceLabel: 'Character Lorebook: 아리', chunkIndex: 0, buckets: ['world'], entityRefs: ['아리'], tags: [], text: '아리에 대한 로어', sourceHash: 'h0', priority: 6, updatedAt: 1 }]
      })
    }
  ];
  const si = { schema: 'libra.hme.scope_index.v1', scopeKey: 'alias-scope', digest: 'd2', rowCount: 1, rows: [mkRow('r0', 10, ['아리엘'])] };
  const mm = code.match(/const HME_SCOPE_INDEX_SCHEMA = '([^']+)'/);
  if (mm) si.schema = mm[1];
  let aliasGraph = null;
  try { aliasGraph = build(si, { scopeKey: 'alias-scope', lorebook: aliasLore, entries: aliasLore }); } catch (_) {}
  const aliasE2 = (Array.isArray(aliasGraph?.edges) ? aliasGraph.edges : []).filter(e => String(e.relation || '') === 'described_by_lore');
  assert('alias_expansion_still_links', aliasE2.length > 0,
    { edges: aliasE2.length, note: '별칭(아리↔아리엘)은 이름 목록에서 확장되므로 계속 연결돼야 한다' });
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);

})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
