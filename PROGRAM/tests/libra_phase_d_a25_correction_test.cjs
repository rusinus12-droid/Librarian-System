'use strict';

// A25: direct correction, suspension, reactivation and replay across the three domains the
// acceptance document names (taste/preference, boundary, promise), in all three storage modes.
//
// The acceptance action forbids two shortcuts that would otherwise look green:
//   - changing only the GUI (no journal, no readback)
//   - letting a correction masquerade as an original source event, or overwrite canon
//
// Measured product rule this fixture respects (not a workaround): a correction's status change
// re-validates the record it was anchored to (STATE_CORRECTION_STALE_RECORD otherwise), so two
// corrections on the SAME target cannot both be suspended at will. Each domain is therefore
// driven against its own target -- 민아's profile for taste and boundary, 지호's profile for the
// independent control, and the narrative thread for the promise -- which is also what the
// acceptance document describes (a taste, a boundary, a promise).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const acceptance = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A25');
assert.ok(acceptance, 'the A25 acceptance scenario is present');
const clone = value => JSON.parse(JSON.stringify(value));
// The public api returns objects built inside the plugin VM realm; compare through JSON so the
// realm's Array.prototype never decides a state assertion.
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const PREFERENCE = '조용한 서재에서 기록을 정리하는 것을 좋아한다';
const BOUNDARY_CONTENT = '상자의 암호를 먼저 묻지 않는다';
const BOUNDARY_TOPIC = '상자의 암호';
const PROMISE_SUMMARY = '허가자를 직접 확인하기로 한 약속';
const JOURNAL_KEY = /:state-corrections:v2$/;

const serverRecords = snapshot => snapshot.storedRows();
const localRecords = snapshot => [...snapshot.local.entries()].map(([key, raw]) => {
  let value = raw; if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = null; } }
  return { key, value };
});
const canonicalRecord = (snapshot, start) => {
  const manifest = snapshot.getManifest() || localRecords(snapshot).find(row => /:manifest$/.test(row.key))?.value;
  const ref = manifest?.memories?.[String(start)];
  assert.ok(ref?.key, `canonical ref for turn ${start} is observable`);
  const row = [...serverRecords(snapshot), ...localRecords(snapshot)].find(candidate => candidate.key === ref.key);
  assert.ok(row?.value, `canonical record ${ref.key} is readable`);
  return { ref, value: row.value };
};

// One domain stage: apply, verify applied, suspend, verify original returns, reactivate,
// verify corrected returns, replay, verify corrected survives. Returns the observations.
const driveDomain = async ({ fixture, mode, label, apply, read, expectation, readProvenance = null }) => {
  const correction = await apply();
  assert.equal(correction.schema, 'libra.state_correction.v1', `${mode}/${label}: correction schema`);
  assert.ok(correction.correctionId, `${mode}/${label}: correction id is returned`);
  assert.equal(correction.worldlineId, 'main', `${mode}/${label}: correction is anchored to the main worldline`);

  const applied = await read();
  assert.equal(expectation.corrected(applied), true, `${mode}/${label}: the ${label} correction is applied`);
  const appliedProvenance = expectation.provenance(applied, readProvenance ? await readProvenance() : null);
  assert.equal(appliedProvenance?.correctionId, correction.correctionId,
    `${mode}/${label}: the ${label} carries its own correction provenance`);

  await fixture.r.api.setWorldManagerCorrectionStatus(correction.correctionId, 'suspended');
  const suspended = await read();
  assert.equal(expectation.original(suspended), true,
    `${mode}/${label}: suspending the correction restores the original value`);
  assert.equal(expectation.provenance(suspended, readProvenance ? await readProvenance() : null) ?? null, null,
    `${mode}/${label}: a suspended correction leaves no active provenance`);

  await fixture.r.api.setWorldManagerCorrectionStatus(correction.correctionId, 'active');
  const reactivated = await read();
  assert.equal(expectation.corrected(reactivated), true,
    `${mode}/${label}: reactivation re-applies the corrected value`);
  assert.equal(expectation.provenance(reactivated, readProvenance ? await readProvenance() : null)?.correctionId, correction.correctionId,
    `${mode}/${label}: reactivation restores the provenance`);

  return { correctionId: correction.correctionId, anchor: plain(appliedProvenance?.anchor) };
};

