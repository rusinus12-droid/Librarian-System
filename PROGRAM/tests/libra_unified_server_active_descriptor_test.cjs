'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {serverFixture, fiveMore} = require('./fixtures/libra_server_runtime_fixture.cjs');

const transformSource = source => source.replace('    const unifiedServerReadKeys =',
  '    globalThis.__descriptorTest = {requireUnifiedStorageBackend, unifiedServerManifestIdentity, unifiedMigrationRef, unifiedMigrationDigest, digest, resolveContext, reconcileCanonicalBranchBeforeRecall, rebuildUnifiedStateForWorldline: options => rebuildUnifiedStateForWorldline(options)};\n'
  + '    const unifiedServerReadKeys =');
const active = fixture => fixture.getRecords('libra.unified_server_active.v1')[0];
const manifest = fixture => fixture.storedRows().find(row => row.key.endsWith(':manifest'));

for (const mode of ['server_only', 'mirror']) {
  test(`${mode}: a verified v3 boundary permits replay of the typed suffix`, async t => {
    const fixture = await serverFixture({mode, transformSource});
    t.after(() => fixture.cleanup());
    const {f} = fixture;
    assert.equal((await f.run()).completed, 1);
    fiveMore(f);
    assert.equal((await f.run()).completed, 1);
    const core = f.r.context.__descriptorTest;
    const row = manifest(fixture);
    const legacyRef = row.value.memories['1'];
    const legacyMemory = fixture.getMemory(1);
    const canonicalArtifact = {schema:'libra.canonical_artifact.v3'};
    const artifactDigest = core.digest(canonicalArtifact);
    Object.assign(legacyMemory, {artifactSchema:canonicalArtifact.schema, canonicalArtifact, artifactDigest});
    Object.assign(legacyRef, {artifactSchema:canonicalArtifact.schema, artifactDigest});
    const set = async (key, value) => {
      await fixture.mutate(key, value);
      if (mode === 'mirror') fixture.local.set(key, JSON.stringify(value));
    };
    await set(legacyRef.key, legacyMemory);
    await set(row.key, row.value);
    const descriptor = active(fixture);
    await fixture.mutate(descriptor.key, null, 'remove');
    fixture.local.delete(descriptor.key);
    const calls = f.control.calls.length;
    const refused = await f.r.api.rebuildWorldManagerState();
    assert.equal(refused.code, 'UNIFIED_SERVER_LEGACY_NOT_SUPPORTED', JSON.stringify(refused));
    assert.equal(active(fixture), undefined);
    const migrationKey = row.key.replace(/manifest$/, 'unified-migration:v1');
    const migration = {schema:'libra.unified_migration.v1', scopeKey:row.value.scopeKey,
      mode:'preserve_legacy_readonly', selectionPolicy:'evidence_selected_v1',
      legacyRefs:[core.unifiedMigrationRef(legacyRef)], recordDigest:'invalid'};
    await set(migrationKey, migration);
    const invalid = await f.r.api.rebuildWorldManagerState();
    assert.match(invalid.error, /digest_mismatch/);
    assert.equal(active(fixture), undefined);
    migration.recordDigest = core.unifiedMigrationDigest(migration);
    await set(migrationKey, migration);
    const legacyBefore = fixture.storedRows().find(record => record.key === legacyRef.key).raw;
    const replay = await f.r.api.rebuildWorldManagerState();
    assert.equal(replay.ok, true, replay.error);
    assert.equal(fixture.getHead().throughTurn, 10);
    assert.equal(fixture.getHead().unifiedCoverage.legacyCount, 1);
    assert.equal(fixture.getHead().unifiedCoverage.typedCount, 1);
    assert.equal(fixture.storedRows().find(record => record.key === legacyRef.key).raw, legacyBefore);
    assert.equal(f.control.calls.length, calls);
    const replayErrors = fixture.storedRows().find(record => record.key.endsWith(':state-replay-errors:v1')).value.records;
    assert.ok(replayErrors.some(error => error.code === 'UNIFIED_SERVER_LEGACY_NOT_SUPPORTED' && error.resolvedAt));
  });

  test(`${mode}: branch rollback writes the manifest and descriptor in one batch`, async t => {
    const fixture = await serverFixture({mode, transformSource});
    t.after(() => fixture.cleanup());
    const {f} = fixture;
    assert.equal((await f.run()).completed, 1);
    fiveMore(f);
    assert.equal((await f.run()).completed, 1);
    const descriptor = active(fixture);
    const calls = f.control.calls.length;
    const removed = f.chat.message.slice(10);
    f.chat.message.splice(10);
    const core = f.r.context.__descriptorTest;
    const context = await core.resolveContext();
    await core.reconcileCanonicalBranchBeforeRecall(context, {full:true, background:true, scheduleDeep:false});
    assert.equal(manifest(fixture).value.memories['6'].status, 'inactive');
    assert.notEqual(active(fixture).value.manifestIdentity, descriptor.value.manifestIdentity);
    assert.equal(active(fixture).value.manifestIdentity, core.unifiedServerManifestIdentity(manifest(fixture).value));
    assert.ok(fixture.batches.some(batch => batch.mutations.some(row => row.key === manifest(fixture).key)
      && batch.mutations.some(row => row.key === descriptor.key && JSON.parse(row.value).source === 'branch_reconcile')));
    if (mode === 'mirror') assert.equal(fixture.local.get(descriptor.key), active(fixture).raw);
    f.chat.message.push(...removed);
    await core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(), {full:true, background:true, scheduleDeep:false});
    assert.equal(manifest(fixture).value.memories['6'].status, 'committed');
    assert.equal(active(fixture).value.manifestIdentity, descriptor.value.manifestIdentity);
    assert.equal(f.control.calls.length, calls);
  });
}

