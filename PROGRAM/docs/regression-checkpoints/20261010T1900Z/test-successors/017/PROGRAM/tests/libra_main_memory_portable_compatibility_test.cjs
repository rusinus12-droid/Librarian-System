'use strict';
// T10 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`01` sections 12/16, `03` A39/A40/A41)
//
// T10 acceptance goals include portable movement, restart and schema protection.
// This file directly exercises only restart/read silence, byte/ref/Head preservation,
// and supported mixed v4/v5 storage in each mode; broader goals below are not proven here.
//
//   A39  a 3x3 portable transfer (each storage mode exporting to each) and a
//        cross-chat restore keep the canonical links and origins intact;
//   A40  a missing or altered bundle is reported, never activated as if it were fine;
//   A41  an upgrade from a v4-only record costs no model call and changes no bytes,
//        and a newer record is never rewritten to suit an older reader.
//
// Storage/restart scenarios use real deployed storage in all three modes.
// No export/import matrix, tampered-bundle import, or unsupported-schema read is run.
// The final portable block is source-text inspection only, not direct guard execution.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const rowsOf = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))];
const memoryRows = snapshot => rowsOf(snapshot)
  .filter(row => /:memory:\d+:/.test(row.key))
  .map(row => ({ key: row.key, raw: row.raw, value: (() => { try { return JSON.parse(row.raw); } catch { return null; } })() }))
  .filter(row => row.value)
  .sort((a, b) => a.key.localeCompare(b.key));
const headOf = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const manifestOf = snapshot => {
  const server = snapshot.getManifest();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  return key ? (() => { try { return JSON.parse(snapshot.local.get(key)); } catch { return null; } })() : null;
};

const runUpgradeMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    // --- a scope that already holds one canonical record ------------------
    f.control.artifact = artifact();
    assert.equal((await f.run()).completed, 1, `${mode}: the record commits`);
    const beforeRecords = memoryRows(snapshot);
    const beforeBytes = beforeRecords.map(row => row.raw);
    const beforeRefs = JSON.stringify(manifestOf(snapshot)?.memories ?? {});
    const beforeHead = JSON.stringify(headOf(snapshot) ?? {});
    assert.ok(beforeBytes.length, `${mode}: a canonical record exists before the reload`);
    assert.ok(Object.keys(manifestOf(snapshot)?.memories ?? {}).length, `${mode}: preserved refs are nonempty`);
    assert.ok(headOf(snapshot), `${mode}: preserved State Head exists`);

    // --- A41: reopening the scope costs no model call and changes nothing ---
    const restarted = await snapshot.restart();
    assert.equal(restarted.control.calls.length, 0,
      `${mode}: reopening the scope makes no model call`);
    observation.reopenSilent = true;
    assert.deepEqual(memoryRows(snapshot).map(row => row.raw), beforeBytes,
      `${mode}: the stored bytes are identical after the reload`);
    assert.equal(JSON.stringify(manifestOf(snapshot)?.memories ?? {}), beforeRefs,
      `${mode}: the manifest refs are identical after the reload`);
    assert.equal(JSON.stringify(headOf(snapshot) ?? {}), beforeHead,
      `${mode}: the State Head is identical after the reload`);
    observation.bytesPreserved = true;

    // --- A41: reading through the public surface is still non-generative ---
    const api = restarted.r.api;
    const head = await api.getCurrentStateHead?.();
    assert.ok(head, `${mode}: the State Head is readable after the reload`);
    const detail = await api.getLibraMemoryDetail?.(head?.reviewedThroughCanonical?.memoryId ?? '', head?.reviewedThroughCanonical?.revision ?? 0);
    // This is a return-type observation, not positive non-null detail availability.
    observation.detailReturnTypeCompatible = detail === null || typeof detail === 'object';
    assert.equal(restarted.control.calls.length, 0,
      `${mode}: reading the record makes no model call`);

    // --- A40 fixture preconditions only: no damage is written or imported ---
    // These local JSON checks do not exercise tamper detection or activation refusal.
    const tampered = memoryRows(snapshot)[0];
    if (tampered) {
      const parsed = JSON.parse(tampered.raw);
      parsed.canonicalArtifact = { ...parsed.canonicalArtifact, facts: [] };
      const damaged = JSON.stringify(parsed);
      const originalDigest = parsed.artifactDigest;
      const currentDigest = JSON.stringify(parsed.canonicalArtifact);
      // A changed local serialization is a precondition, not a validated digest mismatch.
      observation.tamperFixturePrepared = true;
      assert.ok(originalDigest !== undefined,
        `${mode}: the record carries the digest that makes tampering detectable`);
      assert.notEqual(damaged, tampered.raw,
        `${mode}: the tampered body differs from what was stored`);
      assert.ok(typeof currentDigest === 'string',
        `${mode}: the artifact body is readable for comparison`);
    }

    // --- Supported mixed-schema availability (both v4 and v5 are readable) ---
    // This does not exercise an older reader or an unsupported future schema.
    const { fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
    fiveMore(snapshot.f);
    const v5 = JSON.parse(JSON.stringify(snapshot.f.control.artifact));
    v5.schema = 'libra.canonical_artifact.v5';
    snapshot.f.control.artifact = v5;
    assert.equal((await snapshot.f.run()).completed, 1, `${mode}: the v5-labelled batch commits`);
    const stored = memoryRows(snapshot).map(row => row.value.artifactSchema);
    assert.ok(stored.includes('libra.canonical_artifact.v5'),
      `${mode}: the v5 label survives storage instead of being rewritten (stored: ${stored.join(', ')})`);
    assert.ok(stored.includes('libra.canonical_artifact.v4'),
      `${mode}: the earlier v4 record is still present and unchanged`);
    for (const record of beforeRecords) {
      assert.equal(memoryRows(snapshot).find(row => row.key === record.key)?.raw, record.raw,
        `${mode}: the earlier v4 bytes remain unchanged after the v5 commit`);
    }

    const microCalls = () => snapshot.f.control.calls.filter(args =>
      String(args[0]?.messages?.[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')).length;
    // Manual historical reconciliation creates receipts but cannot reserve fresh-
    // output Micro plans. Restart also gives this fixture a new provider-call array.
    await waitFor(() => snapshot.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 15000);
    const status = await snapshot.f.r.api.getReceiptRecoveryStatus();
    const turns = Array.from({length: 10}, (_, index) => index + 1);
    const receiptStages = [...status.receiptStages].sort((a, b) => a.turn - b.turn);
    const microStages = [...status.microJobs].sort((a, b) => a.turn - b.turn);
    assert.deepEqual(receiptStages.map(row => row.turn), turns, `${mode}: all ten receipts must exist`);
    assert.deepEqual(microStages.map(row => row.turn), turns, `${mode}: all ten Micro stages are represented`);
    assert.equal(new Set(receiptStages.map(row => row.receiptRef)).size, 10);
    for (let index = 0; index < turns.length; index += 1) {
      const receipt = receiptStages[index], micro = microStages[index];
      assert.equal(receipt.status, 'verified', `${mode}: T${receipt.turn} has a physically verified receipt`);
      assert.ok(receipt.receiptRef);
      assert.equal(receipt.scopeKey, status.scopeKey);
      assert.equal(micro.receiptRef, receipt.receiptRef);
      assert.equal(micro.scopeKey, receipt.scopeKey);
      assert.equal(micro.revisionId, receipt.identity.revisionId);
      assert.equal(micro.sourceDigest, receipt.identity.sourceDigest);
      assert.equal(micro.status, 'unknown', `${mode}: reconciled T${receipt.turn} has no fresh-output plan`);
      assert.equal(micro.physicalAttemptsUsed, 0);
      assert.equal(micro.logicalAttempts, 0);
      assert.equal(micro.attemptId, '');
      assert.deepEqual(Array.from(micro.history), []);
    }
    const receiptRefs = new Set(receiptStages.map(row => row.receiptRef));
    const workRows = rowsOf(snapshot).map(row => {
      try { return JSON.parse(row.raw); } catch { return null; }
    }).filter(row => row?.schema === 'libra.micro_work.v1' && receiptRefs.has(row.receiptKey));
    assert.equal(workRows.length, 0, `${mode}: reconciliation/status must not backfill automatic work`);
    assert.equal(microCalls(), 0, `${mode}: historical receipts cannot trigger automatic Micro calls`);
    observation.modelCalls = snapshot.f.control.calls.length;
    assert.equal(observation.modelCalls, 1, `${mode}: restarted runtime makes only the second Canonical call`);
    assert.match(JSON.stringify(snapshot.f.control.calls[0]), /LIBRA LONG-TERM MEMORY EXTRACTION/);
    const reread = await snapshot.f.r.api.getReceiptRecoveryStatus();
    assert.deepEqual(reread.receiptStages, status.receiptStages);
    assert.deepEqual(reread.microJobs, status.microJobs);
    assert.equal(snapshot.f.control.calls.length, observation.modelCalls, `${mode}: status reread does not reanalyse`);
    observation.verifiedReceipts = receiptStages.length;
    observation.unknownNoAttemptMicroStages = microStages.length;
    observation.microCalls = microCalls();
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runUpgradeMode(mode);
  const project = ({ mode, ...rest }) => rest;
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same restart/mixed-schema observations as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same restart/mixed-schema observations as plugin_only');

  // --- A39 source-text structural checks only -----------------------------
  // These inspect the guard body without executing it or a portable transfer.
  // They do not prove transitive provider silence or any 3x3/invalid-bundle result.
  const source = require('node:fs').readFileSync(process.env.LIBRA_TEST_PLUGIN || './plugins/LIBRA.js', 'utf8');
  const guard = source.slice(source.indexOf('const validateUnifiedPortableBundle ='),
    source.indexOf('const UNIFIED_MODES ='));
  assert.ok(/validateUnifiedTransferRefs/.test(guard),
    'guard source references transfer-ref validation');
  assert.ok(/UNIFIED_PORTABLE_ROLLBACK_REQUIRES_NATIVE_PREFIX/.test(guard),
    'guard source includes the native-prefix rollback refusal marker');
  assert.ok(!/runLLMModel|callMemoryProvider/.test(guard),
    'this guard source slice has no direct provider-call name');

  console.log(JSON.stringify({
    test: 'libra_main_memory_portable_compatibility',
    passed: 1,
    boundary: 'real deployed LIBRA + real HTTP/SQLite in three modes; reopen, read and mixed-schema storage',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
