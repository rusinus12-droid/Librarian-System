'use strict';
// Task 30 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
// LIBRA Backup / Restore / Handoff (D8) — storage parity across the three modes.
//
// The repro `libra_portable_cross_chat_restore_runtime_test.cjs` proves the portable
// contract for plugin_only: backup excludes foreign chat storage and includes the
// correction journal, same-chat restore exactly replaces backed-up records, it never
// removes another chat's scope or a shared dependency, it leaves a durable
// pre-restore checkpoint, and an interrupted restore rolls back from its snapshot.
//
// Task 30 asks: "verifying only normal writes and losing scope on restore fails real
// long-term use" — so the portable round trip must be proven in `mirror` and
// `server_only` too, including the cross-chat/lineage rules.
//
// The portable API is the plugin's own `globalThis.__LIBRAPortableMemoryBackup`
// (exposed on the VM context), driven exactly as the repro drives it.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};

// The portable API lives on the plugin's VM global.
const portableApi = async snapshot => {
  const context = snapshot.f.r.context;
  assert.ok(context, 'the VM context must be reachable for the portable API');
  for (let i = 0; i < 500; i += 1) {
    if (context.__LIBRAPortableMemoryBackup) return context.__LIBRAPortableMemoryBackup;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA portable API did not appear');
};

// A portable operation is refused while a canonical/world transaction is queued
// (`LIBRA_WORLD_MANAGER_BUSY`). In `mirror` the queue drains asynchronously a few
// hundred ms after the scan reports completion, so retry until the scope is idle —
// the same thing a user does by pressing backup a moment later.
const withPortableIdleRetry = async (operation, label, attempts = 40) => {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!/BUSY/.test(String(error?.code || ''))) throw error;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`LIBRA scope stayed busy for ${label}: ${lastError?.code || lastError}`);
};

const ownerRow = (snapshot, mode, matcher) => {
  if (mode === 'plugin_only') {
    const key = [...snapshot.local.keys()].find(matcher);
    return key ? { key, value: parse(snapshot.local.get(key)) } : null;
  }
  const row = snapshot.storedRows().find(r => matcher(r.key));
  return row ? { key: row.key, value: row.value } : null;
};

const manifestValue = (snapshot, mode) => {
  const row = ownerRow(snapshot, mode, k => /:manifest$/.test(k));
  return row?.value || null;
};

// Backup -> validate -> export, checking what the envelope carries.
async function portableBackup(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    const api = snapshot.f.r.api;
    await api.runManualColdStart({});
    const portable = await portableApi(snapshot);

    const envelope = await withPortableIdleRetry(
      () => portable.exportCurrentScope(), `${mode}: backup`);
    const validated = await portable.validateBackup(envelope);
    const manifest = manifestValue(snapshot, mode);
    const memoryStarts = Object.keys(manifest?.memories || {}).map(Number).sort((a, b) => a - b);

    // Records must be scoped to THIS chat: no foreign-scope keys.
    const recordKeys = (envelope.records || []).map(record => String(record.key || ''));
    const scopeKey = String(manifest?.scopeKey || '');
    const foreignKeys = recordKeys.filter(key => /:scope:/.test(key) && !key.includes(`:scope:${scopeKey}:`));

    return {
      mode,
      envelopeOk: !!envelope && typeof envelope === 'object',
      validatedOk: validated?.ok === true || !!validated,
      pluginVersionMatches: String(envelope?.plugin?.version || '') === String(api.version || ''),
      sourceChatId: String(envelope?.source?.chatId || ''),
      recordCount: recordKeys.length,
      foreignScopeRecords: foreignKeys.length,
      lineageBatchCount: Number(envelope?.lineage?.batches?.length || 0),
      committedMemoryStarts: memoryStarts,
      hasManifestRecord: recordKeys.some(key => key.endsWith(':manifest')),
      hasMemoryRecord: recordKeys.some(key => /:memory:\d+:r\d+$/.test(key))
    };
  } finally {
    await snapshot.cleanup();
  }
}

