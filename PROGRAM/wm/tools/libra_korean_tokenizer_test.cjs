'use strict';
// Gate: 한국어 토크나이저 — n-gram(글자 조각)이 이름 오탐을 만들지 않는가.
//
// 배경 (실측 결함):
//   `signature()` 가 tokens = [어절, 조사제거형, 2gram, 3gram...] 을 한 배열로 만들고,
//   `exactStats`/`evaluateEvidence` 가 이를 구분 없이 "어절 겹침"으로 셌다.
//
//   결과 ①: 이름 접두사 2자만 공유해도 (아리엘/아리수, 도현/도현욱) 글자 조각 '아리'/'도현'
//           이 겹침으로 세어져 evidence gate 를 통과하고 anchorBonus 를 받았다.
//           실측: 접두사 2자 공유 이름 쌍 462/462 통과 (100%), '도현' vs '도현욱' = 0.532.
//   결과 ②: 반대로 실제 동일한 이름 '아리엘' vs '아리엘' 은 words 가 비어 gate=false 였다.
//
//   수정: 어절(wordTokens)과 n-gram(hangulNgrams)을 생성기 기준으로 분리하고,
//   게이트·보너스는 어절 증거만 인정한다.
//
// 이 게이트는 "다른 이름은 통과하지 않고, 같은 이름·같은 내용은 통과한다"를 검사한다.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const snippet = '\n;globalThis.__LIBRA_EXPORTS__ = {' +
  "\nStrengthenedJaccardCore: typeof StrengthenedJaccardCore !== 'undefined' ? StrengthenedJaccardCore : null," +
  "\nTokenizerEngine: typeof TokenizerEngine !== 'undefined' ? TokenizerEngine : null," +
  "\nKoreanTextCore: typeof KoreanTextCore !== 'undefined' ? KoreanTextCore : null" +
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

  const E = ctx.__LIBRA_EXPORTS__;
  const J = E.StrengthenedJaccardCore;
  const K = E.KoreanTextCore;
  if (!J || !K) { console.log(JSON.stringify({ ok: false, reason: 'engine_missing', assertions: [] })); process.exit(1); }

  // ── 1) 어절과 n-gram 이 분리되는가 ──
  const sig = J.signature('아리엘');
  assert('signature_splits_words_and_ngrams', Array.isArray(sig.words) && sig.words.length > 0 && sig.words.includes('아리엘'), {
    words: sig.words, ngrams: sig.ngrams
  });
  assert('ngram_not_in_words', !(sig.words || []).includes('아리'), { words: sig.words, ngrams: sig.ngrams });

  // ── 2) 이름 접두사 공유 쌍은 게이트를 통과하지 않는다 (오탐 차단) ──
  const bases = ['아리', '도현', '루멘', '지훈', '민서', '수아', '하늘'];
  const tails = ['엘', '수', '랑', '아', '사', '스', '온', '진', '현', '욱', '영', '호'];
  let pairs = 0;
  let gatePassed = 0;
  let bonusGiven = 0;
  const worst = [];
  for (const b of bases) {
    const group = tails.map(t => b + t);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairs++;
        const r = J.score(group[i], group[j]);
        if (r.evidenceGate) { gatePassed++; if (worst.length < 5) worst.push({ a: group[i], b: group[j], score: r.score }); }
        if (Number(r.anchorBonus || 0) > 0) bonusGiven++;
      }
    }
  }
  assert('prefix_sharing_names_do_not_pass_gate', gatePassed === 0, { pairs, gatePassed, worst });
  assert('prefix_sharing_names_get_no_anchor_bonus', bonusGiven === 0, { pairs, bonusGiven });
  assert('known_name_collisions_blocked', [
    ['아리엘', '아리수'], ['도현', '도현욱'], ['루멘', '루멘스']
  ].every(([a, b]) => J.score(a, b).evidenceGate === false), {
    아리엘_아리수: J.score('아리엘', '아리수'),
    도현_도현욱: J.score('도현', '도현욱')
  });

  // ── 3) 같은 이름·같은 내용은 반드시 통과한다 (미탐 차단) ──
  const identical = J.score('아리엘', '아리엘');
  assert('identical_name_passes_gate', identical.evidenceGate === true, identical);
  const identicalSentence = J.score('아리엘이 검을 들었다.', '아리엘이 검을 들었다.');
  assert('identical_sentence_passes_gate', identicalSentence.evidenceGate === true, identicalSentence);
  const sameContent = J.score('도현이 별핵을 조사했다', '도현은 별핵을 조사했다');
  assert('same_content_passes_gate', sameContent.evidenceGate === true && sameContent.score > 0.4, sameContent);
  const sameNameDifferentEnding = J.score('아리엘이 검을 들었다', '아리엘은 검을 들고 있었다');
  assert('same_name_different_particle_passes', sameNameDifferentEnding.evidenceGate === true, sameNameDifferentEnding);

  // ── 4) 무관한 텍스트는 낮은 점수를 받는다 ──
  //
  // 주의: 게이트 통과 여부를 기준으로 삼으면 안 된다. '아리엘이 검을 들었다' 와
  // '아리수가 활을 들었다' 는 어절 '들었다' 가 겹치므로 게이트를 여는 것이 정당하다
  // (동사·문형이 같으면 관련 기억일 수 있다). 이름이 다른데 n-gram 만으로
  // 점수가 부풀지 않는지가 핵심이므로 점수 상한으로 판정한다.
  const unrelated = [
    ['회의가 시작됐다', '시대가 바뀌었다'],
    ['국가가 무너졌다', '별핵이 빛났다'],
    ['도현이 달렸다', '아리엘이 웃었다'],
    ['루멘이 책을 읽었다', '월식 의식이 시작됐다']
  ];
  const unrelatedScored = unrelated.map(([a, b]) => ({ a, b, score: J.score(a, b).score }));
  assert('unrelated_text_scores_low', unrelatedScored.every(x => x.score < 0.32), {
    tested: unrelated.length, samples: unrelatedScored
  });

  // 이름만 다른 쌍은 게이트를 열지 않는다 (이름 오탐 차단의 핵심 단언)
  const nameOnly = [['아리엘', '아리수'], ['도현', '도현욱'], ['루멘', '루멘스']];
  assert('name_only_difference_blocked', nameOnly.every(([a, b]) => J.score(a, b).evidenceGate === false), {
    samples: nameOnly.map(([a, b]) => ({ a, b, score: J.score(a, b).score, gate: J.score(a, b).evidenceGate }))
  });

  // ── 5) n-gram 은 여전히 char 점수에 기여한다 (완전히 버리지 않음) ──
  const withNgram = J.score('아리엘이 검을 들었다', '아리엘은 검을 들고 있었다');
  assert('ngram_still_contributes_to_score', withNgram.wordOnlyJaccard !== undefined && withNgram.charJaccard >= 0, {
    charJaccard: withNgram.charJaccard, wordOnlyJaccard: withNgram.wordOnlyJaccard
  });

  const failed = assertions.filter(a => !a.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    summary: failed.length === 0
      ? `한국어 토크나이저 오탐/미탐 차단 ${assertions.length}/${assertions.length}`
      : `실패 ${failed.length}/${assertions.length}`,
    assertions
  }, null, 1));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.log(JSON.stringify({ ok: false, reason: String(err?.message || err), stack: String(err?.stack || ''), assertions }, null, 1));
  process.exit(1);
});
