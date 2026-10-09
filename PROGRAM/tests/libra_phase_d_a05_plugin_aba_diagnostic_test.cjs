'use strict';

// Diagnostic for the plugin_only A05 revision boundary. The local pluginStorage
// contract exposes values, not monotonic revisions. An A->B->A between candidate
// preparation and commit therefore returns the State digest to its baseline.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const transformSource = source => {
  const needle = /const candidate=buildUnifiedStateCandidate\(memory,\{\.\.\.basis,head:snapshot\.head,registry:snapshot\.registry,threadTargetIndex\},verified\.manifest\);/g;
  assert.equal(source.match(needle)?.length || 0, 1, 'State candidate hook anchor is unique');
  return source.replace(needle,
    `const candidate=buildUnifiedStateCandidate(memory,{...basis,head:snapshot.head,registry:snapshot.registry,threadTargetIndex},verified.manifest);\n        if(typeof globalThis.__phaseDPluginAba==='function') await globalThis.__phaseDPluginAba({mode:'state_candidate',candidate:clone(candidate),basis:clone(basis)});`);
};
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const parse = raw => JSON.parse(raw);
const shiftedArtifact = offset => {
  const value = artifact();
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
    }
  }
  return value;
};

(async () => {
  const snapshot = await serverFixture({ mode: 'plugin_only', transformSource });
  try {
    const f = snapshot.f;
    f.control.onCall = () => ({ type: 'success', result: JSON.stringify(shiftedArtifact(f.control.calls.length > 1 ? 5 : 0)) });
    const first = await f.run();
    assert.equal(first.completed, 1, 'baseline local State is created before ABA');
    const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
    assert.ok(key, 'plugin_only has a local authoritative continuity State key');
    const beforeRaw = snapshot.local.get(key);
    const beforeHead = parse(beforeRaw);
    assert.equal(beforeHead.throughTurn, 5, 'baseline State is at the first five-pair frontier');

    fiveMore(f);
    const observation = { injected: false, key, beforeSha256: sha(beforeRaw), beforeThroughTurn: beforeHead.throughTurn,
      observedStorageRevision: null, writes: [] };
    f.r.context.__phaseDPluginAba = async ({ candidate, basis }) => {
      if (observation.injected) return;
      assert.equal(basis.scopeKey, beforeHead.scopeKey, 'candidate is prepared against the same local scope');
      observation.candidateThroughTurn = candidate.head?.throughTurn;
      assert.equal(observation.candidateThroughTurn, 10, 'the T10 State candidate exists before external local writes');
      const currentA = snapshot.local.get(key);
      const valueA = parse(currentA);
      const valueB = { ...valueA, phaseDLocalAbaDiagnostic: 'temporary B' };
      const rawB = JSON.stringify(valueB);
      await snapshot.backend.setItem(key, rawB);
      observation.writes.push({ label: 'B', sha256: sha(snapshot.local.get(key)), throughTurn: parse(snapshot.local.get(key)).throughTurn });
      await snapshot.backend.setItem(key, currentA);
      const afterA = snapshot.local.get(key);
      observation.writes.push({ label: 'A', sha256: sha(afterA), throughTurn: parse(afterA).throughTurn });
      observation.afterAsha256 = sha(afterA);
      observation.sameValueAfterABA = afterA === currentA;
      observation.injected = true;
    };

    const second = await f.run();
    delete f.r.context.__phaseDPluginAba;
    assert.equal(observation.injected, true, 'local A->B->A was injected after candidate preparation');
    assert.equal(observation.sameValueAfterABA, true, 'the authoritative local bytes return exactly to A');
    assert.equal(observation.afterAsha256, observation.beforeSha256, 'A->B->A returns the byte digest to its baseline');
    assert.equal(observation.observedStorageRevision, null, 'pluginStorage exposes no monotonic revision value');
    const afterHead = parse(snapshot.local.get(key));
    observation.afterSha256 = sha(snapshot.local.get(key));
    observation.afterThroughTurn = afterHead.throughTurn;
    observation.staleCandidateCommitted = second.completed === 1 && afterHead.throughTurn === 10;
    assert.equal(observation.staleCandidateCommitted, true,
      'current plugin_only digest guard permits the prepared T10 candidate after the equal-byte A->B->A');

    console.log(JSON.stringify({
      test: 'libra_phase_d_a05_plugin_aba_diagnostic',
      diagnostic: 'A05 plugin_only lacks a monotonic local State revision; equal-byte ABA passes the current content-digest guard',
      status: 'BLOCKED',
      result: observation,
      boundary: 'synthetic provider, actual plugin_only local pluginStorage and public run route; diagnostic defect reproduction only, no server revision/receipt claim'
    }));
  } finally {
    await snapshot.cleanup();
  }
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
