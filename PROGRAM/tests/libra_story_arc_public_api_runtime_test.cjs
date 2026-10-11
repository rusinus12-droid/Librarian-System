'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
    assert.equal(Object.isFrozen(api), true, 'main LIBRA public API should remain frozen');
    assert.equal(api.narrativeCompletionSchema, 'libra.narrative_completion.v2');
    for (const name of [
      'migrateStoryArcToNarrativeIfNeeded',
      'validateAndBindNarrativePatchEvidence',
      'callNarrativeDeltaProvider',
      'narrativeStatePromptBlock',
      'narrativeDirectionPromptBlock',
      'getStoryArc',
      'rebuildStoryArc',
      'setStoryArcDestination',
      'clearStoryArc'
    ]) assert.equal(typeof api[name], 'function', `${name} missing from the frozen main public API`);

    const prompt = api.narrativeStatePromptBlock({
      schema: 'libra.narrative_current_state.v2',
      summary: 'Current narrative',
      arcs: [{ id: 'arc', title: 'Arc', status: 'active', phase: 'rising', centralPressure: 'Pressure' }],
      threads: [{ id: 'thread', type: 'question', status: 'open', summary: 'Question' }],
      locks: [],
      momentum: 'Momentum',
      updatedThroughTurn: 5
    });
    assert.match(prompt, /Current narrative/);
    assert.match(prompt, /already-established narrative state/);

    const guarded = api.validateAndBindNarrativePatchEvidence({
      arcs: [], threads: [], turningPoints: [{ summary: 'Unsupported history entry' }], locks: [], motifs: []
    }, null);
    assert.deepEqual(JSON.parse(JSON.stringify(guarded.turningPoints)), [],
      'unsupported historical turning point must not become current Narrative authority');

    const scopeKey = 'scope-public-api-story-arc-retirement';
    const stateKey = `libra:v1:scope:${scopeKey}:continuity-state`;
    const legacyKey = `libra:v1:scope:${scopeKey}:story-arc`;
    const markerKey = `libra:v1:scope:${scopeKey}:story-arc-migration:v1`;
    harness.values.set(stateKey, JSON.stringify({
      schema: 'libra.continuity_state.v2',
      narrative: {
        schema: 'libra.narrative_current_state.v2',
        summary: 'Frozen API current narrative',
        arcs: [{ id: 'arc', status: 'active', title: 'Current' }],
        threads: [], locks: [], momentum: '', updatedThroughTurn: 5
      }
    }));
    const legacyRaw = JSON.stringify({
      schema: 'libra.story_arc.v1',
      summary: 'Frozen API legacy narrative',
      continuityState: { currentNarrativeState: 'Frozen API legacy narrative' }
    });
    harness.values.set(legacyKey, legacyRaw);
    const migrated = await api.migrateStoryArcToNarrativeIfNeeded({ scopeKey });
    assert.equal(migrated.status, 'legacy_preserved_current_narrative_kept');
    assert.equal(harness.values.get(legacyKey), legacyRaw, 'frozen API migration mutated legacy source');
    const marker = JSON.parse(harness.values.get(markerKey));
    assert.equal(marker.verified, true, 'frozen API migration marker was not written through Risu pluginStorage');
    const storedHead = JSON.parse(harness.values.get(stateKey));
    assert.equal(storedHead.narrative.summary, 'Frozen API current narrative');

    process.stdout.write(`libra_story_arc_public_api_runtime_test: PASS (${path.basename(process.argv[2] || 'LIBRA.js')})\n`);
  } finally {
    await harness.cleanup();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
