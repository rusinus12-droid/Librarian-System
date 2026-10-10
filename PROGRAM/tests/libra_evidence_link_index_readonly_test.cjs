'use strict';
// Stage 1 must not perturb anything the product already produces.
// With the index enabled, the recall result, the canonical memory bytes and the Head bytes
// must be identical to a run where the index stays off, and the off state must be inert:
// no index key, no write, no timer.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const INDEX_KEY = /evidence-link-index/;
const results = [];
async function test(name, fn) { const f = await fixture(); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }
const plain = value => JSON.parse(JSON.stringify(value));
// Per-run identity and wall-clock stamps differ between any two runs regardless of the index;
// every other field must match exactly.
const VOLATILE = new Set(['updatedAt', 'snapshotDigest', 'builtAt', 'buildMs', 'runId', 'createdAt', 'at', 'embedding']);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
// Exactly ONE field may differ between the index being on and off: the feature's OWN diagnostic.
// That is the whole point of the field — off reports `graph_recall_disabled`, on reports what the
// expansion found — and it is not something a model receives. Everything else stays strictly compared,
// and the diagnostic itself is asserted by content below rather than skipped.
//
// This is a correction, not a relaxation. The earlier assertion compared whole objects and passed only
// because the key was ABSENT in both states, so it was vacuous for the one field that could ever differ.
// Naming the exception and asserting its value is strictly stronger than comparing two absences.
const RECALL_DIAGNOSTIC_ONLY_FIELD = 'associativeRecall';
const withoutFeatureDiagnostic = value => {
  const copy = plain(value);
  if (copy && typeof copy === 'object' && copy.diagnostics && typeof copy.diagnostics === 'object') {
    delete copy.diagnostics[RECALL_DIAGNOSTIC_ONLY_FIELD];
  }
  return stable(copy);
};
// Derived embedding retry status and basis snapshot hashes can move between runs; every
// canonical field must not.
const memoryBytes = f => JSON.stringify(stable(f.getMemory()));
const headBytes = f => JSON.stringify(stable(f.getHead()));
const run = async options => {
  const f = await fixture(options);
  const generated = await f.run();
  assert.equal(generated.completed, 1, JSON.stringify(generated));
  return f;
};

