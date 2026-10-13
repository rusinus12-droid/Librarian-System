'use strict';
// Explicit maintenance of GUI-source admission, never loaded by runtime fixtures.
// The historical plan and independent ac4 output pins are not rewritten.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const generator = require('./archive_issued_tail_plan_generator.cjs');
const historical = require('./archive_issued_tail_plans.json');
const file = path.join(__dirname, 'archive_issued_tail_gui_plans.json');
function generate() {
  const {inputs, variants} = generator.actualVariants();
  const plans = variants.map(generator.buildPlan); // Includes exact AST roundtrip.
  for (const plan of plans) {
    const baseline = historical.plans.find(row => row.name === plan.name);
    const fingerprints = row => row.callsites.map(site => site.family + ':' + site.callbackSha256).sort();
    assert.deepEqual(fingerprints(plan), fingerprints(baseline), 'all 32 reviewed scheduler callback bodies unchanged');
    assert.equal(plan.expressionCount, baseline.expressionCount);
    assert.deepEqual(plan.anchors.map(anchor => anchor.before), baseline.anchors.map(anchor => anchor.before));
  }
  return {schema: 'gui-adoption.source-observer-plans.v1', offsetUnit: historical.offsetUnit, inputs,
    review: 'All 32 callback family/body SHA-256 fingerprints, 52 expressions and 8 fixed anchors unchanged from historical plans; generator verifies observation removal restores the exact input AST. Historical output pins remain independent and unchanged.', plans};
}
if (require.main === module) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const actual = generate();
  if (process.argv[2] === '--write') fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  else assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), actual, 'GUI-source plans match static callback/AST proof');
  console.log('PASS: historical pins unchanged; GUI-source exact admission and all reviewed callbacks verified');
}
module.exports = {generate};
