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
const createMemoryGraphStore = resolveTool('libra_memory_graph_store.cjs');

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

const makeSampleSnapshot = () => ({
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
              text: 'Alice received the Silver Ring in the library.',
              values: { itemRef: 'e2', time: 'day-1' },
              evidenceSpans: [{ turn: 1, quote: 'Alice received the Silver Ring' }]
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
            text: 'Alice handed the Silver Ring temporarily to Bob.',
            actor: 'Alice',
            target: 'Bob',
            evidence: {
              role: 'assistant',
              messageId: 'msg-6',
              startOffset: 0,
              endOffset: 44,
              exactQuote: 'Alice handed the Silver Ring to Bob for now.'
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
          text: 'Alice handed the Silver Ring to Bob for now.'
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
              emptyTags: []
            },
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
        entry: { key: 'Silver Ring' },
        rendered: 'The Silver Ring opens the moon vault when Alice wears it.',
        activation: { alwaysActive: true },
        passages: [
          { coordinateSpace: 'rendered', start: 0, end: 57 }
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
              end: 57,
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

test('Defect 1 fix: nodeLimit reached during entity registration records node_work_budget and sets projectionComplete=false', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const snapshot = makeSampleSnapshot();
  snapshot.canonical = [];
  snapshot.micro = [];
  snapshot.state = { view: { head: { schema: 'libra.continuity_state.v2', scopeKey: 'scope-alpha', characters: [] } } };
  snapshot.lore = { entries: [], index: {} };

  const projected = readers.project(snapshot, { nodeLimit: 2 });
  assert.equal(projected.nodes.length, 2);
  assert.equal(projected.coverage.projectionComplete, false);
  assert.ok(projected.coverage.families.canonical.reasons.includes('node_work_budget'));
});

test('Defect 2 fix: reaching nodeLimit prevents orphan SourceNode creation without MeaningNode', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const snapshot = makeSampleSnapshot();
  const projected = readers.project(snapshot, { nodeLimit: 4 });
  const sourceNodes = projected.nodes.filter(n => n.layer === 'source');
  assert.equal(projected.coverage.families.canonical.records, 0);
  assert.ok(projected.coverage.families.canonical.reasons.includes('node_work_budget'));
  assert.equal(projected.coverage.families.micro.records, 0);
  assert.ok(projected.coverage.families.micro.reasons.includes('node_work_budget'));
  assert.equal(projected.coverage.families.lore.records, 0);
  assert.ok(projected.coverage.families.lore.reasons.includes('node_work_budget'));
  assert.ok(sourceNodes.length <= 1);
});

test('Defect 3 fix: empty array [] in State field uses state_field kind with itemIndex: null', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const projected = readers.project(makeSampleSnapshot(), { nodeLimit: 2048 });
  const emptyTagUnit = projected.units.find(u => u.family === 'state' && u.field === 'emptyTags');
  assert.ok(emptyTagUnit, 'emptyTags state unit should exist');
  const emptyTagNode = projected.nodes.find(n => n.id === emptyTagUnit.nodeId);
  assert.equal(emptyTagNode.kind, 'state_field');
  assert.deepEqual(emptyTagUnit.value, []);
});

