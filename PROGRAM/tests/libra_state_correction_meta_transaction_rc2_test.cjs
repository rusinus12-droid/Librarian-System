'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const pluginPath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');

assert.ok(fs.existsSync(pluginPath), `LIBRA test source does not exist: ${pluginPath}`);
const source = fs.readFileSync(pluginPath, 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const correctionSupportSource = sourceSection(
  'const stateCorrectionDefaultStore =',
  'const saveStateWorldlineMeta ='
);
const runtimeMetaSource = sourceSection(
  'const getWorldManagerRuntimeMeta =',
  'const migrateLegacyContinuityOverrides ='
);

const SCHEMAS = Object.freeze({
  correctionStore: 'libra.state_correction_store.v1',
  correctionMeta: 'libra.state_correction_meta.v1',
  correctionCommit: 'libra.state_correction_commit.v1',
  correctionEvent: 'libra.state_correction.v1',
  worldlineMeta: 'libra.state_worldline_meta.v1',
  replayCache: 'libra.state_replay_cache.v1',
  replayError: 'libra.state_replay_error.v1'
});
const STATUSES = Object.freeze(['active', 'suspended', 'dormant_after_rollback', 'superseded', 'deleted']);
const SCOPE = Object.freeze({ scopeKey: 'scope-meta-contract', chatId: 'chat-meta-contract' });
const KEYS = Object.freeze({
  journal: `state-corrections:${SCOPE.scopeKey}`,
  meta: `state-correction-meta:${SCOPE.scopeKey}`,
  commit: `state-correction-commit:${SCOPE.scopeKey}`,
  worldline: `state-worldline-meta:${SCOPE.scopeKey}`,
  replayCache: `state-replay-cache:${SCOPE.scopeKey}`,
  replayErrors: `state-replay-errors:${SCOPE.scopeKey}`
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(keyName => [keyName, stableValue(value[keyName])]));
  }
  return value;
}

function stableReferenceJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  const text = typeof value === 'string' ? value : stableReferenceJson(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= 31;
  hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length + 1}`;
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

function makeRecord(correctionId, status) {
  return {
    schema: SCHEMAS.correctionEvent,
    correctionId,
    scopeKey: SCOPE.scopeKey,
    worldlineId: 'main',
    anchor: { throughTurn: 12 },
    target: { domain: 'characters', mode: 'profile_patch' },
    before: null,
    after: { characters: [{ id: `character-${correctionId}` }] },
    policy: 'point_in_time_override',
    status,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function makeJournal(records = [makeRecord('baseline-active', 'active')]) {
  return {
    schema: SCHEMAS.correctionStore,
    scopeKey: SCOPE.scopeKey,
    revision: 4,
    records: clone(records),
    migratedLegacyOverrideIds: ['legacy-baseline'],
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function correctionCounts(records) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, records.filter(row => row.status === status).length]));
  counts.total = records.length;
  counts.available = true;
  return counts;
}

function makeMeta(journal) {
  return {
    schema: SCHEMAS.correctionMeta,
    scopeKey: SCOPE.scopeKey,
    journalRevision: Number(journal.revision || 0),
    journalDigest: digest(stableReferenceJson({
      schema: journal.schema,
      scopeKey: journal.scopeKey,
      revision: journal.revision,
      records: asArray(journal.records),
      migratedLegacyOverrideIds: asArray(journal.migratedLegacyOverrideIds)
    })),
    correctionCounts: correctionCounts(asArray(journal.records)),
    updatedAt: string(journal.updatedAt || '')
  };
}

function makeWorldlineMeta() {
  return {
    schema: SCHEMAS.worldlineMeta,
    scopeKey: SCOPE.scopeKey,
    activeWorldlineId: 'main',
    revision: 3,
    worldlines: {
      main: {
        id: 'main', parentId: null, forkTurn: 0, cutoffTurn: null, active: true,
        createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z'
      }
    },
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function makeCommit(meta, status = 'committed', transactionId = 'commit-baseline') {
  return {
    schema: SCHEMAS.correctionCommit,
    scopeKey: SCOPE.scopeKey,
    status,
    transactionId,
    targetJournalRevision: Number(meta.journalRevision || 0),
    targetJournalDigest: String(meta.journalDigest || ''),
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...(status === 'committed' ? { committedAt: '2026-08-31T00:00:00.000Z' } : {})
  };
}

function makeInitialRaw() {
  const journal = makeJournal();
  const meta = makeMeta(journal);
  return new Map([
    [KEYS.journal, JSON.stringify(journal)],
    [KEYS.meta, JSON.stringify(meta)],
    [KEYS.commit, JSON.stringify(makeCommit(meta))],
    [KEYS.worldline, JSON.stringify(makeWorldlineMeta())]
  ]);
}

function makeStorage(raw, hooks, stats) {
  return {
    async getJson(storageKey, fallback = null) {
      stats.reads[storageKey] = Number(stats.reads[storageKey] || 0) + 1;
      if (storageKey === KEYS.journal && hooks.throwOnJournalRead) {
        throw new Error('full correction journal must not be read');
      }
      if (storageKey === KEYS.meta && hooks.failMetaRollbackReadback && stats.metaWriteAttempts >= 2) {
        hooks.failMetaRollbackReadback = false;
        const error = new Error('fixture meta rollback readback failed');
        error.code = 'FIXTURE_META_ROLLBACK_READBACK_FAILED';
        throw error;
      }
      if (!raw.has(storageKey)) return clone(fallback);
      return JSON.parse(raw.get(storageKey));
    },
    async setJson(storageKey, value) {
      if (storageKey === KEYS.journal) {
        stats.journalWriteAttempts += 1;
        if (hooks.corruptNextJournalWrite) {
          hooks.corruptNextJournalWrite = false;
          const corrupted = clone(value);
          corrupted.revision = Number(corrupted.revision || 0) + 100;
          raw.set(storageKey, JSON.stringify(corrupted));
          return;
        }
      }
      if (storageKey === KEYS.meta) {
        stats.metaWriteAttempts += 1;
        if (hooks.failNextMetaWrite) {
          hooks.failNextMetaWrite = false;
          const error = new Error('fixture meta write failed');
          error.code = 'FIXTURE_META_WRITE_FAILED';
          throw error;
        }
        if (hooks.corruptNextMetaWrite) {
          hooks.corruptNextMetaWrite = false;
          const corrupted = clone(value);
          corrupted.journalRevision = Number(corrupted.journalRevision || 0) + 100;
          raw.set(storageKey, JSON.stringify(corrupted));
          return;
        }
      }
      if (storageKey === KEYS.commit) stats.commitWriteAttempts += 1;
      raw.set(storageKey, JSON.stringify(value));
    },
    async remove(storageKey) {
      stats.removes += 1;
      raw.delete(storageKey);
    }
  };
}

function buildHarness(hookValues = {}) {
  const raw = makeInitialRaw();
  const hooks = {
    corruptNextJournalWrite: false,
    corruptNextMetaWrite: false,
    failNextMetaWrite: false,
    failMetaRollbackReadback: false,
    throwOnJournalRead: false,
    ...hookValues
  };
  const stats = {
    reads: Object.create(null),
    journalWriteAttempts: 0,
    metaWriteAttempts: 0,
    commitWriteAttempts: 0,
    removes: 0
  };
  const storage = makeStorage(raw, hooks, stats);
  const state = {
    worldManagerRuntimeMetaGeneration: 0,
    snapshot: null
  };
  let nowTick = 0;
  const context = {
    console,
    STATE_CORRECTION_STORE_SCHEMA: SCHEMAS.correctionStore,
    STATE_CORRECTION_META_SCHEMA: SCHEMAS.correctionMeta,
    STATE_CORRECTION_COMMIT_SCHEMA: SCHEMAS.correctionCommit,
    STATE_CORRECTION_EVENT_SCHEMA: SCHEMAS.correctionEvent,
    STATE_WORLDLINE_META_SCHEMA: SCHEMAS.worldlineMeta,
    STATE_REPLAY_CACHE_SCHEMA: SCHEMAS.replayCache,
    STATE_REPLAY_ERROR_SCHEMA: SCHEMAS.replayError,
    STATE_CORRECTION_STATUSES: clone(STATUSES),
    storage,
    key: {
      stateCorrections: () => KEYS.journal,
      stateCorrectionMeta: () => KEYS.meta,
      stateCorrectionCommit: () => KEYS.commit,
      stateWorldlineMeta: () => KEYS.worldline,
      stateReplayCache: () => KEYS.replayCache,
      stateReplayErrors: () => KEYS.replayErrors
    },
    clone,
    stableReferenceJson,
    digest,
    asArray,
    asObject,
    string,
    compact,
    id: prefix => `${prefix}_fixture_${nowTick}`,
    nowIso: () => `2026-08-31T01:00:${String(nowTick++).padStart(2, '0')}.000Z`,
    resolveContext: async () => ({ scope: clone(SCOPE), chat: [] }),
    state
  };

  vm.createContext(context);
  vm.runInContext(
    `${correctionSupportSource}\n${runtimeMetaSource}\n` +
    'globalThis.__testExports={saveStateCorrectionJournal,getWorldManagerRuntimeMeta,stateCorrectionMetaFromJournal,loadStateCorrectionMeta,loadStateCorrectionCommit};',
    context,
    { filename: pluginPath }
  );

  return { ...context.__testExports, raw, hooks, stats, state };
}

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to reject');
}

function hostValue(value) {
  return clone(value);
}

function previousRawPair(harness) {
  return {
    journal: harness.raw.get(KEYS.journal),
    meta: harness.raw.get(KEYS.meta),
    commit: harness.raw.get(KEYS.commit)
  };
}

function assertPreviousRawPair(harness, before) {
  assert.equal(harness.raw.get(KEYS.journal), before.journal, 'journal raw bytes must be restored exactly');
  assert.equal(harness.raw.get(KEYS.meta), before.meta, 'correction meta raw bytes must be restored exactly');
  assert.equal(harness.raw.get(KEYS.commit), before.commit, 'correction commit raw bytes must be restored exactly');
}

async function testSuccessfulJournalAndMetaExactReadback() {
  const harness = buildHarness();
  const input = makeJournal([
    makeRecord('correction-active', 'active'),
    makeRecord('correction-suspended', 'suspended'),
    makeRecord('correction-superseded', 'superseded'),
    makeRecord('correction-deleted', 'deleted')
  ]);
  input.revision = 12;
  input.migratedLegacyOverrideIds = ['legacy-a', 'legacy-a', '', 'legacy-b'];

  const saved = hostValue(await harness.saveStateCorrectionJournal(clone(SCOPE), input));
  const storedJournal = JSON.parse(harness.raw.get(KEYS.journal));
  const storedMeta = JSON.parse(harness.raw.get(KEYS.meta));
  const storedCommit = JSON.parse(harness.raw.get(KEYS.commit));
  const expectedMeta = makeMeta(saved);

  assert.deepEqual(storedJournal, saved, 'returned journal must equal the durable readback');
  assert.equal(harness.raw.get(KEYS.journal), JSON.stringify(saved), 'journal bytes must encode the exact returned readback');
  assert.equal(saved.revision, 13);
  assert.deepEqual(saved.migratedLegacyOverrideIds, ['legacy-a', 'legacy-b']);
  assert.deepEqual(storedMeta, expectedMeta, 'small meta must exactly summarize the saved journal');
  assert.equal(harness.raw.get(KEYS.meta), JSON.stringify(expectedMeta), 'meta bytes must encode the exact expected readback');
  assert.equal(storedMeta.journalRevision, saved.revision);
  assert.equal(storedCommit.status, 'committed');
  assert.equal(storedCommit.targetJournalRevision, storedMeta.journalRevision);
  assert.equal(storedCommit.targetJournalDigest, storedMeta.journalDigest);
  assert.deepEqual(storedMeta.correctionCounts, {
    active: 1,
    suspended: 1,
    dormant_after_rollback: 0,
    superseded: 1,
    deleted: 1,
    total: 4,
    available: true
  });
  assert.equal(harness.state.worldManagerRuntimeMetaGeneration, 2);
}

async function testCorruptJournalRestoresBothRawValues() {
  const harness = buildHarness({ corruptNextJournalWrite: true });
  const before = previousRawPair(harness);
  const error = await caught(harness.saveStateCorrectionJournal(clone(SCOPE), makeJournal([
    makeRecord('new-active', 'active')
  ])));
  assert.equal(error.code, 'STATE_CORRECTION_JOURNAL_READBACK_FAILED');
  assertPreviousRawPair(harness, before);
  assert.equal(harness.stats.metaWriteAttempts, 1, 'meta is only written by rollback when journal validation fails');
}

async function testCorruptMetaRestoresBothRawValues() {
  const harness = buildHarness({ corruptNextMetaWrite: true });
  const before = previousRawPair(harness);
  const error = await caught(harness.saveStateCorrectionJournal(clone(SCOPE), makeJournal([
    makeRecord('new-suspended', 'suspended')
  ])));
  assert.equal(error.code, 'STATE_CORRECTION_META_READBACK_FAILED');
  assertPreviousRawPair(harness, before);
}

async function testMetaWriteFailureRestoresBothRawValues() {
  const harness = buildHarness({ failNextMetaWrite: true });
  const before = previousRawPair(harness);
  const error = await caught(harness.saveStateCorrectionJournal(clone(SCOPE), makeJournal([
    makeRecord('new-deleted', 'deleted')
  ])));
  assert.equal(error.code, 'FIXTURE_META_WRITE_FAILED');
  assertPreviousRawPair(harness, before);
}

async function testMetaRollbackReadbackFailureIsIncomplete() {
  const harness = buildHarness({ corruptNextMetaWrite: true, failMetaRollbackReadback: true });
  const before = previousRawPair(harness);
  const error = await caught(harness.saveStateCorrectionJournal(clone(SCOPE), makeJournal([
    makeRecord('new-active', 'active')
  ])));
  assert.equal(error.code, 'STATE_CORRECTION_ROLLBACK_INCOMPLETE');
  assert.match(error.message, /meta rollback readback failed/);
  assert.equal(harness.raw.get(KEYS.journal), before.journal);
  assert.equal(harness.raw.get(KEYS.meta), before.meta);
  assert.equal(JSON.parse(harness.raw.get(KEYS.commit)).status, 'pending', 'incomplete rollback must remain fail-closed');
}

async function testRuntimeMetaFirstReadNeverLoadsFullJournal() {
  const harness = buildHarness({ throwOnJournalRead: true });
  const expectedMeta = JSON.parse(harness.raw.get(KEYS.meta));
  const result = hostValue(await harness.getWorldManagerRuntimeMeta());

  assert.equal(Number(harness.stats.reads[KEYS.journal] || 0), 0, 'cold runtime-meta read must not load full correction journal');
  assert.equal(Number(harness.stats.reads[KEYS.meta] || 0), 1, 'cold runtime-meta read must load the small meta exactly once');
  assert.equal(Number(harness.stats.reads[KEYS.commit] || 0), 1, 'cold runtime-meta read must load the small commit marker exactly once');
  assert.equal(result.worldline.activeWorldlineId, 'main');
  assert.deepEqual(result.correctionCounts, expectedMeta.correctionCounts);
  assert.equal(result.correctionCounts.available, true);
}

async function testWriterLoaderRoundTripUsesActualDigestFormat() {
  const harness = buildHarness();
  await harness.saveStateCorrectionJournal(clone(SCOPE), makeJournal([makeRecord('roundtrip', 'active')]));
  const loadedMeta = hostValue(await harness.loadStateCorrectionMeta(clone(SCOPE), { strict: true }));
  const loadedCommit = hostValue(await harness.loadStateCorrectionCommit(clone(SCOPE), { strict: true }));
  assert.match(loadedMeta.journalDigest, /^[a-f0-9]{8}:\d+$/i);
  assert.equal(loadedCommit.status, 'committed');
  assert.equal(loadedCommit.targetJournalDigest, loadedMeta.journalDigest);
}

async function testPendingAndMismatchedCommitHideCounts() {
  const harness = buildHarness();
  const meta = JSON.parse(harness.raw.get(KEYS.meta));
  harness.raw.set(KEYS.commit, JSON.stringify(makeCommit(meta, 'pending', 'crash-window')));
  let result = hostValue(await harness.getWorldManagerRuntimeMeta());
  assert.equal(result.correctionCounts.available, false);
  assert.equal(result.correctionCounts.total, null);
  harness.raw.set(KEYS.commit, JSON.stringify(makeCommit({ ...meta, journalRevision: meta.journalRevision + 1 }, 'committed', 'mismatch')));
  result = hostValue(await harness.getWorldManagerRuntimeMeta());
  assert.equal(result.correctionCounts.available, false);
}

const tests = [
  ['successful save has exact journal/meta readback, counts, and journalRevision', testSuccessfulJournalAndMetaExactReadback],
  ['corrupt journal restores previous journal and meta raw bytes', testCorruptJournalRestoresBothRawValues],
  ['corrupt meta restores previous journal and meta raw bytes', testCorruptMetaRestoresBothRawValues],
  ['meta write failure restores previous journal and meta raw bytes', testMetaWriteFailureRestoresBothRawValues],
  ['meta rollback readback failure reports STATE_CORRECTION_ROLLBACK_INCOMPLETE', testMetaRollbackReadbackFailureIsIncomplete],
  ['first runtime-meta read performs zero full-journal reads', testRuntimeMetaFirstReadNeverLoadsFullJournal]
  ,['writer output passes strict loader with the actual digest format', testWriterLoaderRoundTripUsesActualDigestFormat]
  ,['pending or mismatched commit markers hide correction counts', testPendingAndMismatchedCommitHideCounts]
];

(async () => {
  const failures = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`source: ${pluginPath}`);
  console.log(`result: ${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length) process.exitCode = 1;
})();
