'use strict';
// T03 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (contract D02 in MAIN_MEMORY_CONTRACT_DECISIONS.md v2)
//
// RED BEFORE GREEN. D02 requires a v5 canonical artifact to be READABLE while
// the writer keeps writing v4 ("reader deployed before writer"; D02's deployment
// order is (1) v5 reader -> (2) mixed replay -> (3) writer).
//
// What this suite drives:
//   part 1  the acceptance surface -- `debugPrepareUnifiedMemoryArtifact` and
//           `debugValidateUnifiedArtifact`, the same entry points production uses
//           (`quarantineUnifiedProviderRecords` and `validateUnifiedArtifact`).
//   part 2  a real cold start through the deployed plugin, to prove the WRITER
//           still emits v4 after the reader learns v5. A reader change that
//           silently relabels what gets written would be worse than no change.
//
// Why the v5 artifact is honest evidence rather than a fabricated pass: it is
// built by the product's own `artifact()` fixture and ONLY the schema string is
// swapped. Entities, facts, evidence spans and bindings are the real fixture, so
// a reader that "accepts v5" while actually reinterpreting v4 bytes cannot pass
// -- the content is byte-identical to the v4 twin it is compared against.
//
// Measured before the fix (a FINDING, not a guess): the v4 twin validates, and
// the v5 label is refused with `UNIFIED_SCHEMA_INVALID`.
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const V4 = 'libra.canonical_artifact.v4';
const V5 = 'libra.canonical_artifact.v5';
const V99 = 'libra.canonical_artifact.v99';

const clone = value => JSON.parse(JSON.stringify(value));
// The batch is the five U+A pairs the validator requires (`UNIFIED_FIVE_PAIRS_REQUIRED`,
// BATCH_SIZE = 5). `canonicalEvidenceSources` reads `pair.turn` plus `pair.user.text` /
// `pair.assistant.text` and derives the refs `t<turn>-u` / `t<turn>-a` itself -- the same
// refs the artifact's evidence spans point at -- so the batch is rebuilt in that shape
// rather than passed through in the chat's row shape.
const batch = (() => {
  const pairs = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    const user = input.sourceRows.find(row => row.ref === `t${turn}-u`);
    const assistant = input.sourceRows.find(row => row.ref === `t${turn}-a`);
    pairs.push({ turn, user: { text: user.text }, assistant: { text: assistant.text } });
  }
  return pairs;
})();

async function openHarness() { return await fixture(); }

