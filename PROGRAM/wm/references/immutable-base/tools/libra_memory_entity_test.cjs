'use strict';
// Gate: 기억의 엔티티 추출 — 인물이 정확히 뽑히고 조사가 붙지 않는가.
//
// 배경 (실측 결함):
//   `expandTruncatedKoreanName` 이 '도현'을 성씨 '도'+외자 '현' 으로 오판하고,
//   본문의 '도현이'(주격 조사) 를 "더 완전한 이름" 으로 착각해 확장했다.
//   - 엔티티가 '도현이','마수가' 로 저장됨
//   - 그 오염이 known 목록에 축적되어 자가 오염 루프를 만들었다
//   - 확장 실패 시 '' 를 반환해 정상 인물이 통째로 누락됐다 (누락 2건)
//   또한 폴백 정규식 `/[가-힣]{2,5}/g` 가 띄어쓰기를 무시해
//   '휘둘렀지만'을 '휘둘렀지'로 잘라 인물명 후보로 삼았다 (정밀도 6%).
//
// 수정:
//   1) 이름 확장 후보가 조사·어미로 끝나면 확장하지 않는다.
//   2) 확장 후보가 없으면 원래 이름을 유지한다 (누락 방지).
//   3) 폴백 추출을 어절 단위로 분리한다.
//
// 이 게이트는 실제 런타임처럼 엔티티가 알려진 상태에서
// (1) 인물이 조사 없이 정확히 추출되고 (2) 비인물 토큰이 섞이지 않는지 검사한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const snippet = '\n;globalThis.__LIBRA_EXPORTS__ = {' +
  "\nCompactMemoryCodec: typeof CompactMemoryCodec !== 'undefined' ? CompactMemoryCodec : null" +
  '\n};\n';
const closeIdx = code.lastIndexOf('\n})();');
if (closeIdx < 0) { console.log(JSON.stringify({ ok: false, reason: 'iife_close_not_found', assertions: [] })); process.exit(1); }
code = code.slice(0, closeIdx) + snippet + code.slice(closeIdx);

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

(async () => {
  const run = vm.runInContext(code, ctx, { timeout: 30000 });
  if (run && typeof run.then === 'function') await run;
  await new Promise(r => setTimeout(r, 300));

  const codec = ctx.__LIBRA_EXPORTS__.CompactMemoryCodec;
  if (!codec) { console.log(JSON.stringify({ ok: false, reason: 'codec_missing', assertions: [] })); process.exit(1); }

  // 비인물 토큰 (조사 붙은 명사, 동사, 부사, 일반명사)
  const NON_ENTITY = new Set([
    '검을', '화살', '날개', '왼쪽', '오른쪽', '대신', '날려', '피했다', '휘둘렀지', '가볍게',
    '명중시켰다', '망설', '나도', '계속', '너를', '좋아했어', '라고', '얼굴', '사이', '침묵',
    '흘렀다', '탁자', '찢어진', '편지', '조각', '시에', '항구', '적혀', '필체', '것과',
    '세계', '하나', '영구히', '사라진다', '규칙', '과거', '셋이', '잃었다', '위에서'
  ]);

  // 실제 런타임처럼 엔티티가 알려진 상태로 추출한다.
  const known = ['도현', '아리엘', '마수', '집사', '노아', '미라', '루멘'];
  const extract = (ai) => {
    const payload = codec.buildTurnPayload('', ai, { turn: 1, importance: 6, sourceHash: 'x', entityRefs: known.slice() });
    return Array.isArray(payload.mentionedEntityNames) ? payload.mentionedEntityNames : [];
  };

  // ── 1) 조사가 붙은 인물명이 저장되지 않는다 ──
  const josaCases = [
    { ai: '도현이 검을 휘둘렀다.', bad: ['도현이'], good: ['도현'] },
    { ai: '마수가 가볍게 피했다.', bad: ['마수가'], good: ['마수'] },
    { ai: '아리엘이 웃었다.', bad: ['아리엘이'], good: ['아리엘'] },
    { ai: '집사는 자리를 비웠다.', bad: ['집사는'], good: ['집사'] }
  ];
  const josaRows = [];
  let josaBad = 0;
  let josaMiss = 0;
  for (const c of josaCases) {
    const got = extract(c.ai);
    const hasBad = c.bad.some(b => got.includes(b));
    const hasGood = c.good.some(g => got.includes(g));
    if (hasBad) josaBad++;
    if (!hasGood) josaMiss++;
    josaRows.push({ ai: c.ai, got, expected: c.good, attached: hasBad, found: hasGood });
  }
  assert('no_particle_attached_entity', josaBad === 0, { cases: josaRows.length, attached: josaBad, rows: josaRows });
  assert('known_entity_not_dropped', josaMiss === 0, { cases: josaRows.length, missing: josaMiss, rows: josaRows });

  // ── 2) 비인물 토큰이 섞이지 않는다 ──
  const texts = [
    '도현이 검을 휘둘렀지만 마수가 가볍게 피했다. 대신 아리엘이 뒤에서 화살을 날려 마수의 왼쪽 날개를 명중시켰다.',
    '아리엘은 잠시 망설이다가 "나도 계속 너를 좋아했어"라고 말했다. 얼굴이 붉어졌고 두 사람 사이에 침묵이 흘렀다.',
    '탁자 위에서 찢어진 편지 조각을 발견했다. 조각에는 "3시에 항구에서"라고만 적혀 있었다. 필체는 집사의 것과 일치했다.',
    '이 세계에서 별핵을 두 번 사용하면 사용자의 기억 하나가 영구히 사라진다는 규칙이 있다. 과거 별핵 사용자 중 셋이 기억을 잃었다.'
  ];
  const noiseRows = [];
  let noiseTotal = 0;
  let noiseFound = 0;
  for (const t of texts) {
    const got = extract(t);
    const noise = got.filter(x => NON_ENTITY.has(x));
    noiseTotal += got.length;
    noiseFound += noise.length;
    noiseRows.push({ got, noise });
  }
  const precision = noiseTotal ? ((noiseTotal - noiseFound) / noiseTotal) : 0;
  assert('no_non_entity_tokens', noiseFound === 0, {
    extracted: noiseTotal, noiseTokens: noiseFound, precision: precision.toFixed(2), rows: noiseRows
  });

  // ── 3) 인물은 빠지지 않는다 ──
  const present = texts.map(t => extract(t));
  assert('entities_not_lost', present[0].includes('도현') && present[0].includes('마수') && present[0].includes('아리엘'), {
    first: present[0]
  });

  // ── 4) 엔티티가 전혀 없어도 빈 결과가 나온다 (예외 없음) ──
  const empty = extract('그리고 그리고 그리고');
  assert('no_crash_on_empty_entities', Array.isArray(empty), { got: empty });

  const failed = assertions.filter(a => !a.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    summary: failed.length === 0
      ? `기억 엔티티 추출 ${assertions.length}/${assertions.length}`
      : `실패 ${failed.length}/${assertions.length}`,
    assertions
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, reason: String(err?.message || err), stack: String(err?.stack || ''), assertions }, null, 1));
  process.exit(1);
});
