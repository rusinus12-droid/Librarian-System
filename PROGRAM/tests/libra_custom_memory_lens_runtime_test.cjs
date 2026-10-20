'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
const { clone, parent, character } = require('./fixtures/native_branch_fixture.cjs');

(async () => {
  console.log('--- Starting Custom Memory Lens Runtime Test ---');

  // 1. Setup Chat & Turns
  const root = parent('root-lens-test', 5);
  root.message[0].data = '안녕, 오늘 밤 12시에 시계탑에서 만나자고 약속했잖아.';
  root.message[1].data = '그래, 잊지 않았어. 푸른 열쇠를 꼭 챙겨갈게.';
  root.message[2].data = '만약 비가 오면 어떻게 하지?';
  root.message[3].data = '비가 오더라도 비바람을 뚫고 갈 테니 걱정 마.';
  root.message[4].data = '약속 장소에 아무도 없으면 서운할 거야.';

  const char = character([root]);
  let current = root;
  let llmCalls = [];

  const host = {
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => char.chats.indexOf(current),
    getCharacter: async () => clone(char),
    getCharacterFromIndex: async () => clone(char),
    getChat: async () => clone(current),
    getCurrentChat: async () => clone(current),
    getChatFromIndex: async (_c, i) => clone(char.chats[i]),
    getDatabase: async fields => {
      const db = { personas: [], selectedPersona: '', characters: [clone(char)], plugins: [] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(k => [k, db[k] ?? null])) : db;
    },
    runLLMModel: async options => {
      const payloadStr = JSON.stringify(options);
      llmCalls.push({ options, str: payloadStr });
      if (payloadStr.includes('LIBRA LENS ANALYZER')) {
        return {
          type: 'success',
          result: JSON.stringify({
            items: [
              {
                label: '복선',
                summary: '푸른 열쇠 지참 약속',
                refs: ['t1-a'],
                quote: '푸른 열쇠를 꼭 챙겨갈게',
                extra: { importance: 'high' }
              }
            ]
          })
        };
      }
      return { type: 'success', result: '{}' };
    }
  };

  const harness = await createLibraVmHarness({}, host);
  const { api } = harness;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Starter Templates & Natural Language Lens Synthesis
    // -------------------------------------------------------------------------
    console.log('[Test 1] Starter Templates & Natural Language Generation');
    const templates = api.getLensStarterTemplates();
    assert.ok(Array.isArray(templates), 'Templates should be an array');
    assert.equal(templates.length, 5, 'Should provide 5 starter templates');

    const templateIds = templates.map(t => t.id || t.templateId);
    assert.ok(templateIds.includes('starter_unresolved_promises'), 'Includes starter_unresolved_promises');
    assert.ok(templateIds.includes('starter_emotional_aftertaste'), 'Includes starter_emotional_aftertaste');
    assert.ok(templateIds.includes('starter_speech_register'), 'Includes starter_speech_register');
    assert.ok(templateIds.includes('starter_sensory_anchors'), 'Includes starter_sensory_anchors');
    assert.ok(templateIds.includes('starter_clues_red_herrings'), 'Includes starter_clues_red_herrings');

    // Check properties of starter_unresolved_promises
    const fpTpl = templates.find(t => (t.id || t.templateId) === 'starter_unresolved_promises');
    assert.ok(fpTpl.evidenceMode || fpTpl.evidencePolicy);
    assert.ok(Array.isArray(fpTpl.labels) && fpTpl.labels.length > 0);

    // Natural Language Lens Generation
    const genStrict = await api.generateLensDefinitionFromDescription('복선과 복선 회수만 정확한 원문 인용으로 추적해줘');
    assert.ok(genStrict.ok);
    assert.ok(genStrict.lens.id || genStrict.lens.lensId);
    assert.equal(genStrict.lens.evidenceMode || genStrict.lens.evidencePolicy, 'strict');

    const genInterp = await api.generateLensDefinitionFromDescription('등장인물 간의 묘한 분위기와 감정선을 해석해서 기록해줘');
    assert.ok(genInterp.ok);
    assert.equal(genInterp.lens.evidenceMode || genInterp.lens.evidencePolicy, 'interpretive');

    // -------------------------------------------------------------------------
    // TEST 2: Evidence Admission Gate (Strict vs. Interpretive & Rejections)
    // -------------------------------------------------------------------------
    console.log('[Test 2] Evidence Admission Gate');
    const mockBatch = [
      {
        turn: 1,
        user: { text: '안녕, 오늘 밤 12시에 시계탑에서 만나자고 약속했잖아.' },
        assistant: { text: '그래, 잊지 않았어. 푸른 열쇠를 꼭 챙겨갈게.' }
      },
      {
        turn: 2,
        user: { text: '만약 비가 오면 어떻게 하지?' },
        assistant: { text: '비가 오더라도 비바람을 뚫고 갈 테니 걱정 마.' }
      }
    ];

    // 2-A: Strict Mode Admission
    const strictLens = {
      lensId: 'test_strict',
      evidenceMode: 'strict',
      labels: ['복선', '단서']
    };

    const strictCandidates = [
      // 1. Quoted exact match -> Accepted
      { summary: '푸른 열쇠 약속', refs: ['t1-a'], quote: '푸른 열쇠를 꼭 챙겨갈게', label: '복선' },
      // 2. Missing quote -> Rejected (strict_mode_requires_quote)
      { summary: '시계탑 만남', refs: ['t1-u'], basis: '대화에서 약속함', label: '복선' },
      // 3. Quote mismatch -> Rejected (quote_not_found_in_ref)
      { summary: '황금 열쇠 약속', refs: ['t1-a'], quote: '황금 열쇠를 꼭 챙겨갈게', label: '복선' },
      // 4. Out of range ref -> Rejected (ref_out_of_range)
      { summary: '먼 미래 사건', refs: ['t9-u'], quote: '미래', label: '단서' },
      // 5. Missing refs -> Rejected (missing_refs)
      { summary: '참조 없는 관찰', quote: '푸른 열쇠' },
      // 6. Missing summary -> Rejected (missing_summary)
      { refs: ['t1-a'], quote: '푸른 열쇠를 꼭 챙겨갈게' }
    ];

    const strictResult = api.evaluateLensCandidateItems(strictCandidates, strictLens, mockBatch);
    assert.ok(strictResult.ok);
    assert.equal(strictResult.acceptedItems.length, 1, 'Only exact quote candidate accepted in strict mode');
    assert.equal(strictResult.acceptedItems[0].evidenceClass, 'quoted');
    assert.equal(strictResult.acceptedItems[0].quoteRef, 't1-a');
    assert.equal(strictResult.rejectedItems.length, 5, '5 candidates should be rejected');

    const rejectReasons = strictResult.rejectedItems.map(r => r.reasonCode);
    assert.ok(rejectReasons.includes('strict_mode_requires_quote'), 'Rejects missing quote in strict mode');
    assert.ok(rejectReasons.includes('quote_not_found_in_ref'), 'Rejects quote not in referenced text');
    assert.ok(rejectReasons.includes('ref_out_of_range'), 'Rejects out of range turn ref');
    assert.ok(rejectReasons.includes('missing_refs'), 'Rejects missing refs');
    assert.ok(rejectReasons.includes('missing_summary'), 'Rejects missing summary');

    // 2-B: Interpretive Mode Admission
    const interpLens = {
      lensId: 'test_interp',
      evidenceMode: 'interpretive',
      labels: ['분위기', '심리']
    };

    const interpCandidates = [
      // 1. Quoted exact match -> Accepted as 'quoted'
      { summary: '시계탑 약속', refs: ['t1-u'], quote: '시계탑에서 만나자고 약속했잖아', label: '분위기' },
      // 2. Interpreted with basis -> Accepted as 'interpreted'
      { summary: '비바람에도 꺾이지 않는 굳은 결의', refs: ['t2-a'], basis: '비가 와도 가겠다는 답변에서 단호한 의지가 묻어남', label: '심리' },
      // 3. No quote and No basis -> Rejected (missing_basis_for_interpretation)
      { summary: '단순 추측', refs: ['t2-a'], label: '심리' }
    ];

    const interpResult = api.evaluateLensCandidateItems(interpCandidates, interpLens, mockBatch);
    assert.ok(interpResult.ok);
    assert.equal(interpResult.acceptedItems.length, 2, 'Two items accepted in interpretive mode');
    assert.equal(interpResult.acceptedItems[0].evidenceClass, 'quoted');
    assert.equal(interpResult.acceptedItems[1].evidenceClass, 'interpreted');
    assert.equal(interpResult.rejectedItems.length, 1);
    assert.equal(interpResult.rejectedItems[0].reasonCode, 'missing_basis_for_interpretation');

    // -------------------------------------------------------------------------
    // TEST 3: Registry Persistence & Isolation
    // -------------------------------------------------------------------------
    console.log('[Test 3] Registry Persistence & Isolation');
    const initialReg = await api.getLensRegistry();
    assert.equal(initialReg.schema, 'libra.lens_registry.v1');

    // Add starter_unresolved_promises and starter_emotional_aftertaste to registry
    const newRegistry = {
      schema: 'libra.lens_registry.v1',
      enabled: true,
      lensRecallBudgetChars: 1400,
      lenses: [
        { ...fpTpl, enabled: true },
        { ...templates.find(t => (t.id || t.templateId) === 'starter_emotional_aftertaste'), enabled: true }
      ]
    };
    await api.saveLensRegistry(newRegistry);

    const reloadedReg = await api.getLensRegistry();
    assert.equal(reloadedReg.enabled, true);
    assert.equal(reloadedReg.lensRecallBudgetChars, 1400);
    assert.equal(reloadedReg.lenses.length, 2);

    // -------------------------------------------------------------------------
    // TEST 4: Lens Execution & Strict Non-Canonical Isolation
    // -------------------------------------------------------------------------
    console.log('[Test 4] Lens Execution & Strict Non-Canonical Isolation');
    // Baseline check on canonical memory
    const canonicalBefore = await api.getCanonicalMemories();
    const runsBefore = await api.getMemoryRuns();
    const stateHeadBefore = api.getCurrentStateHead();

    // Execute lens for turn range 1~5
    const runResult = await api.runLensForTurnRange('starter_unresolved_promises', { startTurn: 1, endTurn: 5 });
    assert.ok(runResult.ok, `Run should succeed: ${JSON.stringify(runResult)}`);
    assert.equal(runResult.lensId, 'starter_unresolved_promises');
    assert.equal(runResult.acceptedCount, 1);
    assert.equal(runResult.items[0].summary, '푸른 열쇠 지참 약속');

    // Non-canonical isolation assertions:
    const canonicalAfter = await api.getCanonicalMemories();
    const runsAfter = await api.getMemoryRuns();
    const stateHeadAfter = api.getCurrentStateHead();

    assert.equal(canonicalAfter.length, canonicalBefore.length, 'Canonical memories must NOT be modified by lens execution');
    assert.equal(runsAfter.length, runsBefore.length, 'Canonical runs must NOT include lens runs');
    assert.deepEqual(stateHeadAfter, stateHeadBefore, 'Continuity State Head must remain untouched by lens run');

    // -------------------------------------------------------------------------
    // TEST 5: Scope Inspection & Item Deletion
    // -------------------------------------------------------------------------
    console.log('[Test 5] Scope Inspection & Item Deletion');
    const scopeData = await api.inspectScopeLenses();
    assert.ok(scopeData.schema.startsWith('libra.lens_scope_inspection'));
    assert.ok(Array.isArray(scopeData.memories), 'Should provide flattened memories array for GUI');
    assert.ok(Array.isArray(scopeData.runs), 'Should provide flattened runs array for GUI');
    assert.equal(scopeData.memories.length, 1);
    assert.equal(scopeData.memories[0].summary, '푸른 열쇠 지참 약속');
    assert.equal(scopeData.runs.length, 1);

    // Delete the memory item
    const itemIdToDelete = scopeData.memories[0].itemId || scopeData.memories[0].id;
    assert.ok(itemIdToDelete, 'Item ID must exist');

    const delResult = await api.deleteLensMemories({
      lensId: 'starter_unresolved_promises',
      itemId: itemIdToDelete
    });
    assert.ok(delResult.ok);
    assert.equal(delResult.deletedCount, 1);

    // Verify deletion in inspection
    const scopeAfterDel = await api.inspectScopeLenses();
    assert.equal(scopeAfterDel.memories.length, 0, 'Memory record should be deleted');
    assert.equal(scopeAfterDel.runs.length, 1, 'Run log is preserved');

    // -------------------------------------------------------------------------
    // TEST 6: Lens Recall Injection & Staleness Skip
    // -------------------------------------------------------------------------
    console.log('[Test 6] Recall Injection & Staleness Skip');
    // Run lens again so we have an item to recall
    await api.runLensForTurnRange('starter_unresolved_promises', { startTurn: 1, endTurn: 5 });

    // 6-A: Fresh recall
    const recallResult = await api.recallLensMemories({ query: '푸른 열쇠 시계탑', maxChars: 1000 });
    assert.ok(recallResult.enabled);
    assert.ok(recallResult.injectedItems.length >= 1, 'Should inject the lens item');
    assert.ok(recallResult.renderedBlock.includes('[CUSTOM LENS MEMORY REFERENCE — SUPPLEMENTARY NON-CANONICAL]'), 'Must include custom lens header');
    assert.ok(recallResult.renderedBlock.includes('푸른 열쇠 지참 약속'), 'Rendered block must contain lens summary');

    // 6-B: Staleness protection test
    // Modify turn 1 assistant response in chat (causing sourceDigest to mismatch)
    root.message[1].data = '내용이 완전히 수정되었습니다. 열쇠 이야기는 없습니다.';

    const staleRecall = await api.recallLensMemories({ query: '푸른 열쇠 시계탑', maxChars: 1000 });
    assert.equal(staleRecall.injectedItems.length, 0, 'Stale item must NOT be injected into prompt');
    assert.ok(staleRecall.skippedCandidates.length >= 1, 'Stale item should be logged in skippedCandidates');
    assert.equal(staleRecall.skippedCandidates[0].reason, 'stale_source_revision');

    console.log('--- ALL CUSTOM MEMORY LENS RUNTIME TESTS PASSED ---');
  } finally {
    await harness.cleanup();
  }
})().catch(err => {
  console.error('Test failed with error:', err);
  process.exitCode = 1;
});
