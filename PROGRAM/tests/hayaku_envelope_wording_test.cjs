'use strict';
// RED/GREEN lock for the packet-envelope wording defect.
//
// THE DEFECT (measured with the real Gemma-4, not inferred)
//
// `packetSchemaV2WriteInstruction(settings)` is built ONCE and consumed by TWO paths whose envelope
// requirements DIFFER:
//
//   normal turn  — `packetRegularAuthoringRules` spreads it into the contract. There the packet IS
//                  the top level, written inside HAYAKU_STATE_PACKET_START/END, so the sentence
//                  "Use strict JSON with exactly six object-valued keys: meta, entity, ..." is
//                  CORRECT.
//   recovery     — `buildHayakuPacketAuthoringProfile().schemaInstructions` feeds
//                  `nativePacketAuthoringPrompt`. There the packet is nested under `packet` inside
//                  {schema, packet, grounding}, so the same sentence must say `packet.meta`,
//                  `packet.entity`, ... and does not.
//
// Consequence, measured: the real Gemma-4 returned a correct packet BODY with the envelope missing
// on 3 of 3 attempts, both with reasoning on (571-762 s) and off (96-105 s). Fed into the real
// pipeline, that answer is rejected (validCount 0); the same content wrapped in the envelope is
// accepted (validCount 1).
//
// WHAT THIS TEST LOCKS
//
//   1. The RECOVERY instruction names the nested paths (`packet.meta`, `packet.entity`, ...), so a
//      model reading it cannot mistake the packet body for the top level.
//   2. The recovery instruction still states the envelope and its exact keys, in the SAME line as
//      the key list, so the two statements can no longer compete across 3,762 characters.
//   3. The NORMAL-TURN instruction is UNCHANGED in substance — still six keys WITHOUT the `packet.`
//      prefix — because that path's packet really is the top level. A fix that broke this would
//      corrupt the normal contract.
//   4. Both paths still carry the envelope requirement appropriate to them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');

