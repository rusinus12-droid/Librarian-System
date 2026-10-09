'use strict';

const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const ref = (start, id, revision = 1, digest = `d-${id}-r${revision}`) => ({
  key: `libra:v1:scope:test:memory:${start}:r${revision}`,
  status: 'committed', memoryId: id, revision, sourceDigest: digest,
  turnRange: { start, end: start + 4 }, sessionEpoch: 0
});
const ev = row => ({
  memoryId: row.memoryId, revision: row.revision, sourceDigest: row.sourceDigest,
  sessionEpoch: row.sessionEpoch || 0, turnRange: row.turnRange
});
const ready = evidence => ({ status: 'ready', sessionEpoch: evidence.sessionEpoch || 0, throughTurn: evidence.turnRange.end, evidence });
const layerRow = (row, section, text) => ({
  memoryId: row.memoryId, revision: row.revision, sourceDigest: row.sourceDigest,
  sessionEpoch: row.sessionEpoch || 0, inheritedSessionHistory: false,
  turnRange: row.turnRange, section, label: section, text, relevance: 0.9
});

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
    const m1 = ref(1, 'm1');
    const m2 = ref(6, 'm2');
    const m3 = ref(11, 'm3');
    const e1 = ev(m1), e2 = ev(m2), e3 = ev(m3);
    const refs = [m1, m2, m3].map(row => ({
      key: row.key, memoryId: row.memoryId, revision: row.revision, sourceDigest: row.sourceDigest,
      sessionEpoch: row.sessionEpoch, start: row.turnRange.start, end: row.turnRange.end
    }));

    const staleHead = {
      schema: 'libra.continuity_state.v2', scopeKey: 'test', worldlineId: 'main', status: 'ready', throughTurn: 10,
      characters: [{ id: 'c1', name: '세아', aliases: [], state: { location: '복도' }, fieldEvidence: { location: e2 }, evidence: e2 }],
      relationships: [], world: [], narrative: { summary: 'T10 시점의 현재 서사', arcs: [], threads: [], turningPoints: [], locks: [], motifs: [] },
      domainStatus: { characters: ready(e2), relationships: ready(e2), world: ready(e2), narrative: ready(e2) },
      source: e2, basis: { sourceFingerprint: 'stale' }
    };
    const stale = api.debugResponseStateAuthorityForHead(staleHead, refs, { exactBasis: false, sourceMode: 'pruned_last_known' });
    assert.equal(stale.authority.authority, 'last_known_non_authoritative');
    assert.equal(stale.authority.current, false);
    assert.equal(stale.authority.pending, true);
    assert.deepEqual(JSON.parse(JSON.stringify(stale.authority.pendingDomains)).sort(), ['characters', 'narrative', 'relationships', 'world']);
    assert.equal(stale.authority.boundaryEvidence.memoryId, 'm2');
    assert.equal(stale.head.domainStatus.characters.status, 'not_updated');
    assert.equal(stale.head.domainStatus.characters.evidence.memoryId, 'm2', 'last-known evidence must be retained');
    assert.equal(stale.head.domainStatus.characters.attemptedEvidence.memoryId, 'm3', 'newer canonical frontier must be visible as pending attempt');

    const layers = {
      memory: [layerRow(m1, 'memory', 'T1-5'), layerRow(m3, 'memory', 'T11-15')],
      entity: [layerRow(m2, 'characters', 'T6-10')],
      world: [], narrative: []
    };
    const partition = api.debugRecallCanonicalPriorityPartition(layers, stale.authority);
    assert.equal(partition.newerCount, 1);
    assert.equal(partition.historicalCount, 2);
    assert.equal(partition.newerThanState.memory[0].memoryId, 'm3');
    assert.deepEqual(JSON.parse(JSON.stringify(partition.historicalAtOrBeforeState.memory.map(row => row.memoryId))), ['m1']);
    assert.deepEqual(JSON.parse(JSON.stringify(partition.historicalAtOrBeforeState.entity.map(row => row.memoryId))), ['m2']);

    const currentHead = structuredClone(staleHead);
    currentHead.status = 'ready';
    currentHead.throughTurn = 15;
    currentHead.source = e3;
    currentHead.domainStatus = { characters: ready(e3), relationships: ready(e3), world: ready(e3), narrative: ready(e3) };
    currentHead.characters[0].state.location = '옥상';
    currentHead.characters[0].fieldEvidence.location = e3;
    currentHead.characters[0].evidence = e3;
    const current = api.debugResponseStateAuthorityForHead(currentHead, refs, { exactBasis: true, sourceMode: 'current_basis' });
    assert.equal(current.authority.authority, 'target_canonical_chain');
    assert.equal(current.authority.current, true);
    assert.equal(current.authority.pending, false);
    assert.equal(current.authority.boundaryEvidence.memoryId, 'm3');
    const currentPartition = api.debugRecallCanonicalPriorityPartition(layers, current.authority);
    assert.equal(currentPartition.newerCount, 0);
    assert.equal(currentPartition.historicalCount, 3);

    // Active-revision guard: old r1 State provenance must not rescue when the active manifest points to r2.
    const m2r2 = ref(6, 'm2', 2, 'd-m2-r2');
    const revisionManifest = { memories: { 1: m1, 6: m2r2, 11: m3 }, inheritedMemories: [] };
    const rescueHead = structuredClone(staleHead);
    rescueHead.domainStatus.characters = ready(e2);
    const staleRevisionRescue = api.debugClassicProvenanceRescueFromHead(rescueHead, revisionManifest, '세아는 지금 어디 있어?');
    assert.equal(staleRevisionRescue.active, false, 'Classic rescue must never cross the active canonical revision');
    assert.equal(staleRevisionRescue.rawStateInjected, false);

  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_classic_authority_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_classic_authority_runtime_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
