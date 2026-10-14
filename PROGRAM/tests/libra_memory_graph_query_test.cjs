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

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const baseFrame = {
  owner: 'libra:plugin_only',
  scopeKey: 'scope-alpha',
  worldlineId: 'main',
  restoreEpoch: 0,
  view: { viewerId: 'owner_reader', temporalView: 'current_owner_page', cutoffTurn: 6 }
};

const makeFourFamilySnapshot = () => ({
  frame: baseFrame,
  registry: {
    key: 'libra:v1:scope:scope-alpha:entity-registry',
    record: {
      scopeKey: 'scope-alpha',
      fingerprint: 'reg-rev-1',
      entities: [
        { id: 'ent-alice', name: 'Alice', aliases: ['앨리스'], validated: true, status: 'active' },
        { id: 'ent-ring', name: 'Silver Ring', aliases: ['은반지'], validated: true, status: 'active' },
        { id: 'ent-bob', name: 'Bob', aliases: ['밥'], validated: true, status: 'active' }
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
  micro: [
    {
      status: 'verified',
      recordKey: 'libra:v1:scope:scope-alpha:micro:turn-6',
      headKey: 'libra:v1:scope:scope-alpha:micro-head:turn-6',
      receiptKey: 'libra:v1:scope:scope-alpha:receipt:turn-6',
      record: {
        schema: 'libra.micro_memory.v1',
        scopeKey: 'scope-alpha',
        worldlineId: 'main',
        sessionEpoch: 0,
        turn: 6,
        analysisStatus: 'verified',
        sourceRevisionId: 'src-rev-6',
        analysisRevisionId: 'ana-rev-6',
        sourceDigest: 'dig-6',
        receiptKey: 'libra:v1:scope:scope-alpha:receipt:turn-6',
        claims: [
          {
            text: 'Alice lent the Silver Ring to Bob for safekeeping.',
            actor: 'Alice',
            target: 'Bob',
            // D01: Native Micro evidence does NOT contain `turn`; turn lives on record/head/receipt
            evidence: {
              role: 'assistant',
              messageId: 'msg-6',
              startOffset: 0,
              endOffset: 50,
              exactQuote: 'Alice lent the Silver Ring to Bob for safekeeping.'
            }
          }
        ]
      },
      head: {
        schema: 'libra.micro_memory_head.v1',
        scopeKey: 'scope-alpha',
        worldlineId: 'main',
        sessionEpoch: 0,
        turn: 6,
        recordKey: 'libra:v1:scope:scope-alpha:micro:turn-6',
        sourceRevisionId: 'src-rev-6',
        analysisRevisionId: 'ana-rev-6',
        sourceDigest: 'dig-6',
        analysisStatus: 'verified'
      },
      receipt: {
        revisionId: 'src-rev-6',
        sourceDigest: 'dig-6',
        scopeKey: 'scope-alpha',
        worldlineId: 'main',
        turn: 6,
        sessionEpoch: 0,
        assistant: {
          chatId: 'msg-6',
          text: 'Alice lent the Silver Ring to Bob for safekeeping.'
        }
      }
    }
  ],
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
            state: {
              heldItemRef: 'ent-ring',
              mysteryNote: 'unprovenanced observation'
            },
            fieldEvidence: {
              heldItemRef: {
                memoryId: 'm1',
                revision: 'rev-1',
                sourceDigest: 'dig-1',
                assertionIds: ['f1']
              }
            },
            clearedFieldEvidence: {
              formerTitle: {
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
        rendered: 'Only the wearer of the moon crest may unseal the sanctuary.',
        activation: { alwaysActive: false },
        passages: [
          { coordinateSpace: 'rendered', start: 0, end: 59 }
        ]
      }
    ],
    index: {
      entries: [
        {
          identity: 'lore-ring-rule',
          passages: [
            {
              start: 0,
              end: 59,
              mentions: [{ entityId: 'ent-alice', name: 'Alice', ambiguous: false, confirmed: true }]
            }
          ]
        }
      ],
      links: [
        { identity: 'lore-ring-rule', entityId: 'ent-alice', via: 'name_reference', resolution: 'confirmed' }
      ]
    }
  }
});

const buildStack = (snapshot, { nodeLimit = 2048 } = {}) => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });
  const lane = createMemoryGraphLane({ index, pages });
  const query = createMemoryGraphQuery({ index, lane, pages, fingerprint: sha256 });

  const graph = readers.project(snapshot, { nodeLimit });
  const partition = JSON.stringify({ owner: baseFrame.owner, scopeKey: baseFrame.scopeKey, viewer: baseFrame.view.viewerId });
  const generation = pages.generation(graph, { partition, restoreEpoch: 0, view: baseFrame });
  const compiled = index.compile(graph, { partition, generation });
  return { identity, pages, readers, index, lane, query, graph, compiled };
};

