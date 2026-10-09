'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { fixture, snapshotDurable, OWNERS, controlApi, ownerApi, fresh, current, put } = require('./fixtures/authority_server_fixture.cjs');
const refused = /AUTHORITY_(?:LIFECYCLE_UNAVAILABLE|QUARANTINED|CONTROL_REQUIRED|UNAVAILABLE|WRITE_DENIED)|INVALID_AUTHORITY_STORE|AUTHORITY_CLOSED/;
const count = (repo, table) => repo.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('legacy_default_off_preserves_receipts_and_creates_no_authority_storage', t => {
  const f = fixture(t), repo = f.repositories.libra;
  const a = put(repo, 'libra:test:legacy', { value: 1 }, 'legacy-receipt-0001');
  assert.equal(a.result.schema, 'memory-suite.storage.receipt.v1');
  assert.equal(a.result.verified, true);
  assert.deepEqual(put(repo, 'libra:test:legacy', { value: 1 }, 'legacy-receipt-0001'), a);
  assert.throws(() => put(repo, 'libra:test:legacy', 2, 'legacy-receipt-0001'), /operation_id_payload_conflict/);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'config/server-authority.json')), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'stores/_authority')), false);
  assert.equal(repo.database.prepare('PRAGMA user_version').get().user_version, 1);
});

test('constructor_requires_genuine_current_control', t => {
  const f = fixture(t); f.activate({ open: false });
  assert.equal(typeof controlApi.assertAuthorityStore, 'function', 'Unit A needs a private control identity validator');
  const before = snapshotDurable(f.dataDir);
  for (const impostor of [true, {}, { ...f.control }, Object.create(f.control)]) {
    assert.throws(() => f.loaded.__task4.createRepository(f.dataDir, 'libra', () => false, impostor), refused);
  }
  const other = fixture(t); other.activate({ open: false });
  assert.throws(() => f.loaded.__task4.createRepository(f.dataDir, 'libra', () => false, other.control), refused);
  const closed = controlApi.openAuthorityStore({ dataDir: f.dataDir, physicalBinding: f.physicalBinding }); closed.close();
  assert.throws(() => f.loaded.__task4.createRepository(f.dataDir, 'libra', () => false, closed), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
  assert.doesNotThrow(() => f.open('libra'));
});

test('guarded_storage_never_falls_back_to_legacy', t => {
  const f = fixture(t); f.activate({ open: false });
  const before = snapshotDurable(f.dataDir);
  assert.throws(() => f.loaded.__task4.createRepository(f.dataDir, 'libra'), refused);
  assert.throws(() => f.loaded.createMemorySuiteServer({ dataDir: f.dataDir, autoBackup: false, computeEnabled: false }), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
  fs.renameSync(path.join(f.dataDir, 'config/server-authority.json'), path.join(f.root, 'retained-marker.json'));
  fs.renameSync(path.join(f.dataDir, 'stores/_authority'), path.join(f.root, 'retained-control'));
  const orphan = snapshotDurable(f.dataDir);
  assert.throws(() => f.loaded.__task4.createRepository(f.dataDir, 'libra'), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), orphan, 'orphan guards must not be downgraded');
});

for (const namespace of OWNERS) test(`W01_W18_real_${namespace}_mutation_has_exact_stored_authority_receipt`, t => {
  const f = fixture(t); f.activate(); const repo = f.repositories[namespace];
  const operationId = 'guarded-' + namespace + '-0001';
  const before = f.control.readWitness();
  const result = put(repo, namespace + ':test:record', 'hello', operationId);
  const receipt = f.readReceipt(namespace, operationId);
  assert.equal(result.result.schema, 'memory-suite.storage.receipt.v1');
  assert.deepEqual(f.readResult(receipt.namespace,receipt.operationId), result);
  assert.equal(receipt.operationClass, 'kv');
  assert.equal(receipt.namespace, namespace);
  assert.equal(receipt.physicalBinding.dataInstanceId, f.physicalBinding.dataInstanceId);
  assert.equal(f.control.readWitness().controlSequence, before.controlSequence + 2);
  assert.equal(f.control.readWitness().pendingIntent, null);
  assert.equal(receipt.touchedSources.count, namespace === 'libra' ? 1 : 0);
  assert.deepEqual(put(repo, namespace + ':test:record', 'hello', operationId), result);
  assert.throws(() => put(repo, namespace + ':test:record', 'changed', operationId), /operation_id_payload_conflict/);
  assert.equal(repo.get('plugin', namespace + ':test:record').revision, 1);
  assert.throws(() => repo.database.prepare('DELETE FROM kv').run(), /AUTHORITY_WRITE_DENIED/);
  assert.equal(repo.get('plugin', namespace + ':test:record').value, 'hello');
});

test('W02_W03_public_internal_batch_and_purge_recreate_use_same_gate', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const first = repo.applyConditionalBatch([fresh('libra:test:a', 'a'), fresh('libra:test:b', 'b')], { operationId: 'batch-public-0001' });
  assert.deepEqual(f.readResult('libra', 'batch-public-0001'), first);
  assert.equal(first.result.atomicScope, 'single_namespace_sqlite');
  const stamp = ownerApi.readSourceStamps(f.owners.libra, [{ space: 'plugin', key: 'libra:test:a' }])[0];
  const internal = repo.applyConditionalBatch([current(repo, 'libra:test:a', 'purge')]);
  assert.equal(internal.namespace, 'libra'); assert.equal(internal.receipts[0].kind, 'purge');
  const removed = ownerApi.readSourceStamps(f.owners.libra, [{ space: 'plugin', key: 'libra:test:a' }])[0];
  assert.equal(removed.sourceId, stamp.sourceId); assert.equal(removed.present, false); assert(removed.version > stamp.version);
  repo.applyConditionalBatch([fresh('libra:test:a', 'a')]);
  const recreated = ownerApi.readSourceStamps(f.owners.libra, [{ space: 'plugin', key: 'libra:test:a' }])[0];
  assert.equal(recreated.sourceId, stamp.sourceId); assert(recreated.version > removed.version);
  const rows = repo.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(r => JSON.parse(r.receipt_json));
  assert.equal(rows.length, 3); assert(rows.every(r => r.ordinaryResult));
  assert.throws(() => repo.applyConditionalBatch([fresh('libra:test:rollback', 1), fresh('libra:test:b', 'stale')], { operationId: 'batch-stale-0001' }), /conditional_batch_state_changed/);
  assert.equal(repo.get('plugin', 'libra:test:rollback').exists, false);
  assert.equal(repo.operation('batch-stale-0001'), null);
});

