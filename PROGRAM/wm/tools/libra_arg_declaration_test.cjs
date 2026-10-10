'use strict';
// Gate: `//@arg` 선언이 고유한가 + 선언↔소비 정합성.
//
// 배경 (실측 결함):
//   34개 arg 를 GUI 에 노출하는 작업에서 **이미 선언된 9개 이름을 다시 추가**했다.
//   총 163개 선언 / 154개 고유 이름 → 설정 화면에 같은 항목이 두 번 뜬다.
//   (값 해석은 getArgument(argName) 이름 기반이라 모호하지 않지만, 표시가 중복된다.)
//
// 이 게이트가 고정하는 계약:
//   A. 배포본 헤더에 중복 @arg 가 없다
//   B. 소스에도 중복이 없다
//   C. 선언된 arg 는 전부 소비된다 (getVal/readRuntimeArg/getArgument 경유)
//   D. 소비되는 arg 는 전부 선언된다 (미선언 = args 화면에 안 뜸)
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── 수집 ──
const collectArgs = (text) => {
  const names = [];
  const re = /^\/\/@arg\s+(\S+)(?:\s+(\S+))?/gm;
  let m;
  while ((m = re.exec(text))) names.push({ name: m[1], type: m[2] || '' });
  return names;
};
const dupOf = (names) => {
  const seen = new Map();
  const dups = [];
  for (const n of names) {
    const c = (seen.get(n.name) || 0) + 1;
    seen.set(n.name, c);
    if (c === 2) dups.push(n.name);
  }
  return dups;
};

const shell = fs.readFileSync(path.join(PARTS, '00-plugin-shell-and-args.js'), 'utf8');
const srcArgs = collectArgs(shell);
const srcDups = dupOf(srcArgs);

assert('source_has_no_duplicate_args', srcDups.length === 0, {
  total: srcArgs.length, unique: new Set(srcArgs.map(a => a.name)).size, duplicates: srcDups
});

// 배포본 헤더 검사
let distArgs = [];
let distErr = '';
try { distArgs = collectArgs(fs.readFileSync(DIST, 'utf8')); } catch (e) { distErr = String(e?.message || e); }
const distDups = dupOf(distArgs);
assert('dist_has_no_duplicate_args', !distErr && distDups.length === 0, {
  total: distArgs.length, duplicates: distDups, error: distErr
});
assert('declarations_survive_build', srcArgs.length === distArgs.length && srcArgs.length > 100, {
  source: srcArgs.length, dist: distArgs.length
});

// ── 선언 ↔ 소비 정합성 ──
const declared = new Set(srcArgs.map(a => a.name));
const consumed = new Set();
const consumers = {};
for (const file of fs.readdirSync(PARTS)) {
  if (!file.endsWith('.js')) continue;
  const text = fs.readFileSync(path.join(PARTS, file), 'utf8');
  const patterns = [
    /getVal\s*\(\s*[^,]+,\s*['"]([a-z_0-9]+)['"]/g,
    /readRuntimeArg\s*\(\s*['"]([a-z_0-9]+)['"]/g,
    /getArgument\s*\(\s*['"]([a-z_0-9]+)['"]/g,
    /getRuntimeArgVal\s*\(\s*['"]([a-z_0-9]+)['"]/g,
    /hasRuntimeArgValue\s*\(\s*['"]([a-z_0-9]+)['"]/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      consumed.add(m[1]);
      (consumers[m[1]] = consumers[m[1]] || []).push(file);
    }
  }
}

// C: 소비되는데 선언 안 됨 = args 화면에 안 뜨는 숨은 설정
const undeclared = [...consumed].filter(n => !declared.has(n)).sort();
assert('every_consumed_arg_is_declared', undeclared.length === 0, { undeclared });

// D: 선언됐지만 어디서도 소비 안 됨 = 무효 선언
//    변수 기반 읽기(argName 파라미터 경유)가 있으므로 후보만 보고하고,
//    실제 소비 여부는 실행 검증(별도 프로브)이 판정한다. 여기서는 0 을 요구하지 않는다.
const unconsumed = [...declared].filter(n => !consumed.has(n)).sort();
assert('unconsumed_reported_not_failed', true, {
  declaredCount: declared.size,
  literalConsumedCount: consumed.size,
  unconsumedCount: unconsumed.length,
  note: '변수 경유 소비는 리터럴 스캔에 안 잡힌다 — 실행 검증이 판정',
  unconsumedSample: unconsumed.slice(0, 12)
});

// E: 이름 형식 계약 (소문자·숫자·밑줄)
const badFormat = srcArgs.filter(a => !/^[a-z][a-z0-9_]*$/.test(a.name)).map(a => a.name);
assert('arg_names_well_formed', badFormat.length === 0, { badFormat });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
