'use strict';
// Retirement contract. The per-head Micro recall catalog (activeMicroRecallCorpus, catalog/hydration/
// physical-reread head probes and its microRecallIndex diagnostics) was removed with the legacy
// retrieval in 9c03c35. The unified engine now serves new Micro records through its common owner
// graph/index; this suite checks that the old catalog is gone and that the replacement path keeps the
// behaviors the catalog existed for: no restart for a newly published turn and reach through a long
// history. The head-changed-during-read seam belonged to the removed reader and has no counterpart.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../plugins/LIBRA.js'), 'utf8');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {settleStorage} = require('./fixtures/libra_storage_quiesce.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

for (const retired of ['activeMicroRecallCorpus', 'microRecallIndex', 'enumerationFallback', 'libra.micro_recall_index'])
  assert.equal(source.includes(retired), false, `retired Micro head catalog symbol is absent: ${retired}`);

(async () => {
  let listener;
  const fx = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  try {
    const {f} = fx;
    const allMessages = f.chat.message;
    const quotes = new Map([[1, '도서관 전체는 정숙 구역'], [2, '민아가 창고 문을 닫았다']]);
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
    const publish = async (messageIndex, turn) => {
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
    };
    const selectedTurn = (recall, turn) => Array.from(recall.memories || [])
      .some(row => row.memory?.kind === 'micro' && row.memory?.turnRange?.start === turn
        && String(row.excerpt?.text || row.excerpt || '').includes(quotes.get(turn)));
    const noCatalog = recall => assert.equal(recall.diagnostics?.microRecallIndex, undefined,
      'Recall diagnostics no longer carry the retired Micro head catalog');

    await publish(1, 1);
    await settleStorage(fx);
    const first = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
    assert.equal(selectedTurn(first, 1), true, 'first Recall finds the durable T1 Micro');
    noCatalog(first);
    const steady = await f.r.api.previewUnifiedMemoryRecall(quotes.get(1));
    assert.equal(selectedTurn(steady, 1), true, 'steady Recall keeps the same result');

    f.chat.message = allMessages.slice(0, 4);
    f.chat.messages = f.chat.message;
    await publish(3, 2);
    await settleStorage(fx);
    const changed = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
    assert.equal(selectedTurn(changed, 2), true,
      'a newly published T2 enters Recall without restarting or a head-catalog scan');
    assert.equal(selectedTurn(await f.r.api.previewUnifiedMemoryRecall(quotes.get(1)), 1), true,
      'T1 stays reachable after T2 is published');

    // Synthetic history pressure: head rows that are not source evidence must not hide T2.
    const t1HeadKey = [...fx.local.keys()].find(key =>
      String(key).includes(':micro-memory-head:') && String(key).endsWith(':t1'));
    const t1Head = JSON.parse(fx.local.get(t1HeadKey));
    const longChat = allMessages.slice(0, 4);
    for (let turn = 3; turn <= 64; turn++) {
      const user = {...allMessages[2], chatId: `synthetic-t${turn}-u`, data: `합성 사용자 ${turn}`};
      const assistant = {...allMessages[3], chatId: `synthetic-t${turn}-a`, data: `합성 응답 ${turn}`};
      longChat.push(user, assistant);
      const headKey = t1HeadKey.replace(/:t1$/, `:t${turn}`);
      const recordKey = t1Head.recordKey.replace(/:t1:/, `:t${turn}:`);
      fx.local.set(recordKey, JSON.stringify({schema: 'synthetic.catalog_only.v1'}));
      fx.local.set(headKey, JSON.stringify({...t1Head, turn, recordKey}));
    }
    f.chat.message = longChat;
    f.chat.messages = longChat;
    const longCold = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
    assert.equal(selectedTurn(longCold, 2), true, 'T2 remains reachable in a 64-turn history');
    noCatalog(longCold);
    const longWarm = await f.r.api.previewUnifiedMemoryRecall(quotes.get(2));
    assert.equal(selectedTurn(longWarm, 2), true, 'T2 remains reachable after index reuse');

    console.log('PASS retired Micro head catalog; unified path serves incremental Micro Recall');
  } finally { await fx.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
