'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createArchiveOwnerFixture, canonicalNonVector, canonicalIdentity, plain, parse, syntheticResponse }
  = require('./fixtures/archive_owner_fixture.cjs');

const {establishExplicitLocalRoute}=require('./fixtures/flashback_explicit_route_fixture.cjs');

const counts = preview => preview.counts;
const registry = manifest => typeof manifest.embeddingAttemptRegistry === 'string'
  ? JSON.parse(manifest.embeddingAttemptRegistry) : manifest.embeddingAttemptRegistry;
const noEffects = f => {
  const o = f.observation;
  assert.equal(o.requests.length, 0, 'no provider, query, metadata or server request');
  assert.equal(o.writes.length, 0, 'no plugin or local writes');
  assert.equal(o.removals.length, 0, 'no cleanup or removal');
  assert.equal(o.argumentWrites.length, 0, 'no credential synchronization');
};
const noCheckpointEffects = f => {
  for (const event of [...f.observation.reads, ...f.observation.writes, ...f.observation.removals])
    assert.doesNotMatch(event.key, /checkpoint/i, 'archive worker must bypass checkpoints');
  assert.equal(f.observation.enumerations.length, 0, 'archive action uses a frozen declared key set, not inventory enumeration');
  assert.equal(f.observation.argumentWrites.length, 0);
};

test('public archive preview selects a complete multi-chunk source without physical effects', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, true, JSON.stringify(preview));
    assert.equal(preview.allowed, true);
    assert(preview.ticket && typeof preview.ticket === 'object', 'ticket is an opaque object');
    assert.equal(counts(preview).eligibleRecords, f.selectedBefore.length);
    assert.equal(counts(preview).eligibleGroups, 1);
    assert.equal(counts(preview).remainingGroups, 1, 'one other complete source remains');
    assert.equal(counts(preview).excludedGroups, 0);
    assert.equal(counts(preview).excludedRecords, 0);
    noEffects(f); noCheckpointEffects(f);
    assert.deepEqual(f.snapshot(), before);
    assert(!JSON.stringify(preview).includes('test-secret-not-for-output'));
    assert(!JSON.stringify(preview).includes('The brass compass waits'), 'preview does not duplicate raw source text');
  } finally { await f.dispose(); }
});

