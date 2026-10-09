'use strict';
// Gate: 클램프되는 int arg 는 @arg 설명에 범위를 밝힌다.
//
// 배경 (실측 결함):
//   `clampRuntimeInt` 가 27개 arg 를 하드 클램프하는데, 그중 대부분이 @arg 설명에
//   범위를 밝히지 않았다. 사용자가 `rp_long_term_long_ttl=99` 를 넣어도 120 이 되고
//   (하한 클램프), 이유를 알 방법이 없다. 실측: 요청 99 → 실제 120, 요청 55 → 60.
//
// 값 배선은 정상이었다 (실행 검증 40/51 반영, 나머지는 기본값 주입·프리셋 간섭).
// 결함은 **문서화**다: args 화면에서 범위를 알 수 없다.
//
// 이 게이트가 고정하는 계약:
//   A. 소스에서 clampRuntimeInt 로 감싼 arg 를 전수 추출한다
//   B. 각 arg 의 @arg 설명에 그 범위(하한·상한)가 문자열로 존재한다
//   C. 클램프 수가 갑자기 줄어도(리팩터 사고) 보고된다
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARTS = path.join(ROOT, 'src', 'parts');
const INIT = path.join(PARTS, '14-main-initialization.js');
const SHELL = path.join(PARTS, '00-plugin-shell-and-args.js');
const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── A. clampRuntimeInt 호출 전수 추출 (브레이스 매칭) ──
const init = fs.readFileSync(INIT, 'utf8');
const calls = [];
{
  let i = 0;
  while (true) {
    const j = init.indexOf('clampRuntimeInt(', i);
    if (j < 0) break;
    let k = j + 'clampRuntimeInt('.length;
    let depth = 1, inStr = null, esc = false;
    while (k < init.length && depth > 0) {
      const c = init[k];
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (inStr) { if (c === inStr) inStr = null; }
      else if (c === '"' || c === "'" || c === '`') inStr = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      k += 1;
    }
    calls.push({ at: j, text: init.slice(j, k) });
    i = k;
  }
}

// arg 이름 + 마지막 두 숫자/식 인자 = min, max
const clampMap = {};
for (const call of calls) {
  const nameMatch = call.text.match(/['"]([a-z_0-9]+)['"]/);
  if (!nameMatch) continue;
  const name = nameMatch[1];
  // 최상위 콤마로 인자 분해
  const inner = call.text.slice('clampRuntimeInt('.length).replace(/\)\s*$/, '');
  const args = [];
  {
    let depth = 0, inStr = null, esc = false, buf = '';
    for (const c of inner) {
      if (esc) { buf += c; esc = false; continue; }
      if (c === '\\') { buf += c; esc = true; continue; }
      if (inStr) { buf += c; if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'" || c === '`') { buf += c; inStr = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
      if (c === ',' && depth === 0) { args.push(buf.trim()); buf = ''; continue; }
      buf += c;
    }
    if (buf.trim()) args.push(buf.trim());
  }
  // 인자: [value, fallback, min, max] — 마지막 두 개
  if (args.length >= 4) {
    clampMap[name] = { min: args[args.length - 2], max: args[args.length - 1] };
  }
  // 인라인 형태: value, fallback, min, max
  else if (args.length === 4) {
    clampMap[name] = { min: args[2], max: args[3] };
  }
}

const clampNames = Object.keys(clampMap).sort();
assert('clamps_detected', clampNames.length >= 20, { count: clampNames.length, names: clampNames.slice(0, 8) });

// ── B. @arg 설명에 범위가 있는가 ──
const shell = fs.readFileSync(SHELL, 'utf8');
const descOf = {};
for (const m of shell.matchAll(/^\/\/@arg\s+(\S+)\s+(\S+)\s*(.*)$/gm)) descOf[m[1]] = m[3];

const extractNumbers = (expr) => {
  // '32 * 1024 * 1024' → MB 표기, '120' → 정수
  if (/1024\s*\*\s*1024/.test(expr)) {
    const mb = (expr.match(/(\d+)\s*\*\s*1024\s*\*\s*1024/) || [])[1];
    return { kind: 'bytes', value: mb ? Number(mb) + 'MB' : '', raw: expr };
  }
  const n = expr.match(/^(\d+)$/);
  if (n) return { kind: 'int', value: n[1], raw: expr };
  const mx = expr.match(/Math\.max\(\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
  if (mx) return { kind: 'bytes', value: mx[1] + 'MB', raw: expr };
  return { kind: 'expr', value: '', raw: expr };
};

const missing = [];
const covered = [];
for (const name of clampNames) {
  const desc = descOf[name];
  if (!desc) { missing.push({ name, reason: 'no @arg declaration' }); continue; }
  const lo = extractNumbers(clampMap[name].min);
  const hi = extractNumbers(clampMap[name].max);
  const hasRange = /range\s+[0-9]/.test(desc);
  // 범위 표기가 있으면 통과. 없으면 실패로 기록.
  if (hasRange) covered.push({ name, desc, lo: lo.value || lo.raw, hi: hi.value || hi.raw });
  else missing.push({ name, lo: lo.value || lo.raw, hi: hi.value || hi.raw, desc: desc.slice(0, 60) });
}

assert('every_clamped_arg_documents_its_range', missing.length === 0, {
  clampedCount: clampNames.length,
  documented: covered.length,
  undocumented: missing
});

// C. 범위 표기 형식 계약: '(range X-Y)' 패턴
const badFormat = covered.filter(c => !/\(range\s+[^)]+\)/.test(c.desc));
assert('range_notation_well_formed', badFormat.length === 0, { badFormat });

// D. 선언된 범위 숫자가 실제 클램프와 일치하는가 (문서-코드 드리프트 방지)
const drift = [];
for (const name of clampNames) {
  const desc = descOf[name] || '';
  const m = desc.match(/\(range\s+([0-9]+(?:MB)?)\s*-\s*([0-9]+(?:MB)?)\)/);
  if (!m) continue;
  const lo = extractNumbers(clampMap[name].min);
  const hi = extractNumbers(clampMap[name].max);
  const docLo = m[1], docHi = m[2];
  const actualLo = lo.value || lo.raw;
  const actualHi = hi.value || hi.raw;
  // 하한이 문서와 코드에서 같은 숫자인가 (MB/int 표기 모두)
  const sameLo = String(actualLo) === String(docLo);
  // 상한: 코드가 Math.max(...) 합성이면 정확 비교 불가 → 스킵
  const hiCompound = /Math\.max/.test(clampMap[name].max);
  const sameHi = hiCompound || String(actualHi) === String(docHi);
  if (!sameLo || !sameHi) drift.push({ name, doc: docLo + '-' + docHi, code: actualLo + '-' + actualHi });
}
assert('documented_range_matches_code', drift.length === 0, { drift });

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
