'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const sourcePath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};
const flatten = value => Array.isArray(value) ? value.flat(Infinity).filter(Boolean) : [];
const guiEl = (tag, attrs = {}, children = []) => ({ tag, attrs, children: flatten(children) });
const visibleText = node => {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(visibleText).join('\n');
  if (typeof node !== 'object') return String(node);
  return [node.attrs?.text || '', ...flatten(node.children).map(visibleText)].filter(Boolean).join('\n');
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};

const auditFailures = [];
const check = (condition, message) => {
  if (!condition) auditFailures.push(message);
};

assert.doesNotMatch(source, /const (?:currentWorldManagerScopeKey|loadWorldManagerRuntimeMeta|scheduleWorldManagerRuntimeMetaLoad|replayWorldManagerFromHome|openWorldManagerDiagnostics)\s*=/,
  'retired Home runtime-meta adapters must remain physically absent');
const replayScopeCore = between('const rebuildCurrentStateForWorldline = async', 'const rollbackStateCorrectionMutation =');
assert.match(replayScopeCore, /options\.expectedScopeKey[\s\S]*STATE_REPLAY_SCOPE_CHANGED/,
  'core replay must reject a scope that changed before its first context resolution');

const runtimeCoreFragment = between(
  'const getWorldManagerRuntimeMeta = async (',
  '\n\n    const migrateLegacyContinuityOverrides ='
);