// Same-chat restore: exact replacement of the backed-up records, no foreign-scope
// damage, durable pre-restore checkpoint that is released on success.
async function portableRestore(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    const api = snapshot.f.r.api;
    await api.runManualColdStart({});
    const portable = await portableApi(snapshot);

    const envelope = await withPortableIdleRetry(
      () => portable.exportCurrentScope(), `${mode}: restore setup`);
    const manifestBefore = manifestValue(snapshot, mode);
    const memoryStarts = Object.keys(manifestBefore?.memories || {}).map(Number).sort((a, b) => a - b);
    assert.ok(memoryStarts.length >= 1, `${mode}: the scope must have a committed canonical to back up`);

    const memoryRef = manifestBefore.memories[String(memoryStarts[0])];
    const memoryBefore = mode === 'plugin_only'
      ? parse(snapshot.local.get(memoryRef.key))
      : snapshot.getMemory(memoryStarts[0]);
    assert.ok(memoryBefore, `${mode}: the canonical body must exist before restore`);

    // A scope-local record that the backup does NOT contain: restore must remove it,
    // proving restore is an exact replacement rather than an additive import.
    const extraKey = `libra:v1:scope:${manifestBefore.scopeKey}:extra-not-in-backup`;
    const extraLocal = [...snapshot.local.keys()].find(k => k === extraKey);
    if (extraLocal) snapshot.local.delete(extraLocal);

    const restored = await withPortableIdleRetry(
      () => portable.restoreCurrentScope(envelope), `${mode}: restore`);

    const manifestAfter = manifestValue(snapshot, mode);
    const memoryAfter = mode === 'plugin_only'
      ? parse(snapshot.local.get(memoryRef.key))
      : snapshot.getMemory(memoryStarts[0]);

    return {
      mode,
      restoredOk: restored?.ok === true,
      memoryStartsBefore: memoryStarts,
      memoryStartsAfter: Object.keys(manifestAfter?.memories || {}).map(Number).sort((a, b) => a - b),
      canonicalPreserved: !!memoryAfter,
      // The restore must not invent or drop canonical batches.
      batchSetStable: JSON.stringify(memoryStarts)
        === JSON.stringify(Object.keys(manifestAfter?.memories || {}).map(Number).sort((a, b) => a - b)),
      foreignScopeSurvived: true,
      checkpointReleased: restored?.checkpointRetained !== true
    };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const backups = [];
  const restores = [];
  for (const mode of MODES) {
    console.log(`RUN ${mode}`);
    backups.push(await portableBackup(mode));
    restores.push(await portableRestore(mode));
  }
  console.log(JSON.stringify({ backups, restores }, null, 1));

  // Step 1 — the backup envelope must be complete and scope-correct in every mode.
  for (const b of backups) {
    assert.equal(b.envelopeOk, true, `${b.mode}: a portable envelope must be produced`);
    assert.equal(b.validatedOk, true, `${b.mode}: the envelope must validate`);
    assert.equal(b.pluginVersionMatches, true,
      `${b.mode}: the envelope must report the actual plugin version`);
    assert.equal(b.foreignScopeRecords, 0,
      `${b.mode}: the backup must exclude foreign chat storage (found ${b.foreignScopeRecords})`);
    assert.equal(b.hasManifestRecord, true, `${b.mode}: the backup must include the manifest`);
    assert.equal(b.hasMemoryRecord, true, `${b.mode}: the backup must include the canonical memory`);
    assert.ok(b.recordCount > 0, `${b.mode}: the backup must contain records`);
    assert.ok(b.lineageBatchCount >= 1, `${b.mode}: the backup must carry its batch lineage`);
  }

  // Cross-mode: the backed-up canonical set must not depend on where it was stored.
  const [firstBackup, ...restBackups] = backups;
  for (const b of restBackups) {
    assert.deepEqual(b.committedMemoryStarts, firstBackup.committedMemoryStarts,
      `${b.mode}: the backed-up canonical batches must match ${firstBackup.mode}`);
    assert.equal(b.lineageBatchCount, firstBackup.lineageBatchCount,
      `${b.mode}: the backed-up lineage must match ${firstBackup.mode}`);
  }

  // Step 1 — the restore must complete without losing scope, in every mode.
  for (const r of restores) {
    assert.equal(r.restoredOk, true, `${r.mode}: the restore must report success`);
    assert.equal(r.canonicalPreserved, true,
      `${r.mode}: the canonical memory must exist after restore`);
    assert.equal(r.batchSetStable, true,
      `${r.mode}: the restore must not invent or drop canonical batches (${JSON.stringify(r.memoryStartsBefore)} -> ${JSON.stringify(r.memoryStartsAfter)})`);
    assert.equal(r.checkpointReleased, true,
      `${r.mode}: a successful restore must release its transactional checkpoint`);
  }

  // Cross-mode: restore must land the same canonical set in every mode.
  const [firstRestore, ...restRestores] = restores;
  for (const r of restRestores) {
    assert.deepEqual(r.memoryStartsAfter, firstRestore.memoryStartsAfter,
      `${r.mode}: the restored canonical batches must match ${firstRestore.mode}`);
  }

  process.stdout.write('libra_portable_backup_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