test('V01 & V03: retrieves all 4 families (canonical, micro, state, lore) in one frontier and deduplicates EvidenceFamily without cyclic amplification', () => {
  const { query, graph, compiled } = buildStack(makeFourFamilySnapshot());
  const qf = query.sealQueryFrame({
    queryText: 'silver ring alice',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    worldlineId: baseFrame.worldlineId
  });
  const view = query.openView(graph, compiled, qf);
  const res = query.retrieve(view);

  assert.equal(res.complete, true);
  assert.equal(res.modelDispatchEligible, false);
  const familiesFound = new Set(res.candidates.map(c => c.family));
  for (const fam of ['canonical', 'micro', 'state', 'lore']) {
    assert.ok(familiesFound.has(fam), `Expected family ${fam} in unified retrieval results`);
  }
  const loreCand = res.candidates.find(c => c.family === 'lore');
  assert.ok(loreCand.propagatedScore > 0);
  assert.ok(loreCand.winningWitness.hopCount >= 1);

  const canonicalFact = res.candidates.find(c => c.family === 'canonical');
  const stateHeld = res.candidates.find(c => c.family === 'state' && c.availability === 'value' && c.provenanceStatus === 'recorded');
  assert.equal(stateHeld.evidenceFamilyId, `family:derived:${canonicalFact.nodeId}`);
  assert.equal(stateHeld.independentEvidenceCount, 1);
});

test('V02, V04 & D01: missing embeddings do not drop candidates, and past asOfTurn excludes native Micro future turns and State head while preserving clear vs unknown', () => {
  const { query, graph, compiled } = buildStack(makeFourFamilySnapshot());
  const microUnit = graph.units.find(u => u.family === 'micro');
  assert.equal(microUnit.sourceSpan.turn, undefined, 'Native Micro evidence must not carry a synthetic turn field');
  assert.equal(microUnit.turn, 6, 'Projected Micro unit must preserve owner-verified record/receipt turn');

  const currentFrame = query.sealQueryFrame({
    queryText: 'alice observation',
    predicates: ['heldItemRef', 'formerTitle', 'mysteryNote'],
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey
  });
  const currentRes = query.retrieve(query.openView(graph, compiled, currentFrame));
  const clearedField = currentRes.candidates.find(c => c.family === 'state' && c.availability === 'clear');
  const unknownField = currentRes.candidates.find(c => c.family === 'state' && c.provenanceStatus === 'unknown');
  assert.ok(clearedField, 'Explicitly cleared State field is preserved');
  assert.ok(unknownField, 'Unprovenanced State field is preserved with lower role weight');
  assert.equal(clearedField.semanticFeatureStatus, 'unavailable');

  const pastFrame = query.sealQueryFrame({
    queryText: 'silver ring alice safekeeping',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    asOfTurn: 3
  });
  const pastRes = query.retrieve(query.openView(graph, compiled, pastFrame));
  assert.equal(pastRes.historicalStateUnavailable, true, 'Future State head (turn 6) must not be used for asOfTurn 3');
  assert.equal(pastRes.candidates.some(c => c.family === 'state'), false);
  assert.equal(pastRes.candidates.some(c => c.family === 'micro'), false, 'Future native Micro turn 6 must be excluded at asOfTurn 3');
  assert.equal(pastRes.candidates.some(c => c.family === 'canonical'), true, 'Historical Canonical turn 2 remains eligible at asOfTurn 3');
});

