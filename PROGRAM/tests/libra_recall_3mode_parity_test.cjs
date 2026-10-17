'use strict';
// Task 27 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// LIBRA Recall (D5) is proven for `plugin_only` by
// `libra_classic_provenance_rescue_runtime_test.cjs` (provenance/current-state
// rescue) and the character/admission runtime tests. It is `unverified` for `mirror`
// and `server_only`. Recall is where storage correctness becomes USER-VISIBLE: the
// point of storage parity is not "it saved", it is feeding the correct memory back to
// the model. If recall differs per storage mode, the same chat answers differently
// depending on where its data happens to live.
//
// This test runs the REAL recall path in all three modes over an identical corpus and
// asserts the recalled memory set is mode-independent:
//
//   1. every mode recalls the committed canonical memory (the feature really ran)
//   2. the recalled excerpt texts are identical across all three modes
//   3. each mode honours the recall payload budget when it reports one
//   4. mode-specific storage invariants hold (no local owner rows in server_only,
//      server rows present in mirror, local rows present in plugin_only)
//
// This is a parity VERIFICATION, not a fix: it fails loudly if any mode diverges.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
// The largest configured output profile's internal safety cap (extended: 20000).
const RECALL_BLOCK_CAP = 20000;

const CANONICAL_KEY = /:memory:\d+:r\d+$/;
const MANIFEST_KEY = /:manifest$/;

const manifestValue = snapshot => {
  const serverManifest = snapshot.getManifest();
  if (serverManifest) return serverManifest;
  const key = [...snapshot.local.keys()].find(candidate => MANIFEST_KEY.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const canonicalStarts = snapshot => Object.keys(manifestValue(snapshot)?.memories || {})
  .map(Number).sort((left, right) => left - right);

async function recallFor(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    await snapshot.f.run();
    const starts = canonicalStarts(snapshot);
    assert.ok(starts.length >= 1,
      `${mode}: the corpus produced at least one canonical (got ${starts.length})`);

    // Recall through the public entry point, exactly as the chat flow does. The unified
    // engine admits only evidence related to the query, so the query names the corpus'
    // subject; a contentless query correctly recalls nothing in every mode.
    const recall = await snapshot.f.r.api.previewUnifiedMemoryRecall('은빛 열쇠는 누가 가지고 있지?');
    assert.ok(recall && typeof recall === 'object', `${mode}: recall returned an object`);

    const memories = Array.isArray(recall.memories) ? Array.from(recall.memories) : [];
    // The payload is produced inside the plugin VM: values built from its fields carry
    // the VM realm's prototypes, and assert.deepEqual under `assert/strict` compares
    // prototypes — so compare primitives in this realm instead.
    const excerptTexts = Array.from(memories
      .map(row => String(row?.excerpt?.text || row?.text || '').trim())
      .filter(Boolean))
      .sort();

    const serverOwnerRows = snapshot.storedRows()
      .filter(row => CANONICAL_KEY.test(row.key) || MANIFEST_KEY.test(row.key)).length;
    const localOwnerRows = [...snapshot.local.keys()]
      .filter(k => CANONICAL_KEY.test(k) || MANIFEST_KEY.test(k)).length;

    return {
      mode,
      canonicalCount: starts.length,
      memoryCount: memories.length,
      excerptTexts,
      blockChars: Number(recall.blockChars || recall.delivery?.blockChars || 0),
      serverOwnerRows,
      localOwnerRows
    };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await recallFor(mode));

  console.log(JSON.stringify(observations.map(o => ({
    mode: o.mode,
    canonicalCount: o.canonicalCount,
    memoryCount: o.memoryCount,
    blockChars: o.blockChars,
    serverOwnerRows: o.serverOwnerRows,
    localOwnerRows: o.localOwnerRows
  })), null, 1));

  // 1. Every mode must actually recall the committed canonical memory.
  for (const o of observations) {
    assert.ok(o.memoryCount >= 1,
      `${o.mode}: recall returned the committed memory (the feature reached the model)`);
  }

  // 2. The recalled memory set must be identical across modes: storage location must
  //    not change what the model is fed.
  const [first, ...rest] = observations;
  for (const o of rest) {
    assert.equal(JSON.stringify(o.excerptTexts), JSON.stringify(first.excerptTexts),
      `${o.mode}: recalled excerpts must match ${first.mode} (storage mode must not change recall)`);
    assert.equal(o.memoryCount, first.memoryCount,
      `${o.mode}: recalled memory count must match ${first.mode}`);
  }

  // 3. Budget: when the mode reports a delivery size, it stays within the cap.
  for (const o of observations) {
    if (o.blockChars > 0) {
      assert.ok(o.blockChars <= RECALL_BLOCK_CAP,
        `${o.mode}: recall payload must respect the ${RECALL_BLOCK_CAP}-character cap (got ${o.blockChars})`);
    }
  }

  // 4. Mode-specific storage invariants.
  const plugin = observations.find(o => o.mode === 'plugin_only');
  const mirror = observations.find(o => o.mode === 'mirror');
  const server = observations.find(o => o.mode === 'server_only');
  assert.ok(plugin.localOwnerRows >= 1, 'plugin_only keeps the owner rows locally');
  assert.ok(mirror.serverOwnerRows >= 1, 'mirror also holds the owner rows on the server');
  assert.ok(mirror.localOwnerRows >= 1, 'mirror keeps a local copy of the owner rows');
  assert.ok(server.serverOwnerRows >= 1, 'server_only holds the owner rows on the server');
  assert.equal(server.localOwnerRows, 0, 'server_only keeps no owner rows locally');

  process.stdout.write('libra_recall_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
