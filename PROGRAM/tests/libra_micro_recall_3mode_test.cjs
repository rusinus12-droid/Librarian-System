'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const {settleStorage} = require('./fixtures/libra_storage_quiesce.cjs');

const quote = '도서관 전체는 정숙 구역';
const duplicateQuote = '준호가 지호에게서 열쇠를 받아 들었다.';
(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async args => {
        const input = JSON.parse(args[0].messages[1].content);
        const startOffset = input.assistant.text.indexOf(quote);
        assert.ok(startOffset >= 0);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [{changeKind: 'world', text: `${quote}이다.`, actor: '', target: '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'none', evidence: {role: 'assistant', messageId: input.assistant.messageId,
                startOffset, endOffset: startOffset + quote.length, exactQuote: quote}}]}
        })};
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
      await settleStorage(fx);
      const published = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(published.status, 'verified');
      assert.equal(published.head.recallProjection?.schema, 'libra.micro_recall_projection.v1',
        `${mode}: active Micro head carries a reusable, versioned Recall entry`);
      assert.ok(published.head.recallProjection.searchText.includes(quote),
        `${mode}: durable Recall entry preserves the source-bound detail`);
      const originalGetItem = fx.backend.getItem;
      let microRecordReads = 0;
      if (mode === 'plugin_only') fx.backend.getItem = async key => {
        if (key === published.recordKey) microRecordReads += 1;
        return originalGetItem(key);
      };
      const recall = await f.r.api.previewUnifiedMemoryRecall(quote);
      fx.backend.getItem = originalGetItem;
      // The unified engine reads the persisted head projection through its owner graph and
      // hydrates the selected Micro record from the immutable owner record (possibly per page).
      if (mode === 'plugin_only') assert.ok(microRecordReads >= 1,
        'the unified engine hydrates the selected Micro record from its immutable owner record');
      const selected = Array.from(recall.memories || []);
      assert.ok(selected.some(row => row.memory?.kind === 'micro'
        && String(row.excerpt?.text || row.excerpt || row.text || '').includes(quote)),
      `${mode}: a durable T1 Micro is recallable without a Canonical or embedding`);
      assert.ok(recall.bundle.items.some(item => item.family === 'micro'
        && item.sourceSpan?.exactQuote === quote && item.sourceSpan?.role === 'assistant'),
      `${mode}: the recalled Micro keeps its exact source span in the evidence bundle`);
      await f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'classic'});
      // The first Classic request of a scope creates its manifest; that storage write revokes the
      // read set it just issued (the hook then fails open), so deliver once and let storage settle.
      await f.control.hooks.beforeRequest([{role: 'user', content: quote}], 'model');
      await settleStorage(fx);
      const delivered = await f.control.hooks.beforeRequest([{role: 'user', content: quote}], 'model');
      assert.ok(delivered.some(row => String(row.content || '').includes(quote)),
        `${mode}: actual Classic response hook receives the grounded Micro detail`);
      const viewer = f.r.api.getLastMemoryRecallViewer();
      assert.ok(viewer?.rows?.some(row => row.kind === 'micro' && row.injected === true
        && row.semanticRole === 'micro_candidate'
        && String(row.selectedText || '').includes(quote)),
      `${mode}: final delivery keeps the Micro role label and selected text`);
      assert.equal(viewer.finalVerification?.status, 'verified',
        `${mode}: the delivered packet is verified against the consumed read set`);
      if (mode === 'plugin_only') {
        const savedHead = fx.local.get(published.headKey);
        const legacyHead = JSON.parse(savedHead);
        delete legacyHead.recallProjection;
        delete legacyHead.recallProjectionDigest;
        fx.local.set(published.headKey, JSON.stringify(legacyHead));
        const legacyRecall = await f.r.api.previewUnifiedMemoryRecall(quote);
        assert.ok(Array.from(legacyRecall.memories || []).some(row => row.memory?.kind === 'micro'),
          'an existing Micro head without a projection remains recallable');
        assert.equal(fx.local.get(published.headKey), JSON.stringify(legacyHead),
          'read-only Recall does not silently rewrite a legacy Micro head');
        fx.local.set(published.headKey, savedHead);
        const originalKeys = fx.backend.keys;
        fx.backend.keys = async () => { throw new Error('controlled_micro_index_read_failure'); };
        const unavailable = await f.r.api.previewUnifiedMemoryRecall(quote);
        fx.backend.keys = originalKeys;
        assert.ok(Array.from(unavailable.memories || []).some(row => row.memory?.kind === 'micro'),
          'a failed key listing still recalls Micro through the unified request-local corpus');
        assert.equal(unavailable.diagnostics?.microRecallIndex, undefined,
          'the retired Micro head corpus diagnostics are no longer produced');
      }
      const active = mode === 'mirror' ? await f.r.api.debugReadActiveMicroMemory(1) : null;
      f.chat.message[1].data += ' 원문 수정.';
      const stale = await f.r.api.previewUnifiedMemoryRecall(quote);
      assert.equal(Array.from(stale.memories || []).some(row => row.memory?.kind === 'micro'), false,
        `${mode}: source edit excludes the old active Micro revision from Recall`);
      if (mode === 'mirror') {
        // The unified engine serves a warm bridge from its volatile common index, so a record removed
        // behind the storage layer is only observable by a bridge that builds its corpus afresh.
        const fresh = await fx.restart();
        const control = await fresh.r.api.previewUnifiedMemoryRecall(quote);
        assert.equal(Array.from(control.memories || []).some(row => row.memory?.kind === 'micro'), true,
          'a fresh mirror bridge recalls the two-sided Micro record');
        const saved = fx.local.get(active.recordKey);
        assert.ok(saved, 'the mirror keeps a plugin-side copy of the Micro record');
        fx.local.delete(active.recordKey);
        const cold = await fx.restart();
        const oneSided = await cold.r.api.previewUnifiedMemoryRecall(quote);
        assert.equal(Array.from(oneSided.memories || []).some(row => row.memory?.kind === 'micro'), false,
          'one-sided mirror Micro record cannot enter Recall');
        assert.equal(fx.local.has(active.recordKey), false,
          'read-only Recall does not silently repair a one-sided source record');
        fx.local.set(active.recordKey, saved);
      }
      console.log(`PASS pre-Canonical Micro Recall in ${mode}`);
    } finally { await fx.cleanup(); }
  }
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx, allMessages = f.chat.message;
      f.chat.message = allMessages.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async args => {
        const messages = args[0].messages;
        if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return {type: 'success', result: JSON.stringify(f.control.artifact)};
        }
        const input = JSON.parse(messages[1].content);
        const value = input.binding.turn === 1 ? quote
          : input.binding.turn === 3 ? duplicateQuote : '';
        if (!value) return {type: 'error', result: 'controlled Micro unavailable'};
        const startOffset = input.assistant.text.indexOf(value);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [{changeKind: input.binding.turn === 3 ? 'event' : 'world',
              text: input.binding.turn === 3 ? value : `${value}이다.`,
              actor: input.binding.turn === 3 ? '준호' : '',
              target: input.binding.turn === 3 ? '열쇠' : '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'none', evidence: {role: 'assistant', messageId: input.assistant.messageId,
                startOffset, endOffset: startOffset + value.length, exactQuote: value}}]}
        })};
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
      f.chat.message = allMessages.slice(0, 6);
      f.chat.messages = f.chat.message;
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 5});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 3, 15000);
      f.chat.message = allMessages;
      f.chat.messages = allMessages;
      await f.run();
      await settleStorage(fx);
      const recall = await f.r.api.previewUnifiedMemoryRecall(quote);
      await f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'classic'});
      await f.control.hooks.beforeRequest([{role: 'user', content: quote}], 'model');
      assert.ok(Array.from(recall.memories || []).some(row => row.memory?.kind === 'micro'
        && row.memory?.turnRange?.start === 1),
      'old T1 Micro detail remains recallable after the T5 Canonical commits');
      const duplicateRecall = await f.r.api.previewUnifiedMemoryRecall(duplicateQuote);
      assert.ok(Array.from(duplicateRecall.memories || []).some(row => row.memory?.kind === 'micro'
        && row.memory?.turnRange?.start === 3), 'the overlapping Micro record remains recallable');
      await settleStorage(fx);
      await f.control.hooks.beforeRequest([{role: 'user', content: duplicateQuote}], 'model');
      const duplicateDelivery = f.r.api.getLastMemoryRecallViewer();
      const repeatedRows = Array.from(duplicateDelivery?.rows || []).filter(row =>
        row.injected && String(row.selectedText || '').includes(duplicateQuote));
      assert.equal(repeatedRows.length, 2,
        'generic Micro event and typed canonical possession remain distinct despite matching text/quote');
      assert.ok(repeatedRows.some(row => row.kind === 'micro') && repeatedRows.some(row => row.kind !== 'micro'),
      'unproven typed correspondence cannot suppress the source-bound Micro claim');
      assert.equal((await f.r.api.debugReadActiveMicroMemory(3)).status, 'verified',
        'deduplication never deletes the durable T3 Micro');
      console.log(`PASS old Micro detail survives Canonical Recall in ${mode}`);
    } finally { await fx.cleanup(); }
  }
  {
    let listener;
    const fx = await serverFixture({mode: 'plugin_only', host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => ({type: 'error', result: 'controlled unavailable provider'});
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
      const active = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(active.record?.analysisStatus, 'minimum_source_bound');
      const recall = await f.r.api.previewUnifiedMemoryRecall(quote);
      assert.ok(Array.from(recall.memories || []).some(row => row.memory?.kind === 'micro'
        && row.memory?.semanticRole === 'source_only'
        && String(row.excerpt?.text || row.excerpt || '').includes(quote)),
      'source-only minimum remains exact/lexical Recall evidence without inferred State');
      console.log('PASS source-only Micro Recall without provider');
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
