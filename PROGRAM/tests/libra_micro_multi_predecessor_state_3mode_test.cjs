'use strict';
const assert = require('node:assert/strict');
const input = require('./fixtures/unified_vertical_source.json');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {branch} = require('./fixtures/native_branch_fixture.cjs');

const waitFor = async predicate => {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for verified T6 Micro State');
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
  const modes = process.env.LIBRA_TEST_MODE
    ? [process.env.LIBRA_TEST_MODE] : ['plugin_only', 'server_only'];
  for (const mode of modes) {
    const sourceRows = prefix => input.sourceRows.map((row, index) => ({
      role: row.role, chatId: `${prefix}-${index}`, data: row.text
    }));
    const chats = [
      {id: 'unified-chat', chatId: 'unified-chat', name: 'First predecessor',
        message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))},
      {id: 'middle-chat', chatId: 'middle-chat', name: 'Second predecessor', message: []},
      {id: 'final-chat', chatId: 'final-chat', name: 'Final target', message: []},
      {id: 'final-descendant', chatId: 'final-descendant', name: 'Branch successor', message: []}
    ];
    for (const chat of chats) chat.messages = chat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아',
      chatPage: 0, chats};
    let currentChatIndex = 0, listener;
    const host = {
      getCurrentChatIndex: async () => currentChatIndex,
      getChat: async () => chats[currentChatIndex],
      getCurrentChat: async () => chats[currentChatIndex],
      getChatFromIndex: async (_ci, index) => chats[index],
      getCharacter: async () => character,
      getCharacterFromIndex: async () => character,
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [character], plugins: []};
        return Array.isArray(fields)
          ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    };
    const fx = await serverFixture({mode, snapshot: {chat: chats[0]}, host,
      transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
        '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      let {f} = fx;
      let bridge = f.r.context.__fixtureStorageBridge;
      const scopes = [];
      const setMode = async index => {
        currentChatIndex = index;
        const status = await f.r.api.getHostLineageStatus();
        scopes[index] = status.scopeKey;
        await bridge.setScopeMode({scopeId: status.scopeKey, scopeKey: status.scopeKey,
          characterId: character.id, chatId: chats[index].id}, mode);
      };
      const setCanonicalProvider = () => {
        f.control.onCall = args => String(args[0]?.messages?.[0]?.content || '')
          .includes('[LIBRA MICRO SOURCE CONTRACT]')
          ? {type: 'error', result: 'controlled Micro provider unavailable'}
          : {type: 'success', result: JSON.stringify(f.control.artifact)};
      };
      const produceT6 = async (index, value, {edit = false} = {}) => {
        const chat = chats[index];
        const quote = `도서관 문이 ${value}`;
        const previous = edit ? await f.r.api.debugReadActiveMicroMemory(6) : null;
        if (edit) {
          assert.equal(previous?.status, 'verified', 'the edited turn has an active predecessor');
          chat.message[chat.message.length - 1].data = `${quote}. 민아가 이를 확인했다.`;
        } else {
          chat.message.push(
            {role: 'user', chatId: `t6-${index}-u`, data: '도서관 문 상태를 확인해 줘.'},
            {role: 'assistant', chatId: `t6-${index}-a`, data: `${quote}. 민아가 이를 확인했다.`}
          );
        }
        chat.messages = chat.message;
        f.control.onCall = async () => {
          const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(6)).receipt;
          const start = receipt.assistant.text.indexOf(quote);
          return {type: 'success', result: JSON.stringify({
            schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []},
            micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
              worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
              turn: 6, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: [{changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
                stateChangeType: 'set', stateIntent: {domain: 'world',
                  target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value},
                evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
                  startOffset: start, endOffset: start + quote.length, exactQuote: quote}}]}
          })};
        };
        assert.equal(typeof listener, 'function');
        listener({char: character, chat, characterIndex: 0, chatIndex: index,
          messageIndex: chat.message.length - 1});
        await waitFor(async () => {
          const active = await f.r.api.debugReadActiveMicroMemory(6);
          return active.status === 'verified'
            && (!previous || active.recordKey !== previous.recordKey);
        });
        await waitFor(async () => (await f.r.api.debugReadCurrentMicroStateAdmission(6, 0)).status === 'admitted');
        await waitFor(async () => (await f.r.api.debugLoadContinuityStateForResponse()).head?.world
          ?.find(row => row.name === '도서관')?.state?.doorStatus === value);
        if (previous) {
          const sourceScope = scopes[index];
          const rows = mode === 'server_only' ? fx.storedRows()
            : [...fx.local].map(([key, raw]) => {
              try { return {key, value: JSON.parse(raw)}; }
              catch { return {key, value: null}; }
            });
          const revisions = rows.filter(row => row.value?.schema === 'libra.micro_memory.v1'
            && row.value.scopeKey === sourceScope && Number(row.value.turn) === 6);
          assert.ok(revisions.length >= 2,
            `${mode}: edited T6 keeps both immutable Micro revisions`);
          assert.ok(revisions.some(row => row.key === previous.recordKey),
            `${mode}: the prior T6 record remains physically addressable`);
        }
      };
      await setMode(3);
      const descendantScopeKey = scopes[3];
      await setMode(0);
      setCanonicalProvider();
      assert.equal((await f.run()).completed, 1);
      await produceT6(0, '잠깐 열려 있었다');
      await produceT6(0, '열렸다', {edit: true});
      let portable = f.r.context.__LIBRAPortableMemoryBackup;
      const firstEnvelope = await retryBusy(() => portable.exportCurrentScope());
      assert.ok(firstEnvelope.records.filter(row => String(row.key).includes(':micro-memory:')
        && String(row.key).includes(':t6:')).length >= 2,
      `${mode}: first export carries active and historical T6 revisions`);

      await setMode(1);
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(firstEnvelope))).ok,
        true, `${mode}: first predecessor import succeeds`);
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      portable = f.r.context.__LIBRAPortableMemoryBackup;
      chats[1].message.push(...sourceRows('middle'));
      chats[1].messages = chats[1].message;
      setCanonicalProvider();
      assert.equal((await f.run()).completed, 1, `${mode}: middle chat commits its Canonical`);
      await produceT6(1, '닫히는 중이었다');
      await produceT6(1, '닫혔다', {edit: true});
      const secondEnvelope = await retryBusy(() => portable.exportCurrentScope());
      assert.ok(secondEnvelope.records.filter(row => String(row.key).includes(':micro-memory:')
        && String(row.key).includes(':t6:')).length >= 2,
      `${mode}: second export carries active and historical T6 revisions`);

      await setMode(2);
      if (mode === 'mirror') {
        let archiveWrites = 0;
        const archivePrefix = `libra:v1:scope:${scopes[2]}:micro-handoff-archive:`;
        fx.hooks.beforeServerRequest = async (url, request) => {
          const key = String(JSON.parse(request.body || '{}').key || '');
          if (url.endsWith('/v1/kv/set') && key.startsWith(archivePrefix)) {
            archiveWrites += 1;
            if (archiveWrites === 2) throw new Error('injected second Micro archive server failure');
          }
        };
        await assert.rejects(() => retryBusy(() =>
          portable.importAsPredecessorArchive(secondEnvelope)));
        fx.hooks.beforeServerRequest = null;
        assert.equal(archiveWrites, 2, 'the fault reached the second archive write');
        assert.equal([...fx.local.keys()].some(key => key.startsWith(archivePrefix)), false,
          'failed multi-archive import rolls back both local archive rows');
        assert.equal(fx.storedRows().some(row => row.key.startsWith(archivePrefix)), false,
          'failed multi-archive import rolls back both server archive rows');
        const manifestKey = `libra:v1:scope:${scopes[2]}:manifest`;
        const manifest = fx.local.has(manifestKey) ? JSON.parse(fx.local.get(manifestKey)) : null;
        assert.equal((manifest?.inheritedMicroArchives || []).length, 0,
          'failed multi-archive import publishes no archive references');
        assert.equal((manifest?.portableImports || []).some(row => row.verified && row.durable), false,
          'failed multi-archive import publishes no success receipt');
      }
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(secondEnvelope))).ok,
        true, `${mode}: second predecessor import succeeds`);
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      chats[2].message.push(...sourceRows('final'));
      chats[2].messages = chats[2].message;
      setCanonicalProvider();
      assert.equal((await f.run()).completed, 1, `${mode}: final chat commits its Canonical`);
      await waitFor(async () => ((await f.r.api.debugLoadContinuityStateForResponse())
        .authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus').length === 2);
      const view = await f.r.api.debugLoadContinuityStateForResponse();
      const transitions = (view.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus');
      assert.equal(transitions.length, 2,
        `${mode}: both predecessor State claims have target-basis decisions`);
      assert.deepEqual(Array.from(transitions, row => Number(row.sessionEpoch)), [-2, -1],
        `${mode}: older and newer predecessor epochs remain ordered`);
      assert.equal(view.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '닫혔다', `${mode}: the newer predecessor event controls current State`);
      assert.deepEqual(Array.from(transitions, row => row.disposition),
        ['corrected', 'still_current'],
        `${mode}: an older event remains history after a newer predecessor changes its field`);
      assert.ok(transitions.every(row => row.decisionKey),
        `${mode}: both transitions cite durable target decisions`);
      const decisionRows = mode === 'server_only' ? fx.storedRows()
        : [...fx.local].map(([key, raw]) => {
          let value = raw;
          try { value = JSON.parse(raw); } catch (_) { /* non-JSON storage row */ }
          return {key, value};
        });
      for (const transition of transitions) {
        const decision = decisionRows.find(row => row.key === transition.decisionKey)?.value;
        assert.equal(decision?.schema, 'libra.inherited_micro_state_admission.v1');
        assert.equal(decision?.status, 'admitted');
        if (mode === 'mirror') assert.deepEqual(
          fx.storedRows().find(row => row.key === transition.decisionKey)?.value, decision,
          'mirror keeps each target-basis decision identical on both storage sides');
      }
      const finalManifestKey = `libra:v1:scope:${scopes[2]}:manifest`;
      const finalManifestRaw = fx.local.get(finalManifestKey);
      const finalManifest = mode === 'server_only'
        ? fx.storedRows().find(row => row.key === finalManifestKey)?.value
        : JSON.parse(finalManifestRaw);
      const finalArchiveRefs = (finalManifest?.inheritedMicroArchives || [])
        .filter(ref => [scopes[0], scopes[1]].includes(ref.sourceScopeKey));
      assert.equal(finalArchiveRefs.length, 2,
        `${mode}: both edited predecessors have sealed archives before owner deletion`);
      for (const ref of finalArchiveRefs) {
        const localRaw = fx.local.get(ref.archiveKey);
        const remote = fx.storedRows().find(row => row.key === ref.archiveKey)?.value;
        if (mode === 'mirror') assert.ok(localRaw,
          'mirror keeps a physical local archive before the deletion reset fence');
        const archive = mode === 'server_only' ? remote : JSON.parse(localRaw);
        assert.equal(archive?.archiveDigest, ref.archiveDigest);
        if (mode === 'mirror') assert.deepEqual(JSON.parse(localRaw), remote,
          'mirror keeps equal physical archive bodies before owner deletion');
        assert.ok((archive.records || []).filter(row => row.value?.schema === 'libra.micro_memory.v1'
          && Number(row.value.turn) === 6).length >= 2,
        `${mode}: both revisions survive the first predecessor chain`);
      }
      const library = view.head.world.find(row => row.name === '도서관');
      const correction = await f.r.api.addWorldManagerCorrection({anchorTurn: 5,
        target: {domain: 'world'}, patch: {world: [{id: library.id,
          set: {doorStatus: '잠겼다'}}]}});
      assert.equal(correction.ok, true, `${mode}: target user correction commits`);
      const correctedView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(correctedView.head?.world?.find(row => row.id === library.id)
        ?.state?.doorStatus, '잠겼다',
      `${mode}: the target correction supersedes both predecessor values`);
      assert.deepEqual(Array.from((correctedView.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus'), row => row.disposition),
      ['corrected', 'corrected'],
      `${mode}: both predecessor decisions explain the target correction`);
      assert.equal((await f.r.api.setWorldManagerCorrectionStatus(
        correction.correction.correctionId, 'suspended')).ok, true);
      f = await fx.restart();
      assert.equal((await f.r.api.debugLoadContinuityStateForResponse()).head?.world
        ?.find(row => row.name === '도서관')?.state?.doorStatus, '닫혔다',
      `${mode}: the second predecessor stays current after restart`);
      bridge = f.r.context.__fixtureStorageBridge;
      for (const sourceIndex of [0, 1]) {
        currentChatIndex = sourceIndex;
        assert.equal((await f.r.api.getHostLineageStatus()).scopeKey,
          scopes[sourceIndex], `${mode}: deletion selects the original source scope`);
        const deleted = await f.r.api.deleteLibraScope();
        assert.equal(deleted === true || deleted?.verified === true, true,
          `${mode}: source ${sourceIndex} owner deletion is verified`);
        const prefix = `libra:v1:scope:${scopes[sourceIndex]}:`;
        if (mode === 'plugin_only') assert.equal(
          [...fx.local.keys()].some(key => key.startsWith(prefix)), false,
          `${mode}: source ${sourceIndex} plugin owner rows are gone`);
        else assert.equal(fx.storedRows().some(row => row.key.startsWith(prefix)), false,
          `${mode}: source ${sourceIndex} server owner rows are gone`);
        f = await fx.restart();
        bridge = f.r.context.__fixtureStorageBridge;
        await f.r.api.getLibraMemorySettings();
        if (mode !== 'plugin_only') assert.equal(
          fx.storedRows().some(row => row.key.startsWith(prefix)), false,
          `${mode}: restart does not reupload source ${sourceIndex} owner rows`);
      }
      currentChatIndex = 2;
      const afterOwnerRemoval = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(afterOwnerRemoval.head?.world?.find(row => row.name === '도서관')
        ?.state?.doorStatus, '닫혔다',
      `${mode}: the target keeps the latest predecessor State after both source owners are removed`);
      assert.deepEqual(Array.from((afterOwnerRemoval.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus'), row => row.disposition),
      ['corrected', 'still_current'],
      `${mode}: the target still cites both predecessor decisions without source owner storage`);
      const parentLineage = await f.r.api.getHostLineageStatus();
      const child = branch(chats[2], 5, 'final-native-branch');
      child.messages = child.message;
      chats.unshift(child);
      currentChatIndex = 0;
      const childScopeBeforeCopy = await f.r.api.getHostLineageStatus();
      if (mode === 'mirror') {
        let archiveWrites = 0;
        const childArchivePrefix = `libra:v1:scope:${childScopeBeforeCopy.scopeKey}:micro-handoff-archive:`;
        fx.hooks.beforeServerRequest = async (url, request) => {
          const key = String(JSON.parse(request.body || '{}').key || '');
          if (url.endsWith('/v1/kv/set') && key.startsWith(childArchivePrefix)) {
            archiveWrites += 1;
            if (archiveWrites === 2) throw new Error('injected native branch second archive write failure');
          }
        };
        let failedCopy = null;
        try { failedCopy = await f.r.api.debugNativeChatCopy({force: true}); }
        catch (error) { failedCopy = {error: String(error?.message || error)}; }
        fx.hooks.beforeServerRequest = null;
        assert.equal(archiveWrites, 2, 'native branch fault reaches the second inherited archive');
        assert.notEqual(failedCopy?.result?.ok, true,
          'native branch cannot report success after a partial archive copy');
        assert.equal([...fx.local.keys()].some(key => key.startsWith(childArchivePrefix)), false,
          'failed native branch rolls back local inherited Micro archives');
        assert.equal(fx.storedRows().some(row => row.key.startsWith(childArchivePrefix)), false,
          'failed native branch rolls back server inherited Micro archives');
        const failedManifestKey = `libra:v1:scope:${childScopeBeforeCopy.scopeKey}:manifest`;
        const failedManifestRaw = fx.local.get(failedManifestKey);
        const failedManifest = failedManifestRaw ? JSON.parse(failedManifestRaw)
          : fx.storedRows().find(row => row.key === failedManifestKey)?.value;
        assert.equal((failedManifest?.inheritedMicroArchives || []).length, 0,
          'failed native branch publishes no inherited Micro references');
        assert.notEqual(failedManifest?.nativeChatCopy?.durableVerified, true,
          'failed native branch publishes no verified copy marker');
      }
      const copied = await f.r.api.debugNativeChatCopy({force: true});
      assert.equal(copied.result?.ok, true,
        `${mode}: verified native branch copies the final target: ${JSON.stringify(copied)}`);
      const childLineage = await f.r.api.getHostLineageStatus();
      assert.notEqual(childLineage.worldlineMeta?.worldlineId,
        parentLineage.worldlineMeta?.worldlineId);
      assert.equal(childLineage.worldlineMeta?.parentWorldlineId,
        parentLineage.worldlineMeta?.worldlineId,
      `${mode}: native branch keeps its distinct host worldline ancestry`);
      const childManifestKey = `libra:v1:scope:${childLineage.scopeKey}:manifest`;
      const childManifestRaw = fx.local.get(childManifestKey);
      const childManifest = childManifestRaw ? JSON.parse(childManifestRaw)
        : fx.storedRows().find(row => row.key === childManifestKey)?.value;
      assert.equal(childManifest?.inheritedMicroArchives?.length, 2,
        `${mode}: native branch retains both inherited Micro archives`);
      assert.equal(childManifest?.nativeChatCopy?.expectedInheritedMicroArchives, 2,
        `${mode}: completion receipt counts inherited Micro archives`);
      assert.equal(childManifest?.nativeChatCopy?.verifiedInheritedMicroArchives, 2,
        `${mode}: completion receipt verifies inherited Micro archives`);
      assert.equal(childManifest?.nativeChatCopy?.expectedInheritedMicroRefsDigest,
        childManifest?.nativeChatCopy?.verifiedInheritedMicroRefsDigest,
      `${mode}: completion receipt binds the copied archive references`);
      for (const ref of childManifest.inheritedMicroArchives) {
        assert.ok(ref.archiveKey.startsWith(`libra:v1:scope:${childLineage.scopeKey}:micro-handoff-archive:`),
          `${mode}: copied archive belongs to the child scope`);
        const raw = fx.local.get(ref.archiveKey);
        const archive = raw ? JSON.parse(raw)
          : fx.storedRows().find(row => row.key === ref.archiveKey)?.value;
        assert.equal(archive?.archiveDigest, ref.archiveDigest,
          `${mode}: copied archive bytes are independently readable`);
      }
      const rebuilt = await f.r.api.rebuildWorldManagerState();
      assert.equal(rebuilt.ok, true,
        `${mode}: branch rebuilds its own State basis: ${JSON.stringify(rebuilt)}`);
      const branchView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(branchView.head?.world?.find(row => row.name === '도서관')
        ?.state?.doorStatus, '닫혔다',
      `${mode}: branch re-admits the latest inherited Micro on its own basis`);
      assert.deepEqual(Array.from((branchView.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus'), row => row.disposition),
      ['corrected', 'still_current'],
      `${mode}: branch preserves the predecessor order under a new worldline`);
      await produceT6(0, '잠겼다');
      const childEnvelope = await retryBusy(() =>
        f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope());
      const descendant = chats[4];
      const descendantIndex = chats.length - 1;
      currentChatIndex = descendantIndex;
      assert.equal((await f.r.api.getHostLineageStatus()).scopeKey, descendantScopeKey,
        `${mode}: second transfer selects its preconfigured destination`);
      if (mode === 'mirror') {
        let archiveWrites = 0;
        const descendantArchivePrefix = `libra:v1:scope:${descendantScopeKey}:micro-handoff-archive:`;
        fx.hooks.beforeServerRequest = async (url, request) => {
          const key = String(JSON.parse(request.body || '{}').key || '');
          if (url.endsWith('/v1/kv/set') && key.startsWith(descendantArchivePrefix)) {
            archiveWrites += 1;
            if (archiveWrites === 2) throw new Error('injected second-transfer archive write failure');
          }
        };
        await assert.rejects(() => retryBusy(() =>
          f.r.context.__LIBRAPortableMemoryBackup.importAsPredecessorArchive(childEnvelope)));
        fx.hooks.beforeServerRequest = null;
        assert.equal(archiveWrites, 2,
          'second transfer fault reaches an inherited archive after the first write');
        assert.equal([...fx.local.keys()].some(key => key.startsWith(descendantArchivePrefix)), false,
          'failed second transfer removes its local Micro archives');
        assert.equal(fx.storedRows().some(row => row.key.startsWith(descendantArchivePrefix)), false,
          'failed second transfer removes its server Micro archives');
        const failedManifestKey = `libra:v1:scope:${descendantScopeKey}:manifest`;
        const failedManifestRaw = fx.local.get(failedManifestKey);
        const failedManifest = failedManifestRaw ? JSON.parse(failedManifestRaw)
          : fx.storedRows().find(row => row.key === failedManifestKey)?.value;
        assert.equal((failedManifest?.inheritedMicroArchives || []).length, 0,
          'failed second transfer publishes no archive refs');
        assert.equal((failedManifest?.portableImports || [])
          .some(row => row.verified === true && row.durable === true), false,
          'failed second transfer publishes no success receipt');
      }
      assert.equal((await retryBusy(() =>
        f.r.context.__LIBRAPortableMemoryBackup.importAsPredecessorArchive(childEnvelope))).ok,
      true, `${mode}: branch history can move to a new chat`);
      f = await fx.restart();
      bridge = f.r.context.__fixtureStorageBridge;
      descendant.message.push(...sourceRows('descendant'));
      descendant.messages = descendant.message;
      setCanonicalProvider();
      assert.equal((await f.run()).completed, 1,
        `${mode}: descendant commits its own Canonical after branch import`);
      const descendantManifestKey = `libra:v1:scope:${descendantScopeKey}:manifest`;
      const descendantManifestRaw = fx.local.get(descendantManifestKey);
      const descendantManifest = descendantManifestRaw ? JSON.parse(descendantManifestRaw)
        : fx.storedRows().find(row => row.key === descendantManifestKey)?.value;
      const originalArchiveRefs = (descendantManifest?.inheritedMicroArchives || [])
        .filter(ref => [scopes[0], scopes[1]].includes(ref.sourceScopeKey));
      assert.deepEqual(Array.from(originalArchiveRefs, ref => Number(ref.sessionEpoch)), [-3, -2],
        `${mode}: second transfer rebases both original predecessor epochs`);
      const descendantMode = await bridge.getScopeMode({scopeId: descendantScopeKey,
        scopeKey: descendantScopeKey, characterId: character.id, chatId: descendant.id});
      assert.equal(descendantMode?.mode, mode,
        `${mode}: deleting predecessor scopes preserves the live descendant's storage mode`);
      for (const ref of originalArchiveRefs) {
        const localRaw = fx.local.get(ref.archiveKey);
        const remote = fx.storedRows().find(row => row.key === ref.archiveKey)?.value;
        const archive = descendantMode.mode === 'server_only' ? remote : JSON.parse(localRaw);
        if (mode === 'mirror') assert.deepEqual(remote, archive,
          `${mode}: re-transferred archive agrees across local and server storage`);
        assert.equal(archive?.archiveDigest, ref.archiveDigest,
          `${mode}: re-transferred archive has its sealed physical body`);
        const revisions = (archive.records || []).filter(row =>
          row.value?.schema === 'libra.micro_memory.v1' && Number(row.value.turn) === 6);
        assert.ok(revisions.length >= 2,
          `${mode}: re-transfer keeps the old and edited T6 Micro records`);
        const head = (archive.records || []).find(row => row.value?.schema === 'libra.micro_memory_head.v1'
          && Number(row.value.turn) === 6)?.value;
        const activeRecord = revisions.find(row => row.key === head?.recordKey)?.value;
        assert.equal(activeRecord?.claims?.[0]?.stateIntent?.value,
          ref.sourceScopeKey === scopes[0] ? '열렸다' : '닫혔다',
          `${mode}: only the edited source revision remains active in the archive`);
      }
      assert.ok((descendantManifest?.inheritedMicroArchives || []).some(ref =>
        ref.sourceScopeKey === childLineage.scopeKey && Number(ref.sessionEpoch) === -1),
      `${mode}: second transfer retains the child's new-worldline Micro event`);
      await waitFor(async () => ((await f.r.api.debugLoadContinuityStateForResponse())
        .authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus').length === 3);
      const descendantView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(descendantView.head?.world?.find(row => row.name === '도서관')
        ?.state?.doorStatus, '잠겼다',
      `${mode}: second transfer re-admits the child's newer worldline change`);
      assert.deepEqual(Array.from((descendantView.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus'), row => row.disposition),
      ['corrected', 'corrected', 'still_current'],
      `${mode}: second transfer orders both predecessors before the child's new event`);
      for (const {index, scopeKey} of [
        {index: 3, scopeKey: parentLineage.scopeKey},
        {index: 0, scopeKey: childLineage.scopeKey}
      ]) {
        currentChatIndex = index;
        assert.equal((await f.r.api.getHostLineageStatus()).scopeKey, scopeKey,
          `${mode}: owner deletion selects the copied source scope`);
        const deleted = await f.r.api.deleteLibraScope();
        assert.equal(deleted === true || deleted?.verified === true, true,
          `${mode}: copied source owner deletion succeeds`);
        f = await fx.restart();
        bridge = f.r.context.__fixtureStorageBridge;
        if (index === 3) {
          const childStored = mode === 'plugin_only'
            ? JSON.parse(fx.local.get(childManifestKey))
            : fx.storedRows().find(row => row.key === childManifestKey)?.value;
          assert.equal(childStored?.nativeChatCopy?.completenessVersion, 5);
          const beforeRefs = structuredClone(childStored.inheritedMicroArchives);
          const firstArchiveKey = beforeRefs[0].archiveKey;
          const firstArchive = mode === 'plugin_only'
            ? JSON.parse(fx.local.get(firstArchiveKey))
            : fx.storedRows().find(row => row.key === firstArchiveKey)?.value;
          if (mode === 'plugin_only') fx.local.delete(firstArchiveKey);
          else fx.app.repositories.libra.mutate({kind: 'remove', space: 'plugin',
            key: firstArchiveKey, operationId: `fixture_missing_complete_native_archive_${mode}`});
          currentChatIndex = 0;
          f = await fx.restart();
          const damagedCompleteCopy = await f.r.api.debugNativeChatCopy({force: true});
          assert.notEqual(damagedCompleteCopy.result?.reason, 'native_copy_already_complete',
            `${mode}: a v5 completion marker cannot mask a missing inherited archive`);
          assert.notEqual(damagedCompleteCopy.result?.ok, true,
            `${mode}: a missing archive invalidates native-copy completeness`);
          if (mode === 'plugin_only') fx.local.set(firstArchiveKey, JSON.stringify(firstArchive));
          else fx.app.repositories.libra.mutate({kind: 'set', space: 'plugin',
            key: firstArchiveKey, value: JSON.stringify(firstArchive),
            operationId: `fixture_restore_complete_native_archive_${mode}`});
          f = await fx.restart();
          const legacyReceipt = structuredClone(childStored);
          legacyReceipt.nativeChatCopy.completenessVersion = 4;
          delete legacyReceipt.nativeChatCopy.expectedInheritedMicroArchives;
          delete legacyReceipt.nativeChatCopy.verifiedInheritedMicroArchives;
          delete legacyReceipt.nativeChatCopy.expectedInheritedMicroRefsDigest;
          delete legacyReceipt.nativeChatCopy.verifiedInheritedMicroRefsDigest;
          if (mode === 'plugin_only') fx.local.set(childManifestKey, JSON.stringify(legacyReceipt));
          else fx.app.repositories.libra.mutate({kind: 'set', space: 'plugin',
            key: childManifestKey, value: JSON.stringify(legacyReceipt),
            operationId: `fixture_old_native_receipt_${mode}`});
          const missingArchiveKey = beforeRefs[0].archiveKey;
          const survivingArchiveKey = beforeRefs[1].archiveKey;
          const survivingArchive = mode === 'plugin_only'
            ? JSON.parse(fx.local.get(survivingArchiveKey))
            : fx.storedRows().find(row => row.key === survivingArchiveKey)?.value;
          if (mode === 'plugin_only') fx.local.delete(missingArchiveKey);
          else fx.app.repositories.libra.mutate({kind: 'remove', space: 'plugin',
            key: missingArchiveKey, operationId: `fixture_missing_native_archive_${mode}`});
          currentChatIndex = 0;
          f = await fx.restart();
          const oldCopy = await f.r.api.debugNativeChatCopy({force: true});
          assert.notEqual(oldCopy.result?.ok, true,
            `${mode}: an old completion marker cannot certify missing-source Micro closure`);
          assert.equal(oldCopy.result?.reason, 'copy_source_not_found',
            `${mode}: unavailable source is reported explicitly: ${JSON.stringify(oldCopy)}`);
          const after = mode === 'plugin_only'
            ? JSON.parse(fx.local.get(childManifestKey))
            : fx.storedRows().find(row => row.key === childManifestKey)?.value;
          assert.equal(after?.nativeChatCopy?.completenessVersion, 4,
            `${mode}: failed revalidation leaves the old receipt unpromoted`);
          assert.deepEqual(after.inheritedMicroArchives, beforeRefs,
            `${mode}: unavailable source does not rewrite surviving Micro archives`);
          assert.equal(mode === 'plugin_only' ? fx.local.has(missingArchiveKey)
            : fx.storedRows().some(row => row.key === missingArchiveKey), false,
          `${mode}: unavailable source does not fabricate the missing archive`);
          const remainingArchive = mode === 'plugin_only'
            ? JSON.parse(fx.local.get(survivingArchiveKey))
            : fx.storedRows().find(row => row.key === survivingArchiveKey)?.value;
          assert.deepEqual(remainingArchive, survivingArchive,
            `${mode}: failed recovery preserves the independently readable archive`);
          if (mode !== 'plugin_only') {
            const adminHeaders={Authorization:`Bearer ${fx.app.token}`,
              'X-Memory-Suite-Admin':'1','Content-Type':'application/json'};
            const repair=async(action,body)=>{
              const response=await fetch(`${fx.url}/v1/admin/libra/native-archive-repair/${action}`,
                {method:'POST',headers:adminHeaders,body:JSON.stringify(body)});
              return {status:response.status,body:await response.json()};
            };
            const plan=await repair('plan',{backupId:deleted.backupId,
              targetScopeKey:childLineage.scopeKey,targetArchiveKey:missingArchiveKey});
            assert.equal(plan.status,200,`${mode}: selective backup plan: ${JSON.stringify(plan.body)}`);
            const restored=await repair('execute',{planId:plan.body.result.planId,
              fingerprint:plan.body.result.fingerprint});
            assert.equal(restored.status,200,`${mode}: selective backup repair: ${JSON.stringify(restored.body)}`);
            assert.equal(restored.body.result?.physicalReadback,true);
            assert.equal(restored.body.result?.nativeCopyCompleteness,'pending_revalidation');
            const sourceBeforeDeletion=fx.app.listBackups().find(item=>item.id===deleted.backupId);
            assert.ok(sourceBeforeDeletion,`${mode}: deletion backup remains addressable`);
            const recovered=fx.storedRows().find(row=>row.key===missingArchiveKey)?.value;
            assert.equal(recovered?.archiveDigest,beforeRefs[0].archiveDigest,
              `${mode}: only the expected archived body is recovered`);
            assert.deepEqual(fx.storedRows().find(row=>row.key===survivingArchiveKey)?.value,
              survivingArchive,`${mode}: selective repair preserves the other archive`);
            assert.equal(fx.storedRows().find(row=>row.key===childManifestKey)?.value
              ?.nativeChatCopy?.completenessVersion,4,
              `${mode}: restoring bytes does not silently promote the old copy receipt`);
            currentChatIndex=0;
            f=await fx.restart();
            const repairedView=await f.r.api.debugLoadContinuityStateForResponse();
            assert.equal(repairedView.head?.world?.find(row=>row.name==='도서관')
              ?.state?.doorStatus,'잠겼다',
              `${mode}: the child's newer event remains current after archive repair`);
            const repairedTransitions=(repairedView.authority?.microProjection?.transitions||[])
              .filter(row=>row.turn===6&&row.field==='doorStatus');
            assert.equal(repairedTransitions.filter(row=>row.disposition==='still_current').length,1,
              `${mode}: the child has one current state transition`);
            assert.deepEqual(Array.from(repairedTransitions.filter(row=>Number(row.sessionEpoch)<0)
              .sort((a,b)=>Number(a.sessionEpoch)-Number(b.sessionEpoch)),
              row=>[Number(row.sessionEpoch),String(row.disposition)]),
            [[-2,'corrected'],[-1,'corrected']],
            `${mode}: both restored predecessor epochs remain visible and corrected`);
          }
        }
      }
      currentChatIndex = descendantIndex;
      const afterSecondOwnerRemoval = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(afterSecondOwnerRemoval.head?.world?.find(row => row.name === '도서관')
        ?.state?.doorStatus, '잠겼다',
      `${mode}: second transfer survives native parent and child owner deletion`);
      assert.deepEqual(Array.from((afterSecondOwnerRemoval.authority?.microProjection?.transitions || [])
        .filter(row => row.turn === 6 && row.field === 'doorStatus'), row => row.disposition),
      ['corrected', 'corrected', 'still_current'],
      `${mode}: second transfer retains its decisions after owner deletion and restart`);
      console.log(`PASS Micro multi-predecessor State in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