test('Priority 2 & D06 (UM2 Common Access Index & Transitive Reverse Dependencies): compiles directory, directional Typed Adjacency, 4-channel Postings, and transitive source delta impact', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });

  const graph = readers.project(makeSampleSnapshot(), { nodeLimit: 2048 });
  const partition = JSON.stringify({ owner: baseFrame.owner, scopeKey: baseFrame.scopeKey, viewer: baseFrame.view.viewerId });
  const generation = pages.generation(graph, { partition, restoreEpoch: 0, view: baseFrame });

  const compiled = index.compile(graph, { partition, generation });
  assert.equal(compiled.schema, 'libra.memory_graph_index.v1');
  assert.equal(compiled.tokenizerVersion, 'libra.tokenizer.nfkc_v1');
  assert.equal(compiled.dfScope, 'window_exact');
  assert.equal(typeof compiled.tableDigests?.directoryDigest, 'string');
  assert.equal(typeof compiled.tableDigests?.adjacencyDigest, 'string');
  assert.equal(typeof compiled.tableDigests?.postingsDigest, 'string');
  assert.equal(typeof compiled.tableDigests?.reverseDependenciesDigest, 'string');
  assert.equal(compiled.stats.directoryCount, graph.nodes.length);
  assert.equal(compiled.stats.adjacencyCount, graph.edges.length * 2);
  assert.ok(compiled.stats.postingCount > 0);
  assert.ok(compiled.stats.reverseDependencyCount > 0);
  assert.ok(compiled.stats.maxOutDegree >= 1);

  const outSubjectPageCold = index.queryPage(compiled, { table: 'adjacency', direction: 'out', predicate: 'subject_of', pageBytes: 4096 });
  assert.equal(outSubjectPageCold.cacheHit, false);
  const outSubjectPage = index.queryPage(compiled, { table: 'adjacency', direction: 'out', predicate: 'subject_of', pageBytes: 4096 });
  assert.equal(outSubjectPage.cacheHit, true);
  assert.ok(outSubjectPage.items.length >= 2);
  assert.ok(outSubjectPage.items.every(row => row.direction === 'out' && row.predicate === 'subject_of' && row.structural === true));

  const lexicalPage = index.queryPage(compiled, { table: 'postings', channel: 'lexical', term: 'silver', pageBytes: 4096 });
  assert.equal(lexicalPage.items.length, 3);
  assert.ok(lexicalPage.items.every(row => row.df === 3 && row.tf >= 1));

  // D06: source:<id> change transitively includes its MeaningNode postings (lexical/entity/predicate/time) and requests DF refresh
  const canonicalSource = graph.nodes.find(n => n.layer === 'source'
    && graph.units.some(u => u.family === 'canonical' && graph.nodes.some(m => m.id === u.nodeId && m.sourceId === n.id)));
  const sourceOnlyImpact = index.affectedByChanges(compiled, [`source:${canonicalSource.id}`]);
  assert.ok(sourceOnlyImpact.affectedPostingKeys.some(k => k.startsWith('lexical:')), 'source change must include lexical postings');
  assert.equal(sourceOnlyImpact.requiresGlobalDfRefresh, true, 'source change affecting lexical postings must request global DF refresh');

  const impact = index.affectedByChanges(compiled, [`source:${canonicalSource.id}`, 'field:character:heldItemRef', 'unknown:key']);
  assert.equal(impact.schema, 'libra.memory_graph_delta_impact.v1');
  assert.ok(impact.affectedNodeIds.length >= 2);
  assert.ok(impact.affectedEdgeIds.length >= 1);
  assert.ok(impact.affectedPostingKeys.includes('predicate:heldItemRef'));
  assert.deepEqual(impact.unmatchedKeys, ['unknown:key']);
  assert.equal(impact.requiresDegreeRefresh, true);

  const tooSmallPage = index.queryPage(compiled, { table: 'adjacency', offset: 0, pageBytes: 512 });
  assert.equal(tooSmallPage.stopReason, 'row_exceeds_page');
  assert.equal(tooSmallPage.nextOffset, 0);

  const walked = [];
  let offset = 0;
  while (offset < compiled.adjacency.length) {
    const page = index.queryPage(compiled, { table: 'adjacency', offset, pageBytes: 1024 });
    assert.ok(page.items.length > 0);
    assert.ok(page.serializedUtf8Bytes <= 1024);
    walked.push(...page.items);
    offset = page.nextOffset;
  }
  assert.equal(walked.length, compiled.adjacency.length);
});

test('Priority 2 (UM2 Memory Lane Scheduler): coalesces duplicate requests, prioritizes roles/structural edges, and reports unread cursors on budget stop', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });
  const lane = createMemoryGraphLane({ index, pages });

  const graph = readers.project(makeSampleSnapshot(), { nodeLimit: 2048 });
  const partition = JSON.stringify({ owner: baseFrame.owner, scopeKey: baseFrame.scopeKey, viewer: baseFrame.view.viewerId });
  const generation = pages.generation(graph, { partition, restoreEpoch: 0, view: baseFrame });
  const compiled = index.compile(graph, { partition, generation });

  const session = lane.createSession(compiled, { maxPages: 10, maxBytes: 32768, pageBytes: 1024 });
  session.enqueue({ laneRole: 'context_expansion', table: 'directory', requesterId: 'req-ctx' });
  const firstAnchor = session.enqueue({ laneRole: 'query_anchor_access', table: 'postings', channel: 'lexical', term: 'silver', requesterId: 'req-1' });
  const duplicateAnchor = session.enqueue({ laneRole: 'temporal_state_access', table: 'postings', channel: 'lexical', term: 'silver', requesterId: 'req-2' });
  assert.equal(firstAnchor.coalesced, false);
  assert.equal(duplicateAnchor.coalesced, true);

  const result = session.drain();
  assert.equal(result.complete, true);
  assert.equal(result.coalescedRequests, 1);
  assert.equal(result.corpusExclusionAuthority, false);
  assert.equal(result.familyTopKQuota, false);
  assert.equal(result.accesses[0].table, 'postings');
  assert.deepEqual(result.accesses[0].requesters, ['req-1', 'req-2']);

  const tightSession = lane.createSession(compiled, { maxPages: 1, maxBytes: 32768, pageBytes: 1024 });
  tightSession.enqueue({ laneRole: 'graph_neighborhood', table: 'adjacency', structuralOnly: true });
  const partialResult = tightSession.drain();
  assert.equal(partialResult.complete, false);
  assert.equal(partialResult.stopReason, 'page_count_budget');
  assert.equal(partialResult.pagesRead, 1);
  assert.ok(partialResult.unreadCursors.length >= 1);
});

