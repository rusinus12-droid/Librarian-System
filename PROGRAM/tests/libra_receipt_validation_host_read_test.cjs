'use strict';
// Receipt/micro write-fence validation runs at the start and end of every claim check.
// It only needs the open chat's messages and the character id, so for independent chats
// it reads the open chat alone and keeps the character id per character index for 30s;
// native branches still read the full character because lineage checks parent chats, and
// request/output lifecycle hooks drop the remembered character id.
const test = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

function transformSource(source) {
  const anchor = '      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(source.includes(anchor), 'LIBRA core anchor');
  source = source.replace(anchor, `      debugReceiptValidationFixture: async (action, arg) => {
        if (action === 'claim') {
          const context = await resolveContext(true);
          const pair = buildPairs(context.chat, context.scope.scopeKey)[Number(arg || 1) - 1];
          const identity = receiptRecoveryIdentity(context, pair);
          const boundary = await captureReceiptRecoveryBoundary(context, pair);
          return { scope: context.scope, identity, boundary };
        }
        if (action === 'validate') return await validateReceiptRecoveryClaim(arg);
        if (action === 'capture') {
          const context = await resolveContext(true);
          const msgs = Array.isArray(context.chat?.message) ? context.chat.message : [];
          return await captureCommittedOutputEvent({
            char: context.character, chat: context.chat,
            characterIndex: 0, chatIndex: 0, messageIndex: Math.max(1, msgs.length - 1)
          });
        }
        if (action === 'beforeRequest') return await beforeRequest([{ role: 'user', content: 'hello' }], 'model');
        if (action === 'afterRequest') return await afterRequest('response', 'model');
        if (action === 'invalidate') { invalidateReceiptValidationCharacterId(); return true; }
        if (action === 'cache') return state.receiptValidationCharacterId ? { ...state.receiptValidationCharacterId } : null;
        throw new Error('unknown action: ' + action);
      },\n` + anchor);
  const root = "    debugBuildPairs(chat = {}, cacheKey = '')";
  assert.ok(source.includes(root), 'LIBRA root anchor');
  return source.replace(root, '    async debugReceiptValidationFixture(action, arg) { return await LibraMemoryCore.debugReceiptValidationFixture(action, arg); },\n' + root);
}

test('validateReceiptRecoveryClaim reads open chat alone, caches character id, and catches mid-check chat edits', async () => {
  let chatReads = 0;
  let mutateSecondChatRead = false;
  let chatReadsThisCheck = 0;
  const x = await serverFixture({ mode: 'plugin_only', transformSource });
  try {
    const risu = x.f.r.context.risuai;
    const origGetChatFromIndex = risu.getChatFromIndex.bind(risu);
    risu.getChatFromIndex = async (...args) => {
      chatReads += 1;
      const chat = await origGetChatFromIndex(...args);
      if (mutateSecondChatRead) {
        chatReadsThisCheck += 1;
        if (chatReadsThisCheck === 2) {
          const clone = JSON.parse(JSON.stringify(chat));
          clone.message[1].data = 'Edited mid-validation!';
          return clone;
        }
      }
      return chat;
    };

    const reads = x.f.control.hostReads;
    const api = x.f.r.api;
    const claim = await api.debugReceiptValidationFixture('claim', 1);
    assert.equal((await api.debugReceiptValidationFixture('validate', claim)).status, 'current');

    // Cache is now warm: repeated validations read the open chat twice each and the character 0 times.
    const charBefore = reads.character;
    const chatBefore = chatReads;
    for (let i = 0; i < 5; i += 1) {
      const res = await api.debugReceiptValidationFixture('validate', claim);
      assert.equal(res.status, 'current');
    }
    assert.equal(reads.character - charBefore, 0, 'warm validations do not copy the full character');
    assert.equal(chatReads - chatBefore, 10, 'each validation reads the open chat at start and end');

    // Request/output lifecycle hooks drop the remembered character id.
    assert.ok(await api.debugReceiptValidationFixture('cache'), 'character id is cached before hook');
    await api.debugReceiptValidationFixture('beforeRequest');
    assert.equal(await api.debugReceiptValidationFixture('cache'), null, 'beforeRequest drops cached character id');

    assert.equal((await api.debugReceiptValidationFixture('validate', claim)).status, 'current');
    assert.ok(await api.debugReceiptValidationFixture('cache'), 'character id is cached again');
    await api.debugReceiptValidationFixture('afterRequest');
    assert.equal(await api.debugReceiptValidationFixture('cache'), null, 'afterRequest drops cached character id');

    // Editing the open chat between the start read and the end read of one validation is still caught.
    assert.equal((await api.debugReceiptValidationFixture('validate', claim)).status, 'current');
    mutateSecondChatRead = true;
    chatReadsThisCheck = 0;
    const stale = await api.debugReceiptValidationFixture('validate', claim);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.reason, 'source_changed_during_validation');
  } finally {
    await x.cleanup();
  }
});

test('native branch chats still read the full character for lineage verification', async () => {
  const x = await serverFixture({ mode: 'plugin_only', transformSource });
  try {
    const parent = x.f.chat;
    const child = JSON.parse(JSON.stringify(parent));
    child.id = 'branch-chat-1';
    child.message.splice(2, 0, {
      role: 'assistant',
      chatId: 'branch-marker-1',
      isComment: true,
      disabled: true,
      data: `{{specialcomment::branchedfrom::${parent.id}::${parent.message[1].chatId}::}}`
    });
    x.f.character.chats = [parent, child];
    const risu = x.f.r.context.risuai;
    risu.getCurrentChatIndex = async () => 1;
    risu.getChatFromIndex = async (_ci, hi) => {
      x.f.control.hostReads.chat += 1;
      return hi === 1 ? child : parent;
    };

    const reads = x.f.control.hostReads;
    const api = x.f.r.api;
    const claim = await api.debugReceiptValidationFixture('claim', 1);
    const charBefore = reads.character;
    const res = await api.debugReceiptValidationFixture('validate', claim);
    assert.equal(res.status, 'current');
    assert.ok(reads.character - charBefore >= 2, 'native branch falls back to full character reads for parent lineage');
  } finally {
    await x.cleanup();
  }
});

test('one LIBRA turn stays within its full-character-read budget', async () => {
  const x = await serverFixture({ mode: 'plugin_only', transformSource });
  try {
    const reads = x.f.control.hostReads;
    const api = x.f.r.api;
    const charBefore = reads.character;
    await api.debugReceiptValidationFixture('beforeRequest');
    await api.debugReceiptValidationFixture('capture');
    // Let any immediate micro/receipt tasks settle.
    await new Promise(resolve => setTimeout(resolve, 250));
    const turnReads = reads.character - charBefore;
    // Measured on this 5-turn cold fixture: 174 full-character reads before this change, 27 after.
    // On a steady-state turn (earlier turns already receipted) it is ~10-15.
    assert.ok(turnReads <= 40, 'full-character reads in one turn: ' + turnReads);
  } finally {
    await x.cleanup();
  }
});