test('W04_W10_W11_maintenance_true_is_real_permitted_owner_deletion_SQL', t => {
  const f = fixture(t); f.activate(); let maintenance = false;
  const repo = f.open('libra', () => maintenance);
  put(repo, 'libra:v1:scope:deleted:manifest', { scopeKey: 'deleted' }, 'deletion-seed-0001');
  maintenance = true;
  assert.throws(() => put(repo, 'libra:test:blocked', 'x'), /server_maintenance_in_progress/);
  const result = repo.applyConditionalBatch([current(repo, 'libra:v1:scope:deleted:manifest')], { maintenance: true, operationId: 'deletion-batch-0001', ownedScopeDeletion: { scopeId: 'deleted-owner', scopeKey: 'deleted', backupId: 'fixture-backup' } });
  const receipt = f.readReceipt('libra', 'deletion-batch-0001');
  assert.equal(receipt.operationClass, 'maintenance'); assert.deepEqual(f.readResult(receipt.namespace,receipt.operationId), result);
  assert.equal(repo.isOwnerScopeDeleted('deleted-owner'), true);
  assert.equal(count(repo, 'libra_deleted_owner_keys'), 1);
  for (const table of ['libra_deleted_owner_keys', 'libra_deleted_owner_scopes']) assert.throws(() => repo.database.prepare('DELETE FROM ' + table).run(), /AUTHORITY_WRITE_DENIED/);
});

