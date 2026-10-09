'use strict';

const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const expose = source => source
  .replace(
    'if (typeof document === "undefined") return null;',
    'if (typeof document === "undefined") return parseLLMResult(preservedLLMResultText || "");'
  )
  .replace(
    '      getLiveSyncCaptureState:',
    `auditSetDraft: raw => { preservedLLMResultText = String(raw || ''); },
      auditSaveNew: async () => saveEditedResultAsNewPersona(),
      auditGeneratedUpsert: async ctx => upsertGeneratedPersona(ctx, { personaPrompt: 'generated synthetic probe', generationMode: 'classic' }),
      auditLiveUpsert: async ctx => upsertPersonaFresh({
        id: String(ctx?.chat?.bindedPersona || 'lia-live-persona::fixture'), name: 'Live Probe', personaPrompt: 'live synthetic probe',
      }, ctx),
      auditAppendProbe: async guardContext => {
        const snapshot = await readPersonaDatabaseForMutation('audit_probe', guardContext);
        return await writePersonaArrayMutation('audit_probe', snapshot, snapshot.personas.concat({
          id: 'guard-probe-persona', name: 'Guard Probe', personaPrompt: 'synthetic test row', note: '',
        }));
      },
      auditReadLogs: async () => await readLogStore(true),
      getLiveSyncCaptureState:`
  );

const VALID = JSON.stringify({
  personaName: 'Guard Probe',
  personaSpec: { name: 'Guard Probe', role: 'Archivist', personality: 'Careful and curious.' },
  personaPrompt: 'Name: Guard Probe\nRole: Archivist\nPersonality: Careful and curious.',
});

