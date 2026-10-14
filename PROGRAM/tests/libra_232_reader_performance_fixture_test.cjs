'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(process.argv[2] || process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '..', 'plugins', 'LIBRA.js'));
const source = fs.readFileSync(pluginPath, 'utf8');
const start = source.indexOf('const canonicalReaderTitle =');
const end = source.indexOf('const canonicalEvidenceArtifactRows =', start);
assert.ok(start >= 0 && end > start, 'Canonical Reader source range is required');
const readerSource = source.slice(start, end).replace(/    \/\/ Native owner projection shared[\s\S]*?(?=    const canonicalReaderPatchFields =)/,'');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 900) => string(value).slice(0, limit);
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
const refs = Array.from({ length: 64 }, (_, index) => {
  const startTurn = index * 5 + 1;
  return {
    status: 'committed', key: `memory:${startTurn}:1`, memoryId: `mem_${String(startTurn).padStart(6, '0')}`, revision: 1,
    sourceDigest: `source-${index}`, artifactDigest: `artifact-${index}`, turnRange: { start: startTurn, end: startTurn + 4 },
    sessionEpoch: index < 4 ? -1 : 0, inheritedSessionHistory: index < 4, worldlineId: 'main',
    summary: `Chapter ${index + 1}. ${'검증된 정본 요약 문장 '.repeat(80)}`
  };
});
assert.ok(refs.reduce((sum, ref) => sum + ref.summary.length, 0) > 48000, 'fixture must exceed 48k summary characters');

const counters = { bodyHydrations: 0, catalogReads: 0, writes: 0, queries: 0 };
const manifest = { schema: 'libra.manifest.v1', memories: Object.fromEntries(refs.map(ref => [String(ref.turnRange.start), clone(ref)])) };
const contextValue = { scope: { scopeKey: 'scope:reader-performance' }, chat: { messages: Array.from({ length: 320 }, () => ({})) } };
const isolated = {
  ...require('./fixtures/librarian_production_bindings.cjs')(source),
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map, Promise,
  clone, asObject, asArray, string, compact, digest,
  tokenize: value => string(value).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  state: { recallCatalogCache: new Map() },
  storage: {
    getJson: async keyValue => { counters.catalogReads += 1; return keyValue.includes('recall-catalog') ? { schema: 'libra.recall_catalog.v3', signature: 'stale', complete: false, entries: [] } : null; },
    setJson: async () => { counters.writes += 1; throw new Error('Reader attempted a durable write'); }
  },
  key: { recallCatalog: scope => `recall-catalog:${scope.scopeKey}` },
  executeMemoryGraphUnifiedQuery: async options => { counters.queries++; assert.equal(options.queryInput.queryText,'Chapter 42'); assert.equal(options.semanticPolicy.mode,'disabled'); return {guiSearch:{sourceKeys:[refs[41].key],complete:true,stopReason:'frontier_exhausted'}}; },
  statePipelineReplayRefs: value => Object.values(value.memories).sort((a, b) => Number(a.turnRange.start) - Number(b.turnRange.start)),
  resolveContext: async () => clone(contextValue),
  buildPairs: () => Array.from({ length: 320 }, () => ({})),
  loadManifest: async () => clone(manifest),
  resolveWorldManagerHistoryWorldline: async (_scope, requested) => ({ worldlineId: requested || 'main', cutoffTurn: 320 }),
  worldManagerPageLimit: value => Math.max(1, Math.min(100, Number(value || 20))),
  worldManagerEncodeCursor: (_kind, offset, identity) => JSON.stringify({ offset, identityDigest: digest(identity) }),
  worldManagerDecodeCursor: (_kind, cursor, identity, total) => {
    if (!cursor) return 0;
    const decoded = JSON.parse(cursor);
    if (decoded.identityDigest !== digest(identity) || decoded.offset < 0 || decoded.offset > total) throw new Error('cursor invalid');
    return decoded.offset;
  },
  CANONICAL_READER_CHAPTER_SCHEMA: 'libra.canonical_reader_chapter.v1',
  CANONICAL_READER_PAGE_SCHEMA: 'libra.canonical_reader_page.v1',
  STATE_PIPELINE_DOMAINS: [],
  stateCorrectionFailure: code => Object.assign(new Error(code), { code }),
  loadMemoryRef: async ref => {
    counters.bodyHydrations += 1;
    return { ...clone(ref), text: `본문 ${ref.memoryId}`, sourcePairs: [], canonicalArtifact: { characters: [], relationships: [], world: [], openThreads: [] } };
  },
  loadWorldManagerHistoryStateReceipt: async () => ({ receipt: null }),
  loadWorldManagerHistoryObservation: async () => { throw new Error('no observation expected'); }
};

vm.createContext(isolated);
vm.runInContext(`${readerSource}\nthis.readerApi = { listCanonicalReaderChapters, getCanonicalReaderChapter };`, isolated, {
  filename: 'libra-reader-performance-isolated.js', timeout: 3000
});

(async () => {
  const first = clone(await isolated.readerApi.listCanonicalReaderChapters({ limit: 20 }));
  assert.equal(first.items.length, 20, 'initial Chapter page must be capped at 20');
  assert.equal(first.total, 64);
  assert.equal(first.hasMore, true);
  assert.equal(counters.bodyHydrations, 0, 'Chapter list must not hydrate Canonical bodies');
  assert.equal(counters.catalogReads, 0, 'empty-query Chapter list must not read the retrieval catalog');
  assert.equal(counters.writes, 0, 'Chapter list must not write durable state');

  const second = clone(await isolated.readerApi.listCanonicalReaderChapters({ limit: 20, cursor: first.nextCursor }));
  assert.equal(second.items[0].chapterNumber, 21);
  assert.equal(counters.bodyHydrations, 0);

  const searched = clone(await isolated.readerApi.listCanonicalReaderChapters({ query: 'Chapter 42', limit: 20 }));
  assert.equal(searched.items.length, 1, 'GUI uses the common engine selection');
  assert.equal(searched.items[0].chapterNumber, 1);
  assert.equal(searched.items[0].memoryId, refs[41].memoryId);
  assert.equal(counters.catalogReads, 0);
  assert.equal(counters.queries, 1);
  assert.equal(counters.bodyHydrations, 0, 'stale catalog search must not trigger a synchronous body scan');

  const detail = clone(await isolated.readerApi.getCanonicalReaderChapter({ memoryId: refs[41].memoryId, revision: 1 }));
  assert.equal(detail.detailLoaded, true);
  assert.equal(detail.memoryId, refs[41].memoryId);
  assert.equal(counters.bodyHydrations, 1, 'one selected Chapter must hydrate exactly one Canonical body');
  assert.equal(counters.writes, 0);
  console.log('libra_232_reader_performance_fixture_test: PASS (320 turns, 64 Chapters, >48k summaries, one-detail hydration)');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
