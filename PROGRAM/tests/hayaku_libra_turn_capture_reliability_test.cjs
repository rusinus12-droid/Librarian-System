'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const plain = v => JSON.parse(JSON.stringify(v));
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const hayakuTransform = src => src.replace(
  'pendingPairIdentityMatch,',
  'pendingPairIdentityMatch, stableMessageSourceIdentity, authoritativeHistoryPairs, Memory,'
);

test('1) HAYAKU filters non-unique host memo (NewChat) and allows cross-source custom memo vs chatId capture', async () => {
  const U1 = 'Open the brass lantern drawer.';
  const A1_BODY = hiddenPacketMessage('The brass drawer opens to reveal a harbor chart.', createValidPacket({ turn: 1 }));

  // Part A: NewChat memo is not treated as a stable ID
  const h1 = await createHayakuRuntime({ transformSource: hayakuTransform, autoRepair: false });
  try {
    assert.deepEqual(
      plain(h1.hayaku._test.stableMessageSourceIdentity({ role: 'user', memo: 'NewChat', content: U1 })),
      { id: '', source: '', stable: false, canonical: false }
    );
    assert.deepEqual(
      plain(h1.hayaku._test.stableMessageSourceIdentity({ role: 'user', memo: 'firstMessage', content: U1 })),
      { id: '', source: '', stable: false, canonical: false }
    );
    h1.setMessages([{ role: 'user', chatId: 'u1-uuid', data: U1 }]);
    await h1.callBeforeRequest([{ role: 'user', memo: 'NewChat', content: U1 }], 'model');

    const pending1 = h1.hayaku._test.Memory.pendingCaptures.at(-1);
    assert.ok(pending1);
    assert.equal(pending1.lineage.userMessageIdentityStable, false);

    h1.setMessages([
      { role: 'user', chatId: 'u1-uuid', data: U1 },
      { role: 'assistant', chatId: 'a1-uuid', data: A1_BODY }
    ]);
    const res1 = await h1.hayaku._test.processRisuChatOutputEvent({
      char: h1.character,
      chat: h1.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    assert.equal(res1.captured, 1, JSON.stringify(res1));
  } finally {
    await h1.dispose();
  }

  // Part B: Custom non-generic memo on beforeRequest vs canonical chatId on chat.message
  const h2 = await createHayakuRuntime({ transformSource: hayakuTransform, autoRepair: false });
  try {
    h2.setMessages([{ role: 'user', chatId: 'u1-uuid', data: U1 }]);
    await h2.callBeforeRequest([{ role: 'user', memo: 'custom-host-memo-1', content: U1 }], 'model');

    const pending2 = h2.hayaku._test.Memory.pendingCaptures.at(-1);
    assert.ok(pending2);
    assert.equal(pending2.lineage.userMessageIdentitySource, 'memo');

    h2.setMessages([
      { role: 'user', chatId: 'u1-uuid', data: U1 },
      { role: 'assistant', chatId: 'a1-uuid', data: A1_BODY }
    ]);
    const res2 = await h2.hayaku._test.processRisuChatOutputEvent({
      char: h2.character,
      chat: h2.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    assert.equal(res2.captured, 1, JSON.stringify(res2));
  } finally {
    await h2.dispose();
  }
});

test('2) HAYAKU merges consecutive assistant continuation ([U1, A1, A2]) into Pair 1 while skipping leading First Message', async () => {
  const FM = 'Welcome to the observatory.';
  const U1 = 'Check the brass astrolabe.';
  const A1 = hiddenPacketMessage('The astrolabe points north.', createValidPacket({ turn: 1, summary: 'First response half.' }));
  const A2 = hiddenPacketMessage('A comet crosses the lens.', createValidPacket({ turn: 1, summary: 'Continued response half.' }));

  const h = await createHayakuRuntime({ transformSource: hayakuTransform, autoRepair: false });
  try {
    // Leading First Message + [U1, A1] => single pair (pairIndex 1)
    h.setMessages([
      { role: 'assistant', chatId: 'fm-0', data: FM },
      { role: 'user', chatId: 'u1', data: U1 },
      { role: 'assistant', chatId: 'a1', data: A1 }
    ]);
    const scope = h.hayaku._test.hayakuScopeFromChatOutputEvent({
      char: h.character,
      chat: h.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 2
    });
    const beforePairs = h.hayaku._test.authoritativeHistoryPairs(h.chat.message, scope);
    assert.equal(beforePairs.conversationPairCount, 1);
    assert.equal(beforePairs.conversationPairs[0].pairIndex, 1);

    // Continuation beforeRequest ([FM, U1, A1] with no new user message)
    await h.callBeforeRequest([
      { role: 'assistant', chatId: 'fm-0', content: FM },
      { role: 'user', chatId: 'u1', content: U1 },
      { role: 'assistant', chatId: 'a1', content: A1 }
    ], 'model');
    const pending = h.hayaku._test.Memory.pendingCaptures.at(-1);
    assert.ok(pending);
    assert.equal(pending.lineage.targetPairIndex, 1);
    assert.equal(pending.lineage.mode, 'reroll');

    // Commit A2 -> merged into Pair 1 and captured by chatOutput
    h.setMessages([
      { role: 'assistant', chatId: 'fm-0', data: FM },
      { role: 'user', chatId: 'u1', data: U1 },
      { role: 'assistant', chatId: 'a1', data: A1 },
      { role: 'assistant', chatId: 'a2', data: A2 }
    ]);
    const afterPairs = h.hayaku._test.authoritativeHistoryPairs(h.chat.message, scope);
    assert.equal(afterPairs.conversationPairCount, 1);
    assert.equal(afterPairs.conversationPairs[0].assistantMessageIndex, 3);
    assert.ok(afterPairs.conversationPairs[0].assistantVisibleText.includes('The astrolabe points north.'));
    assert.ok(afterPairs.conversationPairs[0].assistantVisibleText.includes('A comet crosses the lens.'));

    const cap = await h.hayaku._test.processRisuChatOutputEvent({
      char: h.character,
      chat: h.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 3
    });
    assert.equal(cap.captured, 1, JSON.stringify(cap));
  } finally {
    await h.dispose();
  }
});

test('3) LIBRA filters non-unique host memo (NewChat) in messageIdentity and handles First Message + continuation [U1, A1, A2]', async () => {
  const fx = await serverFixture({ mode: 'plugin_only' });
  try {
    const pairs = fx.f.r.api.debugBuildPairs({
      id: 'libra-reliability-chat',
      message: [
        { role: 'assistant', chatId: 'fm-0', data: 'Opening greeting.' },
        { role: 'user', memo: 'NewChat', data: 'Ask about the key.' },
        { role: 'assistant', chatId: 'a1', data: 'First reply.' },
        { role: 'assistant', chatId: 'a2', data: 'Continued reply.' },
        { role: 'user', chatId: 'u2-uuid', data: 'Open the vault.' },
        { role: 'assistant', chatId: 'a3', data: 'Vault opened.' }
      ]
    }, 'libra-reliability-chat');

    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].turn, 1);
    assert.equal(pairs[0].user.identityStable, false);
    assert.equal(pairs[0].user.chatId, 'idx_1', 'NewChat memo must not be treated as user chatId');
    assert.equal(pairs[0].assistant.index, 2);
    assert.equal(pairs[0].assistant.endIndex, 3);
    assert.ok(pairs[0].assistant.text.includes('First reply.'));
    assert.ok(pairs[0].assistant.text.includes('Continued reply.'));

    assert.equal(pairs[1].turn, 2);
    assert.equal(pairs[1].user.identityStable, true);
    assert.equal(pairs[1].user.identityCanonical, true);
    assert.equal(pairs[1].user.chatId, 'u2-uuid');
  } finally {
    await fx.cleanup();
  }
});
