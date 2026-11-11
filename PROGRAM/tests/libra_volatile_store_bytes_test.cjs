'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const start = source.indexOf('    const verifiedReadCache = new Map();');
const end = source.indexOf('    const invalidateVerifiedRead =', start);
assert.ok(start >= 0 && end > start, 'extract the active verified-read cache');

const context = vm.createContext({
  state: { residentSequence: 0 },
  clone: structuredClone,
  ensureResidentBudget() {},
  VERIFIED_READ_CACHE_TTL_MS: 30000,
  VERIFIED_READ_CACHE_ENTRY_BYTES: 8192,
  VERIFIED_READ_CACHE_MAX_BYTES: 8192,
  VERIFIED_READ_CACHE_MAX: 16
});
vm.runInContext(source.slice(start, end) + '\nObject.assign(globalThis, { rememberVerifiedRead, deleteVerifiedRead, verifiedReadStats });', context);

const key = 'memory', signature = 'revision';
const bytes = value => 2 * (key.length + signature.length + JSON.stringify(value).length + 'null'.length);
for (const value of ['1111', '22', '333']) {
  context.rememberVerifiedRead(key, signature, value, false);
  assert.equal(context.verifiedReadStats.entries, 1, 'replacement keeps one entry');
  assert.equal(context.verifiedReadStats.bytes, bytes(value), 'replacement accounts only for its current payload');
}
context.deleteVerifiedRead(key);
assert.equal(context.verifiedReadStats.entries, 0);
assert.equal(context.verifiedReadStats.bytes, 0);
console.log('PASS: verified-read cache replacement and removal account for retained bytes');
