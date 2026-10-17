'use strict';
// Durable identities predate the optimized loop: chunk boundaries and UTF-16
// code units must retain their exact existing hashes, including lone surrogates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const start = source.indexOf('  const createTextHasher = () => {');
const end = source.indexOf('\n  const normalizeStoredRagMessage', start);
assert.ok(start >= 0 && end > start);
const create = vm.runInNewContext(source.slice(start, end) + ';createTextHasher');
const cases = [
  [[], '811c9dc5:0'],
  [[''], '1a0c7e2e:1'],
  [['a'], '3224db49:2'],
  [['hello'], '0b935f5c:6'],
  [['한글 😀'], '46b91a73:6'],
  [['\ud800'], '18624f00:2'],
  [['\udfff'], '8f9ad283:2'],
  [['a', 'b'], '36e65dea:4'],
  [['', ''], '32aaa723:2'],
  [['\ud83d', '\ude00'], 'ace96a70:4']
];
for (const [chunks, expected] of cases) {
  const hasher = create();
  for (const chunk of chunks) assert.equal(hasher.update(chunk), hasher);
  assert.equal(hasher.digest(), expected);
  assert.equal(hasher.digest(), expected, 'reading the digest preserves the state');
}
assert.notEqual(create().update('ab').digest(), create().update('a').update('b').digest(),
  'each update keeps its existing delimiter');
console.log('PASS stored hash identities, UTF-16 and streaming chunk boundaries');
