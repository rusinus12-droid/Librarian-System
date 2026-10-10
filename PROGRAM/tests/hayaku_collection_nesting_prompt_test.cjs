'use strict';
// Regression test: the packet contract must say WHERE each collection lives.
//
// MEASURED (2026-09-20, real Gemma-4): the recovery prompt listed the axes and the canonical
// collections on adjacent lines with the same `axis[keys]` shape:
//   "packet holds exactly six object-valued keys: meta, entity, world, narrative, planner, importance."
//   "Canonical collections (arrays of records): meta[speaker_boundaries, overpromotion_risks]; entity[...]"
// The model put speaker_boundaries and overpromotion_risks at packet's TOP level, and
// validateNativeRepairEnvelopeShape rejected the answer (native_repair_packet_top_level_invalid) with
// shapeKeys listing eight keys. Moving those two into meta made the same answer valid.
//
// So this test pins the prompt text: it must tie each collection to its own axis, and it must forbid
// collection names as keys of packet itself. A prompt that only lists them can be read either way.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(PLUGIN, 'utf8');

const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const t = runtime.hayaku._test;
    assert.equal(typeof t.nativePacketAuthoringPrompt, 'function', 'the authoring prompt builder must be exposed');

    for (const kind of ['incremental_recovery', 'after_request_recovery', 'cold_start']) {
      const prompts = t.nativePacketAuthoringPrompt(kind, { memoryLanguage: 'source' });
      const system = String(prompts?.primary || '');
      assert.ok(system.length > 0, `${kind}: the prompt must not be empty`);

      // Every canonical collection must be introduced with its axis, not as a bare bracket list.
      const canonical = system.match(/Canonical collections[^\n]*/);
      assert.ok(canonical, `${kind}: the canonical-collections line must be present`);
      const line = canonical[0];
      assert.ok(/holds/.test(line) || /under its axis/i.test(line),
        `${kind}: each collection must be tied to its axis, got: ${line.slice(0, 200)}`);
      assert.ok(!/^\s*Canonical collections \(arrays of records\): [a-z_]+\[/.test(line.replace(/\\/g, '')),
        `${kind}: the bare axis[...] list shape is what misled the model`);

      // And the six-key exclusivity must be stated outright.
      assert.ok(/Never add these collection names as keys of packet itself/i.test(system),
        `${kind}: the prompt must forbid collection names at packet's top level`);
      assert.ok(/exactly six|exactly these/i.test(system),
        `${kind}: the prompt must still state the six-key rule`);

      // The shape validator itself must still reject an answer with a stray top-level collection.
      const { createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');
      const packet = createValidPacket({ turn: 2, subject: 'Alice', summary: 'Alice checked the gauge.' });
      const envelope = { schema: 'hayaku.native_repair_output.v1', packet, grounding: [] };
      const clean = t.validateNativeRepairEnvelopeShape(JSON.parse(JSON.stringify(envelope)));
      assert.equal(clean.ok, true, `${kind}: the six-key packet must validate`);

      const stray = JSON.parse(JSON.stringify(envelope));
      stray.packet.speaker_boundaries = [];
      const rejected = t.validateNativeRepairEnvelopeShape(stray);
      assert.equal(rejected.ok, false, `${kind}: a stray top-level collection must be rejected`);
      assert.equal(rejected.reason, 'native_repair_packet_top_level_invalid',
        `${kind}: the rejection must name the top-level key problem`);

      // The same content placed correctly must pass — this is what the prompt change asks for.
      const moved = JSON.parse(JSON.stringify(stray));
      delete moved.packet.speaker_boundaries;
      moved.packet.meta.speaker_boundaries = [];
      const accepted = t.validateNativeRepairEnvelopeShape(moved);
      assert.equal(accepted.ok, true, `${kind}: the same collection under meta must validate`);
    }
  } finally {
    await runtime.dispose?.();
  }
  console.log('PASS hayaku collection nesting: every prompt ties collections to their axis, forbids collection keys at packet top level, and the validator still rejects them there');
})().catch(error => { console.error(error); process.exitCode = 1; });