(async () => {
  // ------------------------------------------------------------------------------------
  // The instruction must be callable in both shapes, so the fix is a parameter rather than a
  // second, drifting copy of the same text.
  // ------------------------------------------------------------------------------------
  // The builder now takes a second parameter (an envelope switch) and has a block body, so locate
  // its parameter list by taking the text between the first `(` after its name and the matching `)`.
  const builderNameAt = PLUGIN.indexOf('const packetSchemaV2WriteInstruction =');
  assert.ok(builderNameAt >= 0, 'the schema instruction builder must exist');
  const parenStart = PLUGIN.indexOf('(', builderNameAt);
  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < PLUGIN.length && i < parenStart + 400; i += 1) {
    if (PLUGIN[i] === '(') depth += 1;
    else if (PLUGIN[i] === ')') { depth -= 1; if (depth === 0) { parenEnd = i; break; } }
  }
  assert.ok(parenEnd > parenStart, 'the builder must expose its parameter list');
  const params = PLUGIN.slice(parenStart + 1, parenEnd);
  assert.match(params, /settings/,
    'the builder must keep its settings parameter');
  // A second parameter is the switch. Its NAME may be anything (`options`), so assert the shape
  // (more than one parameter) rather than guessing the identifier.
  assert.ok(params.split(',').length >= 2,
    'the builder must take a second (switch) parameter, so one instruction serves both envelopes');
  // And the switch must actually be CONSUMED — that is the property that matters.
  const builderBody = PLUGIN.slice(parenEnd, PLUGIN.indexOf('const buildHayakuPacketAuthoringProfile', parenEnd));
  assert.match(builderBody, /options\s*\.\s*\w+/,
    'the builder must read the switch from its options');
  assert.match(builderBody, /envelope\s*===?\s*true|inEnvelope/,
    'the switch must be a boolean envelope test');

  // ------------------------------------------------------------------------------------
  // 1 + 2. The RECOVERY shape names the nested paths AND states the envelope keys in the same line.
  //        Asserted by RUNNING the builder, not by reading its source: a string check would pass on
  //        a builder that never takes the branch.
  // ------------------------------------------------------------------------------------
  const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const build = runtime.hayaku._test.packetSchemaV2WriteInstruction;
    assert.equal(typeof build, 'function',
      'the schema instruction builder must be exposed on _test so its two shapes can be executed');

    const nested = build({}, { envelope: true }).join('\n');
    const flat = build({}, {}).join('\n');

    // The nested shape names `packet.meta`, `packet.entity`, ... and the envelope keys.
    for (const key of ['meta', 'entity', 'world', 'narrative', 'planner', 'importance']) {
      assert.ok(nested.includes(`packet.${key}`),
        `the recovery instruction must name packet.${key} (got: ${nested.slice(0, 160)})`);
    }
    assert.match(nested, /schema[\s\S]{0,60}packet[\s\S]{0,60}grounding/,
      'the recovery instruction must name the three envelope keys in the same breath as the packet keys');

    // The flat shape must NOT carry the nested prefix — that path's packet is the top level.
    assert.ok(!/packet\.(meta|entity|world|narrative|planner|importance)/.test(flat),
      'the normal-turn instruction must stay prefix-free');

    // ------------------------------------------------------------------------------------
    // The envelope's OWN schema value must be stated as an explicit assignment.
    //
    // Measured with the real Gemma-4 after the nesting fix landed: the envelope appeared (the
    // `packet` key was present) but the top-level `schema` VALUE was wrong on 3 of 3 attempts —
    // 'hayaku_packet_v1' twice and 'hayaku-packet-authoring-profile-v1' once. Both are strings the
    // prompt contains, and both are attached to an explicit `schema="..."` assignment:
    //   packet.meta.schema="hayaku_packet_v1"
    //   Authoring contract: schema=hayaku-packet-authoring-profile-v1
    // Meanwhile the value the envelope actually needs appeared only in PROSE ("Return one
    // hayaku.native_repair_output.v1 JSON envelope"), never as an assignment the model can copy.
    // So the model copied the assignment pattern it could see.
    // ------------------------------------------------------------------------------------
    assert.match(nested, /schema\s*=\s*"hayaku\.native_repair_output\.v1"/,
      'the envelope schema must be stated as an explicit quoted assignment, not only in prose');
    assert.match(nested, /NOT\s+(?:packet\.meta\.schema|meta\.schema)|not\s+packet\.meta\.schema/i,
      'the instruction must explicitly distinguish the envelope schema from packet.meta.schema');
    // Both values must be present and distinct, so the model never has to infer which is which.
    assert.ok(nested.includes('hayaku.native_repair_output.v1'),
      'the envelope schema value must appear in the recovery instruction');
    assert.ok(/packet\.meta\.schema\s*=\s*"hayaku_packet_v1"/.test(nested),
      'the packet schema value must stay attached to packet.meta');

    // Both must still describe the same schema (one builder, two renderings).
    for (const text of [nested, flat]) {
      assert.ok(text.includes('canonicalAnchors') || text.includes('summary_memory'),
        'both renderings must describe the same packet schema');
      assert.ok(text.includes('overpromotion_risks'),
        'both renderings must carry the same rule set');
    }
  } finally {
    await runtime.dispose?.();
  }

  // ------------------------------------------------------------------------------------
  // 3. The NORMAL-TURN instruction must keep the prefix-free wording.
  // ------------------------------------------------------------------------------------
  const rulesStart = PLUGIN.indexOf('const packetRegularAuthoringRules =');
  const rulesEnd = PLUGIN.indexOf('const packetCompletedFormatExample', rulesStart);
  assert.ok(rulesEnd > rulesStart, 'the normal-turn rules must be bounded');
  const rules = PLUGIN.slice(rulesStart, rulesEnd);
  assert.match(rules, /packetSchemaV2WriteInstruction\(/,
    'the normal-turn rules must still consume the shared instruction');
  assert.ok(!/packetSchemaV2WriteInstruction\([\s\S]{0,80}envelope\s*:\s*true/.test(rules),
    'the normal-turn rules must NOT request the nested shape — its packet is the top level');

  // ------------------------------------------------------------------------------------
  // 4. Both consumers exist and stay wired.
  // ------------------------------------------------------------------------------------
  assert.match(PLUGIN, /schemaInstructions: packetSchemaV2WriteInstruction\(/,
    'the authoring profile must still build schema instructions for the recovery prompt');
  assert.match(PLUGIN, /\.\.\.packetSchemaV2WriteInstruction\(/, 'the normal-turn rules must still spread it');

  console.log(JSON.stringify({
    test: 'hayaku_envelope_wording',
    builderTakesEnvelopeSwitch: true,
    recoveryNamesNestedPaths: true,
    recoveryNamesEnvelopeKeys: true,
    normalTurnStaysPrefixFree: true,
    bothConsumersWired: true
  }, null, 1));
  process.stdout.write('hayaku_envelope_wording_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
