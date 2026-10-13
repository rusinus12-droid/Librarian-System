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

test('Priority 2 (UM2 Common Access Index): compiles Node/Source directory, directional Typed Adjacency, and 4-channel Postings with byte-bounded paging', () => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });

  const graph = readers.project(makeSampleSnapshot(), { nodeLimit: 2048 });
  const partition = JSON.stringify({ owner: baseFrame.owner, scopeKey: baseFrame.scopeKey, viewer: baseFrame.view.viewerId });
  const generation = pages.generation(graph, { partition, restoreEpoch: 0, view: baseFrame });

  const compiled = index.compile(graph, { partition, generation });
  assert.equal(compiled.schema, 'libra.memory_graph_index.v1');
  assert.equal(compiled.stats.directoryCount, graph.nodes.length);
  assert.equal(compiled.stats.adjacencyCount, graph.edges.length * 2);
  assert.ok(compiled.stats.postingCount > 0);
  assert.ok(compiled.stats.lexicalTermCount > 0);
  assert.ok(compiled.stats.entityKeyCount > 0);
  assert.ok(compiled.stats.predicateKeyCount > 0);

  const outSubjectPage = index.queryPage(compiled, { table: 'adjacency', direction: 'out', predicate: 'subject_of', pageBytes: 4096 });
  assert.ok(outSubjectPage.items.length >= 2);
  assert.ok(outSubjectPage.items.every(row => row.direction === 'out' && row.predicate === 'subject_of'));

  const lexicalPage = index.queryPage(compiled, { table: 'postings', channel: 'lexical', term: 'silver', pageBytes: 4096 });
  assert.equal(lexicalPage.items.length, 3);
  assert.ok(lexicalPage.items.every(row => row.df === 3 && row.tf >= 1));

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
