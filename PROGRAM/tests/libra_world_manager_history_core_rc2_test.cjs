'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const pluginPath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');

assert.ok(fs.existsSync(pluginPath), `LIBRA test source does not exist: ${pluginPath}`);
const source = fs.readFileSync(pluginPath, 'utf8');

const requiredCoreNames = [
  'listWorldManagerHistory',
  'getWorldManagerHistoryDetail',
  'listWorldManagerCorrections',
  'getWorldManagerRuntimeMeta'
];

for (const name of requiredCoreNames) {
  assert.match(source, new RegExp(`const\\s+${name}\\s*=\\s*async\\b`), `missing core API: ${name}`);
  assert.match(source, new RegExp(`\\b${name}\\b[\\s\\S]{0,5000}return Object\\.freeze|return Object\\.freeze\\([\\s\\S]{0,5000}\\b${name}\\b`), `core export missing: ${name}`);
  assert.match(source, new RegExp(`async\\s+${name}\\s*\\(`), `public API missing: ${name}`);
}

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

// Domain first-render builders must remain snapshot-only. The paged APIs belong
// behind the explicit History / Corrections tab, never in these cold builders.
for (const [start, end] of [
  ['const buildWorldManagerCharactersPanel =', 'const buildWorldManagerRelationshipsPanel ='],
  ['const buildWorldManagerRelationshipsPanel =', 'const buildWorldManagerWorldPanel ='],
  ['const buildWorldManagerWorldPanel =', 'const buildWorldManagerNarrativeCurrentPanel ='],
  ['const buildWorldManagerNarrativeCurrentPanel =', 'const buildWorldManagerNarrativePanel =']
]) {
  const body = section(start, end);
  assert.doesNotMatch(body, /listWorldManagerHistory|getWorldManagerHistoryDetail|listWorldManagerCorrections|getWorldManagerCorrections/,
    `${start} must not hydrate History or Correction records on first render`);
}
assert.doesNotMatch(source, /const buildSharedHomeOverviewPanel =|const buildSharedHeaderStatusPanel =|const buildInsightRail =/,
  'retired Home and status-dashboard builders must be physically absent');

// The runtime implementation block deliberately has stable boundary markers so
// the fixture can exercise storage call counts without booting a live RisuAI GUI.
const implementationSource = section(
  'const WORLD_MANAGER_HISTORY_DEFAULT_LIMIT =',
  'const mutateStateWorldline ='
);

const SCHEMA = Object.freeze({
  manifest: 'libra.manifest.v1',
  delta: 'libra.continuity_delta.v1',
  correctionStore: 'libra.state_correction_store.v1',
  correctionMeta: 'libra.state_correction_meta.v1',
  correctionCommit: 'libra.state_correction_commit.v1',
  correctionEvent: 'libra.state_correction.v1',
  worldline: 'libra.state_worldline_meta.v1',
  replayCache: 'libra.state_replay_cache.v1',
  replayError: 'libra.state_replay_error.v1'
});

const SCOPE = Object.freeze({ scopeKey: 'scope-a', characterId: 'char-a', chatId: 'chat-a' });

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function string(value) {
  return String(value == null ? '' : value);
}