test('W05_cleanup_is_guarded_and_retains_authority_evidence', t => {
  const f = fixture(t), old = f.repositories.libra;
  old.database.prepare('INSERT INTO operations VALUES(?,?,?,?)').run('expired-ordinary-0001', '0'.repeat(64), '{}', 0);
  f.activate(); const repo = f.repositories.libra;
  for (let i = 0; i < 1000; i++) put(repo, 'libra:test:cleanup', i, 'cleanup-write-' + String(i).padStart(4, '0'));
  assert.equal(repo.operation('expired-ordinary-0001'), null, 'actual cleanup must run under a private permit');
  assert.equal(count(repo, 'authority_write_receipts'), 1001, '1,000 writes plus one guarded cleanup receipt');
  assert.equal(f.readResult('libra', 'cleanup-write-0000').result.revision, 1);
  assert.equal(f.control.readWitness().pendingIntent, null);
  assert.throws(() => repo.database.prepare('DELETE FROM authority_write_receipts').run(), /AUTHORITY_WRITE_DENIED/);
  const pending = f.control.publishIntent({ generation: f.control.readWitness().generation, namespace: 'libra', operationId: 'pending-cleanup-0001', fingerprint: 'a'.repeat(64), operationClass: 'maintenance' });
  assert.throws(() => repo.__task4Maintenance(), /AUTHORITY_BUSY/);
  assert.equal(count(repo, 'authority_write_receipts'), 1001);
  assert.equal(f.control.readWitness().pendingIntent.operationId, pending.operationId);
});

test('W06_W07_flashback_fence_acquire_renew_release_and_missing_alias_are_guarded', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.flashback;
  const key = 'vector_rag_memory:scope:fixture_alias:manifest:v2', owner = 'fixture-writer-00000001';
  const acquired = repo.writerFence.command({ action: 'acquire', key, owner });
  assert.equal(acquired.schema, 'flashback.writer-fence.v1');
  const renewed = repo.writerFence.command({ action: 'renew', key, owner, epoch: acquired.epoch });
  assert.equal(renewed.epoch, acquired.epoch);
  assert.throws(() => put(repo, key, 'unfenced', 'fence-refused-0001'), /FLASHBACK_WRITER_FENCED/);
  const result = repo.mutate({ kind: 'set', space: 'plugin', key, value: 'fenced', operationId: 'fence-data-0001', fence: renewed });
  assert.deepEqual(f.readResult('flashback', 'fence-data-0001'), result);
  repo.writerFence.command({ action: 'release', key, owner, epoch: acquired.epoch });
  put(repo, 'vector_rag_memory:scope:missing_alias:manifest:v2', 'legacy-alias', 'fence-missing-0001');
  const receipts = repo.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(r => JSON.parse(r.receipt_json));
  assert.equal(receipts.filter(r => r.operationClass === 'fence').length, 3);
  assert(receipts.every(r => r.ordinaryResult));
  assert.throws(() => repo.database.prepare("UPDATE flashback_writer_fences SET owner='bypass'").run(), /AUTHORITY_WRITE_DENIED/);
});

test('W06_late_body_rechecks_reset_and_maintenance', async t => {
  const f = fixture(t, { server: true }), key = 'vector_rag_memory:scope:late:manifest:v2';
  const delayed = f.request('/v1/flashback/writer', { action: 'acquire', key, owner: 'late-fixture-owner-0001' }, { defer: true });
  f.app.__task4.setMaintenance(true); delayed.finish();
  const denied = await delayed.result;
  assert.equal(denied.status, 503); assert.equal(count(f.repositories.flashback, 'flashback_writer_fences'), 0);
  f.app.__task4.setMaintenance(false);
  const reset = f.request('/v1/flashback/writer', { action: 'acquire', key, owner: 'late-fixture-owner-0001' }, { defer: true });
  f.app.__task4.namespaceReset.advanceEpochs(['flashback']); reset.finish();
  const stale = await reset.result;
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'MEMORY_SUITE_RESET_RECONNECT_REQUIRED');
  assert.equal(count(f.repositories.flashback, 'flashback_writer_fences'), 0);
});

