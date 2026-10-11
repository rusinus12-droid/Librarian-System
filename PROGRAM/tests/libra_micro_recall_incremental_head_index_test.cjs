'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const sourcePath = path.resolve(__dirname, '../plugins/LIBRA.js'), originalSource = fs.readFileSync(sourcePath, 'utf8');
const {transformSource} = require('./fixtures/libra_micro_head_read_observer.cjs');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

(async () => {
  let listener;
  const fx = await serverFixture({transformSource, mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  try {
    const {f} = fx;
    const allMessages = f.chat.message;
    const quotes = new Map([
      [1, '도서관 전체는 정숙 구역'],
      [2, '민아가 창고 문을 닫았다']
    ]);
    allMessages[3].data = `${quotes.get(2)}.`;
    f.chat.message = allMessages.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const quote = quotes.get(input.binding.turn);
      const startOffset = input.assistant.text.indexOf(quote);
      assert.ok(startOffset >= 0, `T${input.binding.turn} quote binds to source`);
      return {type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1',
        personCandidates: {spans: [], relations: []},
        micro: {schema: 'libra.micro_memory.v1', ...input.binding,
          claims: [{changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관',
            temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
            stateChangeType: 'none', evidence: {role: 'assistant',
              messageId: input.assistant.messageId, startOffset,
              endOffset: startOffset + quote.length, exactQuote: quote}}]}
      })};
    };
    listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
      messageIndex: 1});
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);

    const originalGetItem = fx.backend.getItem;
    let headReads = 0;
    let headReadKeys = [];
    let recordReadKeys = [];
    fx.backend.getItem = async key => {
      if (String(key).includes(':micro-memory-head:')) {
        headReads += 1;
        headReadKeys.push(String(key));
      }
      if (String(key).includes(':micro-memory:')) recordReadKeys.push(String(key));
      return originalGetItem(key);
    };
    const trace = () => Array.from(f.r.context.__MICRO_HEAD_READS__ || [], row => ({...row}));
    const resetTrace = () => { headReads = 0; headReadKeys = []; recordReadKeys = []; f.r.context.__MICRO_HEAD_READS__ = []; };
    const assertTrace = () => { const rows = trace(); assert.equal(rows.length, headReads, 'every actual backend head read has an observed phase'); assert.deepEqual(rows.map(row => row.headKey).sort(), [...headReadKeys].sort()); return rows; };
    const publicSelected = recall => Array.from(recall.memories || []).filter(row => row.memory?.kind === 'micro').map(row => ({memoryId:row.memory.memoryId, turn:row.memory.turnRange?.start}));
    const assertPairedHeads = rows => {
      const hydration = rows.filter(row => row.phase === 'hydration'), rereads = rows.filter(row => row.phase === 'physical-reread');
      assert.deepEqual(hydration.map(row => row.headKey).sort(), rereads.map(row => row.headKey).sort(), 'each hydrated physical head has exactly one matching final reread');
      const identities = hydration.map(row => { const head = JSON.parse(fx.local.get(row.headKey)); return {headKey:row.headKey,recordKey:head.recordKey,analysisRevisionId:head.analysisRevisionId,turn:head.turn}; });
      assert.deepEqual(identities.map(row => row.recordKey).sort(), [...recordReadKeys].sort(), 'hydrated identities match actual physical record reads');
      return identities;
    };
    const selectedTurn = (recall, turn) => Array.from(recall.memories || [])
      .some(row => row.memory?.kind === 'micro' && row.memory?.turnRange?.start === turn);
    try {
      resetTrace();
      const warm = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
      assert.equal(selectedTurn(warm, 1), true, 'first Recall finds the durable T1 Micro');
      const firstReads = headReads;
      const firstTrace = assertTrace();
      assert.deepEqual(firstTrace.map(row => row.phase), ['catalog', 'hydration', 'physical-reread']);
      assert.ok(firstTrace.every(row => row.headKey.endsWith(':t1')));
      resetTrace();
      const steady = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
      assert.equal(selectedTurn(steady, 1), true, 'steady Recall keeps the same result');
      assert.ok(firstReads >= 2, `cold Recall includes catalog and hydration reads: ${firstReads}`);
      assert.equal(headReads, 2, 'steady selected T1 needs hydration and final physical reread');
      const steadyTrace = assertTrace();
      assert.deepEqual(steadyTrace.map(row => row.phase), ['hydration', 'physical-reread']);
      assert.equal(new Set(steadyTrace.map(row => row.headKey)).size, 1, 'both reads belong only to selected T1');
      assert.ok(steadyTrace.every(row => row.headKey.endsWith(':t1')));

      f.chat.message = allMessages.slice(0, 4);
      f.chat.messages = f.chat.message;
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
        messageIndex: 3});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 2, 15000);
      resetTrace();
      const changed = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(changed, 2), true,
        'a newly published T2 enters Recall without restarting or a full head scan');
      const changedTrace = assertTrace();
      const changedHydrated = assertPairedHeads(changedTrace), changedPublicSelected = publicSelected(changed);
      console.log('OBSERVE actual T2 incremental head reads', JSON.stringify({headReads, changedTrace, changedHydrated, changedPublicSelected}));
      assert.ok(changedTrace.filter(row => row.phase === 'catalog').length <= 1, 'incremental catalog reads only new T2');
      assert.ok(changedTrace.filter(row => row.phase === 'catalog').every(row => row.headKey.endsWith(':t2')));
      assert.ok(changedTrace.filter(row => row.phase === 'hydration').length >= 1);
      assert.equal(changedTrace.filter(row => row.phase === 'physical-reread').length, changedTrace.filter(row => row.phase === 'hydration').length);
      assert.deepEqual(changedHydrated.map(row => row.turn).sort(), [1,2], 'incremental shortlist hydrates the two actually published records');
      const finalRereads = changedTrace.filter(row => row.phase === 'physical-reread').length;
      assert.equal(finalRereads, 2);
      assert.ok(headReads - finalRereads <= 3, 'original catalog plus hydration bound remains3 after accounting only proven final rereads');
      assert.equal(headReads, 5, 'one new T2 catalog read plus paired physical reads for each of two shortlisted records');

      // Synthetic catalog pressure only: these extra heads are never source
      // evidence. T1/T2 above are genuinely published and hydrated.
      const t1HeadKey = [...fx.local.keys()].find(key =>
        String(key).includes(':micro-memory-head:') && String(key).endsWith(':t1'));
      const t1Head = JSON.parse(fx.local.get(t1HeadKey));
      const longChat = allMessages.slice(0, 4);
      for (let turn = 3; turn <= 64; turn++) {
        const user = {...allMessages[2], chatId: `synthetic-t${turn}-u`};
        const assistant = {...allMessages[3], chatId: `synthetic-t${turn}-a`};
        user.data = `합성 사용자 ${turn}`;
        assistant.data = `합성 응답 ${turn}`;
        longChat.push(user, assistant);
        const headKey = t1HeadKey.replace(/:t1$/, `:t${turn}`);
        const recordKey = t1Head.recordKey.replace(/:t1:/, `:t${turn}:`);
        fx.local.set(recordKey, JSON.stringify({schema: 'synthetic.catalog_only.v1'}));
        fx.local.set(headKey, JSON.stringify({...t1Head, turn, recordKey}));
      }
      f.chat.message = longChat;
      f.chat.messages = longChat;
      resetTrace();
      const longCold = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(longCold, 2), true, 'T2 remains reachable in a 64-turn catalog');
      const coldHeadReads = headReads;
      const coldTrace = assertTrace();
      resetTrace();
      const longWarm = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(longWarm, 2), true, 'T2 remains reachable after index reuse');
      assert.ok(coldHeadReads >= 60, `cold catalog probes the synthetic history: ${coldHeadReads}`);
      assert.ok(headReads < coldHeadReads / 4,
        `steady catalog avoids history-wide head reads: ${headReads} versus ${coldHeadReads}`);

      const longWarmTrace = assertTrace();
      assert.equal(longWarmTrace.filter(row => row.phase === 'catalog').length, 0, 'warm64-turn catalog performs no head scan');
      const longWarmHydrated = assertPairedHeads(longWarmTrace), longWarmPublicSelected = publicSelected(longWarm);
      assert.deepEqual(longWarmHydrated.map(row => row.turn).sort(), [2]);
      assert.equal(headReads, 2, 'warm64-turn catalog only hydrates and physically rereads actual shortlisted T2');
      const warmHeadReads = headReads;

      // Mutate the actual selected physical head during its record await. The
      // genuine Micro guard must refuse its earlier snapshot before returning.
      const t2HeadKey = t1HeadKey.replace(/:t1$/, ':t2'), originalT2Body = fx.local.get(t2HeadKey), t2Head = JSON.parse(originalT2Body);
      resetTrace();let mutationApplied = false;
      fx.backend.getItem = async key => {
        if (String(key).includes(':micro-memory-head:')) { headReads++; headReadKeys.push(String(key)); }
        if (String(key).includes(':micro-memory:')) recordReadKeys.push(String(key));
        if (!mutationApplied && key === t2Head.recordKey) { mutationApplied = true; const changedHead = JSON.parse(originalT2Body); changedHead.recallProjection.summary += ' physical-head-mutation'; fx.local.set(t2HeadKey, JSON.stringify(changedHead)); }
        return originalGetItem(key);
      };
      let refused;try { refused = await f.r.context.__MICRO_HEAD_READ_TEST__.readActive(t2Head.worldlineId, t2Head.sessionEpoch, t2Head.turn); } finally { fx.local.set(t2HeadKey, originalT2Body); }
      assert.equal(mutationApplied, true);assert.equal(refused.status, 'stale_source');assert.equal(refused.reason, 'micro_head_changed_during_read');
      const refusalTrace = assertTrace();assert.deepEqual(refusalTrace.map(row => row.phase), ['hydration', 'physical-reread']);
      assert.ok(refusalTrace.every(row => row.headKey === t2HeadKey));
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), originalSource, 'production source bytes unchanged');
      console.log('PASS incremental Micro Recall head reads',
        JSON.stringify({syntheticTurns: 64, firstTrace, coldHeadReads, warmHeadReads, steadyTrace, changedTrace, changedHydrated, changedPublicSelected, coldCatalogReads:coldTrace.filter(row => row.phase === 'catalog').length, longWarmTrace, longWarmHydrated, longWarmPublicSelected, physicalHeadMutationRefused:refused.reason}));
    } finally { fx.backend.getItem = originalGetItem; }
  } finally { await fx.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
