'use strict';
// Verify the shipped scanner behaves correctly after the quote-safety rewrite.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Repository-relative on purpose: an absolute path here made the suite pass on the machine it was
// written on while every other checkout failed with ENOENT at this line. The suite could not even
// notice, because it read the author's tree regardless of where it was invoked from.
const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// The EXACT extractor the failing suite uses.
const extractConst = name => {
  const marker = 'const ' + name + ' =';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'missing helper: ' + name);
  let quote = '', escaped = false, round = 0, square = 0, curly = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ';' && round === 0 && square === 0 && curly === 0) return source.slice(start, index + 1);
  }
  assert.fail('unterminated helper: ' + name);
};

const backslash = String.fromCharCode(92);
const dq = String.fromCharCode(34);
const sq = String.fromCharCode(39);

// Only the function itself: its quote/escape characters are built inside it from char codes,
// so it needs no outer scope and survives being extracted alone (which is how several suites use it).
const extracted = {
  canonicalJsonHasDuplicateKeys: extractConst('canonicalJsonHasDuplicateKeys')
};
console.log('추출된 helper 크기:');
for (const [k, v] of Object.entries(extracted)) console.log(`  ${k}: ${v.length}자`);

// Build a sandbox with just those, then call the scanner.
const sandbox = Object.values(extracted).join('\n');
const factory = new Function(`${sandbox}\nreturn canonicalJsonHasDuplicateKeys;`);
const scan = factory();

const cases = [
  { json: '{"facts":[],"facts":[1]}', expect: true, label: 'double-quoted duplicate' },
  { json: '{facts:[],facts:[1]}', expect: true, label: 'bare duplicate' },
  { json: "{'facts':[],'facts':[1]}", expect: true, label: 'single-quoted duplicate' },
  { json: '{schema:"sga.v2",ok:false,ok:true,draft:"complete"}', expect: true, label: 'conflicting ok' },
  { json: '{"facts":[],"notes":[1]}', expect: false, label: 'CONTROL distinct keys' },
  { json: '{"a":{"k":1},"b":{"k":2}}', expect: false, label: 'CONTROL sibling objects' },
  { json: '{"text":"facts:[] facts:[1]"}', expect: false, label: 'CONTROL keys inside a value' },
  { json: `{"text":"it's a trap"}`, expect: false, label: 'CONTROL apostrophe in a value' },
  { json: `{"text":"player's key","other":1}`, expect: false, label: 'CONTROL apostrophe + later key' }
];

const rows = cases.map(c => ({ label: c.label, detected: scan(c.json), expect: c.expect, ok: scan(c.json) === c.expect }));
console.log(JSON.stringify({ rows }, null, 1));
for (const r of rows) assert.equal(r.ok, true, `${r.label}: got ${r.detected}, expected ${r.expect}`);

// The real captured answers must NOT be reported as duplicates.
const recPath = '/tmp/gemma_libra_sga_result.json';
if (fs.existsSync(recPath)) {
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const attempts = rec.results.sga_shadow.attempts;
  const real = attempts.map((a, i) => ({ attempt: i, chars: a.rawContent.length, verdict: scan(a.rawContent) }));
  console.log('실제 캡처 응답 판정:', JSON.stringify(real));
  for (const r of real) assert.equal(r.verdict, false, `attempt ${r.attempt}: a real answer must not be flagged as a duplicate`);
}

process.stdout.write('libra_duplicate_scanner_extractable_test: PASS\n');
