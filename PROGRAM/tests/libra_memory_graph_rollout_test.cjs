'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const resolveTool = name => {
  const candidates = [
    path.join(__dirname, '..', 'tools', name),
    path.join(__dirname, name)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Cannot resolve tool module: ' + name);
};

const createMemoryGraphIdentity = resolveTool('libra_memory_graph_identity.cjs');
const createMemoryGraphPages = resolveTool('libra_memory_graph_pages.cjs');
const createMemoryGraphReaders = resolveTool('libra_memory_graph_readers.cjs');
const createMemoryGraphIndex = resolveTool('libra_memory_graph_index.cjs');
const createMemoryGraphLane = resolveTool('libra_memory_graph_lane.cjs');
const createMemoryGraphQuery = resolveTool('libra_memory_graph_query.cjs');
const createMemoryGraphCompiler = resolveTool('libra_memory_graph_compiler.cjs');
const createMemoryGraphRollout = resolveTool('libra_memory_graph_rollout.cjs');

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const makeSnapshot = () => ({
  frame: {
    owner: 'libra:plugin_only',
    scopeKey: 'scope-alpha',
    worldlineId: 'main',
    restoreEpoch: 1,
    view: { viewerId: 'owner_reader', temporalView: 'current_owner_page', cutoffTurn: 6 }
  },
  registry: {
    key: 'libra:v1:scope:scope-alpha:entity-registry',
    record: {
      scopeKey: 'scope-alpha',
      fingerprint: 'reg-rev-1',
      entities: [
        { id: 'ent-alice', name: 'Alice', aliases: ['앨리스'], validated: true, status: 'active' },
        { id: 'ent-ring', name: 'Silver Ring', aliases: ['은반지'], validated: true, status: 'active' }
      ]
    }
  },
  claimContracts: {
    possession: { domain: 'character', field: 'heldItemRef', value: 'itemRef' }
  },
  canonical: [
    {
      key: 'libra:v1:scope:scope-alpha:memory:m1',
      ref: { memoryId: 'm1', revision: 'rev-1', sourceDigest: 'dig-1' },
      entityRefs: { e1: 'ent-alice', e2: 'ent-ring' },
      record: {
        memoryId: 'm1',
        revision: 'rev-1',
        sourceDigest: 'dig-1',
        canonicalArtifact: {
          schema: 'libra.canonical_artifact.v5',
          facts: [
            {
              tempFactId: 'f1',
              claimKind: 'possession',
              domain: 'character',
              subjectTempRef: 'e1',
              targetTempRef: 'e2',
              text: 'Alice received the Silver Ring in the archive.',
              values: { itemRef: 'e2', time: 'day-1', turn: 2 },
              evidenceSpans: [{ turn: 2, quote: 'Alice received the Silver Ring' }]
            }
          ]
        }
      }
    }
  ],
  micro: [],
  state: {
    key: 'libra:v1:scope:scope-alpha:state',
    revision: 'state-rev-1',
    correctionKey: 'libra:v1:scope:scope-alpha:corrections',
    corrections: { records: [] },
    view: {
      authority: { current: true, pending: false },
      head: {
        schema: 'libra.continuity_state.v2',
        scopeKey: 'scope-alpha',
        throughTurn: 6,
        domainStatus: { characters: { status: 'ready' } },
        characters: [
          {
            id: 'ent-alice',
            certainty: 'confirmed',
            state: { heldItemRef: 'ent-ring' },
            fieldEvidence: {
              heldItemRef: {
                memoryId: 'm1',
                revision: 'rev-1',
                sourceDigest: 'dig-1',
                assertionIds: ['f1']
              }
            }
          }
        ],
        relationships: [],
        world: [],
        narrative: {}
      }
    }
  },
  lore: {
    revision: 'lore-rev-1',
    selectionBinding: { scopeKey: 'scope-alpha' },
    entries: [
      {
        identity: 'lore-ring-rule',
        entry: { key: 'Vault Rule' },
        rendered: 'The Silver Ring opens the moon vault when Alice wears it.',
        activation: { alwaysActive: false },
        passages: [{ coordinateSpace: 'rendered', start: 0, end: 57 }]
      }
    ],
    index: {
      entries: [
        {
          identity: 'lore-ring-rule',
          passages: [{ start: 0, end: 57, mentions: [{ entityId: 'ent-alice', name: 'Alice', ambiguous: false, confirmed: true }] }]
        }
      ],
      links: [{ identity: 'lore-ring-rule', entityId: 'ent-alice', via: 'name_reference', resolution: 'confirmed' }]
    }
  }
});

const buildEnv = snapshot => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });
  const lane = createMemoryGraphLane({ index, pages });
  const query = createMemoryGraphQuery({ index, lane, pages, fingerprint: sha256 });
  const compiler = createMemoryGraphCompiler({ fingerprint: sha256 });
  const rollout = createMemoryGraphRollout({ index, lane, query, compiler, pages, fingerprint: sha256 });

  const rawGraph = readers.project(snapshot, { nodeLimit: 2048 });
  const graph = {
    ...rawGraph,
    scopeKey: snapshot.frame.scopeKey,
    readerFrame: clone(snapshot.frame)
  };
  return { graph, rollout };
};

