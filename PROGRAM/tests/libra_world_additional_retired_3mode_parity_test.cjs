'use strict';
// P07 — LIBRA-WORLD-ADDITIONAL-RETIRED was `unverified` for mirror and server_only.
//
// Feature: World Additional (retired migration path). The inventory names one entry point,
// purgeLegacyWorldAdditionalData, with the expectation "legacy world-additional records are removed
// with a durable migration marker" under schema libra.world_additional_removal.v1 and key
// libra:v1:migration:remove-world-additional:v1. Storage class: diagnostic. branchSensitive true.
//
// Why it was unverified: the one registered test (libra_world_additional_retirement_marker_runtime_test.cjs)
// drives the purge in a single mode. A `verified_supported` status needs the executed entry point plus
// durable readback per mode, so this drives the real purge in all three and reads the marker back from
// the authority each mode actually uses.
//
// WHAT IS ASSERTED: the purge runs, removes the legacy :world-additional: records, and writes a durable
// marker whose report is readable afterwards — in every mode. The marker is the contract: a second run
// must be idempotent (existing.done === true returns the same marker) unless force is passed.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  return source
    .replace(coreAnchor, '      worldAdditionalInternals: { purgeLegacyWorldAdditionalData, storageProbe: { keys: () => storage.keys(), set: (k, v) => storage.setJson(k, v) } },\n' + coreAnchor)
    .replace(publicAnchor, '    worldAdditionalInternals(){ return LibraMemoryCore.worldAdditionalInternals; },\n' + publicAnchor);
};

const parseMaybe = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

// The marker key is `libra:v1:migration:remove-world-additional:v1` (measured from the source). The
// server fixture passes pluginStorage/safeLocalStorage = its own `local` Map into the harness, so that
// is where a plugin_only write lands; server-backed modes also mirror into the server rows.
const MARKER_SUFFIX = ':migration:remove-world-additional:v1';
const markerFromStore = (fixture) => {
  const store = fixture.local;
  if (store && typeof store.keys === 'function') {
    const key = [...store.keys()].find(k => k.endsWith(MARKER_SUFFIX)) || [...store.keys()].find(k => /remove-world-additional/.test(k));
    if (key) return { key, value: parseMaybe(store.get(key)) };
  }
  const rows = (fixture.getRecords?.('libra.world_additional_removal.v1') || []);
  return rows.length ? { key: rows[0].key, value: rows[0].value } : null;
};

// A legacy record the purge is supposed to find and remove.
const legacyKey = key => key.includes(':world-additional:');

(async () => {
  const report = {};

  for (const mode of MODES) {
    const fixture = await serverFixture({ mode, transformSource: instrument });
    const modeReport = { mode };
    try {
      const api = fixture.f.r.api;
      const internals = api.worldAdditionalInternals();
      modeReport.entryPoint = typeof internals?.purgeLegacyWorldAdditionalData;

      // Seed a legacy record the purge must remove, plus an unrelated record it must keep.
      //
      // SEEDED THROUGH THE PLUGIN'S STORAGE API, not by poking the fixture's raw Map. Measured:
      // `storage.keys()` returns keys written through the plugin in ALL modes, but in mirror and
      // server_only it does not see keys injected directly into the raw Map (plugin_only sees both).
      // A raw poke is not a real-world scenario — a legacy record was written by an older plugin
      // version through its own storage layer — so seeding that way produced a false defect report
      // before this was corrected.
      const probe = internals.storageProbe;
      const keepKey = 'libra:v1:scope:purge-probe:manifest';
      await probe.set('libra:v1:scope:purge-probe:world-additional:legacy:1', { schema: 'libra.world_additional.legacy.v1', id: 'legacy-1' });
      await probe.set(keepKey, { schema: 'libra.manifest.v1', kept: true });
      const visible = await probe.keys();
      modeReport.legacySeeded = visible.filter(legacyKey).length;

      const result = parseMaybe(await internals.purgeLegacyWorldAdditionalData({ force: true }));
      modeReport.purge = result && typeof result === 'object'
        ? { schema: result.schema || null, removedCandidateRecords: result.removedCandidateRecords ?? null, cleanedManifests: result.cleanedManifests ?? null, errors: Array.isArray(result.errors) ? result.errors.length : null }
        : { value: String(result).slice(0, 120) };

      // The legacy records must be gone and the unrelated record must survive, read through the same
      // authority the purge itself walks.
      const after = (await probe.keys()).filter(legacyKey);
      modeReport.legacyRemaining = after.length;
      modeReport.unrelatedKept = (await probe.keys()).includes(keepKey);

      // The durable marker must exist and carry the removal report.
      const marker = markerFromStore(fixture);
      modeReport.marker = marker
        ? { keyTail: String(marker.key).slice(-48), schema: marker.value?.schema || null, done: marker.value?.done ?? null, values: typeof marker.value === 'object' ? Object.keys(marker.value).slice(0, 10) : null }
        : null;

      // Idempotence: without force, a completed purge returns the stored marker instead of redoing work.
      const second = parseMaybe(await internals.purgeLegacyWorldAdditionalData());
      modeReport.secondRun = second && typeof second === 'object'
        ? { schema: second.schema || null, done: second.done ?? null, removedCandidateRecords: second.removedCandidateRecords ?? null }
        : { value: String(second).slice(0, 120) };

      report[mode] = modeReport;
    } finally {
      await fixture.cleanup();
    }
  }

  for (const mode of MODES) {
    const r = report[mode];
    assert.ok(r, `${mode} must have produced a report`);
    assert.equal(r.entryPoint, 'function', `${mode}: purgeLegacyWorldAdditionalData must be callable`);
    assert.ok(r.legacySeeded > 0, `${mode}: the legacy record must be seeded for this to mean anything`);
    assert.equal(r.legacyRemaining, 0, `${mode}: the legacy world-additional records must be removed`);
    assert.equal(r.unrelatedKept, true, `${mode}: the purge must not remove unrelated records`);
    assert.ok(r.marker, `${mode}: a durable migration marker must be written`);
    assert.equal(r.marker.schema, 'libra.world_additional_removal.v1',
      `${mode}: the marker must carry the declared schema (got ${r.marker.schema})`);
    assert.equal(r.secondRun.done, true, `${mode}: a second purge must be idempotent and report done`);
  }

  console.log(JSON.stringify({ suite: 'libra_world_additional_retired_3mode_parity', ...report }, null, 1));
  console.log('libra_world_additional_retired_3mode_parity_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_world_additional_retired_3mode_parity_test: FAIL');
  process.exitCode = 1;
});
