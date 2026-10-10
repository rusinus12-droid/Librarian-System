'use strict';
// Task 21 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// LIBRA-WORLD-ADDITIONAL-RETIRED was recorded as plugin_only = verified_supported
// with `tests: []` and requiredWork "Add a focused test for the retirement marker
// readback." The only file under tests/ that mentioned
// `WORLD_ADDITIONAL_REMOVAL_MIGRATION_KEY` was `_libra_rc2_commit9_repro.js`,
// which is an embedded copy of old LIBRA v2.2.8 source and is skipped by the
// regression runner because it does not end in `_test.cjs`.
//
// This test drives the real retirement entry point against a real legacy tree
// and asserts the durable migration marker:
//
//   legacy candidate records + legacy manifest fields
//     -> purgeLegacyWorldAdditionalData
//     -> candidates physically removed, manifests cleaned
//     -> `libra:v1:migration:remove-world-additional:v1` marker is durable
//     -> a second run is idempotent and a reloaded runtime reads the marker back
const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PREFIX = 'libra:v1';
const MARKER_KEY = `${PREFIX}:migration:remove-world-additional:v1`;
const SCOPE = 'world-additional-scope';

// Expose the closure-owned retirement entry point. The deployed plugin file is
// never modified: the harness reads it as a string and runs it in a VM.
// The exposure is injected *after* the definition so the closure binding is
// already initialised when the assignment runs.
const HOOK = `    const memoryRefForStart = (manifest, startTurn) =>`;
const expose = source => {
  assert.ok(source.includes('const purgeLegacyWorldAdditionalData = async'), 'retirement entry point exists in the deployed LIBRA source');
  assert.ok(source.includes(HOOK), 'retirement entry point is followed by the expected anchor line');
  return source.replace(
    HOOK,
    `    globalThis.__libraWorldAdditionalTest = { purgeLegacyWorldAdditionalData };\n${HOOK}`
  );
};

const seededManifest = () => ({
  schema: 'libra.manifest.v1',
  version: '2.3.126',
  scopeKey: SCOPE,
  commitId: 'legacy-commit',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  memories: {},
  // Every retired field shape the purge is required to understand.
  worldAdditionalIds: ['legacy-world-additional-1', 'legacy-world-additional-2'],
  nativeChatCopy: { copiedFromChatId: 'legacy-parent', worldAdditional: { entries: [1, 2, 3] } },
  lastSessionHandoff: { transferId: 'legacy-handoff', worldAdditional: { entries: [4] }, worldAdditionalIds: ['legacy-world-additional-3'] },
  stats: { evidenceRepairs: 1, evidenceFallbacks: 2, evidenceRejects: 3, kept: 9 }
});

const legacyKeys = () => [
  `${PREFIX}:scope:${SCOPE}:world-additional:1`,
  `${PREFIX}:scope:${SCOPE}:world-additional:2`,
  `${PREFIX}:scope:${SCOPE}:world-additional:3`
];
const manifestKey = `${PREFIX}:scope:${SCOPE}:manifest`;

