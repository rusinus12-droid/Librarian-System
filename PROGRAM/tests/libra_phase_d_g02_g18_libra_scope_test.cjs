'use strict';

// G02-G18 action closure, LIBRA-scope gates. Each section drives the §9.3 stimulus and its
// required oracle against the shipped plugin, and prints a per-gate machine-readable row.
//
// Gates whose stimulus belongs to another owner (G02/G03: HAYAKU/SDK source projection) are not
// claimed here. Gates that need a live host (G16 real DOM) or the full regression (G15 peer
// absence beyond this fixture) report exactly what was run.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Recall returns per-run diagnostics (run id, timings, cache flags) alongside the memories.
// G06 asks whether the same LOGICAL result comes back without the cache, so compare the
// memory set itself: ids, canonical digests and the fact text.
const recallLogical = recall => JSON.stringify((recall?.memories || []).map(row => ({
  id: row?.id || null,
  memoryId: row?.memory?.memoryId || null,
  revision: row?.memory?.revision ?? null,
  artifactDigest: row?.memory?.artifactDigest || null,
  facts: (row?.memory?.canonicalArtifact?.facts || []).map(f => f.text)
})));
// local fixture storage holds JSON text; read it as raw bytes without assuming it parses.
const rawLocal = (snap, key) => { const value = snap.local.get(key); return typeof value === 'string' ? value : JSON.stringify(value ?? null); };
// server_only owns canonical rows in SQLite; plugin_only owns them in pluginStorage.
// Read from the store that actually owns this scope so a missing local mirror cannot
// accidentally compare equal before and after an operation.
const rawCanonical = (snap, ref) => {
  if (!ref?.key) return null;
  if (snap.local.has(ref.key)) return rawLocal(snap, ref.key);
  return snap.storedRows().find(row => row.key === ref.key)?.raw ?? null;
};
const localValue = (snap, key) => { try { return JSON.parse(rawLocal(snap, key)); } catch { return null; } };
const manifestOf = snap => snap.getManifest()
  || localValue(snap, [...snap.local.keys()].find(k => /:manifest$/.test(k)) || '') || null;
const firstRefOf = snap => Object.values(manifestOf(snap)?.memories || {})[0] || null;
const rows = [];
const record = (id, stimulus, observed, status = 'VERIFIED', extra = {}) => {
  rows.push({ id, stimulus, observed, status, ...extra });
  console.log(JSON.stringify({ schema: 'g02_g18.gate_row.v1', id, status, stimulus, observed, ...extra }));
};

const assertComputeSuccess = (observed, expectedVersion, baseline = {}) => {
  assert.equal(observed?.state, 'ready', 'G14: consumer must observe successful Compute, not a failure');
  assert.equal(observed?.serverVersion, expectedVersion, 'G14: consumer must observe the negotiated Compute server version');
  assert.ok(Number(observed?.counters?.server || 0) > Number(baseline?.counters?.server || 0),
    'G14: the real Compute operation must reach the server');
  assert.equal(Number(observed?.counters?.fallbacks || 0), Number(baseline?.counters?.fallbacks || 0),
    'G14: the success control must not silently pass through local fallback');
  assert.equal(Number(observed?.counters?.remoteFailures || 0), Number(baseline?.counters?.remoteFailures || 0),
    'G14: the success control must not contain a remote Compute failure');
};

const assertRecallContains = (observed, expectedText, label = 'G18') => {
  assert.ok(Array.isArray(observed?.memories), `${label}: Recall consumer must return a memories array`);
  assert.ok(observed.memories.length > 0, `${label}: Recall consumer must not accept an empty result`);
  const excerpts = observed.memories.map(row => String(row?.text || '')).filter(Boolean);
  assert.ok(excerpts.some(text => text.includes(expectedText)),
    `${label}: Recall consumer must contain the expected source-backed fact: ${expectedText}`);
  return excerpts.find(text => text.includes(expectedText));
};