(async () => {
  const fixture = await createFixture('official', { transformSource: expose });
  try {
    const beforeIds = fixture.db.personas.map(persona => persona.id);
    let writeCount = 0;
    const originalSetDatabase = fixture.api.setDatabase;
    const originalGetDatabase = fixture.api.getDatabase;
    fixture.api.getDatabase = async () => null; // Official contract: missing consent may return null.
    fixture.api.setDatabase = async patch => {
      writeCount += 1;
      return await originalSetDatabase(patch);
    };

    fixture.runtime.auditSetDraft(VALID);
    await assert.rejects(() => fixture.runtime.auditSaveNew());
    assert.equal(writeCount, 0, 'a null database read must stop before a whole-array write');
    assert.deepEqual(fixture.db.personas.map(persona => persona.id), beforeIds,
      'a missing database read must preserve every existing Persona');
    const directContext = {
      char: fixture.character, chat: fixture.liveChat, charIndex: 0, chatIndex: 0,
      db: fixture.db, personaInfo: { persona: fixture.db.personas[0] },
      generationMode: 'classic', contextOptions: { generationMode: 'classic' },
    };
    await assert.rejects(() => fixture.runtime.auditGeneratedUpsert(directContext));
    await assert.rejects(() => fixture.runtime.auditLiveUpsert(directContext));
    assert.equal(writeCount, 0, 'generated and live Persona upserts must also stop when the fresh getter returns null');

    const expectBlockedBeforeWrite = async (getDatabase, guardContext, reason) => {
      const writesBefore = writeCount;
      fixture.api.getDatabase = getDatabase;
      await assert.rejects(() => fixture.runtime.auditAppendProbe(guardContext), error => {
        assert.ok(error.code, `expected a stable safety code for ${reason}`);
        if (reason) assert.equal(error.reason, reason);
        return true;
      });
      assert.equal(writeCount, writesBefore, `unsafe snapshot (${reason || 'unknown'}) must block before setDatabase`);
    };

    // The common mutation guard rejects denied, absent, rejected, partial, and malformed reads.
    await expectBlockedBeforeWrite(async () => undefined, null, 'database_read_unavailable');
    await expectBlockedBeforeWrite(async () => { throw new Error('private host response'); }, null, 'database_read_rejected');
    await expectBlockedBeforeWrite(async () => ({ personas: [] }), null, 'database_snapshot_partial');
    await expectBlockedBeforeWrite(async () => ({ personas: 'not-an-array', selectedPersona: 0 }), null, 'personas_not_array');
    await expectBlockedBeforeWrite(async () => ({ personas: [], selectedPersona: 0 }), null, 'selected_persona_mismatch');
    await expectBlockedBeforeWrite(async () => ({ personas: [{ id: 'one' }], selectedPersona: '' }), null, 'selected_persona_mismatch');

    // A plausible but truncated array must fail against a previously observed full context.
    const knownDb = structuredClone(fixture.db);
    await expectBlockedBeforeWrite(async () => ({ personas: [knownDb.personas[0]], selectedPersona: 0 }), { db: knownDb }, 'known_persona_missing');
    await expectBlockedBeforeWrite(async () => ({ personas: knownDb.personas, selectedPersona: 1 }), { db: knownDb }, 'selected_persona_mismatch');

    // A failed UI read can leave an empty context cache; that cache must not authorize overwriting a fresh non-empty database.
    await expectBlockedBeforeWrite(originalGetDatabase, { db: { personas: [], selectedPersona: '' } }, 'known_persona_missing');

    // A host that claims success while dropping old rows is never reported as a verified write.
    const writesBeforeCorruptHost = writeCount;
    fixture.api.getDatabase = originalGetDatabase;
    fixture.api.setDatabase = async patch => {
      writeCount += 1;
      fixture.db.personas = (patch?.personas || []).filter(persona => persona.id === 'guard-probe-persona');
      return true;
    };
    await assert.rejects(() => fixture.runtime.auditAppendProbe({ db: knownDb }), error => {
      assert.equal(error.code, 'LIA_PERSONA_READBACK_PRESERVATION_FAILED');
      assert.equal(error.reason, 'readback_missing_personas');
      return true;
    });
    assert.equal(writeCount, writesBeforeCorruptHost + 1);
    fixture.db.personas = structuredClone(knownDb.personas);
    fixture.db.selectedPersona = knownDb.selectedPersona;

    // A host that keeps an untouched Persona ID but corrupts its prompt or note must not pass readback.
    const beforeUntouchedCorruption = structuredClone(fixture.db.personas);
    const untouchedIndex = beforeUntouchedCorruption.findIndex((_, index) => index !== fixture.db.selectedPersona);
    assert.ok(untouchedIndex >= 0, 'fixture has a non-selected Persona row to protect');
    const writesBeforeUntouchedCorruption = writeCount;
    fixture.api.setDatabase = async patch => {
      writeCount += 1;
      await originalSetDatabase(patch);
      fixture.db.personas[untouchedIndex].personaPrompt = 'CORRUPTED UNSELECTED CONTENT';
      fixture.db.personas[untouchedIndex].note = 'HOST REWRITE';
      return true;
    };
    await assert.rejects(() => fixture.runtime.auditAppendProbe({ db: knownDb }), error => {
      assert.equal(error.code, 'LIA_PERSONA_READBACK_PRESERVATION_FAILED');
      assert.equal(error.reason, 'readback_untouched_persona_changed');
      return true;
    });
    assert.equal(writeCount, writesBeforeUntouchedCorruption + 1);
    assert.equal(fixture.db.personas[untouchedIndex].personaPrompt, 'CORRUPTED UNSELECTED CONTENT',
      'a failed readback reports partial host writes and does not pretend to roll them back');
    fixture.db.personas = beforeUntouchedCorruption;
    fixture.db.selectedPersona = knownDb.selectedPersona;

    // Re-read immediately before setDatabase and refuse if the host state changed after the first snapshot.
    // The public setter has no revision/CAS token, so this detects drift at that re-read but cannot exclude
    // an external edit in the final read-to-write window.
    let reads = 0;
    const beforeRace = structuredClone(fixture.db);
    const afterRace = structuredClone(fixture.db);
    afterRace.personas.push({ id: 'late-host-row', name: 'Late Host Row', personaPrompt: 'synthetic race row' });
    await expectBlockedBeforeWrite(async () => ++reads === 1 ? beforeRace : afterRace, null, 'snapshot_changed');

    // A valid verified-empty database may use either fixture sentinel, including a host that picks index 0 after first save.
    fixture.api.getDatabase = originalGetDatabase;
    fixture.api.setDatabase = async patch => {
      writeCount += 1;
      return await originalSetDatabase(patch);
    };
    fixture.db.personas = [];
    fixture.db.selectedPersona = -1;
    const emptyWrite = await fixture.runtime.auditAppendProbe({ db: { personas: [], selectedPersona: -1 } });
    assert.deepEqual(emptyWrite.personas.map(persona => persona.id), ['guard-probe-persona']);
    assert.equal(emptyWrite.selectedPersona, -1);
    fixture.db.personas = [];
    fixture.db.selectedPersona = '';
    fixture.api.setDatabase = async patch => {
      writeCount += 1;
      Object.assign(fixture.db, patch || {});
      if (fixture.db.selectedPersona === '' && fixture.db.personas.length) fixture.db.selectedPersona = 0;
      return true;
    };
    const autoSelected = await fixture.runtime.auditAppendProbe({ db: { personas: [], selectedPersona: '' } });
    assert.deepEqual(autoSelected.personas.map(persona => persona.id), ['guard-probe-persona']);
    assert.equal(autoSelected.selectedPersona, 0, 'first Persona creation may trigger host auto-selection');

    const logs = JSON.stringify(await fixture.runtime.auditReadLogs());
    assert.doesNotMatch(logs, /Careful and curious\.|private host response|synthetic test row/,
      'mutation guard diagnostics must not serialize Persona or host contents');
    console.log('lia_persona_database_mutation_guard_test: PASS (read guards, snapshot race, and verified-empty writes)');
  } finally {
    await fixture.dispose();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
