'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const fixture = require('./libra_generation_capture_receipt_fixture.cjs');

// Execute the unchanged product adapter. The Map is the physical host store;
// the fixture must observe the same bytes without substituting product reads.
function productStore() {
  const raw = new Map();
  const host = {pluginStorage: {
    async getItem(key) { return raw.get(key) ?? null; },
    async setItem(key, value) { raw.set(key, value); return true; },
    async removeItem(key) { raw.delete(key); return true; }
  }};
  const source = fs.readFileSync(path.join(__dirname, '../src/parts/01-core-runtime-compat-state-debug.js'), 'utf8');
  const start = source.indexOf('const RisuCompat = (() => {');
  const close = source.indexOf('\n    })();', start);
  assert.ok(start >= 0 && close > start, 'unchanged adapter boundary');
  const context = vm.createContext({risuai: host, console, URL, setTimeout, clearTimeout});
  vm.runInContext(source.slice(start, close + '\n    })();'.length) + '\n;globalThis.storage = RisuCompat.pluginStorage;', context);
  return {raw, storage: context.storage};
}
const rootKey = 'LIBRA_DATA::fixture-canonical-scope';
function record(size = 16) {
  return {scopeKey:'fixture-canonical-scope', resetGeneration:3, entries:[{key:'memory-1', comment:'lmai_memory', content:'한글\r\nmarker:' + 'x'.repeat(size)}]};
}
async function written(size) {
  const store = productStore(), expected = record(size), text = JSON.stringify(expected);
  assert.equal(await store.storage.setItem(rootKey, text), true);
  assert.equal(await store.storage.getItem(rootKey, {strict:true}), text, 'production physical readback is exact');
  return {...store, expected};
}
test('inline canonical roots are observed without treating unrelated stores as canonical', async () => {
  const {raw, expected} = await written(16);
  raw.set('unrelated', 'not JSON');
  assert.deepEqual(fixture.readCanonicalRecords(raw), [{key:rootKey,record:expected}]);
});
test('the real product chunk writer preserves bytes while the old 97-turn diagnostic parses a fragment', async () => {
  const {raw, expected} = await written(1024 * 1024);
  const manifest = JSON.parse(raw.get(rootKey));
  assert.equal(manifest.__libraChunkedStorageV1, true);
  assert.ok(manifest.chunks.length > 1);
  assert.throws(() => Array.from(raw).filter(([key]) => key.startsWith('LIBRA_DATA::')).map(([,value]) => JSON.parse(value)), SyntaxError);
  assert.deepEqual(fixture.readCanonicalRecords(raw), [{key:rootKey,record:expected}]);
});
test('missing chunk is a diagnostic failure and never an empty successful record', async () => {
  const {raw} = await written(600000), manifest = JSON.parse(raw.get(rootKey));
  raw.delete(manifest.chunks[0]);
  assert.throws(() => fixture.readCanonicalRecords(raw), /chunk|undefined|Missing/i);
});
for (const mutation of ['foreign','duplicate','length','root']) test('manifest ' + mutation + ' corruption remains visible', async () => {
  const {raw} = await written(600000), manifest = JSON.parse(raw.get(rootKey));
  if (mutation === 'foreign') {raw.set('foreign-fragment', raw.get(manifest.chunks[0]));manifest.chunks[0] = 'foreign-fragment';}
  if (mutation === 'duplicate') manifest.chunks.push(manifest.chunks[0]);
  if (mutation === 'length') manifest.length++;
  if (mutation === 'root') manifest.key = 'other-root';
  raw.set(rootKey, JSON.stringify(manifest));
  assert.throws(() => fixture.readCanonicalRecords(raw));
});
test('malformed canonical root still fails parsing', () => {
  assert.throws(() => fixture.readCanonicalRecords(new Map([[rootKey,'{broken']])));
});
