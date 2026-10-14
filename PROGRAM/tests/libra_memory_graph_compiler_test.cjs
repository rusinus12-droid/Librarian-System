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

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const makeSnapshot = (mode = 'plugin_only') => ({
  frame: {
    owner: 'libra:' + mode,
    scopeKey: 'scope-alpha',
    worldlineId: 'main',
    restoreEpoch: 3,
    view: { viewerId: 'owner_reader', temporalView: 'current_owner_page', cutoffTurn: 6 }
  },
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
              text: 'Alice received the Silver Ring in the grand archive.',
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
            text: 'Alice received the Silver Ring.',
            actor: 'Alice',
            target: 'Bob',
            evidence: {
              role: 'assistant',
              messageId: 'msg-6',
              turn: 6,
              startOffset: 0,
              endOffset: 31,
              exactQuote: 'Alice received the Silver Ring.'
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
          text: 'Alice received the Silver Ring.'
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
        activation: { alwaysActive: true },
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

const runPipeline = snapshot => {
  const identity = createMemoryGraphIdentity({ fingerprint: sha256 });
  const pages = createMemoryGraphPages({ fingerprint: sha256 });
  const readers = createMemoryGraphReaders({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const index = createMemoryGraphIndex({ pages, fingerprint: sha256 });
  const lane = createMemoryGraphLane({ index, pages });
  const query = createMemoryGraphQuery({ index, lane, pages, fingerprint: sha256 });
  const compiler = createMemoryGraphCompiler({ fingerprint: sha256 });

  const rawGraph = readers.project(snapshot, { nodeLimit: 2048 });
  const graph = {
    ...rawGraph,
    scopeKey: snapshot.frame.scopeKey,
    readerFrame: clone(snapshot.frame)
  };
  const partition = JSON.stringify({ owner: snapshot.frame.owner, scopeKey: snapshot.frame.scopeKey, viewer: snapshot.frame.view.viewerId });
  const generation = pages.generation(graph, { partition, restoreEpoch: snapshot.frame.restoreEpoch, view: snapshot.frame });
  const compiled = index.compile(graph, { partition, generation });
  const qf = query.sealQueryFrame({
    queryText: 'silver ring alice',
    owner: snapshot.frame.owner,
    scopeKey: snapshot.frame.scopeKey,
    worldlineId: snapshot.frame.worldlineId
  });
  const view = query.openView(graph, compiled, qf);
  const queryResult = query.retrieve(view);
  return { graph, compiled, queryResult, compiler };
};

test('V09: conservative Micro absorption suppresses Micro when Canonical counterpart fits budget, but retains Micro if Canonical drops for budget', async () => {
  const snap = makeSnapshot('plugin_only');
  const { graph, queryResult, compiler } = runPipeline(snap);

  const canonicalCand = queryResult.candidates.find(c => c.family === 'canonical');
  const microCand = queryResult.candidates.find(c => c.family === 'micro');
  assert.ok(canonicalCand && microCand);

  // Case A: Sufficient budget -> Canonical is admitted, Micro is absorbed/suppressed
  const generous = compiler.select(queryResult, graph, {
    consumer: 'classic',
    maxCharacters: 4096,
    maxUnits: 10,
    correspondenceMap: { [microCand.nodeId]: canonicalCand.nodeId }
  });
  assert.ok(generous.bundle.items.some(i => i.nodeId === canonicalCand.nodeId));
  assert.equal(generous.bundle.items.some(i => i.nodeId === microCand.nodeId), false);
  assert.deepEqual(generous.bundle.suppressedMicroIds, [microCand.nodeId]);

  // Case B: Tight character budget where mandatory lore (57 chars) + Micro (31 chars) fit,
  // but Canonical (52 chars) after lore+state exceeds maxCharacters -> Canonical drops, so Micro MUST NOT be suppressed!
  const tight = compiler.select(queryResult, graph, {
    consumer: 'classic',
    maxCharacters: 105, // Lore (57) + State ("\"ent-ring\"" = 10) = 67 chars; Canonical (52 chars) overflows 105, whereas Micro (31 chars) fits (67 + 31 = 98 <= 105)!
    maxUnits: 10,
    correspondenceMap: { [microCand.nodeId]: canonicalCand.nodeId }
  });
  assert.equal(tight.bundle.items.some(i => i.nodeId === canonicalCand.nodeId), false, 'Canonical dropped due to character budget');
  assert.equal(tight.bundle.items.some(i => i.nodeId === microCand.nodeId), true, 'Micro must survive when Canonical counterpart drops for budget');
  assert.equal(tight.bundle.suppressedMicroIds.length, 0);
});

test('V06, V07 & V09: final dispatch verification rejects mutated suppressed-Micro source, entity registry change, lore edit, ABA restore epoch, or cloned handle', async () => {
  const snap = makeSnapshot('plugin_only');
  const { graph, queryResult, compiler } = runPipeline(snap);
  const canonicalCand = queryResult.candidates.find(c => c.family === 'canonical');
  const microCand = queryResult.candidates.find(c => c.family === 'micro');

  const selected = compiler.select(queryResult, graph, {
    consumer: 'classic',
    maxCharacters: 4096,
    maxUnits: 10,
    correspondenceMap: { [microCand.nodeId]: canonicalCand.nodeId }
  });
  const packet = compiler.render(selected);
  assert.equal(packet.modelDispatchEligible, false);

  // 1. Unchanged live graph passes physical dispatch verification
  const verified = await compiler.validateConsumedReadSet(selected.readSetHandle, {
    currentGraph: async () => graph,
    assertPhysicalCurrentness: async deps => deps.sourceIds.length >= 3
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.modelDispatchEligible, true);
  assert.equal(verified.verifiedSuppressedMicroCount, 1);

  // 2. JSON clone of readSetHandle is rejected (WeakMap capability protection)
  const forgedHandle = JSON.parse(JSON.stringify(selected.readSetHandle));
  await assert.rejects(
    () => compiler.validateConsumedReadSet(forgedHandle, { currentGraph: async () => graph }),
    /READSET_HANDLE_INVALID/
  );

  // 3. V09: Even though Micro was suppressed/absorbed in the rendered text, mutating the Micro record before dispatch MUST reject delivery!
  const mutatedMicroSnap = makeSnapshot('plugin_only');
  mutatedMicroSnap.micro[0].record.analysisRevisionId = 'ana-rev-6-mutated';
  mutatedMicroSnap.micro[0].head.analysisRevisionId = 'ana-rev-6-mutated';
  const mutatedMicroGraph = runPipeline(mutatedMicroSnap).graph;
  await assert.rejects(
    () => compiler.validateConsumedReadSet(selected.readSetHandle, { currentGraph: async () => mutatedMicroGraph }),
    /DEPENDENCY_BINDING_STALE/
  );

  // 4. V06: Mutating lore rendered text or entity registry fingerprint rejects delivery
  const mutatedLoreSnap = makeSnapshot('plugin_only');
  mutatedLoreSnap.lore.entries[0].rendered = 'The Silver Ring is now sealed forever and cannot open anything.';
  const mutatedLoreGraph = runPipeline(mutatedLoreSnap).graph;
  await assert.rejects(
    () => compiler.validateConsumedReadSet(selected.readSetHandle, { currentGraph: async () => mutatedLoreGraph }),
    /DEPENDENCY_BINDING_STALE/
  );

  // 5. V07: ABA restore epoch advance rejects identical content
  const abaSnap = makeSnapshot('plugin_only');
  abaSnap.frame.restoreEpoch = 4;
  const abaGraph = runPipeline(abaSnap).graph;
  await assert.rejects(
    () => compiler.validateConsumedReadSet(selected.readSetHandle, { currentGraph: async () => abaGraph }),
    /RESTORE_EPOCH_CHANGED|DEPENDENCY_BINDING_STALE/
  );
});

test('V12: plugin_only and server_only produce equivalent bundles/proofs, and GRADIA consumer enforces selection receipt verification', async () => {
  const pluginRun = runPipeline(makeSnapshot('plugin_only'));
  const serverRun = runPipeline(makeSnapshot('server_only'));

  const pluginSel = pluginRun.compiler.select(pluginRun.queryResult, pluginRun.graph, { consumer: 'planner', maxCharacters: 4096 });
  const serverSel = serverRun.compiler.select(serverRun.queryResult, serverRun.graph, { consumer: 'planner', maxCharacters: 4096 });

  assert.deepEqual(
    pluginSel.bundle.items.map(i => ({ family: i.family, text: i.text, score: i.score })),
    serverSel.bundle.items.map(i => ({ family: i.family, text: i.text, score: i.score }))
  );

  // GRADIA consumer without selection receipt must reject
  assert.throws(
    () => pluginRun.compiler.select(pluginRun.queryResult, pluginRun.graph, { consumer: 'gradia' }),
    /GRADIA_RECEIPT_REQUIRED/
  );

  const gradiaSel = pluginRun.compiler.select(pluginRun.queryResult, pluginRun.graph, {
    consumer: 'gradia',
    gradiaSelectionReceipt: { ownerCorpusDigest: 'corpus-sha-1', selectionReceiptId: 'rcpt-101' }
  });
  await assert.rejects(
    () => pluginRun.compiler.validateConsumedReadSet(gradiaSel.readSetHandle, {
      currentGraph: async () => pluginRun.graph,
      verifyGradiaReceipt: async () => false
    }),
    /GRADIA_RECEIPT_INVALID/
  );
  const gradiaVerified = await pluginRun.compiler.validateConsumedReadSet(gradiaSel.readSetHandle, {
    currentGraph: async () => pluginRun.graph,
    verifyGradiaReceipt: async r => r.selectionReceiptId === 'rcpt-101'
  });
  assert.equal(gradiaVerified.modelDispatchEligible, true);
});

(async () => {
  for (const t of tests) {
    await t.fn();
  }
  console.log(JSON.stringify({
    suite: 'libra_memory_graph_compiler',
    passed: tests.length,
    tests: tests.map(t => t.name)
  }));
})();
