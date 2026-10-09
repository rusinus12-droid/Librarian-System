'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const input = require('./fixtures/unified_vertical_source.json');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const editedCanonical = [
  '# 종합 기억',
  '## 시간순 사건',
  '- 사용자가 확인한 사건을 기록한다.',
  '## 인물과 관계',
  '- 인물과 관계의 확인된 경과를 기록한다.',
  '## 세계와 장면',
  '- 세계와 장면의 확인된 경과를 기록한다.',
  '## 내러티브와 미해결 문제',
  '- 해결되지 않은 문제를 기록한다.',
  '## 확정 사실과 불확실 정보',
  '- 확정 사실과 불확실한 정보를 구분한다.',
  '## 회상 키워드',
  '- 수동 편집, 이관, 장면 근거'
].join('\n');

const waitFor = async predicate => {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Micro publication timed out');
};
const retryBusy = async action => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await action(); }
    catch (error) {
      if (!/BUSY/.test(String(error?.code || error?.message || '')) || attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};

(async () => {
  const allModes = ['plugin_only', 'server_only'];
  const modes = process.env.LIBRA_TEST_MODE ? [process.env.LIBRA_TEST_MODE] : allModes;
  assert.ok(modes.every(mode => allModes.includes(mode)));
  for (const mode of modes) {
    const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'Manual archive source',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    sourceChat.messages = sourceChat.message;
    const targetChat = {id: 'manual-archive-target', chatId: 'manual-archive-target',
      name: 'Manual archive target', message: []};
    targetChat.messages = targetChat.message;
    const handoffChat = {id: 'manual-archive-handoff-target', chatId: 'manual-archive-handoff-target',
      name: 'Manual handoff target', message: []};
    handoffChat.messages = handoffChat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아', chatPage: 0,
      chats: [sourceChat, targetChat, handoffChat]};
    let currentChatIndex = 0;
    const host = {
      getCurrentChatIndex: async () => currentChatIndex,
      getChat: async () => character.chats[currentChatIndex],
      getCurrentChat: async () => character.chats[currentChatIndex],
      getChatFromIndex: async (_characterIndex, chatIndex) => character.chats[chatIndex],
      getCharacter: async () => character,
      getCharacterFromIndex: async () => character,
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [character], plugins: []};
        return Array.isArray(fields)
          ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      }
    };
    const fx = await serverFixture({mode, snapshot: {chat: sourceChat}, host,
      transformSource: source => (process.env.LIBRA_TEST_PLUGIN
        ? fs.readFileSync(path.resolve(process.env.LIBRA_TEST_PLUGIN), 'utf8') : source)
        .replace('\n\n  const RisuCompat = (() => {',
          '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      let {f} = fx;
      let bridge = f.r.context.__fixtureStorageBridge;
      const sourceStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: sourceStatus.scopeKey, scopeKey: sourceStatus.scopeKey,
        characterId: character.id, chatId: sourceChat.id}, mode);
      f.control.onCall = () => ({type: 'error', result: 'controlled provider unavailable'});
      assert.equal((await f.run()).completed, 0, `${mode}: no unified Canonical is committed`);
      await require('./fixtures/libra_explicit_micro_retry.cjs').retryHistoricalMicro(f,[1,2,3,4,5]);
      await waitFor(async () => (await Promise.all([1, 2, 3, 4, 5].map(turn =>
        f.r.api.debugReadActiveMicroMemory(turn)))).every(row => row.status === 'verified'));
      const sourceOnlyMicro = await f.r.api.debugReadActiveMicroMemory(1);
      f.control.onCall = async args => {
        const request = JSON.parse(args[0].messages[1].content);
        const scene = request.assistant.text.slice(0, 40);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...request.binding,
            claims: [{changeKind: 'event', text: scene, actor: '', target: '',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'narrative',
                target: {scope: 'current_narrative'}, field: 'summary', operation: 'set', value: scene},
              evidence: {role: 'assistant', messageId: request.assistant.messageId,
                startOffset: 0, endOffset: scene.length, exactQuote: scene}}]}
        })};
      };
      const upgradedMicro = await require('./fixtures/libra_explicit_micro_retry.cjs').retryCurrentMicro(f,1);
      assert.equal(upgradedMicro.status, 'verified');
      assert.notEqual(upgradedMicro.recordKey, sourceOnlyMicro.recordKey,
        `${mode}: source-only revision remains historical after verified analysis`);
      const sourceMicro = await f.r.api.debugReadActiveMicroMemory(1);
      const sceneQuote = sourceMicro.record.claims[0].evidence.exactQuote;
      const sourceManifestKey = `libra:v1:scope:${sourceStatus.scopeKey}:manifest`;
      const storedValue = key => mode === 'server_only'
        ? fx.storedRows().find(row => row.key === key)?.value
        : JSON.parse(fx.local.get(key) || 'null');
      const sourceDecisions = (mode === 'server_only' ? fx.storedRows()
        : [...fx.local].flatMap(([key, raw]) => {
          try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
        }))
        .filter(row => row.value?.schema === 'libra.micro_state_admission.v1'
          && row.value.microRecordKey === sourceMicro.recordKey);
      assert.equal(sourceDecisions.length, 1,
        `${mode}: the source owns a persisted Micro State admission decision`);
      // A prose edit is supported only for a legacy Canonical. Install that
      // upgrade input against the exact source batch, with no unified State
      // built from a different artifact, while keeping the real Micro record.
      const range = (await f.r.api.listCanonicalBatchRanges()).ranges.find(row => row.startTurn === 1);
      const pairs = f.r.api.debugBuildPairs(sourceChat).slice(0, 5);
      assert.ok(range && pairs.length === 5, `${mode}: legacy source identity is available`);
      const now = new Date().toISOString();
      const legacyMemory = {
        schema: 'libra.canonical_memory.v1', memoryId: 'mem_legacy_000001',
        scopeKey: sourceStatus.scopeKey, branchId: range.sourceDigest,
        turnRange: {start: 1, end: 5}, sourcePairs: pairs.map(pair => ({
          turn: pair.turn, userChatId: pair.user.chatId, assistantChatId: pair.assistant.chatId
        })), sourceDigest: range.sourceDigest, revision: 1, status: 'committed',
        text: 'ORIGINAL CANONICAL MEMORY', summary: 'Original', recallKeys: [], importance: 0.5,
        sections: {}, anchors: {}, retrieval: {version: 'libra.retrieval_projection.v2'},
        embedding: {status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2'},
        runId: 'legacy_manual_fixture', createdAt: now, updatedAt: now
      };
      const legacyKey = `libra:v1:scope:${sourceStatus.scopeKey}:memory:1:r1`;
      const manifest = storedValue(sourceManifestKey);
      manifest.memories['1'] = {
        memoryId: legacyMemory.memoryId, key: legacyKey, revision: 1,
        sourceDigest: legacyMemory.sourceDigest, status: 'committed',
        turnRange: legacyMemory.turnRange, summary: legacyMemory.summary,
        embeddingStatus: 'disabled', sessionEpoch: 0, inheritedSessionHistory: false,
        createdAt: now, updatedAt: now, history: []
      };
      manifest.inFlight = null;
      if (mode !== 'server_only') {
        fx.local.set(legacyKey, JSON.stringify(legacyMemory));
        fx.local.set(sourceManifestKey, JSON.stringify(manifest));
      }
      if (mode !== 'plugin_only') {
        await fx.mutate(legacyKey, legacyMemory);
        await fx.mutate(sourceManifestKey, manifest);
      }
      const originalRef = manifest.memories['1'];
      const edit = await f.r.api.createCanonicalEditDraft({memoryId: originalRef.memoryId,
        revision: originalRef.revision});
      const saved = await f.r.api.saveCanonicalEditDraft({candidateId: edit.candidateId,
        text: editedCanonical});
      await f.r.api.saveCanonicalManualStateDisposition({jobId: saved.jobId,
        mode: 'maintained_by_user'});
      const adopted = await f.r.api.resolveCanonicalCandidate({jobId: saved.jobId, decision: 'adopt'});
      assert.equal(adopted.state, 'completed',
        `${mode}: manual edit is committed; state=${adopted.state}, warnings=${JSON.stringify(adopted.stateRebuild?.warnings || [])}`);
      const manualRef = storedValue(sourceManifestKey).memories['1'];
      assert.ok(manualRef.manualAuthorityHash && manualRef.manualStateDispositionDigest,
        `${mode}: the source ref seals both manual authority and State disposition`);
      const manualMemory = storedValue(manualRef.key);
      assert.equal(manualMemory.text, editedCanonical);

      const portable = f.r.context.__LIBRAPortableMemoryBackup;
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      assert.ok(envelope.records.some(row => row.key === sourceMicro.recordKey),
        `${mode}: export includes the original Micro record`);
      assert.ok(envelope.records.some(row => row.key === sourceOnlyMicro.recordKey),
        `${mode}: export preserves the older Micro revision`);
      assert.ok(envelope.records.some(row => row.key === sourceDecisions[0].key),
        `${mode}: export preserves the State admission decision`);
      if (mode === 'plugin_only') {
        const transferId = 'manual-canonical-micro-handoff';
        const prepared = await f.r.api.prepareSessionHandoff({transferId});
        assert.notEqual(prepared.ok, false, 'plugin-only handoff prepares both archives');
        currentChatIndex = 2;
        const handoffStatus = await f.r.api.getHostLineageStatus();
        await bridge.setScopeMode({scopeId: handoffStatus.scopeKey, scopeKey: handoffStatus.scopeKey,
          characterId: character.id, chatId: handoffChat.id}, mode);
        const handoff = await f.r.api.adoptSessionHandoff({transferId, targetChatId: handoffChat.id});
        assert.equal(handoff.verified, true, 'handoff publishes only a verified target');
        const handoffManifest = storedValue(`libra:v1:scope:${handoffStatus.scopeKey}:manifest`);
        const handoffManualRef = handoffManifest.inheritedMemories.find(row => row.manualAuthorityHash);
        assert.ok(handoffManualRef?.manualStateDispositionDigest,
          'plugin-only handoff preserves the manual Canonical seals');
        const handoffArchive = storedValue(handoffManifest.inheritedMicroArchives[0].archiveKey);
        assert.ok(handoffArchive.records.some(row => row.key === sourceDecisions[0].key),
          'plugin-only handoff preserves the Micro State decision in the same source graph');
      }
      currentChatIndex = 1;
      const targetStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
        characterId: character.id, chatId: targetChat.id}, mode);
      const preview = await portable.previewImport(envelope);
      assert.equal(preview.modes.import_as_predecessor_archive.available, true);
      if (mode === 'mirror') {
        const sharedPrefix = 'libra:v1:shared-archive:';
        const priorLocalArchives = [...fx.local.keys()].filter(key => key.startsWith(sharedPrefix)).sort();
        const priorServerArchives = fx.storedRows().filter(row => row.key.startsWith(sharedPrefix))
          .map(row => row.key).sort();
        let refused = false;
        fx.hooks.beforeServerRequest = async (url, request) => {
          if (url.endsWith('/v1/kv/set')
            && String(JSON.parse(request.body || '{}').key || '').includes(':micro-handoff-archive:')) {
            refused = true;
            throw new Error('injected manual Micro archive server write failure');
          }
        };
        await assert.rejects(() => retryBusy(() => portable.importAsPredecessorArchive(envelope)));
        fx.hooks.beforeServerRequest = null;
        assert.equal(refused, true, 'the fault reaches the Micro archive write after Canonical archive work');
        assert.deepEqual([...fx.local.keys()].filter(key => key.startsWith(sharedPrefix)).sort(),
          priorLocalArchives, 'failed transfer rolls back new local Canonical archive rows');
        assert.deepEqual(fx.storedRows().filter(row => row.key.startsWith(sharedPrefix))
          .map(row => row.key).sort(), priorServerArchives,
        'failed transfer rolls back new server Canonical archive rows');
        const failedManifestKey = `libra:v1:scope:${targetStatus.scopeKey}:manifest`;
        const failedLocal = fx.local.has(failedManifestKey)
          ? JSON.parse(fx.local.get(failedManifestKey)) : null;
        const failedServer = fx.storedRows().find(row => row.key === failedManifestKey)?.value || null;
        for (const failed of [failedLocal, failedServer]) {
          assert.equal((failed?.inheritedMemories || []).length, 0);
          assert.equal((failed?.inheritedMicroArchives || []).length, 0);
          assert.equal((failed?.portableImports || []).some(row => row.durable && row.verified), false);
        }
      }
      const imported = await retryBusy(() => portable.importAsPredecessorArchive(envelope));
      assert.equal(imported.ok, true);
      assert.notEqual(imported.inheritedStateAdmission?.status, 'pending_reconciliation',
        `${mode}: the manual archive import re-evaluates inherited Micro against the target basis`);
      const targetManifest = storedValue(`libra:v1:scope:${targetStatus.scopeKey}:manifest`);
      const inheritedManualRef = targetManifest.inheritedMemories.find(row => row.manualAuthorityHash);
      assert.ok(inheritedManualRef, `${mode}: manual Canonical remains in the shared archive`);
      assert.ok(inheritedManualRef.manualStateDispositionDigest,
        `${mode}: archived manual State disposition remains sealed`);
      const archivedManual = storedValue(inheritedManualRef.key);
      assert.equal(archivedManual.text, editedCanonical);
      assert.equal(archivedManual.manualAuthority.status, 'committed');
      assert.equal(archivedManual.manualAuthority.authorityHash,
        inheritedManualRef.manualAuthorityHash);
      assert.equal(archivedManual.manualStateDisposition.intentDigest,
        inheritedManualRef.manualStateDispositionDigest);
      assert.equal(targetManifest.inheritedMicroArchives.length, 1,
        `${mode}: the same transfer links a Micro archive`);
      const microArchive = storedValue(targetManifest.inheritedMicroArchives[0].archiveKey);
      assert.ok(microArchive.records.some(row => row.key === sourceOnlyMicro.recordKey),
        `${mode}: the archive retains the historical Micro revision`);
      assert.ok(microArchive.records.some(row => row.key === sourceMicro.recordKey),
        `${mode}: the archive retains the active Micro revision`);
      assert.ok(microArchive.records.some(row => row.key === sourceDecisions[0].key
        && row.value.decisionDigest === sourceDecisions[0].value.decisionDigest),
        `${mode}: the archive retains the source-basis admission decision`);
      const targetDecision = (mode === 'server_only' ? fx.storedRows()
        : [...fx.local].flatMap(([key, raw]) => {
          try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
        }))
        .find(row => row.value?.schema === 'libra.inherited_micro_state_admission.v1'
          && row.value.scopeKey === targetStatus.scopeKey
          && row.value.microRecordKey === sourceMicro.recordKey);
      assert.ok(targetDecision?.value?.basisDigest && targetDecision.value.decisionDigest,
        `${mode}: a durable target-basis decision exists for the archived Micro claim`);
      assert.equal(targetDecision.value.status, 'pending',
        `${mode}: manual Canonical overlap cannot silently approve the source Micro claim`);
      assert.ok(targetDecision.value.reason,
        `${mode}: pending target decision explains the unresolved overlap`);
      assert.notEqual(targetDecision.value.scopeKey, sourceDecisions[0].value.scopeKey,
        `${mode}: the source admission never becomes target authority`);
      if (mode === 'mirror') {
        assert.deepEqual(fx.storedRows().find(row => row.key === targetDecision.key)?.value,
          targetDecision.value, 'mirror physically agrees on the target-basis decision');
      }

      const sourcePrefix = `libra:v1:scope:${sourceStatus.scopeKey}:`;
      for (const key of [...fx.local.keys()].filter(key => key.startsWith(sourcePrefix))) fx.local.delete(key);
      for (const row of fx.storedRows().filter(row => row.key.startsWith(sourcePrefix))) {
        await fx.mutate(row.key, null, 'remove');
      }
      assert.equal([...fx.local.keys()].some(key => key.startsWith(sourcePrefix)), false,
        `${mode}: no plugin copy of the source owner remains`);
      assert.equal(fx.storedRows().some(row => row.key.startsWith(sourcePrefix)), false,
        `${mode}: no server copy of the source owner remains`);
      f = await fx.restart();
      const recall = await f.r.api.previewUnifiedMemoryRecall(sceneQuote);
      assert.ok((recall.memories || []).some(row => row.memory?.kind === 'micro'
        && (row.memory.sourceSpans || []).some(span => span.exactQuote === sceneQuote)),
        `${mode}: the exact Micro scene survives source deletion and restart`);
      const projected = await f.r.api.debugLoadContinuityStateForResponse();
      assert.notEqual(projected.head?.narrative?.summary, sceneQuote,
        `${mode}: a source-basis Micro decision is not silently authorized in the target`);
      if (mode === 'plugin_only') {
        currentChatIndex = 2;
        const handoffRecall = await f.r.api.previewUnifiedMemoryRecall(sceneQuote);
        assert.ok((handoffRecall.memories || []).some(row => row.memory?.kind === 'micro'
          && (row.memory.sourceSpans || []).some(span => span.exactQuote === sceneQuote)),
        'the manually edited handoff retains precise Micro evidence after source removal');
      }
      console.log(`PASS manual Canonical and Micro archive in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
