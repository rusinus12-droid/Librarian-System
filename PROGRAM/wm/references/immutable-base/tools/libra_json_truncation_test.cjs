'use strict';
/**
 * Gate: JSON 구조가 깨진 LLM 응답을 잘림으로 판정하지 못하던 결함.
 *
 * 실측 배경 (2026-09-27, 실제 출하 프롬프트 15종 × 2모델 = 30건, 수정 후 제품):
 *   qwen3.5-9B 가 done=stop 이면서 브레이스가 안 맞는 응답을 냈다.
 *     case1:  { 6 / } 5   ← 여는 쪽이 하나 많음(덜 닫힘)
 *     case2:  { 106 / } 110 ← 과잉 닫힘
 *   기존 판정은 마지막 글자가 '}' 인지만 봤기 때문에 이들을 전부 놓쳤다.
 *     잘림 판정 2/30 → 11/30 (+9)
 *   미탐지 0건, 정상 응답(gemma 15건) 오탐 0건.
 *
 * 판정 함수가 소스와 dist 에 실제로 들어 있는지 검사한다. 모델을 다시 부르지 않는다.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const assertions = [];
const add = (name, ok, details) => assertions.push({ name, ok: !!ok, details: details || {} });
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const src = readSrc('src/parts/09c-turn-maintenance-optimizer.js');
const dist = readSrc('dist/LIBRA World Manager Full.js');

// ① 균형 판정 함수가 있고 문자열/이스케이프를 존중한다
// 들여쓰기는 고정하지 않는다 — 2026-09-27 에 이 헬퍼를 `if (!parsed)` 밖으로 승격하면서 16칸 → 12칸이
// 됐고, 그때 들여쓰기를 박아 둔 정규식이 "함수가 없다"고 오진했다. 이름/시그니처만 본다.
const fnMatch = src.match(/const jsonBalance = \(text = '', openCh = '\{', closeCh = '\}'\) => \{([\s\S]*?)\n\s{8,20}\};/);
const fnBody = fnMatch ? fnMatch[1] : '';
// 정적 존재 확인이 아니라 실제로 실행해 검증한다.
// 문자열 안의 브레이스와 이스케이프된 따옴표를 세면 안 된다.
let scanner = null;
try {
  scanner = new Function('return (function(){' + fnMatch[0] + '; return jsonBalance;})()')();
} catch (_) { scanner = null; }
add('balance_scanner_present', typeof scanner === 'function', {});
add('balance_scanner_handles_strings_and_escapes',
  typeof scanner === 'function'
    && scanner('{"a":"{{{{"}', '{', '}') === 0        // 문자열 안 브레이스는 무시
    && scanner('{"a":"\\"}","b":1}', '{', '}') === 0  // 이스케이프된 따옴표 뒤에도 정상
    && scanner('{"a":1', '{', '}') === 1              // 실제 덜 닫힘
    && scanner('{"a":1}}', '{', '}') === -1,          // 실제 과잉 닫힘
  { sample: typeof scanner === 'function' ? [scanner('{"a":"{{{{"}', '{', '}'), scanner('{"a":1', '{', '}')] : null });

// ② 덜 닫힘과 과잉 닫힘을 모두 구조 깨짐으로 본다
add('detects_unbalanced_both_directions',
  /braceDepth !== 0 \|\| bracketDepth !== 0/.test(src),
  {});
add('likely_truncated_uses_structural_break',
  /const likelyTruncated = [\s\S]{0,400}structurallyBroken/.test(src),
  {});

// ③ 끝문자 검사가 단독 판정자로 남아 있지 않다
add('end_char_check_not_sole_judge',
  !/const likelyTruncated = [\s\S]{0,200}?&& \/\[?\/?[^\\n]*test\(cleaned\.trim\(\)\);\s*\n/.test(src)
    && /structurallyBroken/.test(src),
  {});

// ④ dist 반영
add('dist_carries_fix',
  /jsonBalance/.test(dist) && /structurallyBroken/.test(dist),
  {});

// ⑤ 실측 근거가 소스에 남아 있다
//   (복구 패스 은퇴로 `repair 대상` 문구가 `구조가 깨진 응답이다` 로 바뀌었다 — 실측 수치는 그대로 유지)
add('measured_evidence_recorded',
  /2 → 11/.test(src) || /잘림 판정 2/.test(src) || /구조가 깨진 응답이므로 repair 대상/.test(src) || /구조가 깨진 응답이다/.test(src),
  {});

const failed = assertions.filter(a => !a.ok);
process.stdout.write(JSON.stringify({
  ok: failed.length === 0,
  suite: 'json-structure-truncation',
  summary: `${assertions.length - failed.length}/${assertions.length}`,
  assertions,
}, null, 1) + '\n');
process.exit(failed.length === 0 ? 0 : 1);
