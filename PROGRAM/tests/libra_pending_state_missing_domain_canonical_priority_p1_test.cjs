'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const sourcePath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const between = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const authoritySource = between(
  "const responseStateBoundaryEvidence =",
  "const loadContinuityStateForResponse = async"
);
const partitionSource = between(
  "const recallCanonicalPriorityPartition =",
  "const buildRecallEvidencePacket ="
);

assert.match(authoritySource, /if \(coverage\.some\(item => !item\)\) return null;/,
  'a missing domain evidence row must prevent construction of an unsafe shared State boundary');
assert.match(partitionSource, /const promoteAllCanonical = authority\.pending === true && !boundary;/,
  'pending State without a safe shared boundary must promote recalled Canonical evidence');
assert.match(partitionSource, /pending_without_safe_boundary_all_canonical_newer/,
  'the conservative no-boundary classification must remain explicit in diagnostics');
assert.match(partitionSource, /const target = promoteAllCanonical\s*\? newer/,
  'the no-boundary branch must route every Canonical row to the newer tier');

const ref = (start, id) => ({
  key: `libra:v1:scope:test:memory:${start}:r1`, status: 'committed',
  memoryId: id, revision: 1, sourceDigest: `digest-${id}`,
  sessionEpoch: 0, turnRange: { start, end: start + 4 }
});
const evidence = row => ({
  memoryId: row.memoryId, revision: row.revision, sourceDigest: row.sourceDigest,
  sessionEpoch: row.sessionEpoch, turnRange: row.turnRange
});
const ready = value => ({
  status: 'ready', evidence: value, sessionEpoch: value.sessionEpoch,
  throughTurn: value.turnRange.end
});
const recallRow = (row, text) => ({
  memoryId: row.memoryId, revision: row.revision, sourceDigest: row.sourceDigest,
  sessionEpoch: row.sessionEpoch, inheritedSessionHistory: false,
  turnRange: row.turnRange, section: 'memory', label: 'memory', text, relevance: 0.9
});
const baseHead = value => ({
  schema: 'libra.continuity_state.v2', scopeKey: 'test', worldlineId: 'main',
  status: 'partial', throughTurn: value.turnRange.end,
  characters: [{ id: 'c1', name: '세아', aliases: [], state: { location: '복도' }, evidence: value }],
  relationships: [], world: [],
  narrative: { summary: '문 앞에서 멈춘 상태', arcs: [], threads: [], locks: [], motifs: [] },
  source: value, basis: { sourceFingerprint: 'fixture' }
});

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const m1 = ref(1, 'm1');
    const m2 = ref(6, 'm2');
    const e1 = evidence(m1);
    const e2 = evidence(m2);
    const refs = [m1, m2];
    const layers = {
      memory: [recallRow(m1, 'T1-5 canonical'), recallRow(m2, 'T6-10 canonical')],
      entity: [], world: [], narrative: []
    };

    const missingDomainHead = baseHead(e2);
    missingDomainHead.domainStatus = {
      characters: ready(e2), relationships: ready(e2),
      world: { status: 'partial', reason: 'world_observation_missing', evidence: null },
      narrative: ready(e2)
    };
    const missing = harness.api.debugResponseStateAuthorityForHead(
      missingDomainHead, refs, { exactBasis: false, sourceMode: 'pruned_last_known' }
    );
    assert.equal(missing.authority.pending, true);
    assert.equal(missing.authority.current, false);
    assert.deepEqual(JSON.parse(JSON.stringify(missing.authority.pendingDomains)), ['world']);
    assert.equal(missing.authority.boundaryEvidence, null,
      'three exact domains cannot create a safe common boundary when one domain has no evidence');

    const conservative = harness.api.debugRecallCanonicalPriorityPartition(layers, missing.authority);
    assert.equal(conservative.boundaryMode, 'pending_without_safe_boundary_all_canonical_newer');
    assert.equal(conservative.newerCount, 2,
      'every recalled Canonical row must outrank a pending State Head with an unknown domain boundary');
    assert.equal(conservative.historicalCount, 0);
    assert.deepEqual(
      JSON.parse(JSON.stringify(conservative.newerThanState.memory.map(row => row.memoryId))),
      ['m1', 'm2']
    );

    const exactBoundaryHead = baseHead(e1);
    exactBoundaryHead.domainStatus = {
      characters: ready(e1), relationships: ready(e1), world: ready(e1), narrative: ready(e1)
    };
    const exact = harness.api.debugResponseStateAuthorityForHead(
      exactBoundaryHead, refs, { exactBasis: false, sourceMode: 'pruned_last_known' }
    );
    assert.equal(exact.authority.pending, true);
    assert.equal(exact.authority.boundaryEvidence.memoryId, 'm1');
    const partitioned = harness.api.debugRecallCanonicalPriorityPartition(layers, exact.authority);
    assert.equal(partitioned.boundaryMode, 'exact_boundary');
    assert.equal(partitioned.newerCount, 1);
    assert.equal(partitioned.historicalCount, 1);
    assert.equal(partitioned.newerThanState.memory[0].memoryId, 'm2');
    assert.equal(partitioned.historicalAtOrBeforeState.memory[0].memoryId, 'm1',
      'the existing exact-boundary behavior must remain intact');
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_pending_state_missing_domain_canonical_priority_p1_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_pending_state_missing_domain_canonical_priority_p1_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