async function auditRuntimeMetaCore() {
  let fullCorrectionJournalReads = 0;
  let smallCorrectionMetaReads = 0;
  let correctionCommitReads = 0;
  let replayCacheValue = null;
  let replayErrorsValue = null;
  const scope = { scopeKey: 'scope-core' };
  const correctionMetaValue = {
    schema: 'libra.state_correction_meta.v1',
    scopeKey: scope.scopeKey,
    journalRevision: 7,
    journalDigest: 'deadbeef:128',
    generation: 'correction-meta-7',
    counts: { active: 2, suspended: 1, dormant_after_rollback: 0, superseded: 0, deleted: 0, total: 3 },
    correctionCounts: { active: 2, suspended: 1, dormant_after_rollback: 0, superseded: 0, deleted: 0, total: 3 }
  };
  let correctionCommitValue = {
    schema: 'libra.state_correction_commit.v1', scopeKey: scope.scopeKey,
    status: 'committed', transactionId: 'runtime-meta-fixture',
    targetJournalRevision: correctionMetaValue.journalRevision,
    targetJournalDigest: correctionMetaValue.journalDigest
  };
  const readSmallCorrectionMeta = async () => {
    smallCorrectionMetaReads += 1;
    return correctionMetaValue;
  };
  const key = new Proxy({}, {
    get: (_target, property) => () => String(property)
  });
  const context = {
    Object, JSON, Number, Array, String, Date, Promise, Proxy,
    STATE_REPLAY_CACHE_SCHEMA: 'libra.state_replay_cache.v1',
    STATE_REPLAY_ERROR_SCHEMA: 'libra.state_replay_error.v1',
    STATE_CORRECTION_META_SCHEMA: 'libra.state_correction_meta.v1',
    STATE_CORRECTION_COMMIT_SCHEMA: 'libra.state_correction_commit.v1',
    STATE_CORRECTION_STATUSES: ['active', 'suspended', 'dormant_after_rollback', 'superseded', 'deleted'],
    resolveContext: async () => ({ scope }),
    loadStateWorldlineMeta: async () => ({
      schema: 'libra.state_worldline_meta.v1', scopeKey: scope.scopeKey,
      revision: 4, activeWorldlineId: 'main', worldlines: { main: { id: 'main', revision: 4 } }
    }),
    // This is a tripwire, not fixture data: the bounded Home API must not need it.
    loadStateCorrectionJournal: async () => {
      fullCorrectionJournalReads += 1;
      return { records: [{ status: 'active' }, { status: 'active' }, { status: 'suspended' }] };
    },
    loadStateCorrectionMeta: readSmallCorrectionMeta,
    loadStateCorrectionCommit: async () => {
      correctionCommitReads += 1;
      return correctionCommitValue;
    },
    stateCorrectionMetaCommitCoherent: (meta, commit) => Boolean(meta && commit
      && commit.status === 'committed'
      && Number(commit.targetJournalRevision) === Number(meta.journalRevision)
      && String(commit.targetJournalDigest || '') === String(meta.journalDigest || '')),
    loadStateCorrectionRuntimeMeta: readSmallCorrectionMeta,
    loadStateCorrectionSummary: readSmallCorrectionMeta,
    loadStateCorrectionCounts: readSmallCorrectionMeta,
    getStateCorrectionRuntimeMeta: readSmallCorrectionMeta,
    state: { worldManagerRuntimeMetaGeneration: 9 },
    storage: {
      getJson: async storageKey => {
        const normalized = String(storageKey).toLowerCase();
        if (normalized.includes('replaycache')) return replayCacheValue;
        if (normalized.includes('replayerror')) return replayErrorsValue;
        if (normalized.includes('correction') && normalized.includes('meta')) return readSmallCorrectionMeta();
        return null;
      }
    },
    key,
    string: value => String(value ?? ''),
    asArray: value => Array.isArray(value) ? value : [],
    asObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    stateCorrectionCountSummary: recordsValue => {
      const rows = Array.isArray(recordsValue) ? recordsValue : [];
      const counts = Object.fromEntries(context.STATE_CORRECTION_STATUSES.map(status => [status, rows.filter(row => row?.status === status).length]));
      counts.total = rows.length;
      counts.available = true;
      return counts;
    },
    clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
    compact: (value, limit = 700) => String(value ?? '').slice(0, limit),
    stateCorrectionFailure: (code, message = code) => Object.assign(new Error(message), { code })
  };
  vm.createContext(context);
  vm.runInContext(`${runtimeCoreFragment}\nthis.getWorldManagerRuntimeMeta = getWorldManagerRuntimeMeta;`, context);

  const laterSuccess = {
    schema: context.STATE_REPLAY_CACHE_SCHEMA,
    scopeKey: scope.scopeKey,
    worldlineId: 'main', fingerprint: 'fp-success', throughTurn: 20,
    appliedDeltas: 4, appliedCorrections: [], reason: 'test', updatedAt: '2026-08-31T02:00:00.000Z'
  };
  const rollbackIncomplete = {
    errorId: 'err-rollback', at: '2026-08-31T01:00:00.000Z', code: 'STATE_REPLAY_ROLLBACK_INCOMPLETE',
    message: 'rollback readback failed', worldlineId: 'main',
    context: { worldlineId: 'main', rollbackIncomplete: true },
    resolvedAt: '2026-08-31T02:00:01.000Z',
    resolution: { worldlineId: 'main', replayFingerprint: laterSuccess.fingerprint }
  };
  const normalError = {
    errorId: 'err-normal', at: '2026-08-31T01:00:00.000Z', code: 'STATE_REPLAY_FAILED',
    message: 'ordinary replay failed', worldlineId: 'main',
    context: { worldlineId: 'main', rollbackIncomplete: false }
  };

  replayCacheValue = laterSuccess;
  replayErrorsValue = { schema: context.STATE_REPLAY_ERROR_SCHEMA, scopeKey: scope.scopeKey, records: [rollbackIncomplete] };
  const rollbackMeta = await context.getWorldManagerRuntimeMeta();
  check(rollbackMeta?.lastReplayError?.code === rollbackIncomplete.code,
    'rollbackIncomplete replay error was auto-cleared merely because a later replay cache timestamp existed');
  check(rollbackMeta?.correctionCounts?.active === 2 && rollbackMeta?.correctionCounts?.total === 3,
    'runtime-meta core did not project correction counts from the bounded correction metadata record');

  correctionCommitValue = { ...correctionCommitValue, status: 'pending' };
  const pendingMeta = await context.getWorldManagerRuntimeMeta();
  check(pendingMeta?.correctionCounts?.available === false && pendingMeta?.correctionCounts?.total == null,
    'runtime-meta core exposed counts while the correction commit marker was pending');
  correctionCommitValue = { ...correctionCommitValue, status: 'committed' };

  replayErrorsValue = { schema: context.STATE_REPLAY_ERROR_SCHEMA, scopeKey: scope.scopeKey, records: [normalError] };
  const unresolvedMeta = await context.getWorldManagerRuntimeMeta();
  check(unresolvedMeta?.lastReplayError?.code === normalError.code,
    'same-worldline replay error was auto-cleared without an explicit resolution record');

  const explicitlyResolved = {
    ...normalError,
    resolvedAt: '2026-08-31T02:00:01.000Z',
    resolution: {
      status: 'resolved', resolvedAt: '2026-08-31T02:00:01.000Z',
      worldlineId: 'main', replayFingerprint: laterSuccess.fingerprint
    }
  };
  replayErrorsValue = {
    schema: context.STATE_REPLAY_ERROR_SCHEMA, scopeKey: scope.scopeKey,
    records: [explicitlyResolved],
    resolutions: [{ errorId: explicitlyResolved.errorId, ...explicitlyResolved.resolution }]
  };
  const resolvedMeta = await context.getWorldManagerRuntimeMeta();
  check(resolvedMeta?.lastReplayError == null,
    'an explicitly resolved same-worldline replay error remained active');

  check(fullCorrectionJournalReads === 0,
    `runtime-meta core read the full correction journal ${fullCorrectionJournalReads} time(s)`);
  check(smallCorrectionMetaReads >= 1,
    'runtime-meta core did not read the bounded correction metadata/count record');
  check(correctionCommitReads >= 1,
    'runtime-meta core did not read the bounded correction commit marker');
}