const readJson = (values, key) => {
  const raw = values.get(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};

const runPurge = async (harness, options) => {
  const entry = harness.context.__libraWorldAdditionalTest;
  assert.ok(entry?.purgeLegacyWorldAdditionalData, 'the retirement entry point is reachable for execution');
  return await entry.purgeLegacyWorldAdditionalData(options);
};

(async () => {
  const initialValues = [
    ...legacyKeys().map((key, index) => [key, JSON.stringify({ schema: 'libra.world_additional.v1', id: `legacy-${index + 1}`, text: `retired candidate ${index + 1}` })]),
    [manifestKey, JSON.stringify(seededManifest())]
  ];
  const harness = await createLibraVmHarness({}, {}, { initialValues, transformSource: expose });
  let reloaded = null;
  const observations = {};
  try {
    const markerBefore = readJson(harness.values, MARKER_KEY);
    assert.equal(markerBefore, null, 'no retirement marker exists before the migration runs');

    // --- real entry point execution -----------------------------------------
    const report = await runPurge(harness);
    assert.equal(report.schema, 'libra.world_additional_removal.v1');
    assert.equal(report.done, true, 'the migration reports completion');
    assert.equal(report.ok, true, `the migration reports no errors: ${JSON.stringify(report.errors)}`);
    // Cross-realm note: objects returned from the plugin VM are not
    // reference-equal to host Array prototypes, so compare length not identity.
    assert.equal(report.errors.length, 0, `the migration reports no errors: ${JSON.stringify(report.errors)}`);
    assert.equal(report.removedCandidateRecords, legacyKeys().length, 'every legacy world-additional candidate record was removed');
    assert.equal(report.cleanedManifests, 1, 'the legacy manifest was cleaned exactly once');
    // The purge can finish inside the same millisecond it started, so require a
    // valid, non-decreasing pair of timestamps rather than a strict increase.
    const startedMs = Date.parse(report.startedAt);
    const finishedMs = Date.parse(report.finishedAt);
    assert.ok(Number.isFinite(startedMs), `startedAt is a timestamp: ${report.startedAt}`);
    assert.ok(Number.isFinite(finishedMs), `finishedAt is a timestamp: ${report.finishedAt}`);
    assert.ok(finishedMs >= startedMs, `finishedAt is not before startedAt: ${report.startedAt} -> ${report.finishedAt}`);
    // Idempotency is proven by the re-run below, which must not move either stamp,
    // so no elapsed-time requirement is needed here.
    observations.report = report;

    // --- durable readback ---------------------------------------------------
    for (const key of legacyKeys()) {
      assert.equal(harness.values.has(key), false, `legacy candidate removed from durable storage: ${key}`);
    }
    const marker = readJson(harness.values, MARKER_KEY);
    assert.ok(marker, 'the retirement marker is durable');
    assert.equal(marker.done, true);
    assert.equal(marker.ok, true);
    assert.equal(marker.removedCandidateRecords, report.removedCandidateRecords);
    assert.equal(marker.cleanedManifests, report.cleanedManifests);
    assert.ok(marker.finishedAt, 'the marker records when the migration finished');

    const cleaned = readJson(harness.values, manifestKey);
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned, 'worldAdditionalIds'), false, 'manifest worldAdditionalIds was deleted');
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned.nativeChatCopy || {}, 'worldAdditional'), false, 'nativeChatCopy.worldAdditional was deleted');
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned.lastSessionHandoff || {}, 'worldAdditional'), false, 'lastSessionHandoff.worldAdditional was deleted');
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned.lastSessionHandoff || {}, 'worldAdditionalIds'), false, 'lastSessionHandoff.worldAdditionalIds was deleted');
    // The purge must not damage unrelated manifest data.
    assert.equal(cleaned.commitId, 'legacy-commit', 'unrelated manifest identity is preserved');
    assert.equal(cleaned.schema, 'libra.manifest.v1');
    assert.deepEqual(cleaned.nativeChatCopy.copiedFromChatId, 'legacy-parent', 'unrelated nested manifest data is preserved');
    assert.deepEqual(cleaned.lastSessionHandoff.transferId, 'legacy-handoff');
    observations.cleanedManifest = cleaned;

    // --- idempotency --------------------------------------------------------
    const second = await runPurge(harness);
    assert.equal(second.done, true);
    assert.equal(second.startedAt, report.startedAt, 'a completed migration is not re-run');
    assert.equal(second.finishedAt, report.finishedAt);
    assert.equal(second.removedCandidateRecords, report.removedCandidateRecords);
    assert.equal(harness.values.has(MARKER_KEY), true);

    // --- reload: the marker is the durable authority ------------------------
    reloaded = await createLibraVmHarness({}, {}, { initialValues: [...harness.values.entries()], transformSource: expose });
    const reloadedMarker = readJson(reloaded.values, MARKER_KEY);
    assert.ok(reloadedMarker, 'a fresh runtime reads the retirement marker back from storage');
    assert.equal(reloadedMarker.done, true);
    assert.equal(reloadedMarker.finishedAt, marker.finishedAt);
    const afterReload = await runPurge(reloaded);
    assert.equal(afterReload.startedAt, report.startedAt, 'the reloaded runtime skips the already-completed migration');
    assert.equal(reloaded.values.has(legacyKeys()[0]), false, 'no legacy candidate is resurrected on reload');
    observations.reload = { skipped: true, finishedAt: reloadedMarker.finishedAt };

    console.log(JSON.stringify({
      test: 'libra_world_additional_retirement_marker_runtime',
      passed: 1,
      boundary: 'real deployed LIBRA retirement entry point + durable marker readback; no model, provider or backend calls',
      observations
    }));
  } finally {
    if (reloaded) await reloaded.cleanup();
    await harness.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
