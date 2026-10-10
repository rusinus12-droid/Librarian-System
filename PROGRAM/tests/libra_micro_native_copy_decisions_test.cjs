'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {clone, parent, branch, character} = require('./fixtures/native_branch_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const rowsFrom = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    const root = parent(`decision-parent-${mode}`, 1);
    root.message[1].data = '민아가 도서관 전체는 정숙 구역이라고 말했다.';
    const char = character([root]);
    let current = root, listener, api, calls = 0;
    const host = {
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => char.chats.indexOf(current),
      getCharacter: async () => clone(char),
      getCharacterFromIndex: async () => clone(char),
      getChat: async () => clone(current),
      getCurrentChat: async () => clone(current),
      getChatFromIndex: async (_ci, i) => clone(char.chats[i]),
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [clone(char)], plugins: []};
        return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
      runLLMModel: async () => {
        calls += 1;
        const source = await api.debugReadActiveCompletedTurnReceipt(1);
        const receipt = source.receipt;
        const quote = '도서관 전체는 정숙 구역';
        const text = receipt.assistant.text;
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [{role: 'assistant', startOffset: 0,
            endOffset: 2, exactQuote: '민아', name: '민아', personType: 'person'}], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 1, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'event', text: `${quote}이다.`, actor: '', target: '',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'narrative',
                target: {scope: 'current_narrative'}, field: 'summary', operation: 'set', value: quote},
              evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: text.indexOf(quote), endOffset: text.indexOf(quote) + quote.length,
                exactQuote: quote}}]}
        })};
      }
    };
    const fx = await serverFixture({mode, host,
      transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
        '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      api = fx.f.r.api;
      const rows = () => mode === 'server_only' ? fx.storedRows() : rowsFrom(fx.local);
      const proof = await api.getHostLineageStatus();
      assert.ok(proof.scopeKey);
      const scope = {scopeId: proof.scopeKey, scopeKey: proof.scopeKey,
        characterId: char.id, chatId: root.id, aliases: [proof.scopeKey, root.id], label: root.id};
      await fx.f.r.context.__fixtureStorageBridge.setScopeMode(scope, mode);
      listener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      try {
        await waitFor(() => rows().filter(row => row.value?.schema === 'libra.micro_state_admission.v1').length >= 1, 15000);
      } catch (error) {
        throw new Error(`${mode}: ${error.message}; calls=${calls}; publication=${JSON.stringify(api.getCaptureBackendState().lastMicroPublication)}; serverRows=${fx.storedRows().length}; localRows=${rowsFrom(fx.local).length}; backend=${JSON.stringify(api.getCaptureBackendState())}; schemas=${JSON.stringify(rows().map(row => row.value?.schema).filter(Boolean).slice(-15))}`);
      }
      const first = await api.debugReadActiveMicroMemory(1);
      assert.equal(first.status, 'verified');
      root.message[1].data += ' 방문객에게 안내했다.';
      listener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => rows().filter(row => row.value?.schema === 'libra.micro_state_admission.v1').length >= 2, 15000);
      const second = await api.debugReadActiveMicroMemory(1);
      assert.equal(second.status, 'verified');
      assert.notEqual(second.recordKey, first.recordKey);
      const sourceDecisions = rows().filter(row => row.value?.schema === 'libra.micro_state_admission.v1'
        && row.value.scopeKey === second.record.scopeKey);
      assert.equal(sourceDecisions.length, 2);
      const sourceInventories = rows().filter(row => row.value?.schema === 'libra.person_span_inventory.v1'
        && row.value.scopeKey === second.record.scopeKey
        && row.value.status === 'classified_candidates');
      assert.equal(sourceInventories.length, 2);
      assert.equal(sourceInventories[0].value.spans.at(-1)?.exactQuote, '민아');
      const child = branch(root, 1, `decision-child-${mode}`);
      char.chats.unshift(child);
      current = child;
      const beforeCopyCalls = calls;
      const copy = await api.debugNativeChatCopy({force: true});
      assert.equal(copy.result?.ok, true, `${mode}: ${JSON.stringify(copy)}`);
      assert.equal(calls, beforeCopyCalls, `${mode}: transfer does not rerun provider`);
      const active = await api.debugReadActiveMicroMemory(1);
      assert.equal(active.status, 'verified');
      assert.equal(active.record.analysisStatus, 'verified');
      const targetDecisions = rows().filter(row => row.value?.schema === 'libra.micro_state_admission.v1'
        && row.value.scopeKey === active.record.scopeKey);
      assert.equal(targetDecisions.length, sourceDecisions.length,
        `${mode}: both decisions survive as distinct provenance`);
      const targetInventory = rows().filter(row => row.value?.schema === 'libra.person_span_inventory.v1'
        && row.value.scopeKey === active.record.scopeKey
        && row.value.status === 'classified_candidates');
      assert.equal(targetInventory.length, 2, `${mode}: classified person spans survive both revisions`);
      assert.equal(targetInventory[0].value.spans.at(-1)?.exactQuote, '민아');
      assert.equal(targetInventory[0].value.spans.at(-1)?.receiptKey.includes(
        `:scope:${active.record.scopeKey}:`), true);
      for (const {value} of targetDecisions) {
        assert.equal(value.scopeKey, active.record.scopeKey);
        assert.ok(value.microRecordKey.includes(`:scope:${active.record.scopeKey}:micro-memory:`));
        assert.equal(value.status, 'pending', `${mode}: old State basis cannot authorize child State`);
        assert.equal(value.reason, 'native_copy_basis_reassessment_required');
        assert.ok(sourceDecisions.some(row => row.value.decisionDigest
          === value.nativeCopySourceDecision?.decisionDigest));
      }
      const projected = await api.debugLoadContinuityStateForResponse();
      assert.notEqual(projected.head?.narrative?.summary, '도서관 전체는 정숙 구역',
        `${mode}: parent admission is not silently projected into child`);
      const restarted = await fx.restart();
      assert.equal((await restarted.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
      assert.equal(rows().filter(row => row.value?.schema === 'libra.micro_state_admission.v1'
        && row.value.scopeKey === active.record.scopeKey).length, 2);
      const sourceOwnerRowsBeforeDelete = rows().filter(row => row.key.includes(
        `:scope:${second.record.scopeKey}:`)).length;
      const targetOwnerRowsBeforeDelete = rows().filter(row => row.key.includes(
        `:scope:${active.record.scopeKey}:`)).length;
      const serverTargetBeforeDelete = fx.storedRows().filter(row => row.key.includes(
        `:scope:${active.record.scopeKey}:`));
      assert.ok(sourceOwnerRowsBeforeDelete > 0 && targetOwnerRowsBeforeDelete > 0);
      if (mode === 'mirror') {
        let blockedWrites = 0;
        fx.hooks.beforeServerRequest = async (_url, init) => {
          const body = String(init?.body || '');
          if (body.includes('scope-registry:v1') && body.includes('nativeCopySuppressed')) {
            blockedWrites += 1;
            throw new Error('fixture_scope_registry_server_write_blocked');
          }
        };
        await assert.rejects(() => restarted.r.api.deleteLibraScope(),
          /LIBRA_VERIFIED_STORAGE|fixture_scope_registry_server_write_blocked/,
          'one-sided suppression must abort deletion before touching Micro records');
        fx.hooks.beforeServerRequest = null;
        assert.ok(blockedWrites > 0);
        assert.equal(fx.storedRows().filter(row => row.key.includes(
          `:scope:${active.record.scopeKey}:`)).length, targetOwnerRowsBeforeDelete);
        assert.equal(rowsFrom(fx.local).filter(row => row.key.includes(
          `:scope:${active.record.scopeKey}:`)).length, targetOwnerRowsBeforeDelete);
      }
      const deleted = await restarted.r.api.deleteLibraScope();
      assert.equal(deleted === true || deleted?.verified === true, true,
        `${mode}: scope delete reports completion only after owner records are gone`);
      const registryKey = 'libra:v1:scope-registry:v1';
      const entryId = `${char.id}::${child.id}`;
      const localRegistry = rowsFrom(fx.local).find(row => row.key === registryKey)?.value;
      assert.equal(localRegistry?.[entryId]?.nativeCopySuppressed, true,
        `${mode}: local native-copy gate prevents automatic recreation`);
      if (mode !== 'plugin_only') {
        const serverRegistry = fx.storedRows().find(row => row.key === registryKey)?.value;
        assert.equal(serverRegistry?.[entryId]?.nativeCopySuppressed, true,
          `${mode}: durable server gate prevents another client from recreating the deleted scope`);
      }
      if (mode === 'plugin_only') {
        assert.equal(rowsFrom(fx.local).filter(row => row.key.includes(
          `:scope:${active.record.scopeKey}:`)).length, 0);
      } else {
        assert.equal(fx.storedRows().filter(row => row.key.includes(
          `:scope:${active.record.scopeKey}:`)).length, 0,
        `${mode}: server owner records are physically deleted`);
        assert.ok(deleted.backupId && deleted.reloadRequired,
          `${mode}: deletion has a server backup and reload fence`);
        const backup = fx.app.listBackups().find(item => item.id === deleted.backupId);
        assert.ok(backup?.stores?.libra?.file,
          `${mode}: the reported backup exists on disk`);
        const backupDb = new DatabaseSync(path.join(backup.path, backup.stores.libra.file),
          {readOnly: true});
        try {
          const backed = backupDb.prepare('SELECT key,value_json,deleted FROM kv WHERE key LIKE ?')
            .all(`libra:v1:scope:${active.record.scopeKey}:%`)
            .filter(row => row.deleted === 0);
          assert.deepEqual(backed.map(row => [row.key, JSON.parse(row.value_json)]).sort(),
            serverTargetBeforeDelete.map(row => [row.key, row.raw]).sort(),
            `${mode}: backup physically preserves the whole active and historical Micro graph`);
        } finally { backupDb.close(); }
        if (mode === 'mirror') {
          assert.equal(rowsFrom(fx.local).filter(row => row.key.includes(
            `:scope:${active.record.scopeKey}:`)).length, targetOwnerRowsBeforeDelete,
          'mirror local copy is retained behind the server-reset fence');
        }
      }
      const sourceAfterDelete = mode === 'plugin_only' ? rowsFrom(fx.local) : fx.storedRows();
      assert.equal(sourceAfterDelete.filter(row => row.key.includes(
        `:scope:${second.record.scopeKey}:`)).length, sourceOwnerRowsBeforeDelete,
      `${mode}: source scope remains physically unchanged`);
      if (mode !== 'plugin_only') {
        const fresh = await fx.restart();
        await fresh.r.api.getLibraMemorySettings();
        assert.equal(fx.storedRows().filter(row => row.key.includes(
          `:scope:${active.record.scopeKey}:`)).length, 0,
        `${mode}: restart does not reupload the deleted Micro graph`);
      }
      console.log(`PASS native copy preserves historical decisions without adopting old State basis in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
