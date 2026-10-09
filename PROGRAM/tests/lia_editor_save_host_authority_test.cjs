'use strict';
// LIA editor save — the host's answer is authoritative (reviewer R1, confirmed defect).
//
// The reviewer measured the shipped editor paths reporting `created` / `updated` after the host had (a)
// returned an explicit false, or (b) stored the row but rewritten its content. These cases drive the real
// product functions through the plugin's own exposure hook, and check the completion log is NOT written on
// a refused save — a success log is what the operator sees, so it must not appear when nothing was stored.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const expose = source => source
  .replace(
    'if (typeof document === "undefined") return null;',
    'if (typeof document === "undefined") return parseLLMResult(preservedLLMResultText || "");'
  )
  .replace(
    '      getLiveSyncCaptureState:',
    `      auditSetDraft: raw => { preservedLLMResultText = String(raw || ''); },
      auditSetName: raw => { preservedGeneratedPersonaNameText = String(raw || '').trim(); },
      auditSaveNew: async () => saveEditedResultAsNewPersona(),
      auditSaveCurrent: async () => saveEditedResultToCurrentPersona(),
      auditReadLogs: async () => await readLogStore(true),
      getLiveSyncCaptureState:`
  );

const contextFor = fixture => ({
  char: fixture.character, chat: fixture.liveChat, charIndex: 0, chatIndex: 0,
  db: fixture.db, personaInfo: { persona: fixture.db.personas[0] },
  generationMode: 'classic', contextOptions: { generationMode: 'classic' },
  characterDescription: [], moduleDescriptions: [], loreSignals: [], personaLoreSignals: [],
});

const VALID = JSON.stringify({
  personaName: 'Probe Persona',
  personaSpec: { name: 'Probe Persona', role: 'Archivist', personality: 'Careful and curious.' },
  personaPrompt: 'Name: Probe Persona\nRole: Archivist\nPersonality: Careful and curious.',
});

// The completion log is the operator-visible success signal; count it before and after every refusal.
const saveEvents = logs => logs.operations.filter(entry => entry.event === 'persona_save').length;

