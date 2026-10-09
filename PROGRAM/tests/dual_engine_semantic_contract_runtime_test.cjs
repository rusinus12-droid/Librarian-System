'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFixture: createFlashbackRuntime } = require('./fixtures/flashback_native_runtime_fixture.cjs');

(async () => {
  const hayaku = await createHayakuRuntime({ autoRepair: false });
  const flashback = await createFlashbackRuntime();
  try {
    const ht = hayaku.hayaku._test;
    const ft = flashback.api._test;

    assert.equal(ht.explicitQueryIntentOf('현재 상태').temporal, 'unspecified');
    assert.equal(ht.explicitQueryIntentOf('time:current relation:causes').temporal, 'current');
    assert.equal(ht.explicitQueryIntentOf('time:current relation:causes').relation, 'CAUSES');
    assert.equal(ht.explicitQueryIntentOf({ queryPlan: { intent: { temporal: 'past', transition: true } } }).transition, true);
    const worldTopicKey = ht.currentWorldTopicKey({
      axis: 'world',
      category: 'current_state',
      publicText: 'Harbor bridge remains open',
      retrieval: {}
    }, 'Harbor bridge');
    assert.match(worldTopicKey, /harbor\|bridge|bridge\|harbor/,
      'world topic routing must run without a language stop-list or undefined token registry');
    const hayakuStructuredPlan = ht.RecallKeywordFeatures.compile({
      rawQuery: 'harbor bridge',
      queryPlan: { intent: { temporal: 'past' } }
    });
    assert.equal(hayakuStructuredPlan.requestText, 'harbor bridge',
      'HAYAKU structured query envelopes must remain text-addressable');

    const structuredAnchors = flashback.api._selectionTest.extractRecallAnchors({
      rawQuery: 'harbor bridge',
      queryPlan: { intent: { temporal: 'past' } }
    });
    assert.ok(structuredAnchors.important.has('harbor'));
    assert.ok(structuredAnchors.important.has('bridge'));
    const structuredPlan = flashback.api._selectionTest.RecallKeywordFeatures.compile({
      rawQuery: 'harbor bridge',
      queryPlan: { intent: { temporal: 'past' } }
    });
    assert.equal(structuredPlan.requestText, 'harbor bridge',
      'structured query envelopes must not degrade to [object Object]');
    for (const compiler of [ht.RecallKeywordFeatures, flashback.api._selectionTest.RecallKeywordFeatures]) {
      for (const temporal of ['past', 'current', 'past']) {
        const input = {rawQuery: 'harbor bridge', queryPlan: {intent: {temporal, contextMode: 'continuation'}}};
        const result = compiler.compile(input);
        assert.equal(result.intent.temporal, temporal, 'intent survives text extraction and same-text cache reuse');
        assert.equal(result.queryMode, 'continuation');
        assert.equal(compiler.compile(compiler.requestSpec(input)).intent.temporal, temporal);
        assert.ok(result.goals.every(goal => goal.intent.temporal === temporal));
      }
    }
    assert.equal(structuredAnchors.queryPlan.intent.temporal, 'past');

    const packet = {
      meta: { schema: 'hayaku_packet_v1' },
      entity: {
        characters: [],
        pov_memories: [{ ownerEntityId: 'Alice', content: 'Alice suspects a hidden door.' }]
      },
      world: { active_events: [{ summary: 'Alice arrived at the harbor.' }] },
      narrative: { scene_deltas: [] },
      planner: {
        continuity_locks: [{ ownerEntityId: 'Alice', summary: 'Alice thinks about returning.' }],
        next_direction: [{ detail: 'The harbor may open again.' }],
        open_invitations: []
      }
    };
    const canonical = ht.canonicalizePacketRecordForIngest(packet, { sourceEvidence: { body: 'Alice suspects a hidden door.' } }, {}).packet;
    assert.equal(canonical.entity.pov_memories[0].memoryType, undefined, 'prose must not assign POV type');
    assert.equal(canonical.planner.continuity_locks.length, 1, 'untyped lock must remain in place');
    assert.equal(canonical.world.active_events.length, 1, 'prose must not close active event');
    assert.equal(canonical.meta.packet_record_audit.corrections.futureCommitmentsMigrated, 0);
    assert.equal(canonical.meta.packet_record_audit.corrections.unsupportedFutureDirectionsDropped, 0);

    const naturalA = ft.computeImportanceDensity('promise object');
    const naturalB = ft.computeImportanceDensity('harbor object');
    assert.equal(naturalA, naturalB, 'prose vocabulary must not alter importance');
    assert.equal(ft.computeMemoryHeat({ text: 'promise', turnIndex: 1 }, { latestTurn: 30 }).durableEvent, false);
    assert.equal(ft.computeMemoryHeat({ text: 'ordinary text', durableEvent: true, turnIndex: 1 }, { latestTurn: 30 }).durableEvent, true);
    assert.equal(ft.computeMemoryHeat({ text: 'conflict', turnIndex: 1 }, { latestTurn: 30 }).disputed, false);
    assert.equal(ft.computeMemoryHeat({ text: 'ordinary text', metadata: { truthIntent: 'disputed' }, turnIndex: 1 }, { latestTurn: 30 }).disputed, true);
    assert.equal(ft.resolveRecallLane({ text: 'promise', turnIndex: 1 }, { latestTurn: 100 }), 'long');
    assert.equal(ft.resolveRecallLane({ text: 'ordinary text', recallLane: 'medium', turnIndex: 1 }, { latestTurn: 100 }), 'medium');

    console.log(JSON.stringify({
      hayakuExplicitIntent: true,
      structuredQueryEnvelope: true,
      hayakuProsePreserved: true,
      flashbackStructuredLifecycle: true,
      proseDoesNotAssignSemantics: true
    }));
  } finally {
    await Promise.allSettled([hayaku.dispose(), flashback.dispose()]);
  }
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
