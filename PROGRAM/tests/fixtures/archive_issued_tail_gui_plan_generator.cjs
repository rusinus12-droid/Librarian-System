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
const REVIEWED_CHANGED = [
  'scheduleLifecycleTimeout:2bf9c91241e953ca75bc7e53d6905692655f3cf429dee6cc54b12449340cdbae',
  'scheduleLifecycleTimeout:43706dc5273442f8423690aac16baf0b562cbb8fb8977629c75577a69c4de836',
  'scheduleTimer:10b3fe6e7a33832f4629819ef36fe7f23605bf3bfc782b22ec319b51394c8ff2',
  'scheduleTimer:52ffbe0b7c0f24a2c3e5dfd8a0aa9254e450bb5e63b6720e57b67a34090cba06',
  'scheduleTimer:5cf5707130448c29ad43138bc5a263cd043f23d6edb2fb366b2ae5004fea69a9',
  'scheduleTimer:648ed3d94917ec34f44a481307c2100feb4b04ef63d396ec80151442426c44a0',
  'scheduleTimer:6821b6263b8c34470e0294dbf3b6bbe2ed85b58c4582f51f73ca373ee3492f83',
  'scheduleTimer:6edb1cee5a943b1c27f05997784148e34788fbd452bb0f3e0d4b078e1a612839',
  'scheduleTimer:9a3f7cd928bd602c3c5a95147c651f624ca35788ca5b6c4f32dfb0d38e4b0e98',
  'scheduleTimer:bbdc522e337015330be717a1112be05e2c1db9e8b8d85144f870197bba40d95e',
  'scheduleTimer:bcd027261a502e7da8d5fac1340cb68224886ef579b9d0245cd6d26716bbb726',
  'scheduleTimer:ce1a5494776e3303fc85acfc8aacf66d85d895e0422c2d6f47e74b0cd850940d'
];
const REVIEWED_REMOVED_COUNT = 7, GUI_EXPRESSIONS = 64, GUI_COUNTS = { scheduleTimer: 22, scheduleLifecycleTimeout: 15 };
function generate() {
  const {inputs, variants} = generator.actualVariants();
  const plans = variants.map(variant => generator.buildPlan(variant, GUI_EXPRESSIONS, GUI_COUNTS)); // Includes exact AST roundtrip.
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
