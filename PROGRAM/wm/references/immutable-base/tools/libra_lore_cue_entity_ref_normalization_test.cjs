'use strict';
// Gate: 로어 큐(03i)의 엔티티 참조가 조사를 뗀 이름인가.
//
// 배경 (실측 결함):
//   `03i:88` 의 폴백 정규식 `/[가-힣]{2,5}(?:...)?/g` 는 어절도 조사도 존중하지 않아
//   '아리엘은'·'세라와는'·'카일을' 을 그대로 ref 로 수집한다.
//   그 refs 는 `03i:464` format() 을 거쳐 **프롬프트에 그대로 나간다**:
//     `entities=아리엘은/세라와는/카일을`
//   그리고 `10c` 그래프의 E2 엣지(entity→lore)가 정본 이름 키와 매칭되지 않는다.
//
// 같은 계열 결함이 `10c` 에서는 이미 고쳐졌다(커밋 b1bc439, normalizeHmeEntityList).
// 이 게이트는 `03i` 쪽 사본을 같은 기준으로 판정한다.
//
// 판정은 *제품 함수를 실행* 해서 한다 — 문자열 존재 검사가 아니다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = { ok: false, assertions: [], measurements: {} };

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

// 03i 는 모듈 IIFE 지역 변수다. 최상위 IIFE 구조(실측):
//   175행 시작 → 60948행 닫힘  ← MemoryEngine 등
//   67376행 초기화 IIFE → 67500행 닫힘
// 03i 는 12952행 부근이라 첫 IIFE 안이다. 닫힘 뒤에 심는다.
const SCOPE_TAIL = 'return { analyzeUserIntent, detectConflict, executeAdjustment, applyChange };';
const tailAt = code.indexOf(SCOPE_TAIL);
if (tailAt < 0) { out.reason = 'scope_tail_not_found'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const closeMark = code.indexOf('\n})();', tailAt);
if (closeMark < 0) { out.reason = 'scope_close_not_found'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
const injectAt = closeMark + '\n})();'.length;
code = code.slice(0, injectAt)
  + '\n;globalThis.__LORE_CUE_TEST__={' +
  "CharacterLoreCueIndex: typeof CharacterLoreCueIndex !== 'undefined' ? CharacterLoreCueIndex : null" +
  ',EntityManager: typeof EntityManager !== "undefined" ? EntityManager : null'
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

const EXP = ctx.__LORE_CUE_TEST__ || {};
const CLCI = EXP.CharacterLoreCueIndex;
const EM = EXP.EntityManager;
if (!CLCI) { out.reason = 'CharacterLoreCueIndex_missing'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
out.measurements.emAvailable = !!EM;
const assert = (name, ok, details = {}) => out.assertions.push({ name, ok: !!ok, details });
const PARTICLE_RE = /(?:에게서는|에게서|에게는|에게|한테는|한테|에서는|에는|에서|으로는|으로|부터|까지|처럼|께서는|께서|하고|이다|이며|이랑|랑|은|는|을|를|의|도|로|만|에|과|와)$/u;

// ── 표본: 문장에 인물 이름이 조사와 함께 등장 ─────────────────────────────
const ENTITY_NAMES = ['아리엘', '세라', '카일', '미르'];
const ENTITY_ENTRIES = ENTITY_NAMES.map(name => ({
  comment: 'lmai_entity', key: `lmai_entity::${name}`, secondkey: '',
  content: JSON.stringify({ name, type: 'character', identity: { aliases: [] }, meta: { aliases: [] } })
}));
const loreEntries = [
  { comment: '북부 기사단', key: '기사단', secondkey: '', content: '북부 기사단은 아리엘이 속한 조직이다. 세라의 아버지가 창설했으며, 카일은 탈퇴했다.' },
  { comment: '마탑', key: '마탑', secondkey: '', content: '마탑은 미르가 수장으로 있는 곳이다. 아리엘과 마탑은 오랜 앙숙 관계다.' }
];
const char = {
  name: '아리엘',
  description: '아리엘은 북부 기사단 소속이다. 세라와는 어릴 적부터 알고 지낸 사이이며, 카일을 라이벌로 여긴다.',
  personality: '냉정하다. 미르에게만 마음을 연다.',
  scenario: '폐허가 된 왕국.',
  firstMessage: '"또 만났군, 세라."',
  creatorNotes: ''
};
const chat = { localLore: [...loreEntries, ...ENTITY_ENTRIES] };

// EntityManager 캐시를 채운다 — 제품이 실제로 부르는 경로 (14-main-initialization 등 10곳).
if (EM?.rebuildCache) { try { EM.rebuildCache([...loreEntries, ...ENTITY_ENTRIES]); } catch (e) { out.measurements.rebuildThrow = String(e?.message); } }

let payload = null;
try { payload = CLCI.buildPayload(char, chat, {}); } catch (e) { out.reason = 'buildPayload_throw: ' + (e && e.message); console.log(JSON.stringify(out, null, 2)); process.exit(1); }
out.measurements.cueCount = (payload?.cues || []).length;

// ── 측정 1: refs 에 조사 붙은 형태가 있는가 ──────────────────────────────
const allRefs = new Set();
for (const cue of payload?.cues || []) {
  (Array.isArray(cue.entityRefs) ? cue.entityRefs : []).forEach(r => allRefs.add(String(r).trim()));
}
const refs = Array.from(allRefs);
out.measurements.refs = refs;
out.measurements.particleRefs = refs.filter(r => PARTICLE_RE.test(r));
out.measurements.exactEntityHits = refs.filter(r => ENTITY_NAMES.includes(r));
out.measurements.recoveryRate = ENTITY_NAMES.length ? out.measurements.exactEntityHits.length / ENTITY_NAMES.length : 0;

// ── 측정 2: 프롬프트(format) 로 나가는 문자열에 조사가 섞이는가 ──────────
const items = (payload?.cues || []).map(cue => ({ ...cue }));
let block = '';
try { block = CLCI.format(items, { title: 'T', maxChars: 8000, itemChars: 560 }); } catch (e) { out.measurements.formatThrow = String(e?.message); }
out.measurements.blockHasParticleEntity = /entities=[^\n]*(?:은|는|을|를|이|가|의|과|와|에게|에서)/.test(block);
const entityTokens = Array.from(block.matchAll(/entities=([^\n;]+)/g))
  .flatMap(m => String(m[1]).split('/'))
  .map(t => String(t).trim())
  .filter(t => t && !/\s/.test(t));
out.measurements.blockEntityTokens = entityTokens.slice(0, 20);
out.measurements.blockParticleTokens = entityTokens.filter(t => PARTICLE_RE.test(t));

// ── 판정 ─────────────────────────────────────────────────────────────────
assert('L1: buildPayload 가 cue 를 만든다', out.measurements.cueCount > 0, { cueCount: out.measurements.cueCount });
// `이`/`가` 는 의도적으로 떼지 않는다 (오탐 실측 — '호랑이'→'호랑' 이 된다).
//   주격 조사는 push() 경로가 정본 이름을 raw.includes 로 찾으므로 이미 해결된다.
//   그래서 판정 기준은 "이/가 **외** 조사가 남지 않는다" 이다.
const NON_I_GA_PARTICLE = /(?:에게서는|에게서|에게는|에게|한테는|한테|에서는|에는|에서|으로는|으로|부터|까지|처럼|께서는|께서|하고|이다|이며|이랑|랑|은|는|을|를|의|도|로|만|에|과|와)$/u;
const residualNonIGa = refs.filter(r => NON_I_GA_PARTICLE.test(r));
out.measurements.residualNonIGa = residualNonIGa;
out.measurements.residualIGa = refs.filter(r => /(?:이|가)$/u.test(r));
assert('L2: [핵심] cue.entityRefs 에 `이`/`가` 외 조사가 남지 않는다',
  residualNonIGa.length === 0,
  { residual: residualNonIGa, residualIGa: out.measurements.residualIGa, allRefs: refs.slice(0, 20) });
assert('L3: 인물 이름이 정확히 회수된다 (4명 전원)',
  out.measurements.exactEntityHits.length === ENTITY_NAMES.length,
  { hits: out.measurements.exactEntityHits, rate: out.measurements.recoveryRate });
assert('L4: [핵심] 프롬프트 block 의 entities= 토큰에 조사가 없다',
  out.measurements.blockParticleTokens.length === 0,
  { particleTokens: out.measurements.blockParticleTokens, sample: out.measurements.blockEntityTokens });

// 실패 대조군 — 판정식이 실제로 조사를 검출하는가
const NEG_CASES = [
  ['아리엘은', true],   // 조사 붙음 → 검출돼야
  ['카일을', true],
  ['세라의', true],
  ['아리엘', false],    // 조사 없음 → 검출 안 돼야
  ['도현', false]
];
const negRows = NEG_CASES.map(([input, expectFlag]) => ({
  input, expectFlag, gotFlag: PARTICLE_RE.test(input), correct: PARTICLE_RE.test(input) === expectFlag
}));
out.measurements.negativeControl = { rows: negRows, allCorrect: negRows.every(r => r.correct) };
// 오탐: `이`/`가` 로 끝나는 정상 명사가 훼손되지 않는가.
const MUST_KEEP = ['도현', '소라', '유리', '마리', '기사단', '마탑', '아리엘', '세라', '사과', '수도',
  '북부', '왕국', '미르', '하나', '바다', '호랑이', '지팡이', '다리', '머리', '가위'];
const ruined = [];
for (const name of MUST_KEEP) {
  const ch = { name, description: `${name} 이 문장에 있다.`, personality: '', scenario: '', firstMessage: '', creatorNotes: '' };
  const pl = CLCI.buildPayload(ch, { localLore: [] }, {});
  const got = new Set();
  (pl.cues || []).forEach(c => (c.entityRefs || []).forEach(r => got.add(String(r).trim())));
  if (!got.has(name)) ruined.push(`${name} -> [${Array.from(got).join(',')}]`);
}
out.measurements.mustKeepRuined = ruined;
assert('L6: [오탐] `이`/`가` 로 끝나는 정상 명사가 훼손되지 않는다',
  ruined.length === 0,
  { ruined, checked: MUST_KEEP.length });

assert('L5: 실패 대조군 — 판정식이 조사 유/무를 정확히 가른다',
  out.measurements.negativeControl.allCorrect === true,
  out.measurements.negativeControl);

out.ok = out.assertions.every(a => a.ok);
console.log(JSON.stringify(out, null, 2));