function compact(value, limit = 1000) {
  return string(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableReferenceJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  const text = typeof value === 'string' ? value : stableReferenceJson(value);
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function mapWithConcurrency(items, loader, concurrency = 12) {
  const source = asArray(items);
  const width = Math.max(1, Math.min(24, Number(concurrency || 12) || 12));
  const out = new Array(source.length);
  for (let offset = 0; offset < source.length; offset += width) {
    const batch = source.slice(offset, offset + width);
    const loaded = await Promise.all(batch.map((item, index) => loader(item, offset + index)));
    for (let index = 0; index < loaded.length; index += 1) out[offset + index] = loaded[index];
  }
  return out;
}

function stateCorrectionReplayJournalDigest(store) {
  return digest(stableReferenceJson({
    scopeKey: string(store?.scopeKey || ''),
    records: asArray(store?.records),
    migratedLegacyOverrideIds: asArray(store?.migratedLegacyOverrideIds)
  }));
}

function makeManifest(count = 100) {
  const memories = {};
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    const start = (ordinal - 1) * 5 + 1;
    const end = start + 4;
    const memoryId = `memory-${String(ordinal).padStart(3, '0')}`;
    memories[String(start)] = {
      memoryId,
      revision: 1,
      sourceDigest: `source-${ordinal}`,
      status: 'committed',
      key: `memory:${memoryId}:r1`,
      deltaKey: `delta:${memoryId}:r1`,
      turnRange: { start, end },
      createdAt: new Date(Date.UTC(2026, 0, ordinal)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, ordinal)).toISOString()
    };
  }
  return {
    schema: SCHEMA.manifest,
    scopeKey: SCOPE.scopeKey,
    memories,
    // This record must not enter current-scope World Manager History.
    inheritedMemories: [{
      memoryId: 'foreign-memory', revision: 1, sourceDigest: 'foreign', status: 'committed',
      key: 'archive:foreign-memory:r1', deltaKey: 'archive-delta:foreign-memory:r1',
      turnRange: { start: 1, end: 5 }, sessionEpoch: -1, inheritedSessionHistory: true
    }],
    frontiers: { observedTurn: count * 5 }
  };
}

function makeDelta(ref, ordinal) {
  const hasNarrative = ordinal % 2 === 0;
  return {
    schema: SCHEMA.delta,
    memoryId: ref.memoryId,
    revision: ref.revision,
    sourceDigest: ref.sourceDigest,
    turnRange: clone(ref.turnRange),
    characterPatch: {
      ok: true,
      patch: {
        characters: [{ operation: 'upsert', id: `character-${ordinal}`, name: `Character ${ordinal}`, set: { mood: 'steady' }, clear: [] }],
        relationships: ordinal % 3 === 0 ? [{ operation: 'upsert', subjectId: 'a', targetId: 'b', dimension: 'trust', state: 'high' }] : [],
        world: []
      }
    },
    worldPatch: {
      ok: true,
      patch: { characters: [], relationships: [], world: ordinal % 4 === 0 ? [{ operation: 'upsert', id: `world-${ordinal}`, name: `World ${ordinal}`, set: { state: 'changed' }, clear: [] }] : [] }
    },
    narrativePatch: hasNarrative ? {
      schema: 'libra.narrative_patch.v1',
      source: 'plot_ito',
      summary: { op: 'set', value: `Narrative ${ordinal}` },
      arcs: [], threads: [], turningPoints: [], locks: [], motifs: []
    } : null,
    domains: {
      character_relationship: { status: 'ready', source: 'character_ito' },
      world: { status: 'ready', source: 'world_ito' },
      narrative: { status: hasNarrative ? 'ready' : 'empty', source: hasNarrative ? 'plot_ito' : 'none' }
    },
    createdAt: ref.updatedAt
  };
}

function makeCorrections(count = 60) {
  const domains = ['characters', 'relationships', 'world', 'narrative'];
  const statuses = ['active', 'suspended', 'dormant_after_rollback', 'superseded', 'deleted'];
  return Array.from({ length: count }, (_, index) => {
    const domain = domains[index % domains.length];
    const status = statuses[index % statuses.length];
    return {
      schema: SCHEMA.correctionEvent,
      correctionId: `correction-${String(index + 1).padStart(3, '0')}`,
      scopeKey: SCOPE.scopeKey,
      worldlineId: index % 2 ? 'main' : 'branch-a',
      anchor: { throughTurn: (index + 1) * 5 },
      basisFingerprint: `basis-${index + 1}`,
      target: { domain, mode: domain === 'narrative' ? 'narrative_patch' : 'profile_patch' },
      before: null,
      after: domain === 'narrative' ? { narrative: { summary: { op: 'set', value: `N${index + 1}` } } } : { [domain]: [{ id: `${domain}-${index + 1}` }] },
      policy: 'point_in_time_override',
      status,
      createdAt: new Date(Date.UTC(2026, 2, index + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 2, index + 1)).toISOString()
    };
  });
}

