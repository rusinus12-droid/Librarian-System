'use strict';
// Flashback's LATEST CONFIRMED STATE lines carry the confirming excerpt under its entity heading only:
// no chat turn, no "last confirmed" tag (the section title says it) and no internal property key.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createModelFixture } = require('./fixtures/recall_model_runtime_fixture.cjs');

test('state lines are the excerpt under its entity heading, with no turn, tag or property key', async t => {
  const f = await createModelFixture();
  t.after(() => f.dispose());
  const sel = f.api._selectionTest;
  const state = (id, fact, text) => ({ unit: { id, state: true, fact }, fragment: { text } });
  const rendered = sel.renderFlashbackEvidencePlan({ choices: [
    state('s1', { entity: 'Alice', property: 'current_location', turn: 12 }, 'Alice waited in the royal archive.'),
    state('s2', { entity: 'Alice', property: 'relationship_trust', peer: 'Bob', turn: 9 }, 'Alice said she trusted Bob.'),
    state('s3', { entity: '@world', property: 'gate_status' }, 'The east gate stayed shut.')
  ] }).text;
  assert.match(rendered, /LATEST CONFIRMED STATE\n\[Alice\]\n- Alice waited in the royal archive\.\n- Alice said she trusted Bob\.\n\[WORLD\]\n- The east gate stayed shut\./);
  assert.doesNotMatch(rendered, /마지막 확인|과거 확인|current_location|relationship_trust|gate_status|→ Bob|\bT\d/);
  const out = await sel.beforeRequest([{ role: 'user', content: 'Where is Alice?' }], 'model');
  const rules = out.map(row => String(row.content || '')).find(body => body.includes('[PAST EVIDENCE RULES]')) || '';
  assert.match(rules, /keep each state attached to its bracketed entity header \(`\[Entity\]`\) without promoting/);
  assert.doesNotMatch(rules, /confirmation turn|`T#`|directional target/);
});