test('W10_W11_W14_W17_activated_lifecycle_catalog_and_job_writers_refuse_before_changes', async t => {
  const f = fixture(t, { server: true }); f.activate({ open: false }); const hooks = f.app.__task4;
  const before = snapshotDurable(f.dataDir);
  for (const run of [() => hooks.writeScopeCatalog({ namespaces: {} }), () => hooks.replaceNamespaceScopeIndex('libra', []), () => hooks.removeCatalogScope('libra', 'scope'), () => hooks.setCatalogScopePinned('libra', 'scope', true), () => hooks.saveDeletePlan({ planId: 'fixture-plan-0001' }), () => hooks.prepareJobBackup('fixture-job-0001', 'libra', {}, []), () => hooks.advanceDeleteJob({ jobId: 'fixture-job-0001' }, true), () => hooks.createScopeDeletePlan({}), () => hooks.executeScopeDeletePlan({})]) assert.throws(run, refused);
  await assert.rejects(() => hooks.ownerScopeDelete({ namespace: 'libra' }, 'plan', { scopeKey: 'scope' }, 'scope'), refused);
  await assert.rejects(() => f.app.createBackup(), refused);
  await assert.rejects(() => f.app.restoreBackup('fixture-backup-0001'), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
});

test('W12_W13_direct_namespace_reset_refuses_activated_and_indeterminate_storage', async t => {
  const f = fixture(t), resetFactory = require('../server/core/namespace-reset.cjs');
  const config = { dataDir: f.dataDir, ...f.physicalBinding, repositories: f.repositories, backup: async () => { throw Error('MUST_NOT_BACKUP'); }, setMaintenance() {} };
  const reset = resetFactory(config), plan = reset.plan(['libra']);
  f.activate({ open: false }); const before = snapshotDurable(f.dataDir);
  assert.throws(() => resetFactory(config), refused);
  assert.throws(() => reset.advanceEpochs(['libra']), refused);
  await assert.rejects(() => reset.execute({ planId: plan.id, confirmation: 'RESET libra', withoutBackup: true }), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), before);
  fs.writeFileSync(path.join(f.dataDir, 'config/server-authority.json'), '{partial');
  const damaged = snapshotDurable(f.dataDir);
  assert.throws(() => reset.advanceEpochs(['libra']), refused);
  assert.deepEqual(snapshotDurable(f.dataDir), damaged);
});

test('W18_preconnected_raw_DML_and_returned_database_never_mint_permits', t => {
  const f = fixture(t), legacy = f.track(new DatabaseSync(f.repositories.libra.filePath));
  f.activate(); const repo = f.repositories.libra;
  put(repo, 'libra:v1:scope:raw:manifest', { scopeKey: 'raw' }, 'raw-seed-0001');
  repo.applyConditionalBatch([current(repo, 'libra:v1:scope:raw:manifest')], { maintenance: true, operationId: 'raw-delete-0001', ownedScopeDeletion: { scopeId: 'raw-owner', scopeKey: 'raw', backupId: 'fixture-backup' } });
  for (const db of [legacy, repo.database]) {
    for (const table of ['metadata', 'kv', 'operations', 'libra_deleted_owner_scopes', 'libra_deleted_owner_keys', 'authority_owner_state', 'authority_write_receipts', 'authority_source_lifecycle']) {
      assert.throws(() => db.exec('INSERT INTO ' + table + ' SELECT * FROM ' + table), /AUTHORITY_WRITE_DENIED|no such function/, table + ' INSERT must use a genuine permit');
    }
  }
});

