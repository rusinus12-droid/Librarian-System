'use strict';
// Explicit maintenance of GUI-source admission, never loaded by runtime fixtures.
// The historical plan and independent ac4 output pins are not rewritten.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const generator = require('./archive_issued_tail_plan_generator.cjs');
const historical = require('./archive_issued_tail_plans.json');
const file = path.join(__dirname, 'archive_issued_tail_gui_plans.json');
// Reviewed callback changes since the historical plans: two scheduleTimer bodies each gained one
// call expression (embedding-queue and legacy-restore startup chains). All other fingerprints are unchanged.
const REVIEWED_CHANGED = ['scheduleTimer:13b75851210c2e97d877d09634e2af8d701032184172894b77dbc9e40c83d0b2', 'scheduleTimer:2348e0c7e63d556e472ead0844f336a42764f3707278ba1432ec5306e8cde193'];
const REVIEWED_REMOVED_COUNT = 2, GUI_EXPRESSIONS = 54;
function generate() {
  const {inputs, variants} = generator.actualVariants();
  const plans = variants.map(variant => generator.buildPlan(variant, GUI_EXPRESSIONS)); // Includes exact AST roundtrip.
  for (const plan of plans) {
    const baseline = historical.plans.find(row => row.name === plan.name);
    const fingerprints = row => row.callsites.map(site => site.family + ':' + site.callbackSha256).sort();
    const old = new Set(fingerprints(baseline)), now = new Set(fingerprints(plan));
    assert.deepEqual(fingerprints(plan).filter(f => !old.has(f)).sort(), [...REVIEWED_CHANGED].sort(), 'only the reviewed scheduler callback bodies changed');
    assert.equal(fingerprints(baseline).filter(f => !now.has(f)).length, REVIEWED_REMOVED_COUNT);
    assert.equal(plan.expressionCount, GUI_EXPRESSIONS);
    assert.deepEqual(plan.anchors.map(anchor => anchor.before), baseline.anchors.map(anchor => anchor.before));
  }
  return {schema: 'gui-adoption.source-observer-plans.v1', offsetUnit: historical.offsetUnit, inputs,
    review: 'All 32 callback family/body SHA-256 fingerprints unchanged from historical plans except two reviewed bodies that each gained one call expression (54 expressions); 8 fixed anchors unchanged; generator verifies observation removal restores the exact input AST. Historical output pins remain independent and unchanged.', plans};
}
if (require.main === module) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const actual = generate();
  if (process.argv[2] === '--write') fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  else assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), actual, 'GUI-source plans match static callback/AST proof');
  console.log('PASS: historical pins unchanged; GUI-source exact admission and all reviewed callbacks verified');
}
module.exports = {generate};
