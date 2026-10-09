'use strict';
// THE INDEPENDENT REVIEW'S THREE FINDINGS, LOCKED AS REGRESSIONS.
//
// R1 (P1, hayaku): a leading fragment that FAILED to parse let a truncated trailing envelope be
//      closed and adopted as a COMPLETED turn. `roots.length === 0` was read as "the answer is one
//      object", but a broken leading fragment never reaches roots — it is recorded in issues — so
//      `{"broken":}<unclosed envelope>` took the single-envelope repair path. The valid-sibling
//      case was already refused, which is exactly why the broken-sibling case looked covered.
// R2 (P2, libra): the string-preservation pass in transformJsonOutsideStrings recognised only
//      double quotes, while the ladder it feeds also accepts single-quoted documents. A
//      single-quoted body therefore received the code-mode rewrites (True/False/None, trailing
//      comma) — a syntax-only repair silently changing CONTENT.
// R3 (P2, libra): the SGA artifact parser scanned the ORIGINAL text for duplicate keys and then
//      accepted relaxedJsonParse's output unchecked. Smart-quoted keys are invisible to the
//      original scan and become plain keys during repair, so `{"ok":false,"ok":true}` was
//      approved as ok:true.
//
// Each case below FAILS on the pre-fix revision and passes now. Measured against 690ed0c:
//   node review_artifacts/prompt_fix_independent_review_20260920/independent_probes.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require(path.resolve(__dirname, 'fixtures', 'libra_unified_runtime_fixture.cjs'));
const H = require(path.resolve(__dirname, 'fixtures', 'hayaku_runtime_harness.cjs'));

const PROGRAM = path.resolve(__dirname, '..');

// ── R1 ────────────────────────────────────────────────────────────────────────────────────────
const sentence = 'Alice waited by the door. Bob waited by the gate.';
const makeEnvelope = () => {
  const packet = H.createValidPacket({ turn: 2, subject: 'Alice', summary: sentence });
  for (const axis of ['entity', 'world', 'narrative', 'planner']) {
    for (const [key, value] of Object.entries(packet[axis])) if (Array.isArray(value)) packet[axis][key] = [];
  }
  packet.entity.characters = [{ name: 'Alice' }];
  packet.meta.summary_memory = { summary: sentence };
  return {
    schema: 'hayaku.native_repair_output.v1', packet,
    grounding: [
      { path: 'entity.characters[0]', source: 'target', evidence: [sentence] },
      { path: 'meta.summary_memory.summary', source: 'target', evidence: [sentence] }
    ]
  };
};
const msg = (role, id, data) => ({ role, id, chatId: id, data });

const repairWith = async raw => {
  const runtime = await H.createHayakuRuntime({
    autoRepair: false,
    messages: [
      msg('user', 'u1', 'Enter.'),
      msg('assistant', 'a1', H.hiddenPacketMessage('Alice entered.', H.createValidPacket({ turn: 1 }))),
      msg('user', 'u2', 'Continue.'),
      msg('assistant', 'a2', sentence)
    ],
    llmResponder: async () => ({ type: 'success', result: raw })
  });
  try { return await runtime.hayaku.recovery.repairNow(); }
  finally { await runtime.dispose(); }
};

