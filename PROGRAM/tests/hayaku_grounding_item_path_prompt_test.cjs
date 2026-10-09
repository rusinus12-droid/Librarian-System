'use strict';
// Regression test: the grounding-path rule must name the ITEM, not one of its fields.
//
// MEASURED (2026-09-20, real Gemma-4 recovery answer): the model wrote
//   {"path":"entity.characters[0].current_state", ...}
//   {"path":"world.active_events[0].summary", ...}
//   {"path":"narrative.critical_dialogue[0].text", ...}
// while the packet held items at entity.characters[0], world.active_events[0],
// narrative.critical_dialogue[0]. validateNativeRepairGrounding then reported
//   grounding_path_missing:entity.characters[0]
//   grounding_path_missing:world.active_events[0]
//   grounding_path_missing:world.regions[0]
// and rejected the answer — the rows existed but covered nothing.
//
// The prompt said "add one grounding row with its exact JSON path (example entity.characters[0])".
// One example is not a rule: the model generalised to "the path of the fact I quoted". The prompt now
// names the item and forbids a trailing field. This test pins that wording on every authoring prompt.
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const t = runtime.hayaku._test;
    for (const kind of ['incremental_recovery', 'after_request_recovery', 'cold_start']) {
      const system = String(t.nativePacketAuthoringPrompt(kind, { memoryLanguage: 'source' })?.primary || '');
      assert.ok(system.length > 0, `${kind}: prompt must not be empty`);

      // The rule must say the path names the ITEM.
      assert.ok(/grounding path names the ITEM/i.test(system),
        `${kind}: the prompt must state that a grounding path names the item, not a field`);
      // And it must show more than one shape, so the rule generalises.
      assert.ok(/entity\.characters\[0\]/.test(system),
        `${kind}: an entity-only example is what the model generalised wrongly from`);
      assert.ok(/planner\.[a-z_]+\[\d+\]/.test(system),
        `${kind}: the example set must include a planner collection`);
      // And it must name the concrete mistake, so a model that already does this stops.
      assert.ok(/(Never|Do not) append a field/i.test(system),
        `${kind}: the prompt must forbid the trailing field explicitly`);
      assert.ok(/does not cover/i.test(system),
        `${kind}: the prompt must say why the field path fails`);

      // The rule alone was not enough: the model wrote records and grounded only some of them, and the
      // validator reported the rest as missing. A countable self-check is what makes it actionable.
      assert.ok(/count the records (you wrote )?(under|in) (entity|the)/i.test(system),
        `${kind}: the prompt must ask for a countable item-vs-row self-check`);
      assert.ok(/without its own row is (treated as )?unsupported/i.test(system),
        `${kind}: the self-check must state the consequence of a missing row`);

      // Listing collection names is not a content rule. The model filled planner with inferences
      // (a source for the knocking, a predicted failure, how the character might react) and grounded
      // none of them. Each collection now says what belongs in it and that it may stay empty.
      assert.ok(/is not for analysis/i.test(system),
        `${kind}: the prompt must say a collection is not a place for analysis`);
      assert.ok(/an empty collection is correct output/i.test(system),
        `${kind}: the prompt must state that an empty collection is correct, or the model fills it`);

      // A CONTEXT-only name fails as unverifiable identity. character.name is required, so the prompt
      // must say to omit the record rather than write it nameless (measured: omitting passes,
      // name-only-in-CONTEXT fails).
      assert.ok(/name must appear in TARGET TURN/i.test(system),
        `${kind}: the prompt must tie a character name to TARGET TURN`);
      assert.ok(/omit the character record/i.test(system),
        `${kind}: the prompt must say to omit the record when TARGET TURN names nobody`);

      // current_state was written as an object holding location/action/emotion. The prose rule existed
      // and was not enough; a literal shape is what the model follows.
      assert.ok(/NO nested state object/i.test(system),
        `${kind}: the prompt must show the flat character shape explicitly`);
    }

    // The validator must still treat a field path as not covering its item.
    const { createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');
    const packet = createValidPacket({ turn: 2, subject: 'Alice', summary: 'Alice checked the gauge.' });
    const target = 'Alice checked the gauge.';
    const fieldOnly = {
      schema: 'hayaku.native_repair_output.v1',
      packet,
      grounding: [{ path: 'entity.characters[0].current_state', source: 'target', evidence: [target] }]
    };
    const fieldResult = t.validateNativeRepairGrounding(fieldOnly, { targetText: target });
    assert.equal(fieldResult.ok, false, 'a field-level path must NOT satisfy the item requirement');
    assert.ok((fieldResult.errors || []).some(e => /grounding_path_missing:entity\.characters\[0\]$/.test(e)),
      `the failure must name the uncovered item, got: ${JSON.stringify((fieldResult.errors || []).slice(0, 4))}`);

    // Every item the validator asks about must get a row naming the ITEM. Build that list from the
    // validator's own complaint, so the test does not hardcode a fixture's shape.
    const firstPass = t.validateNativeRepairGrounding(
      { schema: 'hayaku.native_repair_output.v1', packet, grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: [target] }] },
      { targetText: target }
    );
    const missing = (firstPass.errors || [])
      .map(e => String(e).replace(/^grounding_path_missing:/, ''))
      .filter(Boolean);
    assert.ok(missing.length > 0, 'the fixture packet must have items needing rows');
    const itemLevel = {
      schema: 'hayaku.native_repair_output.v1',
      packet,
      grounding: [
        { path: 'meta.summary_memory.summary', source: 'target', evidence: [target] },
        ...missing.map(path => ({ path, source: 'target', evidence: [target] }))
      ]
    };
    const itemResult = t.validateNativeRepairGrounding(itemLevel, { targetText: target });
    assert.equal(itemResult.ok, true,
      `item-level paths must satisfy every collection item, got: ${JSON.stringify((itemResult.errors || []).slice(0, 4))}`);
  } finally {
    await runtime.dispose?.();
  }
  console.log('PASS hayaku grounding path rule: every prompt names the item and forbids a trailing field, the validator still rejects a field path, and an item path passes');
})().catch(error => { console.error(error); process.exitCode = 1; });