test('one archive group publishes immutable vectors with durable submission and complete-source preservation', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    const localBefore = await f.seedLocal();
    f.startObservation();
    const observedSubmissions = [];
    f.setProviderHook((entry, init) => {
      const submitted = Object.values(registry(entry.owner)?.entries || {}).filter(item => item.state === 'submitted');
      assert.equal(submitted.length, 1, 'owner submission is physically durable at each document wire');
      const attempt = submitted[0];
      assert(attempt.archiveBinding?.operationId);
      assert(attempt.archiveBinding?.candidateScopeKey);
      assert(attempt.archiveBinding?.headWitness);
      assert(attempt.archiveBinding?.sourceWitness);
      assert(attempt.archiveBinding?.targetWitness);
      assert.equal(attempt.jobs.length, f.selectedBefore.length, 'reservation binds every chunk of the selected source');
      assert.equal(new Set(attempt.jobs.map(job => job.logicalJobId)).size, f.selectedBefore.length);
      observedSubmissions.push(attempt);
      return syntheticResponse(init);
    });
    const preview = await f.archive().preview();
    assert.equal(preview.actionable, true, JSON.stringify(preview));
    const result = await f.archive().repair(preview.ticket);
    assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(result.archiveReembedded, f.selectedBefore.length);
    assert.equal(result.provider.state, 'completed');
    assert.equal(result.candidates.state, 'verified');
    assert.equal(result.publication.state, 'verified');
    assert.equal(result.journal.state, 'verified');
    assert.equal(result.provider.requests.length, f.observation.requests.length);
    assert.equal(f.observation.requests.length, 1, 'bounded ordinary group uses one document wire and no provider preflight');
    assert.equal(observedSubmissions.length, 1);
    assert.deepEqual(f.observation.requests[0].body.input,
      f.selectedBefore.slice().sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map(row => f.audit.prepareEmbeddingInput(row.text, 'document', f.targetSettings)),
      'wire contains exactly the selected complete source, in chunk order, without local/unselected text');
    assert(result.candidates.receipts.length > 0);
    noCheckpointEffects(f);
    assert.equal(f.observation.writes.filter(event => event.store === 'local').length, 0, 'inline archive candidate performs no local sidecar or cache write');
    assert.equal(f.observation.removals.length, 0, 'no predecessor/orphan/sidecar cleanup');
    f.assertProtectedUnchanged();
    assert.deepEqual(plain(await f.readLocal()), localBefore, 'active local rows remain exact and are never archive staging');

    const manifest = f.physicalManifest(f.scope.scopeKey);
    assert.notEqual(manifest.archiveRef.archiveScopeKey, f.originalRef.archiveScopeKey);
    assert.equal(manifest.archiveRef.depth, f.originalRef.depth + 1);
    assert.equal(manifest.archiveRef.recordCount, f.beforeRows.length);
    assert.equal(manifest.archiveRef.deltaCount, f.selectedBefore.length);
    const { parentRef: _previousParent, ...oldPointer } = f.originalRef;
    assert.deepEqual(plain(manifest.archiveRef.parentRef), oldPointer);
    const receipt = manifest.archiveRepairReceipt;
    assert.equal(receipt?.schema, 'flashback.archive_repair_receipt.v1');
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.operationId, observedSubmissions[0].archiveBinding.operationId);
    assert.equal(receipt.attemptId, observedSubmissions[0].attemptId);
    assert.equal(receipt.candidateScopeKey, manifest.archiveRef.archiveScopeKey);
    const candidateManifest = f.physicalManifest(receipt.candidateScopeKey);
    const candidatePrefix = `vector_rag_memory:scope:${candidateManifest.storageHash}:`;
    assert(candidateManifest.commitId);
    const allowedKeys = new Set([f.ownerKey, `${candidatePrefix}manifest:v2`,
      ...Array.from({ length: candidateManifest.shardCount }, (_, index) =>
        `${candidatePrefix}records:commit:${candidateManifest.commitId}:shard:${String(index).padStart(4, '0')}`)]);
    for (const effect of f.observation.writes) {
      assert.equal(effect.store, 'plugin');
      assert(allowedKeys.has(effect.key),
        `write is only owner manifest or an exact declared candidate manifest/shard, never active data/worldline/backup: ${effect.key}`);
    }
    assert.deepEqual([...receipt.memberIds].sort(), f.selectedBefore.map(canonicalIdentity).sort());
    assert(!registry(manifest)?.entries?.[receipt.attemptId], 'completed logical attempt no longer remains unresolved');
    const after = await f.readChain();
    assert.equal(after.verified, true);
    assert.equal(after.records, f.beforeRows.length);
    const byId = new Map(after.recordsList.map(row => [canonicalIdentity(row), row]));
    for (const old of f.beforeRows) {
      const current = byId.get(canonicalIdentity(old));
      assert(current);
      assert([old.id, `fb_archive_${canonicalIdentity(old)}`].includes(current.id), 'physical ID maps only to the same canonical member');
      assert.deepEqual(canonicalNonVector(current), canonicalNonVector(old), 'all canonical non-vector fields, including timestamps/history, survive');
      if (old.sourceHash === f.firstSourceHash) {
        assert.deepEqual(Array.from(current.vector), [0, 1, 0, 0]);
        assert.equal(current.embeddingDimensions, 4);
        assert.equal(current.embeddingProvider, f.targetSettings.embeddingProvider);
        assert.equal(current.embeddingModel, f.targetSettings.embeddingModel);
        assert.equal(current.embeddingDescriptor?.schema, 'memory-suite.embedding-descriptor.v1');
        assert.equal(current.embeddingDescriptor.resolvedDimensions, 4);
        assert.equal(current.embeddingDescriptor.space.model, f.targetSettings.embeddingModel);
        assert.equal(current.embeddingDescriptor.route.provider, f.targetSettings.embeddingProvider);
        const profileId = f.audit.embeddingProfileId(f.targetSettings, 4, f.targetSettings.embeddingProvider, f.targetSettings.embeddingModel);
        assert.equal(f.audit.recordEmbeddingCompatibility(current, f.targetSettings, {
          provider: f.targetSettings.embeddingProvider, model: f.targetSettings.embeddingModel, dimensions: 4, profileId
        }).comparable, true, 'effective output is actually target-profile compatible');
        assert.equal(current.embeddingOriginScopeKey, old.embeddingOriginScopeKey || old.inheritedFromScopeKey,
          'physical candidate scope never becomes the canonical embedding origin');
      } else assert.deepEqual(plain(current), old, 'all unselected archive record fields and vectors are unchanged');
    }
    const durableRows = plain(after.recordsList), calls = f.observation.requests.length;
    const reused = await f.archive().repair(preview.ticket);
    assert.equal(reused.status, 'blocked');
    assert.equal(f.observation.requests.length, calls, 'consumed ticket cannot resubmit');
    await f.restart();
    const fresh = await f.readChain();
    assert.equal(fresh.verified, true);
    assert.deepEqual(plain(fresh.recordsList), durableRows, 'fresh VM resolves the same effective chain and vectors');
    assert.equal(f.observation.requests.length, 0);
  } finally { await f.dispose(); }
});