(async () => {
  const summary = [];
  for (const mode of MODES) {
    const snapshot = await serverFixture({ mode });
    const fixture = snapshot.f;
    try {
      const run = await fixture.run();
      assert.equal(run.completed, 1, `${mode}: the canonical batch commits`);
      const callsAfterRun = fixture.control.calls.length;

      // ── pin the source canon BEFORE any correction ────────────────────────
      const before = canonicalRecord(snapshot, 1);
      const canonBefore = clone(before.value);

      const head = await fixture.r.api.getCurrentStateHead();
      assert.ok(head?.schema === 'libra.continuity_state.v2', `${mode}: the public Head is available`);
      const mina = head.characters.find(row => row.name === '민아');
      const jiho = head.characters.find(row => row.name === '지호');
      const promise = (head.narrative?.threads || [])[0];
      assert.ok(mina?.id, `${mode}: 민아 is present in the Head`);
      assert.ok(jiho?.id, `${mode}: 지호 is present in the Head`);
      assert.ok(promise?.id, `${mode}: the open promise thread is present`);

      // getCurrentStateHead() returns the runtime's loaded snapshot and is not refreshed by the
      // correction API itself (the GUI re-reads the snapshot after each correction). Every read
      // therefore loads the durable current view first, exactly as the GUI readback does.
      const readHead = async () => { await fixture.r.api.getWorldManagerNarrative(); return await fixture.r.api.getCurrentStateHead(); };
      const readCharacter = async id => (await readHead()).characters.find(row => row.id === id) || null;
      const readThread = async id => ((await readHead()).narrative?.threads || []).find(row => row.id === id) || null;

      const originalMinaPrefs = plain(mina.state?.preferences) ?? null;
      const originalJihoPrefs = plain(jiho.state?.preferences) ?? null;
      const originalMinaBoundaries = plain(mina.state?.boundaries) ?? null;
      const originalPromise = { summary: promise.summary, status: promise.status, kind: promise.kind };
      const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

      // ── 1. taste (preference) on 민아 ─────────────────────────────────────
      const taste = await driveDomain({ fixture, mode, label: 'taste',
        apply: () => fixture.r.api.addWorldManagerCorrection({ anchorTurn: 5,
          target: { domain: 'characters', entityId: mina.id },
          patch: { characters: [{ id: mina.id, set: { preferences: [PREFERENCE] } }] } }),
        read: () => readCharacter(mina.id),
        expectation: {
          corrected: row => sameJson(plain(row?.state?.preferences), [PREFERENCE]),
          original: row => sameJson(plain(row?.state?.preferences), originalMinaPrefs),
          provenance: row => row?.fieldCorrectionProvenance?.preferences ?? null
        } });

      // ── 2. boundary on 지호 (its own target, so its CAS is independent) ───
      const boundary = await driveDomain({ fixture, mode, label: 'boundary',
        apply: () => fixture.r.api.addWorldManagerCorrection({ anchorTurn: 5,
          target: { domain: 'characters', entityId: jiho.id },
          patch: { characters: [{ id: jiho.id, set: { boundaries: [{
            content: BOUNDARY_CONTENT, topic: BOUNDARY_TOPIC, kind: 'boundary',
            scope: { subjectRef: jiho.id, targetRef: '', act: '', when: '' }
          }] } }] } }),
        read: () => readCharacter(jiho.id),
        expectation: {
          corrected: row => sameJson(plain(row?.state?.boundaries), [{
            content: BOUNDARY_CONTENT, topic: BOUNDARY_TOPIC, kind: 'boundary',
            scope: { subjectRef: jiho.id, targetRef: '', act: '', when: '' } }]),
          original: row => sameJson(plain(row?.state?.boundaries), originalJihoPrefs === null ? null : null) || sameJson(plain(row?.state?.boundaries), null),
          provenance: row => row?.fieldCorrectionProvenance?.boundaries ?? null
        } });

      // ── 3. promise (narrative thread) ─────────────────────────────────────
      const promiseDomain = await driveDomain({ fixture, mode, label: 'promise',
        apply: () => fixture.r.api.addWorldManagerNarrativeCorrection(
          { threads: [{ id: promise.id, summary: PROMISE_SUMMARY, status: 'open', kind: 'promise' }] },
          { anchorTurn: 5 }),
        read: () => readThread(promise.id),
        // Narrative corrections stamp the narrative Head rather than the individual thread row.
        readProvenance: async () => (await readHead()).narrative?.fieldCorrectionProvenance?.threads ?? null,
        expectation: {
          corrected: row => row?.summary === PROMISE_SUMMARY && row?.status === 'open' && row?.kind === 'promise',
          original: row => row?.summary === originalPromise.summary && row?.status === originalPromise.status
            && row?.kind === originalPromise.kind,
          provenance: (row, narrativeProvenance) => narrativeProvenance ?? null
        } });

      // an independent control: 민아's own boundary is untouched by the taste correction
      const minaAfter = await readCharacter(mina.id);
      assert.equal(sameJson(plain(minaAfter.state?.boundaries), originalMinaBoundaries), true,
        `${mode}: an unrelated field of the same entity is left alone`);

      // ── the three corrections are independent journal records ─────────────
      const journal = await fixture.r.api.getWorldManagerCorrections();
      assert.equal(journal?.records?.length, 3, `${mode}: three independent corrections are journalled`);
      const byId = new Map(journal.records.map(row => [row.correctionId, row]));
      for (const row of [taste, boundary, promiseDomain]) {
        assert.equal(byId.get(row.correctionId)?.status, 'active', `${mode}: ${row.correctionId} reads back active`);
      }

      // ── replay / rebuild keeps every corrected value ──────────────────────
      const rebuilt = await fixture.r.api.rebuildWorldManagerState({});
      assert.equal(rebuilt.ok, true, `${mode}: replay succeeds`);
      assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: replay costs no model call`);
      assert.equal(sameJson(plain((await readCharacter(mina.id))?.state?.preferences), [PREFERENCE]), true,
        `${mode}: replay re-applies the taste correction`);
      assert.equal((await readThread(promise.id))?.summary, PROMISE_SUMMARY,
        `${mode}: replay keeps the corrected promise`);
      const afterReplay = await readCharacter(jiho.id);
      assert.equal(sameJson(plain(afterReplay?.state?.boundaries), [{
        content: BOUNDARY_CONTENT, topic: BOUNDARY_TOPIC, kind: 'boundary',
        scope: { subjectRef: jiho.id, targetRef: '', act: '', when: '' } }]), true,
        `${mode}: replay keeps the corrected boundary`);

      // ── a correction must not masquerade as a source event, nor overwrite canon
      const after = canonicalRecord(snapshot, 1);
      // Compare the canonical payload: facts, entities, bindings, source pairs and the digests
      // they are identified by. `embedding` is a separate projection field that this product
      // re-annotates when no embedding key is configured (measured: mirror/server_only flip
      // it from pending to disabled with reason "API Key"), so including it would measure the
      // vector pipeline rather than whether the correction overwrote canon.
      const canonPayload = value => {
        const copy = plain(value) || {};
        delete copy.embedding;
        return JSON.stringify(copy);
      };
      assert.equal(canonPayload(after.value), canonPayload(canonBefore),
        `${mode}: the canonical record bytes are untouched by corrections`);
      assert.equal(after.ref.artifactDigest, before.ref.artifactDigest, `${mode}: the canonical digest is unchanged`);
      const anchor = taste.anchor?.canonical;
      assert.ok(anchor, `${mode}: the provenance carries a canonical anchor`);
      assert.equal(anchor.memoryId, before.ref.memoryId,
        `${mode}: provenance anchors to the real canonical memory id, not to a fabricated event`);
      assert.equal(Number(anchor.revision || 0), Number(before.ref.revision || 0),
        `${mode}: provenance anchors to the real canonical revision`);
      assert.equal(String(anchor.artifactDigest || ''), String(before.ref.artifactDigest || ''),
        `${mode}: provenance anchors to the real canonical artifact digest`);
      assert.deepEqual(plain(anchor.turnRange), plain(before.ref.turnRange),
        `${mode}: provenance anchors to the real canonical turn range`);
      const provenance = (await readCharacter(mina.id))?.fieldCorrectionProvenance?.preferences;
      assert.equal(provenance.correctionId, taste.correctionId, `${mode}: provenance keeps the correction identity`);
      assert.equal(provenance.policy, 'point_in_time_override',
        `${mode}: the correction is recorded as a point-in-time override, not as an original event`);
      assert.notEqual(provenance.correctionId, anchor.memoryId,
        `${mode}: the correction id and the canonical cursor are distinct identities`);

      // ── storage readback per mode ─────────────────────────────────────────
      const onServer = serverRecords(snapshot).some(row => JOURNAL_KEY.test(row.key));
      const onLocal = localRecords(snapshot).some(row => JOURNAL_KEY.test(row.key));
      if (mode === 'plugin_only') {
        assert.equal(onServer, false, 'plugin_only: the journal lives in plugin storage only');
        assert.equal(onLocal, true, 'plugin_only: the journal is present in plugin storage');
      } else {
        assert.equal(onServer, true, `${mode}: the journal is stored on the server`);
      }
      const storedJournal = await fixture.r.api.getWorldManagerCorrections();
      assert.equal(storedJournal.records.length, 3, `${mode}: the stored journal reads back three records`);

      summary.push({ mode, corrections: 3, journalRecords: storedJournal.records.length,
        domains: ['taste', 'boundary', 'promise'],
        suspendedToOriginal: true, reactivatedToCorrected: true, replayKeptCorrected: true,
        canonicalBytesUnchanged: true, canonicalDigest: before.ref.artifactDigest,
        provenancePolicy: provenance.policy, provenanceCorrectionId: provenance.correctionId,
        provenanceAnchorMemoryId: anchor.memoryId,
        modelCalls: fixture.control.calls.length, journalStorage: mode === 'plugin_only' ? 'plugin' : 'server' });
      console.log(JSON.stringify({ marker: 'A25-mode', mode, ...summary.at(-1) }));
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'A25', mode,
        action: acceptance.action, assertion_result: true,
        corrections: 3, domains: ['taste', 'boundary', 'promise'],
        journalRecords: storedJournal.records.length, canonicalBytesUnchanged: true,
        provenancePolicy: provenance.policy }));
    } finally {
      await snapshot.cleanup();
    }
  }
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'))).digest('hex');
  const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log(JSON.stringify({ marker: 'A25-three-mode-correction', modes: MODES, rows: summary,
    sourceSha256: sourceHash, testSha256: testHash, result: 'PASS' }));
})().catch(error => {
  console.log(JSON.stringify({ marker: 'A25-failed', message: String(error && error.message || error) }));
  console.error(error);
  process.exit(1);
});
