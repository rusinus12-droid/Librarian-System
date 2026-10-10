'use strict';
// Stage 5 (second requirement): associative recall must behave identically in all three storage modes.
//
// Stage 1 and Stage 2 each proved their index is mode-independent. Stage 3/4 is the first increment that
// CONSUMES those indexes inside a live recall, so a mode-dependent difference here would change what a
// model actually receives — a far more consequential failure than a projection reading differently. The
// contract is therefore the same but the stakes are higher:
//
//   1. The expansion really ran in every mode (an expansion that silently failed open would report the
//      same "nothing to add" three times and pass every equality check below).
//   2. The OBSERVATION is mode-independent: the same reached candidate, the same outcome, the same budget
//      verdict, the same zero provider cost.
//   3. The delivered result is mode-independent: the same selected memory refs.
//   4. Safety is mode-independent: no mode gains a provider call, and no mode mutates canonical or Head.
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
const VOLATILE_OBSERVATION = new Set(['builtAt', 'buildMs']);
const stableObservation = value => Object.fromEntries(Object.entries(value || {})
  .filter(([key]) => !VOLATILE_OBSERVATION.has(key)));

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
      observation,
      deliveredRefs: arr(recalled.memories).map(entry => String(entry?.memory?.memoryId || '')),
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
    active: o.observation.active,
    reachedMemories: o.observation.reachedMemories,
    added: arr(o.observation.added), agreed: arr(o.observation.agreed), omitted: arr(o.observation.omitted),
    deliveredRefs: o.deliveredRefs,
    providerCallsAdded: o.providerCallsAdded,
    canonicalUnmoved: o.canonicalUnmoved, headUnmoved: o.headUnmoved
  })), null, 1));

  // 1. The expansion really ran in every mode. Without this, three identical "found nothing" reports would
  //    satisfy every equality check below while the feature was dead in all three.
  for (const o of observations) {
    assert.equal(o.participationEnabled, true, `${o.mode}: participation is on when the flag is set`);
    assert.equal(o.observation.active, true,
      `${o.mode}: the expansion must reach across the shared entities: ${JSON.stringify(o.observation)}`);
    assert.ok(Number(o.observation.reachedMemories) >= 1, `${o.mode}: at least one memory was reached`);
    assert.ok(arr(o.observation.candidates).length >= 1, `${o.mode}: the reached candidate is reported`);
  }

  // 2. The observation is mode-independent. Storage location must never change which memory a link finds
  //    or what the report says about it.
  const [first, ...rest] = observations;
  for (const o of rest) {
    assert.deepEqual(o.observation, first.observation,
      `${o.mode}: the associative observation must match ${first.mode} (storage mode must not change it)`);
  }

  // 3. The delivered result is mode-independent — this is what a model actually receives.
  for (const o of rest) {
    assert.deepEqual(o.deliveredRefs, first.deliveredRefs,
      `${o.mode}: the delivered recall must match ${first.mode}`);
  }

  // 4. Safety is mode-independent.
  for (const o of observations) {
    assert.equal(o.providerCallsAdded, 0, `${o.mode}: associative admission adds no provider call`);
    assert.equal(o.canonicalUnmoved, true, `${o.mode}: canonical bytes are unchanged by a recall`);
    assert.equal(o.headUnmoved, true, `${o.mode}: Head bytes are unchanged by a recall`);
    assert.equal(o.observation.budgetUnchanged, true, `${o.mode}: the candidate budget is not enlarged`);
  }

  process.stdout.write('libra_associative_recall_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
