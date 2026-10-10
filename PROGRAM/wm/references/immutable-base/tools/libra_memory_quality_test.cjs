'use strict';
// Gate: 기억 기록 품질 — 요약이 턴 고유의 구체적 사건을 담는가.
//
// 배경 (실측 결함):
//   `scoreSentence` 가 키워드 매칭만으로 점수를 매겨, 진행 문장('계획을 확인했다')
//   이 구체적 사건('별핵 파편이 빛나며 북쪽을 가리켰다')보다 높은 점수를 받았다.
//
//   실측 (수정 전):
//     - 핵심 사건 포착 6/10 (60%)
//     - 턴 고유 내용 포착 3/8 (38%)
//     - 요약 8개 중 4개가 완전히 동일 (boilerplate 가 이겨서)
//     - '기사단장이 왼쪽 어깨를 베었다' / '국고가 바닥났다' 탈락
//   나아가 요약이 recallAnchors 로 복사되므로, 요약에서 탈락한 사건은
//   회상 앵커에도 들어가지 않아 아예 기억되지 않는다.
//
// 수정: 구체 사건(CONCRETE_EVENT_PATTERN)과 수치를 우대하고, 진행만 하는
// 장면 문장(GENERIC_SCENE_PATTERN)을 감점한다.
//
// 이 게이트는 (1) 핵심 사건이 요약에 담기고 (2) 요약이 턴마다 고유하며
// (3) 그 요약으로 회상했을 때 해당 턴이 최상위로 나오는지를 검사한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8')
  .replace('const PENDING_FINALIZE_MIN_MS = 3500;', 'const PENDING_FINALIZE_MIN_MS = 0;')
  .replace('const PENDING_FINALIZE_REQUIRED_MATCHES = 2;', 'const PENDING_FINALIZE_REQUIRED_MATCHES = 1;')
  .replace('const REFRESH_STABILIZE_MS = 2500;', 'const REFRESH_STABILIZE_MS = 0;')
  .replace('const REFRESH_DELETE_BLOCK_MS = 15000;', 'const REFRESH_DELETE_BLOCK_MS = 0;');

