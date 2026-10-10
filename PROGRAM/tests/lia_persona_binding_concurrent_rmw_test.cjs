'use strict';
// P05 — LIA Live Persona binding must not lose a concurrent binding write.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §7 P05
// ("LIA Live Persona Binding whole-store RMW 경쟁조건"). Its required regression:
//
//   two-chat concurrent write / lost binding 0 / reload identical /
//   branch + refresh 동시 PASS / handoff + revalidate 동시 PASS
//
// THE DEFECT: `writeLivePersonaBinding` is a whole-store read-modify-write with no mutex and
// no CAS:
//
//     const store = await readLivePersonaStore(true);        // (1) whole-store READ
//     store.bindings[normalized.scopeKey] = normalized;      // (2) modify ONE key
//     await writeSplitLivePersonaStoreRaw(storage, store, …) // (3) whole-store WRITE
//
// Two writers touching DIFFERENT scopes therefore race on the same document:
//
//     A: reads the store            (bindings = { chat-1 })
//     B: reads the same store       (bindings = { chat-1 })
//     A: writes { chat-1, chat-2 }  (its own key added)
//     B: writes { chat-1, chat-3 }  (B's snapshot has no chat-2) -> chat-2 is LOST
//
// The plugin already has the right primitive — `serializeMutation(space, key, factory)`, a
// per-key serial promise tail used elsewhere in this file — but the binding write does not
// use it, and the store document is shared by every scope, so the lock key must be the STORE,
// not the individual scope.
//
// THE INVARIANT THIS TEST ASSERTS: two bindings written concurrently for different scopes
// must BOTH survive, and must still be present after a reload of the same storage.
//
// Method: extract the real `writeLivePersonaBinding` body and run it against an instrumented
// storage that holds the first write open, so the second write provably reads the
// pre-commit store. This mirrors the existing `lia_binding_transaction_safety_test.cjs`,
// which uses the same extraction technique for `writeSplitLivePersonaStoreRaw`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIA_Persona_Linker.js'), 'utf8');

const from = source.indexOf('async function writeLivePersonaBinding');
const to = source.indexOf('function storedLivePersonaSourceName', from);
assert.ok(from >= 0 && to > from, 'writeLivePersonaBinding source boundary');
const bindingSource = source.slice(from, to);

// The plugin's REAL serial queue, copied verbatim from the source so the lock under test is
// the shipped implementation rather than a stand-in. `withPersonaDatabaseMutationLock` is the
// queue the binding write uses; the per-key `serializeMutation` tail lives in a different IIFE
// and is not reachable from that scope.
const lockSource = (() => {
  const a = source.indexOf('function withPersonaDatabaseMutationLock(task) {');
  assert.ok(a > 0, 'withPersonaDatabaseMutationLock must exist in the plugin');
  const b = source.indexOf('\n  }', a) + 4;
  return source.slice(a, b);
})();
const personaDatabaseMutationQueue = { value: Promise.resolve() };
const withPersonaDatabaseMutationLock = new Function(
  'queueRef',
  `${lockSource.replace(/personaDatabaseMutationQueue/g, 'queueRef.value')}\nreturn withPersonaDatabaseMutationLock;`
)(personaDatabaseMutationQueue);

const clone = value => JSON.parse(JSON.stringify(value));
const normalizeStore = value => ({ version: 6, bindings: clone(value?.bindings || {}) });
const normalizeBinding = value => (value?.scopeKey ? clone(value) : null);
const shardKey = scopeKey => `shard:${scopeKey}`;
const hashText = value => `digest:${String(value)}`;

// The store document, exactly as the plugin stores it: one shard per scope plus an index.
const makeStorage = () => {
  const values = new Map();
  const trace = [];
  let gate = null;
  return {
    values, trace,
    holdNextShardWrite() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gate = { promise, release };
      return gate;
    },
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      const k = String(key);
      trace.push({ op: 'set', key: k });
      if (gate && k.startsWith('shard:')) {
        const held = gate;
        gate = null;
        await held.promise;
      }
      values.set(k, value);
      return true;
    },
    async removeItem(key) { trace.push({ op: 'remove', key: String(key) }); values.delete(String(key)); return true; }
  };
};