(async () => {
  const f = await openHarness();
  const r = f.r;
  try {
    const api = r.api;
    assert.equal(typeof api.debugPrepareUnifiedMemoryArtifact, 'function',
      'the public debug surface exposes the prepare entry point');
    assert.equal(typeof api.debugValidateUnifiedArtifact, 'function',
      'the public debug surface exposes the validate entry point');

    // --- control: the real v4 artifact must keep its exact behaviour -------
    const v4 = artifact();
    const v4Prepared = api.debugPrepareUnifiedMemoryArtifact(clone(v4), batch);
    const v4Validated = api.debugValidateUnifiedArtifact(v4Prepared.artifact, batch);
    assert.equal(v4Validated.ok, true,
      `the v4 control artifact validates (issues: ${JSON.stringify(v4Validated.issues)})`);
    assert.equal(v4Prepared.artifact.facts.length, v4.facts.length,
      'the v4 control keeps every fact through prepare');

    // --- the artifact under test: identical content, v5 label --------------
    const v5 = clone(v4);
    v5.schema = V5;
    const v5Prepared = api.debugPrepareUnifiedMemoryArtifact(clone(v5), batch);
    const v5Validated = api.debugValidateUnifiedArtifact(v5Prepared.artifact, batch);

    // D02: a v5 artifact is READABLE. The same content that validates as v4
    // must validate as v5 -- otherwise the reader cannot serve new data at all.
    assert.equal(v5Validated.ok, true,
      `a v5-labeled artifact validates like its v4 twin (issues: ${JSON.stringify(v5Validated.issues)})`);
    assert.equal(v5Prepared.artifact.facts.length, v4Prepared.artifact.facts.length,
      'a v5 artifact does not lose facts that its v4 twin keeps');

    // "Readable" must mean the same BYTES reach the reader, not merely that a gate
    // opened. A v5 artifact renders through the same projection as its v4 twin, so
    // downstream consumers cannot tell the two apart by content.
    const renderV4 = api.debugRenderUnifiedArtifact(v4);
    const renderV5 = api.debugRenderUnifiedArtifact(v5);
    assert.equal(renderV5, renderV4,
      'a v5 artifact renders to exactly the same text as its v4 twin');
    assert.ok(renderV5.length > 0, 'the rendered text is not empty');

    // --- an unknown FUTURE schema must fail closed, without data loss ------
    const future = clone(v4);
    future.schema = V99;
    const futurePrepared = api.debugPrepareUnifiedMemoryArtifact(clone(future), batch);
    const futureValidated = api.debugValidateUnifiedArtifact(futurePrepared.artifact, batch);
    assert.equal(futureValidated.ok, false,
      'an unknown future schema is refused, not accepted as a known one');
    assert.ok(futureValidated.issues.length > 0,
      'the refusal names an issue instead of failing silently');
    // Data loss check: the refusal must not have emptied the artifact.
    assert.equal(asRecords(futurePrepared.artifact.facts).length, v4.facts.length,
      'refusing an unknown schema keeps the supplied facts (no silent deletion)');

    // --- A30: one bad optional fact must not discard the valid ones --------
    // The corruption is applied to a fact nothing else depends on, so "the other
    // facts survive" is a real isolation claim and not an artefact of the
    // dependency graph.
    const corrupt = clone(v4);
    const victim = corrupt.facts.find(fact => fact.tempFactId === 'f9'); // knowledge
    assert.ok(victim, 'the fixture carries the fact used for the isolation check');
    victim.evidenceSpans = [{ ref: 't9-a', quote: 'this quote appears in no source row' }];
    const corruptPrepared = api.debugPrepareUnifiedMemoryArtifact(clone(corrupt), batch);
    const corruptValidated = api.debugValidateUnifiedArtifact(corruptPrepared.artifact, batch);
    const survivedIds = asRecords(corruptPrepared.artifact.facts).map(fact => fact.tempFactId);
    assert.ok(!survivedIds.includes('f9'),
      'the fact whose evidence cannot be bound is not admitted');
    assert.ok(survivedIds.includes('f5') && survivedIds.includes('f13'),
      'facts unrelated to the bad one are still admitted (A30 partial acceptance)');
    assert.equal(corruptValidated.ok, true,
      `the remaining artifact still validates (issues: ${JSON.stringify(corruptValidated.issues)})`);
    assert.equal(corruptPrepared.admission?.status, 'partial',
      'the admission record reports a partial result rather than hiding the drop');
    assert.ok(asRecords(corruptPrepared.admission?.rejected).some(row => row.id === 'f9'),
      'the dropped fact is named in the admission record');

    // --- part 2: the WRITER's label rule (T03) -----------------------------
    // D02/T03b: "v5 로 라벨링된 것만 v5 로 쓴다". An UNLABELLED provider artifact keeps
    // the v4 default, so no existing flow changes behaviour and an older build can
    // still read everything this build writes.
    const committed = await f.run();
    assert.equal(committed.completed, 1, 'the cold start commits one batch');
    const memory = f.getMemory(1);
    assert.ok(memory, 'the committed memory is readable');
    assert.equal(memory.artifactSchema, V4, 'the writer labels an unlabelled artifact v4');
    assert.equal(memory.canonicalArtifact?.schema, V4,
      'the written artifact inside the memory is v4');
    assert.equal(f.getManifest()?.memories?.['1']?.artifactSchema, V4,
      'the manifest ref is v4');

    // --- part 3: an explicitly v5-labelled artifact keeps its label ---------
    // And every surface that names the schema must AGREE: a record whose artifact
    // says v5 while its ref says v4 would be a silent relabel in the other
    // direction, which D02 forbids just as firmly.
    const v5Run = await fixture();
    try {
      const labelled = artifact();
      labelled.schema = V5;
      v5Run.control.artifact = labelled;
      assert.equal((await v5Run.run()).completed, 1, 'the v5-labelled batch commits');
      const v5Memory = v5Run.getMemory(1);
      const v5Ref = v5Run.getManifest()?.memories?.['1'];
      assert.equal(v5Memory?.artifactSchema, V5, 'a v5-labelled artifact is stored as v5');
      assert.equal(v5Memory?.canonicalArtifact?.schema, V5, 'its artifact keeps the v5 schema');
      assert.equal(v5Ref?.artifactSchema, V5, 'and the manifest ref agrees');
      assert.equal(v5Memory.artifactSchema, v5Memory.canonicalArtifact.schema,
        'the record label and its artifact never disagree');
    } finally {
      await v5Run.r.cleanup();
    }

    console.log(JSON.stringify({
      test: 'libra_main_memory_schema_compatibility',
      passed: 1,
      boundary: 'real deployed LIBRA public debug surface + a real cold start; v5 label on a real fixture artifact; no external calls',
      results: {
        v4: { ok: v4Validated.ok, facts: v4Prepared.artifact.facts.length, issues: v4Validated.issues },
        v5: { ok: v5Validated.ok, facts: v5Prepared.artifact.facts.length, issues: v5Validated.issues, renderBytes: renderV5.length, renderIdenticalToV4: renderV5 === renderV4 },
        future: { ok: futureValidated.ok, issues: futureValidated.issues, factsKept: asRecords(futurePrepared.artifact.facts).length },
        partial: { status: corruptPrepared.admission?.status, rejected: asRecords(corruptPrepared.admission?.rejected).length, factsKept: survivedIds.length },
        written: { artifactSchema: memory.artifactSchema, refSchema: f.getManifest()?.memories?.['1']?.artifactSchema ?? null },
        v5Written: { record: V5, note: 'explicit v5 label honoured end to end' }
      }
    }));
  } finally {
    await r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

function asRecords(value) {
  return Array.isArray(value) ? value : [];
}