// The scope-native projection fingerprint is created at closure setup from the
// deployed LIBRA memory network block, so load that real block rather than a stub.
const memoryNetworkStart = source.indexOf('// BEGIN LIBRA MEMORY NETWORK');
const memoryNetworkEnd = source.indexOf('// END LIBRA MEMORY NETWORK', memoryNetworkStart);
assert.ok(memoryNetworkStart >= 0 && memoryNetworkEnd > memoryNetworkStart, 'LIBRA memory network block must be locatable');
const memoryNetworkSource = source.slice(memoryNetworkStart, memoryNetworkEnd);
const memoryNetworkStableHash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

function buildHarness() {
  let manifest = makeManifest();
  let corrections = makeCorrections();
  let strictJournal = true;
  let strictWorldline = true;
  let cache = {
    schema: SCHEMA.replayCache,
    scopeKey: SCOPE.scopeKey,
    worldlineId: 'main',
    fingerprint: 'replay-fingerprint',
    throughTurn: 500,
    appliedDeltas: 100,
    appliedCorrections: corrections.slice(0, 40).map(row => row.correctionId),
    reason: 'fixture',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
  let errors = {
    schema: SCHEMA.replayError,
    scopeKey: SCOPE.scopeKey,
    records: [
      { at: '2026-08-30T00:00:00.000Z', code: 'OLD', message: 'old', context: { large: 'x'.repeat(1000) } },
      { at: '2026-08-31T00:00:00.000Z', code: 'LATEST', message: 'latest', context: { stack: 'must not escape' } }
    ]
  };
  const reads = [];

  const deltaMap = new Map();
  Object.values(manifest.memories).forEach((ref, index) => deltaMap.set(ref.deltaKey, makeDelta(ref, index + 1)));

  const storage = {
    async getJson(storageKey, fallback) {
      reads.push(storageKey);
      if (storageKey === 'cache:scope-a') return cache == null ? fallback : clone(cache);
      if (storageKey === 'errors:scope-a') return errors == null ? fallback : clone(errors);
      return deltaMap.has(storageKey) ? clone(deltaMap.get(storageKey)) : fallback;
    }
  };
  const key = {
    continuityDelta: (_scope, memoryId, revision) => `delta:${memoryId}:r${revision}`,
    stateReplayCache: () => 'cache:scope-a',
    stateReplayErrors: () => 'errors:scope-a'
  };

  const deps = {
    CONTINUITY_DELTA_SCHEMA: SCHEMA.delta,
    CANONICAL_ARTIFACT_SCHEMA: 'libra.canonical_artifact.v3',
    MANIFEST_SCHEMA: SCHEMA.manifest,
    STATE_CORRECTION_EVENT_SCHEMA: SCHEMA.correctionEvent,
    STATE_CORRECTION_META_SCHEMA: SCHEMA.correctionMeta,
    STATE_CORRECTION_COMMIT_SCHEMA: SCHEMA.correctionCommit,
    STATE_CORRECTION_STATUSES: Object.freeze(['active', 'suspended', 'dormant_after_rollback', 'superseded', 'deleted']),
    STATE_REPLAY_CACHE_SCHEMA: SCHEMA.replayCache,
    STATE_REPLAY_ERROR_SCHEMA: SCHEMA.replayError,
    clone, asArray, asObject, string, compact, stableReferenceJson, digest, mapWithConcurrency, storage, key,
    resolveContext: async () => ({ scope: clone(SCOPE), chat: { messages: [] } }),
    buildPairs: () => [],
    loadManifest: async () => clone(manifest),
    loadStateCorrectionJournal: async (_scope, options = {}) => {
      assert.equal(options.strict, true, 'Correction pagination must strict-read the journal');
      if (!strictJournal) {
        const error = new Error('invalid journal');
        error.code = 'STATE_CORRECTION_JOURNAL_INVALID';
        throw error;
      }
      return {
        schema: SCHEMA.correctionStore,
        scopeKey: SCOPE.scopeKey,
        revision: 7,
        records: clone(corrections),
        migratedLegacyOverrideIds: [],
        updatedAt: '2026-08-31T00:00:00.000Z'
      };
    },
    ensureStateCorrectionMetaForJournal: async () => true,
    loadStateCorrectionMeta: async (_scope, options = {}) => {
      assert.equal(options.strict, true, 'Runtime meta must strict-read the bounded correction metadata');
      const counts = Object.fromEntries(['active', 'suspended', 'dormant_after_rollback', 'superseded', 'deleted']
        .map(status => [status, corrections.filter(row => row.status === status).length]));
      counts.total = corrections.length;
      return { schema: SCHEMA.correctionMeta, scopeKey: SCOPE.scopeKey, journalRevision: 7, journalDigest: 'a'.repeat(64), correctionCounts: counts };
    },
    loadStateCorrectionCommit: async (_scope, options = {}) => {
      assert.equal(options.strict, true, 'Runtime meta must strict-read the bounded correction commit marker');
      return { schema: SCHEMA.correctionCommit, scopeKey: SCOPE.scopeKey, status: 'committed', transactionId: 'fixture', targetJournalRevision: 7, targetJournalDigest: 'a'.repeat(64) };
    },
    stateCorrectionMetaCommitCoherent: (meta, commit) => Boolean(meta && commit
      && commit.status === 'committed'
      && Number(commit.targetJournalRevision) === Number(meta.journalRevision)
      && string(commit.targetJournalDigest) === string(meta.journalDigest)),
    loadStateWorldlineMeta: async (_scope, options = {}) => {
      assert.equal(options.strict, true, 'Runtime meta must strict-read worldline metadata');
      if (!strictWorldline) {
        const error = new Error('invalid worldline');
        error.code = 'STATE_WORLDLINE_META_INVALID';
        throw error;
      }
      return {
        schema: SCHEMA.worldline,
        scopeKey: SCOPE.scopeKey,
        activeWorldlineId: 'main',
        revision: 4,
        worldlines: {
          main: { id: 'main', parentId: null, forkTurn: 0, cutoffTurn: null, active: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' },
          branch: { id: 'branch', parentId: 'main', forkTurn: 250, cutoffTurn: 300, active: false, secret: 'must not escape' }
        },
        updatedAt: '2026-08-31T00:00:00.000Z'
      };
    },
    state: { snapshot: null, worldManagerRuntimeMetaGeneration: 0 },
    stateCorrectionFailure: (code, message = code) => Object.assign(new Error(message), { code })
  };

  deps.stableHash = memoryNetworkStableHash;
  Object.assign(deps,require('./fixtures/librarian_production_bindings.cjs')(source));
  const names = Object.keys(deps);
  const factory = Function(...names, `'use strict';\n${memoryNetworkSource}\n${implementationSource}\nreturn { ${requiredCoreNames.join(', ')} };`);
  const api = factory(...names.map(name => deps[name]));

  return {
    api,
    reads,
    deltaMap,
    get manifest() { return manifest; },
    set manifest(value) { manifest = value; },
    get corrections() { return corrections; },
    set corrections(value) { corrections = value; },
    set strictJournal(value) { strictJournal = value; },
    set strictWorldline(value) { strictWorldline = value; },
    set cache(value) { cache = value; },
    set errors(value) { errors = value; }
  };
}

function assertCode(error, expected) {
  assert.ok(error, `expected ${expected} error`);
  assert.equal(error.code, expected);
}

(async () => {
  {
    const harness = buildHarness();
    const page = await harness.api.listWorldManagerHistory({ domain: 'all', limit: 20, cursor: '' });
    assert.equal(page.items.length, 20);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    assert.ok(!/[{[]/.test(page.nextCursor), 'cursor must be opaque, not serialized JSON');
    assert.ok(!page.nextCursor.includes('memory-'), 'cursor must not expose memory identity');
    assert.equal(page.items[0].memoryId, 'memory-100', 'History must be newest-first');
    assert.equal(page.items.at(-1).memoryId, 'memory-081');
    assert.equal(harness.reads.filter(value => value.startsWith('delta:')).length, 20, 'first page must read only its 20 deltas');
    assert.equal(harness.reads.includes('archive-delta:foreign-memory:r1'), false, 'inherited/archive refs are outside current-scope History');
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item.domains).sort(), ['characters', 'narrative', 'relationships', 'world']);
      assert.equal(typeof item.narrativeSummary, 'string');
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'characterPatch'), false, 'metadata page must not expose raw patches');
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'delta'), false, 'metadata page must not expose raw delta');
    }

    harness.reads.length = 0;
    const second = await harness.api.listWorldManagerHistory({ domain: 'all', limit: 20, cursor: page.nextCursor });
    assert.equal(second.items[0].memoryId, 'memory-080');
    assert.equal(second.items.at(-1).memoryId, 'memory-061');
    assert.equal(harness.reads.filter(value => value.startsWith('delta:')).length, 20, 'second page must read only its 20 deltas');
    assert.equal(new Set([...page.items, ...second.items].map(item => item.memoryId)).size, 40);

    harness.reads.length = 0;
    let filterError = null;
    try { await harness.api.listWorldManagerHistory({ domain: 'narrative', limit: 20, cursor: page.nextCursor }); }
    catch (error) { filterError = error; }
    assertCode(filterError, 'WORLD_MANAGER_HISTORY_CURSOR_INVALID');
    assert.equal(harness.reads.filter(value => value.startsWith('delta:')).length, 0, 'invalid cursor/filter must fail before delta reads');

    harness.manifest = { ...harness.manifest, memories: { ...harness.manifest.memories } };
    delete harness.manifest.memories['1'];
    harness.reads.length = 0;
    let staleError = null;
    try { await harness.api.listWorldManagerHistory({ domain: 'all', limit: 20, cursor: page.nextCursor }); }
    catch (error) { staleError = error; }
    assertCode(staleError, 'WORLD_MANAGER_HISTORY_CURSOR_INVALID');
    assert.equal(harness.reads.filter(value => value.startsWith('delta:')).length, 0, 'stale cursor must fail before delta reads');
  }

  {
    const harness = buildHarness();
    const detail = await harness.api.getWorldManagerHistoryDetail({ memoryId: 'memory-050', revision: 1 });
    assert.equal(detail.item.memoryId, 'memory-050');
    assert.equal(detail.item.revision, 1);
    assert.equal(detail.delta.schema, SCHEMA.delta);
    assert.equal(harness.reads.filter(value => value.startsWith('delta:')).length, 1, 'detail must read one manifest-owned delta only');

    const ownedKey = harness.manifest.memories[String((50 - 1) * 5 + 1)].deltaKey;
    const corrupt = clone(harness.deltaMap.get(ownedKey));
    corrupt.sourceDigest = 'wrong-owner';
    harness.deltaMap.set(ownedKey, corrupt);
    let mismatch = null;
    try { await harness.api.getWorldManagerHistoryDetail({ memoryId: 'memory-050', revision: 1 }); }
    catch (error) { mismatch = error; }
    assertCode(mismatch, 'WORLD_MANAGER_HISTORY_DELTA_IDENTITY_MISMATCH');

    harness.manifest.memories[String((50 - 1) * 5 + 1)].deltaKey = 'delta:scope-b:memory-050:r1';
    let foreignKey = null;
    try { await harness.api.getWorldManagerHistoryDetail({ memoryId: 'memory-050', revision: 1 }); }
    catch (error) { foreignKey = error; }
    assertCode(foreignKey, 'WORLD_MANAGER_HISTORY_DELTA_KEY_INVALID');
    harness.manifest.memories[String((50 - 1) * 5 + 1)].deltaKey = ownedKey;

    let notFound = null;
    try { await harness.api.getWorldManagerHistoryDetail({ memoryId: 'foreign-memory', revision: 1 }); }
    catch (error) { notFound = error; }
    assertCode(notFound, 'WORLD_MANAGER_HISTORY_NOT_FOUND');
  }

  {
    const harness = buildHarness();
    const page = await harness.api.listWorldManagerCorrections({ domain: 'all', status: 'all', limit: 20, cursor: '' });
    assert.equal(page.items.length, 20);
    assert.equal(page.hasMore, true);
    assert.ok(page.items.every(row => row.schema === SCHEMA.correctionEvent));
    assert.equal(Object.prototype.hasOwnProperty.call(page, 'records'), false, 'pagination API must not return the whole journal wrapper');
    assert.ok(!/[{[]/.test(page.nextCursor), 'Correction cursor must be opaque, not serialized JSON');
    assert.ok(!page.nextCursor.includes('correction-'), 'Correction cursor must not expose correction identity');
    const second = await harness.api.listWorldManagerCorrections({ domain: 'all', status: 'all', limit: 20, cursor: page.nextCursor });
    assert.equal(second.items.length, 20);
    assert.equal(new Set([...page.items, ...second.items].map(row => row.correctionId)).size, 40);

    const filtered = await harness.api.listWorldManagerCorrections({ domain: 'characters', status: 'active', limit: 20, cursor: '' });
    assert.ok(filtered.items.length > 0 && filtered.items.length <= 20);
    assert.ok(filtered.items.every(row => row.target.domain === 'characters' && row.status === 'active'));

    const mutated = clone(harness.corrections);
    mutated[0].status = 'suspended';
    mutated[0].updatedAt = '2026-09-01T00:00:00.000Z';
    harness.corrections = mutated;
    let staleCursor = null;
    try { await harness.api.listWorldManagerCorrections({ domain: 'all', status: 'all', limit: 20, cursor: page.nextCursor }); }
    catch (error) { staleCursor = error; }
    assertCode(staleCursor, 'WORLD_MANAGER_CORRECTION_CURSOR_INVALID');

    harness.strictJournal = false;
    let invalid = null;
    try { await harness.api.listWorldManagerCorrections({ domain: 'all', status: 'all', limit: 20, cursor: '' }); }
    catch (error) { invalid = error; }
    assertCode(invalid, 'STATE_CORRECTION_JOURNAL_INVALID');
  }

  {
    const harness = buildHarness();
    const meta = await harness.api.getWorldManagerRuntimeMeta();
    assert.equal(meta.scopeKey, SCOPE.scopeKey);
    assert.equal(meta.worldline.activeWorldlineId, 'main');
    assert.equal(meta.worldline.current.id, 'main');
    assert.equal(Object.prototype.hasOwnProperty.call(meta.worldline, 'worldlines'), false, 'runtime meta must return only current worldline projection');
    assert.equal(meta.replayCache.appliedCorrectionsCount, 40);
    assert.equal(Object.prototype.hasOwnProperty.call(meta.replayCache, 'appliedCorrections'), false, 'runtime meta must not return correction IDs');
    assert.equal(meta.correctionCounts.total, 60);
    assert.equal(meta.correctionCounts.active, 12);
    assert.equal(meta.lastReplayError.code, 'LATEST');
    assert.equal(Object.prototype.hasOwnProperty.call(meta.lastReplayError.context || {}, 'stack'), false, 'runtime meta must not expose error stack');

    harness.cache = { schema: 'wrong', scopeKey: SCOPE.scopeKey };
    let cacheError = null;
    try { await harness.api.getWorldManagerRuntimeMeta(); }
    catch (error) { cacheError = error; }
    assertCode(cacheError, 'WORLD_MANAGER_REPLAY_CACHE_INVALID');

    const clean = buildHarness();
    clean.errors = { schema: 'wrong', scopeKey: SCOPE.scopeKey, records: [] };
    let replayError = null;
    try { await clean.api.getWorldManagerRuntimeMeta(); }
    catch (error) { replayError = error; }
    assertCode(replayError, 'WORLD_MANAGER_REPLAY_ERROR_STORE_INVALID');
  }

  console.log('PASS libra_world_manager_history_core_rc2_test');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
