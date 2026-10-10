'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket
} = require('./fixtures/hayaku_runtime_harness.cjs');


// Transport fixtures carry only the source-supported event; placeholder planner locks are not evidence.
const coldPacket = options => { const p=createValidPacket(options); p.entity={};p.world={};p.narrative={};p.planner={};p.meta.summary_memory={summary:options.summary};return {schema:'hayaku.native_repair_output.v1',packet:p,grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[options.summary]}]}; };
const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the observatory.'),
      assistant('a1', 'Alice entered the observatory and lit the brass lamp.'),
      user('u2', 'I open the old star atlas.'),
      assistant('a2', 'Alice opened the atlas and found a red annotation beside Orion.')
    ]
  });

  try {
    runtime.setLlmResponder(async (_options, callIndex) => {
      if (callIndex === 1) {
        return {
          type: 'success',
          result: JSON.stringify(coldPacket({
            turn: 1,
            subject: 'Alice',
            scene: 'observatory',
            summary: 'Alice entered the observatory and lit the brass lamp.'
          }))
        };
      }
      return { type: 'success', result: 'not valid JSON' };
    });

    const firstResult = await runtime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(firstResult.ok, true);assert.equal(firstResult.completed,false);assert.equal(firstResult.reason,'cold_start_partial_adopted');assert.equal(firstResult.adoption.durable,true);
    assert.equal(firstResult.awaitingUserReview, false, 'failed generation must be retained without the retired manual adoption flow');
    assert.equal(firstResult.failedChunks,1);
    assert.equal(runtime.llmCalls.length, 2, 'one primary per turn; no unapproved repair');

    const failedStatus = await runtime.hayaku.recovery.status();
    assert.equal(failedStatus.coldStartRun.available, true, 'failed checkpoint must remain durable');
    assert.equal(failedStatus.coldStartRun.run.state, 'partial');
    assert.equal(failedStatus.coldStartRun.run.chunks.length, 2);
    assert.equal(failedStatus.coldStartRun.run.chunks[0].status, 'verified');
    assert.equal(failedStatus.coldStartRun.run.chunks[1].status, 'failed');
    assert.ok(failedStatus.coldStartRun.run.chunks[1].failedAnalysisId);
    assert.ok(failedStatus.coldStartRun.run.chunks[0].body, 'verified chunk body must survive failure');

    runtime.setLlmResponder(async () => ({
      type: 'success',
      result: JSON.stringify(coldPacket({
        turn: 2,
        subject: 'Alice',
        scene: 'observatory',
        summary: 'Alice opened the atlas and found a red annotation beside Orion.'
      }))
    }));

    const resumed = await runtime.hayaku.recovery.coldStart({ resume: true, allowExisting:true });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.completed, true);
    assert.equal(resumed.packets, 2);
    assert.equal(resumed.reusedChunks, 1, 'the verified first chunk must not be called again');
    assert.equal(runtime.llmCalls.length, 3, 'resume must add exactly one Other Ax call');

    for (const call of runtime.llmCalls) {
      assert.equal(call.mode, 'otherAx');
      assert.equal(call.allowPlugins, true);
      assert.equal(Object.prototype.hasOwnProperty.call(call, 'staticModel'), false);
      assert.ok(Array.isArray(call.messages) && call.messages.length >= 2);
    }
    assert.equal(runtime.fetchCalls.length, 0, 'HAYAKU must not call nativeFetch for cold start');

    const inspection = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const coldRecords = inspection.records.filter(record => (
      record.captureSource === 'bridge_cold_start'
      && record.recordState === 'historical'
      && record.packetType === 'cold_start_snapshot'
    ));
    assert.equal(coldRecords.length, 2, 'two completed turns must be durably adopted');
    assert.deepEqual(
      Array.from(coldRecords, record => Number(record.historicalOrdinal)).sort((a, b) => a - b),
      [1, 2],
      'cold-start records must preserve completed-turn order as historical ordinals'
    );
    assert.ok(coldRecords.every(record => Number(record.targetPairIndex || 0) === 0),
      'cold-start history must not impersonate a live current-worldline pair slot');

    const completedStatus = await runtime.hayaku.recovery.status();
    assert.equal(completedStatus.coldStartRun.run.state, 'completed');
    assert.equal(completedStatus.coldStartRun.run.chunks[0].checkpointReused, true);
    assert.equal(completedStatus.coldStartRun.run.chunks[1].status, 'verified');

    console.log('PASS hayaku_native_cold_start_contract_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
