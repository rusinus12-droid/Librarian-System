'use strict';

const assert = require('node:assert/strict');
const {
  createStore,
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

const emptyPacket = summary => ({
  meta: { summary_memory: { summary, recallAnchors: [], recallAliases: {}, canonicalAnchors: [], mentionedEntityNames: [], directEvidenceSnippets: [summary], related_refs: [], confidence: 0.9 } },
  entity: { characters: [], relations: [], pov_memories: [], secrets: [] },
  world: { active_events: [], historical_events: [], world_rules: [], offscreen_threads: [], factions: [], regions: [] },
  narrative: { conflict_traces: [], scene_deltas: [], theme_motifs: [], critical_dialogue: [] },
  planner: { continuity_locks: [], do_not_resolve_yet: [], consequence_ledger: [], payoff_tracker: [], open_invitations: [] },
  importance: { overall: 0.8, reason: [] }
});

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: [] });
  try {
    const test = runtime.hayaku._test;
    const suffix = 'FULL_RECOVERY_EVIDENCE_SUFFIX_SENTINEL';
    const longUser = `${'가'.repeat(240111)}${'A'.repeat(63999)}😀${suffix}`;
    const sidecar = await test.writeRecoveryEvidenceSidecar({
      scopeKey: 'fixture-lossless-scope',
      recordId: 'fixture-lossless-debt',
      pairIndex: 7,
      user: longUser,
      assistant: '응답 끝',
      userCanonicalHash: 'fixture-user-canonical',
      assistantCanonicalHash: 'fixture-assistant-canonical'
    });
    assert.equal(sidecar.durable, true, sidecar.reason);
    assert.ok(sidecar.manifest.roles.user.chunkCount > 1, 'oversized evidence must be chunked');
    const readback = await test.readRecoveryEvidenceSidecar(sidecar.manifestRef, {
      scopeKey: 'fixture-lossless-scope',
      recordId: 'fixture-lossless-debt'
    });
    assert.equal(readback.ok, true, readback.reason);
    assert.equal(readback.user, longUser, 'every source character must survive physical readback');
    assert.ok(readback.user.endsWith(suffix), 'tail sentinel must survive');
    assert.ok(readback.user.includes('😀'), 'Unicode code point boundary must survive');
    assert.equal(readback.assistant, '응답 끝');

    const legacyBoundary = test.normalizeRecoveryVaultRecord({
      scopeKey: 'legacy-scope', pairIndex: 1, userHash: 'u', assistantHash: 'a',
      user: { text: 'x'.repeat(240000) }, assistant: { text: 'ok' }
    }, 'legacy-scope');
    assert.equal(legacyBoundary.user.text.length, 240000, 'legacy evidence is preserved, not truncated again');
    assert.equal(legacyBoundary.evidenceCompleteness, 'legacy_evidence_completeness_unknown');

    const paraphrased = emptyPacket('Alice and Bob trust one another and spend their afternoons together.');
    paraphrased.entity.characters = [{ name: 'Alice' }, { name: 'Bob' }];
    paraphrased.entity.relations = [{ from: 'Alice', to: 'Bob', relationship: 'friends' }];
    const paraphrasedEnvelope = {
      schema: 'hayaku.native_repair_output.v1',
      packet: paraphrased,
      grounding: [
        { path: 'entity.characters[0]', source: 'target', evidence: ['Alice and Bob trust one another and spend their afternoons together.'] },
        { path: 'entity.characters[1]', source: 'target', evidence: ['Alice and Bob trust one another and spend their afternoons together.'] },
        { path: 'entity.relations[0]', source: 'target', evidence: ['Alice and Bob trust one another and spend their afternoons together.'] },
        { path: 'meta.summary_memory.summary', source: 'target', evidence: ['Alice and Bob trust one another and spend their afternoons together.'] }
      ]
    };
    const paraphrasedValidation = test.validateNativeRepairGrounding(paraphrasedEnvelope, { targetText: 'Alice and Bob trust one another and spend their afternoons together.' });
    assert.equal(paraphrasedValidation.ok, true, 'a relationship label need not appear literally in its valid source quote');
    assert.equal(paraphrasedValidation.classification, 'source_bound_derived');
    assert.ok(paraphrasedValidation.derived.some(row => row.field.endsWith('.relationship')));

    const negated = emptyPacket('Alice and Bob are not friends.');
    negated.entity.characters = [{ name: 'Alice' }, { name: 'Bob' }];
    negated.entity.relations = [{ from: 'Alice', to: 'Bob', relationship: 'friends' }];
    const negatedQuote = 'Alice and Bob are not friends.';
    const negatedEnvelope = {
      schema: 'hayaku.native_repair_output.v1',
      packet: negated,
      grounding: [
        { path: 'entity.characters[0]', source: 'target', evidence: [negatedQuote] },
        { path: 'entity.characters[1]', source: 'target', evidence: [negatedQuote] },
        { path: 'entity.relations[0]', source: 'target', evidence: [negatedQuote] },
        { path: 'meta.summary_memory.summary', source: 'target', evidence: [negatedQuote] }
      ]
    };
    const negatedValidation = test.validateNativeRepairGrounding(negatedEnvelope, { targetText: negatedQuote });
    assert.equal(negatedValidation.ok, false);
    assert.ok(negatedValidation.ambiguous.some(row => row.reason === 'direct_fact_polarity_mismatch'));

    const unknownTop = structuredClone(paraphrasedEnvelope);
    unknownTop.packet.analysis = { reasoning: 'hidden' };
    assert.equal(test.validateNativeRepairEnvelopeShape(unknownTop).ok, false, 'unknown packet top-level objects must be rejected');

    const japanese = emptyPacket('アリスはボブを助けた。');
    japanese.entity.characters = [{ name: 'アリス' }, { name: 'ボブ' }];
    japanese.world.active_events = [{ summary: 'アリスはボブを助けた。' }];
    const japaneseEnvelope = {
      schema: 'hayaku.native_repair_output.v1',
      packet: japanese,
      grounding: [
        { path: 'entity.characters[0]', source: 'target', evidence: ['アリスはボブを助けた。'] },
        { path: 'entity.characters[1]', source: 'target', evidence: ['アリスはボブを助けた。'] },
        { path: 'world.active_events[0]', source: 'target', evidence: ['アリスはボブを助けた。'] },
        { path: 'meta.summary_memory.summary', source: 'target', evidence: ['アリスはボブを助けた。'] }
      ]
    };
    assert.equal(test.validateNativeRepairGrounding(japaneseEnvelope, { targetText: 'アリスはボブを助けた。' }).ok, true, 'multilingual exact evidence must remain valid');
  } finally {
    await runtime.dispose();
  }

  const failingBase = createStore();
  let recoveryChunkWrites = 0;
  const failingStore = {
    async getItem(key) { return await failingBase.getItem(key); },
    async setItem(key, value) {
      if (String(key).includes('recovery_evidence_chunk')) {
        recoveryChunkWrites += 1;
        if (recoveryChunkWrites === 2) return false;
      }
      return await failingBase.setItem(key, value);
    },
    async removeItem(key) {
      if (String(key).includes('recovery_evidence_chunk')) return false;
      return await failingBase.removeItem(key);
    },
    async keys() { return await failingBase.keys(); },
    async key(index) { return await failingBase.key(index); },
    async length() { return await failingBase.length(); },
    async clear() { return await failingBase.clear(); }
  };
  const rollbackRuntime = await createHayakuRuntime({ autoRepair: false, messages: [], pluginStorage: failingStore });
  try {
    const failed = await rollbackRuntime.hayaku._test.writeRecoveryEvidenceSidecar({
      scopeKey: 'rollback-scope', recordId: 'rollback-debt', pairIndex: 1,
      user: 'x'.repeat(70000), assistant: 'ok', userCanonicalHash: 'u', assistantCanonicalHash: 'a'
    });
    assert.equal(failed.durable, false);
    assert.equal(failed.code, 'HAYAKU_RECOVERY_EVIDENCE_ROLLBACK_INCOMPLETE');
    assert.ok(Array.from(failed.rollback.failures || []).length >= 1, 'rollback readback failure must be explicit');
  } finally {
    await rollbackRuntime.dispose();
  }

  const hugeAssistant = `${'Z'.repeat(480100)}FULL_REQUEST_BUDGET_SUFFIX`;
  const turn1 = createValidPacket({ turn: 1, summary: 'Alice entered the archive.' });
  const budgetRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('budget-u1', 'I enter the archive.'),
      assistant('budget-a1', hiddenPacketMessage('Alice entered the archive.', turn1)),
      user('budget-u2', 'Preserve this oversized turn.'),
      assistant('budget-a2', hugeAssistant)
    ]
  });
  try {
    const result = await budgetRuntime.hayaku.recovery.repairNow({ reason: 'request_budget_fixture' });
    assert.equal(result.ok, false);
    assert.equal(result.awaitingUserReview, false, 'request-size failure must not revive the removed review workflow');
    assert.equal(result.reason, 'evidence_over_request_budget');
    assert.equal(result.llmCalled, false);
    assert.equal(budgetRuntime.llmCalls.length, 0, 'oversized evidence must not be silently truncated and sent');
    const state = await budgetRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: false, limit: 8 });
    const vault = await budgetRuntime.hayaku._test.loadRecoveryVault(state.scopeKey, { force: true });
    const debt = Array.from(vault.records || []).find(row => Number(row.pairIndex) === 2);
    assert.ok(debt?.evidenceManifest?.manifestKey, 'oversized evidence must retain a durable manifest reference');
    assert.equal(debt.assistant.text, '', 'oversized canonical evidence is not duplicated into the bounded Vault row');
    const full = await budgetRuntime.hayaku._test.readRecoveryEvidenceSidecar(debt.evidenceManifest, { scopeKey: debt.scopeKey, recordId: debt.recordId });
    assert.equal(full.ok, true, full.reason);
    assert.equal(full.assistant, hugeAssistant);
    assert.ok(full.assistant.endsWith('FULL_REQUEST_BUDGET_SUFFIX'));
    const portable = budgetRuntime.context.__HAYAKUPortableMemoryBackup;
    assert.ok(portable, 'Portable Backup API must be registered');
    const envelope = await portable.exportCurrentScope();
    await portable.validateBackup(envelope);
    const exportedKeys = new Set(Array.from(envelope.records || [], record => String(record.key || '')));
    assert.ok(exportedKeys.has(debt.evidenceManifest.manifestKey), 'Portable Backup must include the recovery evidence manifest');
    for (const role of ['user', 'assistant']) {
      for (const key of Array.from(full.manifest.roles[role].chunkKeys || [])) {
        assert.ok(exportedKeys.has(key), `Portable Backup must include referenced ${role} chunk ${key}`);
      }
    }
  } finally {
    await budgetRuntime.dispose();
  }

  console.log('PASS hayaku_otherax_evidence_grounding_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