test('explicit State rebuild repairs an older branch deactivation and refuses an unproven identity', async t => {
  const fixture = await serverFixture({transformSource});
  t.after(() => fixture.cleanup());
  const {f} = fixture;
  assert.equal((await f.run()).completed, 1);
  fiveMore(f);
  assert.equal((await f.run()).completed, 1);
  const row = manifest(fixture);
  const previous = active(fixture);
  row.value.memories['6'].status = 'inactive';
  row.value.memories['6'].inactiveReason = 'rollback_or_incomplete_batch';
  await fixture.mutate(row.key, row.value);
  f.chat.message.splice(10);
  const core = f.r.context.__descriptorTest;
  const context = await core.resolveContext();
  await assert.rejects(core.requireUnifiedStorageBackend(context), /UNIFIED_SERVER_ACTIVE_DESCRIPTOR_MISMATCH/);
  assert.equal(active(fixture).raw, previous.raw, 'read-only probe never repairs the descriptor');
  const calls = f.control.calls.length;
  const rebuilt = await f.r.api.rebuildWorldManagerState();
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
  assert.equal(fixture.getHead().throughTurn, 5);
  assert.equal(active(fixture).value.source, 'verified_branch_deactivation');
  assert.equal(f.control.calls.length, calls);
  assert.equal(JSON.stringify(manifest(fixture).value.memories), JSON.stringify(row.value.memories));

  const descriptor = active(fixture);
  await fixture.mutate(descriptor.key, {...descriptor.value, manifestIdentity:'unproven'});
  await assert.rejects(core.requireUnifiedStorageBackend(context, null, true), /UNIFIED_SERVER_ACTIVE_DESCRIPTOR_MISMATCH/);
  assert.equal(active(fixture).value.manifestIdentity, 'unproven');
});

test('a concurrent descriptor change prevents publishing either half of a rollback', async t => {
  const fixture = await serverFixture({transformSource});
  t.after(() => fixture.cleanup());
  const {f} = fixture;
  assert.equal((await f.run()).completed, 1);
  const descriptor = active(fixture);
  const before = manifest(fixture);
  fixture.hooks.beforeBatch = async batch => {
    if (!batch.mutations.some(row => row.key === descriptor.key)) return;
    fixture.hooks.beforeBatch = null;
    await fixture.mutate(descriptor.key, {...descriptor.value, concurrentMarker:true});
  };
  f.chat.message.splice(8);
  const core = f.r.context.__descriptorTest;
  await assert.rejects(core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(),
    {full:true, background:true, scheduleDeep:false}));
  assert.equal(manifest(fixture).raw, before.raw);
  assert.equal(active(fixture).value.concurrentMarker, true);
});