async function auditGuiRuntimeBinding() {
  let scopeKey = 'scope-a';
  let snapshotGeneration = 'snapshot-a-1';
  let headGeneration = 'head-a-1';
  let replayFingerprint = 'replay-a-1';
  let throughTurn = 10;
  let runtimeMetaCalls = 0;
  let refreshCalls = 0;
  let renders = 0;
  const statusMessages = [];
  const coreState = { guiSnapshotLimits: {}, worldManagerRuntimeMetaGeneration: 1 };
  const snapshot = () => ({
    scope: { scopeKey }, generation: snapshotGeneration, snapshotGeneration,
    continuityState: {
      generation: headGeneration, revision: headGeneration, worldlineId: 'main', throughTurn,
      updatedAt: `${headGeneration}-updated`,
      basis: { replayFingerprint, sourceFingerprint: `${headGeneration}-source` }
    }
  });
  const makeRuntimeMeta = (overrides = {}) => ({
    scopeKey,
    generation: snapshotGeneration,
    snapshotGeneration,
    headGeneration,
    head: { generation: headGeneration, worldlineId: 'main', throughTurn, replayFingerprint },
    worldline: { activeWorldlineId: 'main', revision: 1, current: { id: 'main' } },
    replayCache: {
      worldlineId: 'main', fingerprint: replayFingerprint, throughTurn,
      appliedDeltas: 2, appliedCorrectionsCount: 0, updatedAt: '2026-08-31T03:00:00.000Z'
    },
    correctionCounts: { active: 0, total: 0 },
    correctionMetaGeneration: 'correction-1',
    lastReplayError: null,
    ...overrides
  });
  let runtimeMetaFactory = () => makeRuntimeMeta();
  let rebuildFactory = async () => ({ ok: true });
  const Gui = {
    worldManagerRuntimeMeta: null,
    worldManagerRuntimeMetaScopeKey: '',
    worldManagerRuntimeMetaGeneration: '',
    worldManagerRuntimeMetaLoading: false,
    worldManagerRuntimeMetaError: '',
    worldManagerRuntimeMetaErrorScopeKey: '',
    worldManagerRuntimeMetaLoadSerial: 0,
    worldManagerRuntimeMetaScheduledScopeKey: '',
    worldManagerRuntimeMetaRebuilding: false,
    settingsHubSection: '',
    generalSettingsSection: ''
  };
  const context = {
    Promise, Number, String, Error,
    Gui,
    text: value => String(value ?? ''),
    LibraMemoryCore: {
      peekSnapshot: snapshot,
      state: coreState,
      refreshSnapshot: async () => { refreshCalls += 1; return snapshot(); }
    },
    worldManagerSnapshotView: () => {
      const value = snapshot();
      return { snapshot: value, head: value.continuityState, throughTurn: Number(value.continuityState?.throughTurn || 0) };
    },
    LIBRA_SNAPSHOT_PAGE_LIMITS: {},
    queueGuiNavigationRender: () => { renders += 1; },
    guiSetStatus: (...args) => { statusMessages.push(args); },
    sharedNavigate: value => { context.navigated = value; },
    __LIBRA__: {
      getWorldManagerRuntimeMeta: async () => { runtimeMetaCalls += 1; return runtimeMetaFactory(); },
      rebuildWorldManagerState: (...args) => rebuildFactory(...args)
    }
  };
  vm.createContext(context);
  vm.runInContext(`${loaderFragment}\nthis.api = { currentWorldManagerScopeKey, worldManagerRuntimeMetaForCurrentScope, loadWorldManagerRuntimeMeta, scheduleWorldManagerRuntimeMetaLoad, replayWorldManagerFromHome, openWorldManagerDiagnostics };`, context);

  const first = await context.api.loadWorldManagerRuntimeMeta({ force: true });
  assert.equal(first.scopeKey, 'scope-a');
  assert.equal(context.api.worldManagerRuntimeMetaForCurrentScope().scopeKey, 'scope-a');

  scopeKey = 'scope-b';
  snapshotGeneration = 'snapshot-b-1';
  headGeneration = 'head-b-1';
  replayFingerprint = 'replay-b-1';
  assert.equal(context.api.worldManagerRuntimeMetaForCurrentScope(), null, 'scope-a metadata leaked into scope-b');
  const second = await context.api.loadWorldManagerRuntimeMeta();
  assert.equal(second.scopeKey, 'scope-b');
  assert.equal(Gui.worldManagerRuntimeMetaScopeKey, 'scope-b');

  runtimeMetaFactory = () => makeRuntimeMeta({ scopeKey: 'wrong-scope' });
  const mismatch = await context.api.loadWorldManagerRuntimeMeta({ force: true });
  assert.equal(mismatch, null);
  assert.match(Gui.worldManagerRuntimeMetaError, /scope/);
  assert.equal(Gui.worldManagerRuntimeMetaErrorScopeKey, 'scope-b');

  scopeKey = 'scope-c';
  snapshotGeneration = 'snapshot-c-1';
  headGeneration = 'head-c-1';
  replayFingerprint = 'replay-c-1';
  runtimeMetaFactory = () => makeRuntimeMeta();
  Gui.worldManagerRuntimeMeta = null;
  Gui.worldManagerRuntimeMetaError = '';
  Gui.worldManagerRuntimeMetaScheduledScopeKey = '';
  const callsBeforeSchedule = runtimeMetaCalls;
  context.api.scheduleWorldManagerRuntimeMetaLoad();
  context.api.scheduleWorldManagerRuntimeMetaLoad();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtimeMetaCalls, callsBeforeSchedule + 1, 'same-scope first-render metadata load was duplicated');
  assert.equal(Gui.worldManagerRuntimeMetaScopeKey, 'scope-c');

  // The same scope can receive a new snapshot/Head after replay, correction, or
  // worldline mutation. Scope-only caching must not keep the old diagnostics.
  snapshotGeneration = 'snapshot-c-2';
  headGeneration = 'head-c-2';
  replayFingerprint = 'replay-c-2';
  throughTurn = 15;
  check(context.api.worldManagerRuntimeMetaForCurrentScope() == null,
    'same-scope snapshot/Head generation mutation did not invalidate cached runtime metadata');
  const callsBeforeGenerationReload = runtimeMetaCalls;
  await context.api.loadWorldManagerRuntimeMeta();
  check(runtimeMetaCalls === callsBeforeGenerationReload + 1,
    'invalidated same-scope runtime metadata was not reloaded');

  coreState.worldManagerRuntimeMetaGeneration += 1;
  check(context.api.worldManagerRuntimeMetaForCurrentScope() == null,
    'runtime-meta generation mutation did not invalidate the GUI cache binding');
  await context.api.loadWorldManagerRuntimeMeta({ force: true });

  await context.api.replayWorldManagerFromHome();
  assert.equal(refreshCalls, 1, 'successful replay action must refresh the snapshot exactly once');
  assert.ok(statusMessages.some(args => /readback/.test(String(args[0]))), 'successful replay lacks readback-confirmed status');

  // A replay is bound to the scope in which the user started it. If the user
  // changes chat while the write is pending, neither success nor failure may be
  // reported into the newly selected scope.
  scopeKey = 'scope-replay-a';
  snapshotGeneration = 'snapshot-replay-a';
  headGeneration = 'head-replay-a';
  replayFingerprint = 'replay-replay-a';
  throughTurn = 20;
  runtimeMetaFactory = () => makeRuntimeMeta();
  await context.api.loadWorldManagerRuntimeMeta({ force: true });
  const pendingSuccess = deferred();
  rebuildFactory = () => pendingSuccess.promise;
  const successStatusStart = statusMessages.length;
  const successRefreshStart = refreshCalls;
  const replaySuccessPromise = context.api.replayWorldManagerFromHome();
  scopeKey = 'scope-replay-b';
  snapshotGeneration = 'snapshot-replay-b';
  headGeneration = 'head-replay-b';
  replayFingerprint = 'replay-replay-b';
  pendingSuccess.resolve({ ok: true });
  await replaySuccessPromise;
  check(statusMessages.length === successStatusStart,
    'scope-switched replay reported A success in scope B');
  check(refreshCalls === successRefreshStart,
    'scope-switched replay refreshed scope B after completing the write for scope A');

  scopeKey = 'scope-error-a';
  snapshotGeneration = 'snapshot-error-a';
  headGeneration = 'head-error-a';
  replayFingerprint = 'replay-error-a';
  runtimeMetaFactory = () => makeRuntimeMeta();
  await context.api.loadWorldManagerRuntimeMeta({ force: true });
  Gui.worldManagerRuntimeMetaError = '';
  Gui.worldManagerRuntimeMetaErrorScopeKey = '';
  const pendingFailure = deferred();
  rebuildFactory = () => pendingFailure.promise;
  const failureStatusStart = statusMessages.length;
  const replayFailurePromise = context.api.replayWorldManagerFromHome();
  scopeKey = 'scope-error-b';
  snapshotGeneration = 'snapshot-error-b';
  headGeneration = 'head-error-b';
  replayFingerprint = 'replay-error-b';
  pendingFailure.reject(Object.assign(new Error('scope A replay failed'), { code: 'STATE_REPLAY_FAILED' }));
  await replayFailurePromise;
  check(statusMessages.length === failureStatusStart,
    'scope-switched replay reported A failure in scope B');
  check(Gui.worldManagerRuntimeMetaErrorScopeKey !== 'scope-error-b',
    'scope-switched replay bound A failure to scope B');

  rebuildFactory = async () => ({ ok: true });
  context.api.openWorldManagerDiagnostics();
  assert.equal(Gui.settingsHubSection, 'general');
  assert.equal(Gui.generalSettingsSection, 'debug');
  assert.equal(context.navigated, 'settings');
  assert.ok(renders >= 4);
}

function auditRetiredHomeStatus() {
  check(!/const buildSharedHomeOverviewPanel =|const buildSharedHeaderStatusPanel =|const buildInsightRail =|const buildActiveDraftSummaryCard =/.test(source),
    'retired Home and status-dashboard builders remain in the canonical GUI source');
}
async function main() {
  await auditRuntimeMetaCore();
  auditRetiredHomeStatus();
  if (auditFailures.length) {
    throw new Error(`Commit 9 runtime/provenance audit failed:\n- ${auditFailures.join('\n- ')}`);
  }
  process.stdout.write(`libra_world_manager_runtime_meta_gui_rc2_test: PASS (${path.basename(sourcePath)})\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
