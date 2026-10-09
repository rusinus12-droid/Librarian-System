'use strict';
// R01 CAS race: the 0.3.57 legacy-child storage-policy migration
// (`reconcileNativeBranchStoragePolicy`) and the retirement / maintenance writer
// both commit the SAME child scope manifest revision. Before the fix the
// migration did an unlocked load-modify-save, so both writers read revision N
// and the second conditional batch failed with HTTP 409
// `conditional_batch_state_changed` -> intermittent migration failure on a
// one-time data transition.
//
// This test forces the interleaving deterministically: the child manifest
// conditional batch is held at the storage-fetch boundary until a competing
// writer arrives at the same key, or a bounded hold expires. Serialized writers
// can never produce two simultaneous arrivals, so:
//   arrivals >= 1  -> the migration really reached the manifest commit point
//   overlap == false -> no two writers were inside load-modify-save at once
//   conflicts == 0   -> no CAS loss
// Asserting `arrivals >= 1` keeps the test from passing vacuously.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { clone, parent, branch } = require('./fixtures/native_branch_fixture.cjs');

// RED guard: when FLASHBACK_LEGACY_CHILD_RACE_PLUGIN_SOURCE points at an
// alternative plugin byte stream (the pre-fix revision), run against it so this
// test can be shown to FAIL on the unlocked load-modify-save and PASS on the
// locked one. Production runs use the shipped plugin.
const pluginSourceOverride = process.env.FLASHBACK_LEGACY_CHILD_RACE_PLUGIN_SOURCE
  ? fs.readFileSync(path.resolve(process.env.FLASHBACK_LEGACY_CHILD_RACE_PLUGIN_SOURCE), 'utf8')
  : null;

const ITERATIONS = Number(process.env.FLASHBACK_LEGACY_CHILD_RACE_ITERATIONS || 50);
const HOLD_MS = Number(process.env.FLASHBACK_LEGACY_CHILD_RACE_HOLD_MS || 500);
const CONFLICT_PATTERN = /conditional_batch_state_changed|FLASHBACK_COMMIT_CONFLICT|operation_id_payload_conflict|FLASHBACK_WRITER_FENCED/;

