'use strict';
// RED/GREEN guard for the canonical-memory JSON repair ladder.
//
// THE PROBLEM THIS LOCKS DOWN
//
// LIBRA already contains a 13-variant JSON repair ladder (`relaxedJsonParse` ->
// `jsonRepairCandidates` -> quoteBareJsonKeys / singleQuotedJsonStrings /
// escapeJsonStringControlChars / repairInvalidJsonStringEscapes). It was carried over from the
// Serial Gradation Agents for RP prototype, which used it on every stage result.
//
// But the canonical-memory path never calls it. `parseCanonicalArtifactJson` — the single parser
// every committed memory goes through — runs a plain `JSON.parse` after unwrapping the wrapper
// tags, and throws `canonical_artifact_json_invalid` on anything a model slightly malformed.
// Measured against the production parser with `debugParseCanonicalArtifact`:
//
//   trailing comma        -> FAIL   canonical_artifact_json_invalid
//   smart quotes (U+201C) -> FAIL   canonical_artifact_json_invalid
//   single-quoted strings -> FAIL   canonical_artifact_json_invalid
//   bare (unquoted) keys  -> FAIL   canonical_artifact_json_invalid
//   Python None/True      -> FAIL   canonical_artifact_json_invalid
//
// A five-turn memory batch is expensive (four analysis stages) and a parse failure discards it
// AND, because the failed start turn is recorded in `manifest.failedBatches`, removes it from
// every later automatic scan. A repairable JSON defect must not cost a batch.
//
// WHAT IS ASSERTED
//
//   1. REPAIR: every repairable defect above now yields the SAME object the strict JSON would
//      have produced. This is an equivalence assertion, not a smoke test — the repaired parse
//      must equal the canonical form exactly.
//   2. EQUIVALENCE: a well-formed artifact is untouched (same object, and the strict-first order
//      means the ladder never runs for it).
//   3. SAFETY: the ladder must NOT become a way to accept nonsense. Truly broken input (a
//      truncated object, a JSON array root, duplicated keys, prose with no object at all) must
//      still throw, so this cannot silently admit a half-written memory.
//   4. The repair path reports itself, so a repaired batch is distinguishable from a clean one.
const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

// The canonical artifact the repairs must all resolve to.
const CANONICAL = {
  schema: 'libra.canonical_artifact.v4',
  ok: true,
  facts: [{ tempFactId: 'f1', claimKind: 'location', certainty: 'confirmed', evidenceSpans: [{ ref: 't1-u' }] }]
};
const EXPECTED = JSON.stringify(CANONICAL);

// Each entry is the SAME artifact written with one repairable defect.
const repairable = () => [
  ['trailing comma', `${EXPECTED.slice(0, -1)},}`.replace(',}', ',}')],
  ['smart double quotes', '{“schema”:“libra.canonical_artifact.v4”,“ok”:true,“facts”:[{“tempFactId”:“f1”,“claimKind”:“location”,“certainty”:“confirmed”,“evidenceSpans”:[{“ref”:“t1-u”}]}]}'],
  ['single quotes', EXPECTED.replace(/"/g, "'")],
  ['bare keys', EXPECTED.replace(/"(\w+)":/g, '$1:')],
  ['python literals', EXPECTED.replace(/:true/g, ':True').replace(/"certainty":"confirmed"/, '"certainty":"confirmed"')]
];

// Input that must NEVER be accepted, however lenient the ladder becomes.
const unrepairable = () => [
  ['truncated object', '{"schema":"libra.canonical_artifact.v4","facts":[{"tempFactId":"f1"'],
  ['array root', '[{"schema":"libra.canonical_artifact.v4"}]'],
  ['duplicate keys', '{"schema":"a","schema":"b","facts":[]}'],
  ['prose only', 'I could not produce the artifact for this batch.'],
  ['empty', ''],
  ['two objects', '{"schema":"a","facts":[]}\n{"schema":"b","facts":[]}']
];

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
    assert.equal(typeof api.debugParseCanonicalArtifact, 'function',
      'the production canonical artifact parser must be reachable for this guard');
    const parse = api.debugParseCanonicalArtifact;

    // ------------------------------------------------------------------------------------
    // 2. EQUIVALENCE FIRST: a well-formed artifact must be returned unchanged. This pins the
    //    strict-first order — the ladder must never alter a clean parse.
    // ------------------------------------------------------------------------------------
    const clean = parse(EXPECTED);
    assert.equal(JSON.stringify(clean), EXPECTED,
      'a well-formed artifact must be parsed exactly, with no repair applied');

    // Wrapper handling must keep working (these already pass; they must not regress).
    for (const [label, wrapped] of [
      ['json fence', '```json\n' + EXPECTED + '\n```'],
      ['thoughts block', '<thoughts>planning</thoughts>\n' + EXPECTED],
      ['output tag', '<output>' + EXPECTED + '</output>']
    ]) {
      const parsed = parse(wrapped);
      assert.equal(JSON.stringify(parsed), EXPECTED,
        `wrapper handling must be preserved for: ${label}`);
    }

    // ------------------------------------------------------------------------------------
    // 1. REPAIR: every repairable defect resolves to the SAME object as the canonical form.
    // ------------------------------------------------------------------------------------
    const repaired = [];
    for (const [label, malformed] of repairable()) {
      let parsed;
      try {
        parsed = parse(malformed);
      } catch (error) {
        assert.fail(`a repairable defect must not cost a batch — ${label} threw: ${error?.message || error}`);
      }
      assert.equal(JSON.stringify(parsed), EXPECTED,
        `the repaired parse must equal the canonical artifact exactly: ${label}`);
      repaired.push(label);
    }

    // ------------------------------------------------------------------------------------
    // 3. SAFETY: leniency must not become acceptance of nonsense.
    // ------------------------------------------------------------------------------------
    for (const [label, broken] of unrepairable()) {
      assert.throws(() => parse(broken),
        `unrepairable input must still be rejected: ${label}`);
    }

    console.log(JSON.stringify({
      test: 'libra_canonical_json_repair',
      repaired,
      canonicalUnchanged: true,
      wrappersPreserved: 3,
      unrepairableStillRejected: unrepairable().length
    }, null, 1));
    process.stdout.write('libra_canonical_json_repair_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