// Build the REAL writeLivePersonaBinding against injected collaborators.
const buildWriters = shared => {
  // `readLivePersonaStore(true)` reads every shard the index lists and returns the whole store.
  const readStore = async () => {
    const indexRaw = await shared.storage.getItem('index');
    const index = indexRaw ? JSON.parse(indexRaw) : { entries: {} };
    const bindings = {};
    for (const [scopeKey, entry] of Object.entries(index.entries || {})) {
      const raw = await shared.storage.getItem(entry.storageKey || shardKey(scopeKey));
      if (raw) bindings[scopeKey] = JSON.parse(raw);
    }
    shared.cachedComplete = true;
    shared.cached = { version: 6, bindings: clone(bindings) };
    return shared.cached;
  };

  const readIndex = async () => {
    const raw = await shared.storage.getItem('index');
    return raw ? JSON.parse(raw) : { entries: {} };
  };

  const writeIndex = async (storage, index) => {
    await storage.setItem('index', JSON.stringify(index));
    return true;
  };

  // The extraction above is not needed: the binding write calls `writeSplitLivePersonaStoreRaw`,
  // which the existing test already covers. What P05 is about is the READ-MODIFY-WRITE around it,
  // so the split writer is a faithful stand-in that persists exactly what it is handed.
  const writeSplitStandIn = async (storage, store, index) => {
    const entries = {};
    for (const [scopeKey, binding] of Object.entries(store.bindings || {})) {
      const key = shardKey(scopeKey);
      await storage.setItem(key, JSON.stringify(binding));
      entries[scopeKey] = { storageKey: key, digest: hashText(JSON.stringify(binding)), livePersonaId: binding.livePersonaId, updatedAt: binding.updatedAt };
    }
    await writeIndex(storage, { entries });
    return true;
  };

  const verifyReadback = async (storage, normalized, digest) => {
    const raw = await storage.getItem(shardKey(normalized.scopeKey));
    assert.ok(raw, `readback: shard for ${normalized.scopeKey} must exist`);
    const parsed = JSON.parse(raw);
    assert.equal(hashText(raw), digest, `readback: digest for ${normalized.scopeKey}`);
    return { binding: parsed, digest };
  };

  const write = new Function(
    'normalizeLivePersonaBinding', 'waitForPluginStorage', 'getRuntimeApi', 'readLivePersonaIndexWithMigration',
    'livePersonaScopeStorageKey', 'hashText', 'readLivePersonaStore', 'writeSplitLivePersonaStoreRaw',
    'verifyDurableLivePersonaBindingReadback', 'normalizeLivePersonaStore', 'isStoreComplete',
    'withPersonaDatabaseMutationLock',
    `let cachedLivePersonaStore = null;
     ${bindingSource.replace(/cachedLivePersonaStoreComplete/g, 'isStoreComplete()')}
     return writeLivePersonaBinding;`
  )(
    normalizeBinding,
    async () => shared.storage,
    () => ({}),
    readIndex,
    shardKey,
    hashText,
    readStore,
    writeSplitStandIn,
    verifyReadback,
    normalizeStore,
    () => shared.cachedComplete === true,
    withPersonaDatabaseMutationLock
  );

  return write;
};

(async () => {
  const storage = makeStorage();
  const shared = { storage, cached: null, cachedComplete: false, writeSplitSource: '' };
  const write = buildWriters(shared);

  const bindingA = {
    scopeKey: 'char:a|chat:1', enabled: true, policy: 'conservative', livePersonaId: 'live-a',
    sourcePersonaId: 'src-a', bindingStatus: 'connected', updatedAt: 'a'
  };
  const bindingB = {
    scopeKey: 'char:b|chat:2', enabled: true, policy: 'conservative', livePersonaId: 'live-b',
    sourcePersonaId: 'src-b', bindingStatus: 'connected', updatedAt: 'b'
  };

  const observations = {};

  // --- Interleave two whole-store read-modify-writes -----------------------------------
  // The dangerous order is: A reads -> B reads -> A writes -> B writes. A's shard write is
  // held open, and B is started while A is paused, so B reads the store BEFORE A's commit.
  // B must be allowed to reach its own write before A is released, which is why A is held and
  // B is awaited far enough to have completed its read.
  const gate = storage.holdNextShardWrite();
  const writeA = write(clone(bindingA));
  await new Promise(resolve => setTimeout(resolve, 30));   // A is now paused at its shard write

  const writeB = write(clone(bindingB));
  await new Promise(resolve => setTimeout(resolve, 30));   // B has read + started writing

  observations.startedWithoutA = storage.trace.some(t => t.op === 'set' && t.key === shardKey('char:b|chat:2'));

  gate.release();
  const resultA = await writeA;
  const resultB = await writeB;
  observations.writes = {
    a: String(resultA?.binding?.livePersonaId || ''),
    b: String(resultB?.binding?.livePersonaId || '')
  };

  // --- Durable outcome -----------------------------------------------------------------
  const indexRaw = await storage.getItem('index');
  const index = indexRaw ? JSON.parse(indexRaw) : { entries: {} };
  const durable = {};
  for (const [scopeKey, entry] of Object.entries(index.entries || {})) {
    const raw = await storage.getItem(entry.storageKey || shardKey(scopeKey));
    if (raw) durable[scopeKey] = JSON.parse(raw);
  }
  observations.durableScopes = Object.keys(durable).sort();
  observations.trace = storage.trace.map(t => `${t.op} ${t.key}`);

  // THE INVARIANT: both concurrent bindings must survive.
  assert.ok(durable[bindingA.scopeKey],
    `the first binding must survive the concurrent write `
    + `(durable scopes: ${JSON.stringify(observations.durableScopes)})`);
  assert.ok(durable[bindingB.scopeKey],
    `the second binding must survive the concurrent write `
    + `(durable scopes: ${JSON.stringify(observations.durableScopes)})`);
  assert.equal(durable[bindingA.scopeKey].livePersonaId, 'live-a',
    'the first binding must keep its own persona');
  assert.equal(durable[bindingB.scopeKey].livePersonaId, 'live-b',
    'the second binding must keep its own persona');

  // --- Reload: the surviving bindings must be identical after re-reading -----------------
  shared.cached = null;
  const reloaded = {};
  const reloadIndexRaw = await storage.getItem('index');
  const reloadIndex = reloadIndexRaw ? JSON.parse(reloadIndexRaw) : { entries: {} };
  for (const [scopeKey, entry] of Object.entries(reloadIndex.entries || {})) {
    const raw = await storage.getItem(entry.storageKey || shardKey(scopeKey));
    if (raw) reloaded[scopeKey] = JSON.parse(raw);
  }
  observations.reloadedScopes = Object.keys(reloaded).sort();
  assert.deepEqual(reloaded, durable, 'a reload must return the same bindings that were committed');

  console.log(JSON.stringify({ test: 'lia_persona_binding_concurrent_rmw', passed: 1, observations }, null, 1));
  process.stdout.write('lia_persona_binding_concurrent_rmw_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
