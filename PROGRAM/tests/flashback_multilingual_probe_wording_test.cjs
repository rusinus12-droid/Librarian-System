'use strict';
// LOCKS the plain-language wording of the Flashback multilingual probe surface.
//
// WHY THIS EXISTS
//   The screen is a diagnostic tool, but it addressed the user in implementation vocabulary:
//   `hash provider`, `provider/model`, `query/document`, `Evidence Gate`, `canonical memory`,
//   and table labels `음성`/`Δ`/`control`. A reader who does not know the internals cannot tell what
//   the check does or what it will cost them.
//
//   Only WORDING changed here — no state, threshold, probe call or gate behaviour. The suite asserts
//   the wording AND re-asserts that the behaviour behind it is untouched, so a later edit cannot
//   "simplify" the message by weakening the mechanism.
//
//   This test deliberately does NOT pin whole sentences: it pins the technical TERMS that must not
//   reappear and the plain replacements that must be present, so ordinary rewording stays free.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.env.FLASHBACK_TEST_PLUGIN
  ? path.resolve(process.env.FLASHBACK_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};

// The multilingual probe surface: the verdict function, its result renderer, and the card markup.
const stateFn = between('const multilingualProbeStateForSettings =', 'const renderMultilingualProbeResults =');
const renderer = between('const renderMultilingualProbeResults =', 'const buildProviderTab =');
const card = between('const buildMultilingualProbeCard =', 'const buildProviderTab =');
const surface = renderer + card;

// ── 1. implementation vocabulary must not reach the user ────────────────────────────────────────
// Only user-facing string literals are scanned; identifiers and internal comparisons are not
// wording and are expected to keep their technical names.
const userStrings = [...surface.matchAll(/(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/g)]
  .map(match => match[1] ?? match[2])
  .filter(value => value && /[가-힣]/.test(value));   // Korean prose only: the user-facing sentences
const banned = [
  ['hash provider', /hash\s*provider/i],
  ['provider/model', /provider\s*\/\s*model/i],
  ['query/document', /query\s*\/\s*document/i],
  ['Evidence Gate', /Evidence\s*Gate/i],
  ['canonical memory', /canonical\s*memory/i],
  ['dimension/task/prefix/endpoint listing', /dimension\/task\/prefix\/endpoint/i]
];
for (const [label, pattern] of banned) {
  const hit = userStrings.find(value => pattern.test(value));
  assert.equal(hit, undefined, `the user-facing text must not expose "${label}" (found in: ${hit})`);
}

// ── 2. the plain replacements must be present, so the fix cannot be "delete the sentence" ──────
const required = [
  ['현재 AI 연결', /현재 AI 연결의 한국어·영어·일본어·중국어/],
  ['질문과 문서', /질문과 문서로 나누어/],
  ['근거 기준', /근거 기준을 통과하는지/],
  ['저장된 기억', /저장된 기억은 변경되지 않았습니다/],
  ['AI 연결이나 임베딩 설정', /AI 연결이나 임베딩 설정이 바뀌어/]
];
for (const [label, pattern] of required) {
  assert.ok(pattern.test(surface), `the plain wording for "${label}" must be present`);
}
// Table labels and the status badge.
for (const [label, pattern] of [
  ['table 무관/차이/대조', /무관 \$\{formatProbeScore\(item\.maxNegative\)\}<\/span><span>차이 \$\{formatProbeScore\(item\.minMargin\)\}/],
  // The approved GUI moved the former "사용자 실행" provider-tag onto the run button itself.
  ['run button 사용자 실행', /<button id="multilingualProbeBtn" class="[^"]*" type="button" [^>]*>사용자 실행<\/button>/],
  ['meta 근거 기준', /근거 기준 \$\{formatProbeScore\(probe\.gateHighCosine\)\}/],
  ['meta 구분 여유', /구분 여유 \$\{formatProbeScore\(probe\.minMargin\)\}/]
]) {
  assert.ok(pattern.test(surface), `"${label}" must be present in the probe surface`);
}
assert.ok(/item\.control \? '<em>대조<\/em>'/.test(surface), 'the table control marker must read 대조');

// ── 3. the mechanism behind the wording is untouched ───────────────────────────────────────────
// A wording-only change must not have altered any state name, threshold comparison or the probe call.
assert.match(renderer, /state === 'not_applicable'/, 'the not_applicable state branch must be unchanged');
assert.match(stateFn, /probe\.gateHighCosine != null && Math\.abs\(Number\(probe\.gateHighCosine\) - Number\(cfg\.gateHighCosine\)\) > 0\.000001/,
  'the gate comparison must be unchanged');
assert.match(stateFn, /probe\.verified === true \? 'verified' : 'threshold_not_met'/,
  'the verified/threshold verdict must be unchanged');
assert.ok(/id="multilingualProbeBtn"/.test(card), 'the run button must survive');
assert.ok(/id="cancelMultilingualProbeBtn"/.test(card), 'the cancel button must survive');
assert.ok(/id="sameSpacePreviewBtn"/.test(card), 'the same-space preview button must survive');
assert.ok(/id="sameSpaceApplyBtn"/.test(card), 'the same-space apply button must survive');

console.log(JSON.stringify({ test: 'flashback_multilingual_probe_wording', ok: true, userStrings: userStrings.length }));
console.log('PASS Flashback 다국어 리콜 검증: 사용자 문구는 일상어, 상태·문턱·버튼은 그대로');