(async () => {
  const report = { hayaku: {}, libra: {} };
  const json = JSON.stringify(makeEnvelope());

  // A complete single envelope still repairs.
  const complete = await repairWith(json);
  report.hayaku.complete = { repaired: complete.repaired === true, outcome: complete.outcome };
  assert.equal(complete.repaired, true, 'a complete envelope must keep repairing');

  // One unfinished envelope is still recovered — the behaviour this fix must NOT lose.
  const single = await repairWith(json.slice(0, -1));
  report.hayaku.single_unclosed = { repaired: single.repaired === true, outcome: single.outcome };
  assert.equal(single.repaired, true,
    `a single envelope missing only its closing brace must still be repaired (${JSON.stringify(single)})`);

  // A VALID sibling in front already refused; keep that.
  const validSibling = await repairWith('{}\n' + json.slice(0, -1));
  report.hayaku.valid_sibling_then_unclosed = { repaired: validSibling.repaired === true, outcome: validSibling.outcome };
  assert.notEqual(validSibling.repaired, true, 'a valid sibling must not be adopted as one complete answer');

  // THE P1 REGRESSION: a BROKEN sibling in front must refuse too. Before the fix this returned
  // repaired:true / outcome:completed, i.e. a partial answer stored as a whole turn.
  const brokenSibling = await repairWith('{"broken":}\n' + json.slice(0, -1));
  report.hayaku.invalid_sibling_then_unclosed = {
    repaired: brokenSibling.repaired === true,
    outcome: brokenSibling.outcome, reason: brokenSibling.reason
  };
  assert.notEqual(brokenSibling.repaired, true,
    `a BROKEN leading fragment must not let the whole answer count as complete (${JSON.stringify(brokenSibling)})`);

  // ── R2 / R3 through the shipped SGA parser ────────────────────────────────────────────────
  // The accessor must be reachable from BOTH surfaces: the core object and the public `f.r.api`
  // wrapper (the same pair the reviewer's probe wires). Injecting only the core leaves api.reviewParse
  // undefined — a mistake this suite made on its first run.
  const instrument = source => {
    const coreAnchor = '      debugNormalizeSgaPatchResult: ';
    const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
    for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
      if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
    }
    return source
      .replace(coreAnchor,
        '      reviewParse: value => parseStrictSgaArtifactJson(value, {schema: SGA_LENGTH_CORRECTION_SCHEMA, required:["schema","ok","draft"]}),\n' + coreAnchor)
      .replace(publicAnchor,
        '    reviewParse(value) { return LibraMemoryCore.reviewParse(value); },\n' + publicAnchor);
  };
  const f = await fixture({ transformSource: instrument });
  try {
    const parse = f.r.api.reviewParse;
    assert.equal(typeof parse, 'function', 'the parser accessor must be present');

    const BODY = 'True North / None / False / a,}';

    // R2: a single-quoted body must survive byte-for-byte.
    const single = parse("{'schema':'libra.sga_length_correction.v2','ok':true,'draft':'" + BODY + "'}");
    report.libra.single_quoted_body = { draft: single.draft, preserved: single.draft === BODY };
    assert.equal(single.draft, BODY,
      `a single-quoted body must not be rewritten (got "${single.draft}")`);

    // The same body in the double-quoted spelling, with the trailing comma the model adds.
    const dq = '{"schema":"libra.sga_length_correction.v2","ok":true,"draft":"' + BODY + '",}';
    const doubled = parse(dq);
    report.libra.double_quoted_body = { draft: doubled.draft, preserved: doubled.draft === BODY };
    assert.equal(doubled.draft, BODY,
      `a double-quoted body must not be rewritten (got "${doubled.draft}")`);

    // Apostrophes inside a double-quoted body must also stay put.
    const apos = parse('{schema:"libra.sga_length_correction.v2",ok:true,draft:"He said \'True\' and \'False\'."}');
    report.libra.apostrophes_in_body = { draft: apos.draft };
    assert.equal(apos.draft, "He said 'True' and 'False'.",
      `apostrophes inside a body must survive (got "${apos.draft}")`);

    // R3: a duplicate written in smart quotes must be REJECTED, not collapsed to its last value.
    let smartRejection = '';
    try { parse('{“schema”:“libra.sga_length_correction.v2”,“ok”:false,“ok”:true,“draft”:“finished”}'); }
    catch (error) { smartRejection = String(error?.message || error); }
    report.libra.smart_quote_duplicate = { rejection: smartRejection };
    assert.match(smartRejection, /duplicate_key/,
      `a smart-quoted duplicate must be rejected (got "${smartRejection}")`);

    // Controls: the repair must not have been weakened.
    const clean = parse('{"schema":"libra.sga_length_correction.v2","ok":true,"draft":"x"}');
    report.libra.control_clean = { ok: clean.ok === true };
    assert.equal(clean.ok, true, 'a clean artifact must still be accepted');
    let okFalse = '';
    try { parse('{"schema":"libra.sga_length_correction.v2","ok":false,"draft":"x"}'); }
    catch (error) { okFalse = String(error?.message || error); }
    report.libra.control_ok_false = { rejection: okFalse };
    assert.notEqual(okFalse, '', 'ok:false must still be rejected');
  } finally {
    await f.r.cleanup();
  }

  console.log(JSON.stringify(report, null, 1));
  console.log('libra_hayaku_independent_review_regressions_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_hayaku_independent_review_regressions_test: FAIL');
  process.exitCode = 1;
});