(async () => {
  await test('disabled by default: inert, and no index is stored', async () => {
    const f = await run({});
    try {
      const disabled = await f.r.api.getEvidenceLinkIndex({});
      assert.equal(disabled.available, false);
      assert.equal(disabled.reason, 'evidence_link_index_disabled');
      assert.equal(disabled.providerCalls, 0);
      assert.equal([...f.r.values.keys()].some(key => INDEX_KEY.test(key)), false, 'no index key may be written when off');
      assert.equal(f.r.storageWrites.some(write => INDEX_KEY.test(write.key)), false, 'no index write may occur when off');
      // A read-only query on a disabled index must not fail, and must not create state.
      assert.equal([...f.r.values.keys()].some(key => INDEX_KEY.test(key)), false);
    } finally { await f.r.cleanup(); }
  });

  await test('enabled: recall result, canonical bytes and Head bytes are unperturbed', async () => {
    const off = await run({});
    let offRecall, offMemory, offHead, offDiagnostic, offDeliveredMemories;
    try {
      const recall = plain(await off.r.api.previewUnifiedMemoryRecall('도서관 공연 허가'));
      offDiagnostic = recall?.diagnostics?.[RECALL_DIAGNOSTIC_ONLY_FIELD];
      offDeliveredMemories = recall.memories;
      offRecall = withoutFeatureDiagnostic(recall);
      offMemory = memoryBytes(off);
      offHead = headBytes(off);
    } finally { await off.r.cleanup(); }

    const on = await run({ args: { evidence_link_index_enabled: 'true' } });
    try {
      const index = await on.r.api.getEvidenceLinkIndex({});
      assert.equal(index.schema, 'libra.evidence_link_index.v1');
      assert.equal([...on.r.values.keys()].some(key => INDEX_KEY.test(key)), true, 'the index is stored when on');

      const recall = plain(await on.r.api.previewUnifiedMemoryRecall('도서관 공연 허가'));
      const onDiagnostic = recall?.diagnostics?.[RECALL_DIAGNOSTIC_ONLY_FIELD];
      const onRecall = withoutFeatureDiagnostic(recall);
      assert.deepEqual(onRecall, offRecall,
        'recall output must be identical with the index on, apart from the feature diagnostic named above');
      assert.equal(memoryBytes(on), offMemory, 'canonical memory bytes must be unchanged');
      assert.equal(headBytes(on), offHead, 'Head bytes must be unchanged');

      // The one exempted field is asserted BY CONTENT in both directions, so the exception cannot hide a
      // change: off must say the feature is disabled, on must say it ran and reached nothing here.
      assert.equal(offDiagnostic?.mode, 'disabled', 'with the index off the diagnostic reports the feature disabled');
      assert.equal(offDiagnostic?.reason, 'graph_recall_disabled');
      assert.equal(offDiagnostic?.active, false);
      assert.equal(offDiagnostic?.providerCalls, 0);
      assert.equal(onDiagnostic?.mode, 'observation_only', 'with the index on the diagnostic reports the observation mode');
      assert.equal(onDiagnostic?.active, false, 'this corpus reaches nothing, and the report says so rather than staying silent');
      assert.equal(onDiagnostic?.reason, 'no_reachable_candidate');
      assert.equal(onDiagnostic?.providerCalls, 0, 'the observation adds no provider call');
      // Neither state may leak a memory body into the diagnostic.
      for (const diagnostic of [offDiagnostic, onDiagnostic]) {
        const serialized = JSON.stringify(diagnostic || {});
        for (const field of ['canonicalArtifact', 'recallKeys', 'embedding', 'vectorRecord']) {
          assert.equal(serialized.includes(`"${field}"`), false,
            `the recall diagnostic must not carry \`${field}\``);
        }
      }

      // The DELIVERED memories are compared with the SAME per-run filter the rest of this suite uses, so
      // the exemption above cannot mask a change in what a model receives — that is the assertion the
      // Stage 1 contract actually exists for. Compared with `stable` because a run id, a timestamp and a
      // basis digest differ between ANY two runs; measured: those four fields are the only difference.
      assert.deepEqual(stable(recall.memories), stable(offDeliveredMemories),
        'the delivered memory set must be the same with the index on and off');

      const added = [...on.r.values.keys()].filter(key => INDEX_KEY.test(key));
      assert.equal(added.length, 1, `exactly one index key may be added, saw ${JSON.stringify(added)}`);
      assert.equal(added[0], `libra:v1:scope:${on.getHead().scopeKey}:evidence-link-index:v1`);
    } finally { await on.r.cleanup(); }
  });

  await test('enabled: the current view quotes the Head instead of rewriting it', async () => {
    const f = await run({ args: { evidence_link_index_enabled: 'true' } });
    try {
      const before = JSON.stringify(f.getHead());
      const index = await f.r.api.getEvidenceLinkIndex({});
      assert.ok(index.current.fields.length > 0);
      assert.equal(JSON.stringify(f.getHead()), before, 'building the index must not mutate the Head');

      // The current holder is quoted from the Head field evidence, not recomputed from facts.
      const key = index.entities.find(entity => entity.name === '은빛 열쇠');
      const holder = index.current.fields.find(field => field.entityId === key.id && field.field === 'holderRef');
      assert.equal(holder.memoryId, 'mem_000001');
      assert.equal(holder.revision, 1);
      assert.deepEqual(plain(holder.assertionIds), ['f11']);

      // The view names the basis it was read from, and the names are the Head's own values.
      const head = f.getHead();
      assert.equal(index.current.headBasis.sourceFingerprint, head.basis.sourceFingerprint);
      assert.equal(index.current.headBasis.sourceCount, head.basis.sourceCount);
      assert.equal(index.current.headBasis.throughTurn, head.throughTurn);
      assert.equal(index.current.headBasis.reviewedThroughCanonical, String(head.reviewedThroughCanonical || ''));
      assert.equal(index.current.headBasis.changedThroughCanonical, String(head.changedThroughCanonical || ''));
    } finally { await f.r.cleanup(); }
  });

  await test('enabled: a second read reuses the stored index', async () => {
    const f = await run({ args: { evidence_link_index_enabled: 'true' } });
    try {
      const first = await f.r.api.getEvidenceLinkIndex({});
      const second = await f.r.api.getEvidenceLinkIndex({});
      assert.equal(second.signature, first.signature, 'an unchanged basis must keep the same signature');
      assert.equal(second.status.builtAt, first.status.builtAt, 'an unchanged basis must not rebuild');
      const forced = await f.r.api.getEvidenceLinkIndex({ force: true });
      assert.notEqual(forced.status.builtAt, first.status.builtAt, 'force must rebuild');
      assert.equal(forced.signature, first.signature, 'a rebuild of the same basis yields the same signature');
    } finally { await f.r.cleanup(); }
  });

  console.log(JSON.stringify({ suite: 'libra_evidence_link_index_readonly', passed: results.length, tests: results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
