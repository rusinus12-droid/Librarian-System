'use strict';
// When Micro analysis is unavailable the turn is kept as a source excerpt. An excerpt that happened to
// end on a space used to fail its own check, leaving the turn unpublished.
const assert = require('node:assert/strict');
const { create, until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const input = require('./fixtures/unified_vertical_source.json');

(async () => {
  for (const [label, text] of [
    ['a space at the cut', '가'.repeat(499) + ' ' + '나'.repeat(50)],
    ['a line break at the cut', '가'.repeat(499) + '\n' + '나'.repeat(50)],
    ['spaces around the cut', '가'.repeat(497) + '   ' + '나'.repeat(50)],
    ['no space at the cut', '가'.repeat(600)],
    ['shorter than the cut', '짧은 응답입니다.']
  ]) {
    let f, listener;
    try {
      f = await create('LIBRA', 'Full', { initialChat: input.sourceRows.map(row => ({ role: row.role, chatId: row.ref, data: row.text })), host: {
        addRisuChatListener: async (_kind, fn) => { listener = fn; return true; },
        runLLMModel: async () => ({ type: 'error', result: 'synthetic_provider_failure' })
      } });
      await f.open();
      const character = await f.host.getCharacter(), chat = character.chats[0];
      chat.message.push({ role: 'user', chatId: 't6-u', data: '다음 장면.' }, { role: 'assistant', chatId: 't6-a', data: text });
      chat.messages = chat.message;
      listener({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
      await until(() => f.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 'Micro publication', 15000);
      const publication = f.api.getCaptureBackendState().lastMicroPublication;
      assert.equal(publication.status, 'verified', `${label}: ${publication.reason}`);
      assert.equal(publication.analysisStatus, 'minimum_source_bound', label);
    } finally { await f?.close(); }
  }
  console.log('PASS a source excerpt is published wherever it is cut');
})().catch(error => { console.error(error); process.exitCode = 1; });
