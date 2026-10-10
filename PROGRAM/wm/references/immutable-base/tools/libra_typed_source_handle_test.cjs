'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./libra_recall_test_runtime.cjs');

async function runtime() {
  const r = await load({ transformCode(code) {
    const i = code.lastIndexOf('\n})();');
    return code.slice(0, i) + '\n;globalThis.__SOURCE_HANDLE_TEST__={runtime:TypedSemanticRuntime,corpus:TypedRecallCorpus,compat:RisuCompat};\n' + code.slice(i);
  } });
  return { ...r, ...r.context.__SOURCE_HANDLE_TEST__ };
}
const oversizedEntries = () => [{ key: 'lmai_memory::source', comment: 'lmai_memory',
  content: '[META:{"t":1,"ttl":-1}]\n' + 'source evidence '.repeat(300000) }];
async function verifiedSnapshot(r, entries = oversizedEntries(), resetGeneration = 0) {
  const scope = r.api.LibraDataStorage.scopeKeyFor(r.char, r.chat);
  await r.compat.pluginStorage.setItem(r.api.LibraDataStorage.storageKeyFor(scope), JSON.stringify({ scopeKey: scope, resetGeneration, entries }));
  const read = await r.api.LibraDataStorage.readVerified(scope, { readonly: true });
  assert.equal(read.ok, true);
  const snapshot = r.corpus.capture(r.char, r.chat, { verifiedCanonicalEntries: read.entries, resetGeneration, currentTurn: 1 });
  return { snapshot, read, scope };
}

test('verified immutable canonical sources use a bounded request handle without dropping source bytes', async () => {
  const r = await runtime(), { snapshot, read } = await verifiedSnapshot(r);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 4194304, 'reproduce the actual full-source copy bound');
  const captured = r.runtime.capture(snapshot);
  assert.equal(captured.canonicalLore, read.entries, 'request references the strictly verified immutable source');
  assert.equal(captured.canonicalLore[0].content, oversizedEntries()[0].content);
  assert.equal(r.runtime.capture(captured).canonicalLore, captured.canonicalLore);
  assert.ok(Object.isFrozen(captured.canonicalLore[0]));
  assert.throws(() => r.runtime.capture(JSON.parse(JSON.stringify(snapshot))), /snapshot_bytes_bound/, 'unissued copies retain the existing whole-input bound');
  r.chat.localLore = oversizedEntries();
  assert.throws(() => r.runtime.capture(r.corpus.capture(r.char, r.chat)), /snapshot_bytes_bound/, 'host/public captures do not mint a storage source proof');
});

test('source handles retain scope/reset provenance and the same request-frame byte bound', async () => {
  const r = await runtime(), { read } = await verifiedSnapshot(r);
  const wrongReset = r.corpus.capture(r.char, r.chat, { verifiedCanonicalEntries: read.entries, resetGeneration: 9 });
  assert.throws(() => r.runtime.capture(wrongReset), /snapshot_bytes_bound/);
  r.chat.id = 'other-source-scope';
  const foreign = r.corpus.capture(r.char, r.chat, { verifiedCanonicalEntries: read.entries, resetGeneration: 0 });
  assert.throws(() => r.runtime.capture(foreign), /snapshot_bytes_bound/);
  r.chat.id = 'anchor-memo';
  const largeFrame = r.corpus.capture(r.char, r.chat, { verifiedCanonicalEntries: read.entries, resetGeneration: 0,
    ephemeralDriftExclusion: { evidence: 'request frame '.repeat(400000) } });
  assert.throws(() => r.runtime.capture(largeFrame), /snapshot_bytes_bound/, 'source handles cannot expand frame budgets');
});

test('same-ID source updates, deletion and failed strict reads cannot reuse an old handle as current', async () => {
  const r = await runtime(), first = await verifiedSnapshot(r);
  const entries = oversizedEntries(); entries[0].content += '\nsource update';
  const changed = await verifiedSnapshot(r, entries, 2);
  assert.notEqual(changed.snapshot.corpusRevision, first.snapshot.corpusRevision);
  assert.notEqual(r.runtime.capture(changed.snapshot).canonicalLore, r.runtime.capture(first.snapshot).canonicalLore);
  const state = r.runtime.state(first.snapshot.scopeKey);
  assert.equal(r.runtime.install(state, changed.snapshot), true);
  assert.equal(r.runtime.install(state, first.snapshot), false, 'an older issued source cannot replace an observed newer generation');
  const empty = await verifiedSnapshot(r, [], 2);
  assert.equal(r.runtime.capture(empty.snapshot).canonicalLore.length, 0);
  assert.equal(r.runtime.install(state, empty.snapshot), true);
  assert.equal(r.runtime.install(state, changed.snapshot), false, 'a deleted source cannot be restored by its old handle');
  await verifiedSnapshot(r, entries, 2);
  const key = r.api.LibraDataStorage.storageKeyFor(first.scope), manifest = JSON.parse(r.store.get(key));
  assert.ok(manifest.__libraChunkedStorageV1);
  r.store.delete(manifest.chunks[0]);
  assert.equal((await r.api.LibraDataStorage.readVerified(first.scope, { readonly: true })).ok, false);
  assert.equal(Boolean(r.runtime.current(state, first.snapshot, 0)), false, 'capturing an old source does not install it as current');
});
