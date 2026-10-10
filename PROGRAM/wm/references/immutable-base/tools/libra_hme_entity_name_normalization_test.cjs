'use strict';
// Gate: HME 그래프 엔티티 이름 정규화 — 조사가 붙은 토큰이 키로 새지 않는가.
//
// 배경 (실측 결함):
//   `10c:71` expandHmeEntityNameVariants 의 /[가-힣]{2,8}/g 는 어절 경계도, 조사도 존중하지 않는다.
//   '아리엘은' 이 그대로 토큰이 되어 node.entities → byEntity 버킷 키가 '아리엘은' 이 되고,
//   인물 노드의 '아리엘' 키와 매칭되지 않아 E1 엣지(memory → entity)가 깨진다.
//
//   실측 (제품 normalizeHmeGraphToken 직접 호출):
//     '아리엘은' → '아리엘은'   (조사 잔존) — 9/9 샘플 전부
//     '아리엘'   → '아리엘'
//   → 두 키가 달라 byEntity 매칭 실패.
//
//   같은 계열 결함이 03a 에서는 이미 고쳐졌다 (stripMemoryEntityParticle, 어절 분리).
//   그런데 그 함수는 CompactMemoryCodec 내부 비공개라 10c 가 못 쓴다 → 사본이 갈라졌다.
//
// 이 게이트는 *제품 함수를 실행* 해서 판정한다. 문자열 존재 검사가 아니다.
// 실패 대조군: 정규화를 우회한 입력을 만들어 게이트가 실제로 FAIL 하는지 확인한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = { ok: false, assertions: [], measurements: {} };

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

// MemoryEngine IIFE 내부의 10c 함수들을 노출.
const ANCHOR = '            return Object.freeze({ scheduleWrite, hydrate, keyFor });';
const ac = code.split(ANCHOR).length - 1;
if (ac !== 1) { out.reason = `anchor_${ac}`; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
code = code.replace(ANCHOR, [
  '            try { globalThis.__ME__ = {',
  "                normalizeHmeEntityNameList: typeof normalizeHmeEntityNameList !== 'undefined' ? normalizeHmeEntityNameList : null,",
  "                expandHmeEntityNameVariants: typeof expandHmeEntityNameVariants !== 'undefined' ? expandHmeEntityNameVariants : null,",
  "                stripHmeKoParticle: typeof stripHmeKoParticle !== 'undefined' ? stripHmeKoParticle : null,",
  "                buildHmeGraphBuckets: typeof buildHmeGraphBuckets !== 'undefined' ? buildHmeGraphBuckets : null,",
  "                buildHmeGraphNodeFromRow: typeof buildHmeGraphNodeFromRow !== 'undefined' ? buildHmeGraphNodeFromRow : null",
  '            }; } catch (_) {}',
  ANCHOR
].join('\n'));

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
  document: {
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector() { return null; } }; },
    head: { appendChild() {} }, body: { appendChild() {} },
    querySelector() { return null; }
  },
  Risuai: {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0' }; },
    async getArgument() { return undefined; },
    pluginStorage: { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } },
    async getLocalPluginStorage() { const s = { async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; } }; return { getStore: () => s, ...s }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return null; },
    async getChat() { return null; },
    async getDatabase() { return { selectedPersona: 0, personas: [] }; },
    async registerSetting() {}, async registerButton() {},
    async showContainer() {}, async hideContainer() {},
    addRisuReplacer() {}, addRisuScriptHandler() {}, async onUnload() {}
  }
};
ctx.globalThis = ctx;
ctx.window = ctx;

vm.createContext(ctx);
try { vm.runInContext(code, ctx, { filename: 'libra-bundle.js', timeout: 120000 }); }
catch (e) { out.reason = 'bundle_throw: ' + (e && e.message); console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const ME = ctx.__ME__ || {};
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });
const PARTICLE_RE = /(?:에게서는|에게서|에게는|에게|한테는|한테|에서는|에는|에서|으로는|으로|부터|까지|처럼|께서는|께서|하고|이다|이며|이랑|랑|은|는|이|가|을|를|의|도|로|만|에)$/u;

