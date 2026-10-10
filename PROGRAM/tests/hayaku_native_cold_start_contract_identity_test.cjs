'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');


// Transport fixtures carry only the source-supported event; placeholder planner locks are not evidence.
const coldPacket = options => { const p=createValidPacket(options); p.entity={};p.world={};p.narrative={};p.planner={};p.meta.summary_memory={summary:options.summary};return {schema:'hayaku.native_repair_output.v1',packet:p,grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[options.summary]}]}; };
const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the observatory.'),
      assistant('a1', 'Alice entered the observatory.'),
      user('u2', 'I open the atlas.'),
      assistant('a2', 'Alice opened the atlas and found a blue mark.')
    ]
  });

  try {
    runtime.setLlmResponder(async (_options, callIndex) => {
      if (callIndex === 1) {
        return { type: 'success', result: JSON.stringify(coldPacket({ turn: 1, subject: 'Alice', scene: 'observatory', summary: 'Alice entered the observatory.' })) };
      }
      return { type: 'success', result: 'not-json' };
    });

    const firstResult = await runtime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(firstResult.ok, true);assert.equal(firstResult.completed,false);assert.equal(firstResult.reason,'cold_start_partial_adopted');assert.equal(firstResult.adoption.durable,true);
    assert.equal(firstResult.awaitingUserReview, false);
    assert.equal(runtime.llmCalls.length, 2, 'one primary per turn; no unapproved repair');

    const status = await runtime.hayaku.recovery.status();
    assert.equal(status.coldStartRun.available, true);
    const storageKey = status.coldStartRun.storageKey;
    const raw = await runtime.pluginStorage.getItem(storageKey);
    const run = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
    assert.equal(run.chunks[0].status, 'verified');
    assert.ok(run.chunks[0].contractHash, 'verified checkpoint must record its native prompt contract');

    // Simulate a checkpoint made by an older HAYAKU authoring contract. A body
    // that still parses/schema-validates must nevertheless be reanalyzed.
    run.contractHash = 'h64obsolete_contract';
    run.workerVersion = 'hayaku_native_otherax_cold_start_old';
    run.chunks[0].contractHash = 'h64obsolete_contract';
    run.chunks[0].promptContractHash = 'h64obsolete_contract';
    await runtime.pluginStorage.setItem(storageKey, JSON.stringify(run));

    runtime.setLlmResponder(async (_options, callIndex) => ({
      type: 'success',
      result: JSON.stringify(coldPacket({
        turn: callIndex === 3 ? 1 : 2,
        subject: 'Alice',
        scene: 'observatory',
        summary: callIndex === 3 ? 'Alice entered the observatory.' : 'Alice opened the atlas and found a blue mark.'
      }))
    }));

    const resumed = await runtime.hayaku.recovery.coldStart({ resume: true, allowExisting:true });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.reusedChunks, 0, 'obsolete prompt/worker contract must not reuse the old verified checkpoint');
    assert.equal(runtime.llmCalls.length, 4, 'both turns must be reanalyzed after contract identity changes');

    const finalStatus = await runtime.hayaku.recovery.status();
    const finalRun = finalStatus.coldStartRun.run;
    assert.ok(finalRun.contractHash && finalRun.contractHash !== 'h64obsolete_contract');
    assert.ok(finalRun.chunks.every(chunk => chunk.contractHash === finalRun.contractHash));
    assert.ok(finalRun.chunks.every(chunk => chunk.promptContractHash === finalRun.contractHash));

    console.log('PASS hayaku_native_cold_start_contract_identity_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