test('already-compatible archive is a verified no-op with no provider probe or physical write', async () => {
  const f = await createArchiveOwnerFixture({ compatible: true });
  try {
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, false, JSON.stringify(preview));
    assert.equal(preview.reason, 'archive_up_to_date');
    assert.equal(counts(preview).eligibleRecords, 0);
    assert.equal(counts(preview).eligibleGroups, 0);
    assert.equal(counts(preview).remainingGroups, 0);
    noEffects(f); assert.deepEqual(f.snapshot(), before);
  } finally { await f.dispose(); }
});

test('absent archive refuses without fabricating a candidate or probing a provider', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    const manifest = f.physicalManifest(f.scope.scopeKey);
    f.pluginStorage.values.set(f.ownerKey, JSON.stringify({ ...manifest, archiveRef: null }));
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, false, JSON.stringify(preview));
    assert.equal(preview.reason, 'archive_absent');
    assert.equal(counts(preview).eligibleRecords, 0);
    noEffects(f); assert.deepEqual(f.snapshot(), before);
  } finally { await f.dispose(); }
});

for (const misuse of ['forged', 'cloned', 'closed', 'foreign', 'stale-profile']) {
  test(`opaque archive ticket rejects ${misuse} execution before all effects`, async () => {
    const f = await createArchiveOwnerFixture();
    let other;
    try {
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, true, JSON.stringify(preview));
      let ticket = preview.ticket;
      if (misuse === 'forged') ticket = { actionKind: 'archive_repair', scopeKey: f.scope.scopeKey };
      if (misuse === 'cloned') ticket = plain(ticket);
      if (misuse === 'closed') f.archive().clear();
      if (misuse === 'foreign') {
        other = await createArchiveOwnerFixture();
        ticket = (await other.archive().preview()).ticket;
      }
      if (misuse === 'stale-profile') await f.api.saveSettings({ ...f.targetSettings, embeddingModel: 'changed-model' });
      f.startObservation();
      const result = await f.archive().repair(ticket);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(result.archiveReembedded, 0);
      noEffects(f); f.assertProtectedUnchanged();
    } finally { await other?.dispose(); await f.dispose(); }
  });
}

test('duplicate in-flight archive ticket joins one physical execution', { timeout: 15000 }, async () => {
  const f = await createArchiveOwnerFixture();
  let release;
  try {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.setProviderHook(async (_entry, init) => { entered(); await gate; return syntheticResponse(init); });
    const preview = await f.archive().preview();
    const first = f.archive().repair(preview.ticket);
    await started;
    const second = f.archive().repair(preview.ticket);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.status, 'verified', JSON.stringify(a));
    assert.equal(f.observation.requests.length, a.provider.requests.length);
    assert.equal(a.archiveReembedded, f.selectedBefore.length);
  } finally { release?.(); await f.dispose(); }
});