const snippet = '\n;globalThis.__LIBRA_EXPORTS__ = {' +
  "\nMemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null," +
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
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'u' }; },
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

  const E = ctx.__LIBRA_EXPORTS__;
  const engine = E.MemoryEngine;
  const codec = E.CompactMemoryCodec;
  if (!engine || !codec) { console.log(JSON.stringify({ ok: false, reason: 'exports_missing', assertions: [] })); process.exit(1); }

  const build = (text, turn, importance = 6) =>
    codec.buildTurnPayload(text, text, { turn, importance, sourceHash: String(turn) });

  // ── 1) 시나리오별 핵심 사건 포착 ──
  const scenarios = [
    { name: '전투', boiler: ['도현은 검을 고쳐 쥐었다.', '상황을 다시 확인했다.', '아리엘이 옆에서 대기했다.'], key: ['기사단장이 왼쪽 어깨를 베었다.', '회복 물약이 두 개 남았다.'] },
    { name: '연애', boiler: ['둘은 잠시 말이 없었다.', '창밖을 바라보았다.', '시간이 흘렀다.'], key: ['아리엘이 "좋아해"라고 말했다.', '도현은 대답하지 못했다.'] },
    { name: '추리', boiler: ['방 안을 둘러보았다.', '메모를 정리했다.', '의자에 앉았다.'], key: ['피 묻은 장갑이 서랍에서 나왔다.', '집사는 3시에 자리를 비웠다.'] },
    { name: '정치', boiler: ['회의가 계속되었다.', '모두 고개를 끄덕였다.', '자료를 넘겼다.'], key: ['북부 영주가 반란을 선언했다.', '국고가 바닥났다.'] },
    { name: '일상', boiler: ['아침을 먹었다.', '씻고 나왔다.', '가방을 챙겼다.'], key: ['어머니가 입원했다는 전화를 받았다.', '시험에 떨어졌다.'] }
  ];
  let keyTotal = 0;
  let keyCaptured = 0;
  const perScenario = [];
  for (const sc of scenarios) {
    const text = [...sc.boiler, ...sc.key].join(' ');
    const summary = String(build(text, 1, 7).summary || '');
    const hits = sc.key.filter(k => summary.includes(k.slice(0, 10)));
    keyTotal += sc.key.length;
    keyCaptured += hits.length;
    perScenario.push({ name: sc.name, captured: hits.length, of: sc.key.length, summary });
  }
  assert('core_events_captured', keyCaptured / keyTotal >= 0.8, {
    captured: keyCaptured, total: keyTotal, rate: (keyCaptured / keyTotal).toFixed(2), perScenario
  });

  // ── 2) 같은 boilerplate, 다른 사건 → 요약이 턴마다 고유한가 ──
  const sharedBoiler = ['도현은 중앙정원에서 상황을 정리했다.', '아리엘은 고개를 끄덕이며 다음 계획을 확인했다.', '학생회 감시망을 피해야 한다는 판단은 여전히 유효했다.'];
  const uniques = [
    '별핵 파편 1이 은색으로 빛나며 북쪽을 가리켰다.',
    '노아가 기록 일부를 숨긴 사실이 드러났다.',
    '미라가 시계탑에서 시간 잠금 주문의 균열을 발견했다.',
    '달그림자 도서관 지하에서 고대 서약문이 나왔다.',
    '아리엘이 도현에게 진심을 고백했다.',
    '루멘 아카데미 봉인이 절반 해제되었다.',
    '도현이 별핵의 진짜 사용 목적을 알아냈다.',
    '노아와 도현이 화해하고 동맹을 맺었다.'
  ];
  const summaries = uniques.map((u, i) => String(build([...sharedBoiler, u].join(' '), i + 1, 6).summary || ''));
  const distinct = new Set(summaries).size;
  assert('summaries_unique_per_turn', distinct === summaries.length, {
    generated: summaries.length, distinct, duplicated: summaries.length - distinct
  });
  const captured = uniques.filter((u, i) => summaries[i].includes(u.slice(0, 12))).length;
  assert('unique_event_captured', captured / uniques.length >= 0.75, {
    captured, of: uniques.length, rate: (captured / uniques.length).toFixed(2), summaries
  });

  // ── 3) 그 요약으로 회상하면 해당 턴이 최상위인가 ──
  const lore = uniques.map((u, i) => {
    const text = [...sharedBoiler, u].join(' ');
    const payload = build(text, i + 1, 6);
    const meta = { t: i + 1, imp: 6, cat: 'personal', ttl: 720, m_id: 'live-a-' + (i + 1), sourceHash: String(i + 1), turnKey: 'TK|' + (i + 1) };
    return { key: '', comment: 'lmai_memory', content: `[META:${JSON.stringify(meta)}]\n${codec.serialize(payload)}\n`, mode: 'normal', insertorder: 100, alwaysActive: false };
  });
  const vars = {
    focusNames: [], directFocusNames: [], relatedFocusNames: [], narrativeArcKeys: [],
    embeddingAllowed: false, recallFeedbackLorebook: lore,
    scopeKey: 'char-t::::chat-t::::', chatId: 'chat-t', characterId: 'char-t'
  };
  // 질의 → 기대 턴 (질의는 그 턴의 고유 사건에서 뽑은 어휘)
  const queries = [
    { q: '별핵 파편이 가리킨 방향', expect: 1 },
    { q: '노아가 숨긴 기록', expect: 2 },
    { q: '시간 잠금 주문 균열', expect: 3 },
    { q: '고대 서약문 발견', expect: 4 },
    { q: '진심 고백', expect: 5 },
    { q: '봉인 절반 해제', expect: 6 },
    { q: '별핵 사용 목적', expect: 7 },
    { q: '화해와 동맹', expect: 8 }
  ];
  let recallHits = 0;
  const recallRows = [];
  for (const { q, expect } of queries) {
    if (engine.clearDerivedCaches) engine.clearDerivedCaches();
    const r = await engine.retrieveMemories(q, 8, lore, vars, 6);
    const first = (r || [])[0];
    let gotTurn = null;
    if (first) {
      const m = String(first.content).match(/^\[META:(\{[^\r\n]*\})]/);
      if (m) { try { gotTurn = JSON.parse(m[1]).t; } catch (_) {} }
    }
    if (gotTurn === expect) recallHits++;
    recallRows.push({ q, expect, gotTurn, ok: gotTurn === expect });
  }
  assert('recall_finds_own_turn', recallHits / queries.length >= 0.6, {
    hits: recallHits, of: queries.length, rate: (recallHits / queries.length).toFixed(2), rows: recallRows
  });

  // ── 4) 진행 문장만 있으면 요약이 비지 않는다 ──
  const onlyBoiler = String(build(sharedBoiler.join(' '), 1, 5).summary || '');
  assert('summary_not_empty_for_boilerplate_only', onlyBoiler.length > 0, { summary: onlyBoiler });

  const failed = assertions.filter(a => !a.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    summary: failed.length === 0
      ? `기억 기록 품질 ${assertions.length}/${assertions.length}`
      : `실패 ${failed.length}/${assertions.length}`,
    assertions
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, reason: String(err?.message || err), stack: String(err?.stack || ''), assertions }, null, 1));
  process.exit(1);
});