test('W08_real_flashback_repair_stages_and_backup_payload_join_repository_gate', t => {
  const f = fixture(t), vectors = require('./fixtures/server_repair_fixture.cjs');
  const legacy = f.repositories.flashback;
  vectors.seed(legacy);
  const binding = { scopeKey: vectors.scope, dataInstanceId: f.physicalBinding.dataInstanceId, epoch: 0, mode: 'server_only', authorityDigest: 'b'.repeat(64) };
  const backup = vectors.backup(legacy, f.dataDir, binding);
  f.activate();
  const repo = f.repositories.flashback;
  const service = require('../server/core/flashback-server-repair.cjs')({ getRepository: () => f.repositories.flashback, dataInstanceId: binding.dataInstanceId, epochs: () => ({ flashback: 0 }), canWrite: () => true, strongProofProvider: backup.provider });
  const call = (action, input) => service(vectors.owner, action, { ...binding, ...input });
  const reserve = operationId => {
    const preview = call('preview', { shardIndex: 0, backupId: backup.backupId });
    assert.equal(preview.allowed, true);
    return call('reserve', { operationId, shardIndex: 0, backupId: backup.backupId, previewFingerprint: preview.fingerprint });
  };
  const cancelled = 'task4_cancel_operation_0001'; reserve(cancelled);
  assert.equal(call('cancel', { operationId: cancelled }).state, 'cancelled');
  const operationId = 'task4_commit_operation_0001', requestId = 'task4_commit_request_0001';
  reserve(operationId);
  assert.equal(call('submitted', { operationId, requestId }).state, 'submitted');
  assert.equal(call('commit', { operationId, requestId }).originalVectorBytesVerified, true);
  assert.deepEqual(repo.get('local', vectors.vectorKey).value, vectors.payload());
  for (const [id, stages] of [[cancelled, ['reserve', 'cancel']], [operationId, ['reserve', 'submitted', 'commit']]]) {
    for (const stage of stages) {
      const receipt = f.readReceipt('flashback', 'fb_repair_' + id + '_' + stage);
      assert.equal(receipt.operationClass, 'batch'); assert(receipt.ordinaryResult);
    }
  }
  const receipts = repo.database.prepare('SELECT receipt_json FROM authority_write_receipts').all().map(row => JSON.parse(row.receipt_json));
  assert.equal(receipts.filter(row => row.operationClass === 'fence').length, 7);
  assert.equal(f.control.readWitness().pendingIntent, null);
});

test('W09_real_libra_archive_repair_commits_unchanged_public_receipt_under_gate', t => {
  const f = fixture(t), old = f.repositories.libra;
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const digest = value => { const body = JSON.stringify(value); let h = 2166136261; for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= 31; h = Math.imul(h, 16777619); return `${(h >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`; };
  const scope = 'repair-child', sourceScope = 'repair-parent', key = `libra:v1:scope:${scope}:micro-handoff-archive:inherited`, manifestKey = `libra:v1:scope:${scope}:manifest`;
  const core = { schema: 'libra.micro_handoff_archive.v1', sourceScopeKey: 'older-source', activeWorldlineId: 'main', recordCount: 0, recordsDigest: digest([]), records: [] };
  const archive = { ...core, archiveDigest: digest(core) };
  const manifest = { schema: 'libra.manifest.v1', scopeKey: scope, nativeChatCopy: { schema: 'libra.native_chat_copy.v2', sourceScopeKey: sourceScope, targetScopeKey: scope, complete: true, durableVerified: true }, inheritedMicroArchives: [{ schema: 'libra.micro_handoff_archive_ref.v1', archiveKey: key, archiveDigest: archive.archiveDigest, sourceScopeKey: archive.sourceScopeKey, nativeCopiedFromScopeKey: sourceScope }] };
  put(old, manifestKey, JSON.stringify(manifest), 'archive-manifest-seed-0001'); put(old, key, JSON.stringify(archive), 'archive-data-seed-0001');
  const folder = path.join(f.root, 'backup'); fs.mkdirSync(folder);
  const file = path.join(folder, 'libra.sqlite'); old.database.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const backup = { id: 'archive-backup-0001', kind: 'manual', label: 'pre-owner-scope-delete', path: folder, stores: { libra: { file: 'libra.sqlite', sha256: hash(fs.readFileSync(file)) } } };
  old.database.prepare('INSERT INTO libra_deleted_owner_scopes VALUES(?,?,?,?)').run('deleted-parent', sourceScope, backup.id, 0);
  old.mutate({ kind: 'remove', space: 'plugin', key, operationId: 'archive-remove-seed-0001' });
  f.activate(); let committed = 0;
  const repo = f.repositories.libra;
  const repair = require('../server/core/libra-native-archive-repair.cjs')({ repository: repo, listBackups: () => [backup], scrubBackup: selected => {
    assert.equal(hash(fs.readFileSync(file)), selected.stores.libra.sha256);
    const db = new DatabaseSync(file, { readOnly: true });
    try { const ok = db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; return { ok, stores: { libra: { ok } } }; } finally { db.close(); }
  }, canStart: () => true, onCommitted: () => { committed++; } });
  const plan = repair.plan({ backupId: backup.id, targetScopeKey: scope, targetArchiveKey: key });
  const result = repair.execute({ planId: plan.planId, fingerprint: plan.fingerprint });
  assert.equal(result.schema, 'libra.native_archive_backup_repair_receipt.v1');
  assert.equal(result.physicalReadback, true); assert.equal(committed, 1);
  assert.equal(repo.get('plugin', key).value, JSON.stringify(archive));
  assert.equal(f.readReceipt('libra', 'libra-native-archive-repair:' + plan.planId).operationClass, 'batch');
  assert.deepEqual(repair.execute({ planId: plan.planId, fingerprint: plan.fingerprint }), result);
});

