'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

(async () => {
  let listener;
  const fx = await serverFixture({mode: 'plugin_only', host: {
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
    fx.backend.getItem = async key => {
      if (String(key).includes(':micro-memory-head:')) {
        headReads += 1;
        headReadKeys.push(String(key));
      }
      return originalGetItem(key);
    };
    const selectedTurn = (recall, turn) => Array.from(recall.memories || [])
      .some(row => row.memory?.kind === 'micro' && row.memory?.turnRange?.start === turn);
    try {
      const warm = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
      assert.equal(selectedTurn(warm, 1), true, 'first Recall finds the durable T1 Micro');
      const firstReads = headReads;
      headReads = 0;
      headReadKeys = [];
      const steady = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
      assert.equal(selectedTurn(steady, 1), true, 'steady Recall keeps the same result');
      assert.ok(firstReads >= 2, `cold Recall includes catalog and hydration reads: ${firstReads}`);
      assert.ok(headReads <= 1,
        `steady Recall should recheck only selected T1, not rebuild its head index: ${headReads}`);

      f.chat.message = allMessages.slice(0, 4);
      f.chat.messages = f.chat.message;
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
        messageIndex: 3});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 2, 15000);
      headReads = 0;
      headReadKeys = [];
      const changed = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(changed, 2), true,
        'a newly published T2 enters Recall without restarting or a full head scan');
      assert.ok(headReads <= 3,
        `incremental Recall should read new T2 and selected hydration only: ${headReads} ${headReadKeys.join(', ')}`);

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
      headReads = 0;
      headReadKeys = [];
      const longCold = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(longCold, 2), true, 'T2 remains reachable in a 64-turn catalog');
      const coldHeadReads = headReads;
      headReads = 0;
      headReadKeys = [];
      const longWarm = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
      assert.equal(selectedTurn(longWarm, 2), true, 'T2 remains reachable after index reuse');
      assert.ok(coldHeadReads >= 60, `cold catalog probes the synthetic history: ${coldHeadReads}`);
      assert.ok(headReads < coldHeadReads / 4,
        `steady catalog avoids history-wide head reads: ${headReads} versus ${coldHeadReads}`);

      console.log('PASS incremental Micro Recall head reads',
        JSON.stringify({syntheticTurns: 64, coldHeadReads, warmHeadReads: headReads}));
    } finally { fx.backend.getItem = originalGetItem; }
  } finally { await fx.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