test('V13: improved-path reevaluation updates both score and winningWitness.edgeChain atomically when a stronger path arrives after a weaker path', () => {
  const { query, graph, compiled } = buildStack(makeFourFamilySnapshot());
  const loreCandUnit = graph.units.find(u => u.family === 'lore');
  const canonicalUnit = graph.units.find(u => u.family === 'canonical');

  const qf = query.sealQueryFrame({
    queryText: 'archive',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    queryVectors: {
      [loreCandUnit.nodeId]: 0.05,
      [canonicalUnit.nodeId]: 0.98
    }
  });
  const res = query.retrieve(query.openView(graph, compiled, qf));
  const loreResult = res.candidates.find(c => c.nodeId === loreCandUnit.nodeId);
  assert.ok(loreResult);
  assert.ok(loreResult.score > loreResult.directScore, 'Propagated stronger path must supersede weaker direct seed');
  assert.equal(loreResult.winningWitness.seedNodeId, canonicalUnit.nodeId, 'winningWitness must point to the stronger canonical seed');
  assert.ok(loreResult.winningWitness.hopCount >= 2, 'edgeChain must match the winning multi-hop path');
  assert.ok(loreResult.pathVersion >= 2, 'pathVersion must increment on improved-path reevaluation');
});

test('V15 & D05: protected intermediate hub is blocked without mutating SourceGraph, and truncated projection coverage never reports complete: true', () => {
  const { query, graph, compiled } = buildStack(makeFourFamilySnapshot());
  const aliceNode = graph.nodes.find(n => n.layer === 'entity'
    && graph.edges.some(e => e.to === n.id && e.predicate === 'mentions'));
  assert.ok(aliceNode, 'Alice EntityNode bridge must exist');

  const edgesBefore = graph.edges.length;
  const blockedFrame = query.sealQueryFrame({
    queryText: 'silver ring',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    excludedNodeIds: [aliceNode.id]
  });
  const blockedRes = query.retrieve(query.openView(graph, compiled, blockedFrame));
  assert.equal(blockedRes.candidates.some(c => c.family === 'lore'), false, 'Ineligible intermediate hub must not bridge propagation');
  assert.equal(graph.edges.length, edgesBefore, 'SourceGraph must not be mutated by QueryGraphView filtering');

  // D05: nodeLimit truncation sets projectionComplete: false, which must propagate to queryResult.complete: false
  const truncated = buildStack(makeFourFamilySnapshot(), { nodeLimit: 5 });
  assert.equal(truncated.graph.coverage.projectionComplete, false);
  const truncFrame = truncated.query.sealQueryFrame({
    queryText: 'silver ring',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey
  });
  const truncRes = truncated.query.retrieve(truncated.query.openView(truncated.graph, truncated.compiled, truncFrame));
  assert.equal(truncRes.traversalComplete, true);
  assert.equal(truncRes.sourceCoverageComplete, false);
  assert.equal(truncRes.complete, false, 'Truncated source projection must never report queryResult.complete: true');
  assert.equal(truncRes.stopReason, 'projection_coverage_incomplete');
});

test('M04 & M05: frontier-integrated Lane requests per-anchor neighborhood pages on demand, enforces L0 workspace byte budget, and validates resumeCursors generation', () => {
  const { query, graph, compiled } = buildStack(makeFourFamilySnapshot());
  const qf = query.sealQueryFrame({
    queryText: 'silver ring alice',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    worldlineId: baseFrame.worldlineId
  });
  const view = query.openView(graph, compiled, qf);

  // 1. Partial Lane page budget stops with unreadCursors that can be resumed in a subsequent retrieve()
  const partialRes = query.retrieve(view, {
    maxPages: 2,
    maxBytes: 32768,
    pageBytes: 1024
  });
  assert.equal(partialRes.complete, false);
  assert.equal(partialRes.stopReason, 'lane_page_count_budget');
  assert.ok(partialRes.diagnostics.unreadCursors.length > 0, 'Partial budget stop must emit unreadCursors');
  assert.ok(partialRes.diagnostics.l0WorkspaceBytes > 1024, 'L0 workspace byte accounting must be tracked');

  const resumedRes = query.retrieve(view, {
    maxPages: 32,
    maxBytes: 65536,
    pageBytes: 1024,
    resumeCursors: partialRes.diagnostics.unreadCursors
  });
  assert.equal(resumedRes.complete, true);
  assert.ok(resumedRes.diagnostics.onDemandNeighborhoodAnchors >= 1, 'Frontier must issue per-anchor graph_neighborhood requests');
  assert.ok(resumedRes.diagnostics.laneRoleStats.graph_neighborhood.requests >= 1);

  // 2. Stale resumeCursor with mismatched generation must throw LIBRA_GRAPH_LANE_CURSOR_STALE
  const staleCursor = { ...partialRes.diagnostics.unreadCursors[0], generation: 'stale-gen-id' };
  assert.throws(
    () => query.retrieve(view, { resumeCursors: [staleCursor] }),
    /LIBRA_GRAPH_LANE_CURSOR_STALE/
  );

  // 3. Tight maxWorkspaceBytes stops traversal with workspace_byte_budget
  const wsStopped = query.retrieve(view, { maxWorkspaceBytes: 2048 });
  assert.equal(wsStopped.complete, false);
  assert.equal(wsStopped.stopReason, 'workspace_byte_budget');
});