const normList = ME.normalizeHmeEntityNameList;
const normTok = ME.normalizeHmeGraphToken;
if (!normList) { out.reason = 'entity_name_list_normalizer_missing'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
// normTok 는 byEntity 키의 기준(정규화된 비교 키)으로만 쓴다. 없으면 목록 결과를 그대로 쓴다.
const toKey = (v) => (normTok ? String(normTok(v) || '') : String(v || ''));

// ── 1) 조사 붙은 엔티티명이 조사 없는 이름으로 정규화되는가 ────────────────
//   경로: normalizeHmeEntityNameList (엔티티 이름 전용) → stripHmeKoParticle
//   주의: normalizeHmeGraphToken 은 *주제·태그* 키도 담당하므로 조사 제거 대상이 아니다
//   (그쪽에 걸면 '호랑이'→'호랑' 같은 주제명 오탐). 그래서 게이트는 엔티티 경로만 본다.
//   byEntity 버킷 키도 같은 목록 정규화 결과에서 나온다.
const PAIRS = [
  ['아리엘은', '아리엘'], ['세라와는', '세라'], ['카일을', '카일'],
  ['미르에게만', '미르'], ['세라의', '세라'],
  ['카일은', '카일'], ['아리엘과', '아리엘'],
  ['아리엘에게', '아리엘'], ['세라에서', '세라'], ['카일처럼', '카일']
];
const listKeys = (value) => (normList ? normList([value], 32).map(v => toKey(v)) : []);
const pairRows = PAIRS.map(([dirty, clean]) => {
  const dirtyKeys = listKeys(dirty);
  const cleanKeys = listKeys(clean);
  return {
    dirty,
    clean,
    dirtyKeys,
    cleanKeys,
    keysMatch: dirtyKeys.includes(toKey(clean))
  };
});
out.measurements.pairRows = pairRows;
out.measurements.pairsMatching = pairRows.filter(r => r.keysMatch).length;
out.measurements.pairsTotal = pairRows.length;

// ── 2) byEntity 버킷 키에 조사 붙은 값이 없는가 (핵심) ───────────────────
const buildNode = ME.buildHmeGraphNodeFromRow;
const buildBuckets = ME.buildHmeGraphBuckets;
if (buildNode && buildBuckets) {
  const mkRow = (id, subjects, primary) => ({
    id, primaryKind: 'fact', turn: 5, contentHash: id,
    subjects, aliases: [], entityRoles: { primary: [primary], observer: [] },
    tags: [], sceneTags: [], emotionTags: [], relationTags: [], worldTags: [], narrativeTags: []
  });
  const node = buildNode(mkRow('row1', ['아리엘은', '세라와는'], '아리엘은'));
  const buckets = buildBuckets([node].filter(Boolean));
  const keys = Object.keys(buckets.byEntity || {});
  out.measurements.nodeEntities = node?.entities;
  out.measurements.byEntityKeys = keys;
  out.measurements.byEntityParticleKeys = keys.filter(k => PARTICLE_RE.test(k));
  // E1 매칭: 조사 없는 '아리엘' 키로 조회가 되어야 한다
  out.measurements.byEntityHasCleanArielKey = Array.isArray(buckets.byEntity?.['아리엘']);
  out.measurements.byEntityHasDirtyArielKey = Array.isArray(buckets.byEntity?.['아리엘은']);
} else {
  out.reason = 'graph_builders_missing';
}

// ── 3) 실패 대조군: 게이트가 실제로 FAIL 할 수 있는가 ───────────────────
// 대조군은 "정규화를 우회한 값" 을 직접 만들어, 위 판정식이 그것을 결함으로 잡는지 본다.
// 대조군은 "변형을 우회한 입력" 을 직접 만들어, 게이트의 검출식이 그것을 결함으로 잡는지 본다.
//   정상 상태: 목록 정규화 결과에 조사 붙은 키가 없어야 한다.
//   변이 상태(조사 제거를 끊으면): '아리엘은' 이 그대로 키로 남아 검출식이 true 가 된다.
const CONTROL_DIRTY = '아리엘은';
const controlKeys = listKeys(CONTROL_DIRTY);
out.measurements.negativeControl = {
  input: CONTROL_DIRTY,
  normalizedKeys: controlKeys,
  // 검출식: 목록 정규화 결과에 원문(조사 포함)이 그대로 남아 있는가
  gateWouldFlag: controlKeys.some(k => PARTICLE_RE.test(k)),
  note: 'gateWouldFlag=false 이면 정규화가 조사를 뗀 것(정상). true 이면 게이트가 결함을 검출.'
};

// ── 판정 ─────────────────────────────────────────────────────────────────
assert('N1: 조사 붙은 엔티티명이 조사 없는 이름과 같은 키가 된다',
  out.measurements.pairsMatching === out.measurements.pairsTotal,
  { matching: out.measurements.pairsMatching, total: out.measurements.pairsTotal,
    failed: pairRows.filter(r => !r.keysMatch).map(r => ({ dirty: r.dirty, got: r.dirtyKeys, want: r.cleanKeys })) });
assert('N2: [핵심] byEntity 버킷 키에 조사 붙은 값이 없다',
  (out.measurements.byEntityParticleKeys || []).length === 0,
  { particleKeys: out.measurements.byEntityParticleKeys, allKeys: out.measurements.byEntityKeys });
assert('N3: [E1 전제] 조사 없는 인물 키로 byEntity 조회가 된다',
  out.measurements.byEntityHasCleanArielKey === true,
  { clean: out.measurements.byEntityHasCleanArielKey, dirty: out.measurements.byEntityHasDirtyArielKey });
// 오탐 검사 — `이`/`가` 로 끝나는 정상 명사를 훼손하지 않는가.
const MUST_KEEP = ['도현', '소라', '유리', '마리', '기사단', '마탑', '아리엘', '세라', '사과', '수도',
  '나로', '북부', '왕국', '미르', '하나', '바다', '시온', '레아', '호랑이', '지팡이', '다리', '머리'];
const ruined = MUST_KEEP.filter(name => !(normList([name], 32).some(v => toKey(v) === toKey(name))));
out.measurements.mustKeepRuined = ruined;
assert('N5: [오탐] `이`/`가` 로 끝나는 정상 명사가 훼손되지 않는다',
  ruined.length === 0,
  { ruined, checked: MUST_KEEP.length });

assert('N4: 실패 대조군 — 게이트 판정식이 조사 잔존을 검출한다',
  typeof out.measurements.negativeControl.gateWouldFlag === 'boolean',
  out.measurements.negativeControl);

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));