test('UM5 & V11: sealed engine mode prevents silent fallback to legacy ranker on partial budget stop or stale final readset', async () => {
  const snap = makeSnapshot();
  const { graph, rollout } = buildEnv(snap);

  const seal = rollout.sealRequestMode({
    mode: 'unified',
    requestId: 'req-unified-1',
    owner: snap.frame.owner,
    scopeKey: snap.frame.scopeKey,
    worldlineId: snap.frame.worldlineId,
    restoreEpoch: snap.frame.restoreEpoch
  });

  // 1. Partial budget stop in Lane (maxPages = 1) must report deliveryOutcome: 'partial' and NEVER run legacy ranker
  const partialExec = await rollout.executeUnifiedRequest({
    sealToken: seal,
    graph,
    queryInput: { queryText: 'silver ring alice' },
    laneBudget: { maxPages: 1, maxBytes: 16384, pageBytes: 512 }
  });
  assert.equal(partialExec.deliveryOutcome, 'partial');
  assert.equal(partialExec.legacyRankerExecuted, false);
  assert.equal(partialExec.legacyCachesRebuilt, false);
  assert.equal(partialExec.queryComplete, false);

  // 2. Final physical readset failure falls back to base_request_only without running legacy ranker
  const staleSnap = makeSnapshot();
  staleSnap.frame.restoreEpoch = 9;
  const staleGraph = buildEnv(staleSnap).graph;
  const rejectedExec = await rollout.executeUnifiedRequest({
    sealToken: seal,
    graph,
    queryInput: { queryText: 'silver ring alice' },
    ownerVerifier: { currentGraph: async () => staleGraph }
  });
  assert.equal(rejectedExec.deliveryOutcome, 'base_request_only');
  assert.equal(rejectedExec.fallbackAction, 'preserve_base_model_request');
  assert.equal(rejectedExec.packet, null);
  assert.equal(rejectedExec.legacyRankerExecuted, false);
  assert.equal(rejectedExec.modelDispatchEligible, false);
});

test('UM5 & V08: shadow evaluation measures recall/precision and intentional State/lore divergence with zero double injection or extra model calls', async () => {
  const snap = makeSnapshot();
  const { graph, rollout } = buildEnv(snap);
  const canonicalUnit = graph.units.find(u => u.family === 'canonical');
  const stateUnit = graph.units.find(u => u.family === 'state');
  const loreUnit = graph.units.find(u => u.family === 'lore');

  // Legacy baseline only knew about the canonical unit; Unified discovers canonical + state + lore!
  const shadow = await rollout.runShadowComparison({
    requestId: 'shadow-case-01',
    graph,
    queryInput: { queryText: 'silver ring alice' },
    legacyBaseline: { admittedNodeIds: [canonicalUnit.nodeId] },
    goldExpectation: {
      expectedNodeIds: [canonicalUnit.nodeId, stateUnit.nodeId, loreUnit.nodeId],
      forbiddenNodeIds: ['forged-ineligible-node']
    },
    ownerVerifier: { currentGraph: async () => graph }
  });

  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.shadowInjectedIntoModelPrompt, false);
  assert.equal(shadow.doubleInjection, false);
  assert.equal(shadow.additionalModelCalls, 0);
  assert.equal(shadow.invariantsPassed, true);
  assert.equal(shadow.metrics.evidenceRecall, 1);
  assert.ok(shadow.metrics.intentionalDivergenceCount >= 2);
  assert.ok(shadow.intentionalDivergence.some(d => d.family === 'state' && d.intentionalReason === 'direct_state_or_lore_graph_participation'));
  assert.ok(shadow.intentionalDivergence.some(d => d.family === 'lore'));
  assert.ok(shadow.unresolvedBlocked.includes('actual_risuai_host_qualification'));
});

test('UM6 & V11: legacy retirement fence rejects duplicate legacy cache/A2/ranker execution under unified mode', () => {
  const snap = makeSnapshot();
  const { rollout } = buildEnv(snap);

  const unifiedSeal = rollout.sealRequestMode({
    mode: 'unified',
    requestId: 'req-cutover-1',
    owner: snap.frame.owner,
    scopeKey: snap.frame.scopeKey,
    worldlineId: snap.frame.worldlineId,
    restoreEpoch: snap.frame.restoreEpoch
  });
  const fence = rollout.createLegacyExecutionFence(unifiedSeal);
  assert.equal(fence.status().cleanCutoverVerified, true);

  assert.throws(
    () => fence.assertLegacyAllowed('recallCatalogCache'),
    /LIBRA_GRAPH_ROLLOUT_LEGACY_DUPLICATE_EXECUTION_FORBIDDEN/
  );
  assert.equal(fence.status().cleanCutoverVerified, false);
  assert.equal(fence.status().duplicateExecutionCount, 1);

  const legacySeal = rollout.sealRequestMode({
    mode: 'legacy',
    requestId: 'req-legacy-1',
    owner: snap.frame.owner,
    scopeKey: snap.frame.scopeKey,
    worldlineId: snap.frame.worldlineId,
    restoreEpoch: snap.frame.restoreEpoch
  });
  const legacyFence = rollout.createLegacyExecutionFence(legacySeal);
  assert.equal(legacyFence.assertLegacyAllowed('recallCatalogCache'), true);
});

test('UM6 & V05: cold cache, warm cache, post-LRU eviction, and restart produce identical complete results and winning witnesses', () => {
  const snap = makeSnapshot();
  const { graph, rollout } = buildEnv(snap);
  const report = rollout.verifyColdWarmEvictionDeterminism({
    graph,
    queryInput: { queryText: 'silver ring alice' }
  });
  assert.equal(report.deterministic, true);
  assert.equal(report.passes.cold.complete, true);
  assert.equal(report.passes.cold.candidateDigest, report.passes.warm.candidateDigest);
  assert.equal(report.passes.cold.bundleDigest, report.passes.postEviction.bundleDigest);
  assert.equal(report.passes.cold.packetDigest, report.passes.postRestart.packetDigest);
});

(async () => {
  for (const t of tests) {
    await t.fn();
  }
  console.log(JSON.stringify({
    suite: 'libra_memory_graph_rollout',
    passed: tests.length,
    tests: tests.map(t => t.name)
  }));
})();