test('M06 & M07: validates semantic representation space compatibility, isolates mismatched vectors without background re-embedding, and separates unambiguous vs ambiguous entity aliases', () => {
  const snap = makeFourFamilySnapshot();
  // Add a second active entity sharing the alias "실버" to test alias ambiguity detection
  snap.registry.record.entities.push(
    { id: 'ent-alice-clone', name: 'Silver Knight', aliases: ['은기사', '실버'], validated: true, status: 'active' }
  );
  snap.registry.record.entities[1].aliases.push('실버');
  const { query, graph, compiled } = buildStack(snap);

  const canonicalUnit = graph.units.find(u => u.family === 'canonical');
  const loreUnit = graph.units.find(u => u.family === 'lore');
  const canonicalNode = graph.nodes.find(n => n.id === canonicalUnit.nodeId);

  const qf = query.sealQueryFrame({
    queryText: '앨리스 실버',
    owner: baseFrame.owner,
    scopeKey: baseFrame.scopeKey,
    worldlineId: baseFrame.worldlineId,
    entityRegistry: snap.registry.record.entities,
    semanticSpace: {
      spaceId: 'emb-space-v1',
      provider: 'local',
      model: 'bge-m3',
      dimension: 3,
      metric: 'cosine',
      profileDigest: 'prof-1'
    },
    queryEmbedding: [1, 0, 0],
    documentRepresentations: {
      [canonicalUnit.nodeId]: {
        spaceId: 'emb-space-v1',
        provider: 'local',
        model: 'bge-m3',
        dimension: 3,
        metric: 'cosine',
        profileDigest: 'prof-1',
        bindingId: canonicalNode.bindingId,
        vector: [0.8, 0.6, 0]
      },
      [loreUnit.nodeId]: {
        spaceId: 'emb-space-WRONG',
        provider: 'other',
        model: 'other-model',
        dimension: 3,
        metric: 'cosine',
        profileDigest: 'prof-2',
        vector: [1, 0, 0]
      }
    }
  });

  const view = query.openView(graph, compiled, qf);
  // M07: Unambiguous alias '앨리스' resolves to ent-alice, while ambiguous alias '실버' is isolated in ambiguousAliases
  assert.equal(view.resolvedEntityIds.length, 1);
  assert.ok(view.ambiguousAliases.some(a => a.alias === '실버' && a.candidateEntityIds.length === 2));

  const res = query.retrieve(view);
  assert.equal(res.diagnostics.semanticDiagnostics.compatibleCount, 1);
  assert.equal(res.diagnostics.semanticDiagnostics.incompatibleIsolatedCount, 1);
  assert.equal(res.diagnostics.semanticDiagnostics.backgroundEmbeddingStarted, false);

  const canonicalCand = res.candidates.find(c => c.nodeId === canonicalUnit.nodeId);
  const loreCand = res.candidates.find(c => c.nodeId === loreUnit.nodeId);
  assert.equal(canonicalCand.semanticFeatureStatus, 'available_vector_space');
  assert.equal(loreCand.semanticFeatureStatus, 'incompatible_isolated');
});

(async () => {
  for (const t of tests) {
    await t.fn();
  }
  console.log(JSON.stringify({
    suite: 'libra_memory_graph_query',
    passed: tests.length,
    tests: tests.map(t => t.name)
  }));
})();
