'use strict';
// Retirement contract (was: Stage 5 associative-recall 3-mode parity).
//
// The Stage 3/4 associative link-expansion participation was removed with the Classic retrieval path when the
// unified memory engine replaced it (9c03c35; docs/LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md).
// What stays true, and what this test now verifies in all three storage modes:
//
//   1. The associative surface reports itself retired and never participates, even when the legacy
//      associative_recall_enabled flag is set; its observation is the unified engine's access trace.
//   2. The unified recall of the same two-batch corpus is mode-independent: the same delivered memories and the
//      same engine access trace.
//   3. Safety is mode-independent: no mode gains a provider call, and no mode mutates canonical or Head.
const assert = require('node:assert/strict');
const { serverFixture, withLorebook } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const plain = value => JSON.parse(JSON.stringify(value));
const arr = value => (Array.isArray(value) ? value : []);

// Canonical data lives in a DIFFERENT authority per mode, so it is read through whichever store the mode
// actually uses. `snapshot.getMemory`/`getHead` read server rows only, which is why a direct call returns
// undefined in plugin_only — the same reason the sibling 3-mode suites carry the same two helpers.
const MANIFEST_KEY = /:manifest$/;
const HEAD_KEY = /:continuity-state$/;
const localJson = (snapshot, matcher) => {
  const key = [...snapshot.local.keys()].find(matcher);
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const manifestOf = snapshot => snapshot.getManifest() || localJson(snapshot, key => MANIFEST_KEY.test(key));
const memoryOf = (snapshot, start = 1) => {
  const server = snapshot.getMemory(start);
  if (server) return server;
  const ref = manifestOf(snapshot)?.memories?.[String(start)];
  if (!ref?.key) return null;
  const raw = snapshot.local.get(ref.key);
  return raw ? JSON.parse(raw) : null;
};
const headOf = snapshot => snapshot.getHead() || localJson(snapshot, key => HEAD_KEY.test(key));

// Fields that legitimately vary between runs and carry no contract: the timestamp and the measured
// duration. Everything else must match across modes.
// The access trace's generation, index digest, workspace and resource byte accounting are storage-keyed and
// legitimately differ per mode; schema, authority, lane, frontier and coverage are the mode-independent contract.
const STABLE_TRACE_FIELDS = ['schema', 'authority', 'lane', 'frontier', 'coverage'];
const stableObservation = value => Object.fromEntries(Object.entries(value || {})
  .filter(([key]) => STABLE_TRACE_FIELDS.includes(key)));

async function observeFor(mode) {
  const snapshot = await serverFixture({
    mode,
    args: { evidence_link_index_enabled: 'true', lore_link_index_enabled: 'true', associative_recall_enabled: 'true' }
  });
  try {
    withLorebook(snapshot.f);
    assert.equal((await snapshot.f.run()).completed, 1, `${mode}: the batch committed`);

    // A second batch whose artifact carries only part of the first batch's facts, so the two committed
    // memories hold DIFFERENT entity sets. That is what makes a link reachable at all: when both memories
    // name every entity, every index record is already a direct candidate and the honest report is
    // "nothing to add" — three times, in all three modes, which would prove nothing.
    const shifted = JSON.parse(JSON.stringify(snapshot.f.control.artifact));
    for (const row of [...shifted.entities, ...shifted.facts]) {
      for (const span of row.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + 5}`);
    }
    shifted.facts = shifted.facts.slice(0, 4);
    shifted.stateBindings = [];
    const extra = snapshot.f.chat.message.slice(0, 10).map((message, index) => ({
      ...message, chatId: `t${6 + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
    }));
    snapshot.f.chat.message.push(...extra);
    snapshot.f.control.artifact = shifted;
    assert.equal((await snapshot.f.run()).completed, 1, `${mode}: the second batch committed`);

    const callsBefore = snapshot.f.control.calls.length;
    const memoryBefore = JSON.stringify(plain(memoryOf(snapshot)));
    const headBefore = JSON.stringify(plain(headOf(snapshot)));

    // The shared fact is historical: use an explicit past query so a current authoritative Head cannot
    // make an unrelated old fact look current merely because it names the same entity.
    const recalled = plain(await snapshot.f.r.api.previewUnifiedMemoryRecall('예전 은빛 열쇠'));
    const callsAfter = snapshot.f.control.calls.length;

    const diagnostics = plain(await snapshot.f.r.api.getAssociativeRecallDiagnostics());
    const observation = stableObservation(diagnostics.observation);

    return {
      mode,
      participationEnabled: diagnostics.participationEnabled === true,
      retired: diagnostics.retired === true,
      available: diagnostics.available === true,
      engine: diagnostics.engine,
      observation,
      // Graph node ids hash the mode's storage keys and rank ties order by them, so the mode-independent
      // contract is the multiset of delivered canonical memories plus the number of graph nodes.
      deliveredRefs: arr(recalled.memories).map(entry => String(entry?.memory?.memoryId || ''))
        .map(id => (id.startsWith('libra.node.v1:') ? 'graph-node' : id)).sort(),
      providerCallsAdded: callsAfter - callsBefore,
      canonicalUnmoved: JSON.stringify(plain(memoryOf(snapshot))) === memoryBefore,
      headUnmoved: JSON.stringify(plain(headOf(snapshot))) === headBefore
    };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await observeFor(mode));

  console.log(JSON.stringify(observations.map(o => ({
    mode: o.mode,
    retired: o.retired, participationEnabled: o.participationEnabled,
    observationKeys: Object.keys(o.observation),
    deliveredRefs: o.deliveredRefs,
    providerCallsAdded: o.providerCallsAdded,
    canonicalUnmoved: o.canonicalUnmoved, headUnmoved: o.headUnmoved
  })), null, 1));

  // 1. The retired surface stays retired in every mode, regardless of the legacy flag, and says what replaced it.
  for (const o of observations) {
    assert.equal(o.participationEnabled, false, `${o.mode}: associative participation is retired even when the legacy flag is set`);
    assert.equal(o.retired, true, `${o.mode}: the associative diagnostics report retired`);
    assert.equal(o.available, false, `${o.mode}: the associative diagnostics are not available`);
    assert.equal(o.engine, 'unified', `${o.mode}: the replacement engine is named`);
    assert.equal(o.observation.schema, 'libra.graph_access_trace.v1', `${o.mode}: the unified engine access trace is exposed instead`);
    assert.equal(o.observation.authority, 'descriptive_only', `${o.mode}: the trace is descriptive, never authority`);
    assert.ok(o.deliveredRefs.length >= 1 && o.deliveredRefs.every(Boolean), `${o.mode}: the unified recall delivers memories`);
  }

  // 2. The unified recall is mode-independent: same trace, same delivered memories.
  const [first, ...rest] = observations;
  for (const o of rest) {
    assert.deepEqual(o.observation, first.observation,
      `${o.mode}: the unified engine access trace must match ${first.mode} (storage mode must not change it)`);
    assert.deepEqual(o.deliveredRefs, first.deliveredRefs,
      `${o.mode}: the delivered recall must match ${first.mode}`);
  }

  // 3. Safety is mode-independent.
  for (const o of observations) {
    assert.equal(o.providerCallsAdded, 0, `${o.mode}: recall adds no provider call`);
    assert.equal(o.canonicalUnmoved, true, `${o.mode}: canonical bytes are unchanged by a recall`);
    assert.equal(o.headUnmoved, true, `${o.mode}: Head bytes are unchanged by a recall`);
  }

  process.stdout.write('libra_associative_recall_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
