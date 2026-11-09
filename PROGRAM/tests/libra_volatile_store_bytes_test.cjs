'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');

assert.match(
  source,
  /const previous = store\.has\(key\) \? keyBytes \+ volatileUtf8Bytes\(store\.get\(key\)\) : 0;/,
  'overwriting a tracked entry must remove the old key and value bytes before adding the replacement'
);
assert.match(
  source,
  /const nextBytes = retainedBytes - previous \+ keyBytes \+ valueBytes;/,
  'tracked retained bytes must be computed from the complete replacement entry'
);

const utf8Bytes = value => Buffer.byteLength(String(value), 'utf8');
const retainedAfter = (retained, entries, key, value) => {
  const keyBytes = utf8Bytes(key), valueBytes = utf8Bytes(value);
  const previous = entries.has(key) ? keyBytes + utf8Bytes(entries.get(key)) : 0;
  entries.set(key, value);
  return retained - previous + keyBytes + valueBytes;
};

const entries = new Map();
let retained = retainedAfter(0, entries, 'a', '1111');
assert.equal(retained, utf8Bytes('a') + utf8Bytes('1111'));
retained = retainedAfter(retained, entries, 'a', '22');
assert.equal(retained, utf8Bytes('a') + utf8Bytes('22'));
retained = retainedAfter(retained, entries, 'a', '333');
assert.equal(retained, utf8Bytes('a') + utf8Bytes('333'));

console.log(JSON.stringify({ test: 'libra_volatile_store_bytes', passed: 5 }));
