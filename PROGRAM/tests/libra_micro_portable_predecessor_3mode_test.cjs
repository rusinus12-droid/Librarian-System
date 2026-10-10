'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const input = require('./fixtures/unified_vertical_source.json');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const waitForAsync = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for durable Micro publication');
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
  assert.ok(modes.every(mode => allModes.includes(mode)), 'LIBRA_TEST_MODE is a supported storage mode');
  for (const mode of modes) {
    const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'Portable Micro source',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    sourceChat.messages = sourceChat.message;
    const targetChat = {id: 'micro-predecessor-target', chatId: 'micro-predecessor-target',
      name: 'Portable Micro target', message: []};
    targetChat.messages = targetChat.message;
    const nextChat = {id: 'micro-predecessor-next', chatId: 'micro-predecessor-next',
      name: 'Portable Micro next target', message: []};
    nextChat.messages = nextChat.message;
    const nativeChat = {id: 'micro-native-copy-target', chatId: 'micro-native-copy-target',
      name: 'Portable Micro native copy', message: sourceChat.message.map((row, index) =>
        ({...row, chatId: `native-${index}`}))};
    nativeChat.messages = nativeChat.message;
    const tamperChat = {id: 'micro-predecessor-tamper', chatId: 'micro-predecessor-tamper',
      name: 'Portable Micro tamper target', message: []};
    tamperChat.messages = tamperChat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아', chatPage: 0,
      chats: [sourceChat, targetChat, nextChat, nativeChat, tamperChat]};
    let currentChatIndex = 0;
    let completedTurnListener = null;
    const host = {
      addRisuChatListener: async (_kind, handler) => { completedTurnListener = handler; return true; },
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
      assert.ok(bridge, 'the fixture exposes the real owner storage bridge');
      const sourceStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: sourceStatus.scopeKey, scopeKey: sourceStatus.scopeKey,
        characterId: character.id, chatId: sourceChat.id}, mode);
      f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
        .includes('[LIBRA MICRO SOURCE CONTRACT]')
        ? {type: 'error', result: 'controlled Micro provider unavailable'}
        : {type: 'success', result: JSON.stringify(f.control.artifact)};
      assert.equal((await f.run()).completed, 1);
      await require('./fixtures/libra_explicit_micro_retry.cjs').retryHistoricalMicro(f,[1]);
      await waitForAsync(async () => (await f.r.api.debugReadActiveMicroMemory(1)).status === 'verified');
      const sourceMicro = await f.r.api.debugReadActiveMicroMemory(1);
      const query = sourceMicro.record.excerpt.exactQuote;
      let portable = f.r.context.__LIBRAPortableMemoryBackup;
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      assert.ok(envelope.records.some(row => row.key === sourceMicro.recordKey));
      currentChatIndex = 1;
      const targetStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
        characterId: character.id, chatId: targetChat.id}, mode);
      const preview = await portable.previewImport(envelope);
      assert.equal(preview.modes.import_as_predecessor_archive.available, true, `${mode}: target is eligible`);
      if (mode === 'mirror') {
        let refused = false;
        fx.hooks.beforeServerRequest = async (url, request) => {
          if (url.endsWith('/v1/kv/set')
            && String(JSON.parse(request.body || '{}').key || '').includes(':micro-handoff-archive:')) {
            refused = true;
            throw new Error('injected Micro archive server write failure');
          }
        };
        await assert.rejects(() => retryBusy(() => portable.importAsPredecessorArchive(envelope)));
        fx.hooks.beforeServerRequest = null;
        assert.equal(refused, true, 'the fault reached the Micro archive server write');
        const targetArchivePrefix = `libra:v1:scope:${preview.target.scopeKey}:micro-handoff-archive:`;
        assert.equal([...fx.local.keys()].some(key => key.startsWith(targetArchivePrefix)), false,
          'failed mirror import rolls back its local Micro archive');
        assert.equal(fx.storedRows().some(row => row.key.startsWith(targetArchivePrefix)), false,
          'failed mirror import leaves no server Micro archive');
        const failedManifestKey = `libra:v1:scope:${preview.target.scopeKey}:manifest`;
        const failedManifestRaw = fx.local.get(failedManifestKey);
        const failedManifest = failedManifestRaw ? JSON.parse(failedManifestRaw) : null;
        assert.equal((failedManifest?.inheritedMicroArchives || []).length, 0,
          'failed mirror import does not publish inherited Micro refs');
        assert.equal((failedManifest?.portableImports || []).some(row => row.verified && row.durable), false,
          'failed mirror import does not leave a durable receipt');
      }
      const result = await retryBusy(() => portable.importAsPredecessorArchive(envelope));
      assert.equal(result.ok, true, `${mode}: import succeeds`);
      const manifestKey = `libra:v1:scope:${preview.target.scopeKey}:manifest`;
      const localManifest = fx.local.has(manifestKey) ? JSON.parse(fx.local.get(manifestKey)) : null;
      const serverManifest = fx.storedRows().find(row => row.key === manifestKey)?.value || null;
      if (mode === 'mirror') assert.deepEqual(localManifest?.inheritedMicroArchives,
        serverManifest?.inheritedMicroArchives, 'mirror manifest copies agree');
      const manifest = mode === 'server_only' ? serverManifest : localManifest;
      const ref = manifest?.inheritedMicroArchives?.[0];
      assert.equal(ref?.schema, 'libra.micro_handoff_archive_ref.v1', `${mode}: target links the Micro archive`);
      if (mode !== 'server_only') assert.ok(fx.local.has(ref.archiveKey), `${mode}: local archive exists`);
      if (mode !== 'plugin_only') assert.ok(fx.storedRows().some(row => row.key === ref.archiveKey),
        `${mode}: server archive exists`);
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      portable = f.r.context.__LIBRAPortableMemoryBackup;
      const recall = await f.r.api.previewUnifiedMemoryRecall(query);
      assert.ok((recall.memories || []).some(row => row.memory?.kind === 'micro'
        && (row.memory.sourceSpans || []).some(span => span.exactQuote === query)),
        `${mode}: the previous chat's Micro detail reaches Recall after restart`);
      const targetOwnRows = sourceChat.message.map((row, index) =>
        ({...row, chatId: `target-own-${index}`}));
      f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
        .includes('[LIBRA MICRO SOURCE CONTRACT]')
        ? {type: 'error', result: 'controlled Micro provider unavailable'}
        : {type: 'success', result: JSON.stringify(f.control.artifact)};
      assert.equal(typeof completedTurnListener, 'function',
        `${mode}: completed-output listener is registered after target restart`);
      for (let turn = 1; turn <= 5; turn += 1) {
        targetChat.message = targetOwnRows.slice(0, turn * 2);
        targetChat.messages = targetChat.message;
        completedTurnListener({char: character, chat: targetChat, characterIndex: 0,
          chatIndex: 1, messageIndex: turn * 2 - 1});
        await waitForAsync(async () => (await f.r.api.debugReadActiveMicroMemory(turn)).status === 'verified');
      }
      const adoptedRun = await f.run();
      assert.equal(adoptedRun.failed, 0,
        `${mode}: the first target Canonical batch has no failed work: ${JSON.stringify(adoptedRun)}`);
      assert.equal(adoptedRun.completed + adoptedRun.skipped, 1,
        `${mode}: the adopted chat settles its five-turn Canonical: ${JSON.stringify(adoptedRun)}`);
      const committedManifest = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === manifestKey)?.value
        : JSON.parse(fx.local.get(manifestKey));
      const newCanonicalRef = Object.values(committedManifest?.memories || {})
        .find(row => Number(row?.turnRange?.start) === 1);
      assert.equal(newCanonicalRef?.status, 'committed',
        `${mode}: the target owns a newly committed Canonical after T5`);
      const newCanonical = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === newCanonicalRef.key)?.value
        : JSON.parse(fx.local.get(newCanonicalRef.key));
      assert.equal(newCanonical?.status, 'committed',
        `${mode}: the new Canonical body is physically readable`);
      assert.equal(newCanonical?.scopeKey, preview.target.scopeKey,
        `${mode}: inherited Canonical was not promoted as the target's own record`);
      if (mode === 'mirror') {
        assert.deepEqual(fx.storedRows().find(row => row.key === manifestKey)?.value,
          committedManifest, 'mirror Canonical manifest copies agree');
        assert.deepEqual(fx.storedRows().find(row => row.key === newCanonicalRef.key)?.value,
          newCanonical, 'mirror Canonical body copies agree');
      }
      for (let turn = 1; turn <= 5; turn += 1) {
        assert.equal((await f.r.api.debugReadActiveMicroMemory(turn)).status, 'verified',
          `${mode}: T${turn} Micro remains active after the new Canonical commit`);
      }
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      portable = f.r.context.__LIBRAPortableMemoryBackup;
      for (let turn = 1; turn <= 5; turn += 1) {
        assert.equal((await f.r.api.debugReadActiveMicroMemory(turn)).status, 'verified',
          `${mode}: T${turn} Micro survives restart beside the new Canonical`);
      }
      const nextOwnRows = sourceChat.message.map((row, index) =>
        ({...row, chatId: `target-next-${index}`}));
      const secondArtifact = structuredClone(f.control.artifact);
      for (const item of [...secondArtifact.entities, ...secondArtifact.facts]) {
        for (const span of item.evidenceSpans || []) {
          span.ref = span.ref.replace(/^t(\d+)/, (_whole, number) => `t${Number(number) + 5}`);
        }
      }
      f.control.artifact = secondArtifact;
      f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
        .includes('[LIBRA MICRO SOURCE CONTRACT]')
        ? {type: 'error', result: 'controlled Micro provider unavailable'}
        : {type: 'success', result: JSON.stringify(f.control.artifact)};
      let blockedSecondCanonical = false;
      const observedBatchKeys = [];
      let faultSnapshot = null;
      if (mode !== 'plugin_only') {
        fx.hooks.beforeServerRequest = async (url, request) => {
          if (!url.endsWith('/v1/kv/batch')) return;
          const body = JSON.parse(request.body || '{}');
          const keys = (body.mutations || []).map(row => String(row.key || ''));
          observedBatchKeys.push(keys);
          const manifestMutation = (body.mutations || []).find(row => row.key === manifestKey);
          let proposedManifest = null;
          try { proposedManifest = typeof manifestMutation?.value === 'string'
            ? JSON.parse(manifestMutation.value) : manifestMutation?.value; } catch (_) {}
          const currentServerStatus = fx.storedRows().find(row => row.key === manifestKey)
            ?.value?.memories?.['6']?.status;
          if (proposedManifest?.memories?.['6']?.status === 'committed'
            && currentServerStatus !== 'committed') {
            blockedSecondCanonical = true;
            faultSnapshot = {keys, proposedMemoryStatus: proposedManifest.memories['6'].status,
              localMemoryStatus: JSON.parse(fx.local.get(manifestKey) || 'null')?.memories?.['6']?.status,
              serverMemoryStatus: currentServerStatus};
            throw new Error('injected predecessor second Canonical commit failure');
          }
        };
      }
      for (let turn = 6; turn <= 10; turn += 1) {
        targetChat.message = [...targetOwnRows, ...nextOwnRows.slice(0, (turn - 5) * 2)];
        targetChat.messages = targetChat.message;
        completedTurnListener({char: character, chat: targetChat, characterIndex: 0,
          chatIndex: 1, messageIndex: turn * 2 - 1});
        await waitForAsync(async () => (await f.r.api.debugReadActiveMicroMemory(turn)).status === 'verified');
      }
      if (mode !== 'plugin_only') {
        let interruptedRun;
        try { interruptedRun = await f.run(); }
        catch (error) { interruptedRun = {error: String(error?.message || error)}; }
        assert.equal(blockedSecondCanonical, true,
          `${mode}: the fault reaches the second Canonical commit: ${JSON.stringify(observedBatchKeys)}`);
        assert.notEqual(interruptedRun.completed, 1,
          `${mode}: interrupted successor cannot report a completed Canonical`);
        const interruptedManifest = mode === 'server_only'
          ? fx.storedRows().find(row => row.key === manifestKey)?.value
          : JSON.parse(fx.local.get(manifestKey));
        assert.notEqual(interruptedManifest?.memories?.['6']?.status, 'committed',
          `${mode}: failed successor leaves no committed T6–T10 pointer: ${JSON.stringify({interruptedRun, faultSnapshot})}`);
        assert.equal(interruptedManifest?.memories?.['1']?.key, newCanonicalRef.key,
          `${mode}: failed successor preserves the first Canonical pointer`);
        assert.deepEqual(interruptedManifest?.inheritedMicroArchives,
          committedManifest.inheritedMicroArchives,
          `${mode}: failed successor preserves predecessor Micro archive references`);
        assert.equal((await f.r.api.debugReadActiveMicroMemory(10)).status, 'verified',
          `${mode}: failed Canonical commit does not discard the independent T10 Micro`);
        fx.hooks.beforeServerRequest = null;
        f = await fx.restart();
        bridge = f.r.context.__fixtureStorageBridge;
        portable = f.r.context.__LIBRAPortableMemoryBackup;
        f.control.artifact = secondArtifact;
        f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
          .includes('[LIBRA MICRO SOURCE CONTRACT]')
          ? {type: 'error', result: 'controlled Micro provider unavailable'}
          : {type: 'success', result: JSON.stringify(f.control.artifact)};
      }
      const secondRun = mode === 'plugin_only' ? await f.run()
        : await f.r.api.retryFailedMemoryAnalysis({startTurns: [6]});
      assert.equal(secondRun.failed, 0,
        `${mode}: the second target Canonical batch has no failed work: ${JSON.stringify(secondRun)}`);
      assert.equal(secondRun.completed + secondRun.skipped, mode === 'plugin_only' ? 2 : 1,
        `${mode}: the adopted chat settles its next five-turn Canonical: ${JSON.stringify(secondRun)}`);
      const secondManifest = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === manifestKey)?.value
        : JSON.parse(fx.local.get(manifestKey));
      const secondRef = Object.values(secondManifest?.memories || {})
        .find(row => Number(row?.turnRange?.start) === 6);
      assert.equal(secondRef?.status, 'committed',
        `${mode}: the target owns a second Canonical for T6–T10: ${JSON.stringify({secondRun, refs: secondManifest?.memories})}`);
      const secondCanonical = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === secondRef.key)?.value
        : JSON.parse(fx.local.get(secondRef.key));
      assert.equal(secondCanonical?.status, 'committed',
        `${mode}: the second Canonical body is physically committed`);
      assert.equal(secondCanonical?.scopeKey, preview.target.scopeKey,
        `${mode}: the second Canonical body is physically owned by the target`);
      if (mode !== 'plugin_only') {
        const runKey = `libra:v1:scope:${preview.target.scopeKey}:run:${secondRef.runId}`;
        const storedRun = mode === 'server_only'
          ? fx.storedRows().find(row => row.key === runKey)?.value
          : JSON.parse(fx.local.get(runKey));
        assert.ok(['complete', 'complete_with_warnings'].includes(storedRun?.status),
          `${mode}: recovery closes the original committed run`);
        assert.equal(storedRun?.recovery?.kind, 'prepared_server_activation');
        assert.equal(fx.storedRows().some(row => row.value?.schema === 'libra.unified_server_activation.v1'), false,
          `${mode}: recovery removes the prepared activation journal`);
        const stateKey = `libra:v1:scope:${preview.target.scopeKey}:continuity-state`;
        try {
          await waitForAsync(async () => {
            const serverState = fx.storedRows().find(row => row.key === stateKey)?.value;
            const localState = mode === 'mirror' ? JSON.parse(fx.local.get(stateKey) || 'null') : serverState;
            return Number(serverState?.throughTurn || 0) >= 10
              && Number(localState?.throughTurn || 0) >= 10;
          });
        } catch (error) {
          const journalKey = `libra:v1:scope:${preview.target.scopeKey}:state-tracking-journal:v1`;
          const journal = fx.storedRows().find(row => row.key === journalKey)?.value;
          const localJournal = mode === 'mirror' ? JSON.parse(fx.local.get(journalKey) || 'null') : journal;
          const head = fx.storedRows().find(row => row.key === stateKey)?.value;
          throw new Error(`${mode}: recovered State did not advance: ${JSON.stringify({
            throughTurn: head?.throughTurn, localEntries: localJournal?.entries?.map(entry => ({state: entry.state,
              reason: entry.reason, error: entry.error, turnRange: entry.envelope?.turnRange})),
            entries: journal?.entries?.map(entry => ({state: entry.state,
              reason: entry.reason, error: entry.error, turnRange: entry.envelope?.turnRange}))
          })}`, {cause: error});
        }
      }
      if (mode === 'mirror') {
        assert.deepEqual(fx.storedRows().find(row => row.key === manifestKey)?.value,
          secondManifest, 'mirror second Canonical manifest copies agree');
        assert.deepEqual(fx.storedRows().find(row => row.key === secondRef.key)?.value,
          secondCanonical, 'mirror second Canonical body copies agree');
      }
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      portable = f.r.context.__LIBRAPortableMemoryBackup;
      for (let turn = 1; turn <= 10; turn += 1) {
        assert.equal((await f.r.api.debugReadActiveMicroMemory(turn)).status, 'verified',
          `${mode}: T${turn} Micro survives the second Canonical and restart`);
      }
      const continuedEnvelope = await retryBusy(() => portable.exportCurrentScope());
      assert.ok(continuedEnvelope.records.some(row => row.key === ref.archiveKey),
        `${mode}: a second export carries the inherited Micro archive itself`);
      const latestMicro = await f.r.api.debugReadActiveMicroMemory(10);
      assert.ok(continuedEnvelope.records.some(row => row.key === latestMicro.recordKey),
        `${mode}: the second export carries the target's latest Micro revision`);
      currentChatIndex = 2;
      const nextStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: nextStatus.scopeKey, scopeKey: nextStatus.scopeKey,
        characterId: character.id, chatId: nextChat.id}, mode);
      const nextPreview = await portable.previewImport(continuedEnvelope);
      assert.equal(nextPreview.modes.import_as_predecessor_archive.available, true);
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(continuedEnvelope))).ok, true);
      const nextManifestKey = `libra:v1:scope:${nextPreview.target.scopeKey}:manifest`;
      const nextManifest = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === nextManifestKey)?.value
        : JSON.parse(fx.local.get(nextManifestKey));
      assert.equal(nextManifest?.inheritedMicroArchives?.[0]?.sessionEpoch, -2,
        `${mode}: second import preserves the earlier session epoch`);
      assert.equal(nextManifest?.inheritedMicroArchives?.length, 2,
        `${mode}: second import retains inherited and newly committed Micro archives`);
      f = await fx.restart();
      const continuedRecall = await f.r.api.previewUnifiedMemoryRecall(query);
      assert.ok((continuedRecall.memories || []).some(row => row.memory?.kind === 'micro'
        && (row.memory.sourceSpans || []).some(span => span.exactQuote === query)),
        `${mode}: Micro remains recallable after a second portable import and restart`);
      currentChatIndex = 3;
      bridge = f.r.context.__fixtureStorageBridge;
      portable = f.r.context.__LIBRAPortableMemoryBackup;
      const nativeStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: nativeStatus.scopeKey, scopeKey: nativeStatus.scopeKey,
        characterId: character.id, chatId: nativeChat.id}, mode);
      const nativeEnvelope = continuedEnvelope;
      const nativePreview = await portable.previewImport(nativeEnvelope);
      assert.equal(nativePreview.modes.reconstruct_native_copy.available, true,
        `${mode}: the matching copied chat is eligible for native reconstruction`);
      const nativePrefix = `libra:v1:scope:${nativePreview.target.scopeKey}:`;
      if (mode === 'mirror') {
        let refused = false;
        fx.hooks.beforeServerRequest = async (url, request) => {
          if (url.endsWith('/v1/kv/set')
            && String(JSON.parse(request.body || '{}').key || '').startsWith(`${nativePrefix}micro-memory-head:`)) {
            refused = true;
            throw new Error('injected native Micro head server write failure');
          }
        };
        await assert.rejects(() => retryBusy(() => portable.reconstructCopiedChat(nativeEnvelope)));
        fx.hooks.beforeServerRequest = null;
        assert.equal(refused, true, 'native copy fault reached the server Micro head write');
        assert.equal([...fx.local.keys()].some(key => key.startsWith(`${nativePrefix}micro-memory-head:`)), false,
          'failed native copy rolls back local Micro heads');
        assert.equal(fx.storedRows().some(row => row.key.startsWith(`${nativePrefix}micro-memory-head:`)), false,
          'failed native copy rolls back server Micro heads');
      }
      const nativeResult = await retryBusy(() => portable.reconstructCopiedChat(nativeEnvelope));
      assert.equal(nativeResult.ok, true, `${mode}: native reconstruction succeeds`);
      assert.ok(nativeResult.receipt.microOwnerRecords > 0,
        `${mode}: completion receipt counts the rebound Micro owner graph`);
      assert.equal(nativeResult.receipt.microInheritedArchiveCount, 1,
        `${mode}: native copy retains the inherited predecessor Micro archive`);
      const nativeHeadPrefix = `${nativePrefix}micro-memory-head:`;
      if (mode !== 'server_only') assert.ok([...fx.local.keys()].some(key => key.startsWith(nativeHeadPrefix)),
        `${mode}: target has a local active Micro head`);
      if (mode !== 'plugin_only') assert.ok(fx.storedRows().some(row => row.key.startsWith(nativeHeadPrefix)),
        `${mode}: target has a server active Micro head`);
      f = await fx.restart();
      const nativeRecall = await f.r.api.previewUnifiedMemoryRecall(query);
      assert.ok((nativeRecall.memories || []).some(row => row.memory?.kind === 'micro'
        && (row.memory.sourceSpans || []).some(span => span.exactQuote === query)),
        `${mode}: rebound Micro remains recallable after native copy restart`);
      if (mode === 'mirror') {
        currentChatIndex = 4;
        bridge = f.r.context.__fixtureStorageBridge;
        portable = f.r.context.__LIBRAPortableMemoryBackup;
        const tamperStatus = await f.r.api.getHostLineageStatus();
        await bridge.setScopeMode({scopeId: tamperStatus.scopeKey, scopeKey: tamperStatus.scopeKey,
          characterId: character.id, chatId: tamperChat.id}, mode);
        assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(envelope))).ok, true);
        const tamperManifestKey = `libra:v1:scope:${tamperStatus.scopeKey}:manifest`;
        const forgedManifest = JSON.parse(fx.local.get(tamperManifestKey));
        forgedManifest.portableImports = forgedManifest.portableImports.map(row =>
          row.mode === 'import_as_predecessor_archive' ? {...row, verified: false} : row);
        await fx.mutate(tamperManifestKey, forgedManifest);
        fx.local.set(tamperManifestKey, JSON.stringify(forgedManifest));
        tamperChat.message.push(...sourceChat.message.map((row, index) =>
          ({...row, chatId: `tamper-own-${index}`})));
        f = await fx.restart();
        f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
          .includes('[LIBRA MICRO SOURCE CONTRACT]')
          ? {type: 'error', result: 'controlled Micro provider unavailable'}
          : {type: 'success', result: JSON.stringify(f.control.artifact)};
        const blocked = await f.run();
        assert.equal(blocked.completed, 0, 'a forged import receipt cannot activate server lineage');
        assert.match(JSON.stringify(blocked.failures), /UNIFIED_SERVER_LINEAGE_NOT_SUPPORTED/);
      }
      console.log(`PASS Micro predecessor portable import in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