test('transaction_failure_cannot_resurrect_old_writer', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const originalExec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function(sql) {
    const file = this.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (armed && file === repo.filePath && sql === 'COMMIT') { armed = false; throw Error('TASK4_OWNER_COMMIT_FAILURE'); }
    return originalExec.call(this, sql);
  };
  try { assert.throws(() => put(repo, 'libra:test:failed', 'no', 'failed-transaction-0001'), /TASK4_OWNER_COMMIT_FAILURE/); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(repo.get('plugin', 'libra:test:failed').exists, false);
  assert.equal(repo.operation('failed-transaction-0001'), null);
  assert.equal(f.readReceipt('libra', 'failed-transaction-0001'), null);
  const decision = f.control.readOperation({ generation: f.control.readWitness().generation, namespace: 'libra', operationId: 'failed-transaction-0001' });
  assert.equal(decision.status, 'aborted');
  assert.throws(() => repo.database.prepare("INSERT INTO kv VALUES('plugin','late','0',0,1,'digest',0)").run(), /AUTHORITY_WRITE_DENIED/);
  put(repo, 'libra:test:next', 'yes', 'after-failed-transaction-0001');
  assert.equal(repo.get('plugin', 'libra:test:next').value, 'yes');
});

test('conclusive_owner_close_uses_current_transaction_facade_without_legacy_fallback', t => {
  const f = fixture(t); f.activate(); const repo = f.repositories.libra;
  const originalExec = DatabaseSync.prototype.exec;
  let commitFault = true, rollbackFault = true;
  DatabaseSync.prototype.exec = function(sql) {
    if (this === repo.database && commitFault && sql === 'COMMIT') { commitFault = false; throw Error('TASK4_OWNER_COMMIT_FAILURE'); }
    if (this === repo.database && !commitFault && rollbackFault && sql === 'ROLLBACK') { rollbackFault = false; throw Error('TASK4_OWNER_ROLLBACK_FAILURE'); }
    return originalExec.call(this, sql);
  };
  try { assert.throws(() => put(repo, 'libra:test:closed-old', 'no', 'closed-old-transaction-0001'), /TASK4_OWNER_COMMIT_FAILURE/); }
  finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(commitFault, false); assert.equal(rollbackFault, false);
  const result = put(repo, 'libra:test:current-handle', 'yes', 'current-handle-0001');
  assert.deepEqual(f.readResult('libra', 'current-handle-0001'), result);
  const currentDb = new DatabaseSync(repo.filePath, { readOnly: true });
  try {
    assert.equal(currentDb.prepare("SELECT count(*) n FROM kv WHERE key='libra:test:closed-old'").get().n, 0);
    assert.equal(JSON.parse(currentDb.prepare("SELECT value_json FROM kv WHERE key='libra:test:current-handle'").get().value_json), 'yes');
  } finally { currentDb.close(); }
  assert.throws(() => repo.database.exec('COMMIT'), /not open|closed|not a database/i, 'old raw handle must never resume');
});
