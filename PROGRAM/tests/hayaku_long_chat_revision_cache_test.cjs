'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createValidPacket,
  hiddenPacketMessage,
  createHayakuRuntime
} = require('./fixtures/hayaku_runtime_harness.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');

const version=source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version);
assert.ok(source.includes(`const PLUGIN_VERSION = '${version}';`), 'header and runtime versions agree');
assert.match(source, /const messageRevisionProjection = \(message, index = -1, scopeKeyInput = '', options = \{\}\) =>/);
assert.match(source, /const exactChatRevisionObservation = scope =>/);
assert.match(source, /reason: 'observer_exact_revision_unchanged'/);
assert.doesNotMatch(source, /const worldlineObserverTextProbe = value =>/, 'sampled text probes must not be used for authoritative topology changes');
assert.match(source, /invalidateMessageRevisionCache\(liveScope\.key, \{[\s\S]{0,300}indices: \[messageIndex\]/, 'output revision invalidates only the committed message cache entry');

const messages = [];
for (let turn = 1; turn <= 3; turn += 1) {
  const packet = createValidPacket({ turn, subject: `Actor-${turn}`, scene: `Room-${turn}` });
  messages.push({ role: 'user', data: `User action ${turn}.`, chatId: `u-${turn}`, time: turn * 2 - 1 });
  messages.push({
    role: 'assistant',
    data: hiddenPacketMessage(`Assistant outcome ${turn}.`, packet),
    chatId: `a-${turn}`,
    time: turn * 2
  });
}

(async () => {
  const runtime = await createHayakuRuntime({ messages, autoRepair: false });
  try {
    const { hayaku, chat } = runtime;
    const scope = await hayaku._test.currentChatScope();
    assert.equal(scope.chatMessageCount, 6);

    const first = hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    assert.equal(first.conversationPairCount, 3);
    assert.equal(first.historyPairCount, 3);
    const afterFirst = hayaku.lastDebug().messageRevisionCache.stats;
    assert.equal(afterFirst.misses, 6, 'first snapshot computes each message exactly once');
    assert.equal(afterFirst.writes, 6);

    const second = hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    assert.deepEqual(second.conversationPairs, first.conversationPairs, 'cached snapshot preserves the exact semantic result');
    const afterSecond = hayaku.lastDebug().messageRevisionCache.stats;
    assert.equal(afterSecond.misses, afterFirst.misses, 'unchanged snapshot performs no new message computation');
    assert.ok(afterSecond.hits >= afterFirst.hits + 12, 'history and descriptor passes reuse all message revisions');

    const unchangedRevisionA = hayaku._test.exactChatRevisionObservation(scope);
    const unchangedRevisionB = hayaku._test.exactChatRevisionObservation(scope);
    assert.equal(unchangedRevisionA.signature, unchangedRevisionB.signature, 'exact observation is stable for unchanged chat');

    const editedPacket = createValidPacket({ turn: 2, subject: 'Actor-2', scene: 'Room-2-edited', summary: 'Actor-2 changed the established outcome.' });
    chat.message[3].data = hiddenPacketMessage('Assistant outcome 2 was edited.', editedPacket);
    chat.messages = chat.message;

    const editedScope = await hayaku._test.currentChatScope();
    const editedRevision = hayaku._test.exactChatRevisionObservation(editedScope);
    assert.notEqual(editedRevision.signature, unchangedRevisionB.signature, 'same message ID with changed body produces a new exact revision');
    const edited = hayaku._test.authoritativeChatSnapshot(editedScope.chatMessages, editedScope);
    assert.equal(edited.conversationPairCount, 3);
    const afterEdit = hayaku.lastDebug().messageRevisionCache.stats;
    assert.equal(afterEdit.misses, afterSecond.misses + 1, 'only the changed Assistant message is recomputed');
    assert.equal(afterEdit.invalidations, afterSecond.invalidations + 1, 'only one cached revision is replaced');

    chat.message = chat.message.slice(0, 4);
    chat.messages = chat.message;
    const rolledBackScope = await hayaku._test.currentChatScope();
    const rolledBack = hayaku._test.authoritativeChatSnapshot(rolledBackScope.chatMessages, rolledBackScope);
    assert.equal(rolledBack.conversationPairCount, 2);
    const afterRollback = hayaku.lastDebug().messageRevisionCache.stats;
    assert.ok(afterRollback.pruned >= afterEdit.pruned + 2, 'rollback prunes only disappeared message entries');
    assert.equal(afterRollback.misses, afterEdit.misses, 'unchanged retained messages stay cached across rollback');

    process.stdout.write('hayaku_long_chat_revision_cache_test: PASS\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
