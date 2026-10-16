'use strict';
// N05: Storage Owner Durable Inventory, Namespace Fence, and Lifecycle Protection GC Suite
//
// Verifies §8 of LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md:
// 1. Owner without namespace fence refuses real deletion (blocked_atomic_gc_unavailable).
// 2. Incomplete inventory aborts before candidate selection (blocked_incomplete_inventory).
// 3. Multi-tier reachability protects corpus roots, manifests, pages, proofs, and checkpoints.
// 4. In-progress builds with uncommitted working pages are strictly protected.
// 5. Active reader pins/leases protect unreferenced historical generations until expiration.
// 6. Expired leases allow safe reclaiming of orphaned assets.
// 7. Concurrent root or candidate mutations abort the sweep without data loss.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const createPages = require('../tools/libra_memory_graph_pages.cjs');
const createStore = require('../tools/libra_memory_graph_store.cjs');

const fingerprint = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const options = { canonicalCursor: '', microCursor: '', limit: 20, nodeLimit: 2048 };

const makeStoreFixture = () => {
  const values = new Map([['source', 'original']]);
  const events = [];
  const activeBuilds = [];
  const activeReaders = [];
  const pages = createPages({ fingerprint });
  const store = createStore({ pages, fingerprint });

  const graph = {
    schema: 'libra.memory_graph_projection.v1',
    scopeKey: 'scope-gc',
    readerFrame: {
      owner: 'libra:fixture',
      scopeKey: 'scope-gc',
      worldlineId: 'main',
      restoreEpoch: 0,
      view: { viewerId: 'owner_reader' }
    },
    coverage: { inventory: { inventoryComplete: false } },
    nodes: Array.from({ length: 4 }, (_, i) => ({ id: 'n' + i, bindingId: 'b' + i })),
    edges: [{ id: 'e0', bindingId: 'edge' }],
    bases: [{ id: 'basis', bindingId: 'reason' }],
    units: Array.from({ length: 4 }, (_, i) => ({
      nodeId: 'n' + i,
      family: ['canonical', 'micro', 'state', 'lore'][i],
      text: 'content-unit-' + i
    }))
  };

  let hasFenceCapability = true;
  let beforeDeleteHook = () => {};

  const owner = {
    publication: 'test_durable_fence',
    check() {},
    async read(key) { return values.get(key) ?? null; },
    async putImmutable(key, raw) {
      if (values.has(key)) throw new Error('write_conflict');
      events.push(key);
      values.set(key, raw);
    },
    async capture(keys) {
      return keys.map(key => ({ key, raw: values.get(key) ?? null }));
    },
    async assertCaptured(pin) {
      for (const item of pin) {
        if ((values.get(item.key) ?? null) !== item.raw) throw new Error('source_pin_changed');
      }
    },
    async commitRoot({ key, raw, previous, expected, sourcePin }) {
      await this.assertCaptured(sourcePin);
      for (const row of expected) {
        if (values.get(row.key) !== row.raw) throw new Error('page_changed');
      }
      if ((values.get(key) ?? null) !== previous) throw new Error('root_conflict');
      events.push(key);
      values.set(key, raw);
    },
    async listKeys(prefix) {
      return [...values.keys()].filter(k => k.startsWith(prefix)).sort();
    },
    async captureGCInventory(prefix) {
      const keys = await this.listKeys(prefix);
      if (!hasFenceCapability) {
        return { keys, complete: true, fence: null };
      }
      return {
        schema: 'libra.storage_namespace_inventory.v1',
        keys,
        complete: true,
        fence: {
          fenceId: 'fence-epoch-1',
          epoch: 1,
          namespace: prefix,
          issuedAtMs: Date.now(),
          activeBuilds: activeBuilds.map(clone),
          activeReaders: activeReaders.map(clone)
        }
      };
    },
    async deleteConditional({ key, expectedRaw, prefix, inventory, roots, protectedKeys, fence }) {
      beforeDeleteHook();
      if (!hasFenceCapability || !fence) return false;
      if (protectedKeys && protectedKeys.includes(key)) return false;

      // Ensure roots haven't changed
      for (const r of roots) {
        if (values.get(r.key) !== r.raw) return false;
      }
      if (values.get(key) !== expectedRaw) return false;

      values.delete(key);
      return true;
    },
    setFenceCapability(enabled) { hasFenceCapability = Boolean(enabled); },
    setBeforeDeleteHook(fn) { beforeDeleteHook = fn || (() => {}); },
    registerBuild(build) { activeBuilds.push(build); },
    clearBuilds() { activeBuilds.length = 0; },
    registerReader(reader) { activeReaders.push(reader); },
    clearReaders() { activeReaders.length = 0; }
  };

  const snapshot = async () => ({ graph: clone(graph), sourceKeys: ['source'] });

  return {
    values,
    events,
    pages,
    store,
    graph,
    owner,
    snapshot,
    build: extra => store.build({
      snapshot,
      owner,
      sourceOptions: options,
      pageBytes: 512,
      jobToken: 'job-' + events.length,
      ...extra
    }),
    read: extra => store.read({ snapshot, owner, sourceOptions: options, ...extra }),
    rootKey: () => store.location(graph, options).rootKey
  };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('N05: owner without namespace fence blocks deletion with blocked_atomic_gc_unavailable', async () => {
  const fx = makeStoreFixture();
  await fx.build();
  const prefix = 'libra:v1:scope:scope-gc:memory-graph:v1:';
  const orphanKey = prefix + 'page:units:' + '9'.repeat(64);
  fx.values.set(orphanKey, JSON.stringify({ orphan: true }));

  // Disable fence capability
  fx.owner.setFenceCapability(false);

  const dry = await fx.store.collectGarbage({ owner: fx.owner, scopeKey: 'scope-gc', dryRun: true });
  assert.equal(dry.status, 'completed');
  assert.equal(dry.dryRun, true);
  assert.ok(dry.candidateKeys.includes(orphanKey));
  assert.equal(dry.deletedKeys.length, 0);

  const swept = await fx.store.collectGarbage({ owner: fx.owner, scopeKey: 'scope-gc', dryRun: false });
  assert.equal(swept.status, 'blocked_atomic_gc_unavailable');
  assert.deepEqual(swept.deletedKeys, []);
  assert.equal(fx.values.has(orphanKey), true, 'orphan must remain untouched when fence is missing');
});

test('N05: incomplete inventory returns blocked_incomplete_inventory without deleting', async () => {
  const fx = makeStoreFixture();
  await fx.build();

  const brokenOwner = {
    ...fx.owner,
    async captureGCInventory() {
      return { keys: [], complete: false, fence: null };
    }
  };

  const res = await fx.store.collectGarbage({ owner: brokenOwner, scopeKey: 'scope-gc' });
  assert.equal(res.status, 'blocked_incomplete_inventory');
  assert.deepEqual(res.deletedKeys, []);
});

test('N05: in-progress builds protect uncommitted working pages from deletion', async () => {
  const fx = makeStoreFixture();
  await fx.build();
  const prefix = 'libra:v1:scope:scope-gc:memory-graph:v1:';

  // Simulate an ongoing build that has written a working page not yet published to root
  const buildWorkingPage = prefix + 'page:units:' + 'a'.repeat(64);
  const trueOrphanPage = prefix + 'page:units:' + 'b'.repeat(64);
  fx.values.set(buildWorkingPage, JSON.stringify({ inProgressBuild: true }));
  fx.values.set(trueOrphanPage, JSON.stringify({ trueOrphan: true }));

  // Register in-progress build in owner fence
  const now = Date.now();
  fx.owner.registerBuild({
    id: 'build-job-in-progress-1',
    scopeKey: 'scope-gc',
    workingKeys: [buildWorkingPage],
    startedAtMs: now,
    expiresAtMs: now + 30000 // 30s lease
  });

  const gc = await fx.store.collectGarbage({
    owner: fx.owner,
    scopeKey: 'scope-gc',
    dryRun: false,
    nowMs: now
  });

  assert.equal(gc.status, 'completed');
  assert.equal(gc.protectedBuildCount, 1, 'in-progress build must be recognized and counted');
  assert.ok(!gc.candidateKeys.includes(buildWorkingPage), 'working page must NOT be a candidate');
  assert.ok(gc.candidateKeys.includes(trueOrphanPage), 'true orphan page must be a candidate');
  assert.deepEqual(gc.deletedKeys, [trueOrphanPage]);
  assert.equal(fx.values.has(buildWorkingPage), true, 'working page must be preserved');
  assert.equal(fx.values.has(trueOrphanPage), false, 'true orphan page must be deleted');
});

test('N05: active reader lease protects unreferenced generation until lease expires', async () => {
  const fx = makeStoreFixture();
  await fx.build(); // Root Gen 1
  const rootKey = fx.rootKey();
  const gen1Root = JSON.parse(fx.values.get(rootKey));
  const gen1ManifestKey = gen1Root.manifestKey;
  const gen1Manifest = JSON.parse(fx.values.get(gen1ManifestKey));
  const gen1PageKey = gen1Manifest.pages[0].key;

  // Mutate graph and build Gen 2, superseding Gen 1
  fx.graph.nodes[0].bindingId = 'modified-b0';
  await fx.build(); // Root Gen 2
  const gen2Root = JSON.parse(fx.values.get(rootKey));
  assert.notEqual(gen2Root.generation, gen1Root.generation);

  // A reader has pinned Gen 1
  const now = 100000;
  fx.owner.registerReader({
    id: 'reader-lease-active',
    scopeKey: 'scope-gc',
    generationKey: gen1ManifestKey,
    pageKeys: [gen1PageKey],
    acquiredAtMs: now - 5000,
    expiresAtMs: now + 25000 // Valid until 125000
  });

  // GC at time 100000 (lease active)
  const gcActive = await fx.store.collectGarbage({
    owner: fx.owner,
    scopeKey: 'scope-gc',
    dryRun: false,
    nowMs: now
  });

  assert.equal(gcActive.status, 'completed');
  assert.equal(gcActive.protectedReaderCount, 1);
  assert.ok(!gcActive.candidateKeys.includes(gen1ManifestKey), 'leased generation must NOT be candidate');
  assert.ok(!gcActive.candidateKeys.includes(gen1PageKey), 'leased page must NOT be candidate');
  assert.equal(fx.values.has(gen1ManifestKey), true);
  assert.equal(fx.values.has(gen1PageKey), true);

  // Advance time past expiration: 130000 (> 125000)
  const gcExpired = await fx.store.collectGarbage({
    owner: fx.owner,
    scopeKey: 'scope-gc',
    dryRun: false,
    nowMs: 130000
  });

  assert.equal(gcExpired.status, 'completed');
  assert.equal(gcExpired.protectedReaderCount, 0, 'expired lease is no longer protected');
  assert.ok(gcExpired.candidateKeys.includes(gen1ManifestKey), 'expired generation is now candidate');
  assert.ok(gcExpired.deletedKeys.includes(gen1ManifestKey), 'expired generation deleted');
  assert.equal(fx.values.has(gen1ManifestKey), false);
});

test('N05: multi-tier reachability retains corpus roots, manifests, checkpoints, and proofs', async () => {
  const fx = makeStoreFixture();
  await fx.build();
  const prefix = 'libra:v1:scope:scope-gc:memory-graph:v1:';
  const corpusPrefix = prefix + 'corpus:';

  // Inject corpus assets into namespace
  const corpusManifestKey = corpusPrefix + 'manifest:' + 'c'.repeat(64);
  const corpusProofKey = corpusPrefix + 'proof:' + 'd'.repeat(64);
  const corpusPageKey = corpusPrefix + 'page:units:' + 'e'.repeat(64);
  const corpusRootKey = corpusPrefix + 'root:current';
  const corpusCheckpointKey = corpusPrefix + 'checkpoint:turn-5';

  fx.values.set(corpusProofKey, JSON.stringify({ proof: true }));
  fx.values.set(corpusPageKey, JSON.stringify([{ id: 'c-unit' }]));
  fx.values.set(corpusManifestKey, JSON.stringify({
    schema: 'libra.memory_graph_corpus_manifest.v1',
    proofKey: corpusProofKey,
    pages: [{ key: corpusPageKey }]
  }));
  fx.values.set(corpusRootKey, JSON.stringify({
    schema: 'libra.memory_graph_corpus_root.v1',
    digest: 'c'.repeat(64),
    manifestKey: corpusManifestKey
  }));
  fx.values.set(corpusCheckpointKey, JSON.stringify({
    schema: 'libra.memory_graph_corpus_checkpoint.v1',
    turn: 5
  }));

  // Also inject a true window graph orphan
  const windowOrphan = prefix + 'page:units:' + 'f'.repeat(64);
  fx.values.set(windowOrphan, JSON.stringify({ orphan: true }));

  const gc = await fx.store.collectGarbage({
    owner: fx.owner,
    scopeKey: 'scope-gc',
    dryRun: false
  });

  assert.equal(gc.status, 'completed');
  assert.equal(gc.activeCorpusRoots, 1, 'corpus root must be indexed');
  assert.ok(gc.retainedCorpusKeyCount >= 4, 'corpus assets must be retained');
  assert.deepEqual(gc.deletedKeys, [windowOrphan]);
  assert.equal(fx.values.has(corpusRootKey), true, 'corpus root preserved');
  assert.equal(fx.values.has(corpusManifestKey), true, 'corpus manifest preserved');
  assert.equal(fx.values.has(corpusProofKey), true, 'corpus proof preserved');
  assert.equal(fx.values.has(corpusPageKey), true, 'corpus page preserved');
  assert.equal(fx.values.has(corpusCheckpointKey), true, 'corpus checkpoint preserved');
  assert.equal(fx.values.has(windowOrphan), false, 'window orphan deleted');
});

test('N05: concurrent mutation during delete phase aborts sweep without data loss', async () => {
  const fx = makeStoreFixture();
  await fx.build();
  const prefix = 'libra:v1:scope:scope-gc:memory-graph:v1:';
  const orphanKey = prefix + 'page:units:' + '1'.repeat(64);
  fx.values.set(orphanKey, JSON.stringify({ orphan: true }));

  // Simulate concurrent root modification right before deleteConditional
  const rootKey = fx.rootKey();
  const initialRoot = fx.values.get(rootKey);
  fx.owner.setBeforeDeleteHook(() => {
    fx.values.set(rootKey, JSON.stringify({ concurrentRootUpdate: true }));
  });

  const gc = await fx.store.collectGarbage({
    owner: fx.owner,
    scopeKey: 'scope-gc',
    dryRun: false
  });

  assert.equal(gc.status, 'aborted_concurrent_mutation');
  assert.deepEqual(gc.deletedKeys, []);
  assert.equal(fx.values.has(orphanKey), true, 'candidate must be preserved on race');
});

test('N05: inspect exposes lifecycle protection and multi-tier reachability properties', () => {
  const fx = makeStoreFixture();
  const s = fx.store.inspect();
  assert.equal(s.schema, 'libra.graph_store.v1');
  assert.equal(s.rootGCImplemented, true);
  assert.equal(s.gcDeletionRequirement, 'complete_durable_inventory_and_atomic_namespace_fence_for_publishers_and_readers');
  assert.ok(s.gcLifecycleProtection);
  assert.deepEqual(s.gcLifecycleProtection.multiTierReachability, ['window_graph', 'corpus', 'checkpoint', 'representation']);
  assert.equal(s.gcLifecycleProtection.inProgressBuildProtection, true);
  assert.equal(s.gcLifecycleProtection.readerLeaseProtection, true);
  assert.equal(s.gcLifecycleProtection.leaseExpirationSupported, true);
});

const run = async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nAll ${passed}/${tests.length} N05 storage lifecycle and GC tests passed.`);
};

run();
