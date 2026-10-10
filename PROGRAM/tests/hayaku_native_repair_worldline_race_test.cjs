'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });
const groundedEnvelope = summary => {
  const packet = createValidPacket({ turn: 2, subject: 'Alice', scene: 'library', summary });
  packet.entity.characters = [{ name: 'Alice' }];
  packet.planner.continuity_locks = [summary];
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [summary] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [summary] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

(async () => {
  const turn1Packet = createValidPacket({
    turn: 1,
    subject: 'Alice',
    scene: 'library',
    summary: 'Alice entered the library.'
  });
  const initialMessages = [
    user('u1', 'I enter the library.'),
    assistant('a1', hiddenPacketMessage('Alice entered the library.', turn1Packet)),
    user('u2', 'I take the silver key.'),
    assistant('a2-old', 'Alice took the silver key from the desk.')
  ];

  let resolveLlm;
  const delayedLlm = new Promise(resolve => { resolveLlm = resolve; });
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: initialMessages,
    llmResponder: async () => await delayedLlm
  });

  try {
    const repairPromise = runtime.hayaku.recovery.repairNow({ reason: 'worldline_race_test' });
    await waitFor(() => runtime.llmCalls.length === 1, 'native repair Other Ax call', 10000);

    // Simulate a reroll while the old variant is still being analyzed. The same
    // logical pair now has a new Assistant message identity and visible outcome.
    runtime.setMessages([
      initialMessages[0],
      initialMessages[1],
      initialMessages[2],
      assistant('a2-new', 'Alice left the silver key on the desk and closed the drawer.')
    ]);

    resolveLlm({
      type: 'success',
      result: JSON.stringify(groundedEnvelope('Alice took the silver key from the desk.'))
    });

    const result = await repairPromise;
    assert.notEqual(result.outcome, 'completed', 'stale old-variant repair must never be adopted');
    assert.equal(result.repaired, false);
    assert.ok(
      result.outcome === 'cancelled'
        || result.outcome === 'suspended'
        || /stale|worldline|target/i.test(String(result.reason || '')),
      `unexpected stale-target disposition: ${JSON.stringify(result)}`
    );

    const inspection = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const activeRecovery = inspection.records.filter(record => (
      record.packetType === 'recovery_snapshot'
      && record.recordState === 'active'
      && Number(record.targetPairIndex || 0) === 2
    ));
    assert.equal(activeRecovery.length, 0, 'old reroll variant must not enter the canonical active ledger');

    const debtInspection = await runtime.hayaku._test.inspectRecoveryDebtsForNativeRepair({
      includeEvidence: true,
      limit: 8
    });
    const staleOldDebt = Array.from(debtInspection.debts || []).find(debt => (
      String(debt?.evidence?.assistant || '').includes('took the silver key')
      && debt.status === 'repair_pending'
    ));
    assert.equal(staleOldDebt, undefined, 'old rerolled debt must not remain an active repair owner');

    assert.equal(runtime.llmCalls.length, 1, 'stale result handling must not launch a second provider call');
    assert.equal(runtime.fetchCalls.length, 0);
    console.log('PASS hayaku_native_repair_worldline_race_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