for (const placement of ['owner', 'ancestor']) {
  test(`unresolved ${placement} logical history blocks the archive group across profile A-B-A and restart`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      const historyScope = placement === 'owner' ? f.scope.scopeKey : f.originalRef.archiveScopeKey;
      const history = f.unknownRegistry(historyScope);
      f.injectRegistry(historyScope, history);
      const oldHead = plain(f.physicalManifest(f.scope.scopeKey).archiveRef);
      for (const restart of [false, true]) {
        if (restart) {
          await f.api.saveSettings({ ...f.targetSettings, embeddingModel: 'profile-b' });
          await f.api.saveSettings(f.targetSettings);
          await f.restart();
        }
        f.startObservation();
        const preview = await f.archive().preview();
        assert.equal(preview.actionable, false, JSON.stringify(preview));
        assert.match(preview.reason, /unresolved|uncertain|unknown|history/i);
        noEffects(f);
        assert.deepEqual(registry(f.physicalManifest(historyScope)), history);
        assert.deepEqual(plain(f.physicalManifest(f.scope.scopeKey).archiveRef), oldHead);
      }
    } finally { await f.dispose(); }
  });
}

test('public portable import preserves logical unresolved archive history for the new owner', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    const oldOwner = f.scope.scopeKey;
    const history = f.unknownRegistry(oldOwner);
    f.injectRegistry(oldOwner, history);
    const imported = await f.copyToNewOwner();
    assert.notEqual(imported.scopeKey, oldOwner);
    const preview = await f.archive().preview();
    assert.equal(preview.actionable, false, JSON.stringify(preview));
    assert.match(preview.reason, /unresolved|uncertain|unknown|history/i);
    noEffects(f);
    const importedHistory = registry(f.physicalManifest(imported.scopeKey));
    const originalJob = Object.values(history.entries)[0].jobs[0];
    const newJobs = Object.values(importedHistory?.entries || {}).flatMap(entry => entry.jobs);
    assert(newJobs.some(job => job.logicalJobId === originalJob.logicalJobId), 'import retains logical source identity across physical owner IDs');
  } finally { await f.dispose(); }
});

for (const placement of ['owner', 'ancestor']) {
  test(`malformed ${placement} registry remains byte-preserved and blocks before preflight`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      const scopeKey = placement === 'owner' ? f.scope.scopeKey : f.originalRef.archiveScopeKey;
      const malformed = '{malformed-archive-history';
      f.injectRegistry(scopeKey, malformed);
      const before = f.snapshot();
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, false, JSON.stringify(preview));
      assert.match(preview.reason, /registry|history/i);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
      assert.equal(f.physicalManifest(scopeKey).embeddingAttemptRegistry, malformed);
    } finally { await f.dispose(); }
  });
}

for (const [label, timestamp] of [['future', '2099-01-01T00:00:00.000Z'], ['equal', '2024-01-01T00:00:00.000Z']]) {
  test(`${label}-timestamp predecessor cannot defeat the selected vectors or alter source timestamps`, async () => {
    const f = await createArchiveOwnerFixture({ timestamp });
    try {
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, true, JSON.stringify(preview));
      const result = await f.archive().repair(preview.ticket);
      assert.equal(result.status, 'verified', JSON.stringify(result));
      assert.equal(result.archiveReembedded, f.selectedBefore.length);
      const chain = await f.readChain();
      assert.equal(chain.verified, true, 'actual chain loader verifies new effective vectors');
      for (const before of f.selectedBefore) {
        const row = chain.recordsList.find(item => canonicalIdentity(item) === canonicalIdentity(before));
        assert.deepEqual(Array.from(row.vector), [0, 1, 0, 0]);
        assert.equal(row.createdAt, before.createdAt);
        assert.equal(row.updatedAt, before.updatedAt);
        assert.deepEqual(canonicalNonVector(row), canonicalNonVector(before));
      }
      f.assertProtectedUnchanged();
    } finally { await f.dispose(); }
  });
}

test('derived episode groups are explicitly excluded while the complete response group remains actionable', async () => {
  const f = await createArchiveOwnerFixture({ includeEpisode: true });
  try {
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, true, JSON.stringify(preview));
    assert.equal(counts(preview).eligibleRecords, f.selectedBefore.length);
    assert.equal(counts(preview).eligibleGroups, 1);
    assert.equal(counts(preview).remainingGroups, 1);
    assert.equal(counts(preview).excludedGroups, 1, 'aggregate source group is not silently counted as executable');
    assert.equal(counts(preview).excludedRecords, 1, 'excluded record and group units stay distinct');
    noEffects(f); assert.deepEqual(f.snapshot(), before);
    const result = await f.archive().repair(preview.ticket);
    assert.equal(result.archiveReembedded, f.selectedBefore.length);
    const chain = await f.readChain();
    const oldEpisode = f.beforeRows.find(row => row.autoEpisode);
    assert.deepEqual(plain(chain.recordsList.find(row => canonicalIdentity(row) === canonicalIdentity(oldEpisode))), oldEpisode);
    f.assertProtectedUnchanged();
  } finally { await f.dispose(); }
});

