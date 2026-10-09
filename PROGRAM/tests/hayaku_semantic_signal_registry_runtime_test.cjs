'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const h = await createHayakuRuntime({ autoRepair: false });
  try {
    const t = h.hayaku._test;
    assert.deepEqual(Array.from(t.extractTags('A person feels fear near a tower.')), [], 'story words must not become tags');
    assert.deepEqual(
      Array.from(t.extractTags('emotion:fear world:rule narrative:turn relation:ally entity:person time:night locator:scene')),
     ['fear', 'rule', 'turn', 'ally', 'person', 'night', 'scene'],
     'explicit namespace tags must be retained'
   );
    assert.deepEqual(Array.from(t.extractTags('emotion:불안 world:왕국 narrative:미해결.')), ['불안', '왕국', '미해결'], 'unicode explicit tags must be retained');

    const emotion = t.deriveEmotionProfile({ emotionTags: ['fear'], intensity: 0.8, relationImpact: 0.4 });
    assert.deepEqual(Array.from(emotion.tags), ['fear']);
    assert.equal(emotion.intensity, 0.8);
    assert.equal(emotion.relationImpact, 0.4);

    const world = t.deriveWorldProfile({ worldTags: ['rule'], danger: 0.7, canonLevel: 'hard' });
    assert.deepEqual(Array.from(world.tags), ['rule']);
    assert.equal(world.danger, 0.7);
    assert.equal(world.canonLevel, 'hard');

    const story = t.deriveStoryProfile('narrative', 'scene_deltas', { narrativeTags: ['turn'], unresolved: true, priority: 0.6 });
    assert.deepEqual(Array.from(story.tags), ['turn']);
    assert.equal(story.unresolved, true);
    assert.equal(story.priority, 0.6);

    assert.equal(h.llmCalls.length, 0);
    console.log(JSON.stringify({ cases: 6, explicitTagsRetained: true, storyWordsUnclassified: true, modelCalls: 0 }));
  } finally {
    await h.dispose();
  }
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