test('Priority 2 & D03 (UM2 Store Maintenance GC): retains active root manifest/pages and aborts sweep if a concurrent publisher updates root during mark', async () => {
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const store = createMemoryGraphStore({ pages, fingerprint: sha256 });
  const values = new Map([['source-1', 'v1']]);
  const graph = {
    schema: 'libra.memory_graph_projection.v1',
    scopeKey: 'scope-alpha',
    readerFrame: baseFrame,
    coverage: { inventory: { inventoryComplete: false } },
    nodes: [{ id: 'n1', bindingId: 'b1' }],
    edges: [{ id: 'e1', bindingId: 'be1' }],
    bases: [{ id: 'ba1', bindingId: 'bba1' }],
    units: [{ nodeId: 'n1', family: 'canonical', text: 'active unit' }]
  };
  let flipOnRead = null;
  const owner = {
    publication: 'test_runtime_ordered_partial',
    check() {},
    async read(key) {
      const raw = values.get(key) ?? null;
      if (flipOnRead && key === flipOnRead.manifestKey) {
        values.set(flipOnRead.rootKey, flipOnRead.rootRaw);
        flipOnRead = null;
      }
      return raw;
    },
    async putImmutable(key, raw) { values.set(key, raw); },
    async capture(keys) { return keys.map(key => ({ key, raw: values.get(key) ?? null })); },
    async assertCaptured(pin) { for (const item of pin) if ((values.get(item.key) ?? null) !== item.raw) throw new Error('source_pin_changed'); },
    async commitRoot({ key, raw }) { values.set(key, raw); },
    async listKeys(prefix) { return [...values.keys()].filter(k => k.startsWith(prefix)); },
    async captureGCInventory(prefix) {
      return { keys: await this.listKeys(prefix), complete: true, fence: 'mock-atomic-namespace' };
    },
    async deleteConditional({ key, expectedRaw, inventory, roots, prefix }) {
      const keys = [...values.keys()].filter(k => k.startsWith(prefix)).sort();
      const expectedKeys = inventory.keys.filter(k => values.has(k)).sort();
      if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || values.get(key) !== expectedRaw
        || roots.some(root => values.get(root.key) !== root.raw)) return false;
      values.delete(key); return true;
    }
  };
  const sourceOptions = { canonicalCursor: '', microCursor: '', limit: 20, nodeLimit: 2048 };
  await store.build({ snapshot: async () => ({ graph, sourceKeys: ['source-1'] }), owner, sourceOptions, pageBytes: 1024, jobToken: 'job-1' });

  const prefix = 'libra:v1:scope:scope-alpha:memory-graph:v1:';
  const orphanPageKey = prefix + 'page:units:' + '0'.repeat(64);
  const orphanGenKey = prefix + 'generation:' + 'f'.repeat(64);
  values.set(orphanPageKey, JSON.stringify({ orphan: true }));
  values.set(orphanGenKey, JSON.stringify({ orphan: true }));

  const dry = await store.collectGarbage({ owner, scopeKey: 'scope-alpha', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.candidateKeys, [orphanGenKey, orphanPageKey]);
  assert.equal(dry.deletedKeys.length, 0);
  assert.equal(values.has(orphanPageKey), true);

  const swept = await store.collectGarbage({ owner, scopeKey: 'scope-alpha', dryRun: false });
  assert.equal(swept.status, 'completed');
  assert.deepEqual(swept.deletedKeys, [orphanGenKey, orphanPageKey]);
  assert.equal(values.has(orphanPageKey), false);
  assert.equal(values.has(orphanGenKey), false);

  const verified = await store.read({ snapshot: async () => ({ graph, sourceKeys: ['source-1'] }), owner, sourceOptions, pool: 'units' });
  assert.equal(verified.status, 'verified');
  assert.equal(typeof verified.unreadRegions.hasUnreadSourceWindows, 'boolean');
  assert.equal(verified.unreadRegions.exhaustiveDeltaSupported, false);

  // D03: Concurrent publisher updating rootKey during mark phase must NOT have its active manifest deleted
  const rootKey = [...values.keys()].find(k => k.includes(':root:'));
  const aRaw = values.get(rootKey), aRoot = JSON.parse(aRaw);
  await store.build({ snapshot: async () => ({ graph, sourceKeys: ['source-1'] }), owner, sourceOptions, pageBytes: 1024, jobToken: 'job-2' });
  const bRaw = values.get(rootKey), bRoot = JSON.parse(bRaw);
  values.set(rootKey, aRaw);
  flipOnRead = { rootKey, manifestKey: aRoot.manifestKey, rootRaw: bRaw };
  const raceSweep = await store.collectGarbage({ owner, scopeKey: 'scope-alpha' });
  assert.equal(raceSweep.status, 'aborted_concurrent_mutation');
  assert.equal(values.has(bRoot.manifestKey), true, 'Active manifest B must remain intact after concurrent root update');
  assert.equal(raceSweep.deletedKeys.includes(bRoot.manifestKey), false);
});

(async () => {
  for (const t of tests) {
    await t.fn();
  }
  console.log(JSON.stringify({
    suite: 'libra_memory_graph_priority_and_index',
    passed: tests.length,
    tests: tests.map(t => t.name)
  }));
})();
