'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const buildMicro = (receipt, turn) => {
  const quote = receipt.assistant.text;
  return {
    schema: 'libra.micro_memory.v1',
    scopeKey: receipt.scopeKey,
    worldlineId: receipt.worldlineId,
    sessionEpoch: receipt.sessionEpoch,
    turn,
    sourceRevisionId: receipt.revisionId,
    sourceDigest: receipt.sourceDigest,
    claims: [{
      changeKind: 'event',
      text: quote,
      actor: '',
      target: '',
      temporalRole: 'current',
      certainty: 'confirmed',
      epistemicStatus: 'observed',
      stateChangeType: 'none',
      evidence: {
        role: 'assistant',
        messageId: receipt.assistant.chatId,
        startOffset: 0,
        endOffset: quote.length,
        exactQuote: quote
      }
    }]
  };
};

test('Micro caps a 300s librarian stage timeout at 120s, recovers bare micro_memory.v1, and retries on producer_schema_invalid', async () => {
  let listener;
  const fixture = await serverFixture({
    mode: 'plugin_only',
    host: {
      addRisuChatListener: async (_kind, handler) => {
        listener = handler;
        return true;
      }
    }
  });
  try {
    const { f } = fixture;
    const api = f.r.api;
    // A librarian stage timeout saved as 300s (300000 ms) before the 120s cap; it must read back as 120s.
    const existingSlots = fixture.local.has('libra:v1:agent-slots')
      ? JSON.parse(fixture.local.get('libra:v1:agent-slots'))
      : { version: 2, slots: {} };
    fixture.local.set('libra:v1:agent-slots', JSON.stringify({
      version: 2,
      savedAt: new Date().toISOString(),
      slots: {
        ...(existingSlots.slots || {}),
        librarian: {
          ...((existingSlots.slots && existingSlots.slots.librarian) || {}),
          timeout_ms: 300000
        }
      }
    }));

    assert.equal((await f.run()).completed, 1);

    // Turn 6: model returns bare libra.micro_memory.v1 without the envelope wrapper; must recover as verified.
    let turn6Calls = 0;
    f.control.onCall = async () => {
      turn6Calls += 1;
      const { receipt } = await api.debugReadActiveCompletedTurnReceipt(6);
      return { type: 'success', result: JSON.stringify(buildMicro(receipt, 6)) };
    };
    f.chat.message.push(
      { role: 'user', chatId: 't6-u', data: '계속' },
      { role: 'assistant', chatId: 't6-a', data: '민아가 촛불을 켰다.' }
    );
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
    await waitFor(() => api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
    assert.equal(api.getCaptureBackendState().lastMicroPublication?.status, 'verified');
    assert.equal(turn6Calls, 1, 'bare micro_memory.v1 is normalized without needing a retry');

    const workEntries = [...fixture.local.entries()]
      .filter(([, val]) => typeof val === 'string' && val.includes('"leaseExpiresAt"') && val.includes('"turn":6'))
      .map(([, val]) => JSON.parse(val))
      .filter(entry => entry.turn === 6 && Number(entry.leaseExpiresAt) > 0 && Number(entry.invocationStartedAt) > 0);
    assert.ok(workEntries.length >= 1, 'micro-work record persisted for turn 6');
    const leaseDurationMs = Number(workEntries[0].leaseExpiresAt) - Number(workEntries[0].invocationStartedAt);
    // 120s provider window + 15s lease margin; a saved 300s setting no longer stretches it.
    assert.ok(leaseDurationMs >= 120000 && leaseDurationMs <= 136000, `expected Micro lease window of about 135000ms, got ${leaseDurationMs}`);

    // Turn 7: first attempt returns a truncated inner fragment (invalid schema), second attempt returns a valid envelope.
    let turn7Calls = 0;
    f.control.onCall = async () => {
      turn7Calls += 1;
      if (turn7Calls === 1) {
        return { type: 'success', result: JSON.stringify({ claims: [{ changeKind: 'event' }] }) };
      }
      const { receipt } = await api.debugReadActiveCompletedTurnReceipt(7);
      return {
        type: 'success',
        result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: { spans: [], relations: [] },
          micro: buildMicro(receipt, 7),
          timeAdvance: { kind: 'none' }
        })
      };
    };
    f.chat.message.push(
      { role: 'user', chatId: 't7-u', data: '계속' },
      { role: 'assistant', chatId: 't7-a', data: '민아가 창문을 열었다.' }
    );
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
    await waitFor(() => api.getCaptureBackendState().lastMicroPublication?.turn === 7, 15000);
    assert.equal(api.getCaptureBackendState().lastMicroPublication?.status, 'verified');
    assert.equal(turn7Calls, 2, 'retries once when first response fails envelope schema');
  } finally {
    await fixture.cleanup();
  }
});
