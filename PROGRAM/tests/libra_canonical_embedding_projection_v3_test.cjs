'use strict';
// Canonical embedding text, retrieval projection v3. Empty-section placeholders and "(근거: …)"
// evidence refs are not embedded, an empty section has no vector, and the recall keys lead the
// global text. Over-long inputs are cut at a line, sentence or space boundary within the token
// budget. Canonicals built under an older projection are re-embedded by explicit maintenance.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const expose = names => source => {
  const marker = '    // END LIBRA STATE OWNER';
  assert.equal(source.split(marker).length, 2);
  return source.replace(marker, `    globalThis.__projection = { ${names.join(', ')} };\n` + marker);
};
const vectorFor = text => {
  let seed = 2166136261;
  for (const char of String(text)) seed = Math.imul(seed ^ char.codePointAt(0), 16777619) >>> 0;
  return Array.from({ length: 256 }, () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296 - 0.5;
  });
};

test('projection v3 embeds meaning only: no placeholders, no evidence refs, recall keys first', async t => {
  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f = await fixture({ transformSource: expose(['buildMemoryRetrievalProjection', 'renderCanonicalArtifact', 'RETRIEVAL_PROJECTION_VERSION']) });
  t.after(() => f.r.cleanup());
  const { buildMemoryRetrievalProjection, renderCanonicalArtifact, RETRIEVAL_PROJECTION_VERSION } = f.r.context.__projection;
  assert.equal(RETRIEVAL_PROJECTION_VERSION, 'libra.retrieval_projection.v3');
  const text = renderCanonicalArtifact({
    chronology: [{ event: '민아가 서재에서 은빛 열쇠를 찾아 지호에게 돌려주기로 약속했다.', evidenceRefs: ['t2-a', 't3-u'] }],
    recallTerms: ['은빛 열쇠', '반환 약속']
  });
  assert.match(text, /이번 배치에서 새로 확정된 세계 상태 변화 없음/, 'the rendered canonical still carries its placeholders');
  assert.match(text, /\(근거: t2-a, t3-u\)/);
  const projection = buildMemoryRetrievalProjection({ text, summary: '', turnRange: { start: 1, end: 5 }, recallKeys: ['은빛 열쇠'] });
  assert.deepEqual(Object.keys(projection.embeddingTexts).sort(), ['chronology', 'global'], 'empty sections have no vector');
  for (const value of Object.values(projection.embeddingTexts)) {
    assert.doesNotMatch(value, /근거:/, 'evidence refs are not embedded');
    assert.doesNotMatch(value, /이번 배치에서 .*없음|별도로 표시할 불확실 정보 없음/, 'placeholders are not embedded');
  }
  assert.match(projection.embeddingTexts.global, /^\[회상 키\]/, 'recall keys lead the global text');
  assert.match(projection.embeddingTexts.chronology, /은빛 열쇠를 찾아 지호에게 돌려주기로 약속했다\.$/m);
  assert.ok(projection.sections.chronology.includes('(근거: t2-a, t3-u)'), 'stored sections keep their evidence refs');
});

test('an over-long input is cut at a boundary within the token budget', async t => {
  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f = await fixture({ transformSource: expose(['EmbeddingProviderRegistry']) });
  t.after(() => f.r.cleanup());
  const registry = f.r.context.__projection.EmbeddingProviderRegistry;
  const lines = Array.from({ length: 40 }, (_, index) => `- ${index}번째 사건: 민아는 서재의 책장 사이에서 오래된 편지를 찾아 조용히 읽었다.`);
  const source = lines.join('\n');
  const parts = registry.splitEmbeddingInputByTokenBudget(source, 600);
  assert.ok(parts.length > 1, 'the input is split');
  assert.equal(parts.join(''), source, 'nothing is lost or duplicated');
  for (const part of parts.slice(0, -1)) assert.match(part, /\n$/, 'every cut lands on a line break');
});

test('explicit maintenance re-embeds canonicals built under an older projection', async t => {
  const { fixture } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
  const documents = [];
  const x = await fixture({
    mode: 'plugin_only', includeMicro: false, pauseAutomaticAnalysis: true,
    transformSource: expose(['resolveContext', 'loadManifest', 'buildPairs']),
    embeddingConfig: { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
      model: 'text-embedding-3-small', key: 'synthetic-only-not-real', dimensions: 256, maxRetries: 0 },
    embeddingFetch: async (_url, init) => {
      const inputs = [].concat(JSON.parse(init.body).input);
      documents.push(...inputs);
      return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }), { status: 200 });
    }
  });
  t.after(() => x.cleanup());
  const core = x.f.r.core, values = x.f.r.values;
  const manifestKey = [...values.keys()].find(key => key.endsWith(':manifest'));
  const manifest = JSON.parse(values.get(manifestKey));
  const ref = manifest.memories['1'];
  assert.equal(ref.embeddingStatus, 'ready', 'the canonical was embedded on its automatic path');
  assert.equal(ref.retrievalVersion, 'libra.retrieval_projection.v3');
  // As if this canonical had been embedded by a release with the previous projection: an older
  // version label and vectors whose text hashes no longer match the current embedded text.
  ref.retrievalVersion = 'libra.retrieval_projection.v2';
  values.set(manifestKey, JSON.stringify(manifest));
  const memory = JSON.parse(values.get(ref.key));
  const vector = JSON.parse(values.get(memory.embedding.vectorKey));
  for (const entry of Object.values(vector.entries || {})) entry.textHash = 'projection-v2-' + entry.textHash;
  values.set(memory.embedding.vectorKey, JSON.stringify(vector));
  const before = documents.length;
  const result = await core.upgradeCanonicalVectorProjections(await core.resolveContext());
  assert.deepEqual({ attempted: result.attempted, upgraded: result.upgraded, failed: result.failed }, { attempted: 1, upgraded: 1, failed: 0 });
  const after = JSON.parse(values.get(manifestKey)).memories['1'];
  assert.equal(after.retrievalVersion, 'libra.retrieval_projection.v3');
  assert.equal(after.embeddingStatus, 'ready');
  assert.ok(documents.length > before, 'the upgrade embedded the new projection');
  assert.ok(documents.slice(before).every(text => !/근거:/.test(text)), 'the new projection embeds no evidence refs');
});
