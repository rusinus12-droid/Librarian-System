'use strict';
// Actual owner algorithms in an in-memory host; no production admission claim.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const load = (file, name) => Function(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + ';return ' + name)();

async function fixture() {
  return createLibraVmHarness({}, {}, {
    transformSource: source => source.replace(
      '    const sentenceUnits = value => {',
      '    globalThis.__rankedTest = { normalizeSettings, buildQueryBundle, registry: EmbeddingProviderRegistry, createLibraGradiaRankedProducer };\n    const sentenceUnits = value => {'
    ).replace(
      "        const MULTILINGUAL_PROBE_SCHEMA = 'libra.embedding_multilingual_probe.v1';",
      `        globalThis.__seedRankedCache = (raw, texts) => { const cfg = normalizeConfig(raw); for (const value of texts) rememberQueryCache(queryCacheKey(cfg, value, {}), { vector: [1, 0], provider: cfg.provider, model: cfg.model, dimensions: 2, profileId: profileFor({ ...cfg, dimensions: 2 }).profileId, normalized: true }); };\n        const MULTILINGUAL_PROBE_SCHEMA = 'libra.embedding_multilingual_probe.v1';`
    ),
    contextGlobals: { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} }
  });
}

function buildGradiaDeps(maxPhysicalReads = 4) {
  const protocol = load('sdk/gradia/GradiaReadV2Protocol.source.js', 'createGradiaReadV2Protocol')({ sha256: sha });
  const render = load('sdk/GradiaEvidenceRender.v2.source.js', 'createGradiaEvidenceRender')({ protocol });
  const limits = protocol.validateLimits({});
  const credit = load('sdk/gradia/GradiaReadV2Credit.source.js', 'createGradiaReadV2Credit')({ maxManagedBytes: limits.managedBytes, maxPhysicalReads });
  const vmCredit = { ...credit, reserve: raw => credit.reserve({ ...raw }), beginPhysical: raw => credit.beginPhysical({ ...raw }) };
  return { protocol, render, limits, credit, vmCredit };
}

test('explicit ranked producer enforces frozen 80-row frontier and candidateLimit bounds', async () => {
  const f = await fixture();
  try {
    const t = f.context.__rankedTest;
    const { protocol, render, limits, vmCredit } = buildGradiaDeps();
    const producer = t.createLibraGradiaRankedProducer({ protocol, render, digest: sha, credit: vmCredit });
    assert.equal(producer.contract, 'libra.gradia-ranked-producer.v2');
    assert.equal(producer.authorityQualified, false);
    const frontier = Object.freeze(Array.from({ length: 80 }, (_, i) => Object.freeze({ key: `memory-${i}`, memoryId: `mem-${i}`, revision: 1 })));
    const body = ref => `shared relevant memory ${ref.memoryId}`;
    const captured = await producer.capture({
      limits,
      frontier,
      policy: { schema: 'libra.recall-mmr.v2', candidateLimit: 80, mmrEnabled: true, mmrLambda: 0.7 },
      owner: {
        async assertCurrent() { return true; },
        async inspect(ref) {
          const content = body(ref);
          return { narrativeBytes: Buffer.byteLength(content), serializedBytes: Buffer.byteLength(content) + 128, proofBytes: 64, contentHash: sha(content), profile: 'libra.canonical.memory-text.v1', sourceHandle: ref.key, groupId: null };
        },
        async materialize(ref) {
          const content = body(ref);
          return { itemId: ref.memoryId, content, row: { id: ref.memoryId, relevance: 0.9, forced: false, exactScore: 0.5, sparseEvidence: 0.4 } };
        },
        async scoreRows(rows) { return rows; },
        similarity(left, right) { return left.id === right.id ? 1 : 0.1; }
      }
    });
    assert.equal(captured.profile, 'gradia.ranked-corpus-component.v2');
    assert.equal(captured.items.length, 80);
    assert.equal(captured.coverage.frontierCount, 80);
    assert.equal(captured.coverage.visitedCount, 80);
    assert.equal(captured.coverage.frontierExhausted, true);
    captured.release();
  } finally { await f.cleanup(); }
});

