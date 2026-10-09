'use strict';
// RED/GREEN lock for the normal-turn side-write DELIVERY defect.
//
// THE DEFECT (measured with the real Gemma-4)
//
// The normal turn is a side-write: no separate model call. The response model receives the packet
// contract appended to its generation prompt and must enclose exactly one packet in the
// HAYAKU_STATE_PACKET_START / HAYAKU_STATE_PACKET_END markers. The parser requires BOTH
// (`hasCompleteHayakuPacketMarkers`), and the plugin's capture inspection finds nothing without them.
//
// But the shipped prompt never states the START marker:
//
//   full contract     mentions HAYAKU_STATE_PACKET_START : false
//   compact contract  mentions it                       : false
//   critical contract mentions it                       : false
//   format example    shows any marker                  : false
//   completion seal   mentions HAYAKU_STATE_PACKET_END  : true   (and START: false)
//
// The seal says "FINAL CONTENT MUST END WITH: HAYAKU_STATE_PACKET_END -->" — it names the END and
// says only "both packet markers" for the pair. Driven with the real prompt, Gemma-4 wrote exactly
// what it was told: a correct packet BODY inside a Markdown fence, then `HAYAKU_STATE_PACKET_END -->`
// with no start marker — 3 of 3 attempts. The plugin then discarded the packet (validCount 0) while
// the SAME body with both markers was accepted (validCount 1). It also fenced the JSON, because
// nothing forbids a fence on this path.
//
// WHAT THIS TEST LOCKS
//
//   1. The completion seal NAMES the start marker, not just the count, and states the opening
//      `<!--` form — so the marker is copyable rather than guessable.
//   2. The contract forbids Markdown fences on this path, so a conforming answer is pure JSON.
//   3. The seal still states the END marker and the "end with" requirement (the existing contract
//      that other tests and the parser depend on).
//   4. The instruction stays small: this is a delivery fix, not a license to grow the prompt.
//
// Asserted by RUNNING the builders, because a string check would pass on a builder that never takes
// the branch.
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ messages: [] });
  try {
    const t = runtime.hayaku._test;
    const settings = { memoryLanguage: 'source' };

    const seal = t.buildPacketTerminalCompletionSeal(settings);
    const full = t.buildPacketCoreStaticWriteInstruction(settings);
    const compact = t.buildPacketCoreCompactWriteInstruction(settings);
    const critical = t.buildPacketCoreCompactWriteInstruction(settings, { critical: true });

    // ------------------------------------------------------------------------------------
    // 1. The seal must NAME the start marker (the parser needs it and the prompt never stated it).
    //
    //    It must NOT decorate it as an HTML comment: shown as `<!-- HAYAKU_STATE_PACKET_START`, the
    //    real model mirrored the `<!-- ` around the CLOSING marker too, and the trailing `<!-- `
    //    landed inside the packet body (the parser slices between the markers) → json_parse_failed.
    //    That reproduced across three wordings, so the rule is: name the marker bare.
    // ------------------------------------------------------------------------------------
    const START = 'HAYAKU_STATE_PACKET_START';
    const END = 'HAYAKU_STATE_PACKET_END';

    assert.ok(seal.includes(START),
      `the completion seal must name ${START} — it is the marker the parser requires and the prompt never states `
      + `(seal was: ${JSON.stringify(seal.slice(0, 200))})`);
    assert.ok(seal.includes(END),
      'the completion seal must keep naming the end marker');
    // No HTML-comment decoration anywhere in the seal: that decoration is what the model copies.
    assert.ok(!seal.includes('<!--'),
      `the seal must NOT show the HTML-comment form — the real model mirrors it around the closing marker `
      + `and the stray "<!-- " lands inside the packet body (seal was: ${JSON.stringify(seal.slice(0, 240))})`);
    // The marker must be presented as a copyable literal with nothing glued to it.
    assert.match(seal, new RegExp(`${START}(?![\\w.])`),
      `the start marker must be followed by a line break, never punctuation — the real model copies whatever is glued to it`);
    assert.match(seal, new RegExp(`${END}(?![\\w.])`),
      'the end marker must also stand alone');
    // The shape BETWEEN the markers must be stated: one JSON value, nothing else.
    assert.match(seal, /between those two lines|between the markers/i,
      'the seal must describe what belongs BETWEEN the markers');
    assert.match(seal, /exactly one JSON value/i,
      'the seal must state the body is exactly one JSON value');
    assert.match(seal, /starts with \{ and ends with \}/i,
      'the seal must state the body\'s first and last characters, so nothing can trail the JSON');

    // ------------------------------------------------------------------------------------
    // 2. Fences must be forbidden where the model can see it.
    //
    //    The model receives the contract AND the seal, so the rule may live in either; what matters
    //    is that it is present in the text the model gets. Checked on the combined prompt, because
    //    that is the artefact under test — asserting on one half would pass while the other half
    //    silently carried nothing.
    // ------------------------------------------------------------------------------------
    const combined = `${full}\n${seal}`;
    const forbidsFence = text => /(no|never|without|do not|don't)[^.\n]{0,40}(markdown|fence|```|code block)/i.test(text)
      || /(markdown|fence)[^.\n]{0,40}(forbidden|not allowed|prohibited)/i.test(text);
    assert.ok(forbidsFence(combined),
      `the normal-turn prompt must forbid Markdown fences (a real model fenced its packet); contract ${full.length} + seal ${seal.length} chars`);

    // ------------------------------------------------------------------------------------
    // 3. The existing contract must survive: the end marker is stated, and the packet is still
    //    required to come last (wording may vary — the requirement may not).
    // ------------------------------------------------------------------------------------
    assert.match(seal, new RegExp(`${END}`),
      'the seal must state the end marker');
    assert.match(seal, /final line|END WITH|last/i,
      'the seal must state that the end marker comes at the end of the content');

    // ------------------------------------------------------------------------------------
    // 4. This must stay a delivery fix: no runaway growth.
    //
    //    The bound is measured, not guessed. Growing a seal that a small model must follow is not
    //    free, so the ceiling is set just above the size the fix actually needs:
    //      base reminder + fence rule + opener line + end line + body-shape line
    //    The body-shape clause is deliberately the largest part — it is what stopped the model from
    //    repeating `<!--` after the JSON — so the ceiling accounts for it rather than squeezing it.
    // ------------------------------------------------------------------------------------
    assert.ok(seal.length < 850,
      `the seal must stay compact (got ${seal.length} chars)`);
    assert.ok(full.length < 7000,
      `the full contract must not balloon (got ${full.length} chars)`);
    assert.ok(compact.length < 6000 && critical.length < 6000,
      'the compact/critical contracts must not balloon either');

    console.log(JSON.stringify({
      test: 'hayaku_normal_turn_delivery',
      sealNamesStartMarker: true,
      sealShowsOpeningForm: true,
      sealNamesEndMarker: true,
      contractForbidsFence: true,
      sizes: { seal: seal.length, full: full.length, compact: compact.length, critical: critical.length }
    }, null, 1));
    process.stdout.write('hayaku_normal_turn_delivery_test: PASS\n');
  } finally {
    await runtime.dispose?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
