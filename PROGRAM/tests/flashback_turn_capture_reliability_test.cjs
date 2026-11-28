'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { configure } = require('./helpers/unload_recall_contract_fixture.cjs');

const BASE_SOURCE = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
const TEST_SOURCE = BASE_SOURCE.replace(
  'publicApi._test.liveChatPairsFromNormalized = liveChatPairsFromNormalized;',
  [
    'publicApi._test.liveChatPairsFromNormalized = liveChatPairsFromNormalized;',
    'publicApi._test.resolveFlashbackCurrentTurn = resolveFlashbackCurrentTurn;',
    'publicApi._test.currentPendingCaptureBarrier = currentPendingCaptureBarrier;',
    'publicApi._test.reconcileFinalizedCaptureCandidates = reconcileFinalizedCaptureCandidates;'
  ].join('\n  ')
);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, attempts = 160, intervalMs = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await predicate();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error('Timed out waiting for Flashback capture condition');
}

test('1) non-unique host memo (NewChat) and cross-source custom memo vs chatId both capture cleanly', async () => {
  const USER_1 = 'Open the brass lantern drawer.';
  const REPLY_1 = 'The brass drawer opens to reveal a folded harbor chart.';
  const f1 = await createFixture({ source: TEST_SOURCE, chat: { message: [{ role: 'user', chatId: 'u1-uuid', data: USER_1 }] } });
  try {
    await configure(f1, 'hash');
    await until(() => f1.api.getCaptureBackendState().registered);
    await f1.api._selectionTest.beforeRequest([{ role: 'user', memo: 'NewChat', content: USER_1 }], 'model');
    const pending1 = f1.api._test.Runtime.pendingTurns;
    assert.equal(pending1.length, 1);
    assert.equal(pending1[0].requestUserMessageIdHash || '', '', 'NewChat memo must not be treated as unique message id');

    const eventChat1 = { ...f1.currentChat, message: [{ role: 'user', chatId: 'u1-uuid', data: USER_1 }, { role: 'assistant', chatId: 'a1-uuid', data: REPLY_1 }] };
    f1.currentChat.message = eventChat1.message;
    f1.currentChat.messages = eventChat1.message;
    await f1.dispatchRisuChatEvent('output', { char: { ...f1.character, chats: [eventChat1] }, chat: eventChat1, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const scope1 = await f1.api.resolveCurrentScope(false);
    const confirmed1 = await until(async () => (await f1.api._test.loadScopeRecords(scope1.scopeKey)).records.find(r => r.metadata?.captureAuthority?.liveConfirmed === true));
    assert.ok(confirmed1.text.includes(REPLY_1));
  } finally {
    await f1.dispose();
  }

  const f2 = await createFixture({ source: TEST_SOURCE, chat: { message: [{ role: 'user', chatId: 'u1-uuid', data: USER_1 }] } });
  try {
    await configure(f2, 'hash');
    await until(() => f2.api.getCaptureBackendState().registered);
    await f2.api._selectionTest.beforeRequest([{ role: 'user', memo: 'legacy-host-memo-1', content: USER_1 }], 'model');
    const pending2 = f2.api._test.Runtime.pendingTurns;
    assert.equal(pending2.length, 1);
    assert.equal(pending2[0].requestUserMessageIdSource, 'memo');

    const eventChat2 = { ...f2.currentChat, message: [{ role: 'user', chatId: 'u1-uuid', data: USER_1 }, { role: 'assistant', chatId: 'a1-uuid', data: REPLY_1 }] };
    f2.currentChat.message = eventChat2.message;
    f2.currentChat.messages = eventChat2.message;
    await f2.dispatchRisuChatEvent('output', { char: { ...f2.character, chats: [eventChat2] }, chat: eventChat2, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const scope2 = await f2.api.resolveCurrentScope(false);
    const confirmed2 = await until(async () => (await f2.api._test.loadScopeRecords(scope2.scopeKey)).records.find(r => r.metadata?.captureAuthority?.liveConfirmed === true));
    assert.ok(confirmed2.text.includes(REPLY_1));
  } finally {
    await f2.dispose();
  }
});

test('2) chaId-only character tolerates nickname/name differences in captureSnapshotMatchesScope', async () => {
  const USER = 'Inspect the copper astrolabe.';
  const REPLY = 'The copper astrolabe aligns with the northern spire.';
  const f = await createFixture({ source: TEST_SOURCE, chat: { message: [{ role: 'user', chatId: 'u1', data: USER }] } });
  try {
    delete f.character.id;
    f.character.chaId = 'canonical-char-chaid';
    f.character.name = 'Before Nickname';
    await configure(f, 'hash');
    await until(() => f.api.getCaptureBackendState().registered);

    await f.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    const eventChat = { ...f.currentChat, message: [{ role: 'user', chatId: 'u1', data: USER }, { role: 'assistant', chatId: 'a1', data: REPLY }] };
    f.currentChat.message = eventChat.message;
    f.currentChat.messages = eventChat.message;
    const renamedChar = { chaId: 'canonical-char-chaid', name: 'Renamed Character', chats: [eventChat] };
    await f.dispatchRisuChatEvent('output', { char: renamedChar, chat: eventChat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });

    const scope = await f.api.resolveCurrentScope(false);
    const confirmed = await until(async () => (await f.api._test.loadScopeRecords(scope.scopeKey)).records.find(r => r.metadata?.captureAuthority?.liveConfirmed === true));
    assert.ok(confirmed.text.includes(REPLY));
  } finally {
    await f.dispose();
  }
});

test('3) transient scope switch or empty chat lookup does not wipe in-flight pendingTurns', async () => {
  const USER = 'Open the cedar desk.';
  const REPLY = 'Inside the cedar desk lies a sealed ledger.';
  const f = await createFixture({ source: TEST_SOURCE, chat: { id: 'chat-a', chatId: 'chat-a', name: 'Chat A', message: [{ role: 'user', chatId: 'u1', data: USER }] } });
  try {
    const chatB = { id: 'chat-b', chatId: 'chat-b', name: 'Chat B', message: [] };
    f.character.chats.push(chatB);
    await configure(f, 'hash');
    await until(() => f.api.getCaptureBackendState().registered);

    await f.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    assert.equal(f.api._test.pendingCaptureRuntimeSnapshot().pendingTurns.length, 1);

    // Transiently switch to Chat B, then transiently return no active chat (-1)
    f.host.getCurrentChatIndex = async () => 1;
    f.host.getChatFromIndex = async (_c, idx) => f.character.chats[idx];
    await f.api._test.resolveCurrentScopeIdentityBundle(false);
    assert.equal(f.api._test.pendingCaptureRuntimeSnapshot().pendingTurns.length, 1, 'pending turn from Chat A must survive switching to Chat B');

    f.host.getCurrentChatIndex = async () => -1;
    await f.api._test.resolveCurrentScopeIdentityBundle(false);
    assert.equal(f.api._test.pendingCaptureRuntimeSnapshot().pendingTurns.length, 1, 'pending turn must survive transient no_active_chat');

    // Return to Chat A and confirm output capture
    f.host.getCurrentChatIndex = async () => 0;
    const chatA = f.character.chats[0];
    chatA.message = [{ role: 'user', chatId: 'u1', data: USER }, { role: 'assistant', chatId: 'a1', data: REPLY }];
    chatA.messages = chatA.message;
    await f.dispatchRisuChatEvent('output', { char: f.character, chat: chatA, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const scopeA = (await f.api._test.resolveCurrentScopeIdentityBundle(false)).scope;
    const confirmed = await until(async () => (await f.api._test.loadScopeRecords(scopeA.scopeKey)).records.find(r => r.metadata?.captureAuthority?.liveConfirmed === true));
    assert.ok(confirmed.text.includes(REPLY));
  } finally {
    await f.dispose();
  }
});

test('4) loadCurrentChat falls back to character.chats on transient RPC null while honoring explicit -1', async () => {
  const f = await createFixture({ source: TEST_SOURCE, chat: { id: 'chat-fallback', chatId: 'chat-fallback', message: [{ role: 'user', chatId: 'u1', data: 'Hello' }] } });
  try {
    f.character.chatPage = 0;
    f.host.getChatFromIndex = async () => null;
    const recovered = await f.api._test.resolveCurrentScopeIdentityBundle(false);
    assert.equal(recovered.scope.available, true);
    assert.equal(recovered.scope.chatId, 'chat-fallback');

    f.host.getCurrentChatIndex = async () => null;
    const recoveredNullIdx = await f.api._test.resolveCurrentScopeIdentityBundle(false);
    assert.equal(recoveredNullIdx.scope.available, true);

    f.host.getCurrentChatIndex = async () => -1;
    const absent = await f.api._test.resolveCurrentScopeIdentityBundle(false);
    assert.equal(absent.scope.available, false);
    assert.equal(absent.scope.reason, 'no_active_chat');
  } finally {
    await f.dispose();
  }
});

test('5) First Message present: Turn 1 capture & Turn 1 reroll in CHAT_OUTPUT_V3 without user id recover via afterRequest candidate', async () => {
  const FM = 'Welcome to the observatory. The brass telescope points east.';
  const U1 = 'Look through the eyepiece.';
  const A1 = 'Three faint stars align above the ridge.';
  const A1_REROLL = 'A comet tail splits the eastern constellation in two.';

  const f = await createFixture({
    source: TEST_SOURCE,
    chat: {
      message: [
        { role: 'assistant', chatId: 'fm-0', data: FM },
        { role: 'user', chatId: 'u1', data: U1 }
      ]
    }
  });
  try {
    await configure(f, 'hash');
    await until(() => f.api.getCaptureBackendState().registered);

    // Turn 1 with First Message in request
    await f.api._selectionTest.beforeRequest([
      { role: 'assistant', chatId: 'fm-0', content: FM },
      { role: 'user', chatId: 'u1', content: U1 }
    ], 'model');
    f.currentChat.message.push({ role: 'assistant', chatId: 'a1', data: A1 });
    f.currentChat.messages = f.currentChat.message;
    await f.dispatchRisuChatEvent('output', { char: f.character, chat: f.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 2 });
    const scope = await f.api.resolveCurrentScope(false);
    const firstConfirmed = await until(async () => (await f.api._test.loadScopeRecords(scope.scopeKey)).records.find(r => r.text.includes(A1) && r.metadata?.captureAuthority?.liveConfirmed === true));
    assert.equal(Number(firstConfirmed.pairIndex || firstConfirmed.turnIndex), 1);

    // Turn 1 reroll where request strips user ID (triggers awaiting_binding), CHAT_OUTPUT_V3 retains afterRequest candidate
    await f.api._selectionTest.beforeRequest([
      { role: 'assistant', content: FM },
      { role: 'user', content: U1 }
    ], 'model');
    const pendingReroll = f.api._test.Runtime.pendingTurns.at(-1);
    assert.equal(pendingReroll.bindingState, 'awaiting_binding');

    await f.api._selectionTest.afterRequest(A1_REROLL, 'model');
    assert.ok(f.api._test.Runtime.afterRequestCaptureCandidates.has(pendingReroll.pendingId), 'CHAT_OUTPUT_V3 must retain afterRequest candidate');

    f.currentChat.message[2] = { role: 'assistant', chatId: 'a1-reroll', data: A1_REROLL };
    f.currentChat.messages = f.currentChat.message;
    const recon = await f.api._test.reconcileFinalizedCaptureCandidates(
      { character: f.character, chat: f.currentChat, chatInfo: { charIndex: 0, chatIndex: 0 } },
      await f.api.loadSettings(),
      { scope }
    );
    assert.equal(recon.saved, 1, JSON.stringify(recon));
    const rows = (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    assert.ok(rows.some(r => r.text.includes(A1_REROLL) && Number(r.pairIndex || r.turnIndex) === 1));
    assert.ok(!rows.some(r => r.text.includes(A1) && r.lifecycleStatus === 'active'));
  } finally {
    await f.dispose();
  }
});

test('6) continuation turn ([U1, A1, A2] without new user message) updates Pair 1 instead of dropping as pairIndex 2', async () => {
  const U1 = 'Ask the archivist about the lower vault.';
  const A1 = 'The archivist unlocks the iron grate.';
  const A2 = 'Beneath the stair sits a cedar cabinet marked IV.';

  for (const withIds of [true, false]) {
    const f = await createFixture({
      source: TEST_SOURCE,
      chat: {
        message: [
          { role: 'user', ...(withIds ? { chatId: 'u1' } : {}), data: U1 },
          { role: 'assistant', ...(withIds ? { chatId: 'a1' } : {}), data: A1 }
        ]
      }
    });
    try {
      await configure(f, 'hash');
      await until(() => f.api.getCaptureBackendState().registered);
      await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });

      await f.api._selectionTest.beforeRequest([
        { role: 'user', ...(withIds ? { chatId: 'u1' } : {}), content: U1 },
        { role: 'assistant', ...(withIds ? { chatId: 'a1' } : {}), content: A1 }
      ], 'model');

      const pending = f.api._test.Runtime.pendingTurns.at(-1);
      assert.equal(pending.pairIndex, 1, `continuation should target pairIndex 1 (withIds=${withIds})`);
      assert.equal(pending.mode, 'reroll');

      f.currentChat.message.push({ role: 'assistant', ...(withIds ? { chatId: 'a2' } : {}), data: A2 });
      f.currentChat.messages = f.currentChat.message;
      await f.dispatchRisuChatEvent('output', { char: f.character, chat: f.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 2 });

      const scope = await f.api.resolveCurrentScope(false);
      const merged = await until(async () => (await f.api._test.loadScopeRecords(scope.scopeKey)).records.find(r => r.text.includes(A2) && r.metadata?.captureAuthority?.liveConfirmed === true));
      assert.ok(merged.text.includes(A1) && merged.text.includes(A2));
      assert.equal(Number(merged.pairIndex || merged.turnIndex), 1);
    } finally {
      await f.dispose();
    }
  }
});

test('7) resolveFlashbackCurrentTurn skips unprovenanced trailing meta user block and keeps provenance user text with template/translation phrases', async () => {
  const f = await createFixture({ source: TEST_SOURCE });
  try {
    const resolved = f.api._test.resolveFlashbackCurrentTurn([
      { role: 'user', chatId: 'u1', content: '안녕 {{char}}, 이 번역 요청 문장도 확인해줘' },
      { role: 'user', content: '### Status Interface\n- state: normal' }
    ]);
    assert.equal(resolved.rawText, '안녕 {{char}}, 이 번역 요청 문장도 확인해줘');
    assert.equal(resolved.source, 'request_provenance_user');
  } finally {
    await f.dispose();
  }
});

test('8) pendingCaptureBarrier expires automatically after TTL', async () => {
  const f = await createFixture({ source: TEST_SOURCE });
  try {
    f.api._test.Runtime.pendingCaptureBarrier = {
      at: Date.now() - 50000,
      reason: 'before_auxiliary_request',
      decisionId: 'stuck_1',
      pendingIds: ['p1']
    };
    assert.equal(f.api._test.currentPendingCaptureBarrier(), null);
    assert.equal(f.api._test.Runtime.pendingCaptureBarrier, null);

    f.api._test.Runtime.pendingCaptureBarrier = {
      at: Date.now(),
      reason: 'before_auxiliary_request',
      decisionId: 'fresh_1',
      pendingIds: ['p1']
    };
    assert.equal(f.api._test.currentPendingCaptureBarrier()?.decisionId, 'fresh_1');
  } finally {
    await f.dispose();
  }
});