test('ranked producer rejects associative overflow when owner.associativeEnabled is not true', async () => {
  const f = await fixture();
  try {
    const t = f.context.__rankedTest;
    const { protocol, render, limits, vmCredit } = buildGradiaDeps();
    const producer = t.createLibraGradiaRankedProducer({ protocol, render, digest: sha, credit: vmCredit });
    const frontier = Object.freeze(Array.from({ length: 41 }, (_, i) => Object.freeze({ key: `memory-${i}`, memoryId: `mem-${i}` })));
    await assert.rejects(
      producer.capture({
        limits,
        frontier,
        policy: { schema: 'libra.recall-mmr.v2', candidateLimit: 40, mmrEnabled: true, mmrLambda: 0.7 },
        owner: {
          associativeEnabled: false,
          async assertCurrent() { return true; },
          async inspect() { return {}; },
          async materialize() { return {}; },
          async scoreRows(rows) { return rows; },
          similarity() { return 0; }
        }
      }),
      /GRADIA_V2_PRODUCER_ASSOCIATIVE_NOT_ADMITTED/
    );
  } finally { await f.cleanup(); }
});

test('cache-only registry lookup is cold/inflight unavailable without calling an embedder', async () => {
  const f = await fixture();
  try {
    const t = f.context.__rankedTest;
    assert.equal(typeof t.registry.peekWarmQuery, 'function');
    const before = t.registry.getQueryCacheStats();
    const result = t.registry.peekWarmQuery({ provider: 'openai', model: 'text-embedding-3-small' }, ['same complete query'], {});
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'query_cache_unavailable');
    assert.equal(JSON.stringify(t.registry.getQueryCacheStats()), JSON.stringify(before));
  } finally { await f.cleanup(); }
});

test('warm query cache hits without provider calls while cold queries stay unavailable', async () => {
  const f = await fixture();
  try {
    const t = f.context.__rankedTest;
    const embeddingConfig = { provider: 'openai', model: 'text-embedding-3-small' };
    const cold = t.registry.peekWarmQuery(embeddingConfig, ['shared relevant memory'], {});
    assert.equal(cold.status, 'unavailable');
    assert.equal(cold.reason, 'query_cache_unavailable');
    f.context.__seedRankedCache(embeddingConfig, ['shared relevant memory']);
    const warm = t.registry.peekWarmQuery(embeddingConfig, ['shared relevant memory'], {});
    assert.equal(warm.status, 'available');
    assert.equal(warm.vectors.length, 1);
  } finally { await f.cleanup(); }
});

test('warm private owner profile hydrates its 80-row preset with actual LIBRA producer and releases managed credit', async () => {
  const f = await fixture();
  try {
    const t = f.context.__rankedTest;
    const { protocol, render, limits, credit, vmCredit } = buildGradiaDeps();
    const producer = t.createLibraGradiaRankedProducer({ protocol, render, digest: sha, credit: vmCredit });
    const embeddingConfig = { provider: 'openai', model: 'text-embedding-3-small' };
    const queryText = 'shared relevant memory';
    f.context.__seedRankedCache(embeddingConfig, [queryText]);
    const before = JSON.stringify(t.registry.getQueryCacheStats());
    const warm = t.registry.peekWarmQuery(embeddingConfig, [queryText], {});
    assert.equal(warm.status, 'available');
    assert.equal(JSON.stringify(t.registry.getQueryCacheStats()), before);
    const frontier = Object.freeze(Array.from({ length: 80 }, (_, i) => Object.freeze({ key: `memory-${i}`, memoryId: `mem-${i}`, revision: 1 })));
    let reads = 0;
    const body = ref => `shared relevant memory ${ref.memoryId} ` + ('entire text '.repeat(80));
    const result = await producer.capture({
      limits,
      frontier,
      policy: { schema: 'libra.recall-mmr.v2', candidateLimit: 80, mmrEnabled: true, mmrLambda: 0.7 },
      owner: {
        async assertCurrent() { return true; },
        async inspect(ref) {
          const content = body(ref);
          return { narrativeBytes: Buffer.byteLength(content), serializedBytes: Buffer.byteLength(content) + 500, proofBytes: 100, contentHash: sha(content), profile: 'libra.canonical.memory-text.v1', sourceHandle: ref.key, groupId: null };
        },
        async materialize(ref) {
          reads++;
          const content = body(ref);
          return { itemId: ref.memoryId, content, row: { id: ref.memoryId, relevance: 0.85, forced: ref.memoryId === 'mem-0', exactScore: 0.6, sparseEvidence: 0.5 } };
        },
        async scoreRows(rows) { return rows; },
        similarity(left, right) { return left.id === right.id ? 1 : 0.15; }
      }
    });
    assert.equal(reads, 80);
    assert.equal(result.items.length, 80);
    assert.ok(result.coverage.returnedEligibleBytes > 8192);
    assert.equal(result.coverage.frontierExhausted, true);
    assert.equal(result.authorityQualified, false);
    result.release();
    assert.equal(credit.snapshot().managedBytes, 0);
  } finally { await f.cleanup(); }
});
