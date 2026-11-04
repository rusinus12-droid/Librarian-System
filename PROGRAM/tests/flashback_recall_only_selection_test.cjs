'use strict';
// Flashback's selection for another reader: the evidence the hook injects, with no capture armed and
// nothing written.
//
// Run: node tests/flashback_recall_only_selection_test.cjs
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { syntheticFetch, configure, readyForRecall } = require('./helpers/unload_recall_contract_fixture.cjs');

const USER = '은빛 열쇠와 서재 계기판 상태를 확인한다.';
const REPLY = '서재 계기판 바늘이 붉은 눈금에 멈춰 있고 은빛 열쇠 고리가 북쪽 벽에 걸려 있다.';
const PHRASE = '서재 계기판 바늘이 붉은 눈금에 멈춰 있고';
const QUERY = '서재 계기판 바늘과 은빛 열쇠 고리 상태를 알려줘.';

(async () => {
  const seed = await createFixture({ captureBackend: 'afterRequest' });
  const storage = seed.pluginStorage, host = seed.host;
  let chat, character;
  try {
    seed.host.nativeFetch = (url, init) => syntheticFetch(url, init);
    await configure(seed, 'configured');
    await seed.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await seed.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await new Promise(resolve => setTimeout(resolve, 30));
    seed.currentChat.message = [{ role: 'user', chatId: 'u1', data: USER }, { role: 'assistant', chatId: 'a1', data: REPLY }];
    seed.currentChat.messages = seed.currentChat.message;
    await seed.api._selectionTest.afterRequest(REPLY, 'model');
    await readyForRecall(seed, 'configured', PHRASE);
    chat = JSON.parse(JSON.stringify(seed.currentChat));
    character = JSON.parse(JSON.stringify(seed.character));
  } finally { await seed.dispose(); }

  const runtime = await createFixture({ pluginStorage: storage, safeLocalStorage: host.safeLocalStorage, chat, character, captureBackend: 'afterRequest' });
  try {
    runtime.host.nativeFetch = (url, init) => syntheticFetch(url, init);
    await configure(runtime, 'configured');
    await runtime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    const pendingBefore = JSON.stringify(runtime.api.runtime().pendingTurns ?? null);
    const selected = await runtime.api._selectionTest.selectRecallPrompt(QUERY);
    assert.ok(selected.content.includes(PHRASE), 'selection: ' + selected.content.slice(0, 300));
    assert.equal(JSON.stringify(runtime.api.runtime().pendingTurns ?? null), pendingBefore, 'selecting arms no capture');

    const outgoing = await runtime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model');
    const body = outgoing.map(row => String(row.content || '')).join('\n');
    assert.ok(body.includes(selected.content), 'without GRADIA the hook delivers the same evidence itself');

    // Turns already in the recent chat are not handed back as memory, on either path.
    const deduped = await runtime.api._selectionTest.selectRecallPrompt(QUERY, () => {}, { recentChatText: 'User:\n' + USER + '\n\nAssistant:\n' + REPLY + '\n\nUser:\nnext' });
    assert.ok(!deduped.content.includes(PHRASE), 'selection drops a turn the recent chat already shows');
    const hookDeduped = await runtime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }, { role: 'assistant', chatId: 'a1', content: REPLY }, { role: 'user', chatId: 'u9', content: QUERY }], 'model');
    assert.equal(hookDeduped.map(row => String(row.content || '')).join('\n').split(PHRASE).length - 1, 1, 'the hook delivers it only as the recent chat');
    const otherChat = await runtime.api._selectionTest.selectRecallPrompt(QUERY, () => {}, { recentChatText: '전혀 다른 장면의 최근 대화가 여기에 있다.' });
    assert.ok(otherChat.content.includes(PHRASE), 'a turn the recent chat does not show stays available');

    await runtime.api._selectionTest.selectRecallPrompt(QUERY);
    const shown = (await runtime.api.debugState()).lastRecall;
    assert.equal(shown.gradia.status, 'selected', 'the selection is visible in Flashback');
    assert.match(runtime.api._test.renderLastRecallPanel(shown, shown.scopeKey), /GRADIA에 전달 대기/);

    runtime.api._selectionTest.noteGradiaAttach({ active: true, ttlMs: 60000 });
    const compat = (await runtime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model')).map(row => String(row.content || '')).join('\n');
    assert.ok(!compat.includes(PHRASE), 'GRADIA delivers the evidence in compatibility mode');
    assert.equal((await runtime.api.debugState()).lastRecall.gradia.status, 'selected', 'the hook does not overwrite what was selected');
    runtime.api._selectionTest.noteGradiaAttach({ active: false, ttlMs: 0 });
    const restored = (await runtime.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model')).map(row => String(row.content || '')).join('\n');
    assert.ok(restored.includes(PHRASE), 'without the announcement Flashback works alone again');
  } finally { await runtime.dispose(); }
  console.log('flashback_recall_only_selection_test: PASS');
  process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