test('contextual embedding profile is refused before metadata, query or document requests', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    await f.api.saveSettings({ ...f.targetSettings, embeddingProvider: 'voyage_context', embeddingModel: 'voyage-context-3', embeddingDimensions: 256 });
    f.startObservation();
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, false, JSON.stringify(preview));
    assert.match(preview.reason, /profile|contextual|unsupported/i);
    noEffects(f); assert.deepEqual(f.snapshot(), before);
  } finally { await f.dispose(); }
});

for (const placement of ['owner', 'ancestor']) {
  test(`server-only ${placement} route refuses without migration, fallback or credential reconciliation`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      await establishExplicitLocalRoute(f, f.scope); // Only this route-mutation scenario needs persisted authority.
      const key = [...f.pluginStorage.values.keys()].find(item => item.includes('scope_routes_v1__:flashback'));
      assert(key, 'route witness exists');
      const routes = parse(f.pluginStorage.values.get(key));
      const scopeKey = placement === 'owner' ? f.scope.scopeKey : f.originalRef.archiveScopeKey;
      routes.entries[scopeKey] = { scopeId: scopeKey, mode: 'server_only', origin: 'user_explicit', updatedAt: Date.now() + 100000 };
      for (const store of [f.pluginStorage, f.safeLocalStorage]) store.values.set(key, JSON.stringify(routes));
      const before = f.snapshot(), preview = await f.archive().preview();
      assert.equal(preview.actionable, false, JSON.stringify(preview));
      assert.match(preview.reason, /storage|route|plugin|server|authority|unavailable/i);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
    } finally { await f.dispose(); }
  });
}

test('depth-cap head is refused before any attempt to compact or contact a provider', async () => {
  const f = await createArchiveOwnerFixture();
  try {
    const manifest = f.physicalManifest(f.scope.scopeKey);
    f.pluginStorage.values.set(f.ownerKey, JSON.stringify({ ...manifest, archiveRef: { ...manifest.archiveRef, depth: 256 } }));
    const before = f.snapshot(), preview = await f.archive().preview();
    assert.equal(preview.actionable, false, JSON.stringify(preview));
    assert.match(preview.reason, /depth.*cap|depth.*exhaust|depth.*limit/i);
    noEffects(f); assert.deepEqual(f.snapshot(), before);
  } finally { await f.dispose(); }
});

for (const kind of ['missing-chunk', 'duplicate-chunk', 'mixed-origin']) {
  test(`${kind} response group is refused without silently shrinking or rebinding the source`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      const first = f.selectedBefore[0], second = f.selectedBefore[1];
      await f.mutateArchiveRows(rows => rows.map(row => {
        if (row.sourceHash !== f.firstSourceHash) return row;
        if (kind === 'missing-chunk') return { ...row, chunkCount: Number(row.chunkCount) + 1 };
        if (kind === 'duplicate-chunk' && canonicalIdentity(row) === canonicalIdentity(second))
          return { ...row, chunkIndex: first.chunkIndex };
        if (kind === 'mixed-origin' && canonicalIdentity(row) === canonicalIdentity(first))
          return { ...row, embeddingOriginScopeKey: 'other-logical-origin' };
        return row;
      }));
      const before = f.snapshot(); f.startObservation();
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, false, JSON.stringify(preview));
      assert.match(preview.reason, /chunk|group|origin|lineage|invalid|incomplete|integrity/i);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
    } finally { await f.dispose(); }
  });
}

for (const status of ['running', 'uncertain']) {
  test(`pre-origin legacy ${status} archive marker blocks requests with no registry present`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      await f.seedLegacyMarker(status);
      assert.equal(f.physicalManifest(f.scope.scopeKey).embeddingAttemptRegistry, undefined);
      assert.equal(f.archiveManifest.embeddingAttemptRegistry, undefined);
      const before = f.snapshot(); f.startObservation();
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, false, JSON.stringify(preview));
      assert.match(preview.reason, /legacy|history|uncertain|unknown|unresolved|unsupported|incomplete/i);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
      await f.restart();
      const fresh = await f.archive().preview();
      assert.equal(fresh.actionable, false, JSON.stringify(fresh));
      assert.equal(f.observation.requests.length, 0, 'restart does not turn the legacy attempt into pending work');
    } finally { await f.dispose(); }
  });
}