(async () => {
  const aggregate = { iterations: 0, passed: 0, conflicts: 0, overlaps: 0, arrivalsTotal: 0, maxPending: 0 };
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    aggregate.iterations += 1;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-legacy-child-race-'));
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    const address = await app.listen();

    let manifestKey = null;
    const gate = { armed: false, pending: [], arrivals: 0, overlap: false, statuses: [], pendingMax: 0 };
    const releaseAll = () => { const waiting = gate.pending.splice(0); for (const release of waiting) release(); };
    const gatedFetch = async (url, init) => {
      const target = String(url);
      let hit = false;
      if (gate.armed && manifestKey && target.includes('/v1/kv/batch')) {
        try {
          const body = JSON.parse(String((init && init.body) || ''));
          const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
          hit = mutations.length > 0 && mutations[0].key === manifestKey;
        } catch (_) { hit = false; }
      }
      if (!hit) return await fetch(url, init);
      gate.arrivals += 1;
      await new Promise(resolve => {
        gate.pending.push(resolve);
        gate.pendingMax = Math.max(gate.pendingMax, gate.pending.length);
        if (gate.pending.length >= 2) { gate.overlap = true; releaseAll(); return; }
        setTimeout(() => { const index = gate.pending.indexOf(resolve); if (index >= 0) gate.pending.splice(index, 1); resolve(); }, HOLD_MS);
      });
      const response = await fetch(url, init);
      gate.statuses.push(response.status);
      return response;
    };

    const f = await createFixture({
      exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` },
      nativeFetch: gatedFetch,
      ...(pluginSourceOverride ? { source: pluginSourceOverride } : {})
    });
    try {
      const bridge = f.context.__fixtureStorageBridge;
      assert.ok(bridge, 'fixture storage bridge exposed');
      const t = f.api._test, hostParent = parent('race-parent', 8);
      Object.assign(f.currentChat, hostParent); f.character.chats = [f.currentChat];
      const snapshot = chat => ({ character: clone(f.character), chat: clone(chat), db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 } });
      const from = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
      const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
      const records = [];
      for (let i = 1; i <= 8; i++) {
        records.push(t.cleanRecordForMemory({
          id: 'record-' + i, sourceType: 'response', sourceId: `${hostParent.id}:turn:${i}`,
          text: `User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`, title: 'Turn ' + i,
          scopeKey: from.scopeKey, pairIndex: i, turnIndex: i, tags: [], tokenCount: 8, tokens: 8,
          vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
          embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          lifecycleStatus: 'active', sourceHash: 'turn-' + i
        }, from, { authoritativeSource: true }).record);
      }
      await t.saveAllRecords(records, cfg, from);

      // Step 1: the 0.3.57-equivalent adoption runs while the parent is plugin_only.
      const parentSnapshot = clone(f.currentChat);
      const childChat = branch(parentSnapshot, 5, 'race-child');
      Object.assign(f.currentChat, childChat); f.character.chats = [f.currentChat, parentSnapshot];
      const to = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
      const childScope = { scopeId: to.scopeKey, scopeKey: to.scopeKey, characterId: to.characterId, chatId: to.chatId, aliases: [to.scopeKey, to.storageHash, to.chatId].filter(Boolean) };
      const parentStorageScope = { scopeId: from.scopeKey, scopeKey: from.scopeKey, characterId: from.characterId, chatId: from.chatId, aliases: [from.scopeKey, from.storageHash, from.chatId].filter(Boolean) };
      const adopted = await t.cloneScopeStorage(from, to, cfg, { mode: 'chat_copy_live', reason: 'legacy_child_0357' });
      assert.equal(adopted.ok, true, 'legacy adoption succeeds');
      assert.equal((await t.loadScopeManifest(to)).copyAdoptedComplete, true, 'legacy child content-adopted');
      assert.equal((await bridge.getScopeMode(childScope)).mode, 'plugin_only', 'child starts implicit plugin_only');

      // Step 2: the parent becomes server_only after the child was adopted.
      await bridge.setScopeMode(parentStorageScope, 'server_only');

      const recordsBefore = JSON.stringify((await t.loadScopeRecords(to)).records);
      const parentCommitBefore = (await t.loadScopeManifest(from)).commitId;
      const localKeyPrefix = 'vector_rag_memory:scope:';
      const localChildKeysBefore = (await f.pluginStorage.keys()).filter(k => String(k).startsWith(localKeyPrefix) && String(k).includes(String(to.storageHash || ''))).length;

      // Step 3: force the migration writer and a competing maintenance writer to
      // contend for the same manifest revision, with the batch gate armed.
      manifestKey = `vector_rag_memory:scope:${to.storageHash}:manifest:v2`;
      gate.armed = true;
      const settled = await Promise.allSettled([
        t.ensureScopeStorageReady(to, cfg),
        t.retireExternalRecordsForScope(to, { reason: 'race_concurrent_maintenance' })
      ]);
      gate.armed = false;

      const failures = settled.filter(row => row.status === 'rejected')
        .map(row => String(row.reason && (row.reason.message || row.reason)));
      const conflicts = failures.filter(message => CONFLICT_PATTERN.test(message));
      aggregate.arrivalsTotal += gate.arrivals;
      aggregate.maxPending = Math.max(aggregate.maxPending, gate.pendingMax);
      aggregate.conflicts += conflicts.length;
      if (gate.overlap) aggregate.overlaps += 1;

      assert.deepEqual(failures, [], `no writer may fail (iteration ${iteration})`);
      assert.equal(conflicts.length, 0, `no CAS conflict (iteration ${iteration}): ${conflicts.join(' | ')}`);
      assert.ok(gate.arrivals >= 1, `the migration really reached the manifest commit point (iteration ${iteration})`);
      assert.equal(gate.overlap, false, `writers are serialized, never concurrently inside load-modify-save (iteration ${iteration})`);
      assert.ok(gate.statuses.every(status => status === 200), `every manifest batch accepted (iteration ${iteration}): ${JSON.stringify(gate.statuses)}`);

      // Step 4: the migration is real, durable and non-destructive.
      assert.equal((await bridge.getScopeMode(childScope)).mode, 'server_only', `child inherited server_only (iteration ${iteration})`);
      const manifestAfter = await t.loadScopeManifest(to);
      const binding = manifestAfter.nativeBranchCopy && manifestAfter.nativeBranchCopy.storageBinding;
      assert.ok(binding, `migration receipt persisted (iteration ${iteration})`);
      assert.equal(binding.targetModeOrigin, 'migrated', `receipt origin recorded (iteration ${iteration})`);
      assert.equal(binding.migration && binding.migration.migrated, true, `migration evidence recorded (iteration ${iteration})`);
      assert.equal(binding.migration && binding.migration.retainedLocal, true, `local bytes retained (iteration ${iteration})`);

      const recordsAfter = (await t.loadScopeRecords(to)).records;
      assert.equal(JSON.stringify(recordsAfter), recordsBefore, `no duplicate / mutated canonical record (iteration ${iteration})`);
      assert.equal(recordsAfter.filter(r => r.archiveReferenceOnly !== true).length, JSON.parse(recordsBefore).length, `record count unchanged (iteration ${iteration})`);
      assert.equal((await t.loadScopeManifest(from)).commitId, parentCommitBefore, `parent manifest unchanged (iteration ${iteration})`);
      const localChildKeysAfter = (await f.pluginStorage.keys()).filter(k => String(k).startsWith(localKeyPrefix) && String(k).includes(String(to.storageHash || ''))).length;
      assert.equal(localChildKeysAfter, localChildKeysBefore, `no duplicate local migration layer (iteration ${iteration})`);

      // Step 5: a repeat pass must stay idempotent (no second binding layer).
      const repeat = await Promise.allSettled([
        t.ensureScopeStorageReady(to, cfg),
        t.retireExternalRecordsForScope(to, { reason: 'race_concurrent_maintenance_repeat' })
      ]);
      const repeatFailures = repeat.filter(row => row.status === 'rejected').map(row => String(row.reason && (row.reason.message || row.reason)));
      assert.deepEqual(repeatFailures, [], `idempotent repeat has no failure (iteration ${iteration})`);
      const manifestRepeat = await t.loadScopeManifest(to);
      assert.equal(manifestRepeat.nativeBranchCopy.storageBinding.committedAt, binding.committedAt, `original receipt preserved on repeat (iteration ${iteration})`);
      assert.equal(JSON.stringify((await t.loadScopeRecords(to)).records), recordsBefore, `records unchanged on repeat (iteration ${iteration})`);

      aggregate.passed += 1;
    } finally {
      await f.dispose(); await app.close(); fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  assert.equal(aggregate.conflicts, 0, 'zero CAS conflicts across all iterations');
  assert.equal(aggregate.overlaps, 0, 'zero concurrent load-modify-save windows across all iterations');
  assert.ok(aggregate.arrivalsTotal >= ITERATIONS, 'every iteration exercised the manifest commit point');
  console.log(JSON.stringify({
    test: 'native_branch_flashback_legacy_child_migration_concurrency',
    passed: aggregate.passed, iterations: aggregate.iterations,
    http_409: 0, duplicate_copies: 0, parent_mutations: 0,
    manifestCommitsObserved: aggregate.arrivalsTotal, concurrentWindows: aggregate.overlaps
  }));
})().catch(e => { console.error(e); process.exitCode = 1; });
