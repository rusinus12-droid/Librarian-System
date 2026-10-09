'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const acorn = require('acorn');

// Execute the release artifact's unchanged adapter expression. Faults live only
// at the physical host boundary; no product save/readback function is replaced.
const artifact = process.env.LIBRA_STORAGE_OUTCOME_DIST || path.join(__dirname, '../dist/LIBRA World Manager Full.js');
const code = fs.readFileSync(artifact, 'utf8');
let adapter;
const pending = [acorn.parse(code, {ecmaVersion: 'latest'})];
while (pending.length) {
  const node = pending.pop();
  if (!node || typeof node !== 'object') continue;
  if (node.type === 'VariableDeclarator' && node.id?.name === 'RisuCompat') { adapter = code.slice(node.init.start, node.init.end); break; }
  for (const value of Object.values(node)) if (Array.isArray(value)) pending.push(...value); else if (value && typeof value === 'object') pending.push(value);
}
assert(adapter, 'release adapter expression found');
const root = 'LMAI_Config';
const fixture = () => {
  const raw = new Map(), calls = [], control = {};
  const host = {pluginStorage: {
    async getItem(key) {
      calls.push(['get', key]);
      if (control.read) return control.read(key, raw);
      return raw.get(key) ?? null;
    },
    async setItem(key, value) {
      calls.push(['set', key, value]);
      if (control.write) return control.write(key, value, raw);
      raw.set(key, value); return true;
    },
    async removeItem(key) { calls.push(['remove', key]); raw.delete(key); return true; }
  }};
  const context = vm.createContext({risuai: host, console, URL, setTimeout, clearTimeout});
  vm.runInContext('globalThis.storage = (' + adapter + ').pluginStorage;', context);
  return {raw, calls, control, storage: context.storage};
};
async function captureFailure(task) {
  let error;
  try { await task; } catch (e) { error = e; }
  assert(error, 'strict mutation must expose its failed outcome');
  return error;
}
for (const size of [32, 600000]) for (const kind of ['throw', 'mismatch']) {
  test(`${size > 32 ? 'chunked' : 'inline'} ${kind} root readback exposes uncertainty and preserves both generations`, async () => {
    const f = fixture(), old = 'old:' + 'o'.repeat(600000), next = 'new:' + 'n'.repeat(size);
    assert.equal(await f.storage.setItem(root, old), true);
    const oldRoot = f.raw.get(root), oldChunks = JSON.parse(oldRoot).chunks;
    let issued = false;
    f.control.write = (key, value, raw) => { raw.set(key, value); if (key === root) issued = true; return true; };
    f.control.read = (key, raw) => {
      if (key === root && issued) { if (kind === 'throw') throw new Error('physical read unavailable'); return oldRoot; }
      return raw.get(key) ?? null;
    };
    const error = await captureFailure(f.storage.setItem(root, next, {strict:true}));
    assert.equal(error.storageWriteUnverified, true, 'issued root publication is not an ordinary rejected write');
    assert.notEqual(f.raw.get(root), oldRoot, 'no compensating rollback');
    assert(oldChunks.every(key => f.raw.has(key)), 'uncertain outcome must not delete the previous chunks');
    delete f.control.read; delete f.control.write;
    assert.equal(await f.storage.getItem(root, {strict:true}), next, 'fresh physical read recovers the issued value');
  });
}
for (const kind of ['false', 'throw', 'readback']) test(`chunk ${kind} failure leaves old canonical root and no root uncertainty`, async () => {
  const f = fixture(), old = 'old:' + 'o'.repeat(600000);
  await f.storage.setItem(root, old);
  const oldRoot = f.raw.get(root), oldChunks = JSON.parse(oldRoot).chunks;
  f.control.write = (key, value, raw) => {
    if (key !== root) {
      if (kind === 'false') return false;
      if (kind === 'throw') throw new Error('chunk failure');
    }
    raw.set(key, value); return true;
  };
  if (kind === 'readback') f.control.read = (key, raw) => key !== root && !oldChunks.includes(key) ? 'corrupt chunk' : (raw.get(key) ?? null);
  const before = f.calls.length;
  const error = await captureFailure(f.storage.setItem(root, 'new:' + 'n'.repeat(600000), {strict:true}));
  assert.notEqual(error.storageWriteUnverified, true, 'unpublished chunks cannot replace the canonical settings');
  assert.equal(f.raw.get(root), oldRoot);
  assert.equal(f.calls.slice(before).filter(call => call[0] === 'set' && call[1] === root).length, 0);
  assert(oldChunks.every(key => f.raw.has(key)));
  delete f.control.read; delete f.control.write;
  assert.equal(await f.storage.getItem(root, {strict:true}), old);
});
test('false acknowledgment without a write still leaves the invoked root outcome uncertain', async () => {
  const f = fixture(); f.raw.set(root, 'old');
  f.control.write = () => false;
  const error = await captureFailure(f.storage.setItem(root, 'next', {strict:true}));
  assert.equal(error.storageWriteUnverified, true, 'false acknowledgment alone is not proof of no mutation');
  assert.equal(f.raw.get(root), 'old');
});
for (const size of [32, 600000]) test(`false acknowledgment after publishing ${size > 32 ? 'chunked' : 'inline'} root preserves uncertainty`, async () => {
  const f = fixture(); f.raw.set(root, 'old');
  const next = 'next:' + 'n'.repeat(size);
  f.control.write = (key, value, raw) => { raw.set(key, value); return key === root ? false : true; };
  const error = await captureFailure(f.storage.setItem(root, next, {strict:true}));
  assert.equal(error.storageWriteUnverified, true, 'false after write must fence the old settings view');
  delete f.control.write;
  assert.equal(await f.storage.getItem(root, {strict:true}), next, 'issued value remains physically stored');
});
test('host throws after publishing root: strict caller sees uncertainty and no rollback', async () => {
  const f = fixture(); f.raw.set(root, 'old');
  f.control.write = (key, value, raw) => { raw.set(key, value); throw new Error('ack lost'); };
  const error = await captureFailure(f.storage.setItem(root, 'next', {strict:true}));
  assert.equal(error.storageWriteUnverified, true);
  assert.equal(f.raw.get(root), 'next');
});
test('legacy callers keep boolean failure and acknowledged void/true success', async () => {
  const f = fixture(); let issued = false;
  f.control.write = (key, value, raw) => { raw.set(key, value); issued = true; return true; };
  f.control.read = (key, raw) => { if (issued) throw new Error('readback failure'); return raw.get(key) ?? null; };
  assert.equal(await f.storage.setItem(root, 'next'), false);
  assert.equal(f.raw.get(root), 'next');
  delete f.control.read;
  for (const ack of [undefined, true]) {
    f.control.write = (key, value, raw) => { raw.set(key, value); return ack; };
    assert.equal(await f.storage.setItem(root, 'verified:' + ack, {strict:true}), true);
    assert.equal(await f.storage.getItem(root, {strict:true}), 'verified:' + ack);
  }
});
test('successful replacement cleans old chunks only after exact root readback', async () => {
  const f = fixture(); await f.storage.setItem(root, 'o'.repeat(600000));
  const oldChunks = JSON.parse(f.raw.get(root)).chunks, start = f.calls.length;
  assert.equal(await f.storage.setItem(root, 'new', {strict:true}), true);
  assert(oldChunks.every(key => !f.raw.has(key)));
  const calls = f.calls.slice(start), set = calls.findIndex(c => c[0] === 'set' && c[1] === root);
  assert.equal(calls[set + 1][0], 'get'); assert.equal(calls[set + 1][1], root);
  assert(calls.findIndex(c => c[0] === 'remove') > set + 1);
});
