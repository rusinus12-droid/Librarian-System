'use strict';
// A copied chat ("Story (Copy)") whose source chat has no HAYAKU ledger used to re-read every
// matching candidate ledger on each scope resolution (5 s negative cache, no in-flight sharing).
// Concurrent lookups must share one scan, and the negative result must stay cached until a
// ledger write changes the ledger generation. Full plugin in the runtime harness.
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const marker = '    const currentChatScope = async (options = {}) => {';
  const messages = [
    { role: 'user', data: '도서관 문을 열었다.', chatId: 'm1' },
    { role: 'char', data: '문이 천천히 열렸다.', chatId: 'm2' },
    { role: 'user', data: '안으로 들어간다.', chatId: 'm3' },
    { role: 'char', data: '먼지가 흩날렸다.', chatId: 'm4' }
  ];
  // In plugin-only mode the storage proxy answers from memory, so count the candidate-ledger
  // reads where the scan issues them (in server mode each one is a full-ledger HTTP read).
  const readLine = '        const stored = await getStorageItem(`${STORAGE_LEDGER_KEY_PREFIX}${candidate.sourceScopeKey}`, null);';
  const r = await createHayakuRuntime({
    chatId: 'copy-chat', chatName: 'Story (Copy)', messages,
    transformSource: source => {
      assert.ok(source.includes(marker) && source.includes(readLine), 'scope resolver markers present');
      return source.replace(marker, '    globalThis.__hayakuInferCopiedChatSource = inferCopiedChatSource;\n' + marker)
        .replace(readLine, '        globalThis.__hayakuCopyScanReads = (globalThis.__hayakuCopyScanReads || 0) + 1;\n' + readLine);
    }
  });
  try {
    r.character.chats.push({ id: 'source-chat', chatId: 'source-chat', name: 'Story', message: messages.slice(0, 2), messages: messages.slice(0, 2) });
    const infer = r.context.__hayakuInferCopiedChatSource;
    assert.equal(typeof infer, 'function', 'inferCopiedChatSource exposed for the test');
    const reads = () => Number(r.context.__hayakuCopyScanReads || 0);
    const before = reads();
    const copy = r.character.chats[0];

    const results = await Promise.all(Array.from({ length: 6 }, () => infer(r.character, copy)));
    assert.ok(results.every(row => row.reason === 'copy_source_ledger_not_found'), JSON.stringify(results));
    const scanReads = reads() - before;
    assert.ok(scanReads >= 1, 'the scan reads the candidate ledger');
    assert.equal(scanReads, 1, `six concurrent lookups share one scan (ledger reads: ${scanReads})`);

    for (let i = 0; i < 5; i += 1) await infer(r.character, copy);
    assert.equal(reads() - before, scanReads, 'a repeated lookup reuses the cached negative result');
    console.log(JSON.stringify({ test: 'hayaku_copied_chat_source_read_coalescing', passed: true, concurrentLookups: 6, ledgerReads: scanReads,
      boundary: 'full plugin in runtime harness, synthetic chats; live RisuAI untested' }));
  } finally {
    await r.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