test('Recent Work clears a verified descriptor error while State replay still protects the newer Head', async t => {
  const fixture = await serverFixture({transformSource});
  t.after(() => fixture.cleanup());
  const {f} = fixture;
  assert.equal((await f.run()).completed, 1);
  fiveMore(f);
  assert.equal((await f.run()).completed, 1);
  const core = f.r.context.__descriptorTest;
  const context = await core.resolveContext();
  const descriptor = active(fixture);
  const row = manifest(fixture);
  const overviewState = async () => (await f.r.api.getRecentWorkOverview()).jobs.find(job => job.id === 'state');
  assert.equal(fixture.getHead().throughTurn, 10);
  await fixture.mutate(descriptor.key, {...descriptor.value, manifestIdentity:'unproven'});
  const failed = await core.rebuildUnifiedStateForWorldline({context, manifest:row.value, allowIncompletePrefix:true});
  assert.equal(failed.code, 'UNIFIED_SERVER_ACTIVE_DESCRIPTOR_MISMATCH');
  assert.equal((await overviewState()).error, failed.code);

  row.value.memories['6'].status = 'inactive';
  row.value.memories['6'].inactiveReason = 'rollback_or_incomplete_batch';
  await fixture.mutate(row.key, row.value);
  const repairedIdentity = core.unifiedServerManifestIdentity(row.value);
  await fixture.mutate(descriptor.key, {...descriptor.value, manifestIdentity:repairedIdentity});
  f.chat.message.splice(10);
  const calls = f.control.calls.length;
  const retry = await core.rebuildUnifiedStateForWorldline({context, manifest:row.value, allowIncompletePrefix:true});
  assert.equal(retry.reason, 'state_prefix_before_existing_head', retry.error);
  assert.equal(fixture.getHead().throughTurn, 10);
  assert.equal(active(fixture).value.manifestIdentity, repairedIdentity);
  const error = fixture.storedRows().find(record => record.key.endsWith(':state-replay-errors:v1')).value.records.at(-1);
  assert.equal(error.resolution.reason, 'server_descriptor_verified');
  assert.equal((await overviewState()).error, '');
  assert.equal(f.control.calls.length, calls);
});

test('missing-range recovery replays a changed batch that was made inactive by rollback', async t => {
  const fixture = await serverFixture({transformSource});
  t.after(() => fixture.cleanup());
  const {f} = fixture;
  assert.equal((await f.run()).completed, 1);
  fiveMore(f);
  assert.equal((await f.run()).completed, 1);
  const oldRef = fixture.getManifest().memories['6'];
  const oldRaw = fixture.storedRows().find(row => row.key === oldRef.key).raw;
  f.chat.message.splice(10);
  const core = f.r.context.__descriptorTest;
  await core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(), {full:true, background:true, scheduleDeep:false});
  assert.equal(fixture.getManifest().memories['6'].inactiveReason, 'rollback_or_incomplete_batch');

  fiveMore(f);
  f.chat.message.at(-1).data += '\n새 분기의 마지막 문장.';
  const selection = await f.r.api.listCanonicalBatchRanges();
  const range = selection.ranges.find(row => row.startTurn === 6);
  assert.equal(range.status, 'missing');
  assert.notEqual(range.sourceDigest, oldRef.sourceDigest);
  const result = await f.r.api.startSelectedCanonicalBatches({scopeKey:selection.scopeKey, mode:'missing', ranges:[range]});
  assert.equal(result.completed, 1, JSON.stringify(result.failures));
  assert.equal(result.failed, 0);
  const ref = fixture.getManifest().memories['6'];
  assert.equal(ref.status, 'committed');
  assert.equal(ref.revision, oldRef.revision + 1);
  assert.equal(ref.sourceDigest, range.sourceDigest);
  assert.ok(ref.history.some(row => row.key === oldRef.key));
  assert.equal(fixture.storedRows().find(row => row.key === oldRef.key).raw, oldRaw);
  assert.equal(active(fixture).value.manifestIdentity, core.unifiedServerManifestIdentity(fixture.getManifest()));
  assert.equal(fixture.getHead().throughTurn, 10);
});