// Negative controls exercise the same consumer assertions used below. They make a
// failed/wrong-version Compute observation and an empty Recall result fail closed.
const negativeControls = [];
const expectRejectedObservation = (id, observation, assertion) => {
  let rejection = null;
  try { assertion(observation); } catch (error) { rejection = String(error.message || error); }
  assert.ok(rejection, `${id}: mutated consumer observation must be rejected`);
  negativeControls.push({ id, outcome: 'REJECTED', reason: rejection });
  console.log(JSON.stringify({ schema: 'g02_g18.negative_control.v1', id, outcome: 'REJECTED', reason: rejection }));
};
expectRejectedObservation('G14-bad-compute-rejected', {
  state: 'failed', reason: 'unexpected-model', serverVersion: 'unexpected-model',
  counters: { server: 0, fallbacks: 1, remoteFailures: 1 }
}, value => assertComputeSuccess(value, 'expected-server-version'));
expectRejectedObservation('G14-wrong-version-rejected', {
  state: 'ready', reason: '', serverVersion: 'unexpected-model',
  counters: { server: 1, fallbacks: 0, remoteFailures: 0 }
}, value => assertComputeSuccess(value, 'expected-server-version'));
expectRejectedObservation('G18-empty-recall-rejected', { memories: [] },
  value => assertRecallContains(value, '민아만 상자의 암호를 들었다'));