(async () => {
  const fixture = await createFixture('official', { transformSource: expose });
  let passed = 0;
  try {
    const ctx = contextFor(fixture);
    const originalWrite = fixture.api.setDatabase;

    // ── control: the ordinary new-Persona save still succeeds ────────────────────────────────────────
    fixture.runtime.auditSetDraft(VALID);
    const control = await fixture.runtime.auditSaveNew();
    assert.equal(control.action, 'created');
    const controlRow = fixture.db.personas.find(row => row.id === control.personaId);
    assert.equal(controlRow.personaPrompt, JSON.parse(VALID).personaPrompt);
    assert.equal(controlRow.name, 'Probe Persona');
    passed += 1;

    // ── new: all three explicit-refusal shapes are refused, with no completion log ────────────────────
    for (const refusal of [false, { ok: false }, { success: false }]) {
      const before = saveEvents(await fixture.runtime.auditReadLogs());
      fixture.api.setDatabase = async () => refusal;
      fixture.runtime.auditSetDraft(VALID);
      await assert.rejects(() => fixture.runtime.auditSaveNew(), error => error.code === 'LIA_PERSONA_WRITE_REJECTED');
      const after = saveEvents(await fixture.runtime.auditReadLogs());
      assert.equal(after, before, `a refused new save must not log a completion (${JSON.stringify(refusal)})`);
      passed += 1;
    }

    // ── new: a stored row whose SEMANTIC content was rewritten is refused ─────────────────────────────
    fixture.api.setDatabase = async patch => {
      await originalWrite(patch);
      fixture.db.personas[fixture.db.personas.length - 1].personaPrompt = 'CORRUPTED BY HOST';
      return true;
    };
    const beforeCorrupt = saveEvents(await fixture.runtime.auditReadLogs());
    fixture.runtime.auditSetDraft(VALID);
    await assert.rejects(() => fixture.runtime.auditSaveNew(), /LIA_PERSONA_READBACK_MISMATCH:personaPrompt/);
    assert.equal(saveEvents(await fixture.runtime.auditReadLogs()), beforeCorrupt);
    const newMismatchRows = (await fixture.runtime.auditReadLogs()).debug
      .filter(entry => entry.event === 'editor_save_new_readback_mismatch');
    assert.ok(newMismatchRows.length > 0);
    assert.doesNotMatch(JSON.stringify(newMismatchRows), /Name: Probe Persona|CORRUPTED BY HOST|intended"|actual"/,
      'new-save mismatch diagnostics must not export Persona field contents');
    assert.ok(newMismatchRows.every(entry => Number.isInteger(entry.details.intendedLength)
      && Number.isInteger(entry.details.actualLength)));
    passed += 1;

    // ── new: a host that reports success but stores nothing at all is refused ─────────────────────────
    fixture.api.setDatabase = async () => undefined;
    fixture.runtime.auditSetDraft(VALID);
    await assert.rejects(() => fixture.runtime.auditSaveNew(), error => error.code === 'LIA_PERSONA_READBACK_PRESERVATION_FAILED');
    passed += 1;

    // ── new: an unavailable write path is refused rather than silently skipped ────────────────────────
    fixture.api.setDatabase = undefined;
    fixture.runtime.auditSetDraft(VALID);
    await assert.rejects(() => fixture.runtime.auditSaveNew(), error => error.code === 'LIA_PERSONA_WRITE_UNAVAILABLE');
    passed += 1;

    // ── current: control, then the two refusal modes ──────────────────────────────────────────────────
    fixture.api.setDatabase = originalWrite;
    fixture.runtime.auditSetDraft(VALID);
    const currentControl = await fixture.runtime.auditSaveCurrent();
    assert.equal(currentControl.action, 'updated');
    passed += 1;

    for (const refusal of [false, { ok: false }, { success: false }]) {
      const before = saveEvents(await fixture.runtime.auditReadLogs());
      fixture.api.setDatabase = async () => refusal;
      fixture.runtime.auditSetDraft(VALID);
      await assert.rejects(() => fixture.runtime.auditSaveCurrent(), error => error.code === 'LIA_PERSONA_WRITE_REJECTED');
      assert.equal(saveEvents(await fixture.runtime.auditReadLogs()), before,
        `a refused current save must not log a completion (${JSON.stringify(refusal)})`);
      passed += 1;
    }

    // ── current: the name the editor sent is compared too, not just the prompt ────────────────────────
    fixture.api.setDatabase = async patch => {
      await originalWrite(patch);
      const bound = fixture.db.personas.find(row => row.id === fixture.liveChat.bindedPersona);
      if (bound) bound.name = 'RENAMED BY HOST';
      return true;
    };
    fixture.runtime.auditSetName('Editor Name');
    fixture.runtime.auditSetDraft(
      JSON.stringify({ personaName: 'Editor Name', personaPrompt: JSON.parse(VALID).personaPrompt })
    );
    await assert.rejects(() => fixture.runtime.auditSaveCurrent(), /LIA_PERSONA_READBACK_MISMATCH:name/);
    const currentMismatchRows = (await fixture.runtime.auditReadLogs()).debug
      .filter(entry => entry.event === 'editor_save_current_readback_mismatch');
    assert.ok(currentMismatchRows.length > 0);
    assert.doesNotMatch(JSON.stringify(currentMismatchRows), /Editor Name|RENAMED BY HOST|Name: Probe Persona|intended"|actual"/,
      'current-save mismatch diagnostics must not export Persona field contents');
    assert.ok(currentMismatchRows.every(entry => Number.isInteger(entry.details.intendedLength)
      && Number.isInteger(entry.details.actualLength)));
    fixture.runtime.auditSetName('');
    passed += 1;

    // ── preservation: what the save must NOT destroy ──────────────────────────────────────────────────
    fixture.api.setDatabase = originalWrite;
    const nativeBefore = JSON.parse(JSON.stringify(fixture.db.personas[fixture.db.selectedPersona] ?? null));
    const boundId = fixture.liveChat.bindedPersona;
    fixture.runtime.auditSetDraft(VALID);
    await fixture.runtime.auditSaveCurrent();
    assert.equal(String(fixture.liveChat.bindedPersona), String(boundId), 'chat binding must be preserved');
    assert.deepEqual(fixture.db.personas[fixture.db.selectedPersona] ?? null, nativeBefore,
      'the natively selected Persona must not be modified');
    passed += 1;

    // ── preservation: metadata on the target row survives an editor save ──────────────────────────────
    const target = fixture.db.personas.find(row => row.id === boundId);
    target.customMetadata = { preserved: true };
    const editIdBefore = fixture.db.personas.filter(row => String(row.id).startsWith('lia-editor-persona::')).length;
    fixture.runtime.auditSetDraft(VALID);
    await fixture.runtime.auditSaveCurrent();
    assert.equal(target.customMetadata.preserved, true, 'existing metadata must be preserved');
    assert.equal(String(target.id), String(boundId), 'ID/lineage must be preserved');
    assert.equal(fixture.db.personas.filter(row => String(row.id).startsWith('lia-editor-persona::')).length, editIdBefore,
      'a current-save must not append a new editor Persona');
    passed += 1;

    // ── the allowed prompt-only draft behaviour is NOT withdrawn by this fix ─────────────────────────
    fixture.runtime.auditSetDraft('{"personaPrompt":"editor prompt without PersonaSpec"}');
    const promptOnly = await fixture.runtime.auditSaveNew();
    assert.equal(promptOnly.action, 'created');
    assert.equal(fixture.db.personas.find(row => row.id === promptOnly.personaId).personaPrompt,
      'editor prompt without PersonaSpec');
    passed += 1;

    console.log(`lia_editor_save_host_authority_test: PASS (${passed} checks)`);
  } finally { await fixture.dispose(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