for (const placement of ['owner', 'ancestor']) {
  test(`over-capacity ${placement} registry is preserved and blocks before every provider request`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      const scopeKey = placement === 'owner' ? f.scope.scopeKey : f.originalRef.archiveScopeKey;
      const initial = f.unknownRegistry(scopeKey), exemplar = Object.values(initial.entries)[0];
      const entries = {};
      for (let i = 0; i < 3000; i++) {
        const attemptId = `capacity-archive-attempt-${String(i).padStart(5, '0')}`;
        entries[attemptId] = { ...plain(exemplar), attemptId };
      }
      const body = { schema: initial.schema, scopeKey, entries };
      const oversized = { ...body, digest: f.audit.MemorySuiteExecutionContract.hash(body) };
      assert(Buffer.byteLength(JSON.stringify(oversized)) > 1024 * 1024);
      f.injectRegistry(scopeKey, oversized);
      const before = f.snapshot(); f.startObservation();
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, false, JSON.stringify(preview));
      assert.match(preview.reason, /capacity|registry|history|budget/i);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
    } finally { await f.dispose(); }
  });
}

for (const mutation of ['parent', 'body']) {
  test(`same-pointer archive ${mutation} mutation invalidates the ticket before any physical effect`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, true, JSON.stringify(preview));
      const ownerHead = plain(f.physicalManifest(f.scope.scopeKey).archiveRef);
      if (mutation === 'parent') {
        const key = f.manifestKeyFor(f.originalRef.archiveScopeKey), layer = f.archiveManifest;
        f.pluginStorage.values.set(key, JSON.stringify({ ...layer,
          parentArchiveRef: { ...f.originalRef, archiveScopeKey: 'unapproved-parent-scope', archiveId: 'unapproved-parent' } }));
      } else await f.mutateArchiveRows(rows => rows.map((row, index) => index ? row
        : { ...row, metadata: { ...row.metadata, sourceRevisionNote: 'changed-with-identical-head-pointer' } }));
      assert.deepEqual(plain(f.physicalManifest(f.scope.scopeKey).archiveRef), ownerHead);
      const before = f.snapshot(); f.startObservation();
      const result = await f.archive().repair(preview.ticket);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(result.archiveReembedded, 0);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
    } finally { await f.dispose(); }
  });
}

for (const mutation of ['head', 'local-source']) {
  test(`supported ${mutation} A-B-A invalidates admission even after original physical bytes are restored`, async () => {
    const f = await createArchiveOwnerFixture();
    try {
      let localRows;
      if (mutation === 'local-source') localRows = await f.seedLocal();
      const preview = await f.archive().preview();
      assert.equal(preview.actionable, true, JSON.stringify(preview));
      const snapshot = f.snapshot(), originalOwner = f.physicalManifest(f.scope.scopeKey);
      if (mutation === 'head') {
        await f.api._test.saveScopeManifest({ ...originalOwner, archiveRef: null }, f.scope);
        await f.api._test.saveScopeManifest(originalOwner, f.scope);
      } else {
        const row = localRows[0];
        const changed = await f.api._test.buildRecordsFromSources([{ ...row,
          text: row.text + ' A changed observation.', sanitizeMemory: false }], f.targetSettings, f.scope, { deferEmbedding: true });
        await f.api._test.saveAllRecords(changed, f.targetSettings, f.scope);
        await f.api._test.saveAllRecords(localRows, f.targetSettings, f.scope);
      }
      // Supported product writers have performed A -> B -> A. Restore incidental
      // timestamps/commit IDs as well so equality alone cannot detect the change.
      for (const [key, value] of snapshot.plugin) f.pluginStorage.values.set(key, value);
      for (const [key, value] of snapshot.local) f.safeLocalStorage.values.set(key, value);
      const before = f.snapshot(); f.startObservation();
      const result = await f.archive().repair(preview.ticket);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(result.archiveReembedded, 0);
      noEffects(f); assert.deepEqual(f.snapshot(), before);
    } finally { await f.dispose(); }
  });
}