(async () => {
  // ── G05: reopen the active worldline; parent data remains immutable ─────────────────────
  {
    const snap = await serverFixture({ mode: 'server_only' });
    try {
      const f = snap.f;
      await f.run();
      const parentRef = firstRefOf(snap);
      assert.ok(parentRef?.key, 'G05: fixture must create a canonical parent row');
      const parentBytes = rawCanonical(snap, parentRef);
      const parentPayload = JSON.parse(parentBytes);
      const parentDigest = parentRef.artifactDigest;
      const callsBefore = f.control.calls.length;
      const set = await f.r.api.setWorldManagerWorldline({});
      assert.equal(set.ok, true, 'G05: worldline switch succeeds');
      // This call reopens the active worldline; it does not create a separate branch.
      const parentAfter = rawCanonical(snap, parentRef);
      const parentAfterPayload = JSON.parse(parentAfter);
      assert.equal(parentAfterPayload.sourceDigest, parentPayload.sourceDigest,
        'G05: reopening the active worldline preserves the source digest');
      assert.deepEqual(parentAfterPayload.canonicalArtifact, parentPayload.canonicalArtifact,
        'G05: reopening the active worldline preserves canonical artifact content');
      assert.equal(parentAfterPayload.artifactDigest, parentDigest,
        'G05: reopening the active worldline preserves the canonical artifact digest');
      const refAfter = firstRefOf(snap);
      assert.equal(refAfter.artifactDigest, parentDigest, 'G05: the parent artifact digest is unchanged by the switch');
      assert.equal(f.control.calls.length, callsBefore, 'G05: switching costs no provider call');
      const changedFields = [...new Set([...Object.keys(parentPayload), ...Object.keys(parentAfterPayload)])]
        .filter(key => JSON.stringify(parentPayload[key]) !== JSON.stringify(parentAfterPayload[key]));
      record('G05', 'Reopen the active worldline and read the server-owned parent row back',
        `source digest and canonical artifact stayed unchanged (${String(parentDigest).slice(0, 12)}…); raw envelope unchanged ${parentAfter === parentBytes}; updated envelope fields ${changedFields.join(',') || 'none'}; no second branch or late job was created`,
        'UNVERIFIED', { canonicalOwner: 'server', artifactUnchanged: true,
          rawEnvelopeUnchanged: parentAfter === parentBytes, changedEnvelopeFields: changedFields,
          providerCallsUnchanged: true, missing: 'distinct worldline/chat fork plus publication of late work after the switch' });
    } finally { await snap.cleanup(); }
  }

  // ── G10: delete the physical index, then rebuild after a restart ────────────────────────
  {
    const snap = await serverFixture({ mode: 'plugin_only', args: { evidence_link_index_enabled: 'true' } });
    try {
      let f = snap.f;
      await f.run();
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G10: fixture must create a canonical row');
      const canonicalBytesBefore = rawCanonical(snap, ref);
      // The projection is read-only with respect to canonical records, but its
      // regenerable index is persisted when the opt-in is enabled.
      const index = await f.r.api.getEvidenceLinkIndex();
      const indexKeys = [...snap.local.keys()].filter(k => /:evidence-link-index:v1$/.test(k));
      assert.equal(index.schema, 'libra.evidence_link_index.v1', 'G10: the opt-in projection returns its declared schema');
      assert.equal(index.buildVersion, 'readonly_projection_v1', 'G10: source declares this as a read-only projection');
      assert.ok(index.entities?.length > 0 && index.facts?.length > 0, 'G10: the actual canonical corpus produces projection data');
      assert.ok(indexKeys.length > 0, 'G10: opt-in read must produce at least one persisted derived index row');
      for (const key of indexKeys) snap.local.delete(key);
      assert.equal([...snap.local.keys()].filter(k => /:evidence-link-index:v1$/.test(k)).length, 0,
        'G10: the real derived index row was deleted');
      const staleKey = indexKeys[0];
      snap.local.set(staleKey, JSON.stringify({ ...clone(index), signature: 'stale-signature' }));
      const staleIndex = JSON.parse(rawLocal(snap, staleKey));
      assert.equal(staleIndex.signature, 'stale-signature', 'G10: the stale signature is physically present before restart');
      f = await snap.restart();
      const rebuilt = await f.r.api.getEvidenceLinkIndex();
      assert.equal(rebuilt.schema, 'libra.evidence_link_index.v1', 'G10: restart rebuild returns the index schema');
      assert.notEqual(rebuilt.signature, 'stale-signature', 'G10: stale persisted signature is rejected after restart');
      assert.ok(rebuilt.facts?.length > 0, 'G10: rebuilt projection recovers facts from canonical data');
      const persistedRebuild = JSON.parse(rawLocal(snap, staleKey));
      assert.equal(persistedRebuild.signature, rebuilt.signature, 'G10: rebuilt signature is durably read back');
      assert.equal(rawCanonical(snap, ref), canonicalBytesBefore, 'G10: index invalidation leaves canonical source bytes unchanged');
      record('G10', 'Delete a persisted evidence index, inject a stale signature and rebuild after restart',
        `deleted ${indexKeys.length} real index row(s), rejected stale signature, rebuilt ${rebuilt.facts.length} facts and read the replacement signature back`,
        'VERIFIED', { optInOpen: true, projectionBuild: index.buildVersion, entityCount: index.entities.length,
          factCount: index.facts.length, deletedIndexRows: indexKeys.length, staleSignatureWritten: true,
          staleSignatureRejected: rebuilt.signature !== 'stale-signature', rebuiltFactCount: rebuilt.facts.length,
          rebuiltSignatureReadback: persistedRebuild.signature === rebuilt.signature, canonicalPreserved: true });
    } finally { await snap.cleanup(); }
  }

  // ── G11: source-tracing auto vs off ─────────────────────────────────────────────────────
  {
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snap.f;
      await f.run();
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G11: fixture must create a canonical row');
      const canonicalBefore = rawCanonical(snap, ref);
      // Automatic edit-detection modes were explicitly retired on 2026-10-06.
      // Keep this gate identity and canonical preservation control; never fake the removed toggle.
      for (const name of ['getSourceEditSyncStatus','setSourceEditTrackingMode']) {
        assert.equal(typeof f.r.api[name], 'undefined', 'G11: retired automatic tracking control stays absent');
      }
      assert.equal(rawCanonical(snap, ref), canonicalBefore, 'G11: retirement inspection leaves canonical source bytes unchanged');
      record('G11', 'Inspect retired automatic source-tracking controls without altering canonical data',
        'The historical auto/off toggle contract is retired. Explicit source view and user-selected reanalysis are covered by their dedicated runtime gates.',
        'NONAPPLICABLE_RETIRED', { canonicalUnchanged: true,
          contract: 'docs/SOURCE_EDIT_DETECTION_RETIREMENT_20261006.md',
          replacementGate: 'tests/source_edit_detection_retirement_test.cjs',
          historicalExpectationPassed: false });
    } finally { await snap.cleanup(); }
  }

  // ── G12: plugin_only with the Librarian server forbidden ────────────────────────────────
  {
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snap.f;
      const serverRequestsBefore = snap.requests.length;
      const run = await f.run();
      assert.equal(run.completed, 1, 'G12: the batch commits with no server');
      assert.equal(snap.storedRows().length, 0, 'G12: nothing was written to the server');
      const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차');
      assert.ok(recall?.memories?.length > 0, 'G12: recall works with no server');
      record('G12', 'Run plugin_only with the Librarian server unavailable',
        `batch committed locally, server request count ${snap.requests.length - serverRequestsBefore}, recall returned ${recall.memories.length} memories`,
        'VERIFIED', { serverRows: 0, recallMemories: recall.memories.length });
    } finally { await snap.cleanup(); }
  }

  // ── G06: cache eviction / plugin restart; restore the same logical result from canon ────
  {
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      let f = snap.f;
      await f.run();
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G06: fixture must create a canonical row');
      const beforeRaw = rawCanonical(snap, ref);
      const beforeHead = JSON.stringify(await f.r.api.getCurrentStateHead());
      const beforeRecall = recallLogical(await f.r.api.previewUnifiedMemoryRecall('민아 민트차'));
      // evict every derived cache the fixture holds, then restart the plugin itself
      const cacheKeys = [...snap.local.keys()].filter(k => /-cache|replay-cache|pair-revision|link-index/.test(k));
      for (const key of cacheKeys) snap.local.delete(key);
      f = await snap.restart();
      const afterHead = JSON.stringify(await f.r.api.getCurrentStateHead());
      const afterRecall = recallLogical(await f.r.api.previewUnifiedMemoryRecall('민아 민트차'));
      const afterRaw = rawCanonical(snap, ref);
      assert.equal(afterRaw, beforeRaw, 'G06: the canonical record is unchanged by cache eviction and restart');
      assert.equal(afterHead, beforeHead, 'G06: the logical Head state is restored from canon');
      assert.equal(afterRecall, beforeRecall, 'G06: recall returns the same logical result with no cache');
      record('G06', 'Attempt cache eviction and restart the plugin; compare canonical, Head and Recall',
        `restarted and re-read the same canonical bytes, Head and Recall; actual cache rows deleted ${cacheKeys.length}`,
        cacheKeys.length > 0 ? 'VERIFIED' : 'UNVERIFIED', { evictedCacheRows: cacheKeys.length,
          restartReadback: true, headIdentical: true, recallIdentical: true,
          missing: cacheKeys.length > 0 ? null : 'the fixture contained zero matching cache rows, so eviction itself was not exercised' });
    } finally { await snap.cleanup(); }
  }

  // ── G07/G09: terminal-job cancellation guard (in-flight cases remain unverified) ───────
  {
    const snap = await serverFixture({ mode: 'server_only' });
    try {
      const f = snap.f;
      await f.run();
      const callsBefore = f.control.calls.length;
      const initialStatus = await f.r.api.getCanonicalJobStatus({}).catch(e => ({ error: String(e.message) }));
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G07/G09: fixture must create a canonical row');
      const canonicalBefore = JSON.parse(rawCanonical(snap, ref));
      const headBefore = await f.r.api.getCurrentStateHead();
      const headLogical = head => JSON.stringify({
        status: head?.status, worldlineId: head?.worldlineId, throughTurn: head?.throughTurn,
        reviewedThroughCanonical: {
          memoryId: head?.reviewedThroughCanonical?.memoryId,
          revision: head?.reviewedThroughCanonical?.revision,
          artifactDigest: head?.reviewedThroughCanonical?.artifactDigest,
          worldlineId: head?.reviewedThroughCanonical?.worldlineId
        },
        characters: (head?.characters || []).map(character => ({ id: character.id, state: character.state }))
      });
      // run() has already completed. This probes the explicit terminal-job guard only.
      const pending = f.r.api.retryPendingUnifiedState().catch(e => ({ error: String(e.message) }));
      const cancelled = await f.r.api.cancelCanonicalJob({}).catch(e => ({ error: String(e.message) }));
      const status = await f.r.api.getCanonicalJobStatus({}).catch(e => ({ error: String(e.message) }));
      await pending;
      const headAfterCancel = await f.r.api.getCurrentStateHead();
      const canonicalAfterCancel = JSON.parse(rawCanonical(snap, ref));
      assert.equal(cancelled?.ok, false, 'G09: a completed job cannot be cancelled as in-flight');
      assert.equal(cancelled?.reason, 'canonical_job_not_cancellable', 'G09: terminal cancellation is explicitly rejected');
      assert.ok(['completed', 'failed', 'cancelled'].includes(status?.state),
        `G07/G09: the observed job must be terminal (${JSON.stringify(status)})`);
      assert.equal(f.control.calls.length, callsBefore, 'G09: cancellation did not trigger a provider call');
      assert.equal(canonicalAfterCancel.sourceDigest, canonicalBefore.sourceDigest,
        'G09: terminal cancellation attempt leaves the source digest unchanged');
      assert.equal(canonicalAfterCancel.artifactDigest, canonicalBefore.artifactDigest,
        'G09: terminal cancellation attempt leaves the artifact digest unchanged');
      assert.deepEqual(canonicalAfterCancel.canonicalArtifact, canonicalBefore.canonicalArtifact,
        'G09: terminal cancellation attempt leaves canonical artifact content unchanged');
      assert.equal(headLogical(headAfterCancel), headLogical(headBefore),
        'G09: terminal cancellation attempt leaves logical Head state unchanged');
      const changedEnvelopeFields = [...new Set([...Object.keys(canonicalBefore), ...Object.keys(canonicalAfterCancel)])]
        .filter(key => JSON.stringify(canonicalBefore[key]) !== JSON.stringify(canonicalAfterCancel[key]));
      record('G07', 'Inspect job status after a completed run; no in-flight mode transition was started',
        `terminal job status ${status?.state || 'unknown'}; this block did not change storage mode during work`,
        'UNVERIFIED', { initialJobStatus: initialStatus ?? null, jobStatus: status ?? null,
          artifactUnchanged: true, headLogicalStateUnchanged: true,
          missing: 'actual storage-mode transition while a cancellable canonical job is in flight' });
      record('G09', 'Attempt cancellation after completion and re-read the authoritative state',
        `terminal cancellation rejected as ${cancelled.reason}; artifact, logical Head and provider-call count stayed unchanged; envelope fields changed ${changedEnvelopeFields.join(',') || 'none'}`,
        'UNVERIFIED', { cancel: cancelled, jobStatus: status ?? null, canonicalOwner: 'server',
          artifactUnchanged: true, logicalHeadUnchanged: true, changedEnvelopeFields, extraProviderCalls: 0,
          missing: 'held provider response, cancellation before release, late response release, and post-release commit check' });
    } finally { await snap.cleanup(); }
  }

  // ── G08: read delay, write failure, corrupt readback must be disclosed ───────────────────
  {
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snap.f;
      await f.run();
      // a corrupt readback at the storage boundary must not be reported as success
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G08: fixture must create a canonical row');
      const original = rawCanonical(snap, ref);
      snap.local.set(ref.key, JSON.stringify({ schema: 'libra.canonical_memory.v1', memoryId: ref.memoryId, revision: ref.revision, corrupted: true }));
      let disclosed = null;
      try {
        const rebuilt = await f.r.api.rebuildWorldManagerState({});
        disclosed = rebuilt?.ok === false
          ? { kind: 'explicit_failure', code: String(rebuilt.error || rebuilt.code || 'rebuild_failed') }
          : { kind: 'survived_but_reported', ok: rebuilt?.ok };
      } catch (error) {
        disclosed = { kind: 'threw', code: String(error.message) };
      }
      snap.local.set(ref.key, original);
      assert.ok(disclosed?.kind === 'explicit_failure' || disclosed?.kind === 'threw',
        `G08: corrupt canonical data must be rejected, observed ${JSON.stringify(disclosed)}`);
      assert.equal(rawCanonical(snap, ref), original, 'G08: the original canonical bytes are restored and read back');
      record('G08', 'Inject corrupt canonical data; restore and re-read the original row',
        `corrupt row was disclosed as ${disclosed.kind}${disclosed.code ? ': ' + disclosed.code : ''}; restored bytes read back`,
        'UNVERIFIED', { disclosure: disclosed, corruptRowRejected: true, restoredReadback: true,
          missing: 'read delay and failed-write injection were not exercised' });
    } finally { await snap.cleanup(); }
  }

  // ── G15: peers absent — the target owner must still work ────────────────────────────────
  {
    // The fixture host exposes only LIBRA and no peer plugin, which IS the peer-absent case.
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snap.f;
      const run = await f.run();
      const head = await f.r.api.getCurrentStateHead();
      const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차');
      const lineage = await f.r.api.getHostLineageStatus();
      assert.equal(run.completed, 1, 'G15: LIBRA commits with no peer plugin present');
      assert.ok(head, 'G15: the Head works with no peer');
      assert.ok(recall?.memories?.length > 0, 'G15: recall works with no peer');
      record('G15', 'Run the target owner with every peer plugin absent',
        `LIBRA ran alone: batch committed, Head readable, recall returned ${recall.memories.length} memories, lineage surface answered (no coordinator wait)`,
        'VERIFIED', { peersPresent: false, lineage: lineage ?? null });
    } finally { await snap.cleanup(); }
  }

  // ── G13: mirror vs server_only on a healthy server ──────────────────────────────────────
  {
    const results = {};
    for (const mode of ['mirror', 'server_only']) {
      const snap = await serverFixture({ mode });
      try {
        const f = snap.f;
        await f.run();
        const head = await f.r.api.getCurrentStateHead();
        const recall = await f.r.api.previewUnifiedMemoryRecall('민아 민트차 열쇠');
        const ref = Object.values(snap.getManifest()?.memories || {})[0];
        const serverRow = snap.storedRows().find(r => r.key === ref.key);
        const localRow = [...snap.local.entries()].map(([k, raw]) => { let v = raw; try { v = JSON.parse(raw); } catch {} return { key: k, value: v }; }).find(r => r.key === ref.key);
        // The canonical payload is what must agree across modes. Per-run bookkeeping
        // (runId, createdAt/updatedAt, the server URL/port, the mode name and the read-set
        // digests derived from them) necessarily differs between two processes, so comparing
        // whole envelopes would measure the harness rather than the canonical data. Measured:
        // the two modes differed only in those 14 bookkeeping fields.
        const payload = serverRow?.value || {};
        results[mode] = {
          headFacts: JSON.stringify(head?.characters?.map(c => ({ n: c.name, s: c.state })) || null),
          recallCount: recall?.memories?.length ?? 0,
          canonicalPayload: sha256(JSON.stringify({
            schema: payload.schema, memoryId: payload.memoryId, scopeKey: payload.scopeKey,
            worldlineId: payload.worldlineId, branchId: payload.branchId, turnRange: payload.turnRange,
            sourceDigest: payload.sourceDigest, artifactDigest: payload.artifactDigest,
            artifactSchema: payload.artifactSchema, canonicalArtifact: payload.canonicalArtifact,
            sourcePairs: payload.sourcePairs, status: payload.status, revision: payload.revision
          })),
          hasServerRow: !!serverRow,
          localMirrorAgrees: mode === 'mirror' ? sha256(JSON.stringify(localRow?.value ?? null)) === sha256(JSON.stringify(payload)) : null
        };
      } finally { await snap.cleanup(); }
    }
    assert.equal(results.mirror.headFacts, results.server_only.headFacts, 'G13: both modes agree on logical Head state');
    assert.equal(results.mirror.recallCount, results.server_only.recallCount, 'G13: both modes return the same recall count');
    assert.equal(results.mirror.canonicalPayload, results.server_only.canonicalPayload,
      'G13: both modes reach the same canonical payload on the server');
    assert.equal(results.mirror.localMirrorAgrees, true,
      'G13: mirror keeps its local replica byte-identical to the server copy it mirrors');
    assert.equal(results.server_only.hasServerRow, true, 'G13: server_only has no local substitute');
    record('G13', 'Run mirror and server_only with a healthy server; compare logical results and raw authority',
        `Head state and recall agreed; canonical payload identical across modes (${String(results.mirror.canonicalPayload).slice(0, 12)}…); mirror replica byte-identical to the server copy`,
        'VERIFIED', results);
  }

  // ── G14: successful production Recall drives Compute; error modes stay unverified ──────
  {
    const snap = await serverFixture({ mode: 'server_only' });
    try {
      const f = snap.f;
      await f.run();
      const before = f.r.api.getMemorySuiteComputeStatus();
      const bootstrap = await snap.send('POST', '/v1/compute/bootstrap', { namespace: 'libra' });
      assert.equal(bootstrap.status, 200, `G14: read the server's advertised version: ${JSON.stringify(bootstrap)}`);
      const recall = await f.r.api.previewUnifiedMemoryRecall('은빛 열쇠를 지금 누가 가지고 있어');
      const status = f.r.api.getMemorySuiteComputeStatus();
      const idle = await f.r.api.waitForMemorySuiteComputeIdle();
      assertComputeSuccess(status, bootstrap.version, before);
      assert.ok(recall?.memories?.length > 0, 'G14: the production Recall consumer returned a candidate');
      assert.equal(idle?.inFlight, 0, 'G14: idle wait returns after the Compute request settles');
      const computePaths = snap.requests.map(request => new URL(request.url).pathname)
        .filter(route => route === '/v1/compute/bootstrap' || route === '/v1/compute/execute');
      assert.ok(computePaths.includes('/v1/compute/execute'), 'G14: the product operation reached the server Compute endpoint');
      record('G14', 'Run a production Recall that uses Compute and validate its negotiated server result',
        `Recall reached Compute server ${status.serverVersion}; state ${status.state}, server calls +${status.counters.server - before.counters.server}, fallbacks +${status.counters.fallbacks - before.counters.fallbacks}`,
        'UNVERIFIED', { positiveControl: 'production Recall Compute success', computeStatus: status,
          idle, serverVersion: status.serverVersion, advertisedVersion: bootstrap.version,
          computePaths, recallCount: recall.memories.length,
          missing: 'provider failure and Compute version-mismatch responses were not injected into this product path' });
    } finally { await snap.cleanup(); }
  }

  // ── G17: immutable archive/source payload bytes before and after export ─────────────────
  {
    const snap = await serverFixture({ mode: 'plugin_only' });
    try {
      const f = snap.f;
      await f.run();
      const ref = firstRefOf(snap);
      assert.ok(ref?.key, 'G17: fixture must create a canonical row');
      const rawBefore = rawCanonical(snap, ref);
      const export1 = await f.r.api.exportLibraScope({});
      const rawAfter = rawCanonical(snap, ref);
      assert.equal(export1?.schema, 'libra.scope_export.v1', 'G17: export returns the scope export contract');
      assert.ok(export1?.memories?.length > 0, 'G17: export includes the canonical memory');
      assert.equal(export1?.error, '', 'G17: export reports no error');
      assert.equal(rawAfter, rawBefore, 'G17: export leaves the source payload bytes untouched');
      record('G17', 'Export a populated scope and re-read its authoritative source payload',
        `scope export returned ${export1.memories.length} memory; pluginStorage-owned source payload stayed byte-identical (${rawBefore.length} chars)`,
        'VERIFIED', { bytesPreserved: true, exportSchema: export1.schema,
          exportedMemoryCount: export1.memories.length, sourceOwner: 'pluginStorage',
          exportedCanonicalIds: export1.memories.map(memory => memory.memoryId || memory.id || null) });
    } finally { await snap.cleanup(); }
  }

  // ── G18: current/past/branch/alias/unrecalled-promise recall semantics ──────────────────
  {
    const snap = await serverFixture({ mode: 'server_only' });
    try {
      const f = snap.f;
      await f.run();
      const queries = [
        { query: '은빛 열쇠를 지금 누가 가지고 있어', expected: '지호가 열쇠를 민아에게 반환했다', meaning: 'latest possession event' },
        { query: '준호가 열쇠를 들었을 때', expected: '준호가 지호에게서 열쇠를 받아 들었다', meaning: 'past possession event' },
        { query: '상자의 암호', expected: '민아만 상자의 암호를 들었다', meaning: 'character knowledge' },
        { query: '열쇠 반환 약속', expected: '오늘 열쇠를 반환하겠다는 약속이 이행되었다', meaning: 'resolved promise' }
      ];
      const observed = [];
      for (const item of queries) {
        const recall = await f.r.api.previewUnifiedMemoryRecall(item.query);
        const excerpt = assertRecallContains(recall, item.expected);
        observed.push({ query: item.query, meaning: item.meaning, memoryCount: recall.memories.length,
          matchedText: item.expected, excerpt: excerpt.slice(0, 260) });
      }
      const fixtureManifest = snap.getManifest();
      record('G18', 'Check Recall excerpts against current/past possession, knowledge and resolved-promise evidence',
        `${observed.length} queries returned source-backed excerpt matches from ${Object.keys(fixtureManifest?.memories || {}).length} canonical memory`,
        'UNVERIFIED', { queries: observed, canonicalMemoryCount: Object.keys(fixtureManifest?.memories || {}).length,
          missing: 'separate branch and alias fixtures plus a promise deliberately absent from Recall' });
    } finally { await snap.cleanup(); }
  }

  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'))).digest('hex');
  const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log(JSON.stringify({ marker: 'G02-G18-libra-scope-closure', rows, negativeControls,
    sourceSha256: sourceHash, testSha256: testHash,
    notClaimed: { G02: 'HAYAKU/SDK source projection owner', G03: 'HAYAKU/SDK normalization owner',
      G16: 'requires the real RisuAI DOM (live host), not run in this partition' },
    testResult: 'PASS', result: rows.some(row => row.status === 'UNVERIFIED') ? 'PASS_WITH_UNVERIFIED_ROWS' : 'PASS' }));
})().catch(error => {
  console.log(JSON.stringify({ marker: 'G02-G18-libra-scope-failed', message: String(error && error.message || error) }));
  console.error(error);
  process.exit(1);
});
