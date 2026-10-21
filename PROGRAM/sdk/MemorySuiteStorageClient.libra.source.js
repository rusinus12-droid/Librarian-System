/* LIBRARIAN SYSTEM STORAGE SDK v1.8.27
 * Scope-routed durable storage client shared by Flashback, HAYAKU, LIBRA, LIA and RE:TRACE.
 * The server stores opaque values. Each plugin keeps ownership of its own data schema.
 */
const createMemorySuiteStorageBridge = (rawOptions = {}) => {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const namespace = String(options.namespace || '').trim().toLowerCase();
  const pluginId = String(options.pluginId || namespace || 'plugin').trim();
  const pluginVersion = String(options.pluginVersion || '').trim();
  const defaultUrl = String(options.defaultUrl || 'http://127.0.0.1:47630').replace(/\/+$/, '');
  const pluginPrefixes = Array.isArray(options.pluginPrefixes) ? options.pluginPrefixes.map(String) : [];
  const pluginKeys = new Set(Array.isArray(options.pluginKeys) ? options.pluginKeys.map(String) : []);
  const localPrefixes = Array.isArray(options.localPrefixes) ? options.localPrefixes.map(String) : [];
  const localKeys = new Set(Array.isArray(options.localKeys) ? options.localKeys.map(String) : []);
  const excludedKeys = new Set(Array.isArray(options.excludedKeys) ? options.excludedKeys.map(value => String(value).toLowerCase()) : []);
  const excludedPrefixes = Array.isArray(options.excludedPrefixes) ? options.excludedPrefixes.map(value => String(value).toLowerCase()) : [];
  const excludedContains = Array.isArray(options.excludedContains) ? options.excludedContains.map(value => String(value).toLowerCase()).filter(Boolean) : [];
  const modeArguments = [...new Set(['memory_suite_server_mode', ...(Array.isArray(options.modeArguments) ? options.modeArguments : [])].map(String))];
  const urlArguments = [...new Set(['memory_suite_server_url', ...(Array.isArray(options.urlArguments) ? options.urlArguments : [])].map(String))];
  const requiredCapabilities = ['kv.v1', 'keys.v1', 'revision.v1', 'digest.v1', 'idempotency.v1', 'tombstone.v1', 'readback.v1', 'namespace-integrity.v1'];
  const MODE_PLUGIN_ONLY = 'plugin_only';
  const MODE_MIRROR = 'mirror';
  const MODE_SERVER_ONLY = 'server_only';
  // mirror remains readable for old registries, but is only a transfer phase.
  const OPERATIONAL_MODES = Object.freeze([MODE_PLUGIN_ONLY, MODE_SERVER_ONLY]);
  const VALID_MODES = new Set([...OPERATIONAL_MODES, MODE_MIRROR]);
  const STORAGE_MODE_CONTRACT = Object.freeze({
    schema:'memory-suite.storage-mode-contract.v2', operationalModes:OPERATIONAL_MODES,
    transitionPhase:MODE_MIRROR, legacyMirrorReadable:true, mirrorSelectable:false
  });
  let storageTransition = null;
  let modeConfigurationBusy = false;
  let modeConfigurationFrozen = false;
  let wholeDataInventoryEpoch = 0;
  // Optional owner health gate. Admission is synchronous, before a factory can
  // read or mutate storage. Release follows the actual physical promise, never
  // a job's displayed terminal/cancelled status. Nested owner I/O is allowed.
  const withOwnerOperation = async (meta, factory) => {
    const release = typeof options.enterOwnerOperation === 'function'
      ? options.enterOwnerOperation({namespace,pluginId,...meta}) : null;
    if (release !== null && typeof release !== 'function') throw Object.assign(
      new Error('MEMORY_SUITE_OWNER_ADMISSION_INVALID'),{code:'MEMORY_SUITE_OWNER_ADMISSION_INVALID'});
    try { return await factory(); } finally { if (release) release(); }
  };
  const withModeConfiguration = factory => withOwnerOperation({kind:'mode_configuration'}, async () => {
    if (modeConfigurationBusy || storageTransition) throw transitionBusyError();
    wholeDataInventoryEpoch++;
    modeConfigurationBusy = true;
    try { return await factory(); } finally { modeConfigurationFrozen = false; modeConfigurationBusy = false; }
  });
  const ownerIOWork = new Set();
  const transitionBusyError = () => Object.assign(new Error('memory_suite_storage_transition_in_progress'), {
    code:'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS', transition:storageTransition ? {...storageTransition} : null,
    userMessage:'저장 위치를 전환하고 있습니다. 완료 후 다시 시도해 주세요.'
  });
  // A single reserved scope entry carries the user's GLOBAL storage-mode choice. It lives in the same
  // scope-routing registry as every per-chat entry, so it survives reloads, syncs and merges with no
  // schema change, and it is never swept by per-scope deletion (see the scope sweep, which only
  // touches rows whose descriptor is not global).
  //
  // Inheritance rule: a scope with NO explicit user entry follows the global mode; a scope the user
  // set explicitly keeps its own value even if the global mode later changes. When the global entry
  // is absent the behaviour is exactly what it was before this entry existed — every scope decides
  // for itself and defaults to plugin_only — so an untouched install sees no change at all.
  const GLOBAL_SCOPE_ID = '__memory_suite_global__';
  const isGlobalScopeId = value => String(value || '').trim() === GLOBAL_SCOPE_ID;
  // A cleared global entry keeps a removal stamp rather than disappearing, because the registry write
  // merges with the on-disk copy and a merge cannot observe an absence (see clearGlobalMode). Every
  // reader must therefore treat a stamped row as if it were not there.
  const isRemovedScopeRow = row => row?.removed === true;
  const liveGlobalRow = registry => {
    const row = registry?.entries?.[GLOBAL_SCOPE_ID];
    return isRemovedScopeRow(row) ? null : (row || null);
  };
  const globalScopeDescriptor = () => normalizeScopeDescriptor({
    scopeId: GLOBAL_SCOPE_ID,
    scopeKey: GLOBAL_SCOPE_ID,
    label: `${displayName} 전역`,
    global: true,
    available: true
  });
  const displayName = String(options.displayName || pluginId || namespace || 'Plugin').trim();
  const managementButtonEnabled = options.managementButton !== false;
  const requestTimeoutMs = Math.max(5000, Math.min(120000, Number(options.requestTimeoutMs || 30000) || 30000));
  const keyPageSize = Math.max(50, Math.min(1000, Number(options.keyPageSize || 400) || 400));
  const getManyResponseBudgetBytes = Math.max(256 * 1024, Math.min(8 * 1024 * 1024, Number(options.getManyResponseBudgetBytes || 4 * 1024 * 1024) || 4 * 1024 * 1024));
  const interactiveSetValueBudgetBytes = Math.max(256 * 1024, Math.min(4 * 1024 * 1024, Number(options.interactiveSetValueBudgetBytes || 4 * 1024 * 1024) || 4 * 1024 * 1024));
  const maxStoragePaginationPages = Math.max(10, Math.min(100000, Number(options.maxStoragePaginationPages || 10000) || 10000));
  // Bootstrap is only a reachability/contract probe.  Keeping its deadline
  // separate prevents an offline loopback endpoint (or an HTML error page from
  // a browser interceptor) from blocking each plugin's local pluginStorage
  // startup for the full data-request timeout.
  const bootstrapRequestTimeoutMs = Math.max(750, Math.min(5000, Number(options.bootstrapRequestTimeoutMs || 1800) || 1800));
  const bootstrapFailureCacheMs = Math.max(1000, Math.min(60000, Number(options.bootstrapFailureCacheMs || 10000) || 10000));
  const configCacheMs = 30000;
  const bootstrapCacheMs = 30000;
  const sharedBootstrapFailures = (() => {
    const existing = createMemorySuiteStorageBridge.__memorySuiteBootstrapFailures;
    if (existing instanceof Map) return existing;
    const created = new Map();
    try {
      Object.defineProperty(createMemorySuiteStorageBridge, '__memorySuiteBootstrapFailures', {
        value: created, configurable: false, enumerable: false, writable: false
      });
    } catch (_) {}
    return created;
  })();
  const proxyCache = new WeakMap();
  const localProxyCache = new WeakMap();
  const migrationStateByLegacy = new WeakMap();
  const mutationTails = new Map();
  const nativeBranchScopeCapabilities = new WeakMap();
  const NATIVE_BRANCH_CAPABILITY_DEFAULT_LIFETIME_MS = 15 * 60 * 1000;
  const nativeBranchCapabilityError = (code, message = code) => { const error = new Error(message); error.code = code; return error; };
  const nativeBranchCapabilityRevalidate = async (capability, meta) => {
    if (Date.now() > Number(meta.expiresAt || 0)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_EXPIRED', 'native branch capability expired');
    if (typeof meta.verifier !== 'function') { if (meta.state === 'issued') meta.state = 'active'; return; }
    let proof = null;
    try { proof = await meta.verifier({ capability, meta: { ...meta, verifier: undefined } }); }
    catch (error) { throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_SOURCE_UNAVAILABLE', error?.message || 'native branch source proof unavailable'); }
    if (!proof || proof.parentAvailable === false) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_SOURCE_UNAVAILABLE', 'native branch parent is no longer available');
    if (meta.sourceRevision && String(proof.sourceRevision || '') !== String(meta.sourceRevision)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_SOURCE_REVISION_CHANGED', 'native branch source revision changed after issue');
    if (meta.targetRevisionAtIssue && proof.targetRevision && String(proof.targetRevision) !== String(meta.targetRevisionAtIssue)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_TARGET_IDENTITY_CHANGED', 'native branch target identity changed after issue');
    if (String(proof.targetChatId || '') !== String(meta.targetChatId || '')) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_TARGET_IDENTITY_CHANGED', 'native branch target chat changed after issue');
    if (meta.lineageDigest && String(proof.lineageDigest || '') !== String(meta.lineageDigest)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_LINEAGE_DIGEST_CHANGED', 'native branch lineage digest changed after issue');
    meta.revalidatedAt = Date.now();
    if (meta.state === 'issued') meta.state = 'active';
  };
  const revalidateNativeBranchScopeCapability = async capability => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!meta) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_REQUIRED');
    await nativeBranchCapabilityRevalidate(capability, meta);
    return { ok:true, state:meta.state, revalidatedAt:meta.revalidatedAt };
  };
  const nativeBranchAccessGuard = async (capability, scope, access) => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!meta) return;
    if (Date.now() > Number(meta.expiresAt || 0)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_EXPIRED', 'native branch capability expired');
    const isSource = scope.scopeId === capability.sourceScopeId;
    const phase = access === 'read' ? (isSource ? 'source_read' : 'target_read') : 'target_write';
    meta.useCount = Number(meta.useCount || 0) + 1;
    const alreadyChecked = phase === 'source_read' ? meta.sourceReadRevalidatedAt : meta.targetWriteRevalidatedAt;
    const proofRequired = Number(meta.useCount) === 1 || !alreadyChecked;
    if (typeof meta.verifier === 'function' && proofRequired) {
      await nativeBranchCapabilityRevalidate(capability, meta);
      if (phase === 'source_read') meta.sourceReadRevalidatedAt = meta.revalidatedAt; else meta.targetWriteRevalidatedAt = meta.revalidatedAt;
    } else if (meta.state === 'issued') { meta.state = 'active'; }
  };
  const lifecycle = {
    disposed: false,
    timers: new Set(),
    abortControllers: new Set()
  };
  const scheduleLifecycleTimeout = (callback, delayMs) => {
    if (lifecycle.disposed) return null;
    let timer = null;
    timer = setTimeout(() => {
      lifecycle.timers.delete(timer);
      if (lifecycle.disposed) return;
      callback();
    }, Math.max(0, Number(delayMs || 0) || 0));
    lifecycle.timers.add(timer);
    try { timer?.unref?.(); } catch (_) {}
    return timer;
  };
  const clearLifecycleTimeout = timer => {
    if (!timer) return;
    clearTimeout(timer);
    lifecycle.timers.delete(timer);
  };
  const autoMigratePlugin = options.autoMigratePlugin !== false;
  const autoMigrateLocal = options.autoMigrateLocal !== false;
  const migrationConcurrency = Math.max(1, Math.min(4, Number(options.migrationConcurrency || 2) || 2));
  const migrationRetryMs = Math.max(5000, Math.min(10 * 60 * 1000, Number(options.migrationRetryMs || 30000) || 30000));
  const currentScopeProvider = typeof options.currentScopeProvider === 'function' ? options.currentScopeProvider : null;
  const resolveKeyScopeProvider = typeof options.resolveKeyScope === 'function' ? options.resolveKeyScope : null;
  // Payload-bound owner keys must not fall back to the open scope on I/O failure.
  const strictPluginScopePrefixes = (Array.isArray(options.strictPluginScopePrefixes) ? options.strictPluginScopePrefixes : []).map(String).filter(Boolean);
  // Opt-in only: the plugin's resolver must be able to classify global/shared
  // keys and explicit scope-key records correctly when currentScope is null.
  const preResolveKeyScope = options.preResolveKeyScope === true;
  const scopeRoutingEnabled = options.scopeRouting !== false;
  const startupDiagnosticsEnabled = options.startupDiagnostics !== false;
  const scopeCacheMs = Math.max(0, Math.min(10000, Number(options.scopeCacheMs || 0) || 0));
  const sharedRouteModeRaw = String(options.sharedRouteMode || MODE_MIRROR);
  // Optional owner semantic validation runs only after the SDK has restored and
  // read back every generic key.  It lets each plugin reject a structurally
  // complete but semantically unusable snapshot without weakening the common
  // key/digest coverage checks.
  const validateRestore = typeof options.validateRestore === 'function' ? options.validateRestore : null;
  const resolveRestoreDependencies = typeof options.resolveRestoreDependencies === 'function' ? options.resolveRestoreDependencies : null;
  const requireRestoreValidation = options.requireRestoreValidation === true;
  const allowEmptyRestore = options.allowEmptyRestore === true;
  const namespaceDelaySeed = Array.from(namespace).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const migrationDelayMs = Math.max(250, Math.min(10000, Number(options.migrationDelayMs || (700 + (namespaceDelaySeed % 7) * 240)) || 700));
  const state = {
    config: { at: 0, mode: MODE_PLUGIN_ONLY, url: defaultUrl },
    bootstrap: { at: 0, baseUrl: '', value: null, pending: null },
    status: { state: 'idle', at: 0, reason: '', serverVersion: '', url: defaultUrl, namespace },
    migration: {
      plugin: { state: 'idle', scanned: 0, migrated: 0, skipped: 0, failed: 0, at: 0, reason: '' },
      local: { state: 'idle', scanned: 0, migrated: 0, skipped: 0, failed: 0, at: 0, reason: '' }
    },
    warned: new Set(),
    legacy: { plugin: null, local: null },
    management: { registered: false, registering: false, handle: null, timer: null, root: null, lastResult: null },
    syncJob: { current: null, promise: null, retryTimer: null, persistTimer: null, loaded: false, listeners: new Set() },
    transientMode: '',
    diagnostics: { value: null, at: 0, pending: null, timer: null },
    scopeRouting: {
      current: null,
      currentAt: 0,
      registry: null,
      registryLoaded: false,
      registryLoading: null,
      transientModes: new Map(),
      routeCache: new Map(),
      lastLegacyImport: null
    }
  };
  const SYNC_JOB_SCHEMA = 'memory-suite.sync-job.v1';
  const SYNC_JOB_STORAGE_KEY = `__memory_suite_internal_sync_job_v1__:${namespace}`;
  const SYNC_JOB_RETRY_DELAYS_MS = Object.freeze([3000, 5000, 10000, 20000, 30000]);
  const SYNC_JOB_MAX_RETRIES = 8;
  const SYNC_JOB_RESUME_TTL_MS = 2 * 60 * 60 * 1000;
  const SCOPE_ROUTING_SCHEMA = 'memory-suite.scope-routing.v1';
  const SCOPE_ROUTING_LOCAL_KEY = `__memory_suite_internal_scope_routes_v1__:${namespace}`;
  const SCOPE_ROUTING_SERVER_KEY = `__memory_suite_scope_routes_v1__:${namespace}`;
  const SCOPED_REMOTE_KEY_MARKER = '::memory-suite-scope:v1:';
  // A successful local -> server migration retains local bytes as a recovery
  // artifact, never as a second authority. This registry records the explicit
  // retirement decision so that a later server_only read cannot resurrect a
  // stale local candidate. It is a durable, non-destructive marker.
  const RETIRED_SCHEMA = 'memory-suite.retired-local-owner-data.v1';
  const RETIRED_LOCAL_KEY = `__memory_suite_internal_retired_local_v1__:${namespace}`;

  const safeText = value => String(value == null ? '' : value);
  const compact = (value, max = 500) => safeText(value).replace(/\s+/g, ' ').trim().slice(0, max);
  const jsonComparable = value => {
    try { return JSON.stringify(value); }
    catch (_) { return '__MEMORY_SUITE_UNSERIALIZABLE__'; }
  };
  const setStatus = (next, reason = '', extra = {}) => {
    state.status = { ...state.status, state: String(next || 'unknown'), reason: compact(reason), at: Date.now(), ...extra };
  };
  const warnOnce = (code, error) => {
    const key = String(code || 'warning');
    if (state.warned.has(key)) return;
    if (state.warned.size >= 256) {
      const oldest = state.warned.values().next().value;
      if (oldest !== undefined) state.warned.delete(oldest);
    }
    state.warned.add(key);
    try { console.warn(`[Librarian System/${pluginId}] ${key}:`, error?.message || error || 'unknown'); } catch (_) {}
  };

  const storageValueBytes = value => {
    let serialized = '';
    try { serialized = JSON.stringify(value); } catch (_) { serialized = safeText(value); }
    if (serialized == null) serialized = '';
    try { if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(serialized)).byteLength; } catch (_) {}
    return String(serialized).length * 2;
  };


  const createScopedSyncMetrics = () => ({
    localReadCount: 0, localReadBytes: 0, localWriteCount: 0, localWriteBytes: 0,
    localRemoveCount: 0, remoteReadCount: 0, remoteReadBytes: 0,
    remoteListCount: 0, remoteListBytes: 0, remoteWriteCount: 0, remoteWriteBytes: 0,
    byOperation: {}
  });
  const cloneScopedSyncMetrics = metrics => {
    const value = metrics && typeof metrics === 'object' ? metrics : createScopedSyncMetrics();
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return createScopedSyncMetrics(); }
  };
  const recordScopedSyncMetric = (metrics, operation, values = {}) => {
    if (!metrics || typeof metrics !== 'object') return;
    const op = String(operation || 'unknown');
    const row = metrics.byOperation[op] || { count: 0, localBytes: 0, remoteBytes: 0 };
    row.count += Math.max(1, Number(values.count || 1) || 1);
    row.localBytes += Math.max(0, Number(values.localBytes || 0) || 0);
    row.remoteBytes += Math.max(0, Number(values.remoteBytes || 0) || 0);
    metrics.byOperation[op] = row;
    for (const field of ['localReadCount','localReadBytes','localWriteCount','localWriteBytes','localRemoveCount','remoteReadCount','remoteReadBytes','remoteListCount','remoteListBytes','remoteWriteCount','remoteWriteBytes']) {
      if (Object.prototype.hasOwnProperty.call(values, field)) metrics[field] += Math.max(0, Number(values[field] || 0) || 0);
    }
  };
  const mergeScopedSyncMetrics = (target, source) => {
    if (!target || !source || typeof source !== 'object') return target;
    for (const field of ['localReadCount','localReadBytes','localWriteCount','localWriteBytes','localRemoveCount','remoteReadCount','remoteReadBytes','remoteListCount','remoteListBytes','remoteWriteCount','remoteWriteBytes']) {
      target[field] = Math.max(0, Number(target[field] || 0) || 0) + Math.max(0, Number(source[field] || 0) || 0);
    }
    for (const [operation, row] of Object.entries(source.byOperation || {})) {
      const current = target.byOperation[operation] || { count: 0, localBytes: 0, remoteBytes: 0 };
      current.count += Math.max(0, Number(row?.count || 0) || 0);
      current.localBytes += Math.max(0, Number(row?.localBytes || 0) || 0);
      current.remoteBytes += Math.max(0, Number(row?.remoteBytes || 0) || 0);
      target.byOperation[operation] = current;
    }
    return target;
  };
  const scopedSyncRemoteValueBytes = remote => remote?.exists === true
    ? Math.max(0, Number(remote?.valueBytes || 0) || storageValueBytes(remote?.value)) : 0;
  const scopedSyncFailure = ({ key = '', stage = 'unknown', operation = 'unknown', error, localBytes = 0, remoteBytes = 0 } = {}) => {
    const message = compact(error?.message || error || 'memory_suite_scope_sync_failed', 700);
    const errorCode = String(error?.code || 'MEMORY_SUITE_SCOPE_SYNC_FAILED');
    const retryable = typeof error?.retryable === 'boolean' ? error.retryable : retryableSyncError(error);
    return {
      key: String(key || ''), stage: String(stage || 'unknown'), errorCode, message,
      operation: String(operation || 'unknown'),
      localBytes: Math.max(0, Number(localBytes || 0) || 0),
      remoteBytes: Math.max(0, Number(remoteBytes || 0) || 0), retryable,
      error: message
    };
  };

  // MEMORY_SUITE_SCOPE_SYNC_DIAGNOSTICS_V1

  // Batch-read values may legally use keys such as "__proto__".  Assigning
  // those keys with Object.assign or bracket notation can invoke inherited
  // setters and mutate the accumulator prototype.  Define own data properties
  // explicitly so opaque owner keys remain data, never object structure.
  const defineStorageRecordValue = (target, key, value) => {
    Object.defineProperty(target, String(key), {
      value, enumerable: true, configurable: true, writable: true
    });
    return target;
  };
  const mergeStorageRecordValues = (target, source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
    for (const [key, value] of Object.entries(source)) defineStorageRecordValue(target, key, value);
    return target;
  };

  const syncJobTerminal = status => ['completed', 'failed', 'cancelled'].includes(String(status || ''));
  const cloneSyncJob = value => {
    if (!value || typeof value !== 'object') return null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return { ...value }; }
  };
  const notifySyncJob = () => {
    const snapshot = cloneSyncJob(state.syncJob.current);
    for (const listener of Array.from(state.syncJob.listeners)) {
      try { listener(snapshot); } catch (_) {}
    }
  };
  const persistSyncJobNow = (...args) => withOwnerOperation({kind:'storage_operation',operation:'persistSyncJobNow'}, () => persistSyncJobNowImpl(...args));
  const persistSyncJobNowImpl = async () => {
    if (state.syncJob.persistTimer) { clearLifecycleTimeout(state.syncJob.persistTimer); state.syncJob.persistTimer = null; }
    const legacy = state.legacy.plugin;
    const job = state.syncJob.current;
    if (!legacy || typeof legacy.setItem !== 'function' || !job) return false;
    try {
      const payload = JSON.stringify({ ...cloneSyncJob(job), persistedAt: Date.now() });
      const result = await legacy.setItem(SYNC_JOB_STORAGE_KEY, payload);
      if (result === false || typeof legacy.getItem !== 'function') return false;
      const actual = await legacy.getItem(SYNC_JOB_STORAGE_KEY);
      return (typeof actual === 'string' ? actual : JSON.stringify(actual)) === payload;
    } catch (_) { return false; }
  };
  const scheduleSyncJobPersist = (immediate = false) => {
    if (immediate) { void persistSyncJobNow().catch(error => reportStorageFailure('sync.job.persist.admission', error)); return; }
    if (state.syncJob.persistTimer) return;
    state.syncJob.persistTimer = scheduleLifecycleTimeout(() => {
      state.syncJob.persistTimer = null;
      void persistSyncJobNow().catch(error => reportStorageFailure('sync.job.persist.admission', error));
    }, 650);
    try { state.syncJob.persistTimer?.unref?.(); } catch (_) {}
  };
  const updateSyncJob = (patch = {}, options = {}) => {
    if (!state.syncJob.current) return null;
    const now = Date.now();
    state.syncJob.current = {
      ...state.syncJob.current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      updatedAt: now,
      lastActivityAt: options.activity === false ? Number(state.syncJob.current.lastActivityAt || now) : now
    };
    scheduleSyncJobPersist(options.persist === 'immediate');
    notifySyncJob();
    return cloneSyncJob(state.syncJob.current);
  };
  const aggregateSyncJobSpaces = (spaces, completedPasses = {}) => {
    const values = [
      ...Object.values(spaces && typeof spaces === 'object' ? spaces : {}),
      ...Object.values(completedPasses && typeof completedPasses === 'object' ? completedPasses : {})
    ];
    const sum = key => values.reduce((total, row) => total + Math.max(0, Number(row?.[key] || 0) || 0), 0);
    return {
      totalItems: sum('totalItems'), processedItems: sum('processedItems'), processedBytes: sum('processedBytes'),
      transferredBytes: sum('transferredBytes'), uploaded: sum('uploaded'), restored: sum('restored'), matched: sum('matched'),
      removedByTombstone: sum('removedByTombstone'), failures: sum('failureCount'), conflicts: sum('conflictCount')
    };
  };
  const applySyncProgressToJob = progress => {
    const job = state.syncJob.current;
    if (!job || !progress || typeof progress !== 'object') return;
    const space = String(progress.space || job.currentSpace || 'plugin');
    const spaces = { ...(job.spaces || {}) };
    const completedPasses = { ...(job.completedPasses || {}) };
    const previous = spaces[space] || null;
    if (previous && Number(previous.startedAt || 0) > 0 && Number(progress.startedAt || 0) > 0
      && Number(previous.startedAt) !== Number(progress.startedAt)) {
      const prior = completedPasses[space] || {};
      completedPasses[space] = {
        totalItems: Number(prior.totalItems || 0) + Number(previous.totalItems || 0),
        processedItems: Number(prior.processedItems || 0) + Number(previous.processedItems || 0),
        processedBytes: Number(prior.processedBytes || 0) + Number(previous.processedBytes || 0),
        transferredBytes: Number(prior.transferredBytes || 0) + Number(previous.transferredBytes || 0),
        uploaded: Number(prior.uploaded || 0) + Number(previous.uploaded || 0),
        restored: Number(prior.restored || 0) + Number(previous.restored || 0),
        matched: Number(prior.matched || 0) + Number(previous.matched || 0),
        removedByTombstone: Number(prior.removedByTombstone || 0) + Number(previous.removedByTombstone || 0),
        failureCount: Number(prior.failureCount || 0) + Number(previous.failureCount || 0),
        conflictCount: Number(prior.conflictCount || 0) + Number(previous.conflictCount || 0),
        passCount: Number(prior.passCount || 0) + 1
      };
      spaces[space] = {};
    }
    spaces[space] = { ...(spaces[space] || {}), ...progress, space };
    const totals = aggregateSyncJobSpaces(spaces, completedPasses);
    updateSyncJob({
      spaces,
      completedPasses,
      ...totals,
      phase: String(progress.phase || job.phase || 'running'),
      currentSpace: space,
      currentKey: compact(progress.currentKey || '', 220),
      currentAction: String(progress.currentAction || progress.action || ''),
      status: job.status === 'paused' ? 'running' : job.status,
      message: String(progress.message || job.message || '')
    });
  };
  const subscribeSyncJob = listener => {
    if (typeof listener !== 'function') return () => {};
    state.syncJob.listeners.add(listener);
    try { listener(cloneSyncJob(state.syncJob.current)); } catch (_) {}
    return () => state.syncJob.listeners.delete(listener);
  };
  const getSyncJob = () => cloneSyncJob(state.syncJob.current);
  const loadPersistedSyncJob = async () => {
    if (state.syncJob.loadPending) return await state.syncJob.loadPending;
    if (state.syncJob.loaded) return getSyncJob();
    const legacy = state.legacy.plugin;
    if (!legacy || typeof legacy.getItem !== 'function') return null;
    const pending = (async () => {
      try {
        const raw = await legacy.getItem(SYNC_JOB_STORAGE_KEY);
        if (!raw) {
          const current=state.syncJob.current;
          if(current?.kind==='global_mode'&&!syncJobTerminal(current.status)){
            if(current.effectsStarted===false&&current.phase==='prepared'&&!current.globalPlan?.supersedesJobId)state.syncJob.current=null;
            else throw new Error('aggregate_journal_missing_after_effects');
          }
          state.syncJob.loaded = true; return null;
        }
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || parsed.schema !== SYNC_JOB_SCHEMA || parsed.namespace !== namespace) throw new Error('journal_contract_unavailable');
        const age = Date.now() - Math.max(0, Number(parsed.updatedAt || parsed.startedAt || 0) || 0);
        if (age > SYNC_JOB_RESUME_TTL_MS && syncJobTerminal(parsed.status)) { state.syncJob.loaded = true; return null; }
        if (!syncJobTerminal(parsed.status)) {
          if (age > SYNC_JOB_RESUME_TTL_MS) parsed.resumeExpired = true;
          parsed.status = 'paused';
          parsed.phase = 'resume_pending';
          parsed.message = '이전 동기화 작업을 다시 연결하고 있습니다.';
          parsed.nextRetryAt = 0;
        }
        state.syncJob.current = parsed;
        state.syncJob.loaded = true;
        notifySyncJob();
        return getSyncJob();
      } catch (_) {
        state.syncJob.loaded = false;
        throw Object.assign(new Error('MEMORY_SUITE_JOB_JOURNAL_UNAVAILABLE'), {code:'MEMORY_SUITE_JOB_JOURNAL_UNAVAILABLE',journalAdmissionFailure:true});
      }
    })();
    state.syncJob.loadPending = pending;
    try { return await pending; }
    finally { if (state.syncJob.loadPending === pending) state.syncJob.loadPending = null; }
  };
  const clearPersistedSyncJob = (...args) => withOwnerOperation({kind:'storage_operation',operation:'clearPersistedSyncJob'}, () => clearPersistedSyncJobImpl(...args));
  const clearPersistedSyncJobImpl = async () => {
    const legacy = state.legacy.plugin;
    if (!legacy) return false;
    try {
      if (typeof legacy.removeItem === 'function') return (await legacy.removeItem(SYNC_JOB_STORAGE_KEY)) !== false;
      if (typeof legacy.setItem === 'function') return (await legacy.setItem(SYNC_JOB_STORAGE_KEY, null)) !== false;
    } catch (_) {}
    return false;
  };
  const retryableSyncError = error => {
    if (error?.status === 409 && error?.payload?.error === 'MEMORY_SUITE_RESET_RECONNECT_REQUIRED') return false;
    const message = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '').toUpperCase();
    if (code === 'MEMORY_SUITE_CONNECTION_STALE') return false;
    return ['TIMEOUT', 'NETWORK_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'MEMORY_SUITE_SERVER_UNAVAILABLE'].includes(code)
      || /fetch|network|timeout|timed out|econn|connection|server_unavailable|bootstrap|http_50[0234]|503|socket|temporar/.test(message);
  };

  const normalizeServerAvailabilityError = error => {
    const rawMessage = compact(error?.message || error || 'memory_suite_server_unavailable', 700);
    const rawCode = String(error?.code || '').toUpperCase();
    const nativeJsonEnvelopeFailure = /expected double-quoted property name in json|unexpected token.*json|json(?:\.parse)?[^\n]*position\s+\d+/i.test(rawMessage);
    const unavailable = nativeJsonEnvelopeFailure || retryableSyncError(error)
      || ['MEMORY_SUITE_TIMEOUT', 'MEMORY_SUITE_SERVER_UNAVAILABLE', 'MEMORY_SUITE_SERVER_INVALID_JSON'].includes(rawCode);
    if (!unavailable) return error instanceof Error ? error : new Error(rawMessage);
    const normalized = new Error('memory_suite_server_unavailable');
    normalized.code = 'MEMORY_SUITE_SERVER_UNAVAILABLE';
    normalized.retryable = true;
    return normalized;
  };

  const cachedBootstrapFailure = url => {
    const cached = sharedBootstrapFailures.get(String(url || ''));
    if (!cached) return null;
    if (Date.now() - Number(cached.at || 0) >= bootstrapFailureCacheMs) {
      sharedBootstrapFailures.delete(String(url || ''));
      return null;
    }
    const error = new Error(cached.message || 'memory_suite_server_unavailable');
    error.code = cached.code || 'MEMORY_SUITE_SERVER_UNAVAILABLE';
    error.retryable = true;
    error.cached = true;
    return error;
  };

  const apiCandidates = () => {
    const out = [];
    const add = value => {
      if (value && (typeof value === 'object' || typeof value === 'function') && !out.includes(value)) out.push(value);
    };
    try { if (typeof risuai !== 'undefined') add(risuai); } catch (_) {}
    try { if (typeof risuApi !== 'undefined') add(risuApi); } catch (_) {}
    try { if (typeof risuAPI !== 'undefined') add(risuAPI); } catch (_) {}
    try { if (typeof Risuai !== 'undefined') add(Risuai); } catch (_) {}
    try { if (typeof RisuAI !== 'undefined') add(RisuAI); } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        add(globalThis.risuai);
        add(globalThis.risuApi);
        add(globalThis.risuAPI);
        add(globalThis.Risuai);
        add(globalThis.RisuAI);
        add(globalThis.__pluginApis__);
      }
    } catch (_) {}
    return out;
  };

  const getArgumentValue = async (names, fallback = '') => {
    for (const name of names) {
      for (const api of apiCandidates()) {
        try {
          let value;
          if (typeof api?.getArgument === 'function') value = await api.getArgument(name);
          else if (typeof api?.getArg === 'function') value = await api.getArg(name);
          if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
        } catch (_) {}
      }
    }
    return fallback;
  };

  const setArgumentValue = async (name, value) => {
    let lastError = null;
    for (const api of apiCandidates()) {
      try {
        const fn = typeof api?.setArgument === 'function' ? api.setArgument : (typeof api?.setArg === 'function' ? api.setArg : null);
        if (!fn) continue;
        const result = await fn.call(api, name, value);
        if (result === false) throw new Error('argument_write_rejected');
        return true;
      } catch (error) { lastError = error; }
    }
    const error = new Error(`memory_suite_argument_persistence_unavailable:${compact(lastError?.message || lastError || 'setArgument unavailable', 180)}`);
    error.code = 'MEMORY_SUITE_ARGUMENT_PERSISTENCE_UNAVAILABLE';
    throw error;
  };

  const normalizeMode = raw => {
    const value = String(raw || '').trim().toLowerCase().replace(/[ -]+/g, '_');
    if (['off', 'plugin', 'plugin_only', 'standalone', 'local', 'local_only'].includes(value)) return MODE_PLUGIN_ONLY;
    if (['mirror', 'dual', 'coexist', 'coexistence', 'plugin_server', 'plugin+server', 'plugin_and_server'].includes(value)) return MODE_MIRROR;
    if (['required', 'server', 'server_only', 'remote', 'remote_only'].includes(value)) return MODE_SERVER_ONLY;
    return MODE_PLUGIN_ONLY;
  };

  const modeLabel = mode => mode === MODE_MIRROR
    ? '미러 · 전환 미완료'
    : (mode === MODE_SERVER_ONLY ? '서버 단독' : '플러그인 단독');

  const requireOperationalMode = raw => {
    const mode = normalizeMode(raw);
    if (!OPERATIONAL_MODES.includes(mode)) throw Object.assign(new Error('memory_suite_mirror_is_transition_only'), {
      code:'MEMORY_SUITE_MIRROR_TRANSITION_ONLY', requestedMode:mode,
      userMessage:'미러는 저장 위치 전환 중에만 사용합니다. 플러그인 단독 또는 서버 단독을 선택해 주세요.'
    });
    return mode;
  };
  const modeLifecycle = mode => ({
    modeRole:mode === MODE_MIRROR ? 'transition' : 'operational',
    migrationRequired:mode === MODE_MIRROR, operationalModes:[...OPERATIONAL_MODES]
  });

  let resetChoice = null;
  let resetReloadRequired = false;
  // The URL/epoch-only legacy key is deliberately preserved, never upgraded.
  const resetChoiceKey = 'memory_suite_reset_choice.v2.' + namespace;
  const resetPreferenceCommits = (() => {
    const existing = createMemorySuiteStorageBridge.__memorySuiteResetPreferenceCommits;
    if (existing instanceof Map) return existing;
    const created = new Map();
    Object.defineProperty(createMemorySuiteStorageBridge, '__memorySuiteResetPreferenceCommits', {
      value:created, configurable:false, enumerable:false, writable:false
    });
    return created;
  })();
  const withResetPreferenceCommit = work => {
    const previous = resetPreferenceCommits.get(namespace) || Promise.resolve();
    const operation = previous.then(work);
    const tail = operation.then(() => {}, () => {});
    resetPreferenceCommits.set(namespace, tail);
    tail.then(() => { if (resetPreferenceCommits.get(namespace) === tail) resetPreferenceCommits.delete(namespace); });
    return operation;
  };
  const validResetPreference = value => value && typeof value === 'object' && !Array.isArray(value)
    && value.schema === 'memory-suite.reset-choice.v2' && value.namespace === namespace
    && typeof value.url === 'string' && value.dataIdentityContract === 'memory-suite.physical-data-identity.v1'
    && value.dataIdentityCertified === true && value.resetEpochCertified === true
    && typeof value.dataInstanceId === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value.dataInstanceId)
    && Number.isSafeInteger(value.epoch) && value.epoch > 0 && ['empty','upload','owner_scope_deleted'].includes(value.choice)
    && (value.choice !== 'owner_scope_deleted' || (Array.isArray(value.deletedScopeIds) && value.deletedScopeIds.length > 0 && value.deletedScopeIds.every(id => typeof id === 'string' && id.trim() === id && !!id)));
  const readResetPreferenceCandidate = async () => {
    const store = state.legacy.plugin;
    if (!store?.getItem) return null;
    const raw = await store.getItem(resetChoiceKey);
    let value;
    try { value = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)); } catch (_) { return null; }
    return validResetPreference(value) ? value : null;
  };
  const resetPreferenceMatches = (value, connection) => validResetPreference(value)
    && connection?.dataIdentityCertified === true && connection.resetEpochCertified === true
    && value.url === (connection.requestedUrl || connection.url)
    && value.dataInstanceId === connection.dataInstanceId && value.dataIdentityContract === connection.dataIdentityContract
    && value.epoch === connection.resetEpochs?.[namespace];
  const cacheQualifiedResetChoice = value => {
    if (JSON.stringify(resetChoice) !== JSON.stringify(value)) state.scopeRouting.routeCache.clear();
    resetChoice = value;
    return value;
  };
  // Pure qualification: callers must supply an accepted connection. No bootstrap here.
  const readResetChoice = async (connection = state.bootstrap.value) => {
    if (!connection) return cacheQualifiedResetChoice(null);
    const intent = captureBootstrapIntent(await readConfig(true));
    const value = await readResetPreferenceCandidate();
    while (true) {
      // Only wait for an existing publication; this reader never bootstraps.
      const pending = state.bootstrap.pending;
      if (pending) await pending.catch(() => null);
      await assertBootstrapIntent(intent);
      await assertConnectionCurrent(connection, intent.generation);
      if (state.bootstrap.pending) continue;
      const current = state.bootstrap.value;
      if (dataBinding.rejected || dataBinding.certified !== true
        || dataBinding.dataIdentityContract !== connection.dataIdentityContract
        || !resetPreferenceMatches(value, connection) || !resetPreferenceMatches(value, current)) return cacheQualifiedResetChoice(null);
      return cacheQualifiedResetChoice(value);
    }
  };
  const deletedScopesForResetChoice = value => value?.choice === 'owner_scope_deleted' && Array.isArray(value.deletedScopeIds)
    ? value.deletedScopeIds.map(id => String(id || '')).filter(Boolean) : [];
  const qualifyResetChoiceForScope = async scope => {
    const candidate = await readResetPreferenceCandidate();
    // Upload does not itself enable server mode or initiate a local-only recovery.
    if (!candidate) return cacheQualifiedResetChoice(null);
    if ((candidate.choice !== 'empty' && !deletedScopesForResetChoice(candidate).includes(scope.scopeId))) return state.bootstrap.value ? await readResetChoice(state.bootstrap.value) : cacheQualifiedResetChoice(null);
    const config = await readConfig(true);
    if (candidate.url !== config.url) return cacheQualifiedResetChoice(null);
    const connection = await bootstrap(false, true);
    return await readResetChoice(connection);
  };
  const assertResetPreferenceConnection = async (connection, intent) => {
    // A later refresh may start during native intent/currentness reads. Wait for
    // that accepted publication, then recheck the original intent and epoch.
    // This commit's own bootstrap settled before admission to this queue.
    while (true) {
      const pending = state.bootstrap.pending;
      if (pending) await pending.catch(() => null);
      await assertBootstrapIntent(intent);
      await assertConnectionCurrent(connection, intent.generation);
      if (state.bootstrap.pending) continue;
      const current = state.bootstrap.value;
      if (dataBinding.rejected || dataBinding.certified !== true || dataBinding.dataIdentityContract !== connection.dataIdentityContract
        || !current || current.dataInstanceId !== connection.dataInstanceId || current.dataIdentityContract !== connection.dataIdentityContract
        || current.dataIdentityCertified !== true || current.resetEpochCertified !== true
        || current.resetEpochs?.[namespace] !== connection.resetEpochs?.[namespace]) throw connectionStaleError();
      return;
    }
  };
  const acceptServerReset = (...args) => withOwnerOperation({kind:'storage_operation',operation:'acceptServerReset'}, () => acceptServerResetImpl(...args));
  const acceptServerResetImpl = async (choice, deletedScope = null) => {
    if(!['empty','upload','owner_scope_deleted'].includes(choice))throw new Error('reset_choice_invalid');
    const initialIntent=state.config.at || dataBinding.url ? captureBootstrapIntent(state.config) : null;
    const initialSequence=bootstrapSequence;
    const initialPending=initialIntent && !initialIntent.bound && state.bootstrap.baseUrl===initialIntent.url ? state.bootstrap.pending : null;
    // Preserve proof from the exact earlier publication across the first native read.
    const initialProof=initialPending?.then(value=>initialSequence===bootstrapSequence && state.bootstrap.value===value ? value : null,()=>null);
    const config=await readConfig(true);
    const intent=initialIntent ? {...initialIntent,mode:config.mode} : captureBootstrapIntent(config);
    if(initialProof)pinInitialBootstrapIntent(intent,await initialProof);
    const connection=await bootstrap(true,true,intent);
    const epoch=connection.resetEpochs?.[namespace] || 0;
    if(!epoch)throw new Error('server_has_not_been_reset');
    if(connection.dataIdentityCertified !== true || connection.dataIdentityContract !== 'memory-suite.physical-data-identity.v1'
      || !/^[A-Za-z0-9_-]{32}$/.test(String(connection.dataInstanceId || ''))
      || connection.resetEpochCertified !== true || !Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('reset_preference_authority_uncertified');
    const store=state.legacy.plugin;
    if(!store?.setItem||!store?.getItem)throw new Error('reset_preference_storage_unavailable');
    return await withResetPreferenceCommit(async () => {
      await assertResetPreferenceConnection(connection, intent);
      const previous=await readResetChoice(connection);
      if(choice==='owner_scope_deleted' && previous?.choice==='empty')choice='empty';
      const value={schema:'memory-suite.reset-choice.v2',namespace,url:connection.requestedUrl||connection.url,
        dataInstanceId:connection.dataInstanceId,dataIdentityContract:connection.dataIdentityContract,
        dataIdentityCertified:true,resetEpochCertified:true,epoch,choice};
      if(choice==='owner_scope_deleted'){
        const scopeId=String(deletedScope?.scopeId||'').trim();
        if(!scopeId)throw new Error('owner_scope_delete_scope_id_missing');
        value.deletedScopeIds=[...new Set([...deletedScopesForResetChoice(previous),scopeId])];
      }
      await assertResetPreferenceConnection(connection, intent);
      if(await store.setItem(resetChoiceKey,JSON.stringify(value))===false)throw new Error('reset_preference_write_failed');
      const actual=await readResetChoice(connection);
      await assertResetPreferenceConnection(connection, intent);
      if(JSON.stringify(actual)!==JSON.stringify(value))throw new Error('reset_preference_readback_failed');
      resetReloadRequired=true;
      return {ok:true,reloadRequired:true,choice};
    });
  };
  const normalizeServerUrl = rawValue => {
    const raw = String(rawValue || defaultUrl).trim().replace(/\/+$/, '') || defaultUrl;
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(host)) {
        throw new Error('server_url_must_be_loopback_http');
      }
      return parsed.origin;
    } catch (error) {
      const wrapped = new Error(`invalid_memory_suite_server_url:${compact(error?.message || error, 180)}`);
      wrapped.code = 'MEMORY_SUITE_INVALID_SERVER_URL';
      throw wrapped;
    }
  };

  let bootstrapSequence = 0, connectionProbeSequence = 0;
  const dataBinding = { url:'', dataInstanceId:'', dataIdentityContract:'', certified:false, generation:0, rejected:false };
  const connectionStaleError = () => Object.assign(new Error('MEMORY_SUITE_CONNECTION_STALE'), {code:'MEMORY_SUITE_CONNECTION_STALE'});
  const dataInstanceChangedError = () => {
    dataBinding.rejected = true;
    return Object.assign(new Error('MEMORY_SUITE_DATA_INSTANCE_CHANGED'), {code:'MEMORY_SUITE_DATA_INSTANCE_CHANGED'});
  };
  const bindingHeaders = connection => connection.dataIdentityCertified
    ? {'X-Memory-Suite-Data-Instance':connection.dataInstanceId} : {};
  const adoptDataBinding = (connection, explicit = false) => {
    if (!explicit && dataBinding.url === connection.url && dataBinding.certified
      && (!connection.dataIdentityCertified || dataBinding.dataInstanceId !== connection.dataInstanceId)) throw dataInstanceChangedError();
    if (dataBinding.url !== connection.url || dataBinding.dataInstanceId !== connection.dataInstanceId
      || dataBinding.certified !== connection.dataIdentityCertified) dataBinding.generation++;
    Object.assign(dataBinding, {url:connection.url, dataInstanceId:connection.dataInstanceId,
      dataIdentityContract:connection.dataIdentityContract, certified:connection.dataIdentityCertified, rejected:false});
  };
  const serverBinding = () => Object.freeze({schema:'memory-suite.client-data-binding.v1', ...dataBinding,
    resetEpoch: state.bootstrap.value?.resetEpochs?.[namespace] ?? 0,
    resetEpochCertified: state.bootstrap.value?.resetEpochCertified === true,
    current:!lifecycle.disposed && !dataBinding.rejected && !!dataBinding.url && state.config.url === dataBinding.url});
  const configuredServerUrlNow = async () => normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
  const captureBootstrapIntent = config => ({
    namespace, url:config.url, mode:config.mode, generation:dataBinding.generation,
    bound:dataBinding.url === config.url, dataInstanceId:dataBinding.dataInstanceId,
    certified:dataBinding.certified, contract:dataBinding.dataIdentityContract, rejected:dataBinding.rejected
  });
  const assertBootstrapIntent = async (intent, initialProof = null) => {
    let config = await readConfig(true);
    if (initialProof) {
      pinInitialBootstrapIntent(intent, await initialProof);
      config = await readConfig(true);
    }
    if (lifecycle.disposed || intent.namespace !== namespace || config.url !== intent.url || config.mode !== intent.mode
      || dataBinding.generation !== intent.generation || (!intent.rejected && dataBinding.rejected)
      || (intent.bound && (dataBinding.url !== intent.url || dataBinding.dataInstanceId !== intent.dataInstanceId
        || dataBinding.certified !== intent.certified || dataBinding.dataIdentityContract !== intent.contract))) {
      throw Object.assign(connectionStaleError(), {bootstrapIntentFailure:true});
    }
  };
  const pinInitialBootstrapIntent = (intent, value) => {
    // Only a successful, still-current original-target response can establish
    // previously unknown DATA. Failed pending attempts supply no binding proof.
    if (!intent.bound && !lifecycle.disposed && !dataBinding.rejected && value?.url === intent.url && dataBinding.url === intent.url
      && dataBinding.dataInstanceId === value.dataInstanceId && dataBinding.certified === value.dataIdentityCertified
      && dataBinding.dataIdentityContract === value.dataIdentityContract
      && dataBinding.generation === intent.generation + 1) {
      Object.assign(intent, {bound:true, generation:dataBinding.generation, dataInstanceId:dataBinding.dataInstanceId,
        certified:dataBinding.certified, contract:dataBinding.dataIdentityContract, rejected:dataBinding.rejected});
    }
  };
  const assertConnectionCurrent = async (connection, generation) => {
    const currentUrl = await configuredServerUrlNow();
    if (lifecycle.disposed || currentUrl !== connection.url || generation !== dataBinding.generation
      || dataBinding.url !== connection.url) throw connectionStaleError();
    if (connection.dataIdentityCertified && (!dataBinding.certified || dataBinding.dataInstanceId !== connection.dataInstanceId)) throw dataInstanceChangedError();
  };
  const assertResponseBinding = (connection, payload) => {
    if (connection.dataIdentityCertified && payload?.dataInstanceId !== connection.dataInstanceId) throw dataInstanceChangedError();
  };
  // A persisted job must prove the same physical DATA after a fresh VM.
  // Runtime connection generations remain request-local, never a durable ID.
  const durableServerPinError = code => Object.assign(new Error(code), { code, serverPinFailure:true });
  const durableServerPinFromConnection = (connection, url) => {
    if (connection?.dataIdentityCertified !== true
      || connection.dataIdentityContract !== 'memory-suite.physical-data-identity.v1'
      || !/^[A-Za-z0-9_-]{32}$/.test(String(connection.dataInstanceId || '')))
      throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_REQUIRED');
    // The certified reset map uses an absent namespace entry for never-reset (0).
    // An absent map is unknown proof, not an empty certified map.
    const resetEpoch = connection.resetEpochs ? (connection.resetEpochs[namespace] ?? 0) : connection.resetEpoch;
    if (connection.resetEpochCertified !== true || !Number.isSafeInteger(resetEpoch) || resetEpoch < 0) throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_REQUIRED');
    return {schema:'memory-suite.durable-server-pin.v1', namespace, url:normalizeServerUrl(url),
      serverUrl:normalizeServerUrl(connection.serverUrl || connection.url), dataInstanceId:connection.dataInstanceId,
      dataIdentityContract:connection.dataIdentityContract, resetEpoch};
  };
  const captureDurableServerPin = async url => {
    const requestedUrl = normalizeServerUrl(url);
    if (requestedUrl === await configuredServerUrlNow()) {
      const connection = await bootstrap(false,true);
      await assertConnectionCurrent(connection,dataBinding.generation);
      return durableServerPinFromConnection(connection,requestedUrl);
    }
    const probe = await testConnection(requestedUrl);
    if (!probe.ok) throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
    return durableServerPinFromConnection(probe,requestedUrl);
  };
  const durableServerPinShape = (pin, url) => {
    if (!pin || pin.schema !== 'memory-suite.durable-server-pin.v1' || pin.namespace !== namespace
      || !pin.url || !pin.serverUrl || pin.dataIdentityContract !== 'memory-suite.physical-data-identity.v1'
      || !/^[A-Za-z0-9_-]{32}$/.test(String(pin.dataInstanceId || ''))
      || !Number.isSafeInteger(pin.resetEpoch) || pin.resetEpoch < 0)
      throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_REQUIRED');
    if (pin.url !== normalizeServerUrl(url)) throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
    return {schema:pin.schema,namespace:pin.namespace,url:pin.url,serverUrl:pin.serverUrl,
      dataInstanceId:pin.dataInstanceId,dataIdentityContract:pin.dataIdentityContract,resetEpoch:pin.resetEpoch};
  };
  const durableJobPinRoles = job => [
    {role:'source',url:job.sourceUrl,required:normalizeMode(job.sourceMode) !== MODE_PLUGIN_ONLY},
    {role:'target',url:job.targetUrl,required:normalizeMode(job.targetMode) !== MODE_PLUGIN_ONLY || job.targetUrl !== job.sourceUrl}
  ];
  const captureDurableJobServerPins = async job => {
    const pins={source:null,target:null};
    for (const role of durableJobPinRoles(job)) if (role.required) pins[role.role]=await captureDurableServerPin(role.url);
    return pins;
  };
  const assertStoredDurableJobMetadata = async job => {
    const store=state.legacy.plugin;
    let saved;try { const raw=await store?.getItem?.(SYNC_JOB_STORAGE_KEY);saved=typeof raw==='string'?JSON.parse(raw):raw; }catch(_){saved=null;}
    const fixed=value=>['schema','namespace','jobId','kind','scopeId','sourceMode','sourceUrl','targetMode','targetUrl','serverPins','globalPlan','globalPlanDigest']
      .map(field=>value?.[field]);
    if (!saved || jsonComparable(fixed(saved)) !== jsonComparable(fixed(job)))
      throw durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
    for (const role of durableJobPinRoles(job)) if (role.required) durableServerPinShape(job.serverPins?.[role.role],role.url);
  };
  const assertDurableJobAdmission = async job => {
    if (job.resumeExpired === true) throw durableServerPinError('MEMORY_SUITE_JOB_RESUME_EXPIRED');
    await assertStoredDurableJobMetadata(job);
    if(job.kind==='global_mode' && await globalDigest(job.globalPlan)!==job.globalPlanDigest)throw durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
    for (const role of durableJobPinRoles(job)) if (role.required) {
      const expected=durableServerPinShape(job.serverPins?.[role.role],role.url);
      const actual=await captureDurableServerPin(role.url);
      if (jsonComparable(expected)!==jsonComparable(actual)) throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
    }
  };
  const pauseSyncJobForServerPin = async error => {
    if (state.syncJob.retryTimer) {clearLifecycleTimeout(state.syncJob.retryTimer);state.syncJob.retryTimer=null;}
    updateSyncJob({status:'paused',phase:String(error.code || '').toLowerCase(),error:String(error.code || error.message),nextRetryAt:0,
      ...(error?.result ? {result:compactRestoreEvidence(error.result)} : {}),
      ...(error?.recoveryLock ? {recoveryRequired:true,recovery:compactRestoreEvidence(error.recoveryLock)} : {}),
      message:'이전에 저장한 작업의 서버를 확인할 수 없어 작업을 보류했습니다. 기존 데이터와 설정은 유지됩니다.'});
    await persistSyncJobNow();
    return getSyncJob();
  };
  const resetBootstrapCache = () => {
    bootstrapSequence++;
    dataBinding.generation++;
    state.bootstrap = { at: 0, baseUrl: '', value: null, pending: null };
    resetChoice = null;
    state.scopeRouting.routeCache.clear();
  };

  const readConfig = async (force = false) => {
    if (!force && state.transientMode && VALID_MODES.has(state.transientMode)) return { ...state.config, mode: state.transientMode };
    if (!force && Date.now() - Number(state.config.at || 0) < configCacheMs) return state.config;
    const rawMode = (await getArgumentValue(modeArguments, MODE_PLUGIN_ONLY)).trim().toLowerCase();
    const mode = state.transientMode && VALID_MODES.has(state.transientMode) ? state.transientMode : normalizeMode(rawMode);
    const rawUrl = await getArgumentValue(urlArguments, defaultUrl);
    const url = normalizeServerUrl(rawUrl);
    if (state.config.url !== url) resetBootstrapCache();
    state.config = { at: Date.now(), mode, url };
    return state.config;
  };

  const persistMode = async modeValue => {
    const mode = requireOperationalMode(modeValue);
    return await withModePublication('legacy_mode', async () => {
      state.transientMode = mode;
      try {
        await setArgumentValue(modeArguments[0] || 'memory_suite_server_mode', mode);
        state.config.at = 0;
        state.transientMode = '';
        const verified = await readConfig(true);
        if (verified.mode !== mode) throw new Error(`memory_suite_mode_readback_mismatch:${verified.mode}->${mode}`);
        setStatus('mode_changed', '', { mode, modeLabel: modeLabel(mode) });
        return verified;
      } catch (error) {
        state.transientMode = '';
        state.config.at = 0;
        throw error;
      }
    });
  };

  const persistServerUrl = async urlValue => {
    const url = normalizeServerUrl(urlValue);
    return await withModePublication('server_url', async () => {
      await setArgumentValue(urlArguments[0] || 'memory_suite_server_url', url);
      resetBootstrapCache();
      // URL persistence must not re-import the retired global mode argument.  In
      // scope-routed builds that argument is intentionally pinned to plugin_only;
      // readConfig(true) here used to overwrite the active scope's display state.
      const verifiedUrl = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
      if (verifiedUrl !== url) throw new Error(`memory_suite_url_readback_mismatch:${verifiedUrl}->${url}`);
      const verified = { ...state.config, at: Date.now(), url };
      state.config = verified;
      setStatus('url_changed', '', { url });
      return verified;
    });
  };

  const excluded = key => {
    const lower = String(key || '').toLowerCase();
    // Legacy chunk artifacts belong to the old storage adapter. The server stores
    // the hydrated logical record and must never promote individual chunk pieces.
    if (lower.includes('::chunk:v1:')) return true;
    if (excludedKeys.has(lower)) return true;
    if (excludedPrefixes.some(prefix => lower.startsWith(prefix))) return true;
    if (excludedContains.some(part => lower.includes(part))) return true;
    return false;
  };

  const matchesRoute = (space, key) => {
    const normalized = String(key || '');
    if (!normalized || excluded(normalized)) return false;
    const prefixes = space === 'local' ? localPrefixes : pluginPrefixes;
    const exact = space === 'local' ? localKeys : pluginKeys;
    return exact.has(normalized) || prefixes.some(prefix => normalized.startsWith(prefix));
  };

  const fetchApi = (url, init = {}) => {
    if (lifecycle.disposed) {
      const error = new Error('memory_suite_bridge_disposed');
      error.code = 'MEMORY_SUITE_BRIDGE_DISPOSED';
      throw error;
    }
    const requestInit = {
      ...init,
      networkRoute: 'local_network',
      requestTimeoutMs,
      logFetch: false
    };
    for (const api of apiCandidates()) {
      if (typeof api?.nativeFetch === 'function') return api.nativeFetch(url, requestInit);
      if (typeof api?.risuFetch === 'function') return api.risuFetch(url, requestInit);
    }
    if (typeof fetch === 'function') return fetch(url, requestInit);
    throw new Error('memory_suite_server_fetch_unavailable');
  };

  const withTimeout = async (promise, label, timeoutMs = requestTimeoutMs, onTimeout = null) => {
    const effectiveTimeoutMs = Math.max(250, Number(timeoutMs || requestTimeoutMs) || requestTimeoutMs);
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { onTimeout?.(); } catch (_) {}
            const error = new Error(`${label || 'Librarian System request'} timed out after ${effectiveTimeoutMs}ms`);
            error.code = 'MEMORY_SUITE_TIMEOUT';
            reject(error);
          }, effectiveTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const responseText = async (response, label, timeoutMs = requestTimeoutMs, onTimeout = null, physicalOnly = false) => {
    if (typeof response?.text === 'function') return physicalOnly ? await response.text() : await withTimeout(response.text(), `${label} response`, timeoutMs, onTimeout);
    if (typeof response?.json === 'function') return JSON.stringify(physicalOnly ? await response.json() : await withTimeout(response.json(), `${label} response`, timeoutMs, onTimeout));
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')) {
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    }
    return JSON.stringify(response || {});
  };

  const fetchJson = async (url, init = {}, label = 'Librarian System request', timeoutMs = requestTimeoutMs, cleanupTransport = null, readOnlyHealth = false) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const upstreamSignal = init?.signal || null;
    const abort = () => { try { controller?.abort?.(); } catch (_) {} };
    const forwardAbort = () => abort();
    if (controller) lifecycle.abortControllers.add(controller);
    if (upstreamSignal?.aborted) abort();
    else {
      try { upstreamSignal?.addEventListener?.('abort', forwardAbort, { once: true }); } catch (_) {}
    }
    try {
      const requestInit = controller ? { ...init, signal: controller.signal } : init;
      // Keep the physical transport AND response-body drain admitted even if
      // a caller's deadline wins and native transport ignores AbortSignal.
      // Only the strict diagnostic snapshot opts out; ordinary/cleanup requests
      // share the same owner gate as local writes and durable journal tails.
      let responseResolved, responseRejected;
      const responseReady = new Promise((resolve,reject) => { responseResolved=resolve; responseRejected=reject; });
      const physicalRead = async () => {
        try {
          const response = await (cleanupTransport ? cleanupTransport(url, requestInit) : fetchApi(url, requestInit));
          responseResolved(response);
          const raw = await responseText(response, label, timeoutMs, abort, true);
          return {response,raw};
        } catch (error) { responseRejected(error); throw error; }
      };
      const physical = readOnlyHealth === true ? physicalRead()
        : withOwnerOperation({kind:'physical_transport',operation:'fetchJson'}, physicalRead);
      // Also handles synchronous admission refusal before physicalRead starts.
      // A late rejection after caller timeout is observed, never detached.
      void physical.catch(responseRejected);
      const response = await withTimeout(responseReady, label, timeoutMs, abort);
      const {raw} = await withTimeout(physical, `${label} response`, timeoutMs, abort);
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch (parseError) {
        const error = new Error('memory_suite_server_invalid_json');
        error.code = 'MEMORY_SUITE_SERVER_INVALID_JSON';
        error.status = Number(response?.status || 0);
        error.responsePreview = compact(raw, 200);
        error.cause = parseError;
        throw error;
      }
      const status = Number(response?.status || payload?.status || 0);
      const ok = typeof response?.ok === 'boolean' ? response.ok : (status ? status >= 200 && status < 300 : payload?.ok === true);
      if (!ok || payload?.ok !== true) {
        const error = new Error(payload?.error || `memory_suite_server_http_${status || 'unknown'}`);
        error.status = status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } finally {
      if (controller) lifecycle.abortControllers.delete(controller);
      try { upstreamSignal?.removeEventListener?.('abort', forwardAbort); } catch (_) {}
    }
  };

  const validateBootstrapPayload = (payload, requestedUrl = '') => {
    if (payload?.schema !== 'memory-suite.storage.bootstrap.v1' || !payload?.token || !payload?.url) {
      throw new Error('memory_suite_bootstrap_contract_mismatch');
    }
    if (Number(payload.protocol?.major || 0) !== 1) throw new Error('memory_suite_protocol_major_incompatible');
    if (!Array.isArray(payload.namespaces) || !payload.namespaces.includes(namespace)) {
      throw new Error(`memory_suite_namespace_not_supported:${namespace}`);
    }
    for (const capability of requiredCapabilities) {
      if (payload.capabilities?.[capability] !== true) throw new Error(`memory_suite_capability_missing:${capability}`);
    }
    const dataIdentityCertified = payload.capabilities?.['data-instance-binding.v1'] === true;
    if (dataIdentityCertified && (payload.dataIdentityContract !== 'memory-suite.physical-data-identity.v1'
      || !/^[A-Za-z0-9_-]{32}$/.test(String(payload.dataInstanceId || '')))) {
      throw Object.assign(new Error('MEMORY_SUITE_DATA_INSTANCE_CONTRACT'), {code:'MEMORY_SUITE_DATA_INSTANCE_CONTRACT'});
    }
    return {
      dataIdentityCertified,
      dataInstanceId: dataIdentityCertified ? String(payload.dataInstanceId) : '',
      dataIdentityContract: dataIdentityCertified ? String(payload.dataIdentityContract) : '',
      resetEpochs: payload.resetEpochs || {},
      resetEpochCertified: !!payload.resetEpochs && typeof payload.resetEpochs === 'object' && !Array.isArray(payload.resetEpochs)
        && Object.values(payload.resetEpochs).every(value => Number.isSafeInteger(value) && value >= 0),
      requestedUrl: requestedUrl || '',
      url: String(requestedUrl || payload.url).replace(/\/+$/, ''),
      token: String(payload.token),
      version: String(payload.version || ''),
      protocol: payload.protocol || {},
      capabilities: payload.capabilities || {},
      authorityRuntime: payload.authorityRuntime || null,
      namespaces: Array.isArray(payload.namespaces) ? payload.namespaces.slice() : []
    };
  };

  const bootstrapAtUrl = async urlValue => {
    const url = normalizeServerUrl(urlValue);
    const payload = await fetchJson(`${url}/bootstrap`, {
      method: 'GET',
      headers: {
        'X-Memory-Suite-Plugin': pluginId,
        'X-Memory-Suite-Plugin-Version': pluginVersion
      }
    }, 'Librarian System connection test', bootstrapRequestTimeoutMs);
    return validateBootstrapPayload(payload, url);
  };

  // Attempt diagnostics remain public; only current attempts may publish panel state.
  const connectionProbeUiResults = new WeakMap();
  const retainConnectionProbeUiResult = (result, eligible, configuredUrl) => {
    const sequence = connectionProbeSequence, boot = bootstrapSequence, generation = dataBinding.generation;
    connectionProbeUiResults.set(result, { configuredUrl, current: () => eligible && !lifecycle.disposed
      && sequence === connectionProbeSequence && boot === bootstrapSequence && generation === dataBinding.generation });
    return result;
  };
  const connectionPanelProbeGuard = (root, selection) => {
    let revision = 0, attempt = 0;
    const invalidate = () => { revision++; };
    root.addEventListener?.('input', invalidate);
    root.addEventListener?.('change', invalidate);
    return {
      invalidate,
      begin: () => {
        const id = ++attempt, version = revision, selected = selection();
        const attached = () => !lifecycle.disposed && root.isConnected && id === attempt;
        const current = () => attached() && version === revision && selected === selection();
        return { attached, current: async result => {
          const receipt = connectionProbeUiResults.get(result);
          if (!current() || !receipt?.current()) return false;
          const configuredUrl = await configuredServerUrlNow();
          return current() && receipt.current() && configuredUrl === receipt.configuredUrl;
        } };
      }
    };
  };

  const testConnection = (...args) => withOwnerOperation({kind:'storage_operation',operation:'testConnection'}, () => testConnectionImpl(...args));
  const testConnectionImpl = async (urlValue, probeOptions = {}) => {
    // A connection probe is observational.  Never call readConfig(true) here:
    // the legacy global mode argument is plugin_only by design and forcing it
    // used to make a mirror/server_only scope appear to switch modes.
    const configuredUrl = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl).catch(() => defaultUrl));
    const url = normalizeServerUrl(urlValue || configuredUrl || defaultUrl);
    const startedAt = Date.now();
    const probeSequence = ++connectionProbeSequence;
    const probeBinding = { ...dataBinding };
    const probeBootstrapSequence = bootstrapSequence;
    let acceptedBeforeProbe = state.bootstrap.value;
    let acceptedEpochBeforeProbe = acceptedBeforeProbe?.resetEpochs?.[namespace] ?? 0;
    const originalPending = !probeBinding.certified && !probeBinding.dataInstanceId && state.bootstrap.baseUrl === url ? state.bootstrap.pending : null;
    let acceptedOriginalPending = null;
    if (originalPending) void originalPending.then(value => {
      if (bootstrapSequence === probeBootstrapSequence && state.bootstrap.value === value) acceptedOriginalPending = value;
    }, () => {});
    const observedFailure = sharedBootstrapFailures.get(url);
    try {
      const connection = await bootstrapAtUrl(url);
      const integrityPayload = await fetchJson(`${connection.url}/v1/integrity?namespace=${encodeURIComponent(namespace)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${connection.token}`,
        'X-Memory-Suite-Reset-Epochs': JSON.stringify(connection.resetEpochs || {}),
          'X-Memory-Suite-Plugin': pluginId,
          'X-Memory-Suite-Plugin-Version': pluginVersion,
          ...bindingHeaders(connection)
        }
      }, 'Librarian System namespace integrity');
      assertResponseBinding(connection, integrityPayload);
      const integrity = integrityPayload?.result || null;
      if (integrity?.ok !== true) throw new Error(`memory_suite_namespace_integrity_failed:${integrity?.result || 'unknown'}`);
      const result = {
        ok: true,
        url,
        serverUrl: connection.url,
        serverVersion: connection.version,
        dataInstanceId: connection.dataInstanceId,
        dataIdentityContract: connection.dataIdentityContract,
        dataIdentityCertified: connection.dataIdentityCertified,
        resetEpoch: connection.resetEpochs?.[namespace] ?? 0,
        resetEpochCertified: connection.resetEpochCertified === true,
        protocol: connection.protocol,
        namespaces: connection.namespaces,
        integrity,
        records: Math.max(0, Number(integrity?.records || 0) || 0),
        liveRecords: Math.max(0, Number(integrity?.liveRecords || 0) || 0),
        tombstones: Math.max(0, Number(integrity?.tombstones || 0) || 0),
        fileBytes: Math.max(0, Number(integrity?.fileBytes || 0) || 0),
        durationMs: Date.now() - startedAt
      };
      if (url === configuredUrl) {
        if (lifecycle.disposed || probeSequence !== connectionProbeSequence || await configuredServerUrlNow() !== url) throw connectionStaleError();
        if (acceptedOriginalPending && bootstrapSequence === probeBootstrapSequence && state.bootstrap.value === acceptedOriginalPending
          && dataBinding.generation === probeBinding.generation + 1 && dataBinding.url === url && !probeBinding.rejected && !dataBinding.rejected
          && acceptedOriginalPending.dataIdentityCertified === true && acceptedOriginalPending.resetEpochCertified === true
          && dataBinding.certified === true && dataBinding.dataInstanceId === acceptedOriginalPending.dataInstanceId
          && dataBinding.dataIdentityContract === acceptedOriginalPending.dataIdentityContract
          && connection.dataIdentityCertified === true && connection.resetEpochCertified === true
          && connection.dataInstanceId === acceptedOriginalPending.dataInstanceId && connection.dataIdentityContract === acceptedOriginalPending.dataIdentityContract
          && (connection.resetEpochs?.[namespace] ?? 0) === (acceptedOriginalPending.resetEpochs?.[namespace] ?? 0)) {
          Object.assign(probeBinding, dataBinding);
          acceptedBeforeProbe = acceptedOriginalPending;
          acceptedEpochBeforeProbe = acceptedOriginalPending.resetEpochs?.[namespace] ?? 0;
        }
        if (lifecycle.disposed || probeSequence !== connectionProbeSequence
          || bootstrapSequence !== probeBootstrapSequence || state.bootstrap.value !== acceptedBeforeProbe
          || (state.bootstrap.value?.resetEpochs?.[namespace] ?? 0) !== acceptedEpochBeforeProbe
          || dataBinding.generation !== probeBinding.generation || dataBinding.url !== probeBinding.url
          || dataBinding.dataInstanceId !== probeBinding.dataInstanceId || dataBinding.certified !== probeBinding.certified
          || dataBinding.dataIdentityContract !== probeBinding.dataIdentityContract || dataBinding.rejected !== probeBinding.rejected) throw connectionStaleError();
        adoptDataBinding(connection, probeOptions.adoptDataInstance === true);
        bootstrapSequence++;
        state.bootstrap = { at: Date.now(), baseUrl: configuredUrl, value: connection, pending: null };
        if (connection.dataIdentityCertified === true && connection.resetEpochCertified === true
          && observedFailure && sharedBootstrapFailures.get(url) === observedFailure) sharedBootstrapFailures.delete(url);
        setStatus('connected', '', { serverVersion: connection.version, url: connection.url, protocol: connection.protocol });
      }
      return retainConnectionProbeUiResult(result, url === configuredUrl ||
        (probeSequence === connectionProbeSequence && bootstrapSequence === probeBootstrapSequence
          && dataBinding.generation === probeBinding.generation), configuredUrl);
    } catch (error) {
      const normalized = normalizeServerAvailabilityError(error);
      const result = { ok: false, url, error: compact(normalized?.message || normalized, 700), durationMs: Date.now() - startedAt };
      // An obsolete probe can fail after a newer bootstrap has already succeeded.
      // Recheck currentness after the async URL read before publishing failure.
      const canPublishFailure = () => !lifecycle.disposed && normalized?.code !== 'MEMORY_SUITE_CONNECTION_STALE'
        && url === configuredUrl && probeSequence === connectionProbeSequence
        && bootstrapSequence === probeBootstrapSequence && dataBinding.generation === probeBinding.generation;
      if (canPublishFailure() && await configuredServerUrlNow() === url && canPublishFailure()) setStatus('unavailable', result.error, { url });
      const displayEligible = !lifecycle.disposed && normalized?.code !== 'MEMORY_SUITE_CONNECTION_STALE'
        && probeSequence === connectionProbeSequence && bootstrapSequence === probeBootstrapSequence
        && dataBinding.generation === probeBinding.generation;
      return retainConnectionProbeUiResult(result, displayEligible, configuredUrl);
    }
  };

  const bootstrap = (...args) => withOwnerOperation({kind:'storage_operation',operation:'bootstrap'}, () => bootstrapImpl(...args));
  const bootstrapImpl = async (force = false, allowPluginOnly = false, originalIntent = null) => {
    if (lifecycle.disposed) {
      const error = new Error('memory_suite_bridge_disposed');
      error.code = 'MEMORY_SUITE_BRIDGE_DISPOSED';
      throw error;
    }
    const config = await readConfig(force);
    const intent = originalIntent || (force ? captureBootstrapIntent(config) : null);
    const initialSequence = bootstrapSequence;
    const initialPending = intent && !intent.bound && state.bootstrap.baseUrl === intent.url ? state.bootstrap.pending : null;
    // This proof belongs to the earlier pending attempt. This force attempt's
    // own pending is created below and is never awaited as its initial proof.
    const initialProof = initialPending?.then(value => initialSequence === bootstrapSequence && state.bootstrap.value === value ? value : null, () => null);
    if (intent) await assertBootstrapIntent(intent, initialProof);
    if (config.mode === MODE_PLUGIN_ONLY && allowPluginOnly !== true) return null;
    const cached = state.bootstrap;
    // A forced refresh still needs a new response, but must not supersede an
    // in-flight refresh at this URL (including an explicit reset choice).
    if (force && cached.pending && cached.baseUrl === config.url) {
      const value = await cached.pending.catch(() => null);
      pinInitialBootstrapIntent(intent, value);
      return await bootstrap(true, allowPluginOnly, intent);
    }
    if (!force && cached.value && cached.baseUrl === config.url && Date.now() - Number(cached.at || 0) < bootstrapCacheMs) return cached.value;
    if (!force && cached.pending && cached.baseUrl === config.url) return await cached.pending;
    if (!force) {
      const offline = cachedBootstrapFailure(config.url);
      if (offline) throw offline;
    }
    const sequence = ++bootstrapSequence;
    const previous = state.bootstrap;
    const pending = (async () => {
      const payload = await fetchJson(`${config.url}/bootstrap`, {
        method: 'GET',
        headers: {
          'X-Memory-Suite-Plugin': pluginId,
          'X-Memory-Suite-Plugin-Version': pluginVersion
        }
      }, 'Librarian System bootstrap', bootstrapRequestTimeoutMs);
      const value = validateBootstrapPayload(payload, config.url);
      if (intent) await assertBootstrapIntent(intent);
      const currentUrl = await configuredServerUrlNow();
      if (lifecycle.disposed || sequence !== bootstrapSequence || currentUrl !== config.url) throw connectionStaleError();
      adoptDataBinding(value);
      if (previous.value?.resetEpochs?.[namespace] !== value.resetEpochs?.[namespace]) cacheQualifiedResetChoice(null);
      if (intent) pinInitialBootstrapIntent(intent, value);
      sharedBootstrapFailures.delete(config.url);
      state.bootstrap = { at: Date.now(), baseUrl: config.url, value, pending: null };
      setStatus('connected', '', { serverVersion: value.version, url: value.url });
      return value;
    })();
    state.bootstrap = { at: 0, baseUrl: config.url, value: null, pending };
    try {
      return await pending;
    } catch (error) {
      if (sequence !== bootstrapSequence || lifecycle.disposed) throw error;
      const normalized = error?.bootstrapIntentFailure === true ? error : normalizeServerAvailabilityError(error);
      state.bootstrap = previous.value ? {...previous,pending:null} : { at: 0, baseUrl: config.url, value: null, pending: null };
      if (normalized?.code === 'MEMORY_SUITE_SERVER_UNAVAILABLE') {
        sharedBootstrapFailures.set(config.url, { at: Date.now(), message: normalized.message, code: normalized.code });
      }
      setStatus('unavailable', normalized?.message || normalized, { url: config.url });
      // Offline is an expected state: pluginStorage remains authoritative and
      // the status object exposes the condition without noisy console warnings.
      // Contract/configuration failures still surface once for diagnosis.
      if (normalized?.code !== 'MEMORY_SUITE_SERVER_UNAVAILABLE') {
        warnOnce('server_bootstrap_failed', normalized);
      }
      throw normalized;
    }
  };

  const request = (...args) => withOwnerOperation({kind:'storage_operation',operation:'request'}, () => requestImpl(...args));
  const requestImpl = async (method, route, body = null, requestOptions = {}) => {
    const connection = await bootstrap(requestOptions.forceBootstrap === true, requestOptions.allowPluginOnly === true);
    if (!connection) throw new Error('memory_suite_server_not_enabled');
    const bindingGeneration = requestOptions.bindingGeneration ?? dataBinding.generation;
    await assertConnectionCurrent(connection, bindingGeneration);
    const resetEpoch=Number(connection.resetEpochs?.[namespace]||0);
    if(resetEpoch && !route.startsWith('/v1/manager/')){
      const choice=await readResetChoice(connection);
      if(resetReloadRequired || choice?.epoch!==resetEpoch || choice?.url!==(connection.requestedUrl||connection.url)){
        throw new Error('서버 자료가 초기화 또는 복원되었습니다. 서버 연결 설정에서 서버 자료 사용 또는 로컬 기억 다시 업로드를 선택한 뒤 RisuAI를 새로고침하세요.');
      }
    }
    const requestScope = requestOptions.scope && typeof requestOptions.scope === 'object'
      ? requestOptions.scope
      : state.scopeRouting.current;
    const requestScopeId = String(requestOptions.scopeId || requestScope?.scopeId || '').trim();
    const registeredMode = requestScopeId ? state.scopeRouting.registry?.entries?.[requestScopeId]?.mode : '';
    const transientMode = requestScopeId ? state.scopeRouting.transientModes.get(requestScopeId) : '';
    const requestMode = normalizeMode(requestOptions.storageMode || transientMode || registeredMode || state.config.mode || MODE_PLUGIN_ONLY);
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'X-Memory-Suite-Reset-Epochs': JSON.stringify(connection.resetEpochs || {}),
        'X-Memory-Suite-Plugin': pluginId,
        'X-Memory-Suite-Plugin-Version': pluginVersion,
        ...(requestScopeId ? { 'X-Memory-Suite-Scope-Id': encodeURIComponent(requestScopeId) } : {}),
        'X-Memory-Suite-Storage-Mode': requestMode,
        ...(requestOptions.extraHeaders && typeof requestOptions.extraHeaders === 'object' ? requestOptions.extraHeaders : {}),
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        ...bindingHeaders(connection)
      },
      ...(body == null ? {} : { body: JSON.stringify(body) })
    };
    try {
      await assertConnectionCurrent(connection, bindingGeneration);
      const payload = await fetchJson(`${connection.url}${route}`, init, `Librarian System ${method} ${route}`);
      await assertConnectionCurrent(connection, bindingGeneration);
      assertResponseBinding(connection, payload);
      return payload;
    } catch (error) {
      if (error?.status === 403 && requestOptions.authRetry !== false) {
        await bootstrap(true, requestOptions.allowPluginOnly === true);
        return await request(method, route, body, { ...requestOptions, bindingGeneration, authRetry: false });
      }
      if (error?.payload?.error === 'data_instance_binding_changed') dataBinding.rejected = true;
      const unavailable = normalizeServerAvailabilityError(error);
      if (unavailable?.code === 'MEMORY_SUITE_SERVER_UNAVAILABLE') {
        const circuitUrl = String(connection.requestedUrl || state.config.url || '');
        if (circuitUrl) sharedBootstrapFailures.set(circuitUrl, {
          at: Date.now(), message: unavailable.message, code: unavailable.code
        });
        resetBootstrapCache();
      }
      setStatus('request_failed', error?.message || error, { route, method });
      throw error;
    }
  };

  const operationId = kind => {
    let unique = '';
    try { unique = globalThis?.crypto?.randomUUID?.() || ''; } catch (_) {}
    if (!unique) unique = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    const prefix = `${namespace}_${kind}_${pluginId}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
    return `${prefix}_${unique.replace(/[^A-Za-z0-9._:-]/g, '')}`.slice(0, 238);
  };

  const verifyReceipt = (payload, expectedId, expectedSpace, expectedKey) => {
    const receipt = payload?.result || {};
    if (receipt.schema !== 'memory-suite.storage.receipt.v1'
      || receipt.namespace !== namespace
      || receipt.operationId !== expectedId
      || receipt.space !== expectedSpace
      || receipt.key !== expectedKey
      || receipt.durable !== true
      || receipt.verified !== true
      || !receipt.digest
      || Number(receipt.revision || 0) < 1) {
      throw new Error('memory_suite_durable_receipt_invalid');
    }
    return receipt;
  };

  const statusReadbackAttempts = 3;
  const statusReadbackDelayMs = 400;
  const statusReadback = async (id, requestOptions = {}) => {
    try {
      return await request('GET', `/v1/operations/${encodeURIComponent(namespace)}/${encodeURIComponent(id)}`, null, { authRetry: true, allowPluginOnly: requestOptions.allowPluginOnly === true, forceBootstrap:requestOptions.forceBootstrap === true, scope:requestOptions.scope, storageMode:requestOptions.storageMode });
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  };

  const remoteGet = async (space, key, requestOptions = {}) => {
    const payload = await request(
      'GET',
      `/v1/kv/get?namespace=${encodeURIComponent(namespace)}&space=${encodeURIComponent(space)}&key=${encodeURIComponent(key)}`,
      null,
      { allowPluginOnly: requestOptions.allowPluginOnly === true, scope:requestOptions.scope, storageMode:requestOptions.storageMode }
    );
    return payload?.result || {};
  };

  const remoteGetMany = async (space, keys = [], requestOptions = {}) => {
    const list = Array.isArray(keys) ? keys.map(value => String(value || '')).filter(Boolean).slice(0, 512) : [];
    if (!list.length) return { values: {}, pages: 0, oversizedKeys: [] };
    const values = {};
    const oversizedKeys = new Set();
    let cursor = 0;
    let pages = 0;
    for (;;) {
      if (pages >= maxStoragePaginationPages) throw new Error('memory_suite_get_many_pagination_limit_exceeded');
      const payload = await (requestOptions.inventoryRequest || request)(
        'POST',
        '/v1/kv/get-many',
        { namespace, space, keys: list, paged: true, cursor, maxResponseBytes: getManyResponseBudgetBytes },
        { allowPluginOnly: requestOptions.allowPluginOnly === true, scope:requestOptions.scope, storageMode:requestOptions.storageMode }
      );
      pages += 1;
      const result = payload?.result || { values: {} };
      mergeStorageRecordValues(values, result.values);
      for (const key of Array.isArray(result.oversizedKeys) ? result.oversizedKeys : []) oversizedKeys.add(String(key));
      const nextCursor = result?.continuation?.nextCursor;
      if (nextCursor == null) break;
      const normalizedNext = Number(nextCursor);
      if (!Number.isInteger(normalizedNext) || normalizedNext <= cursor || normalizedNext > list.length) {
        throw new Error('memory_suite_get_many_pagination_cursor_invalid');
      }
      cursor = normalizedNext;
    }
    if(requestOptions.strictInventory===true&&(oversizedKeys.size||list.some(key=>!Object.hasOwn(values,key))))throw globalModeError('remote_values_incomplete_or_oversized');
    for (const key of oversizedKeys) defineStorageRecordValue(values, key, await remoteGet(space, key, requestOptions));
    return { values, pages, oversizedKeys: [...oversizedKeys] };
  };

  const remoteKeys = async (space, prefix = '', requestOptions = {}) => {
    const keys = [];
    const tombstones = [];
    const records = [];
    const seenKeys = new Set();
    const seenTombstones = new Set();
    const seenRecords = new Set();
    const seenCursors = new Set();
    let cursor = '';
    let pages = 0;
    for (;;) {
      if (pages >= maxStoragePaginationPages) throw new Error('memory_suite_keys_pagination_limit_exceeded');
      const payload = await (requestOptions.inventoryRequest || request)(
        'GET',
        `/v1/kv/keys?namespace=${encodeURIComponent(namespace)}&space=${encodeURIComponent(space)}&prefix=${encodeURIComponent(prefix)}&paged=1&limit=${keyPageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        null,
        { allowPluginOnly: requestOptions.allowPluginOnly === true, scope:requestOptions.scope, storageMode:requestOptions.storageMode }
      );
      pages += 1;
      const result = payload?.result || { keys: [], tombstones: [], records: [] };
      if(requestOptions.strictInventory===true){
        if(!Array.isArray(result.keys)||!Array.isArray(result.tombstones)||!Array.isArray(result.records))throw globalModeError('remote_keys_incomplete');
        const pageKeys=[...result.keys,...result.tombstones];
        if(new Set(pageKeys).size!==pageKeys.length||pageKeys.some(key=>typeof key!=='string'||seenKeys.has(key)||seenTombstones.has(key)))throw globalModeError('remote_keys_duplicate');
        if(result.records.length!==pageKeys.length||new Set(result.records.map(row=>row.key)).size!==pageKeys.length||result.records.some(row=>!pageKeys.includes(row.key)||!Number.isSafeInteger(row.revision)||!row.digest))throw globalModeError('remote_metadata_incomplete');
      }
      for (const key of Array.isArray(result.keys) ? result.keys : []) {
        const normalized = String(key);
        if (!seenKeys.has(normalized)) { seenKeys.add(normalized); keys.push(normalized); }
      }
      for (const key of Array.isArray(result.tombstones) ? result.tombstones : []) {
        const normalized = String(key);
        if (!seenTombstones.has(normalized)) { seenTombstones.add(normalized); tombstones.push(normalized); }
      }
      for (const row of Array.isArray(result.records) ? result.records : []) {
        const identity = `${String(row?.space || space)}\u0000${String(row?.key || '')}`;
        if (!seenRecords.has(identity)) { seenRecords.add(identity); records.push(row); }
      }
      const nextCursor = String(result.nextCursor || result?.page?.nextCursor || '');
      if (!nextCursor) break;
      if (nextCursor === cursor || seenCursors.has(nextCursor)) throw new Error('memory_suite_keys_pagination_cursor_stalled');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return { keys, tombstones, records, page: { pages, complete: true } };
  };

  const remoteIntegrity = async (requestOptions = {}) => {
    const payload = await request(
      'GET',
      `/v1/integrity?namespace=${encodeURIComponent(namespace)}`,
      null,
      { allowPluginOnly: requestOptions.allowPluginOnly === true }
    );
    const result = payload?.result || {};
    if (result.ok !== true || String(result.result || '') !== 'ok') {
      const error = new Error(`memory_suite_namespace_integrity_failed:${result.result || 'unknown'}`);
      error.code = 'MEMORY_SUITE_INTEGRITY_FAILED';
      throw error;
    }
    return result;
  };

  const remoteMutate = (...args) => withOwnerOperation({kind:'storage_operation',operation:'remoteMutate'}, () => remoteMutateImpl(...args));
  const remoteMutateImpl = async (kind, space, key, value, mutateOptions = {}) => {
    if (kind === 'set') {
      const valueBytes = storageValueBytes(value);
      if (valueBytes > interactiveSetValueBudgetBytes) {
        const error = new Error(`memory_suite_interactive_value_too_large_use_shards:${valueBytes}>${interactiveSetValueBudgetBytes}`);
        error.code = 'MEMORY_SUITE_INTERACTIVE_VALUE_TOO_LARGE';
        error.valueBytes = valueBytes;
        error.maxValueBytes = interactiveSetValueBudgetBytes;
        error.storageMutationRejected = true;
        throw error;
      }
    }
    const id = operationId(kind);
    const expectedRevision = Number.isInteger(Number(mutateOptions.expectedRevision))
      ? Math.max(0, Number(mutateOptions.expectedRevision))
      : null;
    const body = {
      namespace,
      operationId: id,
      space,
      key,
      ...(kind === 'set' ? { value } : {}),
      ...(expectedRevision == null ? {} : { expectedRevision })
    };
    const verifyStored = async receipt => {
      const stored = await remoteGet(space, key, { allowPluginOnly: mutateOptions.allowPluginOnly === true, scope:mutateOptions.scope, storageMode:mutateOptions.storageMode });
      const valueMatches = kind === 'remove'
        ? stored.exists === false && stored.tombstone === true
        : stored.exists === true && jsonComparable(stored.value) === jsonComparable(value);
      if (!valueMatches
        || Number(stored.revision || 0) !== Number(receipt.revision || 0)
        || String(stored.digest || '') !== String(receipt.digest || '')) {
        // Another writer committed after this write: the server's operation record,
        // not the live value, proves this write committed (it was then superseded).
        if (Number(stored.revision || 0) > Number(receipt.revision || 0) && confirmSuperseded) {
          const record = verifyReceipt(await confirmSuperseded(), id, space, key);
          if (Number(record.revision || 0) === Number(receipt.revision || 0) && String(record.digest || '') === String(receipt.digest || '')) {
            setStatus('durable', '', { operationId: id, revision: receipt.revision, key: compact(key, 180), space, superseded: true });
            return { ...receipt, endToEndVerified: true, superseded: true, currentRevision: Number(stored.revision || 0) };
          }
        }
        throw new Error('memory_suite_end_to_end_readback_mismatch');
      }
      setStatus('durable', '', { operationId: id, revision: receipt.revision, key: compact(key, 180), space });
      return { ...receipt, endToEndVerified: true };
    };
    const readbackOptions = { allowPluginOnly: mutateOptions.allowPluginOnly === true, scope:mutateOptions.scope, storageMode:mutateOptions.storageMode };
    const confirmSuperseded = () => statusReadback(id, readbackOptions);
    try {
      const payload = await request('POST', `/v1/kv/${kind}`, body, { allowPluginOnly: mutateOptions.allowPluginOnly === true, scope:mutateOptions.scope, storageMode:mutateOptions.storageMode });
      return await verifyStored(verifyReceipt(payload, id, space, key));
    } catch (error) {
      // A lost response may hide a committed write. The request path has already opened
      // the shared outage circuit, so the operation lookup forces a fresh bootstrap.
      for (let attempt = 0; attempt < statusReadbackAttempts; attempt += 1) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, statusReadbackDelayMs * attempt));
        if (lifecycle.disposed) break;
        try {
          const status = await statusReadback(id, { ...readbackOptions, forceBootstrap:true });
          if (status) return await verifyStored(verifyReceipt(status, id, space, key));
          break;
        } catch (readbackError) {
          if (readbackError?.message === 'memory_suite_end_to_end_readback_mismatch' || readbackError?.status === 403) break;
        }
      }
      error.storageMutationIndeterminate = true;
      error.storageMutationKey = key;
      error.storageOperationId = id;
      throw error;
    }
  };

  const serializeMutation = async (space, key, factory) => {
    const lockKey = `${space}\n${key}`;
    const previous = mutationTails.get(lockKey) || Promise.resolve();
    const operation = Promise.resolve(previous).catch(() => undefined).then(factory);
    const tail = operation.then(() => undefined, () => undefined);
    mutationTails.set(lockKey, tail);
    tail.then(() => {
      if (mutationTails.get(lockKey) === tail) mutationTails.delete(lockKey);
    });
    return await operation;
  };
  const serializeMutationGroup = async (keys, factory) => {
    const ordered=[...new Map((Array.isArray(keys)?keys:[]).map(item=>{
      const space=String(item?.space||''),key=String(item?.key||'');
      return [`${space}\n${key}`,{space,key}];
    }).filter(([identity,item])=>identity!=='\n'&&item.space&&item.key)).values()]
      .sort((a,b)=>`${a.space}\n${a.key}`.localeCompare(`${b.space}\n${b.key}`));
    const acquire=index=>index>=ordered.length?factory():serializeMutation(ordered[index].space,ordered[index].key,()=>acquire(index+1));
    return await acquire(0);
  };

  const isNullishStorageValue = value => value === null || value === undefined || value === '';

  const legacyRead = async (legacy, key) => {
    if (!legacy || typeof legacy.getItem !== 'function') return null;
    const value=await legacy.getItem(key);
    if(globalMigrationContext){const space=legacy===globalMigrationContext.stores.local?'local':'plugin';
      const record=globalMigrationContext.records.find(row=>row.location!=='server'&&row.space===space&&row.key===key&&Object.hasOwn(row,'logicalValue'));
      if(record){if(globalCanonical(value)!==globalCanonical(record.value))throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{key});return record.logicalValue;}
    }
    return value;
  };

  const legacyWriteVerified = (...args) => withOwnerOperation({kind:'storage_operation',operation:'legacyWriteVerified'}, () => legacyWriteVerifiedImpl(...args));
  const legacyWriteVerifiedImpl = async (legacy, key, value, beforeSet = null) => {
    if (!legacy || typeof legacy.setItem !== 'function') return false;
    if (beforeSet) await beforeSet(legacy, key, value);
    const result = await legacy.setItem(key, value);
    if (result === false) return false;
    if (typeof legacy.getItem === 'function') {
      const readback = await legacy.getItem(key);
      if (jsonComparable(readback) !== jsonComparable(value)) {
        const error = new Error(`memory_suite_pluginstorage_readback_mismatch:${compact(key, 160)}`);
        error.code = 'MEMORY_SUITE_LOCAL_READBACK_MISMATCH';
        throw error;
      }
    }
    return true;
  };

  const legacyRemoveVerified = (...args) => withOwnerOperation({kind:'storage_operation',operation:'legacyRemoveVerified'}, () => legacyRemoveVerifiedImpl(...args));
  const legacyRemoveVerifiedImpl = async (legacy, key) => {
    if (!legacy) return false;
    let result = false;
    if (typeof legacy.removeItem === 'function') result = (await legacy.removeItem(key)) !== false;
    else if (typeof legacy.setItem === 'function') result = (await legacy.setItem(key, null)) !== false;
    if (!result) return false;
    if (typeof legacy.getItem === 'function') {
      const readback = await legacy.getItem(key);
      if (!isNullishStorageValue(readback)) {
        const error = new Error(`memory_suite_pluginstorage_remove_readback_mismatch:${compact(key, 160)}`);
        error.code = 'MEMORY_SUITE_LOCAL_REMOVE_READBACK_MISMATCH';
        throw error;
      }
    }
    return true;
  };

  const legacyKeys = async legacy => {
    if (!legacy || typeof legacy.keys !== 'function') return null;
    const listed = await legacy.keys();
    return Array.isArray(listed) ? [...new Set(listed.map(String).filter(Boolean))] : [];
  };

  const chunkOwnerKey = key => {
    const raw = String(key || '');
    const marker = '::chunk:v1:';
    const index = raw.indexOf(marker);
    return index > 0 ? raw.slice(0, index) : '';
  };

  const isOwnedChunkArtifact = (space, key) => {
    const owner = chunkOwnerKey(key);
    return !!owner && matchesRoute(space, owner);
  };

  const listRoutedLegacyKeys = async (legacy, space, includeArtifacts = false) => {
    const listed = await legacyKeys(legacy);
    if (listed == null) {
      const error = new Error('memory_suite_pluginstorage_key_enumeration_required');
      error.code = 'MEMORY_SUITE_KEYS_UNAVAILABLE';
      throw error;
    }
    return listed.filter(key => matchesRoute(space, key) || (includeArtifacts && isOwnedChunkArtifact(space, key)));
  };

  // Owner-only maintenance primitives. They intentionally bypass server
  // routing, but still enforce this namespace's route allowlist and durable
  // readback. Product code uses them only after authenticated RE:TRACE IPC has
  // identified an exact metadata shell; they are never exposed to GUI input.
  const ownerLegacyForSpace = space => String(space || 'plugin') === 'local'
    ? state.legacy.local
    : state.legacy.plugin;
  const ownerLegacyKeys = async (space = 'plugin', includeArtifacts = true) => {
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    return await listRoutedLegacyKeys(ownerLegacyForSpace(normalizedSpace), normalizedSpace, includeArtifacts === true);
  };
  const ownerLegacyRead = async (space, key) => {
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    const logicalKey = String(key || '');
    if (!matchesRoute(normalizedSpace, logicalKey)) throw new Error('memory_suite_owner_legacy_route_denied');
    return await legacyRead(ownerLegacyForSpace(normalizedSpace), logicalKey);
  };
  const ownerLegacyWrite = async (space, key, value) => {
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    const logicalKey = String(key || '');
    if (!matchesRoute(normalizedSpace, logicalKey)) throw new Error('memory_suite_owner_legacy_route_denied');
    const written = await legacyWriteVerified(ownerLegacyForSpace(normalizedSpace), logicalKey, value);
    if (!written) throw new Error('memory_suite_owner_legacy_write_failed');
    return true;
  };
  const ownerLegacyRemove = async (space, key) => {
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    const logicalKey = String(key || '');
    if (!matchesRoute(normalizedSpace, logicalKey)) throw new Error('memory_suite_owner_legacy_route_denied');
    const removed = await legacyRemoveVerified(ownerLegacyForSpace(normalizedSpace), logicalKey);
    if (!removed) throw new Error('memory_suite_owner_legacy_remove_failed');
    return true;
  };

  const migrateFromLegacy = async (space, key, legacyGet = null) => {
    if (typeof legacyGet !== 'function') return { state: 'missing', value: null };
    return await serializeMutation(space, key, async () => {
      const current = await remoteGet(space, key);
      if (current.exists === true) return { state: 'server', value: current.value };
      if (current.tombstone === true) return { state: 'tombstone', value: null };
      const legacy = await legacyGet();
      if (legacy === null || legacy === undefined) return { state: 'missing', value: null };
      try {
        await remoteMutate('set', space, key, legacy, { expectedRevision: 0 });
        return { state: 'migrated', value: legacy };
      } catch (error) {
        if (error?.status === 409) {
          const afterConflict = await remoteGet(space, key);
          if (afterConflict.exists === true) return { state: 'server', value: afterConflict.value };
          if (afterConflict.tombstone === true) return { state: 'tombstone', value: null };
        }
        throw error;
      }
    });
  };

  const synchronizeLegacyWithServer = async (legacy, space = 'plugin', options = {}) => {
    if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
    const config = await readConfig(true);
    if (config.mode === MODE_PLUGIN_ONLY && options.allowPluginOnly !== true) {
      throw new Error('memory_suite_server_mode_required_for_sync');
    }
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const allowPluginOnly = options.allowPluginOnly === true;
    const progress = {
      schema: 'memory-suite.sync-progress.v1', namespace, space,
      phase: 'integrity_before', currentAction: '서버 무결성 확인', currentKey: '',
      totalItems: 0, processedItems: 0, processedBytes: 0, transferredBytes: 0,
      uploaded: 0, restored: 0, matched: 0, removedByTombstone: 0,
      failureCount: 0, conflictCount: 0, startedAt: Date.now(), lastActivityAt: Date.now()
    };
    const report = (phase, patch = {}) => {
      Object.assign(progress, patch || {}, { phase: String(phase || progress.phase), lastActivityAt: Date.now() });
      try { onProgress?.({ ...progress }); } catch (_) {}
    };
    report('integrity_before', { message: '서버 DATA 무결성을 확인하고 있습니다.' });
    const integrityBefore = await remoteIntegrity({ allowPluginOnly });
    report('inventory', { currentAction: '데이터 목록 조사', message: 'pluginStorage와 서버의 데이터 목록을 비교하고 있습니다.' });
    const localLogicalKeys = (await listRoutedLegacyKeys(legacy, space, false)).slice().sort();
    const serverListing = await remoteKeys(space, '', { allowPluginOnly });
    const serverKeys = new Set((serverListing.keys || []).map(String));
    const serverTombstones = new Set((serverListing.tombstones || []).map(String));
    const serverRecordBytes = new Map((Array.isArray(serverListing.records) ? serverListing.records : []).map(row => [String(row?.key || ''), Math.max(0, Number(row?.valueBytes || 0) || 0)]));
    const localSet = new Set(localLogicalKeys);
    const missingServerKeys = options.restoreMissingLocal === true
      ? Array.from(serverKeys).filter(key => matchesRoute(space, key) && !localSet.has(key)).sort()
      : [];
    progress.totalItems = localLogicalKeys.length + missingServerKeys.length;
    report('inventory_complete', {
      currentAction: '목록 조사 완료',
      localKeys: localLogicalKeys.length,
      serverKeys: serverKeys.size,
      serverTombstones: serverTombstones.size,
      message: `처리 대상 ${progress.totalItems.toLocaleString()}개를 확인했습니다.`
    });
    const result = {
      schema: 'memory-suite.sync.v1', namespace, space, startedAt: progress.startedAt,
      localKeys: localLogicalKeys.length, uploaded: 0, restored: 0, removedByTombstone: 0,
      matched: 0, conflicts: [], failures: [], integrityBefore, integrityAfter: null,
      totalItems: progress.totalItems, processedItems: 0, processedBytes: 0, transferredBytes: 0
    };
    // A failed plugin_only -> mirror transition must never consume the only local
    // copy merely because the server carries a deliberate scope-deletion tombstone.
    const protectedConflictKeys = new Set();

    for (const key of localLogicalKeys) {
      let localBytes = 0;
      let action = '비교';
      try {
        report('sync_local', { currentAction: 'pluginStorage → 서버 비교', currentKey: key });
        const localValue = await legacyRead(legacy, key);
        localBytes = isNullishStorageValue(localValue) ? 0 : storageValueBytes(localValue);
        if (isNullishStorageValue(localValue)) {
          action = '빈 값 건너뜀';
        } else {
          const remote = await remoteGet(space, key, { allowPluginOnly });
          if (remote.exists === true && jsonComparable(remote.value) === jsonComparable(localValue)) {
            result.matched += 1;
            action = '일치 확인';
          } else if (remote.tombstone === true && options.resurrectTombstones !== true) {
            if (options.allowOverwrite === false) {
              result.conflicts.push({ key, serverState: 'tombstone', localPreserved: true });
              protectedConflictKeys.add(key);
              action = '삭제 충돌 보존';
            } else if (options.restoreMissingLocal === true) {
              const removed = await legacyRemoveVerified(legacy, key);
              if (!removed) throw new Error('pluginstorage_tombstone_apply_failed');
              result.removedByTombstone += 1;
              action = '서버 삭제 상태 반영';
            } else {
              result.conflicts.push({ key, serverState: 'tombstone' });
              action = '삭제 충돌';
            }
          } else if (options.allowOverwrite === false && remote.exists === true) {
            result.conflicts.push({ key, serverState: 'value' });
            action = '기존 서버 값 충돌';
          } else {
            await remoteMutate('set', space, key, localValue, { allowPluginOnly });
            const verified = await remoteGet(space, key, { allowPluginOnly });
            if (verified.exists !== true || jsonComparable(verified.value) !== jsonComparable(localValue)) {
              throw new Error('post_sync_server_readback_mismatch');
            }
            result.uploaded += 1;
            progress.transferredBytes += localBytes;
            action = '업로드·검증';
          }
        }
      } catch (error) {
        result.failures.push({ key, error: compact(error?.message || error, 220) });
        action = '실패';
      } finally {
        result.processedItems += 1;
        result.processedBytes += localBytes;
        progress.processedItems = result.processedItems;
        progress.processedBytes = result.processedBytes;
        progress.uploaded = result.uploaded;
        progress.restored = result.restored;
        progress.matched = result.matched;
        progress.removedByTombstone = result.removedByTombstone;
        progress.failureCount = result.failures.length;
        progress.conflictCount = result.conflicts.length;
        report('sync_local', { currentAction: action, currentKey: key });
      }
    }

    if (options.restoreMissingLocal === true) {
      for (const key of missingServerKeys) {
        const remoteBytes = Math.max(0, Number(serverRecordBytes.get(key) || 0) || 0);
        let action = '서버 → pluginStorage 복구';
        try {
          report('restore_missing_local', { currentAction: action, currentKey: key });
          const remote = await remoteGet(space, key, { allowPluginOnly });
          if (remote.exists !== true) {
            action = '서버 값 없음';
          } else {
            const ok = await legacyWriteVerified(legacy, key, remote.value);
            if (!ok) throw new Error('pluginstorage_restore_write_failed');
            result.restored += 1;
            progress.transferredBytes += remoteBytes || storageValueBytes(remote.value);
            action = '복구·검증';
          }
        } catch (error) {
          result.failures.push({ key, error: compact(error?.message || error, 220) });
          action = '복구 실패';
        } finally {
          result.processedItems += 1;
          result.processedBytes += remoteBytes;
          progress.processedItems = result.processedItems;
          progress.processedBytes = result.processedBytes;
          progress.uploaded = result.uploaded;
          progress.restored = result.restored;
          progress.matched = result.matched;
          progress.removedByTombstone = result.removedByTombstone;
          progress.failureCount = result.failures.length;
          progress.conflictCount = result.conflicts.length;
          report('restore_missing_local', { currentAction: action, currentKey: key });
        }
      }
      // Tombstones for keys that were already present locally are handled in the
      // local-key pass above. Re-check only for values that survived unexpectedly.
      for (const key of serverTombstones) {
        if (!matchesRoute(space, key) || !localSet.has(key) || protectedConflictKeys.has(key)) continue;
        try {
          const current = await legacyRead(legacy, key);
          if (!isNullishStorageValue(current)) {
            const ok = await legacyRemoveVerified(legacy, key);
            if (!ok) throw new Error('pluginstorage_tombstone_apply_failed');
            result.removedByTombstone += 1;
          }
        } catch (error) {
          result.failures.push({ key, error: compact(error?.message || error, 220) });
        }
      }
    }

    report('integrity_after', { currentAction: '최종 무결성 확인', currentKey: '', message: '동기화 후 서버 DATA 무결성을 확인하고 있습니다.' });
    result.integrityAfter = await remoteIntegrity({ allowPluginOnly });
    result.finishedAt = Date.now();
    result.ok = result.failures.length === 0 && result.conflicts.length === 0;
    progress.failureCount = result.failures.length;
    progress.conflictCount = result.conflicts.length;
    progress.uploaded = result.uploaded;
    progress.restored = result.restored;
    progress.matched = result.matched;
    progress.removedByTombstone = result.removedByTombstone;
    report(result.ok ? 'space_complete' : 'space_incomplete', {
      currentAction: result.ok ? '공간 동기화 완료' : '동기화 확인 필요', currentKey: '',
      message: result.ok ? `${space} 저장소 동기화를 완료했습니다.` : `충돌 ${result.conflicts.length}건 · 실패 ${result.failures.length}건`
    });
    state.management.lastResult = result;
    if (!result.ok) {
      const error = new Error(`memory_suite_sync_incomplete:conflicts=${result.conflicts.length},failures=${result.failures.length}`);
      error.code = 'MEMORY_SUITE_SYNC_INCOMPLETE';
      error.result = result;
      throw error;
    }
    return result;
  };

  const verifyServerPreservation = async (legacy = state.legacy.plugin) => {
    if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
    const config = await readConfig(true);
    if (config.mode === MODE_PLUGIN_ONLY) {
      const error = new Error('plugin_only_mode_has_no_verified_server_copy');
      error.code = 'MEMORY_SUITE_SERVER_COPY_NOT_ACTIVE';
      throw error;
    }
    if (config.mode === MODE_MIRROR) {
      await synchronizeLegacyWithServer(legacy, 'plugin', { allowOverwrite: true, restoreMissingLocal: true });
    }
    const integrity = await remoteIntegrity();
    const keys = await listRoutedLegacyKeys(legacy, 'plugin', false);
    const result = { schema: 'memory-suite.server-preservation.v1', namespace, mode: config.mode, integrity, checked: 0, exact: 0, covered: 0, unsafe: [] };
    for (const key of keys) {
      const localValue = await legacyRead(legacy, key);
      if (isNullishStorageValue(localValue)) continue;
      const remote = await remoteGet('plugin', key);
      result.checked += 1;
      if (config.mode === MODE_MIRROR) {
        if (remote.exists === true && jsonComparable(remote.value) === jsonComparable(localValue)) result.exact += 1;
        else result.unsafe.push({ key, reason: remote.tombstone === true ? 'server_tombstone' : (remote.exists === true ? 'value_mismatch' : 'server_missing') });
      } else {
        if (remote.exists === true || remote.tombstone === true) result.covered += 1;
        else result.unsafe.push({ key, reason: 'server_has_no_record_or_tombstone' });
      }
    }
    result.ok = integrity.ok === true && result.unsafe.length === 0;
    if (!result.ok) {
      const error = new Error(`memory_suite_server_preservation_verification_failed:${result.unsafe.length}`);
      error.code = 'MEMORY_SUITE_SERVER_PRESERVATION_FAILED';
      error.result = result;
      throw error;
    }
    state.management.lastResult = result;
    return result;
  };

  const restoreServerSpaceToLegacy = async (legacy, space = 'plugin', options = {}) => {
    if (!legacy) throw new Error(`memory_suite_${space}_storage_unavailable`);
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const progress = {
      schema: 'memory-suite.restore-progress.v1', namespace, space: normalizedSpace,
      phase: 'integrity_before', currentAction: '서버 무결성 확인', currentKey: '', totalItems: 0, processedItems: 0,
      processedBytes: 0, transferredBytes: 0, restored: 0, removed: 0, verified: 0, failureCount: 0,
      startedAt: Date.now(), lastActivityAt: Date.now()
    };
    const report = (phase, patch = {}) => {
      Object.assign(progress, patch || {}, { phase, lastActivityAt: Date.now() });
      try { onProgress?.({ ...progress }); } catch (_) {}
    };
    report('integrity_before', { message: '서버 DATA 무결성을 확인하고 있습니다.' });
    const integrity = await remoteIntegrity({ allowPluginOnly: options.allowPluginOnly === true });
    report('inventory', { currentAction: '복구 대상 조사', message: '서버 DATA와 pluginStorage를 비교하고 있습니다.' });
    const listing = await remoteKeys(normalizedSpace, '', { allowPluginOnly: options.allowPluginOnly === true });
    const serverKeys = (listing.keys || []).map(String).filter(key => matchesRoute(normalizedSpace, key)).sort();
    const tombstones = (listing.tombstones || []).map(String).filter(key => matchesRoute(normalizedSpace, key)).sort();
    const recordBytes = new Map((Array.isArray(listing.records) ? listing.records : []).map(row => [String(row?.key || ''), Math.max(0, Number(row?.valueBytes || 0) || 0)]));
    const localKeys = await listRoutedLegacyKeys(legacy, normalizedSpace, false);
    const represented = new Set([...serverKeys, ...tombstones]);
    const untracked = localKeys.filter(key => !represented.has(key));
    const pruneKeys = options.pruneUntracked === true ? untracked.slice().sort() : [];
    progress.totalItems = pruneKeys.length + serverKeys.length + tombstones.length;
    report('inventory_complete', { currentAction: '복구 대상 조사 완료', message: `복구·검증 대상 ${progress.totalItems.toLocaleString()}개를 확인했습니다.` });
    const result = {
      schema: 'memory-suite.restore-to-legacy-storage.v1', namespace, space: normalizedSpace,
      restored: 0, removed: 0, verified: 0, pruned: 0, failures: [],
      untrackedLocalKeys: untracked.slice(), integrity,
      totalItems: progress.totalItems, processedItems: 0, processedBytes: 0, transferredBytes: 0
    };
    const originalValues = new Map();
    const mutationOrder = [];
    const captureOriginal = async key => {
      if (!originalValues.has(key)) originalValues.set(key, await legacyRead(legacy, key));
      if (!mutationOrder.includes(key)) mutationOrder.push(key);
    };

    for (let offset = 0; offset < serverKeys.length; offset += 256) {
      const batchKeys = serverKeys.slice(offset, offset + 256);
      let values = {};
      try { values = (await remoteGetMany(normalizedSpace, batchKeys, { allowPluginOnly: options.allowPluginOnly === true }))?.values || {}; }
      catch (_) {}
      for (const key of batchKeys) {
        const bytes = Math.max(0, Number(recordBytes.get(key) || 0) || 0);
        let action = '서버 → pluginStorage 복구';
        try {
          report('restore_values', { currentAction: action, currentKey: key });
          const remote = values[key] || await remoteGet(normalizedSpace, key, { allowPluginOnly: options.allowPluginOnly === true });
          if (remote.exists !== true) throw new Error('server_key_disappeared_during_restore');
          await captureOriginal(key);
          const ok = await legacyWriteVerified(legacy, key, remote.value);
          if (!ok) throw new Error('legacy_restore_write_failed');
          result.restored += 1; result.verified += 1; result.transferredBytes += bytes || storageValueBytes(remote.value);
          action = '복구·readback 검증';
        } catch (error) {
          result.failures.push({ key, error: compact(error?.message || error, 220) }); action = '복구 실패';
        } finally {
          result.processedItems += 1; result.processedBytes += bytes;
          progress.processedItems = result.processedItems; progress.processedBytes = result.processedBytes; progress.transferredBytes = result.transferredBytes;
          progress.restored = result.restored; progress.verified = result.verified; progress.failureCount = result.failures.length;
          report('restore_values', { currentAction: action, currentKey: key });
        }
      }
    }
    for (const key of tombstones) {
      let action = '서버 tombstone 반영';
      try {
        report('restore_tombstones', { currentAction: action, currentKey: key });
        const current = await legacyRead(legacy, key);
        if (!isNullishStorageValue(current)) {
          await captureOriginal(key);
          const ok = await legacyRemoveVerified(legacy, key);
          if (!ok) throw new Error('legacy_restore_tombstone_failed');
          result.removed += 1;
        }
        action = '삭제 상태 검증';
      } catch (error) {
        result.failures.push({ key, error: compact(error?.message || error, 220) }); action = 'tombstone 반영 실패';
      } finally {
        result.processedItems += 1; progress.processedItems = result.processedItems; progress.removed = result.removed; progress.failureCount = result.failures.length;
        report('restore_tombstones', { currentAction: action, currentKey: key });
      }
    }
    if (result.failures.length === 0 && options.pruneUntracked === true) {
      for (const key of pruneKeys) {
        let action = '추적되지 않은 로컬 값 정리';
        try {
          report('prune_local', { currentAction: action, currentKey: key });
          await captureOriginal(key);
          const ok = await legacyRemoveVerified(legacy, key);
          if (!ok) throw new Error('untracked_local_prune_failed');
          result.pruned += 1;
          action = '정리 완료';
        } catch (error) {
          result.failures.push({ key, error: compact(error?.message || error, 220) }); action = '정리 실패';
        } finally {
          result.processedItems += 1; progress.processedItems = result.processedItems; progress.failureCount = result.failures.length;
          report('prune_local', { currentAction: action, currentKey: key });
        }
      }
      if (result.failures.length === 0) result.untrackedLocalKeys = [];
    }
    const restoreWillFail = result.failures.length > 0
      || (options.requireFullCoverage === true && result.untrackedLocalKeys.length > 0);
    if (restoreWillFail && mutationOrder.length) {
      const rollbackFailures = [];
      for (const key of mutationOrder.slice().reverse()) {
        try {
          const original = originalValues.get(key);
          const ok = isNullishStorageValue(original)
            ? await legacyRemoveVerified(legacy, key)
            : await legacyWriteVerified(legacy, key, original);
          if (!ok) throw new Error('legacy_restore_rollback_readback_failed');
        } catch (error) {
          rollbackFailures.push({ key, error: compact(error?.message || error, 220) });
        }
      }
      result.rollback = { attempted: mutationOrder.length, failures: rollbackFailures, ok: rollbackFailures.length === 0 };
    }
    result.ok = result.failures.length === 0 && (options.requireFullCoverage !== true || result.untrackedLocalKeys.length === 0);
    report(result.ok ? 'space_complete' : 'space_incomplete', {
      currentAction: result.ok ? '복구 완료' : '복구 확인 필요', currentKey: '',
      message: result.ok ? `${normalizedSpace} 저장소 복구를 완료했습니다.` : `실패 ${result.failures.length}건 · 추적되지 않은 값 ${result.untrackedLocalKeys.length}건`
    });
    if (!result.ok) {
      const error = new Error(`memory_suite_legacy_restore_incomplete:space=${normalizedSpace},failures=${result.failures.length},untracked=${result.untrackedLocalKeys.length}`);
      error.code = 'MEMORY_SUITE_RESTORE_INCOMPLETE';
      error.result = result;
      throw error;
    }
    state.management.lastResult = result;
    return result;
  };

  const restoreServerToPluginStorage = async (options = {}) => await restoreServerSpaceToLegacy(
    options.legacy || state.legacy.plugin,
    'plugin',
    options
  );

  const verifyScopedLegacyPreservation = async (legacy, space, keys = []) => {
    const normalizedSpace = String(space || 'plugin') === 'local' ? 'local' : 'plugin';
    const requested = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(key => matchesRoute(normalizedSpace, key)))];
    const result = { schema: 'memory-suite.scoped-legacy-preservation.v1', namespace, space: normalizedSpace, requested: requested.length, exact: 0, tombstones: 0, failures: [] };
    if (!requested.length) return { ...result, ok: true };
    const values = (await remoteGetMany(normalizedSpace, requested, { allowPluginOnly: true }))?.values || {};
    for (const key of requested) {
      try {
        const remote = values[key] || await remoteGet(normalizedSpace, key, { allowPluginOnly: true });
        const local = await legacyRead(legacy, key);
        if (remote.tombstone === true || remote.exists === false) {
          if (!isNullishStorageValue(local)) throw new Error('local_value_survives_server_tombstone');
          result.tombstones += 1;
        } else if (remote.exists === true && jsonComparable(local) === jsonComparable(remote.value)) {
          result.exact += 1;
        } else {
          throw new Error(remote.exists === true ? 'local_value_mismatch' : 'server_record_missing');
        }
      } catch (error) { result.failures.push({ key, error: compact(error?.message || error, 220) }); }
    }
    result.ok = result.failures.length === 0;
    if (!result.ok) {
      const error = new Error(`memory_suite_scoped_legacy_preservation_failed:${normalizedSpace}:${result.failures.length}`);
      error.code = 'MEMORY_SUITE_SCOPE_PRESERVATION_FAILED';
      error.result = result;
      throw error;
    }
    return result;
  };

  const setModeSafely = async (requestedMode, operationOptions = {}) => {
    const target = requireOperationalMode(requestedMode);
    const current = await readConfig(true);
    if (target === current.mode) return { changed: false, from: current.mode, to: target, modeLabel: modeLabel(target) };
    const legacy = state.legacy.plugin;
    if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
    const onProgress = typeof operationOptions.onProgress === 'function' ? operationOptions.onProgress : null;
    try {
      if (current.mode === MODE_PLUGIN_ONLY && (target === MODE_MIRROR || target === MODE_SERVER_ONLY)) {
        const synchronized = await synchronizeAllLegacy({
          allowPluginOnly: true,
          allowOverwrite: false,
          restoreMissingLocal: target === MODE_MIRROR,
          onProgress
        });
        if (!synchronized.ok) throw new Error(`memory_suite_mode_seed_sync_failed:${synchronized.failures.length}`);
        // The first pass proves the existing server contains no conflicting data.
        // Only after that proof do new writes temporarily mirror to both stores while
        // a final settle pass closes the race between initial inventory and mode commit.
        state.transientMode = MODE_MIRROR;
        const settled = await synchronizeAllLegacy({
          allowPluginOnly: true,
          allowOverwrite: true,
          restoreMissingLocal: target === MODE_MIRROR,
          onProgress
        });
        if (!settled.ok) throw new Error(`memory_suite_mode_settle_sync_failed:${settled.failures.length}`);
        const integrity = await remoteIntegrity({ allowPluginOnly: true });
        if (integrity?.ok !== true) throw new Error(`memory_suite_mode_integrity_failed:${integrity?.result || 'unknown'}`);
      } else if (current.mode === MODE_MIRROR && target === MODE_SERVER_ONLY) {
        const synchronized = await synchronizeAllLegacy({ allowOverwrite: true, restoreMissingLocal: true, onProgress });
        if (!synchronized.ok) throw new Error(`memory_suite_mode_final_sync_failed:${synchronized.failures.length}`);
        const integrity = await remoteIntegrity();
        if (integrity?.ok !== true) throw new Error(`memory_suite_mode_integrity_failed:${integrity?.result || 'unknown'}`);
      } else if (current.mode === MODE_SERVER_ONLY && (target === MODE_MIRROR || target === MODE_PLUGIN_ONLY)) {
        const restored = await restoreAllLegacyFromServer({ pruneUntracked: true, requireFullCoverage: true, onProgress });
        if (!restored.ok) throw new Error(`memory_suite_mode_restore_failed:${restored.failures.length}`);
      }
      const config = await persistMode(target);
      return { changed: true, from: current.mode, to: target, modeLabel: modeLabel(target), config };
    } catch (error) {
      state.transientMode = '';
      state.config.at = 0;
      throw error;
    }
  };

  const synchronizeAllLegacy = async (options = {}) => {
    const result = { schema: 'memory-suite.sync-all.v1', namespace, plugin: null, local: null, uploaded: 0, restored: 0, matched: 0, failures: [], totalItems: 0, processedItems: 0, processedBytes: 0, transferredBytes: 0 };
    const forward = progress => { try { options.onProgress?.(progress); } catch (_) {} };
    if (state.legacy.plugin) {
      result.plugin = await synchronizeLegacyWithServer(state.legacy.plugin, 'plugin', {
        allowPluginOnly: options.allowPluginOnly === true,
        allowOverwrite: options.allowOverwrite !== false,
        restoreMissingLocal: options.restoreMissingLocal !== false,
        onProgress: forward
      });
      result.uploaded += Number(result.plugin?.uploaded || 0);
      result.restored += Number(result.plugin?.restored || 0);
      result.matched += Number(result.plugin?.matched || 0);
      result.totalItems += Number(result.plugin?.totalItems || 0);
      result.processedItems += Number(result.plugin?.processedItems || 0);
      result.processedBytes += Number(result.plugin?.processedBytes || 0);
      result.transferredBytes += Number(result.plugin?.transferredBytes || 0);
      result.failures.push(...(Array.isArray(result.plugin?.failures) ? result.plugin.failures.map(row => ({ space: 'plugin', ...row })) : []));
    }
    if (state.legacy.local && typeof state.legacy.local?.keys === 'function') {
      result.local = await synchronizeLegacyWithServer(state.legacy.local, 'local', {
        allowPluginOnly: options.allowPluginOnly === true,
        allowOverwrite: options.allowOverwrite !== false,
        restoreMissingLocal: options.restoreMissingLocal !== false,
        onProgress: forward
      });
      result.uploaded += Number(result.local?.uploaded || 0);
      result.restored += Number(result.local?.restored || 0);
      result.matched += Number(result.local?.matched || 0);
      result.totalItems += Number(result.local?.totalItems || 0);
      result.processedItems += Number(result.local?.processedItems || 0);
      result.processedBytes += Number(result.local?.processedBytes || 0);
      result.transferredBytes += Number(result.local?.transferredBytes || 0);
      result.failures.push(...(Array.isArray(result.local?.failures) ? result.local.failures.map(row => ({ space: 'local', ...row })) : []));
    }
    result.ok = result.failures.length === 0;
    return result;
  };

  const restoreAllLegacyFromServer = async (options = {}) => {
    const result = { schema: 'memory-suite.restore-all.v1', namespace, plugin: null, local: null, restored: 0, removed: 0, verified: 0, failures: [], totalItems: 0, processedItems: 0, processedBytes: 0, transferredBytes: 0 };
    const forward = progress => { try { options.onProgress?.(progress); } catch (_) {} };
    if (state.legacy.plugin) {
      result.plugin = await restoreServerSpaceToLegacy(state.legacy.plugin, 'plugin', {
        pruneUntracked: options.pruneUntracked === true,
        requireFullCoverage: options.requireFullCoverage === true,
        allowPluginOnly: options.allowPluginOnly === true,
        onProgress: forward
      });
      result.restored += Number(result.plugin?.restored || 0);
      result.removed += Number(result.plugin?.removed || 0);
      result.verified += Number(result.plugin?.verified || 0);
      result.totalItems += Number(result.plugin?.totalItems || 0);
      result.processedItems += Number(result.plugin?.processedItems || 0);
      result.processedBytes += Number(result.plugin?.processedBytes || 0);
      result.transferredBytes += Number(result.plugin?.transferredBytes || 0);
      result.failures.push(...(Array.isArray(result.plugin?.failures) ? result.plugin.failures.map(row => ({ space: 'plugin', ...row })) : []));
    }
    if (state.legacy.local && typeof state.legacy.local?.getItem === 'function') {
      result.local = await restoreServerSpaceToLegacy(state.legacy.local, 'local', {
        pruneUntracked: options.pruneUntracked === true,
        requireFullCoverage: options.requireFullCoverage === true,
        allowPluginOnly: options.allowPluginOnly === true,
        onProgress: forward
      });
      result.restored += Number(result.local?.restored || 0);
      result.removed += Number(result.local?.removed || 0);
      result.verified += Number(result.local?.verified || 0);
      result.totalItems += Number(result.local?.totalItems || 0);
      result.processedItems += Number(result.local?.processedItems || 0);
      result.processedBytes += Number(result.local?.processedBytes || 0);
      result.transferredBytes += Number(result.local?.transferredBytes || 0);
      result.failures.push(...(Array.isArray(result.local?.failures) ? result.local.failures.map(row => ({ space: 'local', ...row })) : []));
    }
    result.ok = result.failures.length === 0;
    return result;
  };

  const configureConnection = async (settings, operationOptions = {}) => {
    const requested = settings && typeof settings === 'object' ? settings : {};
    const current = await readConfig(true);
    const targetMode = normalizeMode(requested.mode ?? current.mode);
    const targetUrl = normalizeServerUrl(requested.url ?? current.url);
    const original = { ...current };
    const onProgress = typeof operationOptions.onProgress === 'function' ? operationOptions.onProgress : null;
    const report = (phase, patch = {}) => { try { onProgress?.({ schema: 'memory-suite.connection-progress.v1', namespace, space: String(patch.space || 'plugin'), phase, ...patch, lastActivityAt: Date.now() }); } catch (_) {} };
    let connectionTest = null;
    let restoredBeforeUrlChange = null;
    let seedSync = null;
    try {
      report('configuration_start', { currentAction: '설정 변경 준비', message: `${modeLabel(original.mode)} → ${modeLabel(targetMode)}` });
      if (targetMode === MODE_PLUGIN_ONLY) {
        const transition = current.mode === MODE_PLUGIN_ONLY
          ? { changed: false, from: current.mode, to: targetMode }
          : await setModeSafely(MODE_PLUGIN_ONLY, { onProgress });
        if (targetUrl !== original.url) await persistServerUrl(targetUrl);
        const config = await readConfig(true);
        report('configuration_complete', { currentAction: '설정 적용 완료', message: `${modeLabel(config.mode)}로 적용되었습니다.` });
        return { ok: true, from: original, to: config, transition, connectionTest: null, restoredBeforeUrlChange: null, seedSync: null };
      }

      report('connection_test', { currentAction: '서버 연결 확인', message: `${targetUrl} 연결을 확인하고 있습니다.` });
      connectionTest = await testConnection(targetUrl);
      if (!connectionTest.ok) {
        const error = new Error(`memory_suite_connection_test_failed:${connectionTest.error || 'unknown'}`);
        error.code = 'MEMORY_SUITE_CONNECTION_TEST_FAILED';
        error.connectionTest = connectionTest;
        throw error;
      }
      report('connection_ready', { currentAction: '서버 연결 확인 완료', message: `Librarian System ${connectionTest.serverVersion || '-'} 연결됨` });

      if (targetUrl !== original.url && original.mode === MODE_SERVER_ONLY) {
        report('restore_before_url_change', { currentAction: '기존 서버 데이터 로컬 복구', message: '서버 주소 변경 전에 현재 서버 DATA를 pluginStorage로 안전하게 복구합니다.' });
        restoredBeforeUrlChange = await restoreAllLegacyFromServer({ pruneUntracked: true, requireFullCoverage: true, onProgress });
        if (!restoredBeforeUrlChange.ok) throw new Error(`memory_suite_restore_before_url_change_failed:${restoredBeforeUrlChange.failures.length}`);
      }

      if (targetUrl !== original.url) await persistServerUrl(targetUrl);
      resetBootstrapCache();

      if (targetUrl !== original.url) {
        report('seed_new_server', { currentAction: '새 서버 기준선 생성', message: '새 서버에 기존 데이터를 안전하게 복사하고 있습니다.' });
        seedSync = await synchronizeAllLegacy({
          allowPluginOnly: true,
          allowOverwrite: false,
          restoreMissingLocal: targetMode === MODE_MIRROR,
          onProgress
        });
        if (!seedSync.ok) throw new Error(`memory_suite_new_server_seed_failed:${seedSync.failures.length}`);
      }

      const refreshed = await readConfig(true);
      report('mode_transition', { currentAction: '저장 모드 전환 준비', message: '서버 기준선 검증이 끝나면 저장 모드를 확정합니다.' });
      const transition = refreshed.mode === targetMode
        ? { changed: false, from: refreshed.mode, to: targetMode }
        : await setModeSafely(targetMode, { onProgress });
      const config = await readConfig(true);
      await bootstrap(true, true);
      report('configuration_complete', { currentAction: '설정 적용 완료', message: `${modeLabel(config.mode)} · ${config.url}` });
      return { ok: true, from: original, to: config, transition, connectionTest, restoredBeforeUrlChange, seedSync };
    } catch (error) {
      state.transientMode = '';
      state.config.at = 0;
      report('configuration_rollback', { currentAction: '이전 설정 복구', message: compact(error?.message || error, 260) });
      try {
        const now = await readConfig(true).catch(() => null);
        if (now?.url !== original.url) await persistServerUrl(original.url);
        const afterUrl = await readConfig(true).catch(() => null);
        if (afterUrl && afterUrl.mode !== original.mode) await setModeSafely(original.mode, { onProgress });
      } catch (_) {}
      throw error;
    }
  };

  const createBackgroundJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'createBackgroundJob'}, () => createBackgroundJobImpl(...args));
  const createBackgroundJobImpl = async (kind, target = {}) => {
    const currentConfig = await readConfig(true);
    const requestedMode = target.requestedMode ? normalizeMode(target.requestedMode) : (target.mode ? normalizeMode(target.mode) : currentConfig.mode);
    const existing = state.syncJob.current;
    if (existing && !syncJobTerminal(existing.status)) {
      const sameTarget = existing.kind === kind
        && String(existing.targetMode || '') === String(target.mode || '')
        && String(existing.targetUrl || '') === String(target.url || '');
      if (sameTarget) return cloneSyncJob(existing);
      const error = new Error(`memory_suite_background_job_busy:${existing.kind}:${existing.status}`);
      error.code = 'MEMORY_SUITE_SYNC_JOB_BUSY';
      error.job = cloneSyncJob(existing);
      throw error;
    }
    let random = '';
    try { random = globalThis?.crypto?.randomUUID?.() || ''; } catch (_) {}
    if (!random) random = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      schema: SYNC_JOB_SCHEMA,
      namespace,
      pluginId,
      pluginVersion,
      jobId: `${namespace}_${kind}_${random}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 220),
      kind,
      status: 'queued',
      phase: 'queued',
      sourceMode: currentConfig.mode,
      sourceUrl: currentConfig.url,
      requestedMode, effectiveMode: currentConfig.mode,
      targetMode: requestedMode,
      targetUrl: target.url ? normalizeServerUrl(target.url) : currentConfig.url,
      totalItems: 0,
      processedItems: 0,
      processedBytes: 0,
      transferredBytes: 0,
      uploaded: 0,
      restored: 0,
      matched: 0,
      removedByTombstone: 0,
      failures: 0,
      conflicts: 0,
      retryCount: 0,
      nextRetryAt: 0,
      currentSpace: '',
      currentKey: '',
      currentAction: '',
      message: '',
      spaces: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
      finishedAt: 0,
      result: null,
      error: ''
    };
    state.syncJob.current = job;
    state.syncJob.loaded = true;
    notifySyncJob();
    await persistSyncJobNow();
    return cloneSyncJob(job);
  };

  const completeBackgroundJob = async (result = null) => {
    updateSyncJob({
      requestedMode: result?.requestedMode || state.syncJob.current?.requestedMode || state.syncJob.current?.targetMode || '',
      effectiveMode: result?.effectiveMode || state.syncJob.current?.sourceMode || '',
      status: 'completed', phase: 'completed', currentAction: '완료', currentKey: '',
      message: '작업이 안전하게 완료되었습니다.', result: result ? cloneSyncJob(result) : null,
      error: '', nextRetryAt: 0, finishedAt: Date.now()
    }, { persist: 'immediate' });
    return getSyncJob();
  };

  const failBackgroundJob = async error => {
    updateSyncJob({
      requestedMode: error?.requestedMode || state.syncJob.current?.requestedMode || state.syncJob.current?.targetMode || '',
      effectiveMode: error?.effectiveMode || state.syncJob.current?.sourceMode || '',
      status: 'failed', phase: 'failed', currentAction: '작업 중단', currentKey: '',
      message: '작업을 완료하지 못했습니다.', error: compact(error?.message || error, 700),
      nextRetryAt: 0, finishedAt: Date.now()
    }, { persist: 'immediate' });
    return getSyncJob();
  };

  const executeBackgroundJob = (...args) => withOwnerOperation({kind:'job_execution',operation:'executeBackgroundJob'}, () => executeBackgroundJobImpl(...args));
  const executeBackgroundJobImpl = async () => {
    const job = state.syncJob.current;
    if (!job || syncJobTerminal(job.status)) return getSyncJob();
    if (state.syncJob.promise) return state.syncJob.promise;
    if (state.syncJob.retryTimer) { clearLifecycleTimeout(state.syncJob.retryTimer); state.syncJob.retryTimer = null; }
    updateSyncJob({ status: 'running', phase: job.phase === 'resume_pending' ? 'resuming' : (job.phase || 'starting'), nextRetryAt: 0, error: '' });
    const runner = (async () => {
      try {
        let result;
        if (job.kind === 'connection_config') {
          result = await configureConnection({ mode: job.requestedMode || job.targetMode, url: job.targetUrl }, { onProgress: applySyncProgressToJob });
        } else if (job.kind === 'manual_sync') {
          result = await synchronizeAllLegacy({ allowOverwrite: true, restoreMissingLocal: true, onProgress: applySyncProgressToJob });
          if (!result.ok) throw new Error(`sync_failures:${result.failures.length}`);
        } else if (job.kind === 'server_restore') {
          result = await restoreAllLegacyFromServer({ pruneUntracked: false, requireFullCoverage: false, onProgress: applySyncProgressToJob });
          if (!result.ok) throw new Error(`restore_failures:${result.failures.length}`);
        } else {
          throw new Error(`memory_suite_unknown_background_job:${job.kind}`);
        }
        await completeBackgroundJob(result);
        return result;
      } catch (error) {
        if (retryableSyncError(error) && Number(state.syncJob.current?.retryCount || 0) < SYNC_JOB_MAX_RETRIES) {
          const retryCount = Number(state.syncJob.current?.retryCount || 0) + 1;
          const delay = SYNC_JOB_RETRY_DELAYS_MS[Math.min(SYNC_JOB_RETRY_DELAYS_MS.length - 1, retryCount - 1)];
          updateSyncJob({
            status: 'paused', phase: 'waiting_for_server', currentAction: '서버 재연결 대기',
            message: `서버 연결이 일시적으로 끊겼습니다. ${Math.ceil(delay / 1000)}초 후 이어서 확인합니다.`,
            error: compact(error?.message || error, 420), retryCount, nextRetryAt: Date.now() + delay
          }, { persist: 'immediate' });
          state.syncJob.retryTimer = scheduleLifecycleTimeout(() => {
            state.syncJob.retryTimer = null;
            void executeBackgroundJob().catch(error => reportStorageFailure('sync.job.retry.admission', error));
          }, delay);
          try { state.syncJob.retryTimer?.unref?.(); } catch (_) {}
          return null;
        }
        await failBackgroundJob(error);
        throw error;
      }
    })();
    state.syncJob.promise = runner.finally(() => { state.syncJob.promise = null; });
    return state.syncJob.promise;
  };

  const startConnectionConfigurationJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'startConnectionConfigurationJob'}, () => startConnectionConfigurationJobImpl(...args));
  const startConnectionConfigurationJobImpl = async settings => {
    const requested = settings && typeof settings === 'object' ? settings : {};
    const current = await readConfig(true);
    const target = {
      mode: normalizeMode(requested.mode ?? current.mode),
      url: normalizeServerUrl(requested.url ?? current.url)
    };
    const job = await createBackgroundJob('connection_config', target);
    void executeBackgroundJob().catch(() => {});
    return job;
  };

  const startSynchronizationJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'startSynchronizationJob'}, () => startSynchronizationJobImpl(...args));
  const startSynchronizationJobImpl = async () => {
    const current = await readConfig(true);
    if (current.mode !== MODE_MIRROR) throw new Error('memory_suite_manual_sync_requires_mirror_mode');
    const job = await createBackgroundJob('manual_sync', { mode: current.mode, url: current.url });
    void executeBackgroundJob().catch(() => {});
    return job;
  };

  const startRestoreJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'startRestoreJob'}, () => startRestoreJobImpl(...args));
  const startRestoreJobImpl = async () => {
    const current = await readConfig(true);
    if (current.mode !== MODE_SERVER_ONLY) throw new Error('memory_suite_restore_requires_server_only_mode');
    const job = await createBackgroundJob('server_restore', { mode: current.mode, url: current.url });
    void executeBackgroundJob().catch(() => {});
    return job;
  };

  const resumePendingSyncJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'resumePendingSyncJob'}, () => resumePendingSyncJobImpl(...args));
  const resumePendingSyncJobImpl = async () => {
    await loadPersistedSyncJob();
    const job = state.syncJob.current;
    if (!job || syncJobTerminal(job.status)) return cloneSyncJob(job);
    if (!state.legacy.plugin) return cloneSyncJob(job);
    void executeBackgroundJob().catch(() => {});
    return cloneSyncJob(job);
  };

  const waitForSyncJob = async (jobId = '', timeoutMs = 15 * 60 * 1000) => {
    const wanted = String(jobId || state.syncJob.current?.jobId || '');
    if (!wanted) return null;
    const current = state.syncJob.current;
    if (current?.jobId === wanted && syncJobTerminal(current.status)) return cloneSyncJob(current);
    return await new Promise((resolve, reject) => {
      let timer = null;
      const unsubscribe = subscribeSyncJob(job => {
        if (!job || job.jobId !== wanted || !syncJobTerminal(job.status)) return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(job);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`memory_suite_sync_job_wait_timeout:${wanted}`));
      }, Math.max(1000, Number(timeoutMs || 0) || 15 * 60 * 1000));
    });
  };

  const getConnectionSettings = async (options = {}) => {
    const config = await readConfig(options.force === true);
    const result = {
      schema: 'memory-suite.connection-settings.v1',
      namespace,
      pluginId,
      pluginVersion,
      mode: config.mode,
      modeLabel: modeLabel(config.mode),
      url: config.url,
      status: { ...state.status },
      migration: { plugin: { ...state.migration.plugin }, local: { ...state.migration.local } },
      syncJob: getSyncJob(),
      diagnostics: {
        ready: !!state.diagnostics.value,
        reachable: state.diagnostics.value?.reachable ?? null,
        updatedAt: Number(state.diagnostics.at || 0),
        eventCount: Array.isArray(state.diagnostics.value?.events) ? state.diagnostics.value.events.length : 0,
        error: String(state.diagnostics.value?.error || '')
      }
    };
    if (options.test === true) result.connection = await testConnection(config.url);
    return result;
  };

  const prepareServerScopeDeletion = async (options = {}) => {
    const pluginLegacy = state.legacy.plugin;
    if (!pluginLegacy) throw new Error('memory_suite_pluginstorage_unavailable');
    const localLegacy = state.legacy.local;
    const pluginKeys = [...new Set((Array.isArray(options.pluginKeys) ? options.pluginKeys : []).map(String).filter(key => matchesRoute('plugin', key)))];
    const localKeys = [...new Set((Array.isArray(options.localKeys) ? options.localKeys : []).map(String).filter(key => matchesRoute('local', key)))];
    const current = await readConfig(true);
    const proofNeedsTransientServer = current.mode === MODE_PLUGIN_ONLY;
    if (proofNeedsTransientServer) state.transientMode = MODE_MIRROR;
    try {
    let beforeIntegrity;
    beforeIntegrity = await remoteIntegrity();
    let pluginRestore = null;
    let localRestore = null;
    let pluginSync = null;
    let localSync = null;

    if (current.mode === MODE_MIRROR) {
      pluginSync = await synchronizeLegacyWithServer(pluginLegacy, 'plugin', { allowOverwrite: true, restoreMissingLocal: true });
      if (localLegacy && typeof localLegacy?.getItem === 'function') {
        localSync = await synchronizeLegacyWithServer(localLegacy, 'local', { allowOverwrite: true, restoreMissingLocal: true });
      }
    } else if (current.mode === MODE_SERVER_ONLY) {
      pluginRestore = await restoreServerSpaceToLegacy(pluginLegacy, 'plugin', { pruneUntracked: false, requireFullCoverage: false });
      if (localLegacy && typeof localLegacy?.getItem === 'function') {
        localRestore = await restoreServerSpaceToLegacy(localLegacy, 'local', { pruneUntracked: false, requireFullCoverage: false });
      } else if (localKeys.length) {
        const error = new Error('memory_suite_local_storage_required_for_scope_preservation');
        error.code = 'MEMORY_SUITE_LOCAL_STORAGE_UNAVAILABLE';
        throw error;
      }
    }

    const pluginProof = await verifyScopedLegacyPreservation(pluginLegacy, 'plugin', pluginKeys);
    const localProof = localKeys.length
      ? await verifyScopedLegacyPreservation(localLegacy, 'local', localKeys)
      : { schema: 'memory-suite.scoped-legacy-preservation.v1', namespace, space: 'local', requested: 0, exact: 0, tombstones: 0, failures: [], ok: true };

    let modeChanged = false;
    if (proofNeedsTransientServer) state.transientMode = '';
    if (current.mode !== MODE_PLUGIN_ONLY) {
      await persistMode(MODE_PLUGIN_ONLY);
      modeChanged = true;
    }
    const verifiedMode = await readConfig(true);
    if (verifiedMode.mode !== MODE_PLUGIN_ONLY) throw new Error(`memory_suite_scope_delete_mode_transition_failed:${verifiedMode.mode}`);
    const afterIntegrity = await remoteIntegrity({ allowPluginOnly: true });
    const receipt = {
      schema: 'memory-suite.server-scope-delete-owner-receipt.v1',
      namespace, pluginId, pluginVersion,
      scopeId: String(options.scopeId || '').slice(0, 320),
      scopeKey: String(options.scopeKey || '').slice(0, 700),
      modeBefore: current.mode,
      modeAfter: MODE_PLUGIN_ONLY,
      modeChanged,
      verified: pluginProof.ok === true && localProof.ok === true && afterIntegrity.ok === true,
      pluginKeys: pluginKeys.length,
      localKeys: localKeys.length,
      pluginProof,
      localProof,
      pluginRestore,
      localRestore,
      pluginSync,
      localSync,
      integrityBefore: beforeIntegrity,
      integrityAfter: afterIntegrity,
      checkedAt: Date.now()
    };
    if (receipt.verified !== true) {
      const error = new Error('memory_suite_scope_delete_owner_proof_incomplete');
      error.code = 'MEMORY_SUITE_SCOPE_DELETE_OWNER_PROOF_INCOMPLETE';
      error.receipt = receipt;
      throw error;
    }
    state.management.lastResult = receipt;
    setStatus('scope_delete_owner_ready', '', { mode: MODE_PLUGIN_ONLY, scopeId: receipt.scopeId });
    return receipt;
    } finally {
      if (proofNeedsTransientServer) state.transientMode = '';
    }
  };

  const deletePluginStorageAfterServerVerification = async () => {
    const legacy = state.legacy.plugin;
    if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
    const current = await readConfig(true);
    if (current.mode === MODE_PLUGIN_ONLY) {
      const error = new Error('pluginStorage 삭제는 미러 또는 서버 단독 모드에서만 사용할 수 있습니다.');
      error.code = 'MEMORY_SUITE_DELETE_REQUIRES_SERVER_MODE';
      throw error;
    }
    const preservation = await verifyServerPreservation(legacy);
    let modeChanged = false;
    if (current.mode === MODE_MIRROR) {
      await persistMode(MODE_SERVER_ONLY);
      modeChanged = true;
    }
    const allKeys = await listRoutedLegacyKeys(legacy, 'plugin', true);
    const logicalKeys = allKeys.filter(key => matchesRoute('plugin', key));
    const artifactKeys = allKeys.filter(key => !matchesRoute('plugin', key) && isOwnedChunkArtifact('plugin', key));
    const failures = [];
    let deleted = 0;
    for (const key of logicalKeys) {
      try {
        const ok = await legacyRemoveVerified(legacy, key);
        if (!ok) throw new Error('pluginstorage_delete_failed');
        deleted += 1;
      } catch (error) { failures.push({ key, error: compact(error?.message || error, 220) }); }
    }
    for (const key of artifactKeys) {
      try {
        const ok = await legacyRemoveVerified(legacy, key);
        if (ok) deleted += 1;
      } catch (error) { failures.push({ key, error: compact(error?.message || error, 220) }); }
    }
    const remaining = await listRoutedLegacyKeys(legacy, 'plugin', true).catch(() => []);
    if (remaining.length) failures.push({ key: '*', error: `pluginstorage_keys_remaining:${remaining.length}` });
    const result = { schema: 'memory-suite.pluginstorage-delete.v1', namespace, preservation, modeChanged, mode: MODE_SERVER_ONLY, deleted, logicalDeleted: logicalKeys.length, artifactDeleted: artifactKeys.length, remaining, failures, ok: failures.length === 0 };
    state.management.lastResult = result;
    if (!result.ok) {
      const error = new Error(`memory_suite_pluginstorage_delete_incomplete:${failures.length}`);
      error.code = 'MEMORY_SUITE_PLUGINSTORAGE_DELETE_INCOMPLETE';
      error.result = result;
      throw error;
    }
    setStatus('pluginstorage_deleted', '', { mode: MODE_SERVER_ONLY, deleted });
    return result;
  };

  const migrateAllLegacy = async (legacy, space) => {
    const target = state.migration[space] || state.migration.plugin;
    const startedAt = Date.now();
    target.state = 'running'; target.at = startedAt; target.reason = '';
    target.scanned = 0; target.migrated = 0; target.skipped = 0; target.failed = 0;
    const config = await readConfig();
    if (config.mode === MODE_PLUGIN_ONLY) {
      target.state = 'plugin_only';
      return { ...target };
    }
    if (typeof legacy?.keys !== 'function' || typeof legacy?.getItem !== 'function') {
      target.state = 'lazy_only'; target.reason = 'legacy_key_enumeration_unavailable'; return { ...target };
    }
    if (config.mode === MODE_MIRROR && space === 'plugin') {
      try {
        const synced = await synchronizeLegacyWithServer(legacy, space, { allowOverwrite: true, restoreMissingLocal: true });
        target.scanned = synced.localKeys; target.migrated = synced.uploaded; target.skipped = synced.matched + synced.restored; target.failed = synced.failures.length;
        target.state = synced.ok ? 'complete' : 'partial'; target.at = Date.now();
        return { ...target, durationMs: Date.now() - startedAt };
      } catch (error) {
        target.state = 'partial'; target.failed += 1; target.reason = compact(error?.message || error, 240); target.at = Date.now();
        return { ...target, durationMs: Date.now() - startedAt };
      }
    }
    const listed = await legacy.keys();
    const keysToInspect = [...new Set((Array.isArray(listed) ? listed : []).map(String).filter(key => matchesRoute(space, key)))];
    target.scanned = keysToInspect.length;
    let cursor = 0;
    const worker = async () => {
      while (cursor < keysToInspect.length) {
        const index = cursor; cursor += 1; const key = keysToInspect[index];
        try {
          const result = await migrateFromLegacy(space, key, async () => await legacy.getItem(key));
          if (result.state === 'migrated') target.migrated += 1; else target.skipped += 1;
        } catch (error) { target.failed += 1; target.reason = compact(error?.message || error, 240); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(migrationConcurrency, Math.max(1, keysToInspect.length)) }, () => worker()));
    target.state = target.failed > 0 ? 'partial' : 'complete'; target.at = Date.now();
    return { ...target, durationMs: Date.now() - startedAt };
  };

  const scheduleLegacyMigration = (legacy, space, force = false) => {
    const enabled = space === 'local' ? autoMigrateLocal : autoMigratePlugin;
    if (!enabled || !legacy || (typeof legacy !== 'object' && typeof legacy !== 'function')) return null;
    let record = migrationStateByLegacy.get(legacy);
    const timestamp = Date.now();
    if (!record) { record = { running: null, timer: null, completed: false, retryAt: 0, space }; migrationStateByLegacy.set(legacy, record); }
    if (record.running) return record.running;
    if (!force && record.completed) return null;
    if (!force && record.retryAt > timestamp) return null;
    if (record.timer) return null;
    record.timer = scheduleLifecycleTimeout(() => {
      record.timer = null;
      record.running = migrateAllLegacy(legacy, space)
        .then(result => {
          record.completed = result.state === 'complete' || result.state === 'plugin_only' || result.state === 'lazy_only';
          record.retryAt = result.state === 'partial' ? Date.now() + migrationRetryMs : 0;
          return result;
        })
        .catch(error => {
          record.completed = false; record.retryAt = Date.now() + migrationRetryMs;
          const target = state.migration[space] || state.migration.plugin;
          target.state = 'failed'; target.reason = compact(error?.message || error, 240); target.at = Date.now();
          warnOnce(`migration_${space}_${target.reason}`, error);
          return { ...target };
        })
        .finally(() => { record.running = null; });
    }, migrationDelayMs + (space === 'local' ? 900 : 0));
    try { record.timer?.unref?.(); } catch (_) {}
    return null;
  };

  const get = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null) => {
    if (!matchesRoute(space, key)) return typeof legacyGet === 'function' ? await legacyGet() : null;
    const config = await readConfig();
    if (config.mode === MODE_PLUGIN_ONLY) return typeof legacyGet === 'function' ? await legacyGet() : null;
    if (config.mode === MODE_MIRROR) {
      const localValue = typeof legacyGet === 'function' ? await legacyGet() : null;
      if (cachedBootstrapFailure(config.url)) {
        setStatus('server_unavailable_local_only', 'memory_suite_server_unavailable', { mode: MODE_MIRROR, key: compact(key, 160), space });
        return localValue;
      }
      if (!isNullishStorageValue(localValue)) {
        try {
          const remote = await remoteGet(space, key);
          if (remote.tombstone === true) {
            if (typeof legacyRemove === 'function') await legacyRemove();
            setStatus('server_tombstone_applied', '', { mode: MODE_MIRROR, key: compact(key, 160), space });
            return null;
          }
          void serializeMutation(space, key, async () => {
            try {
              if (remote.exists !== true || jsonComparable(remote.value) !== jsonComparable(localValue)) {
                await remoteMutate('set', space, key, localValue);
              }
              setStatus('synced', '', { mode: MODE_MIRROR, key: compact(key, 160), space });
            } catch (error) {
              setStatus('local_ahead', error?.message || error, { mode: MODE_MIRROR, key: compact(key, 160), space });
            }
          });
          return localValue;
        } catch (error) {
          setStatus('server_unavailable_local_only', error?.message || error, { mode: MODE_MIRROR, key: compact(key, 160), space });
          return localValue;
        }
      }
      try {
        const remote = await remoteGet(space, key);
        if (remote.exists === true) {
          if (typeof legacySet === 'function') await legacySet(remote.value);
          return remote.value;
        }
        if (remote.tombstone === true && typeof legacyRemove === 'function') await legacyRemove();
        return null;
      } catch (error) {
        setStatus('server_unavailable_local_only', error?.message || error, { mode: MODE_MIRROR, key: compact(key, 160), space });
        return null;
      }
    }
    const remote = await remoteGet(space, key);
    if (remote.exists === true) return remote.value;
    if (remote.tombstone === true) return null;
    const migrated = await migrateFromLegacy(space, key, legacyGet);
    return migrated.value;
  };

  const set = async (space, key, value, legacySet = null) => {
    if (!matchesRoute(space, key)) return typeof legacySet === 'function' ? await legacySet(value) : false;
    const config = await readConfig();
    if (config.mode === MODE_PLUGIN_ONLY) return typeof legacySet === 'function' ? await legacySet(value) : false;
    if (config.mode === MODE_MIRROR) {
      const localOk = typeof legacySet === 'function' ? await legacySet(value) : false;
      if (!localOk) return false;
      try {
        await serializeMutation(space, key, () => remoteMutate('set', space, key, value));
        setStatus('synced', '', { mode: MODE_MIRROR, key: compact(key, 160), space });
      } catch (error) {
        setStatus('local_ahead', error?.message || error, { mode: MODE_MIRROR, key: compact(key, 160), space });
        warnOnce(`mirror_server_write_${compact(key, 80)}`, error);
      }
      return true;
    }
    await serializeMutation(space, key, () => remoteMutate('set', space, key, value));
    return true;
  };

  const remove = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null) => {
    if (!matchesRoute(space, key)) return typeof legacyRemove === 'function' ? await legacyRemove() : false;
    const config = await readConfig();
    if (config.mode === MODE_PLUGIN_ONLY) return typeof legacyRemove === 'function' ? await legacyRemove() : false;
    if (config.mode === MODE_MIRROR) {
      const previousLocal = typeof legacyGet === 'function' ? await legacyGet() : null;
      try {
        await serializeMutation(space, key, () => remoteMutate('remove', space, key, null));
      } catch (error) {
        setStatus('mirror_delete_blocked', error?.message || error, { mode: MODE_MIRROR, key: compact(key, 160), space });
        return false;
      }
      const localOk = typeof legacyRemove === 'function' ? await legacyRemove() : false;
      if (!localOk) {
        if (!isNullishStorageValue(previousLocal)) {
          try { await serializeMutation(space, key, () => remoteMutate('set', space, key, previousLocal)); } catch (error) { reportStorageFailure('storage.mirror.rollback', error); }
        }
        setStatus('mirror_delete_rolled_back', 'pluginStorage remove failed', { mode: MODE_MIRROR, key: compact(key, 160), space });
        return false;
      }
      setStatus('synced', '', { mode: MODE_MIRROR, key: compact(key, 160), space });
      return true;
    }
    await serializeMutation(space, key, () => remoteMutate('remove', space, key, null));
    return true;
  };

  const keys = async (space, prefix = '', legacyKeysFn = null) => {
    const config = await readConfig();
    const legacy = typeof legacyKeysFn === 'function' ? await legacyKeysFn() : [];
    const legacyList = Array.isArray(legacy) ? legacy.map(String).filter(Boolean) : [];
    if (config.mode === MODE_PLUGIN_ONLY) return legacyList;
    let remote = { keys: [], tombstones: [] };
    try { remote = await remoteKeys(space, prefix); }
    catch (error) {
      if (config.mode === MODE_MIRROR) return legacyList;
      throw error;
    }
    const serverKeys = Array.isArray(remote.keys) ? remote.keys.map(String) : [];
    const tombstones = new Set(Array.isArray(remote.tombstones) ? remote.tombstones.map(String) : []);
    const hiddenLegacyKey = key => {
      if (!matchesRoute(space, key)) return false;
      if (tombstones.has(key)) return true;
      for (const tombstone of tombstones) if (key.startsWith(`${tombstone}::chunk:v1:`)) return true;
      return false;
    };
    return [...new Set([...serverKeys, ...legacyList.filter(key => !hiddenLegacyKey(key))])];
  };

  const createProxy = (legacy, space, cache) => {
    if (!legacy || (typeof legacy !== 'object' && typeof legacy !== 'function')) return legacy;
    state.legacy[space] = legacy;
    if (space === 'plugin') scheduleLifecycleTimeout(() => { void resumePendingSyncJob().catch(() => {}); }, 0);
    if (cache.has(legacy)) { scheduleLegacyMigration(legacy, space); return cache.get(legacy); }
    const proxy = Object.freeze({
      getItem: async key => await get(
        space,
        String(key),
        async () => typeof legacy.getItem === 'function' ? await legacy.getItem(key) : null,
        async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false,
        async () => {
          if (typeof legacy.removeItem === 'function') return (await legacy.removeItem(key)) !== false;
          if (typeof legacy.setItem === 'function') return (await legacy.setItem(key, null)) !== false;
          return false;
        }
      ),
      setItem: async (key, value) => await set(space, String(key), value, async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false),
      removeItem: async key => await remove(
        space,
        String(key),
        async () => typeof legacy.getItem === 'function' ? await legacy.getItem(key) : null,
        async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false,
        async () => {
          if (typeof legacy.removeItem === 'function') return (await legacy.removeItem(key)) !== false;
          if (typeof legacy.setItem === 'function') return (await legacy.setItem(key, null)) !== false;
          return false;
        }
      ),
      keys: async () => await keys(space, '', async () => typeof legacy.keys === 'function' ? await legacy.keys() : []),
      migrateAll: async () => await migrateAllLegacy(legacy, space)
    });
    cache.set(legacy, proxy);
    scheduleLegacyMigration(legacy, space);
    return proxy;
  };

  const connectionPanelIdBase = `memory-suite-connection-${namespace}`.replace(/[^A-Za-z0-9_-]/g, '_');
  let connectionPanelSequence = 0;

  const htmlEscape = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const mountConnectionPanel = async (container, panelOptions = {}) => {
    if (!container || typeof container.querySelector !== 'function') return false;
    const instanceId = `${connectionPanelIdBase}-${++connectionPanelSequence}`;
    const title = String(panelOptions.title || `${displayName} · 서버 연결`).trim();
    const description = String(panelOptions.description || '저장 방식과 Librarian System 서버 주소를 설정하고 연결 상태를 확인합니다.').trim();
    const bookTheme = String(panelOptions.theme || '').toLowerCase() === 'book';
    const config = await readConfig(true).catch(error => ({ mode: MODE_PLUGIN_ONLY, url: defaultUrl, error: compact(error?.message || error, 300) }));
    const fmtBytes = bytes => {
      const value = Math.max(0, Number(bytes || 0) || 0);
      if (value < 1024) return `${Math.round(value)} B`;
      if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
      if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
      return `${(value / (1024 ** 3)).toFixed(2)} GB`;
    };
    const fmtDuration = ms => {
      const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      if (total < 60) return `${total}초`;
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes < 60) return `${minutes}분 ${seconds}초`;
      return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
    };
    const phaseLabel = phase => ({
      queued: '작업 준비', starting: '작업 시작', resuming: '이전 작업 재개', resume_pending: '재개 대기',
      configuration_start: '설정 변경 준비', connection_test: '서버 연결 확인', connection_ready: '서버 연결 확인 완료',
      seed_new_server: '새 서버 기준선 생성', mode_transition: '저장 모드 전환 준비',
      integrity_before: '서버 무결성 확인', inventory: '데이터 조사 중', inventory_complete: '데이터 조사 완료',
      sync_local: 'pluginStorage → 서버 동기화', restore_missing_local: '서버 → pluginStorage 보충',
      restore_before_url_change: '기존 서버 데이터 복구', prune_local: '로컬 정리', restore_values: '서버 데이터 복구',
      restore_tombstones: '삭제 상태 복구', integrity_after: '최종 무결성 확인', space_complete: '저장소 동기화 완료',
      space_incomplete: '동기화 확인 필요', configuration_complete: '설정 적용 완료', configuration_rollback: '이전 설정 복구',
      waiting_for_server: '서버 재연결 대기', completed: '완료', failed: '실패'
    }[String(phase || '')] || String(phase || '작업 중'));
    const jobTitle = job => job?.kind === 'manual_sync' ? '수동 동기화'
      : (job?.kind === 'server_restore' ? '서버 → pluginStorage 복구'
        : ((job?.sourceMode === MODE_PLUGIN_ONLY && job?.targetMode !== MODE_PLUGIN_ONLY) ? '초기 서버 동기화' : '저장 설정 전환'));

    container.innerHTML = `
      <section class="mscx" data-memory-suite-connection-panel="${htmlEscape(namespace)}">
        <style>
          #${instanceId}{--mscx-bg:rgba(15,23,42,.72);--mscx-card:rgba(30,41,59,.76);--mscx-soft:rgba(15,23,42,.68);--mscx-line:rgba(148,163,184,.25);--mscx-text:#eef4ff;--mscx-muted:#9eabc1;--mscx-accent:#7aa2ff;--mscx-good:#56d49b;--mscx-warn:#f0b65a;--mscx-danger:#fb7185;color:var(--mscx-text);display:grid;gap:14px;font:500 13px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-width:0}
          #${instanceId} *{box-sizing:border-box} #${instanceId} .mscx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:2px 2px 0} #${instanceId} h2{margin:0;font-size:20px;line-height:1.25;color:var(--mscx-text)} #${instanceId} .mscx-head p{margin:6px 0 0;color:var(--mscx-muted);font-size:12px}
          #${instanceId} .mscx-state{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;border:1px solid var(--mscx-line);border-radius:999px;background:var(--mscx-soft);white-space:nowrap;font-size:11px;font-weight:800;color:var(--mscx-muted)} #${instanceId} .mscx-dot{width:8px;height:8px;border-radius:50%;background:var(--mscx-muted)} #${instanceId} .mscx-state.good .mscx-dot{background:var(--mscx-good);box-shadow:0 0 0 4px rgba(86,212,155,.12)} #${instanceId} .mscx-state.warn .mscx-dot{background:var(--mscx-warn)} #${instanceId} .mscx-state.error .mscx-dot{background:var(--mscx-danger)}
          #${instanceId} .mscx-card{padding:14px;border:1px solid var(--mscx-line);border-radius:15px;background:var(--mscx-card);min-width:0} #${instanceId} .mscx-card-title{display:block;margin-bottom:9px;font-size:12px;font-weight:850;color:var(--mscx-text)}
          #${instanceId} .mscx-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px} #${instanceId} .mscx-mode{position:relative;display:grid;gap:4px;padding:12px;border:1px solid var(--mscx-line);border-radius:12px;background:var(--mscx-soft);cursor:pointer;min-width:0} #${instanceId} .mscx-mode.selected,#${instanceId} .mscx-mode:has(input:checked){border-color:var(--mscx-accent);box-shadow:0 0 0 1px var(--mscx-accent) inset;background:rgba(81,116,200,.13)} #${instanceId} .mscx-mode input{position:absolute;right:10px;top:10px;accent-color:var(--mscx-accent)} #${instanceId} .mscx-mode strong{padding-right:22px;font-size:12px;color:var(--mscx-text)} #${instanceId} .mscx-mode small{color:var(--mscx-muted);font-size:10px;line-height:1.45}
          #${instanceId} .mscx-url-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px} #${instanceId} input[type="url"],#${instanceId} input[type="password"]{width:100%;min-width:0;padding:10px 11px;border:1px solid var(--mscx-line);border-radius:10px;background:var(--mscx-soft);color:var(--mscx-text);font:500 12px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none} #${instanceId} input[type="url"]:focus,#${instanceId} input[type="password"]:focus{border-color:var(--mscx-accent);box-shadow:0 0 0 3px rgba(122,162,255,.12)}
          #${instanceId} .mscx-actions{display:flex;flex-wrap:wrap;gap:8px} #${instanceId} button{min-height:38px;padding:8px 12px;border:1px solid var(--mscx-line);border-radius:10px;background:var(--mscx-soft);color:var(--mscx-text);font:750 11px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer} #${instanceId} button:hover{border-color:rgba(122,162,255,.65);background:rgba(70,94,150,.22)} #${instanceId} button.primary{background:rgba(55,97,181,.72);border-color:rgba(122,162,255,.75)} #${instanceId} button.danger{color:#ffe4e8;background:rgba(126,34,52,.55);border-color:rgba(251,113,133,.55)} #${instanceId} button:disabled{opacity:.45;cursor:not-allowed}
          #${instanceId} .mscx-info{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px} #${instanceId} .mscx-info div{padding:9px 10px;border:1px solid var(--mscx-line);border-radius:10px;background:var(--mscx-soft);min-width:0} #${instanceId} .mscx-info span{display:block;color:var(--mscx-muted);font-size:9px;font-weight:800} #${instanceId} .mscx-info strong{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--mscx-text)}
          #${instanceId} .mscx-job{display:grid;gap:10px;border-color:rgba(122,162,255,.34);background:linear-gradient(180deg,rgba(35,55,97,.45),rgba(15,23,42,.58))} #${instanceId} .mscx-job[hidden]{display:none} #${instanceId} .mscx-job-head{display:flex;justify-content:space-between;gap:10px;align-items:center} #${instanceId} .mscx-job-head strong{font-size:13px} #${instanceId} .mscx-job-badge{font-size:10px;font-weight:850;color:var(--mscx-muted)}
          #${instanceId} .mscx-progress{height:9px;border-radius:999px;overflow:hidden;background:rgba(2,6,23,.6);border:1px solid rgba(148,163,184,.18)} #${instanceId} .mscx-progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--mscx-accent),var(--mscx-good));transition:width .25s ease} #${instanceId} .mscx-progress.indeterminate>i{width:38%;animation:mscx-slide 1.2s ease-in-out infinite}@keyframes mscx-slide{0%{transform:translateX(-110%)}100%{transform:translateX(290%)}}
          #${instanceId} .mscx-job-phase{font-size:12px;font-weight:800;color:var(--mscx-text)} #${instanceId} .mscx-job-message{font-size:10px;color:var(--mscx-muted)} #${instanceId} .mscx-job-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px} #${instanceId} .mscx-job-stat{padding:8px;border-radius:9px;background:rgba(2,6,23,.38);border:1px solid rgba(148,163,184,.16);min-width:0} #${instanceId} .mscx-job-stat span{display:block;font-size:8px;color:var(--mscx-muted);font-weight:800} #${instanceId} .mscx-job-stat b{display:block;margin-top:2px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} #${instanceId} .mscx-job-current{padding:8px 9px;border-radius:9px;background:rgba(2,6,23,.35);font:500 9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--mscx-muted);overflow-wrap:anywhere}
          #${instanceId} .mscx-message{min-height:56px;padding:11px 12px;border:1px solid var(--mscx-line);border-radius:11px;background:var(--mscx-soft);color:var(--mscx-muted);white-space:pre-wrap;font-size:11px} #${instanceId} .mscx-message.good{border-color:rgba(86,212,155,.35);color:#c9f8e4} #${instanceId} .mscx-message.error{border-color:rgba(251,113,133,.38);color:#ffd0d8} #${instanceId} .mscx-note{color:var(--mscx-muted);font-size:10px;line-height:1.5}
          @media(max-width:760px){#${instanceId} .mscx-modes{grid-template-columns:1fr}#${instanceId} .mscx-info{grid-template-columns:repeat(2,minmax(0,1fr))}#${instanceId} .mscx-job-stats{grid-template-columns:repeat(2,minmax(0,1fr))}#${instanceId} .mscx-url-row{grid-template-columns:1fr}#${instanceId} .mscx-head{display:grid}#${instanceId} .mscx-state{justify-self:start}}
          ${bookTheme ? `
          #${instanceId}{--mscx-bg:#f8f0e5;--mscx-card:#f6ecdf;--mscx-soft:#fbf5eb;--mscx-line:#cfbea3;--mscx-text:#392b20;--mscx-muted:#75614c;--mscx-accent:#9a6938;--mscx-good:#58715c;--mscx-warn:#9b6b36;--mscx-danger:#8a5148;color-scheme:light;-webkit-text-fill-color:currentColor}
          #${instanceId} .mscx-card,#${instanceId} .mscx-mode,#${instanceId} .mscx-message,#${instanceId} input[type="url"],#${instanceId} input[type="password"]{background:#fbf5eb;color:#392b20}
          #${instanceId} .mscx-mode.selected,#${instanceId} .mscx-mode:has(input:checked){background:#ead9c1;border-color:#a97947;box-shadow:inset 0 0 0 1px rgba(154,105,56,.15)}
          #${instanceId} button{background:#f3e8d8;color:#5e4630;border-color:#c5ae8e}#${instanceId} button:hover{background:#eadcc8;border-color:#a97947}#${instanceId} button.primary{background:#dfc39d;border-color:#a97947;color:#53341c}#${instanceId} button.danger{background:#ecd9d4;border-color:#b98076;color:#713d37}
          #${instanceId} .mscx-job{background:#f2e6d5;border-color:#c5a67d}#${instanceId} .mscx-progress{background:#dfd0bb;border-color:#cfbea3}#${instanceId} .mscx-job-stat,#${instanceId} .mscx-job-current{background:#fbf5eb;color:#584533;border-color:#d5c4ac}
          #${instanceId} .mscx-message.good{background:#e4eadf;color:#405241;border-color:#819078}#${instanceId} .mscx-message.error{background:#ecd9d4;color:#713d37;border-color:#b98076}
          #${instanceId} .mscx-state{background:#f3e8d8;color:#6d5844}#${instanceId} .mscx-state.good{color:#405241}#${instanceId} .mscx-state.error{color:#713d37}
          #${instanceId} h2,#${instanceId} strong,#${instanceId} b{color:#33271c}#${instanceId} .mscx-note,#${instanceId} small,#${instanceId} .mscx-job-message{color:#75614c}
          ` : ''}
        </style>
        <div id="${instanceId}">
          <div class="mscx-head"><div><h2>${htmlEscape(title)}</h2><p>${htmlEscape(description)}</p></div><div class="mscx-state" data-mscx-state><span class="mscx-dot"></span><span data-mscx-state-text>상태 확인 중</span></div></div>
          <div class="mscx-card"><span class="mscx-card-title">저장 방식</span><div class="mscx-modes">
            <label class="mscx-mode"><input type="radio" name="${instanceId}-mode" value="plugin_only"><strong>플러그인 단독 · 기본</strong><small>RisuAI pluginStorage만 사용합니다. 서버가 없어도 정상 작동합니다.</small></label>
            <label class="mscx-mode"><input type="radio" name="${instanceId}-mode" value="server_only"><strong>서버 단독</strong><small>Librarian System DATA를 영구 정본으로 사용합니다.</small></label>
          </div></div>
          <div class="mscx-card"><span class="mscx-card-title">서버 주소</span><div class="mscx-url-row"><input data-mscx-url type="url" spellcheck="false" value="${htmlEscape(config.url || defaultUrl)}"><button data-mscx-test type="button">연결 테스트</button></div><div class="mscx-note" style="margin-top:8px">별도 key 입력 없이 localhost·127.0.0.1·::1의 로컬 서버에 연결합니다. 기본 주소는 http://127.0.0.1:47630 입니다.</div></div>
          <div class="mscx-info"><div><span>현재 모드</span><strong data-mscx-mode-label>${htmlEscape(modeLabel(config.mode || MODE_PLUGIN_ONLY))}</strong></div><div><span>서버 버전</span><strong data-mscx-version>-</strong></div><div><span>프로토콜</span><strong data-mscx-protocol>-</strong></div><div><span>서버 데이터</span><strong data-mscx-records>-</strong></div><div><span>namespace</span><strong>${htmlEscape(namespace)}</strong></div></div>
          <div class="mscx-actions"><button data-mscx-apply class="primary" type="button">설정 적용</button><button data-mscx-sync type="button">지금 동기화</button><button data-mscx-restore type="button">서버 → pluginStorage 복구</button><button data-mscx-delete class="danger" type="button">플러그인 스토리지 삭제</button></div>
          <div class="mscx-card mscx-job" data-mscx-job hidden><div class="mscx-job-head"><strong data-mscx-job-title>초기 서버 동기화</strong><span class="mscx-job-badge" data-mscx-job-badge>작업 중</span></div><div class="mscx-progress" data-mscx-progress><i></i></div><div><div class="mscx-job-phase" data-mscx-job-phase>작업 준비</div><div class="mscx-job-message" data-mscx-job-message></div></div><div class="mscx-job-stats"><div class="mscx-job-stat"><span>진행</span><b data-mscx-job-items>-</b></div><div class="mscx-job-stat"><span>처리 용량</span><b data-mscx-job-bytes>-</b></div><div class="mscx-job-stat"><span>전송·복구</span><b data-mscx-job-transfer>-</b></div><div class="mscx-job-stat"><span>경과 시간</span><b data-mscx-job-elapsed>-</b></div><div class="mscx-job-stat"><span>마지막 활동</span><b data-mscx-job-activity>-</b></div><div class="mscx-job-stat"><span>재시도 / 실패</span><b data-mscx-job-retry>-</b></div></div><div class="mscx-job-current" data-mscx-job-current>현재 작업을 준비하고 있습니다.</div><div class="mscx-note">이 화면을 닫아도 작업은 계속됩니다. 새로고침 후에는 저장된 작업 영수증을 읽고 이미 서버에 일치하는 항목을 다시 전송하지 않고 이어서 확인합니다.</div></div>
          <div class="mscx-message" data-mscx-message>${htmlEscape(config.error ? `설정 읽기 실패: ${config.error}` : `현재 모드: ${modeLabel(config.mode || MODE_PLUGIN_ONLY)}`)}</div>
        </div>
      </section>`;

    const root = container.querySelector(`#${instanceId}`);
    if (!root) return false;
    let currentConfig = { ...config };
    let lastTerminalHandled = '';
    const q = selector => root.querySelector(selector);
    const modeInputs = () => Array.from(root.querySelectorAll(`input[name="${instanceId}-mode"]`));
    const selectedMode = () => modeInputs().find(input => input.checked)?.value || MODE_PLUGIN_ONLY;
    const updateModeSelectionStyles = () => modeInputs().forEach(input => input.closest?.('.mscx-mode')?.classList?.toggle('selected', input.checked === true));
    modeInputs().forEach(input => { input.checked = input.value === (currentConfig.mode || MODE_PLUGIN_ONLY); input.addEventListener?.('change', updateModeSelectionStyles); });
    updateModeSelectionStyles();
    const probeUi = connectionPanelProbeGuard(root, () => `${selectedMode()}|${q('[data-mscx-url]').value}`);
    const messageNode = q('[data-mscx-message]');
    const stateNode = q('[data-mscx-state]');
    const setMessage = (value, tone = '') => { probeUi.invalidate(); if (messageNode) { messageNode.textContent = String(value || ''); messageNode.className = `mscx-message${tone ? ` ${tone}` : ''}`; } };
    const setConnectionUi = result => {
      const ok = result?.ok === true;
      if (stateNode) stateNode.className = `mscx-state ${ok ? 'good' : 'error'}`;
      const stateText = q('[data-mscx-state-text]'); if (stateText) stateText.textContent = ok ? '서버 연결됨' : ((currentConfig.mode || MODE_PLUGIN_ONLY) === MODE_PLUGIN_ONLY ? '플러그인 단독' : '서버 연결 안 됨');
      const version = q('[data-mscx-version]'); if (version) version.textContent = ok ? (result.serverVersion || '-') : '-';
      const protocol = q('[data-mscx-protocol]'); if (protocol) protocol.textContent = ok ? `${Number(result.protocol?.major || 0)}.${Number(result.protocol?.minor || 0)}` : '-';
      const records = q('[data-mscx-records]'); if (records) records.textContent = ok ? `${Number(result.liveRecords || 0).toLocaleString()}건` : '-';
    };
    const setPluginOnlyUi = () => {
      if (stateNode) stateNode.className = 'mscx-state warn';
      const stateText = q('[data-mscx-state-text]'); if (stateText) stateText.textContent = '플러그인 단독';
      const version = q('[data-mscx-version]'); if (version) version.textContent = '-';
      const protocol = q('[data-mscx-protocol]'); if (protocol) protocol.textContent = '-';
      const records = q('[data-mscx-records]'); if (records) records.textContent = '-';
    };
    const renderJob = job => {
      const node = q('[data-mscx-job]');
      if (!node) return;
      if (!job) { node.hidden = true; return; }
      node.hidden = false;
      const terminal = syncJobTerminal(job.status);
      const total = Math.max(0, Number(job.totalItems || 0) || 0);
      const processed = Math.max(0, Number(job.processedItems || 0) || 0);
      const percent = total > 0 ? Math.max(0, Math.min(100, processed / total * 100)) : 0;
      const progressNode = q('[data-mscx-progress]');
      if (progressNode) {
        progressNode.classList.toggle('indeterminate', !terminal && total <= 0);
        const bar = progressNode.querySelector('i'); if (bar && total > 0) bar.style.width = `${percent.toFixed(2)}%`; else if (bar && terminal) bar.style.width = job.status === 'completed' ? '100%' : '0%';
      }
      q('[data-mscx-job-title]').textContent = jobTitle(job);
      q('[data-mscx-job-badge]').textContent = job.status === 'completed' ? '완료' : (job.status === 'failed' ? '실패' : (job.status === 'paused' ? '일시 중지 · 자동 재시도' : (total > 0 ? `${percent.toFixed(1)}%` : '작업 중')));
      q('[data-mscx-job-phase]').textContent = phaseLabel(job.phase);
      q('[data-mscx-job-message]').textContent = job.message || (job.error ? job.error : '');
      q('[data-mscx-job-items]').textContent = total > 0 ? `${processed.toLocaleString()} / ${total.toLocaleString()}건` : `${processed.toLocaleString()}건 확인`;
      q('[data-mscx-job-bytes]').textContent = fmtBytes(job.processedBytes || 0);
      q('[data-mscx-job-transfer]').textContent = fmtBytes(job.transferredBytes || 0);
      const endAt = job.finishedAt || Date.now(); q('[data-mscx-job-elapsed]').textContent = fmtDuration(endAt - Number(job.startedAt || endAt));
      const activityAge = Math.max(0, Date.now() - Number(job.lastActivityAt || job.updatedAt || Date.now())); q('[data-mscx-job-activity]').textContent = activityAge < 1500 ? '방금 전' : `${fmtDuration(activityAge)} 전`;
      q('[data-mscx-job-retry]').textContent = `${Number(job.retryCount || 0)} / ${Number(job.failures || 0)}`;
      const currentBits = [job.currentAction, job.currentSpace ? `[${job.currentSpace}]` : '', job.currentKey].filter(Boolean); q('[data-mscx-job-current]').textContent = currentBits.join(' · ') || (terminal ? (job.status === 'completed' ? '모든 검증이 완료되었습니다.' : (job.error || '작업이 중단되었습니다.')) : '현재 작업을 준비하고 있습니다.');
      const active = !terminal;
      if (active && stateNode) {
        stateNode.className = job.status === 'paused' ? 'mscx-state warn' : 'mscx-state warn';
        const stateText = q('[data-mscx-state-text]'); if (stateText) stateText.textContent = job.status === 'paused' ? '동기화 일시 중지' : `${jobTitle(job)} 중`;
      }
      if (terminal && job.jobId && lastTerminalHandled !== job.jobId) {
        lastTerminalHandled = job.jobId;
        setMessage(job.status === 'completed'
          ? `${jobTitle(job)} 완료\n업로드 ${Number(job.uploaded || 0).toLocaleString()} · 복구 ${Number(job.restored || 0).toLocaleString()} · 일치 ${Number(job.matched || 0).toLocaleString()}`
          : `${jobTitle(job)} 실패\n${job.error || '상세 오류를 확인하세요.'}`, job.status === 'completed' ? 'good' : 'error');
        scheduleLifecycleTimeout(() => { void refreshActionState().then(async latest => { if (latest.mode === MODE_PLUGIN_ONLY) setPluginOnlyUi(); else { const attempt = probeUi.begin(); const result = await testConnection(latest.url); if (await attempt.current(result)) setConnectionUi(result); } }); }, 0);
      }
    };
    const refreshActionState = async () => {
      const current = await readConfig(true).catch(() => currentConfig); currentConfig = { ...current };
      const job = getSyncJob(); const activeJob = !!job && !syncJobTerminal(job.status);
      const modeLabelNode = q('[data-mscx-mode-label]'); if (modeLabelNode) modeLabelNode.textContent = modeLabel(current.mode);
      q('[data-mscx-apply]').disabled = activeJob;
      q('[data-mscx-sync]').disabled = activeJob || current.mode !== MODE_MIRROR;
      q('[data-mscx-restore]').disabled = activeJob || current.mode !== MODE_SERVER_ONLY;
      q('[data-mscx-delete]').disabled = activeJob || current.mode === MODE_PLUGIN_ONLY;
      modeInputs().forEach(input => { input.disabled = activeJob; input.checked = input.value === (activeJob ? (job.targetMode || current.mode) : current.mode); }); updateModeSelectionStyles();
      const url = q('[data-mscx-url]'); if (url) { url.disabled = activeJob; if (typeof document === 'undefined' || document.activeElement !== url) url.value = activeJob ? (job.targetUrl || current.url) : current.url; }
      renderJob(job);
      return current;
    };

    q('[data-mscx-test]').onclick = async () => {
      setMessage('서버 연결을 확인하고 있습니다…'); q('[data-mscx-test]').disabled = true;
      const attempt = probeUi.begin();
      const result = await testConnection(q('[data-mscx-url]').value, {adoptDataInstance:true});
      if (attempt.attached()) q('[data-mscx-test]').disabled = false;
      if (!await attempt.current(result)) return result;
      setConnectionUi(result); renderJob(getSyncJob());
      setMessage(result.ok ? `연결 성공\nLibrarian System ${result.serverVersion || '-'} · Protocol ${Number(result.protocol?.major || 0)}.${Number(result.protocol?.minor || 0)} · DB ${result.integrity?.result || 'ok'} · 데이터 ${Number(result.liveRecords || 0).toLocaleString()}건 · ${result.durationMs}ms` : `연결 실패\n${result.error || '서버에 연결할 수 없습니다.'}`, result.ok ? 'good' : 'error');
      q('[data-mscx-test]').disabled = false;
    };

    q('[data-mscx-apply]').onclick = async () => {
      const targetMode = selectedMode(); const targetUrl = q('[data-mscx-url]').value;
      try {
        const current = await readConfig(true);
        if (targetMode === current.mode && normalizeServerUrl(targetUrl) === current.url) { setMessage('변경할 설정이 없습니다.', 'good'); return; }
        if (targetMode === MODE_PLUGIN_ONLY && current.mode === MODE_PLUGIN_ONLY) {
          q('[data-mscx-apply]').disabled = true; setMessage('서버 주소 설정을 적용하고 있습니다…');
          const result = await configureConnection({ mode: targetMode, url: targetUrl });
          setMessage(`설정 적용 완료\n${modeLabel(result.to.mode)} · ${result.to.url}`, 'good'); setPluginOnlyUi();
          await refreshActionState(); return;
        }
        const job = await startConnectionConfigurationJob({ mode: targetMode, url: targetUrl });
        setMessage(`설정 변경을 접수했습니다.\n현재 저장 모드는 데이터 안전을 위해 그대로 유지하며, ${jobTitle(job)}가 끝나면 ${modeLabel(job.targetMode)}로 자동 확정됩니다.`, 'good');
        renderJob(job); await refreshActionState();
      } catch (error) { setMessage(`설정 적용 시작 실패\n${error?.message || error}`, 'error'); await refreshActionState(); }
    };

    q('[data-mscx-sync]').onclick = async () => {
      try { const job = await startSynchronizationJob(); setMessage('수동 동기화를 백그라운드에서 시작했습니다. 이 화면을 닫아도 계속됩니다.', 'good'); renderJob(job); await refreshActionState(); }
      catch (error) { setMessage(`동기화 시작 실패\n${error?.message || error}`, 'error'); }
    };
    q('[data-mscx-restore]').onclick = async () => {
      try { const job = await startRestoreJob(); setMessage('서버 DATA 복구를 백그라운드에서 시작했습니다. 진행 상황은 아래에 계속 표시됩니다.', 'good'); renderJob(job); await refreshActionState(); }
      catch (error) { setMessage(`복구 시작 실패\n${error?.message || error}`, 'error'); }
    };

    let deleteArmedUntil = 0;
    q('[data-mscx-delete]').onclick = async () => {
      const button = q('[data-mscx-delete]'); if (getSyncJob() && !syncJobTerminal(getSyncJob().status)) { setMessage('진행 중인 동기화가 끝난 뒤 삭제할 수 있습니다.', 'error'); return; }
      if (Date.now() > deleteArmedUntil) {
        button.disabled = true; setMessage('삭제 전에 서버 DATA의 무결성과 보존 범위를 확인하고 있습니다…');
        try { const checked = await verifyServerPreservation(state.legacy.plugin); deleteArmedUntil = Date.now() + 30000; button.textContent = '검증 완료 · 다시 눌러 삭제'; setMessage(`서버 보존 검증 완료\nDB 무결성: ${checked.integrity?.result || 'ok'} · 항목 ${checked.checked}\n30초 안에 다시 누르면 pluginStorage를 삭제하고 서버 단독으로 전환합니다.`, 'good'); }
        catch (error) { deleteArmedUntil = 0; button.textContent = '플러그인 스토리지 삭제'; setMessage(`삭제 차단\n서버에 안전하게 보존됐다고 확인할 수 없습니다.\n${error?.message || error}`, 'error'); }
        finally { await refreshActionState(); if (deleteArmedUntil > Date.now()) button.disabled = false; }
        return;
      }
      deleteArmedUntil = 0; button.disabled = true; setMessage('서버 보존 상태를 다시 확인한 뒤 pluginStorage를 삭제합니다…');
      try { const result = await deletePluginStorageAfterServerVerification(); button.textContent = '플러그인 스토리지 삭제'; await clearPersistedSyncJob(); setMessage(`삭제 완료\n삭제 항목 ${result.deleted} · 저장 방식 서버 단독\n필요하면 복구 버튼으로 pluginStorage를 다시 만들 수 있습니다.`, 'good'); }
      catch (error) { button.textContent = '플러그인 스토리지 삭제'; setMessage(`삭제 실패 또는 중단\n${error?.message || error}\n검증되지 않은 데이터는 삭제하지 않았습니다.`, 'error'); }
      finally { await refreshActionState(); }
    };

    const unsubscribe = subscribeSyncJob(renderJob);
    const tick = setInterval(() => {
      if (!root.isConnected) { clearInterval(tick); unsubscribe(); return; }
      renderJob(getSyncJob());
    }, 1000);
    try { tick?.unref?.(); } catch (_) {}
    await resumePendingSyncJob().catch(() => null);
    await refreshActionState();
    if ((currentConfig.mode || MODE_PLUGIN_ONLY) !== MODE_PLUGIN_ONLY) { const attempt = probeUi.begin(); void testConnection(currentConfig.url).then(async result => { if (!await attempt.current(result)) return; setConnectionUi(result); renderJob(getSyncJob()); }).catch(() => {}); } else setPluginOnlyUi();
    renderJob(getSyncJob());
    return true;
  };

  const managementRootId = `memory-suite-management-${namespace}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const managementButtonId = `memory-suite-management-button-${namespace}`.replace(/[^A-Za-z0-9_-]/g, '_');

  const closeManagementDialog = async () => {
    try { state.management.root?.remove?.(); } catch (_) {}
    state.management.root = null;
    for (const api of apiCandidates()) {
      try { if (typeof api?.hideContainer === 'function') { await api.hideContainer(); break; } } catch (_) {}
    }
  };

  const openManagementDialog = async () => {
    for (const api of apiCandidates()) {
      try { if (typeof api?.showContainer === 'function') { await api.showContainer('fullscreen'); break; } } catch (_) {}
    }
    if (typeof document === 'undefined' || !document.body) throw new Error('memory_suite_management_dom_unavailable');
    try { document.getElementById(managementRootId)?.remove?.(); } catch (_) {}
    const root = document.createElement('div');
    root.id = managementRootId;
    root.innerHTML = `<style>
      #${managementRootId}{position:fixed;inset:0;z-index:28;background:rgba(4,8,15,.72);display:flex;align-items:center;justify-content:center;padding:18px}
      #${managementRootId} .ms-dialog-card{width:min(820px,100%);max-height:94vh;overflow:auto;background:#101827;border:1px solid #334155;border-radius:17px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.48)}
      #${managementRootId} .ms-dialog-close{display:flex;justify-content:flex-end;margin-top:12px} #${managementRootId} .ms-dialog-close button{padding:9px 14px;border:1px solid #475569;border-radius:9px;background:#1e293b;color:#eef3ff;cursor:pointer;font-weight:700}
    </style><div class="ms-dialog-card"><div data-ms-dialog-panel></div><div class="ms-dialog-close"><button data-ms-dialog-close type="button">닫기</button></div></div>`;
    document.body.appendChild(root);
    state.management.root = root;
    const host = root.querySelector('[data-ms-dialog-panel]');
    await mountConnectionPanel(host, { title: `${displayName} · 서버 연결`, description: '저장 방식, 서버 주소, 연결 상태와 복구·삭제 작업을 관리합니다.' });
    root.querySelector('[data-ms-dialog-close]').onclick = () => { void closeManagementDialog(); };
    return true;
  };

  const registerManagementButton = async () => {
    if (!managementButtonEnabled || state.management.registered || state.management.registering) return state.management.handle;
    state.management.registering = true;
    try {
      const api = apiCandidates().find(candidate => typeof candidate?.registerButton === 'function');
      if (!api) return null;
      const handle = await api.registerButton({
        name: `${displayName} 데이터 저장`, icon: '💾', iconType: 'html', location: 'hamburger', id: managementButtonId
      }, openManagementDialog);
      state.management.handle = handle || { id: managementButtonId };
      state.management.registered = true;
      return state.management.handle;
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/duplicate|already|exists/i.test(message)) {
        state.management.registered = true;
        state.management.handle = { id: managementButtonId, duplicate: true };
        return state.management.handle;
      }
      warnOnce('management_button_registration_failed', error);
      return null;
    } finally { state.management.registering = false; }
  };

  const scheduleManagementRegistration = () => {
    if (!managementButtonEnabled || state.management.registered || state.management.timer) return;
    let attempts = 0;
    const tryRegister = async () => {
      state.management.timer = null; attempts += 1;
      const result = await registerManagementButton();
      if (!result && attempts < 8) {
        state.management.timer = scheduleLifecycleTimeout(tryRegister, Math.min(5000, 500 + attempts * 650));
        try { state.management.timer?.unref?.(); } catch (_) {}
      }
    };
    state.management.timer = scheduleLifecycleTimeout(tryRegister, 300);
    try { state.management.timer?.unref?.(); } catch (_) {}
  };


  // ---------------------------------------------------------------------------
  // Scope-routed storage layer v1.7
  // ---------------------------------------------------------------------------
  const strictOwnerScopeDescriptor = (source,fallbackId='') => {
    const fields=['scopeId','scopeKey','characterId','chatId','canonicalCharacterId','canonicalChatId','canonicalScopeId','personaId','storageHash'];
    if(fields.some(key=>source[key]!==undefined&&typeof source[key]!=='string')
      ||source.aliases!==undefined&&(!Array.isArray(source.aliases)||source.aliases.some(alias=>typeof alias!=='string'))
      ||fallbackId&&source.scopeId&&source.scopeId!==fallbackId)throw Object.assign(new Error('MEMORY_SUITE_GLOBAL_OWNER_IDENTITY_INVALID'),{code:'MEMORY_SUITE_GLOBAL_OWNER_IDENTITY_INVALID'});
    return {...source,scopeId:source.scopeId||fallbackId,scopeKey:source.scopeKey||source.scopeId||fallbackId,
      aliases:[...new Set([...(source.aliases||[]),...(source.storageHash?[source.storageHash]:[])])],available:source.available!==false,label:String(source.label||source.chatTitle||source.scopeId||fallbackId)};
  };
  const normalizeScopeDescriptor = (value, fallbackId = '') => {
    const source = value && typeof value === 'object' ? value : (value ? { scopeId: value } : {});
    // Strict owner inventory descriptors already carry source-proven identity. Never
    // synthesize canonical aliases or truncate their verified alias membership.
    if (source.globalInventoryIdentity === 'memory-suite.strict-owner-scope.v1') return strictOwnerScopeDescriptor(source,fallbackId);
    const scopeId = String(source.scopeId || source.scopeKey || source.key || fallbackId || '').trim().slice(0, 700);
    const canonicalCharacterIdRaw = String(source.canonicalCharacterId || source.canonical_character_id || '').trim().slice(0, 240);
    const canonicalChatIdRaw = String(source.canonicalChatId || source.canonical_chat_id || '').trim().slice(0, 240);
    const canonicalScopeIdRaw = String(source.canonicalScopeId || source.canonical_scope_id || '').trim().slice(0, 700);
    const aliases = [...new Set((Array.isArray(source.aliases) ? source.aliases : [])
      .concat([source.scopeKey, source.key, source.storageHash, source.chatId, source.chat_id, canonicalChatIdRaw, canonicalScopeIdRaw])
      .map(item => String(item || '').trim()).filter(Boolean))].slice(0, 24);
    if (!scopeId) return { scopeId: '', scopeKey: '', label: '현재 스코프 확인 불가', aliases, available: false };
    const characterId = String(source.characterId || source.character_id || '').trim().slice(0, 240);
    const chatId = String(source.chatId || source.chat_id || '').trim().slice(0, 240);
    const canonicalCharacterId = canonicalCharacterIdRaw || characterId;
    const canonicalChatId = canonicalChatIdRaw || chatId;
    const canonicalScopeId = canonicalScopeIdRaw || (canonicalCharacterId && canonicalChatId ? `canonical:char:${canonicalCharacterId}|chat:${canonicalChatId}` : '');
    const personaId = String(source.personaId || source.persona_id || '').trim().slice(0, 240);
    const characterName = String(source.characterName || source.character_name || '').trim().slice(0, 160);
    const chatTitle = String(source.chatTitle || source.chat_title || source.title || '').trim().slice(0, 200);
    const personaName = String(source.personaName || source.persona_name || '').trim().slice(0, 160);
    const label = String(source.label || source.displayName || [characterName, chatTitle].filter(Boolean).join(' / ') || chatTitle || chatId || scopeId).trim().slice(0, 260);
    return { ...source, scopeId, scopeKey: String(source.scopeKey || source.key || scopeId).trim().slice(0, 700), aliases, characterId, chatId, canonicalCharacterId, canonicalChatId, canonicalScopeId, personaId, characterName, chatTitle, personaName, label, available: source.available !== false };
  };

  const defaultCurrentScope = async () => {
    const apis = apiCandidates();
    let charIndex = -1, chatIndex = -1, character = null, chat = null, db = null;
    for (const api of apis) {
      try {
        if (charIndex < 0 && typeof api?.getCurrentCharacterIndex === 'function') charIndex = Number(await api.getCurrentCharacterIndex());
        if (chatIndex < 0 && typeof api?.getCurrentChatIndex === 'function') chatIndex = Number(await api.getCurrentChatIndex());
        if (!character && Number.isInteger(charIndex) && charIndex >= 0 && typeof api?.getCharacterFromIndex === 'function') character = await api.getCharacterFromIndex(charIndex);
        if (!chat && Number.isInteger(charIndex) && charIndex >= 0 && Number.isInteger(chatIndex) && chatIndex >= 0 && typeof api?.getChatFromIndex === 'function') chat = await api.getChatFromIndex(charIndex, chatIndex);
        if (!db && typeof api?.getDatabase === 'function') db = await api.getDatabase(['selectedPersona', 'personas']);
      } catch (error) { reportStorageFailure('storage.scope.registry.op', error); }
    }
    character = character && typeof character === 'object' ? character : {};
    chat = chat && typeof chat === 'object' ? chat : {};
    db = db && typeof db === 'object' ? db : {};
    const first = (...values) => values.map(item => String(item == null ? '' : item).trim()).find(Boolean) || '';
    // Keep the legacy physical routing IDs unchanged, but carry a canonical
    // RisuAI identity beside them. This prevents an update from orphaning existing
    // server/pluginStorage routes while allowing owner plugins to converge on chaId/chat.id.
    const characterId = first(character.id, character._id, character.uid, character.uuid, character.key, Number.isInteger(charIndex) && charIndex >= 0 ? `charIndex:${charIndex}` : '');
    const chatId = first(chat.id, chat._id, chat.uid, chat.uuid, chat.key, chat.chatId, Number.isInteger(chatIndex) && chatIndex >= 0 ? `chatIndex:${chatIndex}` : '');
    const canonicalCharacterId = first(character.chaId, character.characterId, character.charId, character.id, character._id, character.uid, character.uuid, character.key, characterId);
    const canonicalChatId = first(chat.id, chat.chatId, chat._id, chat.uid, chat.uuid, chat.key, chatId);
    const canonicalScopeId = canonicalCharacterId && canonicalChatId ? `canonical:char:${canonicalCharacterId}|chat:${canonicalChatId}` : '';
    let personaId = first(chat.bindedPersona, chat.boundPersonaId, chat.personaId);
    const selectedPersona = Number(db.selectedPersona);
    if (!personaId && Number.isInteger(selectedPersona) && Array.isArray(db.personas)) personaId = first(db.personas[selectedPersona]?.id, db.personas[selectedPersona]?._id, `personaIndex:${selectedPersona}`);
    if (!characterId || !chatId) return normalizeScopeDescriptor(null);
    const scopeId = `memory-suite:${namespace}:char:${characterId}|chat:${chatId}|persona:${personaId || 'default'}`;
    return normalizeScopeDescriptor({
      scopeId, scopeKey: scopeId, characterId, chatId, canonicalCharacterId, canonicalChatId, canonicalScopeId, personaId,
      characterName: first(character.nickname, character.name, character.charName),
      chatTitle: first(chat.name, chat.title, chat.chatName, chat.filename, chatId),
      aliases: [chatId, canonicalChatId, canonicalScopeId].filter(Boolean)
    });
  };

  const rawPluginStorage = () => {
    if (state.legacy.plugin?.getItem && state.legacy.plugin?.setItem) return state.legacy.plugin;
    for (const api of apiCandidates()) {
      try { if (api?.pluginStorage?.getItem && api?.pluginStorage?.setItem) return api.pluginStorage; } catch (_) {}
    }
    return null;
  };

  const rawDeviceStorage = async (readOptions = {}) => {
    if (state.legacy.local?.getItem && state.legacy.local?.setItem) return state.legacy.local;
    for (const api of apiCandidates()) {
      try {
        if (typeof api?.getLocalPluginStorage === 'function') {
          const store = await api.getLocalPluginStorage();
          if (store?.getItem && store?.setItem) return store;
        }
        if (api?.safeLocalStorage?.getItem && api?.safeLocalStorage?.setItem) return api.safeLocalStorage;
      } catch (error) { if (readOptions.strict === true) throw error; reportStorageFailure('storage.device.store.probe', error); }
    }
    return null;
  };

  // Physical observation only: this must not import modes, bootstrap a server,
  // or assign unclassified keys to whichever chat happens to be open.
  const inspectWholeDataLocalInventory = async () => {
    const error = code => Object.assign(new Error(code), { code });
    const epoch = wholeDataInventoryEpoch, generation = dataBinding.generation;
    const assertFence = () => {
      if (lifecycle.disposed || modeConfigurationBusy || modeConfigurationFrozen || storageTransition
        || resetReloadRequired || wholeDataInventoryEpoch !== epoch || dataBinding.generation !== generation) {
        throw error('MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');
      }
    };
    assertFence();
    const plugin = rawPluginStorage(), local = await rawDeviceStorage({strict:true});
    const stores = { plugin, local };
    const exactJson = value => {
    const seen = new Set();
    const walk = item => {
      if (item === null) return 'null';
      if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
      if (typeof item !== 'object' || seen.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error('non_json_value');
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (prototype !== null) {
        const constructor = Object.getOwnPropertyDescriptor(prototype,'constructor')?.value;
        if (typeof constructor !== 'function'
          || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(array ? Array : Object)
          || (!array && Object.getPrototypeOf(prototype) !== null)) throw new Error('non_json_value');
        for (let inherited=prototype; inherited; inherited=Object.getPrototypeOf(inherited)) {
          if (Object.getOwnPropertyDescriptor(inherited,'toJSON')) throw new Error('non_json_value');
        }
      }
      const names = Object.getOwnPropertyNames(item), keys = Object.keys(item);
      if (array ? names.length !== item.length + 1 || keys.length !== item.length : names.length !== keys.length) throw new Error('non_json_value');
      seen.add(item);
      const read = key => {
        const descriptor = Object.getOwnPropertyDescriptor(item,key);
        if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) throw new Error('non_json_value');
        return walk(descriptor.value);
      };
      const result = array
        ? '[' + Array.from({length:item.length},(_,index)=>read(String(index))).join(',') + ']'
        : '{' + keys.sort().map(key=>JSON.stringify(key)+':'+read(key)).join(',') + '}';
      seen.delete(item);
      return result;
    };
    return walk(value);
    };
    const snapshot = async () => {
      assertFence();
      if (rawPluginStorage() !== plugin || await rawDeviceStorage({strict:true}) !== local) throw error('MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');
      const records = [], reasons = [], authority = [];
      for (const space of ['plugin', 'local']) {
        const store = stores[space];
        if (store?.getItem) {
          const registry = await store.getItem(SCOPE_ROUTING_LOCAL_KEY);
          authority.push([space, registry == null ? null : JSON.parse(exactJson(registry))]);
        }
        const requiredSpace = space === 'plugin' || localPrefixes.length > 0 || localKeys.size > 0;
        if (!requiredSpace) continue;
        if (typeof store?.keys !== 'function' || typeof store?.getItem !== 'function') {
          reasons.push(space + '_key_enumeration_unavailable'); continue;
        }
        const keys = await store.keys();
        if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key || /[\0\r\n]/.test(key))
          || new Set(keys).size !== keys.length) { reasons.push(space + '_key_enumeration_invalid'); continue; }
        for (const key of keys.slice().sort()) {
          const artifactOwner = chunkOwnerKey(key);
          const decoded = scopedRemoteKeyInfo(artifactOwner || key);
          const artifact = !!artifactOwner && (matchesRoute(space, artifactOwner) || matchesRoute(space, decoded.logicalKey));
          if (!matchesRoute(space, key) && !matchesRoute(space, decoded.logicalKey) && !artifact) continue;
          if ((artifactOwner || key).includes(SCOPED_REMOTE_KEY_MARKER) && !decoded.scopeId) reasons.push(space + '_scope_identity_unverified');
          const raw = await store.getItem(key);
          let serialized;
          try { serialized = exactJson(raw); if (serialized === undefined) throw new Error(); }
          catch (_) { reasons.push(space + '_value_unreadable'); continue; }
          records.push({owner:namespace,space,key,logicalKey:decoded.logicalKey,
            scopeKind:decoded.scopeId ? 'scope' : 'unclassified',scopeId:decoded.scopeId || '',
            artifact,deleted:false,value:JSON.parse(serialized)});
        }
      }
      assertFence();
      return {records,reasons,authority};
    };
    const initial = await snapshot(), witness = JSON.stringify(initial);
    if (JSON.stringify(await snapshot()) !== witness) throw error('MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');
    const assertCurrent = async () => {
      if (JSON.stringify(await snapshot()) !== witness) throw error('MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');
      return true;
    };
    return {schema:'memory-suite.whole-data-local-inventory.v1',owner:namespace,
      coverage:'declared_owner_routes',inventoryComplete:initial.reasons.length === 0,
      suiteComplete:false,canCutover:false,sourceFence:false,
      reasons:[...initial.reasons,'shared_atomic_authority_provider_required','owner_semantic_inventory_required'],
      records:initial.records,assertCurrent};
  };
  const migrateWholeData = async (mode, migrationOptions = {}) => {
    requireOperationalMode(mode);
    const coordinator = options.wholeDataMigrationCoordinator;
    const expectedOwners = ['flashback','hayaku','lia','libra','retrace'];
    if (!coordinator || coordinator.contract !== 'memory-suite.whole-data-provider.v1'
      || typeof coordinator.migrate !== 'function' || !Array.isArray(coordinator.owners)
      || coordinator.owners.slice().sort().join(',') !== expectedOwners.join(',')) {
      throw Object.assign(new Error('MEMORY_SUITE_WHOLE_MIGRATION_PROVIDER_UNAVAILABLE'),
        {code:'MEMORY_SUITE_WHOLE_MIGRATION_PROVIDER_UNAVAILABLE'});
    }
    // The provider owns all five writer fences, durable staging and the common
    // authority decision. Do not emulate that with sequential setGlobalMode calls.
    return await coordinator.migrate({...migrationOptions,targetMode:mode});
  };

  // BEGIN CORE OWNER MODE PUBLICATION DIAGNOSTICS v1
  // Ordinary host get/set has no atomic writer ownership or cross-process CAS.
  // These co-stored records detect observed configuration changes, including ABA
  // through this writer. They never issue a semantic authority epoch.
  const modePublicationEnabled = ['flashback','hayaku','libra'].includes(namespace)
    && scopeRoutingEnabled && options.storagePolicy !== 'local_only' && options.storagePolicy !== 'manager_only';
  const MODE_PUBLICATION_SCHEMA = 'memory-suite.mode-publication.v1';
  const modePublicationActivities = new Set();
  let modePublicationRevision = 0, modePublicationReadPending = 0;
  const modePublicationFail = code => { throw Object.assign(new Error(code), {code}); };
  const modePublicationGeneration = () => {
    if (!Number.isSafeInteger(wholeDataInventoryEpoch + 1)) modePublicationFail('MODE_PUBLICATION_GENERATION_EXHAUSTED');
    wholeDataInventoryEpoch++;
  };
  const modePublicationProjection = registry => {
    if (!registry || registry.schema !== SCOPE_ROUTING_SCHEMA || registry.namespace !== namespace
        || !registry.entries || typeof registry.entries !== 'object' || Array.isArray(registry.entries)) modePublicationFail('MODE_PUBLICATION_MALFORMED');
    const ids = Object.keys(registry.entries).sort();
    if (ids.length > 8192) modePublicationFail('MODE_PUBLICATION_LIMIT');
    const rows = ids.map(scopeId => {
      const row = registry.entries[scopeId];
      if (!scopeId || scopeId.length > 700 || !row || typeof row !== 'object' || Array.isArray(row)
          || !VALID_MODES.has(row.mode) || row.scopeId !== undefined && row.scopeId !== scopeId
          || row.scopeKey !== undefined && (typeof row.scopeKey !== 'string' || row.scopeKey.length > 700)
          || row.origin !== undefined && (typeof row.origin !== 'string' || row.origin.length > 100)
          || row.removed !== undefined && typeof row.removed !== 'boolean'
          || row.pendingTargetMode !== undefined && row.pendingTargetMode !== null && !VALID_MODES.has(row.pendingTargetMode)) modePublicationFail('MODE_PUBLICATION_MALFORMED');
      return [scopeId,row.scopeKey ?? scopeId,row.mode,row.origin ?? '',row.removed === true,
        row.pendingTargetMode ?? null,Boolean(row.recoveryRequired)];
    });
    const projection = JSON.stringify([namespace,registry.legacyGlobalModeImported === true,rows]);
    if (projection.length > 524288) modePublicationFail('MODE_PUBLICATION_LIMIT');
    return projection;
  };
  const modePublicationDigest = async registry => {
    const bytes = new TextEncoder().encode(modePublicationProjection(registry));
    if (bytes.length > 1048576) modePublicationFail('MODE_PUBLICATION_LIMIT');
    if (typeof globalThis.crypto?.subtle?.digest !== 'function') modePublicationFail('MODE_PUBLICATION_CRYPTO_UNAVAILABLE');
    const digest = await globalThis.crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  };
  const modePublicationRecordValid = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === ['schema','namespace','pluginId','epoch','revision','phase','reason','routeDigest','atomicOwnerQualified'].sort().join('|')
    && value.schema === MODE_PUBLICATION_SCHEMA && value.namespace === namespace && value.pluginId === pluginId
    && typeof value.epoch === 'string' && /^[a-f0-9]{32}$/.test(value.epoch)
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && ['pending','settled','failed'].includes(value.phase) && typeof value.reason === 'string'
    && /^[a-z_]{1,64}$/.test(value.reason) && /^[a-f0-9]{64}$/.test(value.routeDigest)
    && value.atomicOwnerQualified === false;
  const createModePublication = async (registry, previous, detail = {}) => {
    if (previous !== undefined && !modePublicationRecordValid(previous)) modePublicationFail('MODE_PUBLICATION_RECORD_UNSUPPORTED');
    const priorRevision = previous ? previous.revision : 0;
    const revision = Math.max(modePublicationRevision,priorRevision) + 1;
    if (!Number.isSafeInteger(revision)) modePublicationFail('MODE_PUBLICATION_GENERATION_EXHAUSTED');
    if (typeof globalThis.crypto?.getRandomValues !== 'function') modePublicationFail('MODE_PUBLICATION_CRYPTO_UNAVAILABLE');
    const epoch = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
    modePublicationRevision = revision;
    return {schema:MODE_PUBLICATION_SCHEMA,namespace,pluginId,epoch,revision,
      phase:detail.phase || (storageTransition || modePublicationActivities.size ? 'pending' : 'settled'),
      reason:detail.reason || 'registry_write',routeDigest:await modePublicationDigest(registry),atomicOwnerQualified:false};
  };
  const modePublicationView = (status, publication = null) => Object.freeze({
    schema:'memory-suite.mode-publication-observation.v1',status,
    publication:publication ? Object.freeze({...publication}) : null,
    instanceGeneration:wholeDataInventoryEpoch,semanticModeEpoch:null,atomicOwnerQualified:false,
    authorityQualified:false,reason:'host_atomic_owner_capability_unavailable'
  });
  // This takes only bytes actually read by the owner. Callers cannot submit a
  // record, verifier, epoch, mode or qualification flag to the public reader.
  const inspectModePublicationCopies = async copies => {
    if (!modePublicationEnabled) return modePublicationView('unsupported_owner');
    const records = [];let absent = false;
    for (const raw of copies) {
      if (raw == null || raw === '') {absent=true;continue;}
      if (typeof raw !== 'string' || raw.length > 1048576) return modePublicationView('malformed');
      let registry;try {registry=JSON.parse(raw);} catch (_) {return modePublicationView('malformed');}
      if (!registry || typeof registry !== 'object' || Array.isArray(registry)
          || registry.schema !== SCOPE_ROUTING_SCHEMA || registry.namespace !== namespace
          || !registry.entries || typeof registry.entries !== 'object' || Array.isArray(registry.entries)) return modePublicationView('malformed');
      if (!Object.hasOwn(registry,'modePublication')) {absent=true;continue;}
      const record=registry.modePublication;
      if (!modePublicationRecordValid(record)) return modePublicationView('malformed');
      try {if (record.routeDigest !== await modePublicationDigest(registry)) return modePublicationView('mismatch');}
      catch (error) {return modePublicationView(error?.code === 'MODE_PUBLICATION_LIMIT' ? 'limit' : 'malformed');}
      records.push(record);
    }
    if (!records.length) return modePublicationView('absent');
    if (absent || records.some(record=>JSON.stringify(record)!==JSON.stringify(records[0]))) return modePublicationView('conflict');
    return modePublicationView(records[0].phase === 'settled' ? 'observed' : 'unsettled',records[0]);
  };
  const inspectModePublication = async (...args) => {
    if (args.length) modePublicationFail('MODE_PUBLICATION_REQUEST_INVALID');
    if (!modePublicationEnabled) return modePublicationView('unsupported_owner');
    if (lifecycle.disposed) return modePublicationView('disposed');
    if (modePublicationReadPending >= 4) return modePublicationView('busy');
    modePublicationReadPending++;
    try {
      const generation=wholeDataInventoryEpoch,plugin=rawPluginStorage();
      let device;try {device=await rawDeviceStorage({strict:true});} catch (_) {return modePublicationView('unavailable');}
      const stores=[...new Set([plugin,device].filter(Boolean))];
      if (!stores.length) return modePublicationView('unavailable');
      let copies;try {copies=[];for (const store of stores) copies.push(await store.getItem(SCOPE_ROUTING_LOCAL_KEY));}
      catch (_) {return modePublicationView('unavailable');}
      const view=await inspectModePublicationCopies(copies);
      if (lifecycle.disposed || wholeDataInventoryEpoch !== generation || rawPluginStorage() !== plugin) return modePublicationView('changed');
      try {if (await rawDeviceStorage({strict:true}) !== device) return modePublicationView('changed');}
      catch (_) {return modePublicationView('unavailable');}
      if (lifecycle.disposed || wholeDataInventoryEpoch !== generation || rawPluginStorage() !== plugin) return modePublicationView('changed');
      return view;
    } finally {modePublicationReadPending--;}
  };
  const publishModeConfigurationStage = async (reason, phase) => {
    if (!modePublicationEnabled) return null;
    return await writeScopeRegistryLocal(await loadScopeRegistry(true,false),{reason,phase});
  };
  const withModePublication = async (reason, factory) => {
    if (!modePublicationEnabled) return await factory();
    const activity={};modePublicationActivities.add(activity);
    try {
      await publishModeConfigurationStage(reason+'_pending','pending');
      const result=await factory();modePublicationActivities.delete(activity);
      await publishModeConfigurationStage(reason+'_settled',storageTransition || modePublicationActivities.size ? 'pending' : 'settled');
      return result;
    } catch (error) {
      modePublicationActivities.delete(activity);
      try {await publishModeConfigurationStage(reason+'_failed','failed');}
      catch (publicationError) {error.modePublicationError=String(publicationError?.code || 'MODE_PUBLICATION_UNAVAILABLE');}
      throw error;
    }
  };
  // END CORE OWNER MODE PUBLICATION DIAGNOSTICS v1

  const parseScopeRegistry = raw => {
    let source = raw;
    if (typeof source === 'string') { try { source = JSON.parse(source); } catch (_) { source = null; } }
    source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const entries = {};
    const incoming = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries) ? source.entries : {};
    for (const [scopeIdRaw, rowRaw] of Object.entries(incoming)) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const scope = ['libra','hayaku','flashback'].includes(namespace)&&scopeRoutingEnabled&&options.storagePolicy!=='local_only'
        ? strictOwnerScopeDescriptor(row,scopeIdRaw) : normalizeScopeDescriptor(row, scopeIdRaw);
      if (!scope.scopeId) continue;
      entries[scope.scopeId] = { ...scope, mode: normalizeMode(row.mode), updatedAt: Math.max(0, Number(row.updatedAt || 0) || 0), source: String(row.source || 'registry').slice(0, 100) };
    }
    return {
      ...source,
      schema: SCOPE_ROUTING_SCHEMA,
      version: 1,
      namespace,
      pluginId,
      defaultMode: MODE_PLUGIN_ONLY,
      updatedAt: Math.max(0, Number(source.updatedAt || 0) || 0),
      legacyGlobalModeImported: source.legacyGlobalModeImported === true,
      entries
    };
  };

  const mergeScopeRegistries = (...values) => {
    const result = parseScopeRegistry(null);
    for (const value of values) {
      const registry = parseScopeRegistry(value);
      // Preserve future/owner metadata rather than stripping it on an unrelated write.
      for (const [key,item] of Object.entries(registry)) {
        if (['schema','version','namespace','pluginId','defaultMode','updatedAt','legacyGlobalModeImported','entries'].includes(key)) continue;
        if (key === 'modePublication' && modePublicationRecordValid(result[key]) && modePublicationRecordValid(item)
            && result[key].revision > item.revision) continue;
        Object.defineProperty(result,key,{value:item,writable:true,enumerable:true,configurable:true});
      }
      result.legacyGlobalModeImported = result.legacyGlobalModeImported || registry.legacyGlobalModeImported;
      result.updatedAt = Math.max(result.updatedAt, registry.updatedAt);
      for (const [scopeId, row] of Object.entries(registry.entries)) {
        const previous = result.entries[scopeId];
        if (!previous || Number(row.updatedAt || 0) >= Number(previous.updatedAt || 0)) result.entries[scopeId] = row;
      }
    }
    return result;
  };

  // Diagnostic hooks belong to the shared source, not hand-edited embeds.
  const reportStorageFailure = (tag, error) => {
    try { globalThis.__librarianDiag?.(namespace, tag, error); } catch (_) {}
  };
  let scopeRegistryWriteTail = Promise.resolve();
  const writeScopeRegistryLocal = (registryValue, detail) => withOwnerOperation({kind:'storage_operation',operation:'writeScopeRegistryLocal'}, () => writeScopeRegistryLocalImpl(registryValue, detail));
  const writeScopeRegistryLocalImpl = (registryValue, detail) => {
    if (modePublicationEnabled) modePublicationGeneration();
    const requested = parseScopeRegistry(registryValue);
    const task = scopeRegistryWriteTail.catch(() => {}).then(async () => {
      // A queued caller may have loaded its snapshot before another scope saved.
      // Merge after acquiring the write turn so unrelated entries survive.
      const registry = mergeScopeRegistries(await loadScopeRegistry(true, false), requested);
      registry.updatedAt = Date.now();
      if (modePublicationEnabled) registry.modePublication = await createModePublication(registry, registry.modePublication, detail);
      const payload = JSON.stringify(registry);
      let success = false;
      const pluginStore = rawPluginStorage();
      if (pluginStore?.setItem) {
        try {
          const result = await pluginStore.setItem(SCOPE_ROUTING_LOCAL_KEY, payload);
          if (result !== false) {
            const readback = await pluginStore.getItem?.(SCOPE_ROUTING_LOCAL_KEY);
            success = String(readback || '') === payload;
          }
        } catch (error) { reportStorageFailure('scope.routing.plugin.write', error); }
      }
      const deviceStore = await rawDeviceStorage().catch(() => null);
      if (deviceStore?.setItem) {
        try {
          const result = await deviceStore.setItem(SCOPE_ROUTING_LOCAL_KEY, payload);
          const readback = await deviceStore.getItem?.(SCOPE_ROUTING_LOCAL_KEY);
          if (result !== false && String(readback || '') === payload) success = true;
        } catch (error) { reportStorageFailure('scope.routing.device.write', error); }
      }
      if (!success) {
        state.scopeRouting.registry = null;
        state.scopeRouting.registryLoaded = false;
        scopeRegistryGeneration += 1;
        state.scopeRouting.routeCache.clear();
        const error = new Error('memory_suite_scope_routing_storage_unavailable');
        error.code = 'MEMORY_SUITE_SCOPE_ROUTING_STORAGE_UNAVAILABLE';
        throw error;
      }
      state.scopeRouting.registry = registry;
      state.scopeRouting.registryLoaded = true;
      state.scopeRouting.registryCheckedAt = Date.now();
      scopeRegistryGeneration += 1;
      state.scopeRouting.routeCache.clear();
      return registry;
    });
    scopeRegistryWriteTail = task;
    return task;
  };

  // Another tab or bridge can switch a scope's mode in shared storage. A loaded registry is
  // re-read after a short TTL so routing follows the switch; unchanged, the route cache stays.
  // Bounded: archive and ledger scans touch many distinct keys in one chat.
  const routeCacheLimit = 2048;
  const rememberRoute = (cacheKey, route) => {
    const cache = state.scopeRouting.routeCache;
    cache.delete(cacheKey);
    cache.set(cacheKey, route);
    while (cache.size > routeCacheLimit) cache.delete(cache.keys().next().value);
  };
  const scopeRegistryRevalidateMs = 2000;
  let scopeRegistryGeneration = 0;
  const loadScopeRegistry = async (force = false, tryServer = false) => {
    const loaded = state.scopeRouting.registryLoaded && state.scopeRouting.registry;
    const fresh = Date.now() - Number(state.scopeRouting.registryCheckedAt || 0) < scopeRegistryRevalidateMs;
    if (!force && loaded && fresh) return state.scopeRouting.registry;
    if (!force && state.scopeRouting.registryLoading) return await state.scopeRouting.registryLoading;
    const revalidating = !force && loaded;
    const generation = scopeRegistryGeneration;
    const task = (async () => {
      let pluginRaw = null, deviceRaw = null, serverRaw = null;
      const pluginStore = rawPluginStorage();
      try { pluginRaw = await pluginStore?.getItem?.(SCOPE_ROUTING_LOCAL_KEY); } catch (error) { reportStorageFailure('storage.scope.route.read.plugin', error); }
      const deviceStore = await rawDeviceStorage().catch(() => null);
      try { deviceRaw = await deviceStore?.getItem?.(SCOPE_ROUTING_LOCAL_KEY); } catch (error) { reportStorageFailure('storage.scope.route.read.device', error); }
      if (tryServer && !pluginRaw && !deviceRaw) {
        try {
          const remote = await remoteGet('plugin', SCOPE_ROUTING_SERVER_KEY, { allowPluginOnly: true });
          if (remote.exists === true) serverRaw = remote.value;
        } catch (error) { reportStorageFailure('storage.scope.route.read.server', error); }
      }
      const registry = mergeScopeRegistries(serverRaw, pluginRaw, deviceRaw);
      // A local registry write that landed meanwhile is newer than this read.
      if (generation !== scopeRegistryGeneration && state.scopeRouting.registryLoaded && state.scopeRouting.registry) return state.scopeRouting.registry;
      state.scopeRouting.registryCheckedAt = Date.now();
      if (revalidating && JSON.stringify(registry) === JSON.stringify(state.scopeRouting.registry)) return state.scopeRouting.registry;
      state.scopeRouting.registry = registry;
      state.scopeRouting.registryLoaded = true;
      state.scopeRouting.routeCache.clear();
      return registry;
    })();
    state.scopeRouting.registryLoading = task;
    try { return await task; } finally { state.scopeRouting.registryLoading = null; }
  };

  const synchronizeScopeRegistryToServer = (...args) => withOwnerOperation({kind:'storage_operation',operation:'synchronizeScopeRegistryToServer'}, () => synchronizeScopeRegistryToServerImpl(...args));
  const synchronizeScopeRegistryToServerImpl = async registryValue => {
    const registry = parseScopeRegistry(registryValue || await loadScopeRegistry());
    try {
      await remoteMutate('set', 'plugin', SCOPE_ROUTING_SERVER_KEY, registry, { allowPluginOnly: true });
      return true;
    } catch (error) {
      setStatus('scope_route_server_pending', error?.message || error);
      return false;
    }
  };

  const hydrateScopeRegistryFromServer = (...args) => withOwnerOperation({kind:'storage_operation',operation:'hydrateScopeRegistryFromServer'}, () => hydrateScopeRegistryFromServerImpl(...args));
  const hydrateScopeRegistryFromServerImpl = async () => {
    if (!scopeRoutingEnabled) return null;
    try {
      const remote = await remoteGet('plugin', SCOPE_ROUTING_SERVER_KEY, { allowPluginOnly:true });
      if (remote.exists !== true || !remote.value) return null;
      const local = await loadScopeRegistry(false, false);
      const merged = mergeScopeRegistries(remote.value, local);
      const saved = await writeScopeRegistryLocal(merged);
      state.scopeRouting.routeCache.clear();
      setStatus('scope_routes_hydrated', '', { routeCount:Object.keys(saved.entries || {}).length });
      return saved;
    } catch (error) {
      // Scope metadata hydration is best-effort. It must never prevent plugin UI,
      // request hooks, or plugin-only scopes from starting while the server is down.
      setStatus('scope_routes_server_unavailable', error?.message || error);
      return null;
    }
  };

  const compactRestoreEvidence = value => {
    if (value == null) return null;
    try {
      const json = JSON.stringify(value);
      if (json.length <= 12000) return JSON.parse(json);
      return { truncated:true, preview:json.slice(0, 11000) };
    } catch (_) { return { preview:compact(value, 1000) }; }
  };

  const recoveryLockForScope = async scopeInput => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(false));
    if (!scope.scopeId) return null;
    const registry = await loadScopeRegistry(false, false);
    const row = registry?.entries?.[scope.scopeId];
    const lock = row?.recoveryRequired;
    if (!lock) return null;
    return lock && typeof lock === 'object'
      ? { ...lock, scopeId:scope.scopeId }
      : { schema:'memory-suite.recovery-required.v1', scopeId:scope.scopeId, required:true, reason:String(row?.recoveryReason || 'restore_failed') };
  };

  const persistRecoveryRequired = async (scopeInput, error, evidence = null, lockOptions = {}) => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    if (!scope.scopeId) throw error;
    const registry = await loadScopeRegistry(true, lockOptions.localOnly !== true);
    const now = Date.now();
    const previous = registry.entries[scope.scopeId] || {};
    const validation = compactRestoreEvidence(error?.validation || error?.result?.validation || evidence?.validation || null);
    const metrics = compactRestoreEvidence(error?.metrics || error?.result?.metrics || evidence?.metrics || null);
    const lock = {
      schema:'memory-suite.recovery-required.v1', required:true, namespace, pluginId,
      scopeId:scope.scopeId, scopeLabel:scope.label, at:now,
      code:String(error?.code || 'MEMORY_SUITE_SCOPE_RESTORE_INCOMPLETE'),
      reason:compact(error?.message || error || 'restore_failed', 900),
      validation, metrics,
      evidence:compactRestoreEvidence(evidence || error?.result || null)
    };
    registry.entries[scope.scopeId] = {
      ...previous, ...scope, mode:MODE_SERVER_ONLY, recoveryRequired:lock,
      recoveryState:'required', recoveryReason:lock.reason, updatedAt:now, source:'restore_failed_recovery_required'
    };
    registry.legacyGlobalModeImported = true;
    const saved = await writeScopeRegistryLocal(registry);
    state.scopeRouting.transientModes.delete(scope.scopeId);
    state.config = { ...state.config, at:Date.now(), mode:MODE_SERVER_ONLY };
    if (lockOptions.localOnly !== true) await synchronizeScopeRegistryToServer(saved);
    setStatus('recovery_required', lock.reason, { scopeId:scope.scopeId, scopeLabel:scope.label, mode:MODE_SERVER_ONLY, recoveryRequired:true, recovery:lock });
    return lock;
  };

  const clearRecoveryRequired = async scopeInput => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    if (!scope.scopeId) return null;
    const registry = await loadScopeRegistry(true, false);
    const previous = registry.entries[scope.scopeId];
    if (!previous?.recoveryRequired) return null;
    const next = { ...previous, ...scope, updatedAt:Date.now(), source:'restore_verified_recovery_cleared' };
    delete next.recoveryRequired;
    delete next.recoveryState;
    delete next.recoveryReason;
    registry.entries[scope.scopeId] = next;
    const saved = await writeScopeRegistryLocal(registry);
    await synchronizeScopeRegistryToServer(saved);
    setStatus('recovery_cleared', '', { scopeId:scope.scopeId, scopeLabel:scope.label, mode:normalizeMode(next.mode), recoveryRequired:false });
    return { scopeId:scope.scopeId, cleared:true, at:Date.now() };
  };

  const recoveryRequiredError = (scope, lock, action = 'operation') => {
    const error = new Error(`memory_suite_recovery_required:${scope?.scopeId || ''}:${action}`);
    error.code = 'MEMORY_SUITE_RECOVERY_REQUIRED';
    error.scope = scope;
    error.recovery = lock;
    error.recoveryLock = lock;
    error.userMessage = '서버에서 pluginStorage 복구가 완전히 검증되지 않았습니다. 서버 단독을 유지한 채 복구를 다시 완료해 주세요.';
    return error;
  };

  const assertRecoveryActionAllowed = async (scopeInput, action = 'operation') => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    const lock = await recoveryLockForScope(scope);
    if (lock) throw recoveryRequiredError(scope, lock, action);
    return scope;
  };

  const resolveCurrentScope = async (force = false) => {
    if (!scopeRoutingEnabled) return normalizeScopeDescriptor({ scopeId: '__plugin_global__', scopeKey: '__plugin_global__', label: `${displayName} 전역`, global: true });
    if (!force && scopeCacheMs > 0 && state.scopeRouting.current?.scopeId && Date.now() - Number(state.scopeRouting.currentAt || 0) < scopeCacheMs) return state.scopeRouting.current;
    let value = null;
    try { value = currentScopeProvider ? await currentScopeProvider({ namespace, pluginId, pluginVersion, force }) : await defaultCurrentScope(); }
    catch (error) { setStatus('scope_unavailable', error?.message || error); }
    const scope = normalizeScopeDescriptor(value);
    const previousScopeId = String(state.scopeRouting.current?.scopeId || '');
    state.scopeRouting.current = scope;
    state.scopeRouting.currentAt = Date.now();
    // Re-reading the same active chat must not throw away every resolved key
    // route. The old unconditional clear multiplied host-context work across a
    // ledger/archive scan even though the scope had not changed.
    if (previousScopeId !== String(scope.scopeId || '')) state.scopeRouting.routeCache.clear();
    return scope;
  };

  const registryEntryByAlias = (registry, aliasValue) => {
    const alias = String(aliasValue || '').trim();
    if (!alias) return null;
    for (const row of Object.values(registry?.entries || {})) {
      if (row.scopeId === alias || row.scopeKey === alias || (Array.isArray(row.aliases) && row.aliases.includes(alias))) return row;
    }
    return null;
  };

  const resolveScopeByAlias = async (aliasValue, options = {}) => {
    const alias = String(aliasValue || '').trim();
    if (!alias) return null;
    const force = options?.force !== false;
    let registry = await loadScopeRegistry(force, false);
    let row = registryEntryByAlias(registry, alias);
    if (!row && options?.tryServer !== false) {
      registry = await loadScopeRegistry(true, true);
      row = registryEntryByAlias(registry, alias);
    }
    const scope = normalizeScopeDescriptor(row || null);
    return scope?.scopeId ? scope : null;
  };

  const maybeImportLegacyGlobalMode = async (scope, registry) => {
    if (!scope?.scopeId || registry.entries[scope.scopeId] || registry.legacyGlobalModeImported) return registry;
    const legacyMode = normalizeMode(await getArgumentValue(modeArguments, MODE_PLUGIN_ONLY));
    registry.legacyGlobalModeImported = true;
    if (legacyMode !== MODE_PLUGIN_ONLY) {
      registry.entries[scope.scopeId] = { ...scope, mode: legacyMode, updatedAt: Date.now(), source: 'legacy_global_mode_current_scope' };
      state.scopeRouting.lastLegacyImport = { scopeId: scope.scopeId, mode: legacyMode, at: Date.now() };
    }
    const saved = await writeScopeRegistryLocal(registry);
    try { await withModePublication('legacy_import_reset', () => setArgumentValue(modeArguments[0] || 'memory_suite_server_mode', MODE_PLUGIN_ONLY)); } catch (_) {}
    return saved;
  };

  const readScopeModeValue = async (scopeInput = null, force = false) => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(force));
    if (!scope.scopeId) return { scope, mode: MODE_PLUGIN_ONLY, modeLabel: modeLabel(MODE_PLUGIN_ONLY), explicit: false };
    // The global entry itself is read directly, never through inheritance.
    if (isGlobalScopeId(scope.scopeId)) {
      const globalRegistry = await loadScopeRegistry(force, false);
      const globalStored = liveGlobalRow(globalRegistry);
      const globalMode = normalizeMode(globalStored?.mode || MODE_PLUGIN_ONLY);
      return { scope, mode: globalMode, modeLabel: modeLabel(globalMode), explicit: !!globalStored, modeOrigin: String(globalStored?.origin || ''), global: true };
    }
    let registry = await loadScopeRegistry(force, false);
    if (!globalModeEnabled && (!scopeInput || scope.scopeId === state.scopeRouting.current?.scopeId)) registry = await maybeImportLegacyGlobalMode(scope, registry);
    const stored = registry.entries[scope.scopeId];
    const transient = state.scopeRouting.transientModes.get(scope.scopeId);
    const choice=await qualifyResetChoiceForScope(scope);
    if (resetPreferenceMatches(choice, state.bootstrap.value) && (choice?.choice==='empty' || deletedScopesForResetChoice(choice).includes(scope.scopeId))) return { scope: stored ? normalizeScopeDescriptor(stored, scope.scopeId) : scope, mode: MODE_SERVER_ONLY, modeLabel: modeLabel(MODE_SERVER_ONLY), explicit: false, modeOrigin: choice.choice==='empty' ? '' : 'deleted_scope' };
    if (VALID_MODES.has(transient)) return { scope: stored ? normalizeScopeDescriptor(stored, scope.scopeId) : scope, mode: transient, modeLabel: modeLabel(transient), explicit: false, modeOrigin: 'transient' };
    if (stored) {
      // A mode written by automatic inheritance/migration is not a user choice.
      // Only a user_scope_setting (or a legacy entry without an explicit origin)
      // counts as explicit so automatic lineage never overrides a user selection.
      const origin = String(stored.origin || '');
      const explicit = origin !== 'inherited' && origin !== 'migrated';
      if (explicit) return { scope: normalizeScopeDescriptor(stored, scope.scopeId), mode: normalizeMode(stored.mode), modeLabel: modeLabel(normalizeMode(stored.mode)), explicit: true, modeOrigin: origin, pendingTargetMode:origin === 'transition_pending' ? normalizeMode(stored.pendingTargetMode) : null, transitionStartedAt:Number(stored.updatedAt || 0) };
    }
    // No entry of its own, or only an inherited/migrated one: the global choice governs. With no
    // global entry stored either, this falls back to plugin_only exactly as before.
    const globalStored = liveGlobalRow(registry);
    if (globalStored) {
      const globalMode = normalizeMode(globalStored.mode || MODE_PLUGIN_ONLY);
      return { scope: stored ? normalizeScopeDescriptor(stored, scope.scopeId) : scope, mode: globalMode, modeLabel: modeLabel(globalMode), explicit: false, modeOrigin: 'global', inheritedFromGlobal: true };
    }
    const fallbackMode = stored ? normalizeMode(stored.mode) : globalModeEnabled && !registry.legacyGlobalModeImported ? normalizeMode(await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY)) : MODE_PLUGIN_ONLY;
    return { scope: stored ? normalizeScopeDescriptor(stored, scope.scopeId) : scope, mode: fallbackMode, modeLabel: modeLabel(fallbackMode), explicit: false, modeOrigin: String(stored?.origin || '') };
  };
  const readScopeMode = async (scopeInput = null, force = false) => {
    const value = await readScopeModeValue(scopeInput, force);
    const pending = value.pendingTargetMode && value.pendingTargetMode !== value.mode;
    const transition = storageTransition && storageTransition.scopeId === value.scope.scopeId ? {...storageTransition}
      : pending ? {schema:'memory-suite.storage-transition.v1',scopeId:value.scope.scopeId,fromMode:value.mode,toMode:value.pendingTargetMode,effectiveMode:value.mode,phase:'pending',startedAt:value.transitionStartedAt} : null;
    return {...value, ...modeLifecycle(value.mode), migrationRequired:value.mode === MODE_MIRROR || Boolean(pending), transition, storagePhase:transition ? MODE_MIRROR : value.mode};
  };
  const scopeExecutionPolicyFromModeState = modeState => {
    const storageMode = normalizeMode(modeState?.mode || MODE_PLUGIN_ONLY);
    const serverBacked = storageMode !== MODE_PLUGIN_ONLY;
    const scope = normalizeScopeDescriptor(modeState?.scope || null);
    return Object.freeze({
      schema: 'memory-suite.scope-execution-policy.v1',
      namespace,
      pluginId,
      scope,
      scopeId: scope.scopeId || '',
      storageMode,
      storageModeLabel: modeLabel(storageMode),
      ...modeLifecycle(storageMode), migrationRequired:modeState?.migrationRequired === true, transition:modeState?.transition || null,
      storagePhase:modeState?.storagePhase || storageMode,
      configuredRoute: serverBacked ? 'server' : 'local',
      lockedByStorageMode: true,
      serverBacked
    });
  };
  const getScopeExecutionPolicy = async (scopeInput = null, policyOptions = {}) => {
    const optionsValue = policyOptions && typeof policyOptions === 'object' ? policyOptions : {};
    try {
      return scopeExecutionPolicyFromModeState(await readScopeMode(scopeInput, optionsValue.force === true));
    } catch (error) {
      const scope = normalizeScopeDescriptor(scopeInput || state.scopeRouting.current || null);
      setStatus('scope_execution_policy_local_fallback', error?.message || error, { scopeId: scope.scopeId || '', mode: MODE_PLUGIN_ONLY });
      return scopeExecutionPolicyFromModeState({ scope, mode: MODE_PLUGIN_ONLY });
    }
  };

  // BEGIN QUALIFIED SERVER SEMANTIC ROUTES v1
  // Authenticated server settings are separate from ordinary native publication.
  // Stock RisuAI cannot certify atomic native cutover or full-corpus eligibility.
  const serverRouteError=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
  const serverRouteCanonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
  const serverRouteConnection=()=>{
    const connection=state.bootstrap.value;
    return ['libra','hayaku','flashback'].includes(namespace)&&connection?.dataIdentityCertified===true
      &&connection.capabilities?.['core3-semantic-route.v1']===true
      &&connection.authorityRuntime?.authorityProfile==='memory-suite.authority-profile.core3.v2'
      &&connection.authorityRuntime?.serverSemanticRouteAuthority===true?connection:null;
  };
  const requireServerRouteConnection=()=>{const c=serverRouteConnection();if(!c)throw serverRouteError('SERVER_MODE_AUTHORITY_UNAVAILABLE');return c;};
  const serverRouteRequest=async(connection,action,body)=>{
    const generation=dataBinding.generation;await assertConnectionCurrent(connection,generation);
    if(serverRouteConnection()!==connection)throw serverRouteError('SERVER_MODE_AUTHORITY_CHANGED');
    const payload=await request('POST','/v1/authority/'+action,body,{allowPluginOnly:true,authRetry:false,bindingGeneration:generation});
    await assertConnectionCurrent(connection,generation);
    if(serverRouteConnection()?.dataInstanceId!==connection.dataInstanceId||!serverRouteConnection())throw serverRouteError('SERVER_MODE_AUTHORITY_CHANGED');
    return payload.result;
  };
  const inspectServerModeAuthority=async scopeInput=>{
    const connection=serverRouteConnection();if(!connection)return Object.freeze({status:'unsupported',semanticModeEpoch:null,nativeAuthority:'unavailable'});
    const scope=normalizeScopeDescriptor(scopeInput||await resolveCurrentScope(true));
    if(!scope.scopeId||!scope.scopeKey)throw serverRouteError('SERVER_MODE_SCOPE_UNAVAILABLE');
    const selection=await serverRouteRequest(connection,'route/read',{scopeId:scope.scopeId,scopeKey:scope.scopeKey});
    if(selection?.schema!=='memory-suite.authority-route-selection.v1'||selection.namespace!==namespace||selection.scopeId!==scope.scopeId||selection.scopeKey!==scope.scopeKey)throw serverRouteError('SERVER_MODE_AUTHORITY_INVALID');
    return Object.freeze({status:selection.route?'observed':'absent',...selection,nativeAuthority:'unavailable',recallEligibility:'unqualified'});
  };
  const prepareServerModePublication=async(scope,mode,overrideKind)=>{
    const connection=serverRouteConnection();if(!connection)return null;
    const target={scopeId:scope.scopeId,scopeKey:scope.scopeKey,mode,overrideKind};
    const store=rawPluginStorage(),key=`__memory_suite_internal_server_route_v1__:${namespace}:${encodeURIComponent(scope.scopeId)}`;
    if(typeof store?.getItem!=='function'||typeof store?.setItem!=='function'||typeof store?.removeItem!=='function')throw serverRouteError('SERVER_MODE_JOURNAL_UNAVAILABLE');
    const raw=await store.getItem(key);let saved;
    if(raw!=null){try{if(typeof raw!=='string'||raw.length>32768)throw 0;saved=JSON.parse(raw);}catch(_){throw serverRouteError('SERVER_MODE_JOURNAL_INVALID');}
      if(saved?.schema!=='memory-suite.pending-server-route.v1'||saved.namespace!==namespace||saved.dataInstanceId!==connection.dataInstanceId||saved.url!==connection.url||serverRouteCanonical(saved.body?.target)!==serverRouteCanonical(target))throw serverRouteError('SERVER_MODE_OPERATION_PENDING');
      return {connection,store,key,saved};
    }
    const selection=await serverRouteRequest(connection,'route/read',{scopeId:scope.scopeId,scopeKey:scope.scopeKey});
    if(selection?.schema!=='memory-suite.authority-route-selection.v1'||selection.namespace!==namespace)throw serverRouteError('SERVER_MODE_AUTHORITY_INVALID');
    const expectedRoute=selection.dependencies?.own||null;
    if(expectedRoute&&serverRouteCanonical(Object.fromEntries(['scopeId','scopeKey','mode','overrideKind'].map(k=>[k,expectedRoute[k]])))===serverRouteCanonical(target))return null;
    if(typeof globalThis.crypto?.randomUUID!=='function')throw serverRouteError('SERVER_MODE_RANDOM_UNAVAILABLE');
    saved={schema:'memory-suite.pending-server-route.v1',namespace,dataInstanceId:connection.dataInstanceId,url:connection.url,body:{operationId:'route:'+globalThis.crypto.randomUUID(),expectedRoute,target}};
    const encoded=JSON.stringify(saved);if(encoded.length>32768)throw serverRouteError('SERVER_MODE_JOURNAL_LIMIT');
    if(await store.setItem(key,encoded)===false||await store.getItem(key)!==encoded)throw serverRouteError('SERVER_MODE_JOURNAL_UNAVAILABLE');
    return {connection,store,key,saved};
  };
  const publishPreparedServerMode=async prepared=>{
    if(!prepared)return null;const {connection,store,key,saved}=prepared;let receipt;
    try{receipt=await serverRouteRequest(connection,'route/transition',saved.body);}
    catch(error){
      // Lost ACK is not a failed transition. Keep the persisted operation ID and
      // query its durable status; no replacement operation is allocated.
      try{const status=await serverRouteRequest(connection,'route/status',{operationId:saved.body.operationId});if(status?.status==='committed')receipt=status.receipt;}catch(_){}
      if(!receipt)throw serverRouteError('SERVER_MODE_OPERATION_INDETERMINATE',{operationId:saved.body.operationId,cause:error});
    }
    if(receipt?.schema!=='memory-suite.authority-route-receipt.v1'||receipt.operationId!==saved.body.operationId||receipt.physicalBinding?.dataInstanceId!==saved.dataInstanceId
      ||receipt.route?.namespace!==namespace||!Number.isSafeInteger(receipt.route.modeEpoch)||receipt.route.modeEpoch<1||receipt.nativeAuthority!=='unavailable'
      ||serverRouteCanonical(receipt.request)!==serverRouteCanonical({namespace,...saved.body}))throw serverRouteError('SERVER_MODE_RECEIPT_INVALID');
    if(await store.removeItem(key)===false||await store.getItem(key)!=null)throw serverRouteError('SERVER_MODE_JOURNAL_CLEANUP_UNAVAILABLE',{operationId:saved.body.operationId});
    return receipt;
  };
  const serverObservationHandles=new WeakMap();
  const serverObservationState=input=>{
    const s=input&&serverObservationHandles.get(input.handle);
    if(!s||s.requestId!==input.requestId)throw serverRouteError('INVALID_SERVER_OBSERVATION_HANDLE');
    if(s.released)throw serverRouteError('OBSERVATION_RELEASED');return s;
  };
  const observeServerBackend=async(input,sourceClosure=false)=>{
    if(namespace!=='libra')throw serverRouteError('SOURCE_PROOF_UNAVAILABLE');
    const connection=requireServerRouteConnection(),result=await serverRouteRequest(connection,sourceClosure?'libra/observe-closure':'libra/observe',{namespace,requestId:input.requestId,scopeId:input.scopeId,scopeKey:input.scopeKey,...(sourceClosure?{throughTurn:input.throughTurn}:{starts:input.starts}),durationMs:input.durationMs});
    if(typeof result?.handle!=='string'||result.summary?.requestId!==input.requestId||result.summary?.captureWitness?.physicalBinding?.dataInstanceId!==connection.dataInstanceId||result.summary?.nativeAuthority!=='unavailable')throw serverRouteError('SERVER_OBSERVATION_INVALID');
    const handle=Object.freeze({});serverObservationHandles.set(handle,{connection,token:result.handle,requestId:input.requestId,released:false});return Object.freeze({handle,summary:Object.freeze(result.summary)});
  };
  const serverObservationAction=async(action,input)=>{const s=serverObservationState(input),result=await serverRouteRequest(s.connection,'libra/'+action,{handle:s.token,requestId:s.requestId});if(action==='release')s.released=true;return result;};
  // END QUALIFIED SERVER SEMANTIC ROUTES v1

  const persistScopedMode = async (modeValue, scopeInput = null, persistOptions = {}) => {
    const target = requireOperationalMode(modeValue);
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    if (!scope.scopeId || scope.available === false) {
      const error = new Error('memory_suite_current_scope_unavailable');
      error.code = 'MEMORY_SUITE_SCOPE_UNAVAILABLE';
      throw error;
    }
    const registry = parseScopeRegistry(await loadScopeRegistry(true, false));
    const origin = String(persistOptions.origin || 'user_explicit');
    const serverPublication=await prepareServerModePublication(scope,target,['inherited','migrated'].includes(origin)?'inherited':'explicit');
    registry.entries[scope.scopeId] = { ...(registry.entries[scope.scopeId] || {}), ...scope, mode: target, origin, updatedAt: Math.max(Date.now(),Number(registry.entries[scope.scopeId]?.updatedAt || 0)+1), source: String(persistOptions.source || 'user_scope_setting'), ...(persistOptions.globalMigrationJobId?{globalMigrationJobId:persistOptions.globalMigrationJobId,pendingTargetMode:target}:{}) };
    registry.legacyGlobalModeImported = true;
    const saved = await writeScopeRegistryLocal(registry);
    if (saved.entries[scope.scopeId]?.mode !== target) throw Object.assign(new Error('memory_suite_mode_readback_mismatch'),{code:'MEMORY_SUITE_MODE_READBACK_MISMATCH'});
    await publishPreparedServerMode(serverPublication);
    state.scopeRouting.transientModes.delete(scope.scopeId);
    state.config = { ...state.config, at: Date.now(), mode: target };
    // Entering plugin-only is a hard network boundary.  Do not immediately
    // reconnect merely to publish the route registry that disabled the server.
    // A later explicit connection/sync action can publish it if requested.
    if (target !== MODE_PLUGIN_ONLY && !globalJobRunning) void synchronizeScopeRegistryToServer(saved).catch(error => reportStorageFailure('scope.registry.sync.admission', error));
    setStatus('scope_mode_changed', '', { scopeId: scope.scopeId, scopeLabel: scope.label, mode: target, modeLabel: modeLabel(target) });
    return { scope, mode: target, modeLabel: modeLabel(target), registry: saved };
  };

  // The global choice is stored as one reserved entry in the same registry every scope uses, so it
  // travels with the existing local/device/server copies and merge logic unchanged. Writing it must
  // Core3 retires legacy overrides only after the whole known inventory is verified.
  // Other consumers retain their legacy follower-only behavior below.
  // BEGIN CORE3 GLOBAL ALL-CHAT MIGRATION v1
  // Per-plugin observation and resumable coordination, not a cross-host lease.
  const globalModeEnabled = ['libra','hayaku','flashback'].includes(namespace)
    && scopeRoutingEnabled && options.storagePolicy !== 'local_only' && options.storagePolicy !== 'manager_only';
  let globalMigrationContext = null;
  let globalJobRunning = false;
  const globalModeError = (code, details) => Object.assign(new Error(code), {code, ...(details ? {details} : {})});
  const globalCanonical = value => JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
  const globalDigest = async value => {
    const text=globalCanonical(value);
    if(typeof text !== 'string' || typeof globalThis.crypto?.subtle?.digest !== 'function') throw globalModeError('MEMORY_SUITE_GLOBAL_FINGERPRINT_UNAVAILABLE');
    const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  };
  const globalExactJson = value => {
    const seen = new Set();
    const walk = item => {
      if (item === null) return 'null';
      if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
      if (typeof item !== 'object' || seen.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error('non_json_value');
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (prototype !== null) {
        const constructor = Object.getOwnPropertyDescriptor(prototype,'constructor')?.value;
        if (typeof constructor !== 'function'
          || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(array ? Array : Object)
          || (!array && Object.getPrototypeOf(prototype) !== null)) throw new Error('non_json_value');
        for (let inherited=prototype; inherited; inherited=Object.getPrototypeOf(inherited)) {
          if (Object.getOwnPropertyDescriptor(inherited,'toJSON')) throw new Error('non_json_value');
        }
      }
      const names = Object.getOwnPropertyNames(item), keys = Object.keys(item);
      if (array ? names.length !== item.length + 1 || keys.length !== item.length : names.length !== keys.length) throw new Error('non_json_value');
      seen.add(item);
      const read = key => {
        const descriptor = Object.getOwnPropertyDescriptor(item,key);
        if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) throw new Error('non_json_value');
        return walk(descriptor.value);
      };
      const result = array
        ? '[' + Array.from({length:item.length},(_,index)=>read(String(index))).join(',') + ']'
        : '{' + keys.sort().map(key=>JSON.stringify(key)+':'+read(key)).join(',') + '}';
      seen.delete(item);
      return result;
    };
    return walk(value);
    };
  const globalRecordIdentity = row => [row.location,row.space,row.key].join('\u0000');
  const globalRecordScopeIds = row => row.classification === 'shared'
    ? (Array.isArray(row.dependencyScopeIds) ? row.dependencyScopeIds.map(String) : []) : [String(row.scopeId || '')];
  const globalPayloadRecord = row => ['scope','shared'].includes(row.classification) && row.artifact !== true;
  const globalScopeDescriptorOnly = row => {
    const scope=Object.fromEntries(['scopeId','scopeKey','characterId','chatId','canonicalCharacterId','canonicalChatId','canonicalScopeId','personaId','characterName','chatTitle','personaName','label','available'].map(key=>[key,row[key]]).filter(([,value])=>value !== undefined));
    scope.scopeKey=scope.scopeKey||scope.scopeId;
    scope.aliases=[...new Set(Array.isArray(row.aliases)?row.aliases:[])].sort();
    if(typeof scope.scopeId!=='string'||!scope.scopeId||typeof scope.scopeKey!=='string'||!scope.scopeKey
      || /[\0\r\n]/.test(scope.scopeId+scope.scopeKey)||scope.aliases.some(alias=>typeof alias!=='string'||/[\0\r\n]/.test(alias)))throw globalModeError('MEMORY_SUITE_GLOBAL_OWNER_IDENTITY_INVALID');
    for(const field of ['canonicalCharacterId','canonicalChatId','canonicalScopeId'])if(scope[field]===undefined)scope[field]='';
    scope.globalInventoryIdentity='memory-suite.strict-owner-scope.v1';
    return scope;
  };
  const globalReadRegistry = (raw, location, blockers) => {
    if(raw == null || raw === '')return parseScopeRegistry(null);
    let value;try{value=typeof raw === 'string'?JSON.parse(raw):raw;}catch(_){blockers.push({code:'routing_registry_malformed',location});return parseScopeRegistry(null);}
    if(!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCOPE_ROUTING_SCHEMA
      || value.namespace && value.namespace !== namespace || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
      blockers.push({code:'routing_registry_malformed',location});return parseScopeRegistry(null);
    }
    for(const [id,row] of Object.entries(value.entries))if(!id || !row || typeof row !== 'object' || Array.isArray(row)
      || row.scopeId && row.scopeId !== id || !VALID_MODES.has(row.mode))blockers.push({code:'routing_entry_malformed',location,scopeId:id});
    for(const [id,row]of Object.entries(value.entries))try{strictOwnerScopeDescriptor(row,id);}catch(_){blockers.push({code:'routing_entry_identity_malformed',location,scopeId:id});}
    if(blockers.some(row=>row.location===location&&/^routing_/.test(row.code)))return parseScopeRegistry(null);
    return {...value,entries:Object.fromEntries(Object.entries(value.entries).map(([id,row])=>[id,{...row,scopeId:row.scopeId||id}]))};
  };
  const globalHostCatalog = async () => {
    const host=apiCandidates().find(api=>typeof api?.getDatabase === 'function');
    if(!host)throw globalModeError('host_catalog_api_unavailable');
    const database=await host.getDatabase(['characters']);
    if(!database || !Array.isArray(database.characters))throw globalModeError('host_catalog_unavailable_or_denied');
    const scopes=[],seen=new Set();
    for(let characterIndex=0;characterIndex<database.characters.length;characterIndex++){
      const character=database.characters[characterIndex];
      const characterId=String(character?.chaId || character?.characterId || character?.id || character?.uuid || '').trim();
      if(!characterId || !Array.isArray(character?.chats))throw globalModeError('host_character_identity_or_chats_incomplete');
      for(let chatIndex=0;chatIndex<character.chats.length;chatIndex++){
        const chat=character.chats[chatIndex],chatId=String(chat?.id || chat?.chatId || chat?.uuid || '').trim();
        if(!chatId || seen.has(characterId+'\u0000'+chatId))throw globalModeError('host_chat_identity_missing_or_duplicate');
        seen.add(characterId+'\u0000'+chatId);
        scopes.push({characterId,chatId,characterIndex,chatIndex,characterName:String(character.nickname || character.name || '').slice(0,160),
          chatTitle:String(chat.name || chat.title || '').slice(0,200),personaId:String(chat.bindedPersona || chat.boundPersonaId || chat.personaId || '')});
      }
    }
    return scopes;
  };
  const collectGlobalInventory = async (target,inventoryOptions={}) => {
    const readOnlyUnfingerprinted=inventoryOptions.readOnlyCatalog===true&&typeof globalThis.crypto?.subtle?.digest!=='function';
    const digestInventory=value=>readOnlyUnfingerprinted?Promise.resolve(''):globalDigest(value);
    const configuredUrl=await configuredServerUrlNow(),targetUrl=normalizeServerUrl(inventoryOptions.url||configuredUrl);
    const urlChanged=targetUrl!==configuredUrl;
    let inventoryRequest=null;
    if(urlChanged){
      let connection=null;
      // Existing owner authority, read-only keys/get-many only, same DATA response proof.
      inventoryRequest=async(method,route,body)=>{
        if(!connection){connection=await bootstrapAtUrl(targetUrl);durableServerPinFromConnection(connection,targetUrl);}
        if(!(method==='GET'&&route.startsWith('/v1/kv/keys?')||method==='POST'&&route==='/v1/kv/get-many'))throw globalModeError('MEMORY_SUITE_GLOBAL_INVENTORY_METHOD_INVALID');
        if(Number(connection.resetEpochs?.[namespace]||0)!==0)throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
        const payload=await fetchJson(connection.url+route,{method,headers:{Authorization:`Bearer ${connection.token}`,
          'X-Memory-Suite-Plugin':pluginId,'X-Memory-Suite-Plugin-Version':pluginVersion,'X-Memory-Suite-Storage-Mode':MODE_PLUGIN_ONLY,
          'X-Memory-Suite-Reset-Epochs':JSON.stringify(connection.resetEpochs||{}),...bindingHeaders(connection),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        assertResponseBinding(connection,payload);return payload;
      };
    }
    const blockers=[],records=[],registries=[],registryCopies=[];
    if(readOnlyUnfingerprinted)blockers.push({code:'scope_catalog_read_only_crypto_unavailable'});
    let hostScopes=[];
    try{hostScopes=await globalHostCatalog();}catch(error){blockers.push({code:String(error.code || 'host_catalog_read_failed')});}
    if(typeof options.discoverGlobalScopes !== 'function')blockers.push({code:'owner_global_discovery_unavailable'});
    const stores={plugin:rawPluginStorage(),local:await rawDeviceStorage({strict:true}).catch(error=>{blockers.push({code:'device_store_unavailable'});return null;})};
    for(const space of ['plugin','local']){
      const store=stores[space],location=space==='plugin'?'plugin':'device';
      if(store?.getItem){try{const raw=await store.getItem(SCOPE_ROUTING_LOCAL_KEY);registryCopies.push({location,raw});registries.push(globalReadRegistry(raw,location,blockers));}catch(_){blockers.push({code:'routing_registry_unavailable',location});}}
      const required=space==='plugin'||localPrefixes.length>0||localKeys.size>0;
      if(!required && !store)continue;
      if(typeof store?.getItem !== 'function'||typeof store?.keys !== 'function'){if(required)blockers.push({code:'physical_key_enumeration_unavailable',location});continue;}
      let keys;try{keys=await store.keys();}catch(_){blockers.push({code:'physical_key_enumeration_failed',location});continue;}
      if(!Array.isArray(keys)||keys.some(key=>typeof key!=='string'||!key||/[\0\r\n]/.test(key))||new Set(keys).size!==keys.length){blockers.push({code:'physical_key_enumeration_invalid',location});continue;}
      for(const key of keys.slice().sort()){
        const artifactOwnerKey=chunkOwnerKey(key),decoded=scopedRemoteKeyInfo(artifactOwnerKey||key);
        if(!matchesRoute(space,artifactOwnerKey||key)&&!matchesRoute(space,decoded.logicalKey))continue;
        try{const value=await store.getItem(key);const serialized=globalExactJson(value);if(serialized===undefined)throw 0;
          records.push({location,space,key,logicalKey:decoded.logicalKey,scopeId:decoded.scopeId,artifact:!!artifactOwnerKey,artifactOwnerKey,deleted:false,value:JSON.parse(serialized)});
        }catch(_){blockers.push({code:'physical_value_unreadable',location,space,key});}
      }
    }
    const localRegistry=mergeScopeRegistries(...registries);
    const legacyMode=normalizeMode(await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY));
    const remoteRequired=urlChanged || target!==MODE_PLUGIN_ONLY || legacyMode!==MODE_PLUGIN_ONLY || !!dataBinding.dataInstanceId
      || registryCopies.some(copy=>copy.raw != null && Object.values(globalReadRegistry(copy.raw,copy.location,[]).entries).some(row=>!isRemovedScopeRow(row)&&normalizeMode(row.mode)!==MODE_PLUGIN_ONLY))
      || registries.some(registry=>registry.globalMigrationRemoteHistory===true)
      || registryCopies.some(copy=>copy.raw!=null)&&registries.some(registry=>registry.globalMigrationRemoteHistory!==false&&Object.keys(registry.entries).length>0);
    let serverPin=null;
    // Missing host/adapter is a blocker before any connection or durable effect.
    if(remoteRequired && !blockers.some(row=>/host_|owner_global/.test(row.code))){
      try{
        serverPin=await captureDurableServerPin(targetUrl);
        for(const space of ['plugin','local']){
          const listing=await remoteKeys(space,'',{allowPluginOnly:true,strictInventory:true,inventoryRequest});
          const metadata=new Map(listing.records.map(row=>[String(row.key),row]));
          const all=[...listing.keys,...listing.tombstones];
          for(let offset=0;offset<all.length;offset+=512){
            const keys=all.slice(offset,offset+512),batch=await remoteGetMany(space,keys,{allowPluginOnly:true,strictInventory:true,inventoryRequest});
            for(const key of keys){
              const row=batch.values[key],meta=metadata.get(key);
              if(!row || !meta || row.revision!==meta.revision || row.digest!==meta.digest || Boolean(row.tombstone)!==Boolean(meta.tombstone))throw globalModeError('remote_record_changed_or_incomplete');
              if(key===SCOPE_ROUTING_SERVER_KEY){if(row.exists){registryCopies.push({location:'server',raw:row.value});registries.push(globalReadRegistry(row.value,'server',blockers));}continue;}
              const artifactOwnerKey=chunkOwnerKey(key),decoded=scopedRemoteKeyInfo(artifactOwnerKey||key);
              if(!matchesRoute(space,artifactOwnerKey||key)&&!matchesRoute(space,decoded.logicalKey)){
                if(!key.startsWith('__memory_suite_'))blockers.push({code:'remote_key_ownership_unknown',space,key});
                continue;
              }
              records.push({location:'server',space,key,logicalKey:decoded.logicalKey,scopeId:decoded.scopeId,artifact:!!artifactOwnerKey,artifactOwnerKey,
                deleted:row.tombstone===true,value:row.exists===true?row.value:null,revision:row.revision,digest:row.digest,valueBytes:meta.valueBytes});
            }
          }
        }
      }catch(error){blockers.push({code:String(error.code || error.message || 'remote_inventory_unavailable')});}
    }
    let owner={scopes:[],records:[],blockers:[],completeKnownScopes:false};
    if(typeof options.discoverGlobalScopes==='function'){
      try{owner=await options.discoverGlobalScopes({namespace,hostScopes,registries,records});}
      catch(error){blockers.push({code:'owner_global_discovery_failed',reason:String(error.code || error.message || '').slice(0,160)});}
    }
    if(!owner || !Array.isArray(owner.scopes)||!Array.isArray(owner.records)||!Array.isArray(owner.blockers))throw globalModeError('MEMORY_SUITE_GLOBAL_OWNER_CONTRACT_INVALID');
    blockers.push(...owner.blockers);
    const scopes=owner.scopes.map(globalScopeDescriptorOnly).sort((a,b)=>a.scopeId.localeCompare(b.scopeId));
    const scopeIds=new Set(scopes.map(scope=>scope.scopeId));
    if(scopeIds.size!==scopes.length||scopes.some(scope=>!scope.scopeId||scope.available===false||isGlobalScopeId(scope.scopeId)))blockers.push({code:'owner_scope_identity_invalid'});
    const classified=new Map(owner.records.map(row=>[globalRecordIdentity(row),row]));
    if(classified.size!==records.length||owner.records.length!==records.length)blockers.push({code:'owner_record_coverage_incomplete'});
    for(const row of records){
      const value=classified.get(globalRecordIdentity(row));
      if(!value||!['scope','shared','control','artifact'].includes(value.classification))blockers.push({code:'owner_record_unclassified',space:row.space,key:row.key});
      else if(globalPayloadRecord(value)&&(!globalRecordScopeIds(value).length||globalRecordScopeIds(value).some(id=>!scopeIds.has(id))))blockers.push({code:'owner_record_scope_unverified',space:row.space,key:row.key});
    }
    const registry=mergeScopeRegistries(mergeScopeRegistries(...registries));
    const modeFor=scope=>{
      const sourceRegistry=urlChanged?localRegistry:registry;
      const row=sourceRegistry.entries[scope.scopeId],global=liveGlobalRow(sourceRegistry);
      return normalizeMode(row&&!isRemovedScopeRow(row)&&!['inherited','migrated'].includes(String(row.origin||''))?row.mode
        :global?.mode || row?.mode || (!registry.legacyGlobalModeImported?legacyMode:MODE_PLUGIN_ONLY));
    };
    const scoped=scopes.map(scope=>({...scope,sourceMode:modeFor(scope)}));
    const safeRecords=[],originalByIdentity=new Map(records.map(item=>[globalRecordIdentity(item),item]));
    for(const row of owner.records){
      const original=originalByIdentity.get(globalRecordIdentity(row));
      if(!original)continue;
      const checked={...original,...(Object.hasOwn(row,'logicalValue')?{logicalValue:row.logicalValue}:{}),classification:row.classification,scopeId:String(row.scopeId||''),dependencyScopeIds:row.dependencyScopeIds||[],dependencyKeys:row.dependencyKeys||[]};
      checked.fingerprint=await digestInventory([checked.deleted,checked.value]);safeRecords.push(checked);
    }
    for(const row of safeRecords){
      if(row.location!=='server'||row.deleted||!globalPayloadRecord(row))continue;
      const lacksLocal=!safeRecords.some(local=>local.location!=='server'&&local.space===row.space&&local.logicalKey===row.logicalKey&&!local.deleted);
      if(lacksLocal&&globalRecordScopeIds(row).some(id=>scoped.find(scope=>scope.scopeId===id)?.sourceMode===MODE_PLUGIN_ONLY))
        blockers.push({code:'remote_source_route_unverified',space:row.space,key:row.logicalKey,scopeId:row.scopeId});
    }
    const catalog={hostScopes,scopes:scopes.map(scope=>[scope.scopeId,scope.scopeKey,scope.characterId,scope.chatId,scope.aliases]),
      keys:[...new Set(safeRecords.filter(row=>row.classification!=='control').map(row=>globalCanonical([row.space,row.logicalKey,row.classification,row.scopeId,row.dependencyScopeIds])))].sort()};
    const catalogFingerprint=await digestInventory(catalog);
    return {schema:'memory-suite.global-inventory.v1',namespace,targetUrl,targetMode:target,scopes:scoped,records:safeRecords,registry,registryCopies,hostScopes,
      stores,remoteRequired,serverPin,catalogFingerprint,inventoryFingerprint:await digestInventory([catalogFingerprint,safeRecords.filter(row=>row.classification!=='control').map(row=>[globalRecordIdentity(row),row.fingerprint,row.revision,row.digest])]),
      blockers,completeKnownScopes:owner.completeKnownScopes===true&&blockers.length===0};
  };
  const globalInventorySummary = inventory => ({schema:inventory.schema,namespace,targetUrl:inventory.targetUrl,targetMode:inventory.targetMode,completeKnownScopes:inventory.completeKnownScopes,
    discoveredScopes:inventory.scopes.length,legacyOverrides:inventory.scopes.filter(scope=>{const row=inventory.registry.entries[scope.scopeId];return row&&!['inherited','migrated'].includes(String(row.origin||''));}).length,
    directions:Object.fromEntries([MODE_PLUGIN_ONLY,MODE_SERVER_ONLY,MODE_MIRROR].map(mode=>[mode,inventory.scopes.filter(scope=>scope.sourceMode===mode).length])),
    blockers:inventory.blockers,catalogFingerprint:inventory.catalogFingerprint,inventoryFingerprint:inventory.inventoryFingerprint});
  const previewGlobalMode = async (mode,previewOptions={}) => {
    const target=requireOperationalMode(mode);
    if(!globalModeEnabled)throw globalModeError('MEMORY_SUITE_GLOBAL_OWNER_UNSUPPORTED');
    const url=await configuredServerUrlNow(),targetUrl=normalizeServerUrl(previewOptions.url||url);
    if(targetUrl!==url){const old=await collectGlobalInventory(MODE_PLUGIN_ONLY);
      if(!old.completeKnownScopes)return globalInventorySummary(old);
      if(old.scopes.some(scope=>scope.sourceMode!==MODE_PLUGIN_ONLY))return {...globalInventorySummary(old),completeKnownScopes:false,blockers:[{code:'MEMORY_SUITE_SERVER_URL_IN_USE'}]};}
    const first=await collectGlobalInventory(target,{url:targetUrl});
    if(first.completeKnownScopes){const second=await collectGlobalInventory(target,{url:targetUrl});
      if(!second.completeKnownScopes||first.catalogFingerprint!==second.catalogFingerprint||first.inventoryFingerprint!==second.inventoryFingerprint
        ||globalCanonical(first.registryCopies)!==globalCanonical(second.registryCopies)){first.completeKnownScopes=false;first.blockers.push({code:'inventory_changed_during_preview'});}}
    return globalInventorySummary(first);
  };
  const globalSaveJob = async patch => {
    state.syncJob.current={...state.syncJob.current,...patch,updatedAt:Date.now(),lastActivityAt:Date.now()};
    state.syncJob.loaded=true;notifySyncJob();
    if(!await persistSyncJobNow())throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');
    return getSyncJob();
  };
  const globalSourceWitness = inventory => inventory.records.filter(row=>{
    if(!globalPayloadRecord(row)&&row.classification!=='artifact')return false;
    const modes=globalRecordScopeIds(row).map(id=>inventory.scopes.find(scope=>scope.scopeId===id)?.sourceMode);
    return row.location==='server'?modes.some(mode=>mode!==MODE_PLUGIN_ONLY):modes.some(mode=>mode!==MODE_SERVER_ONLY);
  }).map(row=>({identity:globalRecordIdentity(row),fingerprint:row.fingerprint,revision:row.revision,digest:row.digest}));
  const assertGlobalPlanCurrent = async (job,inventory,allowPreviousUrl=false) => {
    if(!inventory.completeKnownScopes||inventory.catalogFingerprint!==job.globalPlan.catalogFingerprint)throw globalModeError('MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED',globalInventorySummary(inventory));
    const records=new Map(inventory.records.map(row=>[globalRecordIdentity(row),row]));
    for(const source of job.globalPlan.sources){const row=records.get(source.identity);
      if(!row||row.fingerprint!==source.fingerprint||source.revision!==undefined&&(row.revision!==source.revision||row.digest!==source.digest))throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{identity:source.identity});}
    const previousGlobal=job.globalPlan.registry.entries[GLOBAL_SCOPE_ID],actualGlobal=inventory.registry.entries[GLOBAL_SCOPE_ID];
    if(globalCanonical(actualGlobal||null)!==globalCanonical(previousGlobal||null)&&!(actualGlobal?.globalMigrationJobId===job.jobId&&actualGlobal.mode===job.targetMode))throw globalModeError('MEMORY_SUITE_GLOBAL_ROUTE_CHANGED',{scopeId:GLOBAL_SCOPE_ID});
    for(const scope of job.globalPlan.scopes){const original=job.globalPlan.registry.entries[scope.scopeId],actual=inventory.registry.entries[scope.scopeId];
      if(globalCanonical(actual||null)===globalCanonical(original||null))continue;
      if(actual?.globalMigrationJobId===job.jobId&&actual.mode===job.targetMode&&['transition_pending','inherited'].includes(actual.origin))continue;
      throw globalModeError('MEMORY_SUITE_GLOBAL_ROUTE_CHANGED',{scopeId:scope.scopeId});}
    if(await configuredServerUrlNow()!==job.targetUrl&&!(allowPreviousUrl&&await configuredServerUrlNow()===job.globalPlan.previousUrl))throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
    await assertDurableJobAdmission(job);
  };
  const globalRouteForRecord = async (row,scope) => {
    const raw=resolveKeyScopeProvider?await resolveKeyScopeProvider({namespace,pluginId,pluginVersion,space:row.space,key:row.logicalKey,currentScope:scope,
      registry:{...globalMigrationContext.registry,entries:{...globalMigrationContext.registry.entries,...Object.fromEntries(globalMigrationContext.scopes.map(item=>[item.scopeId,item]))}}}):{};
    // The strict owner inventory supplies membership even for older resolver gaps.
    // Only already-owned route keys reach this path; control/credential rows never do.
    return await normalizeRouteDescriptor({...raw,kind:row.classification==='shared'?'shared':'scope',scope,scopeId:scope.scopeId,scopeKey:scope.scopeKey,
      includeInScopeSync:true,...(row.location==='server'?{remoteKey:row.key}:{})},row.space,row.logicalKey,scope);
  };
  const globalPreflightDestinations = async inventory => {
    const byIdentity=new Map(inventory.records.map(row=>[globalRecordIdentity(row),row]));
    for(const scope of inventory.scopes){
      if(scope.sourceMode===inventory.targetMode)continue;
      for(const row of inventory.records.filter(row=>globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(scope.scopeId))){
        const sourceRemote=scope.sourceMode===MODE_SERVER_ONLY;
        if((row.location==='server')!==sourceRemote)continue;
        const route=await globalRouteForRecord(row,scope);
        const destinationKey=sourceRemote?[row.space==='plugin'?'plugin':'device',row.space,row.logicalKey].join('\u0000')
          :['server',row.space,route.remoteKey].join('\u0000');
        const destination=byIdentity.get(destinationKey);
        if(!destination)continue;
        const sourceValue=Object.hasOwn(row,'logicalValue')?row.logicalValue:row.value;
        const projected=sourceRemote?sourceValue:await routeProjectValue(route,sourceValue);
        if(row.deleted!==destination.deleted||await globalDigest([row.deleted,projected])!==await globalDigest([destination.deleted,Object.hasOwn(destination,'logicalValue')?destination.logicalValue:destination.value]))
          throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT',{scopeId:scope.scopeId,space:row.space,key:row.logicalKey});
      }
    }
  };
  const verifyGlobalScopeDestination = async (inventory,scope,target) => {
    let verified=0;
    const rows=inventory.records.filter(row=>globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(scope.scopeId)
      &&(scope.sourceMode===MODE_SERVER_ONLY?row.location==='server':row.location!=='server'));
    for(const row of rows){
      const route=await globalRouteForRecord(row,scope);
      if(target===MODE_SERVER_ONLY){
        const remote=await remoteGet(row.space,route.remoteKey,{allowPluginOnly:true});
        const logical=Object.hasOwn(row,'logicalValue')?row.logicalValue:row.value;
        const expected=row.location==='server'?logical:await routeProjectValue(route,logical);
        if(row.deleted?remote.tombstone!==true:remote.exists!==true||globalCanonical(remote.value)!==globalCanonical(expected))throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED',{scopeId:scope.scopeId,key:row.logicalKey});
      }else{
        const store=inventory.stores[row.space],value=await legacyRead(store,row.logicalKey);
        if(row.deleted?!isNullishStorageValue(value):globalCanonical(await routeProjectValue(route,value))!==globalCanonical(Object.hasOwn(row,'logicalValue')?row.logicalValue:row.value))throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED',{scopeId:scope.scopeId,key:row.logicalKey});
      }
      verified++;
    }
    return {scopeId:scope.scopeId,verifiedRecords:verified};
  };
  const runGlobalModeJob = async (job,initialInventory=null) => {
    if(globalJobRunning)throw transitionBusyError();
    globalJobRunning=true;
    try{
      // The outer mode-configuration gate owns admission through final publication.
      do{await Promise.allSettled([...ownerIOWork]);if(typeof whenFlashbackWritersIdle==='function')await whenFlashbackWritersIdle();await Promise.allSettled([...mutationTails.values()]);}
      while(ownerIOWork.size||mutationTails.size);
      modeConfigurationFrozen=true;
      // Admitted writers may have completed during drain; never reuse the prepare snapshot.
      let inventory=await collectGlobalInventory(job.targetMode,{url:job.targetUrl});
      if(await configuredServerUrlNow()!==job.targetUrl){
        if(await configuredServerUrlNow()!==job.globalPlan.previousUrl)throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
        await assertDurableJobAdmission(job);
        const old=await collectGlobalInventory(MODE_PLUGIN_ONLY);
        if(!old.completeKnownScopes||old.scopes.some(scope=>scope.sourceMode!==MODE_PLUGIN_ONLY))throw globalModeError('MEMORY_SUITE_SERVER_URL_IN_USE');
        if(old.inventoryFingerprint!==job.globalPlan.previousInventoryFingerprint)throw globalModeError('MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');
        if(state.syncJob.current.pauseRequested)return await globalSaveJob({status:'cancelled',phase:'cancelled_before_effects'});
        await assertGlobalPlanCurrent(job,inventory,true);
        globalMigrationContext=inventory;await globalPreflightDestinations({...inventory,scopes:job.globalPlan.scopes});globalMigrationContext=null;
        await globalSaveJob({phase:'configure_url',effectsStarted:true});
        await persistServerUrl(job.targetUrl);
        inventory=await collectGlobalInventory(job.targetMode);
      }
      await assertGlobalPlanCurrent(job,inventory);
      globalMigrationContext=inventory;
      await globalPreflightDestinations({...inventory,scopes:job.globalPlan.scopes});
      await globalSaveJob({status:'running',phase:'copy_verify',message:'전체 대화 데이터를 검증하고 옮기고 있습니다.'});
      for(const scope of job.globalPlan.scopes){
        if(state.syncJob.current.pauseRequested){
          const touched=Object.keys(state.syncJob.current.checkpoints||{}).length>0||state.syncJob.current.effectsStarted;
          return await globalSaveJob({status:touched?'paused':'cancelled',phase:touched?'paused_resumable':'cancelled_before_effects',message:touched?'미완료 · 원본과 현재 경로를 보존했습니다. 이어서 진행할 수 있습니다.':'효과 발생 전에 취소했습니다.'});
        }
        await assertDurableJobAdmission(job);
        await globalSaveJob({currentScopeId:scope.scopeId,currentKey:'',effectsStarted:true});
        const sameMode=scope.sourceMode===job.targetMode;
        const actual=(await readScopeMode(scope,true)).mode;
        const completed=actual===job.targetMode&&inventory.registry.entries[scope.scopeId]?.globalMigrationJobId===job.jobId;
        const hasRecords=inventory.records.some(row=>globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(scope.scopeId));
        const hasLiveScopeRecords=inventory.records.some(row=>row.classification==='scope'&&!row.deleted&&row.scopeId===scope.scopeId&&(scope.sourceMode===MODE_SERVER_ONLY?row.location==='server':row.location!=='server'));
        if(!sameMode&&!completed&&hasRecords){
          await scopedSetModeSafely(job.targetMode,{scope,source:'global_allchat_transition',origin:'transition_pending',recordExplicit:false,
            globalMigrationJobId:job.jobId,allowEmptyRestore:!hasLiveScopeRecords,assertServerPins:()=>assertDurableJobAdmission(job),
            onProgress:progress=>{state.syncJob.current={...state.syncJob.current,currentSpace:progress.space,currentKey:progress.currentKey||'',currentAction:progress.currentAction||''};notifySyncJob();}});
        }
        const evidence=await verifyGlobalScopeDestination(inventory,scope,job.targetMode);
        if(sameMode||completed||!hasRecords)await persistScopedMode(job.targetMode,scope,{origin:'transition_pending',source:'global_allchat_verified',globalMigrationJobId:job.jobId});
        await globalSaveJob({checkpoints:{...state.syncJob.current.checkpoints,[scope.scopeId]:evidence},verifiedScopes:Object.keys({...state.syncJob.current.checkpoints,[scope.scopeId]:evidence}).length});
      }
      if(state.syncJob.current.pauseRequested)return await globalSaveJob({status:'paused',phase:'paused_resumable',message:'미완료 · 검증된 경로와 원본을 보존했습니다. 전체 적용은 재개 후 완료합니다.'});
      inventory=await collectGlobalInventory(job.targetMode);
      await assertGlobalPlanCurrent(job,inventory);
      globalMigrationContext=inventory;
      for(const scope of job.globalPlan.scopes)await verifyGlobalScopeDestination(inventory,scope,job.targetMode);
      await globalSaveJob({phase:'commit_pending',message:'모든 대화 검증 완료 · 전역 설정을 게시하고 있습니다.'});
      const registry=parseScopeRegistry(await loadScopeRegistry(true,false));
      for(const scope of job.globalPlan.scopes){const old=registry.entries[scope.scopeId]||{};
        registry.entries[scope.scopeId]={...old,...scope,mode:job.targetMode,origin:'inherited',pendingTargetMode:null,globalMigrationJobId:job.jobId,
          updatedAt:Math.max(Date.now(),Number(old.updatedAt||0)+1),source:'global_allchat_verified'};}
      const oldGlobal=registry.entries[GLOBAL_SCOPE_ID]||{};
      registry.entries[GLOBAL_SCOPE_ID]={...globalScopeDescriptor(),mode:job.targetMode,origin:'user_explicit',globalMigrationJobId:job.jobId,
        updatedAt:Math.max(Date.now(),Number(oldGlobal.updatedAt||0)+1),source:'global_allchat_verified'};
      registry.legacyGlobalModeImported=true;registry.globalMigrationRemoteHistory=inventory.remoteRequired;
      let saved=await writeScopeRegistryLocal(registry,{reason:'global_allchat_commit',phase:'pending'});
      for(const store of [...new Set(Object.values(inventory.stores).filter(Boolean))]){
        const raw=await store.getItem(SCOPE_ROUTING_LOCAL_KEY);
        if(globalCanonical(globalReadRegistry(raw,'commit',[]).entries)!==globalCanonical(saved.entries))throw globalModeError('MEMORY_SUITE_GLOBAL_REGISTRY_READBACK_FAILED');
      }
      if(inventory.remoteRequired){
        for(const scope of job.globalPlan.scopes)await publishPreparedServerMode(await prepareServerModePublication(scope,job.targetMode,'inherited'));
        await publishPreparedServerMode(await prepareServerModePublication(globalScopeDescriptor(),job.targetMode,'global'));
        if(!await synchronizeScopeRegistryToServer(saved))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_PENDING');
        const remote=await remoteGet('plugin',SCOPE_ROUTING_SERVER_KEY,{allowPluginOnly:true});
        if(remote.exists!==true||globalCanonical(parseScopeRegistry(remote.value).entries)!==globalCanonical(saved.entries))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_READBACK_FAILED');
      }
      saved=await writeScopeRegistryLocal(saved,{reason:'global_allchat_verified',phase:'settled'});
      for(const store of [...new Set(Object.values(inventory.stores).filter(Boolean))]){
        if(String(await store.getItem(SCOPE_ROUTING_LOCAL_KEY))!==JSON.stringify(saved))throw globalModeError('MEMORY_SUITE_GLOBAL_REGISTRY_READBACK_FAILED');
      }
      if(inventory.remoteRequired){
        if(!await synchronizeScopeRegistryToServer(saved))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_PENDING');
        const remote=await remoteGet('plugin',SCOPE_ROUTING_SERVER_KEY,{allowPluginOnly:true});
        if(remote.exists!==true||globalCanonical(parseScopeRegistry(remote.value))!==globalCanonical(parseScopeRegistry(saved)))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_READBACK_FAILED');
      }
      const result={scope:globalScopeDescriptor(),mode:job.targetMode,effectiveMode:job.targetMode,requestedMode:job.targetMode,modeLabel:modeLabel(job.targetMode),
        completeKnownScopes:true,discoveredScopes:job.globalPlan.scopes.length,verifiedScopes:job.globalPlan.scopes.length,migrated:job.globalPlan.scopes.map(scope=>scope.scopeId),failed:[],registry:saved};
      await globalSaveJob({status:'completed',phase:'completed',effectiveMode:job.targetMode,result,finishedAt:Date.now(),message:'전체 대화 이전과 전역 설정 적용이 완료되었습니다.'});
      state.config={...state.config,mode:job.targetMode,at:Date.now()};state.scopeRouting.routeCache.clear();
      return result;
    }catch(error){
      try{await globalSaveJob({status:'paused',phase:state.syncJob.current?.phase==='commit_pending'?'commit_pending':'recovery_pending',error:String(error.code||error.message),
        message:'미완료 · 원본과 실제 경로를 보존했습니다. 문제를 확인한 뒤 이어서 진행하세요.'});}catch(_){}
      error.job=getSyncJob();throw error;
    }finally{globalMigrationContext=null;globalJobRunning=false;}
  };
  const persistGlobalModeAllChats = async (modeValue,operationOptions={}) => {
    const target=requireOperationalMode(modeValue);
    await loadPersistedSyncJob();
    const pending=getSyncJob();
    let superseded=null;
    if(pending&&!syncJobTerminal(pending.status)){
      if(pending.kind!=='global_mode'||pending.targetMode!==target)throw globalModeError('MEMORY_SUITE_SYNC_JOB_BUSY');
      if(operationOptions.url&&normalizeServerUrl(operationOptions.url)!==pending.targetUrl)throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
      await assertDurableJobAdmission(pending);
      if(operationOptions.refreshInventory===true&&operationOptions.previewFingerprint
        &&['MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED','MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'].includes(pending.error))superseded=pending;
      else {await globalSaveJob({pauseRequested:false});return await runGlobalModeJob(state.syncJob.current);}
    }
    // Accepted owner operations may re-enter the proxy. Finish them before the
    // prepared journal closes aggregate I/O, then freeze without an idle gap.
    do{await Promise.allSettled([...ownerIOWork]);if(typeof whenFlashbackWritersIdle==='function')await whenFlashbackWritersIdle();await Promise.allSettled([...mutationTails.values()]);}
    while(ownerIOWork.size||mutationTails.size);
    modeConfigurationFrozen=true;
    const url=await configuredServerUrlNow();
    const targetUrl=normalizeServerUrl(operationOptions.url||url);
    let previousInventory=null;
    if(targetUrl!==url){
      previousInventory=await collectGlobalInventory(MODE_PLUGIN_ONLY);
      if(!previousInventory.completeKnownScopes)throw globalModeError('MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE',globalInventorySummary(previousInventory));
      if(previousInventory.scopes.some(scope=>scope.sourceMode!==MODE_PLUGIN_ONLY))throw globalModeError('MEMORY_SUITE_SERVER_URL_IN_USE');
    }
    const inventory=await collectGlobalInventory(target,{url:targetUrl});
    if(!inventory.completeKnownScopes)throw globalModeError('MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE',globalInventorySummary(inventory));
    if(operationOptions.previewFingerprint&&operationOptions.previewFingerprint!==inventory.inventoryFingerprint)throw globalModeError('MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');
    const second=await collectGlobalInventory(target,{url:targetUrl});
    if(!second.completeKnownScopes||inventory.catalogFingerprint!==second.catalogFingerprint||inventory.inventoryFingerprint!==second.inventoryFingerprint
      ||globalCanonical(inventory.registryCopies)!==globalCanonical(second.registryCopies))throw globalModeError('MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');
    globalMigrationContext=inventory;
    try{await globalPreflightDestinations(inventory);}finally{globalMigrationContext=null;}
    const now=Date.now(),jobId=operationId('global');
    const globalPlan={schema:'memory-suite.global-mode-plan.v1',namespace,targetMode:target,scopes:inventory.scopes,
      registry:inventory.registry,registryCopies:inventory.registryCopies,catalogFingerprint:inventory.catalogFingerprint,
      inventoryFingerprint:inventory.inventoryFingerprint,sources:globalSourceWitness(inventory),remoteRequired:inventory.remoteRequired,
      previousUrl:previousInventory?url:null,previousInventoryFingerprint:previousInventory?.inventoryFingerprint||null,
      supersedesJobId:superseded?.jobId||null};
    if(superseded){const key=SYNC_JOB_STORAGE_KEY+':superseded:'+superseded.jobId;
      if(!await legacyWriteVerified(state.legacy.plugin,key,JSON.stringify(superseded)))throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');}
    state.syncJob.current={schema:SYNC_JOB_SCHEMA,namespace,pluginId,pluginVersion,jobId,id:jobId,kind:'global_mode',scopeId:GLOBAL_SCOPE_ID,
      sourceMode:inventory.remoteRequired?MODE_SERVER_ONLY:MODE_PLUGIN_ONLY,sourceUrl:targetUrl,targetMode:target,targetUrl,requestedMode:target,
      effectiveMode:normalizeMode(liveGlobalRow(inventory.registry)?.mode||MODE_PLUGIN_ONLY),serverPins:{source:inventory.serverPin,target:target!==MODE_PLUGIN_ONLY?inventory.serverPin:null},
      globalPlan,globalPlanDigest:await globalDigest(globalPlan),checkpoints:{},verifiedScopes:0,discoveredScopes:inventory.scopes.length,
      status:'queued',phase:'prepared',startedAt:now,updatedAt:now,lastActivityAt:now,pauseRequested:false,effectsStarted:false};
    try{await globalSaveJob({});}catch(error){state.syncJob.current=superseded||state.syncJob.current;state.syncJob.loaded=false;throw error;}
    return await runGlobalModeJob(state.syncJob.current,inventory);
  };
  const pauseGlobalModeJob = async () => {
    await loadPersistedSyncJob();const job=getSyncJob();
    if(job?.kind!=='global_mode'||syncJobTerminal(job.status))return job;
    state.syncJob.current.pauseRequested=true;
    if(!globalJobRunning&&!modeConfigurationBusy)return await globalSaveJob({status:job.effectsStarted?'paused':'cancelled',phase:job.effectsStarted?'paused_resumable':'cancelled_before_effects'});
    return getSyncJob();
  };
  // END CORE3 GLOBAL ALL-CHAT MIGRATION v1

  const persistGlobalMode = async (modeValue, persistOptions = {}) => {
    if(globalModeEnabled)return await persistGlobalModeAllChats(modeValue,persistOptions);
    const target = requireOperationalMode(modeValue);
    // A global change is a real storage-mode change for every scope that FOLLOWS it, so it must run
    // the same data migration the per-scope path runs. Writing only the registry would silently
    // re-route reads to a store that was never seeded, which is exactly the defect this replaces:
    // the affected scope's values stayed on the old side and came back null.
    //
    // Scopes with their OWN choice are deliberately excluded — the whole point of the global entry is
    // that an explicit per-chat setting keeps its value, so migrating those would contradict the
    // contract and move data the user did not ask to move.
    // Which scopes must be migrated? Every scope that FOLLOWS the global mode — which is two groups,
    // and missing the second one is a real defect (found by mutation testing this suite):
    //   · scopes with an entry marked inherited/migrated, and
    //   · scopes with NO entry at all, which is the ordinary state of a chat that never set its own
    //     mode and therefore inherits. Those are invisible in the registry, so they cannot be found by
    //     scanning it.
    // The second group is reached through the ACTIVE scope, which is the only such scope this call can
    // identify with certainty. A chat that is not open cannot be migrated from here; it will follow the
    // new global mode the next time it is opened and the panel runs a transition for it.
    const registryBefore = parseScopeRegistry(await loadScopeRegistry(true, false));
    const followers = Object.values(registryBefore.entries || {})
      .filter(row => !isRemovedScopeRow(row) && !isGlobalScopeId(row.scopeId))
      .filter(row => {
        const origin = String(row.origin || '');
        return origin === 'inherited' || origin === 'migrated' || origin === 'transition_pending';
      })
      .map(row => normalizeScopeDescriptor(row))
      .filter(scope => scope.scopeId);
    const active = normalizeScopeDescriptor(await resolveCurrentScope(true).catch(() => null));
    const affected = [...followers];
    // The active scope joins the list only when it genuinely follows the global mode and is not
    // already covered above.
    if (active.scopeId && !affected.some(scope => scope.scopeId === active.scopeId)) {
      const activeState = await readScopeMode(active, true).catch(() => null);
      if (activeState && activeState.explicit !== true && activeState.mode !== target) affected.push(active);
    }
    // Migrate first, then record the choice. A failed migration must leave the previous mode in
    // force rather than a registry that claims a store nothing was moved into.
    const migrated = [];
    const failed = [];
    for (const scope of affected) {
      const current = await readScopeMode(scope, true).catch(() => null);
      if (!current || current.mode === target) continue;
      // `origin: 'inherited'` is required, not cosmetic. The per-scope path persists the scope entry
      // using whatever origin it is given, and readScopeMode treats every origin except exactly
      // 'inherited'/'migrated' as a USER choice. Passing anything else would freeze the scope to this
      // one value: it would stop following the global mode and a later global change would skip it.
      try {
        await scopedSetModeSafely(target, {
          scope,
          source: String(persistOptions.source || 'user_global_setting'),
          origin: 'inherited',
          recordExplicit: false,
          onProgress: persistOptions.onProgress
        });
        migrated.push(scope.scopeId);
      } catch (error) {
        // A scope that cannot move yet (its server is unreachable, its recovery lock is held, or it
        // has nothing to restore) must NOT veto the global choice. The user asked for a default; the
        // scope keeps its previous behaviour until the move can succeed, and the caller is told. The
        // alternative — throwing — makes the whole feature unusable exactly when the server is down,
        // which is when plugin_only users most need a local setting to stick.
        const retained = parseScopeRegistry(await loadScopeRegistry(true, false));
        const effective = await readScopeMode(scope, true);
        retained.entries[scope.scopeId] = {...(retained.entries[scope.scopeId] || {}), ...scope,
          mode:effective.mode, origin:'transition_pending', pendingTargetMode:target,
          updatedAt:Math.max(Date.now(),Number(retained.entries[scope.scopeId]?.updatedAt || 0)+1), source:'global_transition_failed_source_preserved'};
        const retainedSaved = await writeScopeRegistryLocal(retained);
        const retainedRow = retainedSaved.entries[scope.scopeId];
        if (retainedRow?.mode !== effective.mode || retainedRow?.origin !== 'transition_pending' || retainedRow?.pendingTargetMode !== target) {
          throw Object.assign(new Error('memory_suite_pending_transition_readback_mismatch'),{code:'MEMORY_SUITE_MODE_READBACK_MISMATCH'});
        }
        failed.push({ scopeId: scope.scopeId, reason: String(error?.code || error?.message || error || 'unknown').slice(0, 160) });
      }
    }
    const registry = parseScopeRegistry(await loadScopeRegistry(true, false));
    const scope = globalScopeDescriptor();
    const serverPublication=await prepareServerModePublication(scope,target,'global');
    registry.entries[GLOBAL_SCOPE_ID] = {
      scopeId: GLOBAL_SCOPE_ID,
      scopeKey: GLOBAL_SCOPE_ID,
      label: scope.label,
      global: true,
      mode: target,
      origin: String(persistOptions.origin || 'user_explicit'),
      updatedAt: Math.max(Date.now(),Number(registry.entries[GLOBAL_SCOPE_ID]?.updatedAt || 0)+1),
      source: String(persistOptions.source || 'user_global_setting')
      // No `removed` key: setting the mode again must revive a previously cleared entry.
    };
    registry.legacyGlobalModeImported = true;
    const saved = await writeScopeRegistryLocal(registry);
    if (saved.entries[GLOBAL_SCOPE_ID]?.mode !== target) throw Object.assign(new Error('memory_suite_global_mode_readback_mismatch'),{code:'MEMORY_SUITE_MODE_READBACK_MISMATCH'});
    await publishPreparedServerMode(serverPublication);
    state.config = { ...state.config, at: Date.now(), mode: target };
    // Publish the registry whenever the recorded value differs from what the server holds — including
    // plugin_only. The old `target !== MODE_PLUGIN_ONLY` guard existed because entering plugin_only is
    // a hard network boundary for the MODE, but the registry itself must still be published or a
    // restore or another device would read back the superseded mode.
    void synchronizeScopeRegistryToServer(saved).catch(error => reportStorageFailure('scope.registry.sync.admission', error));
    setStatus('global_mode_changed', '', { mode: target, modeLabel: modeLabel(target), migrated, failed });
    return { scope, mode: target, modeLabel: modeLabel(target), registry: saved, migrated, failed };
  };

  const readGlobalMode = async (force = false) => {
    const registry = await loadScopeRegistry(force, false);
    const stored = liveGlobalRow(registry);
    const mode = normalizeMode(stored?.mode || MODE_PLUGIN_ONLY);
    return {
      scope: globalScopeDescriptor(),
      mode,
      modeLabel: modeLabel(mode),
      // `set` is what the UI needs: an UNSET global entry means "do not govern anything", which is a
      // different state from an explicit plugin_only choice.
      set: !!stored,
      explicit: !!stored,
      modeOrigin: String(stored?.origin || ''),
      ...modeLifecycle(mode),
      legacyOverrides:Object.values(registry.entries||{}).filter(row=>!isGlobalScopeId(row.scopeId)&&!isRemovedScopeRow(row)&&!['inherited','migrated'].includes(String(row.origin||''))).length,
      updatedAt: Number(stored?.updatedAt || 0) || 0
    };
  };

  // Drop the global entry entirely, returning the install to the pre-global behaviour where every
  // scope decides for itself. Per-scope entries are left exactly as they are.
  //
  // A plain `delete` cannot work here: writeScopeRegistryLocal merges the on-disk registry with the
  // requested one so that concurrent scope writes cannot lose each other's rows, and a merge cannot
  // see an absence. Removing the row from the snapshot therefore just resurrects the on-disk copy.
  // The entry is marked with a removal stamp instead, which the merge CAN see, and reads treat a
  // stamped row as absent.
  const clearGlobalMode = async () => {
    if(globalModeEnabled)return {...await persistGlobalModeAllChats(MODE_PLUGIN_ONLY,{source:'global_default_reset'}),cleared:true};
    const registry = parseScopeRegistry(await loadScopeRegistry(true, false));
    const existing = liveGlobalRow(registry);
    if (!existing) return { cleared: false };
    const serverPublication=await prepareServerModePublication(globalScopeDescriptor(),MODE_PLUGIN_ONLY,'removed');
    registry.entries[GLOBAL_SCOPE_ID] = {
      scopeId: GLOBAL_SCOPE_ID,
      scopeKey: GLOBAL_SCOPE_ID,
      removed: true,
      mode: MODE_PLUGIN_ONLY,
      origin: 'user_explicit',
      updatedAt: Math.max(Date.now(),Number(existing.updatedAt || 0)+1),
      source: 'user_global_cleared'
    };
    const saved = await writeScopeRegistryLocal(registry);
    if (saved.entries[GLOBAL_SCOPE_ID]?.removed !== true) throw Object.assign(new Error('memory_suite_global_clear_readback_mismatch'),{code:'MEMORY_SUITE_MODE_READBACK_MISMATCH'});
    await publishPreparedServerMode(serverPublication);
    // Publish the removal stamp. Without this the server keeps the superseded global mode, and the
    // very next restore or second device reads it back as if the user had never cleared it.
    void synchronizeScopeRegistryToServer(saved).catch(error => reportStorageFailure('scope.registry.sync.admission', error));
    setStatus('global_mode_cleared', '');
    return { cleared: true, registry: saved };
  };

  const anyServerScopedMode = async () => {
    const registry = await loadScopeRegistry(false, false);
    if (Object.values(registry.entries || {}).some(row => !isRemovedScopeRow(row) && normalizeMode(row.mode) !== MODE_PLUGIN_ONLY)) return true;
    // Scoped reads already admit an unconsumed legacy global argument. Shared
    // owner infrastructure must use that same fallback, without overriding a
    // published global choice or importing/publishing any new mode here.
    return globalModeEnabled && !registry.legacyGlobalModeImported && !liveGlobalRow(registry)
      && normalizeMode(await getArgumentValue(modeArguments, MODE_PLUGIN_ONLY)) !== MODE_PLUGIN_ONLY;
  };

  const normalizeRouteDescriptor = async (rawValue, space, key, currentScope) => {
    let raw = rawValue;
    if (typeof raw === 'string') raw = { scopeId: raw };
    raw = raw && typeof raw === 'object' ? raw : {};
    let kind = String(raw.kind || raw.type || '').trim().toLowerCase();
    if (!['scope', 'shared', 'global'].includes(kind)) kind = raw.global === true ? 'global' : (raw.shared === true ? 'shared' : 'scope');
    // Resolve an explicit scope or alias before falling back to the current scope.
    // Falling back first would silently assign an unknown historical key to the
    // currently open chat, which is unsafe for per-scope routing.
    let scope = normalizeScopeDescriptor(raw.scope || raw, '');
    if (kind === 'scope' && !scope.scopeId && raw.scopeAlias) {
      const registry = await loadScopeRegistry(false, false);
      scope = normalizeScopeDescriptor(registryEntryByAlias(registry, raw.scopeAlias));
    }
    if (kind === 'scope' && !scope.scopeId) scope = normalizeScopeDescriptor(currentScope);
    let mode = MODE_PLUGIN_ONLY;
    if (kind === 'scope') mode = (await readScopeMode(scope, false)).mode;
    else if (kind === 'shared') mode = (await anyServerScopedMode()) ? normalizeMode(sharedRouteModeRaw) : MODE_PLUGIN_ONLY;
    const remoteKey = String(raw.remoteKey || (raw.scopedContainer === true && scope.scopeId
      ? `${key}${SCOPED_REMOTE_KEY_MARKER}${encodeURIComponent(scope.scopeId)}`
      : key));
    return {
      routed: true, kind, space, key: String(key), logicalKey: String(key), remoteKey,
      scope, scopeId: scope.scopeId || '', scopeLabel: scope.label || '', mode,
      projectValue: typeof raw.projectValue === 'function' ? raw.projectValue : null,
      mergeValue: typeof raw.mergeValue === 'function' ? raw.mergeValue : null,
      removeValue: typeof raw.removeValue === 'function' ? raw.removeValue : null,
      scopedContainer: raw.scopedContainer === true,
      // Shared/global infrastructure is never swept or deleted as part of one chat scope.
      // A plugin may opt a truly scope-owned shared record in explicitly.
      includeInScopeSync: raw.includeInScopeSync === true || (raw.includeInScopeSync !== false && kind === 'scope'),
      metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
    };
  };

  const resolveScopedRoute = async (space, key, routeOptions = {}) => {
    const normalizedKey = String(key || '');
    if(globalMigrationContext && routeOptions.scope){
      const id=String(routeOptions.scope.scopeId||'');
      const candidates=globalMigrationContext.records.filter(row=>row.space===space&&row.logicalKey===normalizedKey&&globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(id));
      const row=candidates.find(row=>row.location!=='server')||candidates[0];
      if(row)return await globalRouteForRecord(row,normalizeScopeDescriptor(routeOptions.scope));
      return {routed:false,kind:'global',space,key:normalizedKey,logicalKey:normalizedKey,remoteKey:normalizedKey,scopeId:'',mode:MODE_PLUGIN_ONLY};
    }
    const strictResolution = space === 'plugin' && strictPluginScopePrefixes.some(prefix => normalizedKey.startsWith(prefix));
    if (!matchesRoute(space, normalizedKey)) return { routed: false, kind: 'global', space, key: normalizedKey, logicalKey: normalizedKey, remoteKey: normalizedKey, scopeId: '', mode: MODE_PLUGIN_ONLY };
    if (!scopeRoutingEnabled) return { routed: true, kind: 'global', space, key: normalizedKey, logicalKey: normalizedKey, remoteKey: normalizedKey, scopeId: '', mode: MODE_PLUGIN_ONLY };

    // Many durable keys already contain their immutable scope id, while shared
    // archive/control keys never need a chat scope. Let explicitly opted-in
    // resolvers classify those keys before touching the RisuAI character/chat
    // APIs. This keeps archive traversal proportional to storage layers instead
    // of layers multiplied by repeated current-chat discovery.
    let registry = null;
    let preResolved = null;
    if (preResolveKeyScope && resolveKeyScopeProvider) {
      try {
        registry = await loadScopeRegistry(false, false);
        preResolved = await resolveKeyScopeProvider({ namespace, pluginId, pluginVersion, space, key: normalizedKey, currentScope: routeOptions.scope ? normalizeScopeDescriptor(routeOptions.scope) : null, registry });
      } catch (error) {
        if (strictResolution) { setStatus('scope_route_failed', error?.message || error, { key:compact(normalizedKey,180), space }); throw error; }
        preResolved = null;
      }
    }
    const preKind = String(preResolved?.kind || preResolved?.type || '').toLowerCase();
    const preScope = preKind === 'scope' ? normalizeScopeDescriptor(preResolved?.scope || preResolved, '') : null;
    const preResolvedWithoutCurrent = preKind === 'shared'
      || preKind === 'global'
      || (preKind === 'scope' && Boolean(preScope?.scopeId) && !preResolved?.scopeAlias);
    if (preResolvedWithoutCurrent) {
      const routeScopeId = preKind === 'scope' ? preScope.scopeId : `__${preKind}__`;
      const preCacheKey = `${space}\n${normalizedKey}\n${routeScopeId}`;
      if (!routeOptions.noCache && state.scopeRouting.routeCache.has(preCacheKey)) return state.scopeRouting.routeCache.get(preCacheKey);
      const route = await normalizeRouteDescriptor(preResolved, space, normalizedKey, null);
      rememberRoute(preCacheKey, route);
      return route;
    }

    const currentScope = normalizeScopeDescriptor(routeOptions.scope || await resolveCurrentScope(routeOptions.forceScope === true));
    const cacheKey = `${space}\n${normalizedKey}\n${currentScope.scopeId}`;
    if (!routeOptions.noCache && state.scopeRouting.routeCache.has(cacheKey)) return state.scopeRouting.routeCache.get(cacheKey);
    let raw = preResolved;
    try {
      raw = raw || (resolveKeyScopeProvider
        ? await resolveKeyScopeProvider({ namespace, pluginId, pluginVersion, space, key: normalizedKey, currentScope, registry: registry || await loadScopeRegistry(false, false) })
        : { kind: 'scope', ...currentScope });
    } catch (error) {
      setStatus('scope_route_failed', error?.message || error, { key: compact(normalizedKey, 180), space });
      if (strictResolution) throw error;
      raw = { kind: 'scope', ...currentScope };
    }
    // If the preliminary pass returned a scope alias, re-resolve with the actual
    // current scope before normalization so historical/legacy aliases remain valid.
    if (resolveKeyScopeProvider && raw?.kind === 'scope' && raw?.scopeAlias && !raw?.scopeId) {
      try { raw = await resolveKeyScopeProvider({ namespace, pluginId, pluginVersion, space, key: normalizedKey, currentScope, registry: registry || await loadScopeRegistry(false, false) }); }
      catch (_) {}
    }
    const route = await normalizeRouteDescriptor(raw, space, normalizedKey, currentScope);
    rememberRoute(cacheKey, route);
    return route;
  };

  const scopedRemoteKeyInfo = remoteKeyValue => {
    const remoteKey = String(remoteKeyValue || '');
    const index = remoteKey.lastIndexOf(SCOPED_REMOTE_KEY_MARKER);
    if (index < 0) return { logicalKey: remoteKey, scopeId: '' };
    let scopeId = '';
    try { scopeId = decodeURIComponent(remoteKey.slice(index + SCOPED_REMOTE_KEY_MARKER.length)); } catch (_) {}
    return { logicalKey: remoteKey.slice(0, index), scopeId };
  };

  const routeProjectValue = async (route, value) => {
    if (typeof route?.projectValue === 'function') return await route.projectValue(value, { route, scope: route.scope, namespace, pluginId });
    return value;
  };

  const routeMergeValue = async (route, remoteValue, localValue) => {
    if (typeof route?.mergeValue === 'function') return await route.mergeValue(remoteValue, localValue, { route, scope: route.scope, namespace, pluginId });
    return remoteValue;
  };

  const routeRemoveLocal = async (route, legacyGet, legacySet, legacyRemove) => {
    if (typeof route?.removeValue === 'function') {
      const local = typeof legacyGet === 'function' ? await legacyGet() : null;
      const next = await route.removeValue(local, { route, scope: route.scope, namespace, pluginId });
      if (next === undefined || next === null || next === '') return typeof legacyRemove === 'function' ? await legacyRemove() : false;
      return typeof legacySet === 'function' ? await legacySet(next) : false;
    }
    return typeof legacyRemove === 'function' ? await legacyRemove() : false;
  };

  const scopedBootstrap = async (force = false) => await bootstrap(force, true);
  const scopedServerGet = async (space, key) => await remoteGet(String(space || 'plugin'), String(key || ''), { allowPluginOnly: true });
  const scopedServerGetMany = async (space = 'plugin', keys = []) => await remoteGetMany(String(space || 'plugin'), keys, { allowPluginOnly: true });
  const scopedServerKeys = async (space = 'plugin', prefix = '') => await remoteKeys(String(space || 'plugin'), String(prefix || ''), { allowPluginOnly: true });
  const scopedServerIntegrity = async () => await remoteIntegrity({ allowPluginOnly: true });

  const nativeBranchScopeChatId = scope => String(scope?.chatId || scope?.canonicalChatId || '').trim();
  const nativeBranchScopeCharacterId = scope => String(scope?.characterId || scope?.canonicalCharacterId || '').trim();
  const createNativeBranchScopeCapability = input => {
    const value = input && typeof input === 'object' ? input : {};
    const lineage = value.lineage && typeof value.lineage === 'object' ? value.lineage : {};
    const sourceScope = normalizeScopeDescriptor(value.sourceScope || null);
    const targetScope = normalizeScopeDescriptor(value.targetScope || null);
    const owner = String(value.owner || namespace || '').trim().toLowerCase();
    const namespaceOwner = String(namespace || '').trim().toLowerCase();
    const sourceChatId = nativeBranchScopeChatId(sourceScope), targetChatId = nativeBranchScopeChatId(targetScope);
    const sourceCharacterId = nativeBranchScopeCharacterId(sourceScope), targetCharacterId = nativeBranchScopeCharacterId(targetScope);
    const lineageCharacterId = String(lineage.characterId || '').trim();
    if (!owner || (namespaceOwner && owner !== namespaceOwner)
      || lineage.schema !== 'librarian.host_lineage.v1' || lineage.kind !== 'native_branch' || lineage.status !== 'verified'
      || lineage.inheritanceEligible !== true || !lineage.prefixDigest || !sourceScope.scopeId || !targetScope.scopeId
      || sourceScope.scopeId === targetScope.scopeId || !sourceChatId || !targetChatId
      || String(lineage.parentChatId || '') !== sourceChatId || String(lineage.hostChatId || '') !== targetChatId
      || (sourceCharacterId && targetCharacterId && sourceCharacterId !== targetCharacterId)
      || (lineageCharacterId && sourceCharacterId && lineageCharacterId !== sourceCharacterId)
      || (lineageCharacterId && targetCharacterId && lineageCharacterId !== targetCharacterId)) {
      const error = new Error('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_INVALID'); error.code='MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_INVALID'; throw error;
    }
    const sourceRevision = String(value.sourceRevision || '');
    const targetRevisionAtIssue = String(value.targetRevision || value.targetRevisionAtIssue || '');
    const issuedAt = Date.now();
    const expiresAt = Number.isFinite(Number(value.expiresAt)) ? Number(value.expiresAt) : issuedAt + Math.max(1000, Number(value.lifetimeMs || NATIVE_BRANCH_CAPABILITY_DEFAULT_LIFETIME_MS) || NATIVE_BRANCH_CAPABILITY_DEFAULT_LIFETIME_MS);
    const capability=Object.freeze({schema:'memory-suite.native-branch-scope-capability.v1',owner,sourceScopeId:sourceScope.scopeId,targetScopeId:targetScope.scopeId,sourceChatId,targetChatId,lineageDigest:String(lineage.prefixDigest||''),sourceRevision,targetRevisionAtIssue,issuedAt:new Date(issuedAt).toISOString(),expiresAt:new Date(expiresAt).toISOString(),createdAt:issuedAt});
    nativeBranchScopeCapabilities.set(capability, {state:'issued',sourceRevision,targetRevisionAtIssue,lineageDigest:String(lineage.prefixDigest||''),targetChatId,owner,issuedAt,expiresAt,useCount:0,verifier:typeof value.verifier==='function'?value.verifier:null}); return capability;
  };
  const getNativeBranchScopeCapabilityState = capability => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!meta) return { state:'unknown', exists:false };
    return { state:meta.state, exists:true, owner:meta.owner, lineageDigest:meta.lineageDigest, sourceRevision:meta.sourceRevision, targetRevisionAtIssue:meta.targetRevisionAtIssue, targetChatId:meta.targetChatId, issuedAt:new Date(meta.issuedAt).toISOString(), expiresAt:new Date(meta.expiresAt).toISOString(), useCount:Number(meta.useCount||0) };
  };
  const consumeNativeBranchScopeCapability = capability => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!meta || meta.state === 'consumed' || meta.state === 'revoked') return false;
    meta.state = 'consumed'; meta.consumedAt = Date.now(); return true;
  };
  const revokeNativeBranchScopeCapability = (capability, reason = 'revoked') => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!meta || meta.state === 'revoked' || meta.state === 'consumed') return false;
    meta.state = 'revoked'; meta.revokedAt = Date.now(); meta.revokeReason = String(reason || 'revoked'); return true;
  };
  const assertNativeBranchScopeCapability = (capability, scopeInput, access='read') => {
    const meta = nativeBranchScopeCapabilities.get(capability);
    if (!capability || typeof capability !== 'object' || !meta) { const error=new Error('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_REQUIRED'); error.code='MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_REQUIRED'; throw error; }
    if (meta.state === 'consumed' || meta.state === 'revoked') throw nativeBranchCapabilityError(`MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_${meta.state.toUpperCase()}`, `native branch capability ${meta.state}`);
    if (Date.now() > Number(meta.expiresAt || 0)) throw nativeBranchCapabilityError('MEMORY_SUITE_NATIVE_BRANCH_CAPABILITY_EXPIRED', 'native branch capability expired');
    const scope=normalizeScopeDescriptor(scopeInput||null), targetAccess=['write','remove','readwrite'].includes(String(access||'').toLowerCase());
    if (!scope.scopeId || (targetAccess ? scope.scopeId!==capability.targetScopeId : ![capability.sourceScopeId,capability.targetScopeId].includes(scope.scopeId))) { const error=new Error('MEMORY_SUITE_NATIVE_BRANCH_SCOPE_ACCESS_DENIED'); error.code='MEMORY_SUITE_NATIVE_BRANCH_SCOPE_ACCESS_DENIED'; throw error; }
    return scope;
  };
  const assertNativeBranchKeyOwnership = async (scope, capability, space, key) => {
    if (!capability) return null;
    const route = await resolveScopedRoute(space, key, { scope, noCache:true });
    const kind = String(route?.kind || 'scope');
    if (kind !== 'scope' || !route.scopeId || route.scopeId !== scope.scopeId) {
      const error = new Error('MEMORY_SUITE_NATIVE_BRANCH_KEY_OWNERSHIP_DENIED');
      error.code = 'MEMORY_SUITE_NATIVE_BRANCH_KEY_OWNERSHIP_DENIED';
      throw error;
    }
    return route;
  };
  const authoritativeMirrorRoute = route => namespace === 'libra' && route?.kind === 'scope' && route.mode === MODE_MIRROR;
  // The SQLite commit is authoritative. A failed local copy must never trigger
  // another server commit or upload an older local Head on a later read/sync.
  const mirrorServerRow = async (space, key, route, row, beforeSet = null) => {
    try {
      const legacy = ownerLegacyForSpace(space);
      if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
      const current = await legacyRead(legacy, key);
      const ok = row.exists === true
        ? await legacyWriteVerified(legacy, key, await routeMergeValue(route, row.value, current), beforeSet)
        : await routeRemoveLocal(route, async () => legacyRead(legacy,key), next => legacyWriteVerified(legacy,key,next), () => legacyRemoveVerified(legacy,key));
      if (!ok) throw new Error('memory_suite_local_mirror_readback_failed');
      return { verified:true, key };
    } catch (error) {
      setStatus('server_durable_mirror_pending', error?.message || error, { scopeId:route.scopeId, key, space, mode:MODE_MIRROR });
      reportStorageFailure('storage.mirror.readback', error);
      return { verified:false, key, error:String(error?.message || error) };
    }
  };
  const scopedGetImpl = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null, operationOptions = {}) => {
    const captureRepair = operationOptions.completedTurnCaptureRepair;
    if (captureRepair != null && (namespace !== 'libra' || space !== 'plugin'
      || typeof captureRepair.expectedServerValue !== 'string' || typeof captureRepair.assertCurrent !== 'function'))
      throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_ROUTE_DENIED');
    const operationScope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(false));
    if (captureRepair != null) {
      const prefix = `libra:v1:scope:${operationScope.scopeKey}:source-receipt-capture:`;
      if (!String(key).startsWith(prefix) || !/^[^:]+:e\d+:t[1-9]\d*:[a-z0-9]+$/i.test(String(key).slice(prefix.length)))
        throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_ROUTE_DENIED');
    }
    const currentMode = (await readScopeMode(operationScope, false)).mode;
    if (captureRepair != null && currentMode !== MODE_MIRROR) throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_ROUTE_DENIED');
    if (currentMode === MODE_PLUGIN_ONLY) return typeof legacyGet === 'function' ? await legacyGet() : null;
    const route = await resolveScopedRoute(space, key, { scope:operationScope, noCache:operationOptions.noCache === true });
    if (captureRepair != null && (!route.routed || !authoritativeMirrorRoute(route)
      || route.scopeId !== operationScope.scopeId || operationOptions.readOnlySnapshot === true))
      throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_ROUTE_DENIED');
    if (!route.routed || route.mode === MODE_PLUGIN_ONLY) return typeof legacyGet === 'function' ? await legacyGet() : null;
    if (operationOptions.readOnlySnapshot === true && route.mode === MODE_MIRROR) {
      // A read-only source snapshot must never write the parent. Equal values are
      // merged; a server-only value is read through; a local-only value is ordinary
      // local-ahead mirror state. Only an existing, different server value or a
      // server tombstone for a still-present local value is an ambiguous conflict.
      const localValue = typeof legacyGet === 'function' ? await legacyGet() : null;
      const projected = isNullishStorageValue(localValue) ? null : await routeProjectValue(route, localValue);
      const remote = await remoteGet(space, route.remoteKey, { allowPluginOnly:true, scope:route.scope, storageMode:route.mode });
      if (remote.tombstone === true) { const error=new Error('MEMORY_SUITE_NATIVE_BRANCH_MIRROR_SOURCE_DIVERGED'); error.code='MEMORY_SUITE_NATIVE_BRANCH_MIRROR_SOURCE_DIVERGED'; throw error; }
      if (isNullishStorageValue(projected)) return remote.exists === true ? await routeMergeValue(route, remote.value, null) : null;
      if (remote.exists !== true) return await routeMergeValue(route, null, localValue);
      if (jsonComparable(remote.value) !== jsonComparable(projected)) { const error=new Error('MEMORY_SUITE_NATIVE_BRANCH_MIRROR_SOURCE_DIVERGED'); error.code='MEMORY_SUITE_NATIVE_BRANCH_MIRROR_SOURCE_DIVERGED'; throw error; }
      return await routeMergeValue(route, remote.value, localValue);
    }
    if (authoritativeMirrorRoute(route)) {
      // Local snapshots can be partial after an interrupted mirror copy. Do not
      // treat them as canonical while the server is unavailable. Keep the
      // authoritative read and its local copy inside the same per-key tail as
      // writes/removes, so an older delayed read cannot roll the mirror back.
      return await serializeMutation(space,route.remoteKey,async()=>{
        let row = await remoteGet(space, route.remoteKey, { allowPluginOnly:true, scope:route.scope, storageMode:route.mode });
        if (captureRepair != null) {
          if (row.exists !== true || row.tombstone === true || row.value !== captureRepair.expectedServerValue)
            throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_SERVER_CHANGED');
          const beforeSet = async (legacy, logicalKey, value) => {
            await captureRepair.assertCurrent();
            if (value !== captureRepair.expectedServerValue) throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_SERVER_CHANGED');
            const currentServer = await remoteGet(space, route.remoteKey, { allowPluginOnly:true, scope:route.scope, storageMode:route.mode });
            if (currentServer.exists !== true || currentServer.tombstone === true
              || currentServer.value !== captureRepair.expectedServerValue
              || currentServer.revision !== row.revision || currentServer.digest !== row.digest)
              throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_SERVER_CHANGED');
            await captureRepair.assertCurrent();
            // Run after owner admission, immediately before the physical set.
            // A late local capture can own additional retired raw variants.
            const local = await legacy.getItem(logicalKey);
            if (!isNullishStorageValue(local) && local !== captureRepair.expectedServerValue)
              throw new Error('MEMORY_SUITE_CAPTURE_REPAIR_LOCAL_CHANGED');
          };
          const copied = await mirrorServerRow(space,key,route,row,beforeSet);
          if (copied.verified !== true) throw new Error(`MEMORY_SUITE_CAPTURE_REPAIR_COPY_FAILED:${copied.error || key}`);
          return await routeMergeValue(route,row.value,null);
        }
        if (!row.exists && !row.tombstone) {
          const local = typeof legacyGet === 'function' ? await legacyGet() : null;
          const projected = isNullishStorageValue(local) ? null : await routeProjectValue(route,local);
          if (!isNullishStorageValue(projected)) {
            try { await remoteMutate('set',space,route.remoteKey,projected,{allowPluginOnly:true,expectedRevision:0,scope:route.scope,storageMode:route.mode}); }
            catch (error) { if (error?.status !== 409) throw error; }
            row = await remoteGet(space,route.remoteKey,{allowPluginOnly:true,scope:route.scope,storageMode:route.mode});
            if (!row.exists && !row.tombstone) throw new Error('MEMORY_SUITE_MIRROR_IMPORT_UNCONFIRMED');
          }
        }
        await mirrorServerRow(space,key,route,row);
        return row.exists ? await routeMergeValue(route,row.value,null) : null;
      });
    }
    if (route.mode === MODE_MIRROR) {
      const localValue = typeof legacyGet === 'function' ? await legacyGet() : null;
      const config = await readConfig();
      if (cachedBootstrapFailure(config.url)) {
        setStatus('server_unavailable_local_only', 'memory_suite_server_unavailable', { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
        return localValue;
      }
      const projected = isNullishStorageValue(localValue) ? null : await routeProjectValue(route, localValue);
      if (!isNullishStorageValue(projected)) {
        try {
          const remote = await remoteGet(space, route.remoteKey, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode });
          if (remote.tombstone === true) {
            await routeRemoveLocal(route, legacyGet, legacySet, legacyRemove);
            setStatus('server_tombstone_applied', '', { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
            return typeof legacyGet === 'function' ? await legacyGet() : null;
          }
          void serializeMutation(space, route.remoteKey, async () => {
            try {
              if (remote.exists !== true || jsonComparable(remote.value) !== jsonComparable(projected)) {
                await remoteMutate('set', space, route.remoteKey, projected, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode });
              }
              setStatus('synced', '', { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
            } catch (error) {
              setStatus('local_ahead', error?.message || error, { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
            }
          });
          return localValue;
        } catch (error) {
          setStatus('server_unavailable_local_only', error?.message || error, { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
          return localValue;
        }
      }
      try {
        const remote = await remoteGet(space, route.remoteKey, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode });
        if (remote.exists === true) {
          const merged = await routeMergeValue(route, remote.value, localValue);
          if (typeof legacySet === 'function') await legacySet(merged);
          return merged;
        }
        if (remote.tombstone === true) await routeRemoveLocal(route, legacyGet, legacySet, legacyRemove);
        return typeof legacyGet === 'function' ? await legacyGet() : null;
      } catch (error) {
        setStatus('server_unavailable_local_only', error?.message || error, { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
        return localValue;
      }
    }
    // server_only: never fall back silently when the server is unavailable.
    const remote = await remoteGet(space, route.remoteKey, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode });
    if (remote.exists === true) return await routeMergeValue(route, remote.value, null);
    if (remote.tombstone === true) return null;
    if (operationOptions.strictServerOnly === true) return null;
    // Retained local owner bytes from a completed migration are a recovery
    // artifact, not a second authority. They must never be re-adopted as
    // canonical simply because the server row is absent, and must never be
    // silently re-uploaded. Only an explicit maintenance path may observe them.
    if (await isRetiredLocalKey(route.scope, key)) return null;
    const localValue = typeof legacyGet === 'function' ? await legacyGet() : null;
    const projected = isNullishStorageValue(localValue) ? null : await routeProjectValue(route, localValue);
    if (!isNullishStorageValue(projected)) {
      try { await remoteMutate('set', space, route.remoteKey, projected, { expectedRevision: 0, allowPluginOnly: true, scope:route.scope, storageMode:route.mode }); }
      catch (error) {
        if (error?.status !== 409) throw error;
      }
      const migrated = await remoteGet(space, route.remoteKey, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode });
      if (migrated.exists === true) return await routeMergeValue(route, migrated.value, null);
    }
    return null;
  };

  const scopedSetImpl = async (space, key, value, legacySet = null, operationOptions = {}) => {
    const operationScope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(false));
    const currentMode = (await readScopeMode(operationScope, false)).mode;
    if (currentMode === MODE_PLUGIN_ONLY) return typeof legacySet === 'function' ? await legacySet(value) : false;
    const route = await resolveScopedRoute(space, key, { scope:operationScope, noCache:operationOptions.noCache === true });
    if (!route.routed || route.mode === MODE_PLUGIN_ONLY) return typeof legacySet === 'function' ? await legacySet(value) : false;
    const projected = await routeProjectValue(route, value);
    if (authoritativeMirrorRoute(route)) {
      const mirrored=await serializeMutation(space,route.remoteKey,async()=>{
        await remoteMutate('set',space,route.remoteKey,projected,{allowPluginOnly:true,scope:route.scope,storageMode:route.mode});
        return await mirrorServerRow(space,key,route,await remoteGet(space,route.remoteKey,{allowPluginOnly:true,scope:route.scope,storageMode:route.mode}));
      });
      if (operationOptions.requireDurableMirror === true && mirrored?.verified !== true) throw new Error('MEMORY_SUITE_NATIVE_BRANCH_MIRROR_TARGET_READBACK_FAILED');
      return true;
    }
    if (route.mode === MODE_MIRROR) {
      const localOk = typeof legacySet === 'function' ? await legacySet(value) : false;
      if (!localOk) return false;
      try {
        await serializeMutation(space, route.remoteKey, () => remoteMutate('set', space, route.remoteKey, projected, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode }));
        setStatus('synced', '', { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
      } catch (error) {
        setStatus('local_ahead', error?.message || error, { scopeId: route.scopeId, mode: route.mode, key: compact(key, 160), space });
        if (operationOptions.requireDurableMirror === true) throw error;
        warnOnce(`mirror_server_write_${compact(key, 80)}`, error);
      }
      return true;
    }
    await serializeMutation(space, route.remoteKey, () => remoteMutate('set', space, route.remoteKey, projected, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode }));
    return true;
  };

  const scopedRemoveImpl = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null, operationOptions = {}) => {
    const operationScope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(false));
    const currentMode = (await readScopeMode(operationScope, false)).mode;
    if (currentMode === MODE_PLUGIN_ONLY) return typeof legacyRemove === 'function' ? await legacyRemove() : false;
    const route = await resolveScopedRoute(space, key, { scope:operationScope, noCache:operationOptions.noCache === true });
    if (!route.routed || route.mode === MODE_PLUGIN_ONLY) return typeof legacyRemove === 'function' ? await legacyRemove() : false;
    if (authoritativeMirrorRoute(route)) {
      await serializeMutation(space,route.remoteKey,async()=>{
        await remoteMutate('remove',space,route.remoteKey,null,{allowPluginOnly:true,scope:route.scope,storageMode:route.mode});
        await mirrorServerRow(space,key,route,await remoteGet(space,route.remoteKey,{allowPluginOnly:true,scope:route.scope,storageMode:route.mode}));
      });
      return true;
    }
    if (route.mode === MODE_MIRROR) {
      try { await serializeMutation(space, route.remoteKey, () => remoteMutate('remove', space, route.remoteKey, null, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode })); }
      catch (error) { setStatus('mirror_delete_blocked', error?.message || error, { scopeId: route.scopeId, key: compact(key, 160), space }); return false; }
      const localOk = await routeRemoveLocal(route, legacyGet, legacySet, legacyRemove);
      if (!localOk) return false;
      return true;
    }
    await serializeMutation(space, route.remoteKey, () => remoteMutate('remove', space, route.remoteKey, null, { allowPluginOnly: true, scope:route.scope, storageMode:route.mode }));
    return true;
  };

  const scopedKeysImpl = async (space, prefix = '', legacyKeysFn = null, operationOptions = {}) => {
    const currentScope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(false));
    const currentMode = (await readScopeMode(currentScope, false)).mode;
    const legacy = typeof legacyKeysFn === 'function' ? await legacyKeysFn() : [];
    const legacyList = Array.isArray(legacy) ? legacy.map(String).filter(Boolean) : [];
    // Do not inspect foreign routes or enumerate the server while the active
    // scope is plugin-only.  Explicit bridge.serverKeys() remains available.
    if (currentMode === MODE_PLUGIN_ONLY) return [...new Set(legacyList)];
    const enforceScopeOwnership = operationOptions.enforceScopeOwnership === true;
    const ownedByScope = route => route?.kind === 'scope' && route.scopeId === currentScope.scopeId;
    const visible = [];
    let requiresServer = currentMode !== MODE_PLUGIN_ONLY;
    for (const key of legacyList) {
      if (!matchesRoute(space, key)) { visible.push(key); continue; }
      const route = await resolveScopedRoute(space, key, { scope: currentScope });
      if (enforceScopeOwnership && !ownedByScope(route)) continue;
      if (route.mode !== MODE_SERVER_ONLY && !authoritativeMirrorRoute(route)) visible.push(key);
      if (route.mode !== MODE_PLUGIN_ONLY) requiresServer = true;
    }
    if (!requiresServer) return [...new Set(visible)];
    let remote = { keys: [], tombstones: [] };
    try { remote = await remoteKeys(space, prefix, { allowPluginOnly: true, scope:currentScope, storageMode:currentMode }); }
    catch (error) {
      if (requiresServer && (currentMode === MODE_SERVER_ONLY || namespace === 'libra')) throw error;
      return [...new Set(visible)];
    }
    const tombstones = new Set();
    for (const raw of Array.isArray(remote.tombstones) ? remote.tombstones : []) {
      const decoded = scopedRemoteKeyInfo(raw);
      if (decoded.scopeId && decoded.scopeId !== currentScope.scopeId) continue;
      tombstones.add(decoded.logicalKey);
    }
    for (const remoteKey of Array.isArray(remote.keys) ? remote.keys : []) {
      const decoded = scopedRemoteKeyInfo(remoteKey);
      if (decoded.scopeId && decoded.scopeId !== currentScope.scopeId) continue;
      const route = await resolveScopedRoute(space, decoded.logicalKey, { scope: decoded.scopeId ? { ...currentScope, scopeId: decoded.scopeId, scopeKey: decoded.scopeId } : currentScope });
      if (enforceScopeOwnership && !(decoded.scopeId ? decoded.scopeId === currentScope.scopeId : ownedByScope(route))) continue;
      if (route.mode !== MODE_PLUGIN_ONLY && !tombstones.has(decoded.logicalKey)) visible.push(decoded.logicalKey);
    }
    return [...new Set(visible.filter(key => !tombstones.has(key)))];
  };

  const scheduleScopedAutomaticMigration = (legacy, space) => {
    const enabled = space === 'plugin' ? autoMigratePlugin : autoMigrateLocal;
    if (!enabled || !legacy || typeof legacy.keys !== 'function') return;
    const migration = state.migration[space];
    if (!migration || migration.scheduled === true || migration.state === 'running') return;
    migration.scheduled = true;
    const run = async () => {
      migration.scheduled = false;
      let scope = null;
      try {
        // The independent startup timer cannot bypass the saved journal's
        // physical DATA admission or import legacy mode arguments first.
        await loadPersistedSyncJob();
        if (state.syncJob.creating) {
          state.migration[space] = { ...migration, state:'paused', at:Date.now(), reason:'sync_job_creating', scheduled:false };
          return;
        }
        const pending = getSyncJob();
        if (pending && !syncJobTerminal(pending.status)) {
          try { await assertDurableJobAdmission(pending); }
          catch (error) {
            if (error?.serverPinFailure === true) await pauseSyncJobForServerPin(error);
            throw error;
          }
        }
        scope = await resolveCurrentScope(false);
        if (!scope?.scopeId) {
          state.migration[space] = { ...migration, state:'lazy_only', at:Date.now(), reason:'current_scope_unavailable', scheduled:false };
          return;
        }
        const modeState = await readScopeMode(scope, false);
        if (modeState.mode === MODE_PLUGIN_ONLY) {
          state.migration[space] = { ...migration, state:'idle', at:Date.now(), reason:'scope_plugin_only', scheduled:false };
          return;
        }
        state.migration[space] = { ...migration, state:'running', at:Date.now(), reason:'scope_automatic_migration', scheduled:false };
        const result = await scopedSynchronizeSpace(legacy, space, {
          scope, allowOverwrite:false, restoreMissingLocal:modeState.mode === MODE_MIRROR
        });
        state.migration[space] = {
          state:'complete', scanned:Number(result.totalItems || 0), migrated:Number(result.uploaded || 0),
          skipped:Number(result.matched || 0), failed:Number(result.failures?.length || 0), at:Date.now(),
          reason:`scope:${scope.scopeId}`, scheduled:false
        };
      } catch (error) {
        const keyEnumerationMissing = error?.code === 'MEMORY_SUITE_KEYS_UNAVAILABLE' || /key_enumeration/i.test(String(error?.message || ''));
        state.migration[space] = {
          ...state.migration[space], state:keyEnumerationMissing?'lazy_only':'partial', at:Date.now(),
          failed:Math.max(1, Number(error?.result?.failures?.length || 0) || 1), reason:compact(error?.message || error, 300), scheduled:false
        };
        if (!keyEnumerationMissing && error?.serverPinFailure !== true && retryableSyncError(error)) {
          scheduleLifecycleTimeout(() => scheduleScopedAutomaticMigration(legacy, space), migrationRetryMs);
        }
      }
    };
    const timer = scheduleLifecycleTimeout(() => { void withOwnerIO(space,'',run).catch(error=>{ migration.scheduled=false; if(error?.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS') scheduleLifecycleTimeout(()=>scheduleScopedAutomaticMigration(legacy,space),migrationRetryMs); else warnOnce('automatic_migration',error); }); }, migrationDelayMs);
    try { timer?.unref?.(); } catch (_) {}
  };

  const legacyStoreForSpace = async space => String(space || 'plugin') === 'local' ? await rawDeviceStorage() : rawPluginStorage();
  const explicitScopeAccessors = async (spaceValue, keyValue) => {
    const space=String(spaceValue||'plugin')==='local'?'local':'plugin', key=String(keyValue||''), legacy=await legacyStoreForSpace(space);
    return {get:async()=>typeof legacy?.getItem==='function'?await legacy.getItem(key):null,set:async next=>typeof legacy?.setItem==='function'?(await legacy.setItem(key,next))!==false:false,remove:async()=>{if(typeof legacy?.removeItem==='function')return(await legacy.removeItem(key))!==false;if(typeof legacy?.setItem==='function')return(await legacy.setItem(key,null))!==false;return false;},keys:async()=>typeof legacy?.keys==='function'?await legacy.keys():[]};
  };
  const explicitNativeBranchGet=async(scopeInput,space,key,capability)=>{const scope=assertNativeBranchScopeCapability(capability,scopeInput,'read');await nativeBranchAccessGuard(capability,scope,'read');await assertNativeBranchKeyOwnership(scope,capability,String(space||'plugin'),String(key));const a=await explicitScopeAccessors(space,key);return await scopedGet(String(space||'plugin'),String(key),a.get,a.set,a.remove,{scope,noCache:true,readOnlySnapshot:scope.scopeId===capability.sourceScopeId,strictServerOnly:true});};
  const explicitNativeBranchSet=async(scopeInput,space,key,value,capability)=>{const scope=assertNativeBranchScopeCapability(capability,scopeInput,'write');await nativeBranchAccessGuard(capability,scope,'write');await assertNativeBranchKeyOwnership(scope,capability,String(space||'plugin'),String(key));const a=await explicitScopeAccessors(space,key);return await scopedSet(String(space||'plugin'),String(key),value,a.set,{scope,noCache:true,requireDurableMirror:true});};
  const explicitNativeBranchRemove=async(scopeInput,space,key,capability)=>{const scope=assertNativeBranchScopeCapability(capability,scopeInput,'remove');await nativeBranchAccessGuard(capability,scope,'write');await assertNativeBranchKeyOwnership(scope,capability,String(space||'plugin'),String(key));const a=await explicitScopeAccessors(space,key);return await scopedRemove(String(space||'plugin'),String(key),a.get,a.set,a.remove,{scope,noCache:true});};
  const explicitNativeBranchKeys=async(scopeInput,space,prefix,capability)=>{const scope=assertNativeBranchScopeCapability(capability,scopeInput,'read');const a=await explicitScopeAccessors(space,'');return await scopedKeys(String(space||'plugin'),String(prefix||''),a.keys,{scope,noCache:true,enforceScopeOwnership:true});};
  const openNativeBranchScopeView=(scopeInput,viewOptions={})=>{const capability=viewOptions.capability,accessMode=String(viewOptions.access||'read').toLowerCase(),scope=assertNativeBranchScopeCapability(capability,scopeInput,accessMode==='read'?'read':'write'),writable=accessMode==='write'||accessMode==='readwrite';return Object.freeze({scope:Object.freeze({...scope}),access:writable?'readwrite':'read',getItem:async key=>await explicitNativeBranchGet(scope,'plugin',key,capability),keys:async prefix=>await explicitNativeBranchKeys(scope,'plugin',prefix,capability),setItem:writable?async(key,value)=>await explicitNativeBranchSet(scope,'plugin',key,value,capability):async()=>{throw new Error('MEMORY_SUITE_NATIVE_BRANCH_SOURCE_READ_ONLY')},removeItem:writable?async key=>await explicitNativeBranchRemove(scope,'plugin',key,capability):async()=>{throw new Error('MEMORY_SUITE_NATIVE_BRANCH_SOURCE_READ_ONLY')}});};

  const withOwnerIO = async (space, key, factory) => {
    if (!matchesRoute(space, String(key || '')) && key !== '') return await factory();
    return await withOwnerOperation({kind:'owner_io',space,key:String(key || '')}, async () => {
    await loadPersistedSyncJob();
    if(state.syncJob.current?.kind==='global_mode'&&!syncJobTerminal(state.syncJob.current.status))throw transitionBusyError();
    // Preparation still uses the source store: an admitted operation may call
    // the proxy again before it finishes. Freeze I/O only after that work drains.
    if (modeConfigurationFrozen || (storageTransition && storageTransition.phase !== 'draining')) throw transitionBusyError();
    const work = Promise.resolve().then(factory);
    ownerIOWork.add(work);
    try { return await work; } finally { ownerIOWork.delete(work); }
    });
  };
  const scopedGet = (...args) => withOwnerIO(args[0],args[1],()=>scopedGetImpl(...args));
  const scopedSet = (...args) => withOwnerIO(args[0],args[1],()=>scopedSetImpl(...args));
  const scopedRemove = (...args) => withOwnerIO(args[0],args[1],()=>scopedRemoveImpl(...args));
  const scopedKeys = (...args) => withOwnerIO(args[0],'',()=>scopedKeysImpl(...args));

  const createScopedProxy = (legacy, space, cache) => {
    if (!legacy || (typeof legacy !== 'object' && typeof legacy !== 'function')) return legacy;
    state.legacy[space] = legacy;
    if (cache.has(legacy)) return cache.get(legacy);
    const proxy = Object.freeze({
      getItem: async key => await scopedGet(
        space, String(key),
        async () => typeof legacy.getItem === 'function' ? await legacy.getItem(key) : null,
        async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false,
        async () => {
          if (typeof legacy.removeItem === 'function') return (await legacy.removeItem(key)) !== false;
          if (typeof legacy.setItem === 'function') return (await legacy.setItem(key, null)) !== false;
          return false;
        }
      ),
      setItem: async (key, value) => await scopedSet(space, String(key), value, async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false),
      removeItem: async key => await scopedRemove(
        space, String(key),
        async () => typeof legacy.getItem === 'function' ? await legacy.getItem(key) : null,
        async next => typeof legacy.setItem === 'function' ? (await legacy.setItem(key, next)) !== false : false,
        async () => {
          if (typeof legacy.removeItem === 'function') return (await legacy.removeItem(key)) !== false;
          if (typeof legacy.setItem === 'function') return (await legacy.setItem(key, null)) !== false;
          return false;
        }
      ),
      keys: async prefix => await scopedKeys(space, String(prefix || ''), async () => typeof legacy.keys === 'function' ? await legacy.keys() : [])
    });
    cache.set(legacy, proxy);
    scheduleScopedAutomaticMigration(legacy, space);
    if (space === 'plugin') scheduleLifecycleTimeout(() => {
      void (async () => {
        if (state.syncJob.creating) return;
        await loadPersistedSyncJob();
        const pending=getSyncJob();
        if(pending?.kind==='global_mode'&&!syncJobTerminal(pending.status)){await scopedResumePendingSyncJob();return;}
        let checked=false;
        if (pending && !syncJobTerminal(pending.status)) {
          try {
            await assertStoredDurableJobMetadata(pending);
            // Preserve an old legacy mode carrier until its pending work has a
            // verified DATA boundary. Local-only startup still does no probe.
            if (normalizeMode(await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY)) !== MODE_PLUGIN_ONLY) {
              await assertDurableJobAdmission(pending);checked=true;
            }
          }
          catch(error){if(error.serverPinFailure){await pauseSyncJobForServerPin(error);return;}throw error;}
        }
        const scope = await resolveCurrentScope(false);
        const modeState = await readScopeMode(scope, false);
        if (modeState.mode === MODE_PLUGIN_ONLY) return;
        if (pending && !syncJobTerminal(pending.status) && !checked) {
          try {await assertDurableJobAdmission(pending);}
          catch(error){if(error.serverPinFailure){await pauseSyncJobForServerPin(error);return;}throw error;}
        }
        await hydrateScopeRegistryFromServer();
        await scopedResumePendingSyncJob();
      })().catch(() => {});
    }, 0);
    return proxy;
  };

  const scopeRouteMatches = (route, targetScope) => {
    if (!route?.routed || route.kind === 'global' || route.includeInScopeSync === false) return false;
    if (route.kind === 'shared') return route.includeInScopeSync === true;
    return !!targetScope?.scopeId && route.scopeId === targetScope.scopeId;
  };

  const collectScopedLegacyRows = async (legacy, space, scope) => {
    const listed = await legacyKeys(legacy);
    if (listed == null) {
      const error = new Error('memory_suite_pluginstorage_key_enumeration_required');
      error.code = 'MEMORY_SUITE_KEYS_UNAVAILABLE';
      throw error;
    }
    const rows = [];
    for (const key of listed.map(String).filter(Boolean)) {
      if (!matchesRoute(space, key)) continue;
      const route = await resolveScopedRoute(space, key, { scope, noCache: true });
      if (scopeRouteMatches(route, scope)) rows.push({ key, route });
    }
    return rows;
  };

  const inspectNativeBranchTargetLocalData = async (scopeInput = null) => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    if (!scope.scopeId) return { schema:'memory-suite.native-branch-local-inventory.v1', namespace, scope, total:0, plugin:0, local:0, keys:[] };
    const summary = { schema:'memory-suite.native-branch-local-inventory.v1', namespace, scope, total:0, plugin:0, local:0, keys:[] };
    const inspectSpace = async (legacy, space) => {
      if (!legacy || typeof legacy.keys !== 'function') return;
      const rows = await collectScopedLegacyRows(legacy, space, scope);
      summary[space] = rows.length;
      summary.total += rows.length;
      for (const row of rows) summary.keys.push({ space, key:String(row.key || ''), remoteKey:String(row.route?.remoteKey || '') });
    };
    await inspectSpace(state.legacy.plugin, 'plugin');
    await inspectSpace(state.legacy.local, 'local');
    return summary;
  };

  // ---- R02: retained-local retirement -------------------------------------
  // Migration keeps local bytes as a recovery artifact. Once the server copy is
  // read back and verified, the local copy is explicitly retired so a later
  // server_only read can never resurrect it as a second authority. The marker
  // never deletes bytes and is scoped to the exact migration.
  const simpleDigest = value => {
    const source = safeText(value);
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
    return `msd1_${hash.toString(16).padStart(8, '0')}_${source.length.toString(16)}`;
  };
  const parseRetiredLocalRegistry = raw => {
    let source = raw;
    if (typeof source === 'string') { try { source = JSON.parse(source); } catch (_) { source = null; } }
    source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const entries = {};
    const incoming = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries) ? source.entries : {};
    for (const [scopeIdRaw, rowRaw] of Object.entries(incoming)) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const scopeId = String(scopeIdRaw || row.scopeId || '').trim();
      if (!scopeId) continue;
      const keys = Array.isArray(row.keys) ? [...new Set(row.keys.map(k => String(k || '').trim()).filter(Boolean))].slice(0, 8192) : [];
      entries[scopeId] = {
        scopeId, disposition: String(row.disposition || ''), serverDigest: String(row.serverDigest || ''),
        retiredAt: String(row.retiredAt || ''), keys, updatedAt: Math.max(0, Number(row.updatedAt || 0) || 0)
      };
    }
    return { schema: RETIRED_SCHEMA, namespace, pluginId, entries };
  };
  const retiredRegistryCache = { loaded: false, value: null, loading: null };
  const loadRetiredLocalRegistry = async (force = false) => {
    if (!force && retiredRegistryCache.loaded && retiredRegistryCache.value) return retiredRegistryCache.value;
    if (!force && retiredRegistryCache.loading) return await retiredRegistryCache.loading;
    const task = (async () => {
      let raw = null;
      const pluginStore = rawPluginStorage();
      try { raw = await pluginStore?.getItem?.(RETIRED_LOCAL_KEY); } catch (error) { reportStorageFailure('retired.local.registry.read.plugin', error); }
      if (raw == null || raw === '') {
        const deviceStore = await rawDeviceStorage().catch(() => null);
        try { raw = await deviceStore?.getItem?.(RETIRED_LOCAL_KEY); } catch (error) { reportStorageFailure('retired.local.registry.read.device', error); }
      }
      const registry = parseRetiredLocalRegistry(raw);
      retiredRegistryCache.value = registry;
      retiredRegistryCache.loaded = true;
      return registry;
    })();
    retiredRegistryCache.loading = task;
    try { return await task; } finally { retiredRegistryCache.loading = null; }
  };
  const writeRetiredLocalRegistry = (...args) => withOwnerOperation({kind:'storage_operation',operation:'writeRetiredLocalRegistry'}, () => writeRetiredLocalRegistryImpl(...args));
  const writeRetiredLocalRegistryImpl = async registryValue => {
    const registry = parseRetiredLocalRegistry(registryValue);
    const payload = JSON.stringify(registry);
    let success = false;
    const pluginStore = rawPluginStorage();
    if (pluginStore?.setItem) {
      try {
        const result = await pluginStore.setItem(RETIRED_LOCAL_KEY, payload);
        if (result !== false) { const readback = await pluginStore.getItem?.(RETIRED_LOCAL_KEY); success = String(readback || '') === payload; }
      } catch (error) { reportStorageFailure('retired.local.registry.write.plugin', error); }
    }
    const deviceStore = await rawDeviceStorage().catch(() => null);
    if (deviceStore?.setItem) {
      try {
        const result = await deviceStore.setItem(RETIRED_LOCAL_KEY, payload);
        const readback = await deviceStore.getItem?.(RETIRED_LOCAL_KEY);
        if (result !== false && String(readback || '') === payload) success = true;
      } catch (error) { reportStorageFailure('retired.local.registry.write.device', error); }
    }
    if (!success) {
      const error = new Error('memory_suite_retired_local_registry_unavailable');
      error.code = 'MEMORY_SUITE_RETIRED_LOCAL_REGISTRY_UNAVAILABLE';
      throw error;
    }
    retiredRegistryCache.value = registry;
    retiredRegistryCache.loaded = true;
    return registry;
  };
  const retiredEntryForScope = async scopeInput => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(false));
    if (!scope.scopeId) return null;
    const registry = await loadRetiredLocalRegistry(false);
    return registry.entries[scope.scopeId] || null;
  };
  const isRetiredLocalKey = async (scope, key) => {
    const entry = await retiredEntryForScope(scope);
    if (!entry) return false;
    if (!entry.keys.length) return true;
    return entry.keys.includes(String(key || ''));
  };
  const retireNativeBranchLocalTargetData = (...args) => withOwnerOperation({kind:'storage_operation',operation:'retireNativeBranchLocalTargetData'}, () => retireNativeBranchLocalTargetDataImpl(...args));
  const retireNativeBranchLocalTargetDataImpl = async retireOptions => {
    const scope = normalizeScopeDescriptor(retireOptions?.scope || null);
    if (!scope.scopeId) throw new Error('memory_suite_retire_scope_required');
    const keys = Array.isArray(retireOptions?.keys)
      ? [...new Set(retireOptions.keys.map(value => String(value || '').trim()).filter(Boolean))]
      : [];
    // Retirement is only valid once the server copy is verified. Confirm the
    // readback for every retired key, then record the digest of what the server
    // actually holds. A missing tombstone/value fails closed: nothing is retired.
    const digests = [];
    for (const key of keys) {
      const route = await resolveScopedRoute('plugin', key, { scope, noCache: true });
      if (route.mode === MODE_PLUGIN_ONLY) {
        const error = new Error('memory_suite_retire_requires_server_authority');
        error.code = 'MEMORY_SUITE_RETIRE_SERVER_AUTHORITY_REQUIRED';
        error.key = key;
        throw error;
      }
      const row = await remoteGet('plugin', route.remoteKey, { allowPluginOnly: true, scope, storageMode: route.mode });
      if (row.exists !== true || row.tombstone === true) {
        const error = new Error('memory_suite_retire_server_readback_missing');
        error.code = 'MEMORY_SUITE_RETIRE_SERVER_READBACK_MISSING';
        error.key = key;
        throw error;
      }
      digests.push(`${key}\u0000${String(row.digest || '')}\u0000${jsonComparable(row.value)}`);
    }
    const serverDigest = simpleDigest(digests.sort().join('\n'));
    const retiredAt = new Date().toISOString();
    const registry = await loadRetiredLocalRegistry(true);
    const previous = registry.entries[scope.scopeId] || {};
    const mergedKeys = [...new Set([...(Array.isArray(previous.keys) ? previous.keys : []), ...keys])];
    registry.entries[scope.scopeId] = {
      scopeId: scope.scopeId, disposition: 'retired_after_server_readback', serverDigest, retiredAt,
      keys: mergedKeys, updatedAt: Date.now()
    };
    await writeRetiredLocalRegistry(registry);
    return { retired: true, disposition: 'retired_after_server_readback', serverDigest, retiredAt, keys: mergedKeys };
  };
  // Explicit maintenance path: the only way to observe retired local bytes.
  const inspectNativeBranchRetiredLocalData = async (scopeInput = null) => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(true));
    const base = { schema: 'memory-suite.native-branch-retired-local.v1', namespace, scope, disposition: '', total: 0, keys: [] };
    if (!scope.scopeId) return base;
    const entry = await retiredEntryForScope(scope);
    if (!entry) return base;
    const rows = await collectScopedLegacyRows(state.legacy.plugin, 'plugin', scope).catch(() => []);
    const present = new Set(rows.map(row => String(row.key || '')));
    const candidateKeys = entry.keys.length ? entry.keys : [...present];
    const keys = candidateKeys.filter(key => present.has(key));
    return {
      ...base, disposition: entry.disposition, serverDigest: entry.serverDigest, retiredAt: entry.retiredAt,
      total: keys.length, keys, retiredKeyCount: entry.keys.length
    };
  };

  const scopedSynchronizeSpace = async (legacy, space = 'plugin', syncOptions = {}) => {
    const scope = normalizeScopeDescriptor(syncOptions.scope || await resolveCurrentScope(true));
    const reset=await qualifyResetChoiceForScope(scope);
    if(reset?.choice==='empty')throw new Error('서버 자료 사용 모드에서는 기존 로컬 기억을 자동 업로드하지 않습니다. 로컬 기억 다시 업로드를 명시적으로 선택하세요.');
    if (!legacy) throw new Error('memory_suite_pluginstorage_unavailable');
    if (!scope.scopeId) throw new Error('memory_suite_current_scope_unavailable');
    if(deletedScopesForResetChoice(reset).includes(scope.scopeId))throw new Error('libra_deleted_scope_sync_blocked');
    const onProgress = typeof syncOptions.onProgress === 'function' ? syncOptions.onProgress : null;
    const dryRun = syncOptions.dryRun === true;
    const progress = {
      schema: 'memory-suite.sync-progress.v2', namespace, space, scopeId: scope.scopeId, scopeLabel: scope.label,
      phase: 'integrity_before', currentAction: '서버 무결성 확인', currentKey: '', totalItems: 0, processedItems: 0,
      processedBytes: 0, transferredBytes: 0, uploaded: 0, restored: 0, matched: 0, removedByTombstone: 0,
      failureCount: 0, conflictCount: 0, startedAt: Date.now(), lastActivityAt: Date.now()
    };
    const report = (phase, patch = {}) => {
      Object.assign(progress, patch || {}, { phase: String(phase || progress.phase), lastActivityAt: Date.now() });
      try { onProgress?.({ ...progress }); } catch (_) {}
    };
    const metrics = createScopedSyncMetrics();
    const readLocal = async (key, operation = 'local_read') => {
      const value = await legacyRead(legacy, key);
      const bytes = isNullishStorageValue(value) ? 0 : storageValueBytes(value);
      recordScopedSyncMetric(metrics, operation, { localReadCount: 1, localReadBytes: bytes, localBytes: bytes });
      return value;
    };
    const writeLocal = async (key, value, operation = 'local_write') => {
      const bytes = isNullishStorageValue(value) ? 0 : storageValueBytes(value);
      recordScopedSyncMetric(metrics, operation, { localWriteCount: 1, localWriteBytes: bytes, localBytes: bytes });
      return await legacyWriteVerified(legacy, key, value);
    };
    const removeLocal = async (key, operation = 'local_remove') => {
      recordScopedSyncMetric(metrics, operation, { localRemoveCount: 1 });
      return await legacyRemoveVerified(legacy, key);
    };
    const readRemote = async (remoteKey, operation = 'remote_read') => {
      const remote = await remoteGet(space, remoteKey, { allowPluginOnly: true });
      const bytes = scopedSyncRemoteValueBytes(remote);
      recordScopedSyncMetric(metrics, operation, { remoteReadCount: 1, remoteReadBytes: bytes, remoteBytes: bytes });
      return remote;
    };
    const writeRemote = async (...args) => {
      const value = args[3];
      const bytes = args[0] === 'set' ? storageValueBytes(value) : 0;
      recordScopedSyncMetric(metrics, 'remote_write', { remoteWriteCount: 1, remoteWriteBytes: bytes, remoteBytes: bytes });
      return await remoteMutate(...args);
    };
    const integrityBefore = await remoteIntegrity({ allowPluginOnly: true });
    recordScopedSyncMetric(metrics, 'integrity_before', { remoteReadCount: 1, remoteReadBytes: storageValueBytes(integrityBefore), remoteBytes: storageValueBytes(integrityBefore) });
    report('inventory', { message: `${scope.label || scope.scopeId} 데이터 목록을 조사하고 있습니다.` });
    const localRows = await collectScopedLegacyRows(legacy, space, scope);
    const listing = await remoteKeys(space, '', { allowPluginOnly: true });
    recordScopedSyncMetric(metrics, 'remote_keys', { remoteReadCount: 1, remoteReadBytes: storageValueBytes(listing), remoteListCount: 1, remoteListBytes: storageValueBytes(listing), remoteBytes: storageValueBytes(listing) });
    const remoteRecords = new Map((Array.isArray(listing.records) ? listing.records : []).map(row => [String(row?.key || ''), row]));
    const remoteKeysForScope = new Set();
    for (const remoteKey of Array.isArray(listing.keys) ? listing.keys : []) {
      const decoded = scopedRemoteKeyInfo(remoteKey);
      if (decoded.scopeId === scope.scopeId) remoteKeysForScope.add(remoteKey);
      else if (!decoded.scopeId) {
        const route = await resolveScopedRoute(space, decoded.logicalKey, { scope, noCache: true });
        if (scopeRouteMatches(route, scope) && route.remoteKey === remoteKey) remoteKeysForScope.add(remoteKey);
      }
    }
    const localRemoteKeys = new Set(localRows.map(row => row.route.remoteKey));
    const missingRemoteRows = syncOptions.restoreMissingLocal === true
      ? Array.from(remoteKeysForScope).filter(remoteKey => !localRemoteKeys.has(remoteKey))
      : [];
    progress.totalItems = localRows.length + missingRemoteRows.length;
    report('inventory_complete', { totalItems: progress.totalItems, currentAction: '목록 조사 완료' });
    const result = {
      schema: 'memory-suite.scope-sync.v1', namespace, space, scope, startedAt: progress.startedAt,
      totalItems: progress.totalItems, processedItems: 0, processedBytes: 0, transferredBytes: 0,
      uploaded: 0, restored: 0, matched: 0, removedByTombstone: 0,
      plannedUploaded: 0, plannedRestored: 0, dryRun, conflicts: [], failures: [], failureDetails: [],
      metrics, requestedMode: syncOptions.requestedMode || '', effectiveMode: syncOptions.effectiveMode || '',
      integrityBefore, integrityAfter: null
    };
    for (const row of localRows) {
      let bytes = 0, localBytes = 0, remoteBytes = 0, stage = 'local_read', operation = 'local_compare', action = '비교';
      try {
        report('sync_local', { currentKey: row.key, currentAction: 'pluginStorage → 서버 비교' });
        stage = 'local_read'; operation = 'local_compare';
        const local = await readLocal(row.key, operation);
        localBytes = isNullishStorageValue(local) ? 0 : storageValueBytes(local);
        const projected = isNullishStorageValue(local) ? null : await routeProjectValue(row.route, local);
        bytes = isNullishStorageValue(projected) ? 0 : storageValueBytes(projected);
        localBytes = bytes;
        if (isNullishStorageValue(projected)) action = '빈 값 건너뜀';
        else {
          stage = 'remote_read'; operation = 'remote_compare';
          const remote = await readRemote(row.route.remoteKey, operation);
          remoteBytes = scopedSyncRemoteValueBytes(remote);
          if (remote.exists === true && jsonComparable(remote.value) === jsonComparable(projected)) { result.matched += 1; action = '일치 확인'; }
          else if (remote.tombstone === true && syncOptions.resurrectTombstones !== true) {
            if (!dryRun && syncOptions.allowOverwrite !== false && syncOptions.restoreMissingLocal === true) {
              const removed = await routeRemoveLocal(
                row.route,
                async()=>readLocal(row.key,'tombstone_local_read'),
                async next=>writeLocal(row.key,next,'tombstone_local_write'),
                async()=>removeLocal(row.key,'tombstone_local_remove')
              );
              if (!removed) throw new Error('pluginstorage_tombstone_apply_failed');
              result.removedByTombstone += 1;
              action = '서버 삭제 상태 반영';
            } else {
              result.conflicts.push({ key: row.key, remoteKey: row.route.remoteKey, reason: 'server_tombstone', localPreserved: true, serverPreserved:true });
              action = '삭제 충돌 보존';
            }
          } else if (authoritativeMirrorRoute(row.route) && remote.exists === true) {
            if (dryRun) result.plannedRestored += 1;
            else {
              const mirror = await mirrorServerRow(space,row.key,row.route,remote);
              if (!mirror.verified) throw new Error(mirror.error);
              result.restored += 1; result.transferredBytes += bytes;
            }
            action = '서버 정본 → 로컬 복사본 갱신';
          } else if (syncOptions.allowOverwrite === false && remote.exists === true) {
            const reason = 'server_value_mismatch';
            result.conflicts.push({ key: row.key, remoteKey: row.route.remoteKey, reason, localPreserved: true, serverPreserved:true });
            action = '값 충돌 보존';
          } else if (dryRun) {
            result.plannedUploaded += 1;
            action = remote.exists === true ? '서버 덮어쓰기 예정' : '서버 업로드 예정';
          } else {
            stage = 'remote_write'; operation = 'remote_write';
            await writeRemote('set', space, row.route.remoteKey, projected, { allowPluginOnly: true });
            result.uploaded += 1; result.transferredBytes += bytes; action = '서버 저장·검증 완료';
          }
        }
      } catch (error) { const detail = scopedSyncFailure({ key: row.key, stage, operation, error, localBytes, remoteBytes }); result.failures.push(detail); result.failureDetails.push(detail); action = '실패'; }
      finally {
        result.processedItems += 1; result.processedBytes += bytes;
        Object.assign(progress, { processedItems: result.processedItems, processedBytes: result.processedBytes, transferredBytes: result.transferredBytes, uploaded: result.uploaded, restored: result.restored, matched: result.matched, removedByTombstone: result.removedByTombstone, failureCount: result.failures.length, conflictCount: result.conflicts.length, metrics: cloneScopedSyncMetrics(metrics) });
        report('sync_local', { currentKey: row.key, currentAction: action });
      }
    }
    for (const remoteKey of missingRemoteRows) {
      let bytes = Math.max(0, Number(remoteRecords.get(remoteKey)?.valueBytes || 0) || 0), localBytes = 0, remoteBytes = bytes, stage = 'remote_read', operation = 'restore_remote_read', action = '서버 → pluginStorage 복구';
      try {
        const decoded = scopedRemoteKeyInfo(remoteKey);
        const route = await resolveScopedRoute(space, decoded.logicalKey, { scope, noCache: true });
        stage = 'remote_read'; operation = 'restore_remote_read';
        const remote = await readRemote(remoteKey, operation);
        remoteBytes = scopedSyncRemoteValueBytes(remote) || bytes;
        if (remote.exists === true) {
          stage = 'local_read'; operation = 'restore_local_read';
          const current = await readLocal(decoded.logicalKey, operation);
          localBytes = isNullishStorageValue(current) ? 0 : storageValueBytes(current);
          const merged = await routeMergeValue(route, remote.value, current);
          if (dryRun) {
            result.plannedRestored += 1; action = '복구 가능 확인';
          } else {
            stage = 'local_write'; operation = 'restore_local_write';
            if (!await writeLocal(decoded.logicalKey, merged, operation)) throw new Error('pluginstorage_restore_failed');
            result.restored += 1; result.transferredBytes += bytes; action = '복구·readback 완료';
          }
        }
      } catch (error) { const detail = scopedSyncFailure({ key: remoteKey, stage, operation, error, localBytes, remoteBytes }); result.failures.push(detail); result.failureDetails.push(detail); action = '복구 실패'; }
      finally {
        result.processedItems += 1; result.processedBytes += bytes;
        Object.assign(progress, { processedItems: result.processedItems, processedBytes: result.processedBytes, transferredBytes: result.transferredBytes, uploaded: result.uploaded, restored: result.restored, matched: result.matched, removedByTombstone: result.removedByTombstone, failureCount: result.failures.length, conflictCount: result.conflicts.length, metrics: cloneScopedSyncMetrics(metrics) });
        report('sync_remote', { currentKey: remoteKey, currentAction: action });
      }
    }
    report('integrity_after', { currentKey: '', currentAction: dryRun ? '사전검사 완료' : '최종 무결성 확인', message: dryRun ? '쓰기 없는 모드 전환 사전검사를 완료했습니다.' : '현재 스코프 동기화 후 서버 DATA 무결성을 확인하고 있습니다.' });
    result.integrityAfter = dryRun ? integrityBefore : await remoteIntegrity({ allowPluginOnly: true });
    if (!dryRun) recordScopedSyncMetric(metrics, 'integrity_after', { remoteReadCount: 1, remoteReadBytes: storageValueBytes(result.integrityAfter), remoteBytes: storageValueBytes(result.integrityAfter) });
    result.metrics = cloneScopedSyncMetrics(metrics);
    result.failureDetails = result.failures.slice();
    result.diagnostics = { schema: 'memory-suite.scope-sync-diagnostics.v1', metrics: result.metrics, failures: result.failureDetails.slice() };
    result.ok = result.failures.length === 0 && result.conflicts.length === 0;
    report(result.ok ? 'scope_complete' : 'scope_incomplete', { currentKey: '', currentAction: result.ok ? '스코프 동기화 완료' : '확인 필요', message: result.ok ? `${scope.label || scope.scopeId} 동기화를 완료했습니다.` : `실패 ${result.failures.length} · 충돌 ${result.conflicts.length}` });
    if (!result.ok) {
      const error = new Error(`memory_suite_scope_sync_incomplete:${scope.scopeId}:failures=${result.failures.length},conflicts=${result.conflicts.length}`);
      error.code = 'MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE'; error.result = result; throw error;
    }
    return result;
  };

  const scopedSynchronizeAll = async (syncOptions = {}) => {
    const scope = normalizeScopeDescriptor(syncOptions.scope || await resolveCurrentScope(true));
    if (syncOptions.allowRecoveryRequired !== true) await assertRecoveryActionAllowed(scope, 'synchronize');
    const modeState = await readScopeMode(scope, true);
    const requestedMode = normalizeMode(syncOptions.requestedMode || syncOptions.mode || modeState.mode);
    const result = {
      schema: 'memory-suite.scope-sync-all.v1', namespace, scope, plugin: null, local: null,
      requestedMode, effectiveMode: modeState.mode,
      uploaded: 0, restored: 0, matched: 0, removedByTombstone: 0,
      plannedUploaded: 0, plannedRestored: 0, failures: [], failureDetails: [], conflicts: [],
      totalItems: 0, processedItems: 0, processedBytes: 0, transferredBytes: 0,
      metrics: createScopedSyncMetrics()
    };
    const forward = progress => { try { syncOptions.onProgress?.(progress); } catch (_) {} };
    const addPart = (space, part) => {
      result[space] = part;
      for (const field of ['uploaded','restored','matched','removedByTombstone','plannedUploaded','plannedRestored','totalItems','processedItems','processedBytes','transferredBytes']) result[field] += Number(part?.[field] || 0);
      mergeScopedSyncMetrics(result.metrics, part?.metrics);
      for (const failure of Array.isArray(part?.failures) ? part.failures : []) {
        const detail = { ...failure, space: String(space) };
        result.failures.push(detail); result.failureDetails.push(detail);
      }
      for (const conflict of Array.isArray(part?.conflicts) ? part.conflicts : []) result.conflicts.push({ ...conflict, space: String(space) });
    };
    const runPart = async (legacy, space) => {
      if (!legacy || (space === 'local' && typeof legacy.keys !== 'function')) return;
      try {
        const part = await scopedSynchronizeSpace(legacy, space, { ...syncOptions, scope, requestedMode, effectiveMode: modeState.mode, onProgress: forward });
        addPart(space, part);
      } catch (error) {
        const part = error?.result && typeof error.result === 'object' ? error.result : null;
        if (part) addPart(space, part);
        else {
          const detail = scopedSyncFailure({ key: '', stage: 'scope', operation: space + '_scope_sync', error });
          result.failures.push({ ...detail, space }); result.failureDetails.push({ ...detail, space });
        }
      }
    };
    await runPart(state.legacy.plugin, 'plugin');
    await runPart(state.legacy.local, 'local');
    result.metrics = cloneScopedSyncMetrics(result.metrics);
    result.diagnostics = { schema: 'memory_suite.scope-sync-diagnostics.v1', metrics: result.metrics, failures: result.failureDetails.slice(), conflicts: result.conflicts.slice() };
    result.ok = result.failures.length === 0 && result.conflicts.length === 0;
    if (!result.ok) {
      const error = new Error('memory_suite_scope_sync_incomplete:' + scope.scopeId + ':failures=' + result.failures.length + ',conflicts=' + result.conflicts.length);
      error.code = 'MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE'; error.result = result;
      throw error;
    }
    return result;
  };

  const restoreCandidateSummary = row => ({
    space:String(row?.space || ''), logicalKey:String(row?.logicalKey || ''), remoteKey:String(row?.remoteKey || ''),
    kind:String(row?.kind || row?.route?.kind || 'scope'), dependency:row?.dependency === true,
    explicitDependency:row?.explicitDependency === true, dependencyReason:String(row?.dependencyReason || ''),
    valueBytes:Math.max(0, Number(row?.valueBytes || 0) || 0)
  });

  const collectScopedRestoreInventory = async (space, scope) => {
    const listing = await remoteKeys(space, '', { allowPluginOnly:true });
    const records = new Map((Array.isArray(listing?.records) ? listing.records : []).map(row => [String(row?.key || ''), row]));
    const candidates = [], tombstones = [], seenValues = new Set(), seenTombstones = new Set();
    const classify = async (remoteKey, tombstone = false) => {
      const decoded = scopedRemoteKeyInfo(remoteKey);
      const route = await resolveScopedRoute(space, decoded.logicalKey, { scope, noCache:true });
      if (!route?.routed || route.kind === 'global') return;
      const dependency = route.kind === 'shared' && route.includeInScopeSync === true;
      const owned = decoded.scopeId
        ? decoded.scopeId === scope.scopeId
        : scopeRouteMatches(route, scope);
      if (!owned && !dependency) return;
      if (route.remoteKey !== remoteKey) return;
      const row = {
        space, remoteKey, logicalKey:decoded.logicalKey, route,
        kind:route.kind, dependency, valueBytes:Math.max(0, Number(records.get(remoteKey)?.valueBytes || 0) || 0)
      };
      const seen = tombstone ? seenTombstones : seenValues;
      if (seen.has(remoteKey)) return;
      seen.add(remoteKey);
      (tombstone ? tombstones : candidates).push(row);
    };
    for (const remoteKey of Array.isArray(listing?.keys) ? listing.keys.map(String) : []) await classify(remoteKey, false);
    for (const remoteKey of Array.isArray(listing?.tombstones) ? listing.tombstones.map(String) : []) await classify(remoteKey, true);
    return {
      schema:'memory-suite.scope-restore-inventory.v1', namespace, space, scope,
      listing, candidates, tombstones,
      scopeCandidates:candidates.filter(row => !row.dependency),
      dependencyCandidates:candidates.filter(row => row.dependency)
    };
  };

  const expandRestoreDependencies = async (inventories, scope) => {
    if (!resolveRestoreDependencies) return { dependencies:[], warnings:[], metrics:{} };
    const initialCandidates = [
      ...inventories.plugin.candidates.map(restoreCandidateSummary),
      ...inventories.local.candidates.map(restoreCandidateSummary)
    ];
    let raw;
    try {
      raw = await resolveRestoreDependencies({
        namespace, pluginId, pluginVersion, scope, serverCandidates:initialCandidates,
        inventories:{
          plugin:{
            keys:Array.isArray(inventories.plugin.listing?.keys)?inventories.plugin.listing.keys.map(String):[],
            tombstones:Array.isArray(inventories.plugin.listing?.tombstones)?inventories.plugin.listing.tombstones.map(String):[],
            candidates:inventories.plugin.candidates.map(restoreCandidateSummary)
          },
          local:{
            keys:Array.isArray(inventories.local.listing?.keys)?inventories.local.listing.keys.map(String):[],
            tombstones:Array.isArray(inventories.local.listing?.tombstones)?inventories.local.listing.tombstones.map(String):[],
            candidates:inventories.local.candidates.map(restoreCandidateSummary)
          }
        },
        serverRead:async (spaceValue,remoteKey)=>await remoteGet(String(spaceValue||'plugin'),String(remoteKey||''),{allowPluginOnly:true}),
        serverList:async (spaceValue='plugin',prefix='')=>await remoteKeys(String(spaceValue||'plugin'),String(prefix||''),{allowPluginOnly:true})
      });
    } catch (cause) {
      const error = new Error(`memory_suite_restore_dependency_resolver_failed:${compact(cause?.message || cause, 500)}`);
      error.code = 'MEMORY_SUITE_RESTORE_DEPENDENCY_RESOLUTION_FAILED'; error.cause = cause; throw error;
    }
    const source = Array.isArray(raw) ? { dependencies:raw } : (raw && typeof raw === 'object' ? raw : { dependencies:[] });
    const dependencies = Array.isArray(source.dependencies) ? source.dependencies : [];
    const added = [];
    for (const dependencyRaw of dependencies) {
      const dependency = dependencyRaw && typeof dependencyRaw === 'object' ? dependencyRaw : { remoteKey:dependencyRaw };
      const space = String(dependency.space || 'plugin') === 'local' ? 'local' : 'plugin';
      const remoteKey = String(dependency.remoteKey || dependency.key || '').trim();
      const inventory = inventories[space];
      if (!remoteKey) continue;
      const available = new Set(Array.isArray(inventory.listing?.keys) ? inventory.listing.keys.map(String) : []);
      if (!available.has(remoteKey)) {
        if (dependency.optional === true) continue;
        const error = new Error(`memory_suite_restore_dependency_missing:${space}:${remoteKey}`);
        error.code = 'MEMORY_SUITE_RESTORE_DEPENDENCY_MISSING';
        error.dependency = { space, remoteKey, reason:String(dependency.reason || '') };
        throw error;
      }
      const decoded = scopedRemoteKeyInfo(remoteKey);
      const logicalKey = String(dependency.logicalKey || decoded.logicalKey || '').trim();
      if (!logicalKey || !matchesRoute(space, logicalKey)) {
        const error = new Error(`memory_suite_restore_dependency_not_owned:${space}:${logicalKey || remoteKey}`);
        error.code = 'MEMORY_SUITE_RESTORE_DEPENDENCY_NOT_OWNED'; throw error;
      }
      if (inventory.candidates.some(row => row.remoteKey === remoteKey)) continue;
      const route = await resolveScopedRoute(space, logicalKey, { scope, noCache:true });
      if (!route?.routed || route.kind === 'global') {
        const error = new Error(`memory_suite_restore_dependency_route_invalid:${space}:${logicalKey}`);
        error.code = 'MEMORY_SUITE_RESTORE_DEPENDENCY_NOT_OWNED'; throw error;
      }
      const records = new Map((Array.isArray(inventory.listing?.records)?inventory.listing.records:[]).map(row=>[String(row?.key||''),row]));
      const row = {
        space, remoteKey, logicalKey, route, kind:route.kind, dependency:true, explicitDependency:true,
        dependencyReason:String(dependency.reason || ''), valueBytes:Math.max(0,Number(records.get(remoteKey)?.valueBytes||0)||0)
      };
      inventory.candidates.push(row); inventory.dependencyCandidates.push(row); added.push(restoreCandidateSummary(row));
    }
    return {
      dependencies:added,
      warnings:compactRestoreEvidence(Array.isArray(source.warnings)?source.warnings:[]) || [],
      metrics:compactRestoreEvidence(source.metrics || {}) || {}
    };
  };

  const normalizeRestoreValidation = (raw, phase, space) => {
    if (raw == null || raw === true) return { ok:true, phase, space, errors:[], warnings:[], metrics:{} };
    if (raw === false) return { ok:false, phase, space, errors:['restore_semantic_validation_rejected'], warnings:[], metrics:{} };
    const value = raw && typeof raw === 'object' ? raw : {};
    const errors = Array.isArray(value.errors) ? value.errors : (value.error ? [value.error] : []);
    const warnings = Array.isArray(value.warnings) ? value.warnings : (value.warning ? [value.warning] : []);
    return {
      ok:value.ok !== false && errors.length === 0, phase, space,
      errors:compactRestoreEvidence(errors) || [], warnings:compactRestoreEvidence(warnings) || [],
      metrics:compactRestoreEvidence(value.metrics || {}) || {}
    };
  };

  const runRestoreValidator = async context => {
    if (!validateRestore) {
      if (!requireRestoreValidation) return { ok:true, phase:context.phase, space:context.space, errors:[], warnings:[], metrics:{} };
      const error = new Error(`memory_suite_restore_semantic_validator_unavailable:${namespace}`);
      error.code = 'MEMORY_SUITE_RESTORE_VALIDATOR_UNAVAILABLE';
      error.validation = { ok:false, phase:context.phase, space:context.space, errors:['owner_semantic_validator_unavailable'], warnings:[], metrics:{} };
      throw error;
    }
    let raw;
    try { raw = await validateRestore(context); }
    catch (cause) {
      const error = new Error(`memory_suite_restore_semantic_validator_threw:${compact(cause?.message || cause, 400)}`);
      error.code = 'MEMORY_SUITE_RESTORE_SEMANTIC_VALIDATION_FAILED';
      error.validation = { ok:false, phase:context.phase, space:context.space, errors:[compact(cause?.message || cause, 900)], warnings:[], metrics:{} };
      error.cause = cause;
      throw error;
    }
    const validation = normalizeRestoreValidation(raw, context.phase, context.space);
    if (!validation.ok) {
      const error = new Error(`memory_suite_restore_semantic_validation_failed:${context.phase}:${context.space}`);
      error.code = 'MEMORY_SUITE_RESTORE_SEMANTIC_VALIDATION_FAILED';
      error.validation = validation;
      error.metrics = validation.metrics;
      throw error;
    }
    return validation;
  };

  const scopedRestoreSpace = async (legacy, space = 'plugin', restoreOptions = {}) => {
    if (!legacy || typeof legacy.getItem !== 'function' || typeof legacy.setItem !== 'function') {
      const error = new Error(`memory_suite_restore_adapter_unavailable:${space}`);
      error.code = 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE';
      throw error;
    }
    const scope = normalizeScopeDescriptor(restoreOptions.scope || await resolveCurrentScope(true));
    if (!scope.scopeId) throw new Error('memory_suite_current_scope_unavailable');
    const onProgress = typeof restoreOptions.onProgress === 'function' ? restoreOptions.onProgress : null;
    const inventory = restoreOptions.inventory || await collectScopedRestoreInventory(space, scope);
    const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];
    const tombstones = Array.isArray(inventory.tombstones) ? inventory.tombstones : [];
    const result = {
      schema:'memory-suite.scope-restore.v2', namespace, space, scope,
      totalItems:candidates.length + tombstones.length, processedItems:0, restored:0, removed:0, verified:0,
      candidateCount:candidates.length, scopeCandidateCount:candidates.filter(row=>!row.dependency).length,
      dependencyCandidateCount:candidates.filter(row=>row.dependency).length,
      restoredKeys:[], removedKeys:[], failures:[], coverage:[], validation:null
    };
    const report = (phase, patch = {}) => { try { onProgress?.({ schema:'memory-suite.sync-progress.v2', namespace, space, scopeId:scope.scopeId, scopeLabel:scope.label, phase, totalItems:result.totalItems, processedItems:result.processedItems, restored:result.restored, removedByTombstone:result.removed, failureCount:result.failures.length, lastActivityAt:Date.now(), ...patch }); } catch (_) {} };
    report('restore_preflight', { currentAction:'복구 대상과 의존 자료를 검증하고 있습니다.', candidateCount:result.candidateCount, dependencyCandidateCount:result.dependencyCandidateCount });
    for (const row of candidates) {
      try {
        report('restore_values', { currentKey:row.logicalKey, currentAction:row.dependency?'서버 → 공유 의존 자료 복구':'서버 → pluginStorage 복구' });
        const remote = await remoteGet(space, row.remoteKey, { allowPluginOnly:true });
        if (remote.exists !== true) throw new Error('server_record_missing');
        const current = await legacyRead(legacy, row.logicalKey);
        const merged = await routeMergeValue(row.route, remote.value, current);
        if (!(globalMigrationContext && jsonComparable(current)===jsonComparable(merged)) && !await legacyWriteVerified(legacy, row.logicalKey, merged)) throw new Error('pluginstorage_restore_failed');
        const readback = await legacyRead(legacy, row.logicalKey);
        const projected = await routeProjectValue(row.route, readback);
        if (jsonComparable(projected) !== jsonComparable(remote.value)) throw new Error('pluginstorage_restore_coverage_mismatch');
        result.restored += 1; result.verified += 1; result.restoredKeys.push(row.logicalKey);
        result.coverage.push({ key:row.logicalKey, remoteKey:row.remoteKey, dependency:row.dependency, verified:true });
      } catch (error) {
        result.failures.push({ key:row.logicalKey, remoteKey:row.remoteKey, dependency:row.dependency, error:compact(error?.message || error, 300) });
      } finally { result.processedItems += 1; }
    }
    for (const row of tombstones) {
      try {
        report('restore_tombstones', { currentKey:row.logicalKey, currentAction:row.dependency?'공유 의존 자료 삭제 표식 적용':'서버 삭제 표식 적용' });
        const ok = await routeRemoveLocal(row.route, async()=>legacyRead(legacy,row.logicalKey), async next=>legacyWriteVerified(legacy,row.logicalKey,next), async()=>legacyRemoveVerified(legacy,row.logicalKey));
        if (!ok) throw new Error('pluginstorage_tombstone_readback_failed');
        result.removed += 1; result.removedKeys.push(row.logicalKey);
      } catch (error) { result.failures.push({ key:row.logicalKey, remoteKey:row.remoteKey, dependency:row.dependency, error:compact(error?.message || error, 300) }); }
      finally { result.processedItems += 1; }
    }
    if (result.verified !== candidates.length) {
      result.failures.push({ key:'*coverage*', error:`restore_coverage_incomplete:${result.verified}/${candidates.length}` });
    }
    if (result.failures.length === 0) {
      try {
        result.validation = await runRestoreValidator({
          namespace, pluginId, pluginVersion, scope, space, phase:'space_complete',
          serverCandidates:candidates.map(restoreCandidateSummary), restoredKeys:result.restoredKeys.slice(), removedKeys:result.removedKeys.slice(),
          readback:async key=>await legacyRead(legacy,String(key||'')), result
        });
      } catch (error) {
        result.validation = error.validation || null;
        result.metrics = error.metrics || error.validation?.metrics || null;
        error.result = result;
        throw error;
      }
    }
    result.ok = result.failures.length === 0 && result.validation?.ok !== false;
    if (!result.ok) {
      const error = new Error(`memory_suite_scope_restore_incomplete:${scope.scopeId}:${space}:${result.failures.length}`);
      error.code='MEMORY_SUITE_SCOPE_RESTORE_INCOMPLETE'; error.result=result; throw error;
    }
    state.management.lastResult = result;
    return result;
  };

  const scopedRestoreAll = async (restoreOptions = {}) => {
    const scope = normalizeScopeDescriptor(restoreOptions.scope || await resolveCurrentScope(true));
    const result = {
      schema:'memory-suite.scope-restore-all.v2', namespace, scope, plugin:null, local:null,
      failures:[], restored:0, removed:0, verified:0, totalItems:0, processedItems:0,
      candidateCount:0, scopeCandidateCount:0, dependencyCandidateCount:0, validation:null, metrics:null
    };
    const restoreOriginals = [];
    const restoreOriginalKeys = new Set();
    const captureRestoreOriginals = async (space, inventory, legacy) => {
      if (!legacy) return;
      for (const row of [...(inventory?.candidates || []), ...(inventory?.tombstones || [])]) {
        const logicalKey = String(row?.logicalKey || '');
        const identity = `${space}\u0000${logicalKey}`;
        if (!logicalKey || restoreOriginalKeys.has(identity)) continue;
        restoreOriginalKeys.add(identity);
        const value = await legacy.getItem(logicalKey); // exact physical rollback, never hydrated logical values
        restoreOriginals.push({ space, logicalKey, legacy, existed:value !== null && value !== undefined, value });
      }
    };
    const rollbackRestoreOriginals = async () => {
      const rollback = { attempted:restoreOriginals.length, restored:0, removed:0, failures:[], ok:true };
      for (const original of restoreOriginals.slice().reverse()) {
        try {
          const ok = original.existed
            ? await legacyWriteVerified(original.legacy, original.logicalKey, original.value)
            : await legacyRemoveVerified(original.legacy, original.logicalKey);
          if (!ok) throw new Error('pluginstorage_restore_rollback_readback_failed');
          if (original.existed) rollback.restored += 1;
          else rollback.removed += 1;
        } catch (error) {
          rollback.failures.push({ space:original.space, key:original.logicalKey, error:compact(error?.message || error, 300) });
        }
      }
      rollback.ok = rollback.failures.length === 0;
      return rollback;
    };
    const forward = progress => { try { restoreOptions.onProgress?.(progress); } catch (_) {} };
    try {
      if (!scope.scopeId) throw new Error('memory_suite_current_scope_unavailable');
      const pluginInventory = await collectScopedRestoreInventory('plugin', scope);
      const localInventory = await collectScopedRestoreInventory('local', scope);
      const inventories = { plugin:pluginInventory, local:localInventory };
      const dependencyExpansion = await expandRestoreDependencies(inventories, scope);
      result.dependencyExpansion = dependencyExpansion;
      const scopeCandidates = pluginInventory.scopeCandidates.length + localInventory.scopeCandidates.length;
      const allCandidates = pluginInventory.candidates.length + localInventory.candidates.length;
      const allTombstones = pluginInventory.tombstones.length + localInventory.tombstones.length;
      result.candidateCount = allCandidates;
      result.scopeCandidateCount = scopeCandidates;
      result.dependencyCandidateCount = pluginInventory.dependencyCandidates.length + localInventory.dependencyCandidates.length;
      if (!state.legacy.plugin || typeof state.legacy.plugin.getItem !== 'function' || typeof state.legacy.plugin.setItem !== 'function') {
        const error = new Error('memory_suite_restore_adapter_unavailable:plugin');
        error.code = 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE'; throw error;
      }
      if ((localInventory.candidates.length || localInventory.tombstones.length)
        && (!state.legacy.local || typeof state.legacy.local.getItem !== 'function' || typeof state.legacy.local.setItem !== 'function')) {
        const error = new Error('memory_suite_restore_adapter_unavailable:local');
        error.code = 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE'; throw error;
      }
      if (!allowEmptyRestore && restoreOptions.allowEmptyRestore !== true && scopeCandidates === 0) {
        const error = new Error(`memory_suite_restore_snapshot_empty:${scope.scopeId}:dependencies=${result.dependencyCandidateCount},tombstones=${allTombstones}`);
        error.code = 'MEMORY_SUITE_RESTORE_SNAPSHOT_EMPTY'; throw error;
      }
      await captureRestoreOriginals('plugin', pluginInventory, state.legacy.plugin);
      await captureRestoreOriginals('local', localInventory, state.legacy.local);
      result.plugin = await scopedRestoreSpace(state.legacy.plugin, 'plugin', { ...restoreOptions, scope, inventory:pluginInventory, onProgress:forward });
      if (localInventory.candidates.length || localInventory.tombstones.length) {
        result.local = await scopedRestoreSpace(state.legacy.local, 'local', { ...restoreOptions, scope, inventory:localInventory, onProgress:forward });
      }
      for (const spaceResult of [result.plugin, result.local].filter(Boolean)) {
        result.restored += Number(spaceResult.restored || 0); result.removed += Number(spaceResult.removed || 0);
        result.verified += Number(spaceResult.verified || 0); result.totalItems += Number(spaceResult.totalItems || 0);
        result.processedItems += Number(spaceResult.processedItems || 0);
      }
      const candidateSummaries = [
        ...pluginInventory.candidates.map(restoreCandidateSummary),
        ...localInventory.candidates.map(restoreCandidateSummary)
      ];
      const verifiedEmptyGlobalScope=globalMigrationContext && !globalMigrationContext.records.some(row=>row.classification==='scope'&&!row.deleted&&row.scopeId===scope.scopeId&&row.location==='server');
      result.validation = verifiedEmptyGlobalScope ? {ok:true,errors:[],warnings:['strict_global_inventory_empty_scope_verified']} : await runRestoreValidator({
        namespace, pluginId, pluginVersion, scope, space:'all', phase:'complete',
        serverCandidates:candidateSummaries,
        restoredKeys:[
          ...(result.plugin?.restoredKeys || []).map(key=>({space:'plugin',key})),
          ...(result.local?.restoredKeys || []).map(key=>({space:'local',key}))
        ],
        removedKeys:[
          ...(result.plugin?.removedKeys || []).map(key=>({space:'plugin',key})),
          ...(result.local?.removedKeys || []).map(key=>({space:'local',key}))
        ],
        readback:async (spaceValue,key)=>await legacyRead(spaceValue==='local'?state.legacy.local:state.legacy.plugin,String(key||'')),
        result
      });
      result.metrics = result.validation?.metrics || {};
      result.ok = result.verified === allCandidates && result.processedItems === (allCandidates + allTombstones) && result.validation?.ok !== false;
      if (!result.ok) {
        const error = new Error(`memory_suite_scope_restore_coverage_incomplete:${scope.scopeId}:${result.verified}/${allCandidates}`);
        error.code = 'MEMORY_SUITE_SCOPE_RESTORE_INCOMPLETE'; error.result = result; throw error;
      }
      if (restoreOptions.assertServerPins) await restoreOptions.assertServerPins();
      await clearRecoveryRequired(scope);
      state.management.lastResult = result;
      setStatus('restore_verified', '', { scopeId:scope.scopeId, scopeLabel:scope.label, restored:result.restored, dependencies:result.dependencyCandidateCount, recoveryRequired:false });
      return result;
    } catch (error) {
      const partial = error?.result;
      if (partial?.space === 'plugin') result.plugin = partial;
      if (partial?.space === 'local') result.local = partial;
      result.restored = 0; result.removed = 0; result.verified = 0; result.totalItems = 0; result.processedItems = 0;
      for (const spaceResult of [result.plugin, result.local].filter(Boolean)) {
        result.restored += Number(spaceResult.restored || 0);
        result.removed += Number(spaceResult.removed || 0);
        result.verified += Number(spaceResult.verified || 0);
        result.totalItems += Number(spaceResult.totalItems || 0);
        result.processedItems += Number(spaceResult.processedItems || 0);
      }
      if (!result.validation) result.validation = error.validation || partial?.validation || null;
      if (!result.metrics) result.metrics = error.metrics || partial?.metrics || result.validation?.metrics || null;
      try { result.rollback = await rollbackRestoreOriginals(); }
      catch (rollbackError) { result.rollback = { attempted:restoreOriginals.length, restored:0, removed:0, failures:[{ error:compact(rollbackError?.message || rollbackError, 500) }], ok:false }; }
      error.result = result;
      if (!error.validation && result.validation) error.validation = result.validation;
      // A replaced DATA instance cannot receive the old job's recovery metadata.
      // Completed local rollback needs no integrity hold; incomplete rollback keeps
      // a durable local hold without adopting or publishing to the replacement.
      if (!error.serverPinFailure || result.rollback?.ok !== true) {
        try { error.recoveryLock = await persistRecoveryRequired(scope, error, { result, validation:error.validation || result.validation, metrics:error.metrics || result.metrics }, {localOnly:!!error.serverPinFailure}); }
        catch (lockError) { error.recoveryLockError = compact(lockError?.message || lockError, 500); }
      }
      throw error;
    }
  };

  const scopedVerifyPreservation = async (_legacy = state.legacy.plugin, verifyOptions = {}) => {
    const scope = normalizeScopeDescriptor(verifyOptions.scope || await resolveCurrentScope(true));
    if (!scope.scopeId) throw new Error('memory_suite_current_scope_unavailable');
    const integrity = await remoteIntegrity({ allowPluginOnly: true });
    const result = {
      schema:'memory-suite.scope-preservation.v2', namespace, scope, checked:0,
      failures:[], integrity, spaces:{ plugin:null, local:null }
    };
    const verifySpace = async (legacy, space) => {
      if (!legacy || typeof legacy.getItem !== 'function' || typeof legacy.keys !== 'function') return null;
      const rows = await collectScopedLegacyRows(legacy, space, scope);
      const spaceResult = { space, checked:0, total:rows.length, failures:[] };
      for (const row of rows) {
        if (row.route.kind !== 'scope') continue; // Shared/global metadata is not deleted by current-scope cleanup.
        try {
          const local = await legacyRead(legacy, row.key);
          const projected = isNullishStorageValue(local) ? null : await routeProjectValue(row.route, local);
          if (isNullishStorageValue(projected)) continue;
          const remote = await remoteGet(space, row.route.remoteKey, { allowPluginOnly:true });
          if (remote.exists !== true || jsonComparable(remote.value) !== jsonComparable(projected)) {
            spaceResult.failures.push({ key:row.key, remoteKey:row.route.remoteKey, reason:remote.tombstone?'server_tombstone':'value_mismatch_or_missing' });
          } else {
            spaceResult.checked += 1;
          }
        } catch (error) {
          spaceResult.failures.push({ key:row.key, remoteKey:row.route.remoteKey, reason:compact(error?.message || error, 240) });
        }
      }
      result.checked += spaceResult.checked;
      result.failures.push(...spaceResult.failures.map(row => ({ ...row, space })));
      return spaceResult;
    };
    result.spaces.plugin = await verifySpace(state.legacy.plugin, 'plugin');
    result.spaces.local = await verifySpace(state.legacy.local, 'local');
    result.ok = result.failures.length === 0;
    if (!result.ok) {
      const error = new Error(`memory_suite_scope_preservation_failed:${scope.scopeId}:${result.failures.length}`);
      error.code='MEMORY_SUITE_SCOPE_PRESERVATION_FAILED'; error.result=result; throw error;
    }
    return result;
  };

  const scopedSetModeSafely = async (requestedMode, operationOptions = {}) => {
    const target = requireOperationalMode(requestedMode);
    const scope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(true));
    const reset=await qualifyResetChoiceForScope(scope);
    if (reset?.choice === 'empty' && target !== MODE_SERVER_ONLY) throw new Error('reset_empty_mode_locked: select local upload and reload before changing storage mode');
    if (deletedScopesForResetChoice(reset).includes(scope.scopeId)) throw new Error('libra_deleted_scope_mode_locked');
    const recoveryLock = await recoveryLockForScope(scope);
    if (recoveryLock && target !== MODE_SERVER_ONLY) throw recoveryRequiredError(scope, recoveryLock, `set_mode_${target}`);
    const current = await readScopeMode(scope, true);
    if (storageTransition) throw transitionBusyError();
    if (target === current.mode) {
      if (current.explicit !== true && operationOptions.recordExplicit !== false) {
        if (operationOptions.assertServerPins) await operationOptions.assertServerPins();
        await persistScopedMode(target, scope, { source: String(operationOptions.source || 'user_scope_setting'), origin:'user_explicit' });
      }
      if (serverRouteConnection() && (current.explicit === true || operationOptions.recordExplicit === false)) {
        const prepared=await prepareServerModePublication(scope,target,['inherited','migrated'].includes(current.modeOrigin)?'inherited':'explicit');
        await publishPreparedServerMode(prepared);
      }
      return { changed:false, requestedMode:target, effectiveMode:current.mode, from:current.mode, to:target, scope, modeLabel:modeLabel(target) };
    }
    if (!state.legacy.plugin) throw new Error('memory_suite_pluginstorage_unavailable');
    if (storageTransition) throw transitionBusyError();
    storageTransition = {schema:'memory-suite.storage-transition.v1', scopeId:scope.scopeId,
      fromMode:current.mode, toMode:target, effectiveMode:current.mode, phase:'draining', startedAt:Date.now()};
    const onProgress = typeof operationOptions.onProgress === 'function' ? operationOptions.onProgress : null;
    let transitionFailure = null;
    try {
      await publishModeConfigurationStage('transition_draining','pending');
      do {
        await Promise.allSettled([...ownerIOWork]);
        await Promise.allSettled([...mutationTails.values()]);
      } while (ownerIOWork.size || mutationTails.size);
      // No await between the final idle check and closing admission. Nested or
      // newly admitted work during preparation must finish before the snapshot.
      storageTransition.phase = MODE_MIRROR;
      // Keep admission closed between global follower migrations and through
      // the final route publication. The outer configuration owns this fence.
      if (modeConfigurationBusy) modeConfigurationFrozen = true;
      await publishModeConfigurationStage('transition_mirror','pending');
      setStatus('storage_transition', '', {transition:{...storageTransition}, scopeId:scope.scopeId});
      if (current.mode === MODE_PLUGIN_ONLY && target !== MODE_PLUGIN_ONLY) {
        // Discover every deterministic conflict before the first server or local write.
        // This prevents a late key conflict from leaving an earlier key partially seeded.
        const preflight = await scopedSynchronizeAll({ scope, requestedMode:target, effectiveMode:current.mode, dryRun:true, allowOverwrite:false, restoreMissingLocal:false, onProgress });
        const seeded = await scopedSynchronizeAll({ scope, requestedMode:target, effectiveMode:current.mode, allowOverwrite:false, restoreMissingLocal:false, onProgress });
        const settled = seeded;
        if (!preflight.ok || !seeded.ok || !settled.ok) throw new Error('memory_suite_scope_mode_seed_failed');
        await remoteIntegrity({ allowPluginOnly:true });
      } else if (current.mode === MODE_MIRROR && target === MODE_SERVER_ONLY) {
        await scopedSynchronizeAll({ scope, requestedMode:target, effectiveMode:current.mode, allowOverwrite:globalMigrationContext?false:true, restoreMissingLocal:true, onProgress });
        await remoteIntegrity({ allowPluginOnly:true });
      } else if ((current.mode === MODE_SERVER_ONLY && target !== MODE_SERVER_ONLY) || (current.mode === MODE_MIRROR && target === MODE_PLUGIN_ONLY)) {
        await scopedRestoreAll({ scope, onProgress, assertServerPins:operationOptions.assertServerPins,allowEmptyRestore:operationOptions.allowEmptyRestore });
      }
      if (operationOptions.assertServerPins) await operationOptions.assertServerPins();
      const saved = await persistScopedMode(target, scope, { source:operationOptions.source || 'safe_scope_mode_transition', origin:String(operationOptions.origin || 'user_explicit'),globalMigrationJobId:operationOptions.globalMigrationJobId });
      return { changed:true, requestedMode:target, effectiveMode:target, from:current.mode, to:target, scope, modeLabel:modeLabel(target), transition:{...storageTransition, phase:'completed'}, config:saved };
    } catch (error) {
      transitionFailure = error;
      state.scopeRouting.transientModes.delete(scope.scopeId);
      error.requestedMode = target; error.effectiveMode = current.mode;
      error.modeTransition = { requestedMode: target, effectiveMode: current.mode, from: current.mode, to: target, scope };
      throw error;
    } finally {
      storageTransition = null;
      state.scopeRouting.routeCache.clear();
      try {await publishModeConfigurationStage(transitionFailure ? 'transition_failed' : 'transition_settled',transitionFailure ? 'failed' : 'settled');}
      catch (publicationError) {
        if (transitionFailure) transitionFailure.modePublicationError=String(publicationError?.code || 'MODE_PUBLICATION_UNAVAILABLE');
        else throw publicationError;
      }
    }
  };

  const scopedConfigureConnection = async (settings, operationOptions = {}) => {
    const source = settings && typeof settings === 'object' ? settings : {};
    if (source.mode != null) requireOperationalMode(source.mode);
    if (storageTransition) throw transitionBusyError();
    const scope = normalizeScopeDescriptor(operationOptions.scope || await resolveCurrentScope(true));
    const currentUrl = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    const currentMode = (await readScopeMode(scope, true)).mode;
    const targetUrl = normalizeServerUrl(source.url || currentUrl);
    const targetMode = requireOperationalMode(source.mode || currentMode);
    if (targetMode !== MODE_SERVER_ONLY) await assertRecoveryActionAllowed(scope, `configure_${targetMode}`);

    // The server URL is plugin-global while storage modes are scope-local. Moving the
    // global URL while even one scope still depends on the old server would silently
    // split that plugin's scopes between two DATA roots. Refuse the change until every
    // known scope has been brought back to plugin_only. This is intentionally stricter
    // than timestamp-based migration and never rewrites another scope behind the user's back.
    if (targetUrl !== currentUrl) {
      const registry = await loadScopeRegistry(true, false);
      const serverBackedScopes = Object.values(registry?.entries || {})
        .filter(row => normalizeMode(row?.mode) !== MODE_PLUGIN_ONLY)
        .map(row => ({ scopeId:String(row?.scopeId || ''), scopeLabel:String(row?.label || row?.scopeId || ''), mode:normalizeMode(row?.mode) }));
      if (serverBackedScopes.length) {
        const error = new Error(`memory_suite_server_url_in_use:${serverBackedScopes.length}`);
        error.code = 'MEMORY_SUITE_SERVER_URL_IN_USE';
        error.details = { currentUrl, targetUrl, serverBackedScopes };
        error.userMessage = '서버를 사용하는 스코프가 남아 있어 서버 주소를 변경할 수 없습니다. 해당 스코프들을 먼저 플러그인 단독으로 전환해 주세요.';
        throw error;
      }
    }

    let connectionTest = null;
    if (targetMode !== MODE_PLUGIN_ONLY || targetUrl !== currentUrl) {
      connectionTest = await testConnection(targetUrl);
      if (!connectionTest.ok) { const error = new Error(`memory_suite_connection_test_failed:${connectionTest.error || 'unknown'}`); error.code='MEMORY_SUITE_CONNECTION_TEST_FAILED'; error.result=connectionTest; throw error; }
    }
    let urlChanged = false;
    try {
      if (targetUrl !== currentUrl) {
        await persistServerUrl(targetUrl);
        urlChanged = true;
      }
      const modeResult = await scopedSetModeSafely(targetMode, { ...operationOptions, scope });
      const effectiveMode = normalizeMode(modeResult?.effectiveMode || targetMode);
      const from = { mode:currentMode, modeLabel:modeLabel(currentMode), requestedMode:currentMode, effectiveMode:currentMode, url:currentUrl, scope };
      const to = { mode:effectiveMode, modeLabel:modeLabel(effectiveMode), requestedMode:targetMode, effectiveMode, url:targetUrl, scope };
      return { ok:true, scope, url:targetUrl, mode:effectiveMode, modeLabel:modeLabel(effectiveMode), requestedMode:targetMode, effectiveMode, from, to, transition:modeResult, modeResult, connectionTest };
    } catch (error) {
      error.requestedMode = targetMode; error.effectiveMode = currentMode;
      error.modeTransition = { requestedMode: targetMode, effectiveMode: currentMode, from: currentMode, to: targetMode, scope };
      if (urlChanged) {
        try { await persistServerUrl(currentUrl); resetBootstrapCache(); }
        catch (rollbackError) { error.urlRollbackError = compact(rollbackError?.message || rollbackError, 300); }
      }
      throw error;
    }
  };

  const scopedGetConnectionSettings = async (settingsOptions = {}) => {
    const scope = normalizeScopeDescriptor(settingsOptions.scope || await resolveCurrentScope(settingsOptions.force === true));
    const modeState = await readScopeMode(scope, settingsOptions.force === true);
    const recoveryRequired = await recoveryLockForScope(scope);
    const url = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    state.config = { ...state.config, at: Date.now(), mode: modeState.mode, url };
    const connection = settingsOptions.test === true ? await testConnection(url) : null;
    // The panel needs three things the scope read alone cannot express: whether a global choice
    // exists, what it is, and whether THIS scope's mode came from it. Without those the UI cannot
    // show "전역" as the active scope target or offer to clear it.
    const globalState = await readGlobalMode(settingsOptions.force === true);
    return { namespace, pluginId, pluginVersion, scope, scopeId:scope.scopeId, scopeLabel:scope.label, mode:modeState.mode, modeLabel:modeLabel(modeState.mode), ...modeLifecycle(modeState.mode), migrationRequired:modeState.migrationRequired, transition:modeState.transition, storagePhase:modeState.storagePhase, modeExplicit: modeState.explicit === true, modeOrigin: String(modeState.modeOrigin || ''), inheritedFromGlobal: modeState.inheritedFromGlobal === true, global: { set: globalState.set, mode: globalState.mode, modeLabel: globalState.modeLabel, updatedAt: globalState.updatedAt }, executionPolicy:scopeExecutionPolicyFromModeState(modeState), url, defaultMode:MODE_PLUGIN_ONLY, recoveryRequired, status:{...state.status, ...modeLifecycle(modeState.mode), migrationRequired:modeState.migrationRequired, transition:modeState.transition, storagePhase:modeState.storagePhase, mode:modeState.mode, scopeId:scope.scopeId, scopeLabel:scope.label, recoveryRequired:!!recoveryRequired}, connection, syncJob:getSyncJob() };
  };

  const scopedCreateBackgroundJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'scopedCreateBackgroundJob'}, () => scopedCreateBackgroundJobImpl(...args));
  const scopedCreateBackgroundJobImpl = async (kind, target = {}) => {
    if (storageTransition || modeConfigurationBusy || state.syncJob.creating) throw transitionBusyError();
    state.syncJob.creating=true;
    try {
    const scope = normalizeScopeDescriptor(target.scope || await resolveCurrentScope(true));
    if (!scope.scopeId || scope.available === false) {
      const error = new Error('memory_suite_current_scope_unavailable');
      error.code = 'MEMORY_SUITE_SCOPE_UNAVAILABLE';
      throw error;
    }
    if (kind === 'manual_sync' || (kind === 'connection_config' && normalizeMode(target.mode) !== MODE_SERVER_ONLY)) {
      await assertRecoveryActionAllowed(scope, kind);
    }
    const existing = state.syncJob.current;
    if (existing && !syncJobTerminal(existing.status)) {
      const sameTarget = String(existing.kind || '') === String(kind || '')
        && String(existing.scopeId || '') === scope.scopeId
        && String(existing.targetMode || '') === String(target.mode || '')
        && String(existing.targetUrl || '') === String(target.url || '');
      if (sameTarget) return cloneSyncJob(existing);
      const error = new Error(`memory_suite_background_job_busy:${existing.kind}:${existing.status}`);
      error.code = 'MEMORY_SUITE_SYNC_JOB_BUSY';
      error.job = cloneSyncJob(existing);
      throw error;
    }
    const now = Date.now();
    let random = '';
    try { random = globalThis?.crypto?.randomUUID?.() || ''; } catch (_) {}
    if (!random) random = `${now.toString(36)}_${Math.random().toString(36).slice(2,10)}`;
    const jobId = `${namespace}_${kind}_${scope.scopeId}_${random}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 240);
    const currentMode = (await readScopeMode(scope, true)).mode;
    const requestedMode = target.requestedMode ? normalizeMode(target.requestedMode) : (target.mode ? normalizeMode(target.mode) : currentMode);
    const currentUrl = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    const targetUrl = target.url ? normalizeServerUrl(target.url) : currentUrl;
    const serverPins = await captureDurableJobServerPins({sourceMode:currentMode,sourceUrl:currentUrl,targetMode:requestedMode,targetUrl});
    state.syncJob.current = {
      schema: SYNC_JOB_SCHEMA, namespace, pluginId, pluginVersion,
      jobId, id: jobId, kind: String(kind || 'manual_sync'),
      scopeId: scope.scopeId, scopeKey: scope.scopeKey, scopeLabel: scope.label,
      sourceMode: currentMode, sourceUrl: currentUrl, requestedMode, effectiveMode: currentMode,
      targetMode: requestedMode,
      targetUrl, serverPins,
      status: 'queued', phase: 'queued', message: '작업을 준비하고 있습니다.',
      startedAt: now, updatedAt: now, lastActivityAt: now, finishedAt: 0,
      totalItems: 0, processedItems: 0, processedBytes: 0, transferredBytes: 0,
      uploaded: 0, restored: 0, matched: 0, removedByTombstone: 0,
      failures: 0, conflicts: 0, retryCount: 0, nextRetryAt: 0,
      currentSpace: '', currentKey: '', currentAction: '', spaces: {}, completedPasses: {},
      result: null, error: ''
    };
    state.syncJob.loaded = true;
    notifySyncJob();
    if (!await persistSyncJobNow()) {
      const error=durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
      await pauseSyncJobForServerPin(error);throw error;
    }
    return getSyncJob();
    } finally {state.syncJob.creating=false;}
  };

  const scopedExecuteBackgroundJob = (...args) => withOwnerOperation({kind:'job_execution',operation:'scopedExecuteBackgroundJob'}, () => scopedExecuteBackgroundJobImpl(...args));
  const scopedExecuteBackgroundJobImpl = async () => {
    if (state.syncJob.creating) return getSyncJob();
    const job = state.syncJob.current;
    if (!job || syncJobTerminal(job.status)) return getSyncJob();
    if (state.syncJob.promise) return state.syncJob.promise;
    if (state.syncJob.retryTimer) { clearLifecycleTimeout(state.syncJob.retryTimer); state.syncJob.retryTimer = null; }
    const scope = normalizeScopeDescriptor({
      scopeId: job.scopeId, scopeKey: job.scopeKey || job.scopeId, label: job.scopeLabel || job.scopeId
    });
    const runner = (async () => {
      try {
        await assertDurableJobAdmission(job);
        const assertServerPins=()=>assertDurableJobAdmission(job);
        updateSyncJob({status:'running',phase:job.phase==='resume_pending'?'resuming':(job.phase||'starting'),nextRetryAt:0,error:''});
        let result;
        if (job.kind === 'connection_config') {
          result = await withModeConfiguration(()=>scopedConfigureConnection({ mode: job.requestedMode || job.targetMode, url: job.targetUrl }, { scope, onProgress: applySyncProgressToJob, assertServerPins }));
        } else if (job.kind === 'manual_sync') {
          await assertRecoveryActionAllowed(scope, 'manual_sync');
          const mode = (await readScopeMode(scope, true)).mode;
          if (mode !== MODE_MIRROR) throw new Error('memory_suite_manual_sync_requires_mirror_mode');
          result = await withOwnerIO('plugin','',()=>scopedSynchronizeAll({ scope, allowOverwrite: true, restoreMissingLocal: true, onProgress: applySyncProgressToJob, assertServerPins }));
        } else if (job.kind === 'server_restore') {
          const mode = (await readScopeMode(scope, true)).mode;
          if (mode !== MODE_SERVER_ONLY) throw new Error('memory_suite_restore_requires_server_only_mode');
          result = await withOwnerIO('plugin','',()=>scopedRestoreAll({ scope, onProgress: applySyncProgressToJob, assertServerPins }));
        } else {
          throw new Error(`memory_suite_unknown_background_job:${job.kind}`);
        }
        await assertServerPins();
        updateSyncJob({
          requestedMode: result?.requestedMode || state.syncJob.current?.requestedMode || state.syncJob.current?.targetMode || '',
          effectiveMode: result?.effectiveMode || state.syncJob.current?.sourceMode || '',
          status: 'completed', phase: 'completed', currentAction: '완료', currentKey: '',
          message: '작업이 안전하게 완료되었습니다.', result: cloneSyncJob(result), error: '',
          nextRetryAt: 0, finishedAt: Date.now()
        }, { persist: 'immediate' });
        return result;
      } catch (error) {
        if (error.serverPinFailure) return await pauseSyncJobForServerPin(error);
        if (retryableSyncError(error) && Number(state.syncJob.current?.retryCount || 0) < SYNC_JOB_MAX_RETRIES) {
          const retryCount = Number(state.syncJob.current?.retryCount || 0) + 1;
          const delay = SYNC_JOB_RETRY_DELAYS_MS[Math.min(SYNC_JOB_RETRY_DELAYS_MS.length - 1, retryCount - 1)];
          updateSyncJob({
            status: 'paused', phase: 'waiting_for_server', currentAction: '서버 재연결 대기',
            message: `서버 연결이 일시적으로 끊겼습니다. ${Math.ceil(delay / 1000)}초 후 현재 스코프 작업을 이어서 확인합니다.`,
            error: compact(error?.message || error, 420), retryCount, nextRetryAt: Date.now() + delay
          }, { persist: 'immediate' });
          state.syncJob.retryTimer = scheduleLifecycleTimeout(() => {
            state.syncJob.retryTimer = null;
            void scopedExecuteBackgroundJob().catch(error => reportStorageFailure('sync.job.retry.admission', error));
          }, delay);
          try { state.syncJob.retryTimer?.unref?.(); } catch (_) {}
          return null;
        }
        updateSyncJob({
          requestedMode: error?.requestedMode || state.syncJob.current?.requestedMode || state.syncJob.current?.targetMode || '',
          effectiveMode: error?.effectiveMode || state.syncJob.current?.sourceMode || '',
          status: 'failed', phase: 'failed', currentAction: '작업 중단', currentKey: '',
          message: '작업을 완료하지 못했습니다.', error: compact(error?.message || error, 700),
          result:compactRestoreEvidence(error?.result || null),
          recoveryRequired:!!error?.recoveryLock, recovery:compactRestoreEvidence(error?.recoveryLock || null),
          validation:compactRestoreEvidence(error?.validation || error?.result?.validation || null),
          metrics:compactRestoreEvidence(error?.metrics || error?.result?.metrics || null),
          nextRetryAt: 0, finishedAt: Date.now()
        }, { persist: 'immediate' });
        throw error;
      }
    })();
    state.syncJob.promise = runner.finally(() => { state.syncJob.promise = null; });
    return state.syncJob.promise;
  };

  const scopedStartConnectionConfigurationJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'scopedStartConnectionConfigurationJob'}, () => scopedStartConnectionConfigurationJobImpl(...args));
  const scopedStartConnectionConfigurationJobImpl = async settings => {
    const source = settings && typeof settings === 'object' ? settings : {};
    if (source.mode != null) requireOperationalMode(source.mode);
    if (storageTransition || modeConfigurationBusy) throw transitionBusyError();
    const scope = normalizeScopeDescriptor(source.scope || await resolveCurrentScope(true));
    const modeState = await readScopeMode(scope, true);
    const currentUrl = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    const job = await scopedCreateBackgroundJob('connection_config', {
      scope, mode: requireOperationalMode(source.mode ?? modeState.mode), url: normalizeServerUrl(source.url ?? currentUrl)
    });
    void scopedExecuteBackgroundJob().catch(() => {});
    return job;
  };
  const scopedStartSynchronizationJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'scopedStartSynchronizationJob'}, () => scopedStartSynchronizationJobImpl(...args));
  const scopedStartSynchronizationJobImpl = async (options = {}) => {
    if (storageTransition || modeConfigurationBusy) throw transitionBusyError();
    const scope = normalizeScopeDescriptor(options.scope || await resolveCurrentScope(true));
    await assertRecoveryActionAllowed(scope, 'manual_sync');
    const modeState = await readScopeMode(scope, true);
    if (modeState.mode !== MODE_MIRROR) throw new Error('memory_suite_manual_sync_requires_mirror_mode');
    const url = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    const job = await scopedCreateBackgroundJob('manual_sync', { scope, mode: modeState.mode, url });
    void scopedExecuteBackgroundJob().catch(() => {});
    return job;
  };
  const scopedStartRestoreJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'scopedStartRestoreJob'}, () => scopedStartRestoreJobImpl(...args));
  const scopedStartRestoreJobImpl = async (options = {}) => {
    if (storageTransition || modeConfigurationBusy) throw transitionBusyError();
    const scope = normalizeScopeDescriptor(options.scope || await resolveCurrentScope(true));
    const modeState = await readScopeMode(scope, true);
    if (modeState.mode !== MODE_SERVER_ONLY) throw new Error('memory_suite_restore_requires_server_only_mode');
    const url = normalizeServerUrl(await getArgumentValue(urlArguments, defaultUrl));
    const job = await scopedCreateBackgroundJob('server_restore', { scope, mode: modeState.mode, url });
    void scopedExecuteBackgroundJob().catch(() => {});
    return job;
  };
  const scopedResumePendingSyncJob = (...args) => withOwnerOperation({kind:'job_admission',operation:'scopedResumePendingSyncJob'}, () => scopedResumePendingSyncJobImpl(...args));
  const scopedResumePendingSyncJobImpl = async () => {
    if (state.syncJob.creating) return getSyncJob();
    await loadPersistedSyncJob();
    const job = getSyncJob();
    if (!job || syncJobTerminal(job.status) || state.syncJob.promise) return job;
    if(job.kind==='global_mode'){
      void withModeConfiguration(()=>runGlobalModeJob(state.syncJob.current)).catch(()=>{});
      return getSyncJob();
    }
    const scope = await resolveCurrentScope(false);
    if (!scope.scopeId || String(job.scopeId || '') !== scope.scopeId) return job;
    void scopedExecuteBackgroundJob().catch(() => {});
    return getSyncJob();
  };
  const scopedWaitForSyncJob = async (jobId = '', timeoutMs = 15 * 60 * 1000) => {
    const wanted = String(jobId || state.syncJob.current?.jobId || state.syncJob.current?.id || '');
    if (!wanted) return null;
    const current = state.syncJob.current;
    if ((current?.jobId === wanted || current?.id === wanted) && syncJobTerminal(current.status)) return cloneSyncJob(current);
    return await new Promise((resolve, reject) => {
      let timer = null;
      const unsubscribe = subscribeSyncJob(job => {
        if (!job || (job.jobId !== wanted && job.id !== wanted) || !syncJobTerminal(job.status)) return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(job);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`memory_suite_sync_job_wait_timeout:${wanted}`));
      }, Math.max(1000, Number(timeoutMs || 0) || 15 * 60 * 1000));
    });
  };

  const scopedDeletePluginStorageAfterVerification = async (deleteOptions = {}) => {
    const scope = normalizeScopeDescriptor(deleteOptions.scope || await resolveCurrentScope(true));
    await assertRecoveryActionAllowed(scope, 'delete_pluginstorage');
    const checked = await scopedVerifyPreservation(state.legacy.plugin, { scope });
    if(typeof deleteOptions.beforeDelete==='function')await deleteOptions.beforeDelete();
    if(deleteOptions.preserveMode===true){
      if((await readScopeMode(scope,true)).mode!==MODE_SERVER_ONLY)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_REQUIRES_SERVER_ONLY');
    }else await persistScopedMode(MODE_SERVER_ONLY, scope, { source:'scope_pluginstorage_delete' });
    const result = {
      ok:true, schema:'memory-suite.scope-pluginstorage-delete.v2', namespace, scope,
      deleted:0, deletedPlugin:0, deletedLocal:0, checked:checked.checked,
      mode:MODE_SERVER_ONLY, spaces:{ plugin:null, local:null }
    };
    const deleteSpace = async (legacy, space) => {
      if (!legacy || typeof legacy.keys !== 'function') return null;
      const rows = await collectScopedLegacyRows(legacy, space, scope);
      const rowResult = { space, examined:rows.length, deleted:0, retainedShared:0, failures:[] };
      for (const row of rows) {
        if (row.route.kind !== 'scope') { rowResult.retainedShared += 1; continue; }
        try {
          const ok = await routeRemoveLocal(
            row.route,
            async()=>legacyRead(legacy,row.key),
            async next=>legacyWriteVerified(legacy,row.key,next),
            async()=>legacyRemoveVerified(legacy,row.key)
          );
          if (!ok) throw new Error('scope_local_delete_readback_failed');
          rowResult.deleted += 1;
        } catch (error) {
          rowResult.failures.push({ key:row.key, error:compact(error?.message || error, 240) });
        }
      }
      if (rowResult.failures.length) {
        const error = new Error(`memory_suite_scope_local_delete_incomplete:${space}:${rowResult.failures.length}`);
        error.code='MEMORY_SUITE_SCOPE_LOCAL_DELETE_INCOMPLETE'; error.result=rowResult; throw error;
      }
      return rowResult;
    };
    result.spaces.plugin = await deleteSpace(state.legacy.plugin, 'plugin');
    result.spaces.local = await deleteSpace(state.legacy.local, 'local');
    result.deletedPlugin = Number(result.spaces.plugin?.deleted || 0);
    result.deletedLocal = Number(result.spaces.local?.deleted || 0);
    result.deleted = result.deletedPlugin + result.deletedLocal;
    return result;
  };

  const scopedPrepareServerScopeDeletion = (...args) => withOwnerOperation({kind:'storage_operation',operation:'scopedPrepareServerScopeDeletion'}, () => scopedPrepareServerScopeDeletionImpl(...args));
  const scopedPrepareServerScopeDeletionImpl = async (deleteOptions = {}) => {
    const scope = normalizeScopeDescriptor(deleteOptions.scope || { scopeId:deleteOptions.scopeId, scopeKey:deleteOptions.scopeId, label:deleteOptions.scopeLabel || deleteOptions.scopeId });
    if (!scope.scopeId) throw new Error('memory_suite_scope_delete_owner_scope_missing');
    // Restore only this scope before allowing RE:TRACE to delete its server copy.
    await scopedRestoreAll({ scope });
    const localRows = await collectScopedLegacyRows(state.legacy.plugin, 'plugin', scope).catch(() => []);
    await persistScopedMode(MODE_PLUGIN_ONLY, scope, { source:'retrace_server_scope_delete_owner_proof' });
    return {
      schema:'memory-suite.server-scope-delete-owner-receipt.v1', namespace, pluginId, scopeId:scope.scopeId,
      verified:true, modeAfter:MODE_PLUGIN_ONLY, restoredKeys:localRows.length, checkedAt:Date.now(),
      members:Array.isArray(deleteOptions.members)?deleteOptions.members.length:0
    };
  };

  const assertStorageTransitionComplete = async (scope, modeState) => {
    if (storageTransition || modeState?.transition || modeState?.migrationRequired) throw transitionBusyError();
    await loadPersistedSyncJob();
    const job = getSyncJob();
    // An aggregate migration owns every scope, including scopes discovered
    // after it paused. Per-scope connection changes retain their own boundary.
    if (job && !syncJobTerminal(job.status) && (job.kind === 'global_mode' || (job.kind === 'connection_config' && job.scopeId === scope.scopeId))) {
      const error = transitionBusyError();
      error.transition = {scopeId:job.scopeId,fromMode:job.sourceMode,toMode:job.targetMode,phase:job.phase,jobId:job.jobId};
      throw error;
    }
  };

  const scopedEnsureHandoffReady = (...args) => withOwnerOperation({kind:'storage_operation',operation:'scopedEnsureHandoffReady'}, () => scopedEnsureHandoffReadyImpl(...args));
  const scopedEnsureHandoffReadyImpl = async (handoffOptions = {}) => {
    if (storageTransition) throw transitionBusyError();
    const phase = String(handoffOptions.phase || 'handoff').trim() || 'handoff';
    const scope = normalizeScopeDescriptor(handoffOptions.scope || await resolveCurrentScope(true));
    const modeState = await readScopeMode(scope, true);
    requireOperationalMode(modeState.mode);
    await assertStorageTransitionComplete(scope, modeState);
    const base = { schema:'memory-suite.handoff-storage.v2', namespace, pluginId, phase, scope, scopeId:scope.scopeId, mode:modeState.mode, modeLabel:modeLabel(modeState.mode), serverRequired:modeState.mode!==MODE_PLUGIN_ONLY, verified:true, pluginSync:null, localSync:null, integrity:null, checkedAt:Date.now() };
    if (modeState.mode === MODE_PLUGIN_ONLY) return base;
    const before = await remoteIntegrity({ allowPluginOnly:true });
    let sync = null;
    if (modeState.mode === MODE_MIRROR) sync = await scopedSynchronizeAll({ scope, allowOverwrite:true, restoreMissingLocal:true });
    const after = await remoteIntegrity({ allowPluginOnly:true });
    return { ...base, checkedAt:Date.now(), pluginSync:sync?.plugin||null, localSync:sync?.local||null, integrity:after, integrityBefore:before };
  };

  // Read-only source durability check for Native Branch preparation. Never
  // uploads, deletes or merges parent data; a divergent or tombstoned parent
  // fails closed so a branch cannot overwrite the authoritative source.
  const verifyNativeBranchSourceDurability = async (verifyOptions = {}) => {
    const scope = normalizeScopeDescriptor(verifyOptions.scope || null);
    if (!scope.scopeId) throw new Error('memory_suite_native_branch_source_scope_required');
    if (storageTransition) throw transitionBusyError();
    const modeState = await readScopeMode(scope, false);
    const mode = requireOperationalMode(modeState.mode);
    await assertStorageTransitionComplete(scope, modeState);
    const result = { schema:'memory-suite.native-branch-source-durability.v1', namespace, scope, mode, verified:true, checked:0, keys:[] };
    if (mode === MODE_PLUGIN_ONLY) return result;
    const fail = (reason, detail) => {
      const error = new Error(`memory_suite_native_branch_source_not_durable:${reason}${detail ? `:${detail}` : ''}`);
      error.code = 'MEMORY_SUITE_NATIVE_BRANCH_SOURCE_NOT_DURABLE';
      error.reason = reason;
      setStatus('native_branch_source_conflict', reason, { scopeId:scope.scopeId, mode });
      throw error;
    };
    // server_only never uses local canonical fallback. Its authority is the
    // server, so a reachable, consistent server is sufficient; retained local
    // remnants (legacy quarantine) are not allowed to fail the branch.
    result.integrity = await remoteIntegrity({ allowPluginOnly:true });
    result.integrityAfter = result.integrity;
    if (mode !== MODE_MIRROR) return result;
    // mirror holds two canonical copies. A server value that exists but differs
    // from the local canonical — or a server tombstone for a value still held
    // locally — makes the parent ambiguous: reject without writing either side.
    // A remote that is merely absent while local exists is ordinary local-ahead
    // mirror state and is not a conflict.
    for (const [space, legacy] of [['plugin', state.legacy.plugin], ['local', state.legacy.local]]) {
      if (!legacy || typeof legacy.keys !== 'function') continue;
      const rows = await collectScopedLegacyRows(legacy, space, scope);
      for (const row of rows) {
        if (row.route.kind !== 'scope') continue;
        const remote = await remoteGet(space, row.route.remoteKey, { allowPluginOnly:true });
        if (remote.tombstone === true) fail('server_tombstone_on_source', row.key);
        if (remote.exists !== true) continue;
        const local = await legacyRead(legacy, row.key);
        const projected = isNullishStorageValue(local) ? null : await routeProjectValue(row.route, local);
        if (jsonComparable(remote.value) !== jsonComparable(projected)) fail('source_local_server_diverged', row.key);
        result.keys.push(row.key);
        result.checked += 1;
      }
    }
    result.integrityAfter = await remoteIntegrity({ allowPluginOnly:true });
    return result;
  };

  // BEGIN OWNER SCOPE MANAGEMENT v1
  // Read the complete owner inventory without returning memory bodies or credentials.
  const requireScopeManagement = () => {
    if (!globalModeEnabled || options.scopeManagement !== true) throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_UNSUPPORTED');
  };
  const localScopeDataPlan = (inventory,scope) => {
    const owned=inventory.records.filter(row=>row.location!=='server'&&!row.deleted&&row.classification==='scope'&&row.scopeId===scope.scopeId);
    const keys=new Set(owned.flatMap(row=>[row.key,row.logicalKey]));
    const artifacts=inventory.records.filter(row=>row.location!=='server'&&!row.deleted&&row.classification==='artifact'&&row.scopeId===scope.scopeId
      &&owned.some(parent=>parent.key===row.artifactOwnerKey&&parent.space===row.space&&parent.location===row.location));
    const referenced=inventory.records.some(row=>!row.deleted&&!owned.includes(row)&&!artifacts.includes(row)
      &&(row.dependencyKeys||[]).some(key=>keys.has(key)));
    const registryEdits=[];let registryConflict=false;
    for(const row of inventory.records.filter(row=>row.location!=='server'&&!row.deleted&&(options.scopeRegistryKeys||[]).includes(row.logicalKey))){
      let value;try{value=typeof row.value==='string'?JSON.parse(row.value):row.value;}catch(_){registryConflict=true;continue;}
      if(!value||typeof value!=='object'||Array.isArray(value)){registryConflict=true;continue;}
      const next={...value},removedEntries=[];let removed=0;
      for(const [id,entry]of Object.entries(value))if(entry?.scopeKey===scope.scopeId){
        if(entry.characterId!==scope.characterId||entry.chatId!==scope.chatId){registryConflict=true;continue;}
        removedEntries.push([id,entry]);delete next[id];removed++;
      }
      if(removed)registryEdits.push({row,next:typeof row.value==='string'?JSON.stringify(next):next,removed,removedEntries});
    }
    return {owned,artifacts,registryEdits,referenced:referenced||registryConflict};
  };
  const inspectScopeCatalog = async () => {
    requireScopeManagement();
    return await scopeCatalogFromInventory(await collectGlobalInventory(MODE_PLUGIN_ONLY,{readOnlyCatalog:true}));
  };
  const scopeCatalogFromInventory = async inventory => {
    const current=await resolveCurrentScope(true).catch(()=>null);
    const activeMode=current?inventory.scopes.find(scope=>scope.scopeId===current.scopeId)?.sourceMode:null;
    const safeIssue=row=>Object.fromEntries(['code','key','space','location','scopeId','detail','reason'].filter(key=>row[key]!=null).map(key=>[key,row[key]]));
    const blockers=inventory.blockers.map(safeIssue);
    const general=blockers.filter(issue=>!issue.key&&!issue.scopeId);
    const rows=[];
    for(const scope of inventory.scopes){
      const records=inventory.records.filter(row=>row.classification!=='control'&&globalRecordScopeIds(row).includes(scope.scopeId));
      const keySet=new Set(records.flatMap(row=>[row.key,row.logicalKey]));
      const issues=[...general,...blockers.filter(issue=>issue.scopeId===scope.scopeId||issue.key&&keySet.has(issue.key))];
      const live=records.filter(row=>!row.deleted&&row.classification!=='artifact');
      const owned=live.filter(row=>row.classification==='scope'&&row.scopeId===scope.scopeId);
      const keys=[...new Set(live.map(row=>row.logicalKey))].sort();
      const locations=[...new Set(live.map(row=>row.location))].sort();
      const plan=localScopeDataPlan(inventory,scope);
      let dataSummary='';try{if(typeof options.scopeDataSummary==='function')dataSummary=String(options.scopeDataSummary({scope,records:live})||'').slice(0,240);}catch(_){}
      const canDelete=inventory.completeKnownScopes&&!!current?.scopeId&&activeMode===MODE_PLUGIN_ONLY&&scope.sourceMode===MODE_PLUGIN_ONLY&&!!scope.characterId&&!!scope.chatId&&current.scopeId!==scope.scopeId&&!plan.referenced&&(plan.owned.length>0||plan.registryEdits.length>0);
      const fingerprint=typeof globalThis.crypto?.subtle?.digest==='function'?await globalDigest([scope,current?.scopeId,inventory.hostScopes,records.filter(row=>!(options.scopeRegistryKeys||[]).includes(row.logicalKey)).map(row=>[globalRecordIdentity(row),row.fingerprint,row.revision,row.digest]),plan.registryEdits.map(edit=>[globalRecordIdentity(edit.row),edit.removedEntries]),issues,general]):'';
      rows.push({scopeId:scope.scopeId,scopeKey:scope.scopeKey,characterName:scope.characterName||'',chatTitle:scope.chatTitle||'',label:scope.label||scope.scopeKey,
        detached:!!(scope.canonicalCharacterId||scope.characterId)&&!!(scope.canonicalChatId||scope.chatId)&&!inventory.hostScopes.some(host=>(scope.canonicalCharacterId||scope.characterId)===host.characterId&&(scope.canonicalChatId||scope.chatId)===host.chatId),current:current?.scopeId===scope.scopeId,mode:scope.sourceMode,modeLabel:modeLabel(scope.sourceMode),
        recordCount:keys.length,ownedRecordCount:new Set(owned.map(row=>row.logicalKey)).size,ownedLocalRecords:owned.filter(row=>row.location!=='server').length,localRecords:live.filter(row=>row.location!=='server').length,serverRecords:live.filter(row=>row.location==='server').length,
        locations,keys,issues,fingerprint,dataSummary,canDelete,deleteBlockedReason:canDelete?'':current?.scopeId===scope.scopeId?'현재 채팅은 삭제 대상에서 제외됩니다.':scope.sourceMode!==MODE_PLUGIN_ONLY||activeMode!==MODE_PLUGIN_ONLY?'플러그인 단독 모드에서만 로컬 자료를 정리합니다.':!scope.characterId||!scope.chatId?'원본 캐릭터·채팅 식별 미확인':plan.referenced?'다른 자료에서 참조 중':!inventory.completeKnownScopes?'전체 목록·참조 검사가 완료되지 않았습니다.':'정리할 로컬 자료가 없습니다.',registryEntries:plan.registryEdits.reduce((n,edit)=>n+edit.removed,0),referenced:plan.referenced,serverChecked:inventory.remoteRequired&&!!inventory.serverPin&&general.length===0,canManage:!!current?.scopeId&&owned.length>0&&issues.length===0&&general.length===0});
    }
    const unresolved=inventory.records.filter(row=>globalPayloadRecord(row)&&!globalRecordScopeIds(row).some(Boolean))
      .map(row=>({key:row.logicalKey,space:row.space,location:row.location,issues:blockers.filter(issue=>issue.key===row.key||issue.key===row.logicalKey)}));
    return {schema:'memory-suite.scope-management-catalog.v1',namespace,checkedAt:Date.now(),completeKnownScopes:inventory.completeKnownScopes,
      currentScopeId:current?.scopeId||'',rows,unresolved,blockers};
  };
  const cleanupManagedScope = async (inventory,scope) => {
    const owned=inventory.records.filter(row=>row.location!=='server'&&!row.deleted&&row.classification==='scope'&&row.scopeId===scope.scopeId);
    const artifacts=inventory.records.filter(row=>row.location!=='server'&&!row.deleted&&row.classification==='artifact'&&row.scopeId===scope.scopeId
      &&owned.some(parent=>parent.key===row.artifactOwnerKey&&parent.space===row.space&&parent.location===row.location));
    const snapshots=[];
    for(const row of [...artifacts,...owned]){
      const store=inventory.stores[row.space],value=await store.getItem(row.key);
      if(globalCanonical(value)!==globalCanonical(row.value))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      snapshots.push({row,store,value});
    }
    try{
      const result=await scopedDeletePluginStorageAfterVerification({scope,preserveMode:true,beforeDelete:async()=>{
        if((await resolveCurrentScope(true)).scopeId===scope.scopeId)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CLEANUP_BLOCKED');
      }});
      result.deletedArtifacts=0;
      // The verified logical root covers these exact physical chunks. Shared roots
      // and their chunks remain untouched even when this scope references them.
      for(const row of artifacts){
        const store=inventory.stores[row.space];
        if(!await legacyRemoveVerified(store,row.key))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_ARTIFACT_DELETE_FAILED');
        result.deletedArtifacts++;result.deleted++;
        if(row.space==='plugin')result.deletedPlugin++;else result.deletedLocal++;
        if(result.spaces[row.space]){result.spaces[row.space].deleted++;result.spaces[row.space].examined++;}
      }
      return result;
    }catch(error){
      const failures=[];
      // Chunks precede their roots, so a restored root never precedes its payload.
      for(const {row,store,value}of snapshots){
        try{const current=await store.getItem(row.key);if(globalCanonical(current)===globalCanonical(value))continue;
          if(!isNullishStorageValue(current)||!await legacyWriteVerified(store,row.key,value))failures.push(row.key);
        }catch(_){failures.push(row.key);}
      }
      error.rollback={restored:failures.length===0,failures};throw error;
    }
  };
  const deleteLocalScopeData = async (inventory,scope,row,action) => {
    const plan=localScopeDataPlan(inventory,scope);
    if(!row.canDelete||action==='prune'&&plan.owned.length)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_BLOCKED');
    const currentId=await resolveCurrentScope(true).then(scope=>scope.scopeId);
    const hostBinding=globalCanonical(inventory.hostScopes),generation=dataBinding.generation;
    const assertCurrent=async()=>{
      if(lifecycle.disposed||resetReloadRequired||dataBinding.generation!==generation
        ||(await resolveCurrentScope(true)).scopeId!==currentId||currentId===scope.scopeId
        ||(await readScopeMode(scope,true)).mode!==MODE_PLUGIN_ONLY
        ||(await readScopeMode(await resolveCurrentScope(true),true)).mode!==MODE_PLUGIN_ONLY
        ||globalCanonical(await globalHostCatalog())!==hostBinding)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
    };
    const edits=[...plan.artifacts,...plan.owned].map(row=>({row,next:null})).concat(plan.registryEdits);
    for(const edit of edits){edit.store=inventory.stores[edit.row.space];edit.before=await edit.store.getItem(edit.row.key);
      if(globalCanonical(edit.before)!==globalCanonical(edit.row.value))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');}
    const applied=[];
    try{
      for(const edit of edits){await assertCurrent();
        if(globalCanonical(await edit.store.getItem(edit.row.key))!==globalCanonical(edit.before))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
        applied.push(edit);
        const ok=edit.next===null?await legacyRemoveVerified(edit.store,edit.row.key):await legacyWriteVerified(edit.store,edit.row.key,edit.next);
        if(!ok)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_FAILED');
      }
      await assertCurrent();
      return {ok:true,scopeId:scope.scopeId,deleted:plan.owned.length+plan.artifacts.length,registryEntriesRemoved:plan.registryEdits.reduce((n,edit)=>n+edit.removed,0)};
    }catch(error){
      const failures=[];
      for(const edit of applied.slice().reverse())try{
        const current=await edit.store.getItem(edit.row.key);
        if(globalCanonical(current)===globalCanonical(edit.before))continue;
        if(globalCanonical(current)!==globalCanonical(edit.next)||!await legacyWriteVerified(edit.store,edit.row.key,edit.before))failures.push(edit.row.key);
      }catch(_){failures.push(edit.row.key);}
      error.rollback={restored:!failures.length,failures};throw error;
    }
  };
  const manageScope = async request => {
    requireScopeManagement();
    if(!['sync','restore','cleanup','delete','prune','export'].includes(request?.action)||!request.scopeId||!request.expectedFingerprint)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_REQUEST_INVALID');
    return await withModeConfiguration(async()=>{
      if(state.syncJob.creating||state.syncJob.current&&!syncJobTerminal(state.syncJob.current.status))throw transitionBusyError();
      do{await Promise.allSettled([...ownerIOWork]);await Promise.allSettled([...mutationTails.values()]);}while(ownerIOWork.size||mutationTails.size);
      modeConfigurationFrozen=true;
      const inventory=await collectGlobalInventory(MODE_PLUGIN_ONLY),catalog=await scopeCatalogFromInventory(inventory);
      const row=catalog.rows.find(row=>row.scopeId===request.scopeId),scope=inventory.scopes.find(scope=>scope.scopeId===request.scopeId);
      if(!row||row.fingerprint!==request.expectedFingerprint||!row.fingerprint)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      if(['delete','prune'].includes(request.action))return await deleteLocalScopeData(inventory,scope,row,request.action);
      if(request.action==='export'){
        if(!catalog.completeKnownScopes||row.mode!==MODE_PLUGIN_ONLY)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_EXPORT_BLOCKED');
        const records=inventory.records.filter(item=>item.location!=='server'&&!item.deleted&&globalRecordScopeIds(item).includes(scope.scopeId)&&item.classification!=='control');
        return {ok:true,schema:'memory-suite.scope-data-backup.v1',namespace,scope,exportedAt:Date.now(),records:records.map(item=>({space:item.space,key:item.key,value:item.value}))};
      }
      if(!row.canManage)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      if(request.action==='sync'&&row.mode===MODE_SERVER_ONLY)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_LOCAL_SOURCE_REQUIRED');
      if(request.action!=='sync'&&(!catalog.completeKnownScopes||row.mode!==MODE_SERVER_ONLY))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_REQUIRES_SERVER_ONLY');
      if(request.action==='cleanup'&&(row.current||!row.ownedLocalRecords))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CLEANUP_BLOCKED');
      globalMigrationContext=inventory;
      try{
        if(request.action==='sync'){
          const result=await scopedSynchronizeAll({scope,allowOverwrite:false,restoreMissingLocal:false});
          await verifyGlobalScopeDestination(inventory,scope,MODE_SERVER_ONLY);return result;
        }
        if(request.action==='restore')return await scopedRestoreAll({scope});
        return await cleanupManagedScope(inventory,scope);
      }finally{globalMigrationContext=null;}
    });
  };
  const mountScopeManagementPanel = async container => {
    requireScopeManagement();
    const esc=value=>safeText(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    container.innerHTML=`<section class="card" data-scope-manager><style>
      [data-scope-manager]{width:100%;min-width:0;box-sizing:border-box;background:var(--surface,#faf8f2);color:var(--text,#302b28);padding:20px;border:1px solid var(--border,#d6d0c4);border-radius:12px}
      [data-scope-manager] .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}
      [data-scope-manager] button{font:inherit;color:inherit;background:var(--surface2,#f0ece3);border:1px solid var(--border2,#b6ad9d);border-radius:8px;padding:9px 12px;cursor:pointer}
      [data-scope-manager] button:disabled{opacity:.5;cursor:default}[data-scope-manager] .muted{color:var(--text2,#62594f);font-size:12px;line-height:1.65}
      [data-scope-manager] [data-scope-action=delete]{color:var(--danger,#ad3331)}[data-scope-manager] textarea{box-sizing:border-box;color:inherit;background:var(--surface2,#f0ece3)}
      </style><h3>스코프 데이터 관리</h3>
      <p class="muted">캐릭터·채팅별 저장 자료, 고아 데이터와 빈 목록을 관리합니다. 원본 채팅이 없다는 이유로 기억을 자동 삭제하지 않습니다. LLM 호출은 없습니다.</p>
      <div class="actions"><input data-scope-search type="search" aria-label="스코프 검색" placeholder="캐릭터 · 채팅 이름 · 스코프 키로 찾기" style="min-width:0;flex:1">
      <select data-scope-filter aria-label="스코프 분류"><option value="all">전체</option><option value="memory">기억 저장소</option><option value="detached">고아 데이터</option><option value="empty">빈 목록 · 정리 후보</option><option value="issues">확인 필요</option><option value="server_only">서버 관리 대상</option></select><button type="button" data-scope-refresh>전체 목록 새로 읽기</button></div>
      <p data-scope-summary role="status" aria-live="polite">목록을 확인하고 있습니다…</p>
      <div class="actions"><label><input type="checkbox" data-scope-select-all aria-label="검색 결과의 관리 가능 스코프 모두 선택"> 검색 결과 선택</label><span data-scope-selection>선택 0개</span></div>
      <div class="actions"><button type="button" data-scope-pick="orphan">고아 데이터 선택</button><button type="button" data-scope-pick="empty">빈 목록 선택</button><button type="button" data-scope-action="export">선택 데이터 백업</button><button type="button" data-scope-action="prune">선택 빈 목록 정리</button><button type="button" data-scope-action="delete">선택 데이터 삭제</button></div>
      <p class="muted">삭제는 현재 채팅을 제외한 플러그인 단독 자료에만 적용합니다. 다른 스코프가 참조하거나 읽기·권한을 확인할 수 없는 자료는 보존합니다. 서버 데이터와 저장 위치 전환은 별도의 서버 관리에서 진행하세요.</p>
      <div data-scope-confirm hidden style="display:none" role="alertdialog" aria-label="선택 스코프 작업 확인"><p data-scope-confirm-text></p><label data-scope-delete-ack-row hidden><input type="checkbox" data-scope-delete-ack> 필요한 데이터를 백업했으며 선택 자료의 영구 삭제에 동의합니다.</label><div class="actions"><button type="button" data-scope-cancel>취소</button><button type="button" data-scope-approve>확인하고 실행</button></div></div>
      <div data-scope-result role="status" aria-live="polite"></div><div data-scope-rows style="display:grid;gap:8px;min-width:0"></div>
      <div data-scope-unresolved style="overflow-wrap:anywhere"></div><div class="actions"><button type="button" data-scope-more hidden>다음 50개</button></div>
      <details data-scope-diagnostics><summary>전체 목록 진단 · 본문과 API 키 제외</summary><textarea data-scope-diagnostics-text readonly aria-label="전체 스코프 목록 진단" style="width:100%;min-height:160px"></textarea></details></section>`;
    const root=container.querySelector('[data-scope-manager]'),q=selector=>root.querySelector(selector);
    const palette=typeof globalThis.getComputedStyle==='function'?globalThis.getComputedStyle(root):null;
    for(const control of root.querySelectorAll('input[type="search"],select,option')){
      control.style.backgroundColor=palette?.backgroundColor||'#111a2a';control.style.color=palette?.color||'#e8eefc';
      control.style.border='1px solid #526273';control.style.borderRadius='8px';control.style.padding='10px';
    }
    let catalog=null,busy=false,limit=50,serial=0;const selected=new Set();
    const filtered=()=>{const term=q('[data-scope-search]').value.trim().toLocaleLowerCase(),filter=q('[data-scope-filter]').value;
      return (catalog?.rows||[]).filter(row=>(!term||[row.characterName,row.chatTitle,row.scopeKey,row.scopeId].join(' ').toLocaleLowerCase().includes(term))
        &&(filter==='all'||filter==='issues'&&(row.issues.length>0||row.unavailable)||filter==='memory'&&row.ownedRecordCount>0&&!row.detached||filter==='detached'&&row.detached&&row.ownedRecordCount>0||filter==='empty'&&row.ownedRecordCount===0&&!row.unavailable&&row.issues.length===0&&catalog.completeKnownScopes||row.mode===filter));};
    const selectable=row=>row.canDelete||row.canManage&&row.mode===MODE_PLUGIN_ONLY;
    const updateSelection=()=>{
      const rows=filtered().filter(selectable),all=q('[data-scope-select-all]');all.disabled=busy||rows.length===0;
      all.checked=rows.length>0&&rows.every(row=>selected.has(row.scopeId));all.indeterminate=!all.checked&&rows.some(row=>selected.has(row.scopeId));
      q('[data-scope-selection]').textContent=`선택 ${selected.size}개`;
      const chosen=(catalog?.rows||[]).filter(row=>selected.has(row.scopeId));
      root.querySelectorAll('[data-scope-action]').forEach(button=>{const action=button.getAttribute('data-scope-action');button.disabled=busy||!chosen.length||chosen.some(row=>action==='export'?!selectable(row):!row.canDelete||action==='prune'&&row.ownedRecordCount>0);});
      root.querySelectorAll('[data-scope-pick]').forEach(button=>{button.disabled=busy;});
    };
    const render=()=>{
      const rows=filtered();q('[data-scope-summary]').textContent=catalog?`확인된 스코프 ${catalog.rows.length}개 · 표시 ${rows.length}개 · 미해결 ${catalog.blockers.length}개${catalog.completeKnownScopes?'':' · 전체 확인 미완료'}`:'목록을 확인하고 있습니다…';
      q('[data-scope-rows]').innerHTML=rows.slice(0,limit).map(row=>`<article class="mscx-scope-row" data-scope-row="${esc(row.scopeId)}" style="min-width:0;overflow-wrap:anywhere;border:1px solid #526273;border-radius:10px;padding:12px;display:block">
        <div class="actions"><input type="checkbox" data-scope-select="${esc(row.scopeId)}" aria-label="${esc(row.label)} 선택" ${selected.has(row.scopeId)?'checked':''} ${busy||!selectable(row)?'disabled':''}>
        <div style="min-width:0;flex:1"><b style="display:block">${esc(row.characterName||row.label)}</b><span>${esc(row.chatTitle||row.scopeKey)}</span></div><span>${row.current?'현재 · ':''}${esc(row.modeLabel)}</span></div>
        ${row.dataSummary?'<div>'+esc(row.dataSummary)+'</div>':''}<div class="muted">${row.unavailable?'이번 조회 미확인 · 이전 목록 보존':row.issues.length?'확인 필요':row.detached?'원본 채팅 없음 · 저장 자료 보존':row.ownedRecordCount?'저장 항목 확인':row.registryEntries?'목록 잔재 · 정리 후보':'저장 항목 없음'} · 소유 저장 키 ${row.ownedRecordCount}개 · 로컬 ${row.localRecords} / 서버 ${row.unavailable?'미확인':row.serverChecked?row.serverRecords:'미조회'}</div>
        ${row.deleteBlockedReason?'<div class="muted">'+esc(row.deleteBlockedReason)+'</div>':''}${row.mode!=='plugin_only'?'<div class="muted">서버 관리 대상 · 이 화면에서 삭제하지 않습니다.</div>':''}<details><summary>스코프 키 · 저장 위치 · 진단 보기</summary><div>${esc(row.scopeKey)}</div><div>${esc(row.locations.map(location=>({plugin:'플러그인 저장소',device:'기기 저장소',server:'서버'})[location]||location).join(' · ')||'저장 항목 없음')}</div><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.issues.map(issue=>[issue.code,issue.key,issue.detail].filter(Boolean).join(' · ')).join('\n')||'이 스코프에서 확인된 오류 없음')}</pre><details><summary>저장 키 ${row.keys.length}개</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.keys.join('\n'))}</pre></details></details></article>`).join('')||'<p class="muted">표시할 스코프가 없습니다.</p>';
      q('[data-scope-more]').hidden=rows.length<=limit;
      if(catalog){q('[data-scope-diagnostics-text]').value=JSON.stringify(catalog,null,2);
        q('[data-scope-unresolved]').innerHTML=catalog.unresolved.length?`<details open><summary>스코프 식별 미확인 자료 ${catalog.unresolved.length}개 · 자동 연결·삭제 안 함</summary>${catalog.unresolved.map(row=>`<div class="mscx-scope-row"><b>${esc(row.key)}</b><span>${esc(row.location+' · '+row.space)}</span><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.issues.map(issue=>[issue.code,issue.detail].filter(Boolean).join(' · ')).join('\n'))}</pre></div>`).join('')}</details>`:'';
      }
      updateSelection();
    };
    const refresh=async()=>{
      const ticket=++serial;q('[data-scope-refresh]').disabled=true;q('[data-scope-summary]').textContent='전체 스코프와 저장 항목을 확인하고 있습니다…';
      try{const next=await inspectScopeCatalog();if(ticket!==serial||!root.isConnected)return;
        if(!next.completeKnownScopes&&catalog){for(const old of catalog.rows)if(!next.rows.some(row=>row.scopeId===old.scopeId))next.rows.push({...old,canManage:false,canDelete:false,unavailable:true,issues:[{code:'scope_not_observed_in_incomplete_refresh'}]});}
        catalog=next;for(const id of selected)if(!catalog.rows.some(row=>row.scopeId===id&&selectable(row)))selected.delete(id);render();
      }catch(error){if(ticket===serial&&root.isConnected){q('[data-scope-summary]').textContent=`목록 확인 실패 · 이전 목록을 보존합니다: ${error.code||error.message}`;if(catalog){catalog={...catalog,completeKnownScopes:false,rows:catalog.rows.map(row=>({...row,unavailable:true,canManage:false,canDelete:false}))};selected.clear();render();q('[data-scope-result]').textContent=String(error.code||error.message);}}}
      finally{if(ticket===serial&&root.isConnected)q('[data-scope-refresh]').disabled=false;}
    };
    q('[data-scope-refresh]').onclick=()=>{if(!busy)void refresh();};
    q('[data-scope-search]').oninput=q('[data-scope-filter]').onchange=()=>{limit=50;render();};
    q('[data-scope-more]').onclick=()=>{limit+=50;render();};
    q('[data-scope-select-all]').onchange=event=>{for(const row of filtered().filter(selectable)){if(event.target.checked)selected.add(row.scopeId);else selected.delete(row.scopeId);}render();};
    root.addEventListener('change',event=>{const id=event.target.getAttribute?.('data-scope-select');if(!id)return;const row=catalog?.rows.find(row=>row.scopeId===id);if(!busy&&row&&selectable(row)){if(event.target.checked)selected.add(id);else selected.delete(id);}updateSelection();});
    for(const button of root.querySelectorAll('[data-scope-pick]'))button.onclick=()=>{
      if(busy)return;const orphan=button.getAttribute('data-scope-pick')==='orphan';
      q('[data-scope-filter]').value=orphan?'detached':'empty';selected.clear();limit=50;
      for(const row of filtered())if(row.canDelete)selected.add(row.scopeId);render();
      q('[data-scope-result]').textContent='정리 후보를 선택했습니다. 아직 삭제하지 않았습니다.';
    };
    let confirmation=null;
    const finishConfirmation=value=>{if(!confirmation)return;const resolve=confirmation;confirmation=null;q('[data-scope-confirm]').hidden=true;q('[data-scope-confirm]').style.display='none';resolve(value);};
    q('[data-scope-delete-ack]').onchange=()=>{q('[data-scope-approve]').disabled=!q('[data-scope-delete-ack-row]').hidden&&!q('[data-scope-delete-ack]').checked;};
    q('[data-scope-approve]').onclick=()=>{if(!q('[data-scope-approve]').disabled)finishConfirmation(true);};q('[data-scope-cancel]').onclick=()=>finishConfirmation(false);
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&confirmation){event.preventDefault();event.stopPropagation();finishConfirmation(false);}});
    for(const button of root.querySelectorAll('[data-scope-action]'))button.onclick=async()=>{
      if(busy||!selected.size)return;
      const action=button.getAttribute('data-scope-action'),rows=catalog.rows.filter(row=>selected.has(row.scopeId));
      const destructive=action==='delete'||action==='prune';
      if(rows.some(row=>destructive?(!row.canDelete||action==='prune'&&row.ownedRecordCount>0):(!row.canManage||row.mode!==MODE_PLUGIN_ONLY))){q('[data-scope-result]').textContent='선택한 자료의 삭제·백업 권한을 확인할 수 없습니다. 현재 채팅, 참조 관계, 서버 저장 모드와 오류를 확인하세요.';return;}
      q('[data-scope-delete-ack-row]').hidden=!destructive;q('[data-scope-delete-ack]').checked=false;q('[data-scope-approve]').disabled=destructive;
      busy=true;render();q('[data-scope-confirm-text]').textContent=`${button.textContent} · ${rows.length}개\n${rows.map(row=>row.label+' · '+row.scopeKey).join('\n')}\n선택한 스코프의 로컬 데이터만 처리합니다. 서버 데이터와 현재 채팅은 변경하지 않습니다.`;
      q('[data-scope-confirm]').hidden=false;q('[data-scope-confirm]').style.display='block';q('[data-scope-confirm-text]').style.whiteSpace='pre-wrap';q('[data-scope-cancel]').focus();
      let monitor=null;const accepted=await new Promise(resolve=>{confirmation=resolve;monitor=setInterval(()=>{if(!root.isConnected)finishConfirmation(false);},200);try{monitor?.unref?.();}catch(_){}});clearInterval(monitor);
      try{if(!accepted||!root.isConnected)return;let completed=0;
        for(const row of rows){q('[data-scope-result]').textContent=`진행 ${completed}/${rows.length} · ${row.label}`;
          const result=await manageScope({scopeId:row.scopeId,action,expectedFingerprint:row.fingerprint});
          if(result.ok===false)throw new Error('선택 스코프 작업 미완료');
          if(action==='export'){
            const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
            const link=root.ownerDocument.createElement('a');link.href=url;link.download=namespace+'-scope-backup-'+Date.now()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          }
          completed++;selected.delete(row.scopeId);if(!root.isConnected)break;}
        if(root.isConnected)q('[data-scope-result]').textContent=`완료 ${completed}/${rows.length}개`;
      }catch(error){if(root.isConnected)q('[data-scope-result]').textContent=`작업 보류 · ${error.code||error.message}${error.rollback?.restored===false?' · 일부 값 복구 미완료: '+error.rollback.failures.join(', '):error.rollback?.restored===true?' · 변경한 값을 원래대로 복구했습니다.':''}`;}
      finally{busy=false;if(root.isConnected)await refresh();}
    };
    await refresh();return true;
  };
  // END OWNER SCOPE MANAGEMENT v1

  const scopedMountConnectionPanel = async (container, panelOptions = {}) => {
    if (!container || typeof container.innerHTML === 'undefined') throw new Error('memory_suite_connection_panel_container_required');
    const bookTheme = String(panelOptions.theme || '').toLowerCase() === 'book';
    const cachedScope = normalizeScopeDescriptor(state.scopeRouting.current || null);
    const cachedRegistryMode = cachedScope.scopeId
      ? state.scopeRouting.registry?.entries?.[cachedScope.scopeId]?.mode
      : '';
    const cachedMode = normalizeMode(state.scopeRouting.transientModes.get(cachedScope.scopeId) || cachedRegistryMode || state.config.mode || MODE_PLUGIN_ONLY);
    let initial = {
      namespace,
      pluginId,
      pluginVersion,
      scope: cachedScope,
      scopeId: cachedScope.scopeId,
      scopeLabel: cachedScope.scopeId ? cachedScope.label : '현재 스코프 확인 중…',
      mode: cachedMode,
      modeLabel: modeLabel(cachedMode),
      executionPolicy: scopeExecutionPolicyFromModeState({ scope:cachedScope, mode:cachedMode }),
      url: normalizeServerUrl(state.config.url || defaultUrl),
      defaultMode: MODE_PLUGIN_ONLY,
      recoveryRequired: false,
      status: { ...state.status, mode:cachedMode, scopeId:cachedScope.scopeId, scopeLabel:cachedScope.label, recoveryRequired:false },
      connection: null,
      syncJob: getSyncJob()
    };
    const rootId = `memory-suite-scope-connection-${namespace}-${Math.random().toString(36).slice(2,8)}`;
    const esc = value => safeText(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    container.innerHTML = `<div id="${rootId}" class="mscx-scope-root"><style>
      #${rootId}{font-family:system-ui,-apple-system,sans-serif;color:#e8eefc;display:grid;gap:14px} #${rootId} *{box-sizing:border-box}
      #${rootId} .mscx-card{border:1px solid #34425b;background:#111a2a;border-radius:14px;padding:15px;display:grid;gap:12px}
      #${rootId} h3{margin:0;font-size:18px} #${rootId} .muted{color:#9eacc3;font-size:12px;line-height:1.5}
      #${rootId} .scope{padding:11px 12px;background:#172236;border:1px solid #3b4d6b;border-radius:10px} #${rootId} .scope b{display:block;margin-bottom:4px}
      #${rootId} .scopetoggle{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:4px;border:1px solid #34425b;border-radius:11px;background:#0b1423}
      #${rootId} .scopetoggle button{appearance:none;border:0;border-radius:8px;background:transparent;color:#9eacc3;font:inherit;font-size:12px;font-weight:700;padding:9px 8px;cursor:pointer;min-width:0}
      #${rootId} .scopetoggle button[aria-pressed="true"]{background:#1d2f52;color:#eef4ff;box-shadow:0 0 0 1px #5d88ff inset}
      #${rootId} .scopetoggle button small{display:block;margin-top:2px;font-weight:400;font-size:10px;color:#9eacc3}
      #${rootId} .scopetoggle button[aria-pressed="true"] small{color:#cdd9f2}
      #${rootId} .scopetoggle button:only-child{grid-column:1/-1}
      #${rootId} .mscx-advanced{border:1px solid #34425b;border-radius:10px;padding:0 12px} #${rootId} .mscx-advanced>summary{cursor:pointer;padding:11px 0;font-weight:700;font-size:13px} #${rootId} .mscx-advanced>summary small{font-weight:400;color:#9eacc3;margin-left:6px} #${rootId} .mscx-advanced-body{display:grid;gap:8px;padding-bottom:12px}
      #${rootId} .scopeunset{border-color:#f0b65c;background:#241d10}
      #${rootId} .modes{display:grid;gap:8px} #${rootId} label.mode{display:flex;gap:9px;align-items:flex-start;border:1px solid #34425b;border-radius:10px;padding:10px;cursor:pointer}
      #${rootId} input[type=text],#${rootId} input[type=password]{width:100%;padding:10px 11px;border-radius:9px;border:1px solid #465a79;background:#0b1321;color:#fff}
      #${rootId} .actions{display:flex;flex-wrap:wrap;gap:8px} #${rootId} button{border:1px solid #50658a;background:#1d2a42;color:#fff;border-radius:9px;padding:9px 12px;font-weight:700;cursor:pointer} #${rootId} button.primary{background:#2d5bd1;border-color:#4c79e4} #${rootId} button.danger{background:#51212a;border-color:#8e4350}
      #${rootId} button:disabled{opacity:.45;cursor:not-allowed} #${rootId} .status{white-space:pre-wrap;border:1px solid #34425b;background:#0c1422;border-radius:10px;padding:11px;min-height:46px;font-size:12px;line-height:1.55}
      #${rootId} .job{display:none;border:1px solid #365275;background:#101d31;border-radius:12px;padding:12px;gap:9px} #${rootId} .job.show{display:grid} #${rootId} .job.terminal{border-color:#4c668e} #${rootId} .job.failed{border-color:#9b4655;background:#25141d}
      #${rootId} .bar{height:9px;background:#25344d;border-radius:99px;overflow:hidden} #${rootId} .bar>i{display:block;height:100%;background:#5d88ff;width:0%}
      #${rootId} .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;font-size:12px} #${rootId} .result{display:none;white-space:pre-wrap;border:1px solid #34425b;background:#0b1423;border-radius:9px;padding:10px;font-size:12px;line-height:1.55} #${rootId} .job.terminal .result{display:block} #${rootId} [hidden]{display:none!important} @media(max-width:540px){#${rootId} .grid{grid-template-columns:1fr}}
      ${bookTheme ? `
      #${rootId}{color-scheme:light;color:#392b20;min-width:0}
      #${rootId} .mscx-card{background:#f8f0e5;border-color:#cbb89d;min-width:0}
      #${rootId} :is(h3,b,strong){color:#392b20!important;-webkit-text-fill-color:#392b20!important}
      #${rootId} :is(.muted,span,small){color:#6f5a44!important;-webkit-text-fill-color:#6f5a44!important}
      #${rootId} :is(.scope,.status,.result){background:#fffaf2;border-color:#cbb89d;color:#4d3929;min-width:0;overflow-wrap:anywhere}
      #${rootId} label.mode{background:#f5ebdc;border-color:#cbb89d;color:#392b20;min-width:0}
      #${rootId} .scopetoggle{background:#efe2cd;border-color:#cbb89d}
      #${rootId} .scopetoggle button{background:transparent;border:0;color:#6f5a44;-webkit-text-fill-color:#6f5a44}
      #${rootId} .scopetoggle button[aria-pressed="true"]{background:#fffaf2;color:#392b20;-webkit-text-fill-color:#392b20;box-shadow:0 0 0 1px #a77742 inset}
      #${rootId} .scopetoggle button[aria-pressed="true"] small{color:#6f5a44!important;-webkit-text-fill-color:#6f5a44!important}
      #${rootId} .mscx-advanced{border-color:#cbb89d;background:#f5ebdc}
      #${rootId} label.mode:has(input:checked){background:#e8d6bb;border-color:#a77742}
      #${rootId} label.mode>span{min-width:0;overflow-wrap:anywhere}
      #${rootId} input[type=radio]{flex:none;accent-color:#966334}
      #${rootId} input[type=text],#${rootId} input[type=password]{background:#fffaf2;border-color:#cbb89d;color:#392b20}
      #${rootId} button{background:#efe2cd;border-color:#bfa27a;color:#594129;-webkit-text-fill-color:#594129;white-space:normal;overflow-wrap:anywhere;max-width:100%}
      #${rootId} button.primary{background:#dfc39d;border-color:#a97947;color:#53341c;-webkit-text-fill-color:#53341c}
      #${rootId} button.danger{background:#efdad5;border-color:#b77c71;color:#793f37;-webkit-text-fill-color:#793f37}
      #${rootId} button:disabled{opacity:1;background:#eee7dc;border-color:#cbbda9;color:#766753;-webkit-text-fill-color:#766753}
      #${rootId} .job{background:#f3e8d8;border-color:#c2a47c;color:#392b20;min-width:0}
      #${rootId} .job.failed{background:#efdad5;border-color:#b77c71}
      #${rootId} .bar{background:#e5d7c1} #${rootId} .bar>i{background:#966334}
      #${rootId} .status[data-tone=error],#${rootId} .status[data-tone=danger]{background:#efdad5;color:#793f37;border-color:#b77c71}
      ` : ''}
    </style>
      <div class="mscx-card"><div><h3>${esc(panelOptions.title || `${displayName} · 서버 연결`)}</h3><div class="muted">${esc(panelOptions.description || (globalModeEnabled ? '이 플러그인의 전체 대화를 확인하고 저장 위치를 전환합니다.' : '현재 스코프의 저장 방식을 변경합니다.'))}</div></div>
        <div class="scope"><b>현재 스코프</b><span data-scope-label>${esc(initial.scopeLabel || '확인 불가')}</span><div class="muted" data-scope-id>${esc(initial.scopeId || '')}</div></div>
        <div class="muted" data-scope-note><b>${globalModeEnabled ? '이 플러그인의 전체 대화에 적용되는 전역 설정입니다.' : '이 설정은 현재 스코프에만 적용됩니다.'}</b><br>새 스코프의 기본값은 플러그인 단독이며, 전역 설정을 지정하면 설정하지 않은 스코프가 그 값을 따릅니다. 서버 주소만 플러그인 공통 설정입니다.</div>
        <div class="scopetoggle" id="${rootId}-scopecard" role="group" aria-label="저장 설정 적용 범위">
          <button type="button" data-scope-global aria-pressed="${globalModeEnabled ? 'true' : 'false'}">전역<small>이 플러그인의 모든 대화에 적용</small></button>
          ${globalModeEnabled ? '' : '<button type="button" data-scope-perchat aria-pressed="true">스코프별<small>이 대화에만 적용</small></button>'}
        </div>
        <div class="modes">
          <label class="mode"><input type="radio" name="${rootId}-mode" value="plugin_only"><span><b>플러그인 단독 · 기본</b><br><small>현재 스코프를 RisuAI pluginStorage에만 저장합니다.</small></span></label>
          <label class="mode"><input type="radio" name="${rootId}-mode" value="server_only"><span><b>서버 단독</b><br><small>현재 스코프의 영구 정본을 Librarian System DATA에 저장합니다.</small></span></label>
        </div>
        <div class="muted" data-mirror-transition>미러는 두 저장 위치 사이의 전환 중에만 사용합니다. 기존 미러 설정은 단독 모드를 선택해 전환을 완료하세요.</div>
        <div class="scope" data-mode-summary hidden></div>
        <p class="muted" data-server-hint>Docker는 host.docker.internal 주소를 입력할 수 있습니다. PocketRisu의 /proxy2 경유 요청은 PocketRisu 서버에서 출발합니다. localhost는 그 서버 또는 컨테이너 자신입니다. 백엔드가 실행 중인 위치와 접근 경로를 확인하세요.</p><label data-server-fields><b>서버 주소</b><input data-url type="text" value="${esc(initial.url)}"></label>
        <div class="actions"><button data-test>연결 테스트</button><button class="primary" data-apply>설정 적용</button></div>
        <section class="mscx-card" data-mode-confirm role="alertdialog" aria-label="저장 위치 전환 확인" hidden style="display:none">
          <b>저장 위치 전환 확인</b><p data-mode-confirm-text style="white-space:pre-wrap;overflow-wrap:anywhere"></p>
          <div class="actions"><button type="button" data-mode-confirm-cancel>취소 · 원본 유지</button><button type="button" class="primary" data-mode-confirm-approve>동의하고 이전</button></div>
        </section>
        <details class="mscx-advanced"><summary>고급 작업 <small>동기화 · 복구 · 이전 · 초기화</small></summary><div class="mscx-advanced-body"><div class="muted">평소에는 쓰지 않아도 됩니다. 저장 위치를 옮기거나 문제를 복구할 때만 사용하세요.</div>
        <div class="actions"><button data-sync>지금 동기화</button><button data-restore>서버 → pluginStorage 복구</button></div>
        ${globalModeEnabled ? '<div class="actions"><button data-global-pause>전체 이전 중단·보존</button><button data-global-resume>미완료 전체 이전 재개</button></div>' : ''}
        <div class="actions"><button data-reset-empty>서버 자료 사용 · 로컬 업로드 안 함</button><button data-reset-upload>초기화 후 로컬 기억 다시 업로드</button></div>
        <div class="actions"><button class="danger" data-delete>현재 스코프 pluginStorage 삭제</button></div></div></details><div class="status" data-status>현재 모드: ${esc(initial.modeLabel)}
서버 상태를 확인할 수 있습니다.</div>
        <details data-preview-diagnostics hidden><summary>이전 검사 상세 · 대화 본문과 API 키 제외</summary><textarea data-preview-diagnostics-text aria-label="이전 검사 상세" readonly style="width:100%;min-height:180px"></textarea></details>
      </div>
      <div class="job" data-job><b data-job-title>작업 진행 중</b><div class="bar"><i data-job-bar></i></div><div class="grid"><span data-job-phase></span><span data-job-count></span><span data-job-bytes></span><span data-job-time></span><span data-job-retry></span><span data-job-key></span></div><div class="result" data-job-result></div><textarea data-job-diagnostics aria-label="저장 이전 상세 진단" readonly style="display:none"></textarea><button data-job-copy type="button">상세 진단 복사</button><div class="actions" data-job-terminal-actions style="display:none"><button data-job-dismiss type="button">결과 확인 닫기</button></div></div>
    </div>`;
    const root = container.querySelector(`#${rootId}`);
    const q = sel => root.querySelector(sel);
    const probeUi = connectionPanelProbeGuard(root, () => `${q('[data-url]').value}|${root.querySelector(`input[name="${rootId}-mode"]:checked`)?.value || initial.mode}|${q('[data-scope-global]').getAttribute('aria-pressed')}`);
    const setMessage = (message, tone='') => { probeUi.invalidate(); const box=q('[data-status]'); box.textContent=String(message||''); box.dataset.tone=tone; };
    const selectedInitialMode=globalModeEnabled ? initial.global?.mode || MODE_PLUGIN_ONLY : initial.mode;
    const radio = OPERATIONAL_MODES.includes(selectedInitialMode) ? root.querySelector(`input[name="${rootId}-mode"][value="${selectedInitialMode}"]`) : null; if (radio) radio.checked=true;
    const selectedMode = () => normalizeMode(root.querySelector(`input[name="${rootId}-mode"]:checked`)?.value || initial.mode);
    const syncModePresentation = () => {
      const mode = selectedMode();
      const local = mode === MODE_PLUGIN_ONLY;
      const serverFields = q('[data-server-fields]');
      if (serverFields) serverFields.hidden = false;
      const serverHint = q('[data-server-hint]');
      if (serverHint) serverHint.hidden = false;
      const testButton = q('[data-test]');
      if (testButton) testButton.disabled = false;
      const summary = q('[data-mode-summary]');
      if (summary) summary.hidden = true;
    };
    const applyRecoveryGuard = lock => {
      const active=!!lock;
      for(const input of root.querySelectorAll(`input[name="${rootId}-mode"]`)) input.disabled=active&&input.value!==MODE_SERVER_ONLY;
      q('[data-sync]').disabled=active; q('[data-delete]').disabled=active;
      if(active){const serverOnly=root.querySelector(`input[name="${rootId}-mode"][value="server_only"]`);if(serverOnly)serverOnly.checked=true;}
      syncModePresentation();
    };
    applyRecoveryGuard(initial.recoveryRequired);
    for(const input of root.querySelectorAll(`input[name="${rootId}-mode"]`)) input.addEventListener('change',syncModePresentation);
    syncModePresentation();
    const readinessControls = [...root.querySelectorAll(`input[name="${rootId}-mode"]`), q('[data-url]'), q('[data-test]'), q('[data-apply]'), q('[data-sync]'), q('[data-restore]'), q('[data-delete]')].filter(Boolean);
    const setControlsReady = ready => { for (const control of readinessControls) control.disabled = !ready; };
    const renderConnectionSettings = settings => {
      initial = settings;
      q('[data-scope-label]').textContent = settings.scopeLabel || '확인 불가';
      q('[data-scope-id]').textContent = settings.scopeId || '';
      q('[data-url]').value = settings.url || defaultUrl;
      const nextRadio = root.querySelector(`input[name="${rootId}-mode"][value="${settings.mode}"]`) || root.querySelector(`input[name="${rootId}-mode"][value="plugin_only"]`);
      if (nextRadio) nextRadio.checked = true;
      setControlsReady(true);
      applyRecoveryGuard(settings.recoveryRequired);
      setMessage(`현재 모드: ${settings.modeLabel}\n서버 상태를 확인할 수 있습니다.`);
    };
    setControlsReady(false);
    setMessage('현재 스코프의 저장 설정을 확인하고 있습니다…');
    const formatBytes = bytes => { const n=Math.max(0,Number(bytes||0)); if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; };
    let dismissedJobId='',terminalRefreshId='';
    const renderJob = job => {
      const card=q('[data-job]');
      if (!job || (job.kind !== 'global_mode' && job.scopeId !== initial.scopeId) || job.jobId === dismissedJobId) { card.classList.remove('show','terminal','failed'); return; }
      const terminal=syncJobTerminal(job.status);
      card.classList.add('show'); const total=Math.max(0,Number(job.kind==='global_mode'?job.discoveredScopes||0:job.totalItems||0)), done=Math.max(0,Number(job.kind==='global_mode'?job.verifiedScopes||0:job.processedItems||0)); const percent=total?Math.min(100,Math.round(done/total*100)):0;
      card.classList.toggle('terminal',terminal); card.classList.toggle('failed',job.status==='failed');
      q('[data-job-title]').textContent = `${job.message || (terminal?'작업 결과':'작업 진행 중')}${total ? ` · ${terminal&&job.status==='completed'?100:percent}%` : ''}`; q('[data-job-bar]').style.width=`${terminal&&job.status==='completed'?100:percent}%`;
      q('[data-job-phase]').textContent=`현재 단계: ${job.phase || '준비'}`; q('[data-job-count]').textContent=`진행: ${done.toLocaleString()} / ${total || terminal ? total.toLocaleString() : '조사 중'}${job.status==='completed' && total===0 ? ' · 이동할 데이터 없음' : ''}`;
      q('[data-job-bytes]').textContent=`처리: ${formatBytes(job.processedBytes)} · 전송: ${formatBytes(job.transferredBytes)}`; q('[data-job-time]').textContent=`경과: ${Math.max(0,Math.floor((Date.now()-Number(job.startedAt||Date.now()))/1000))}초`;
      q('[data-job-retry]').textContent=`재시도 ${Number(job.retryCount||0)} · 실패 ${Number(job.failures||0)}`; q('[data-job-key]').textContent=`현재: ${job.currentKey || job.currentAction || '-'}`;
      const terminalActions=q('[data-job-terminal-actions]'); terminalActions.style.display=terminal?'flex':'none';
      const result=job.result&&typeof job.result==='object'?job.result:{};
      q('[data-job-result]').textContent=terminal
        ? [job.status==='completed'?'완료 결과':'실패 결과',`요청 모드: ${modeLabel(job.requestedMode || job.targetMode || initial.mode)}`,`현재 적용 모드: ${modeLabel(job.effectiveMode || result.effectiveMode || job.sourceMode || initial.mode)}`,job.status==='failed'?'전환 미완료 · 현재 적용 모드를 확인하세요.':'',`복원 ${Number(job.restored||result.restored||0)} · 업로드 ${Number(job.uploaded||result.uploaded||0)} · 일치 ${Number(job.matched||result.matched||0)}`,`삭제 표식 ${Number(job.removedByTombstone||result.removed||0)} · 검증 ${Number(result.verified||0)}`,job.recoveryRequired?'복구 필수 잠금: 활성 · 서버 단독 유지':'복구 필수 잠금: 없음',job.error?`오류: ${job.error}`:''].filter(Boolean).join('\n')
        : '';
      const diagnosticText = terminal ? JSON.stringify({ schema:'memory-suite.scope-sync-diagnostics.v1', requestedMode:job.requestedMode || job.targetMode || '', effectiveMode:job.effectiveMode || job.sourceMode || '', failures:result.failures || [], metrics:result.metrics || {}, result }, null, 2) : '';
      const diagnosticBox = q('[data-job-diagnostics]'); if (diagnosticBox) { diagnosticBox.value = diagnosticText; diagnosticBox.style.display = terminal && diagnosticText ? 'block' : 'none'; }
      const copyButton = q('[data-job-copy]'); if (copyButton && !copyButton.dataset.bound) { copyButton.dataset.bound = '1'; copyButton.onclick = async () => { try { const value = q('[data-job-diagnostics]')?.value || ''; if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(value); else { q('[data-job-diagnostics]')?.select?.(); document.execCommand?.('copy'); } setMessage('Detailed diagnostics copied','good'); } catch (error) { setMessage('Detailed diagnostics copy failed\n' + (error?.message || error),'error'); } }; }
      if(terminal&&job.jobId!==terminalRefreshId){terminalRefreshId=job.jobId;scheduleLifecycleTimeout(()=>{void scopedGetConnectionSettings({scope:initial.scope,force:true}).then(settings=>applyRecoveryGuard(settings.recoveryRequired)).catch(()=>{});},0);}
    };
    for(const [selector,choice] of [['[data-reset-empty]','empty'],['[data-reset-upload]','upload']]){
      q(selector).onclick=async()=>{try{await acceptServerReset(choice);setMessage('선택을 저장했습니다. 기존 실행의 재업로드를 막기 위해 RisuAI를 새로고침한 뒤 사용하세요.','good');}catch(error){setMessage(error.message,'error');}};
    }
    q('[data-test]').onclick = async()=>{ setMessage('서버 연결을 확인하고 있습니다…'); const attempt=probeUi.begin(); const storageResult=await testConnection(q('[data-url]').value, {adoptDataInstance:true}); if(!await attempt.current(storageResult))return storageResult; setMessage(storageResult.ok?`연결됨 · Librarian System ${storageResult.serverVersion} · 항목 ${storageResult.liveRecords}`:`연결 실패 · ${storageResult.error}`,storageResult.ok?'good':'error'); };
    // ── 적용 범위 (전역 / 스코프별) ────────────────────────────────────────────────────────────────
    // `scopeTarget` is declared before the handlers below read it; the panel also refreshes through a
    // scheduled callback, so a later `let` would be a TDZ error on the first refresh.
    let scopeTarget = globalModeEnabled ? 'global' : 'scope';
    let lastSettings = {
      mode: normalizeMode(initial.mode),
      modeExplicit: initial.modeExplicit === true,
      inheritedFromGlobal: initial.inheritedFromGlobal === true,
      global: initial.global && typeof initial.global === 'object' ? initial.global : { set:false, mode:MODE_PLUGIN_ONLY }
    };
    // Re-read the settings and reflect them in the range card. Called after a global write, whose
    // effect (this chat now inherits, or its own choice now stands) is not visible in `initial`.
    const refreshPanelSettings = async () => {
      try {
        const settings = await scopedGetConnectionSettings({ scope: initial.scope, force: true });
        lastSettings = {
          mode: normalizeMode(settings.mode),
          modeExplicit: settings.modeExplicit === true,
          inheritedFromGlobal: settings.inheritedFromGlobal === true,
          global: settings.global && typeof settings.global === 'object' ? settings.global : { set:false, mode:MODE_PLUGIN_ONLY }
        };
        applyRecoveryGuard(settings.recoveryRequired);
        refreshScopeNote();
      } catch (_) {}
    };
    const scopeGlobalButton = q('[data-scope-global]');
    const scopePerChatButton = globalModeEnabled ? null : q('[data-scope-perchat]');
    const scopeNoteNode = q('[data-scope-note]');
    const refreshScopeNote = () => {
      if (!scopeNoteNode) return;
      if(globalModeEnabled){
        scopeNoteNode.textContent='전역 단일 설정 · 이 플러그인의 모든 대화를 확인합니다. 과거 개별 경로는 전체 검증이 끝날 때까지 보존됩니다.';
        return;
      }
      if (scopeTarget === 'global') {
        scopeNoteNode.innerHTML = lastSettings.global?.set === true
          ? `<b>전역 설정이 적용 중입니다 (${esc(modeLabel(lastSettings.global.mode))}).</b><br>설정하지 않은 모든 대화가 이 값을 따릅니다.`
          : '<b>아직 전역 설정이 없습니다.</b><br>여기서 모드를 고르고 적용하면 모든 대화의 기본값이 됩니다.';
      } else if (lastSettings.inheritedFromGlobal === true && lastSettings.global?.set === true) {
        scopeNoteNode.innerHTML = `<b>이 대화는 따로 설정하지 않아 전역 값(${esc(modeLabel(lastSettings.global.mode))})을 따릅니다.</b><br>여기서 적용하면 이 대화만 별도로 지정됩니다.`;
      } else if (lastSettings.modeExplicit === true) {
        scopeNoteNode.innerHTML = `<b>이 대화는 개별 설정(${esc(modeLabel(lastSettings.mode))})을 사용합니다.</b><br>전역 값을 바꿔도 이 대화는 그대로 유지됩니다.`;
      } else {
        scopeNoteNode.innerHTML = '<b>이 설정은 현재 스코프에만 적용됩니다.</b><br>새 스코프의 기본값은 플러그인 단독이며, 전역 설정을 지정하면 설정하지 않은 스코프가 그 값을 따릅니다. 서버 주소만 플러그인 공통 설정입니다.';
      }
      const card = q(`#${rootId}-scopecard`);
      if (card) card.className = scopeTarget === 'global' && lastSettings.global?.set !== true ? 'scopetoggle scopeunset' : 'scopetoggle';
    };
    const setScopeTarget = target => {
      const nextTarget = globalModeEnabled || target === 'global' ? 'global' : 'scope';
      if (nextTarget !== scopeTarget) probeUi.invalidate();
      scopeTarget = nextTarget;
      if (scopeGlobalButton) scopeGlobalButton.setAttribute('aria-pressed', scopeTarget === 'global' ? 'true' : 'false');
      if (scopePerChatButton) scopePerChatButton.setAttribute('aria-pressed', scopeTarget === 'scope' ? 'true' : 'false');
      refreshScopeNote();
    };
    if (scopeGlobalButton) scopeGlobalButton.onclick = () => setScopeTarget('global');
    if (scopePerChatButton) scopePerChatButton.onclick = () => setScopeTarget('scope');

    // ── 전환 경고 ──────────────────────────────────────────────────────────────────────────────────
    // Each direction states the consequence the user is actually accepting, and a cancelled dialog
    // stops before any write. Returns true to proceed, false to cancel.
    const confirmModeTransition = async (fromMode, toMode, preview = null) => {
      if (fromMode === toMode && !preview) return true;
      let question = '';
      if (fromMode === MODE_PLUGIN_ONLY && toMode === MODE_SERVER_ONLY) {
        question = '플러그인 단독에서 서버 단독으로 전환합니다.\n\n서버로 데이터를 옮기는 과정이 필요하니 시간이 오래 걸릴 수 있습니다.\n전환이 끝나면 서버 DATA가 정본이 되고 pluginStorage는 사용하지 않습니다.\n\n그래도 진행하시겠습니까?';
      } else if (fromMode === MODE_SERVER_ONLY && toMode === MODE_PLUGIN_ONLY) {
        question = '서버 단독에서 플러그인 단독으로 전환합니다.\n\n플러그인 스토리지로 데이터를 옮겨야 하니 시간이 소요됩니다.\n전환이 끝나면 서버 없이 동작합니다.\n\n동의하십니까?';

      } else if (fromMode === MODE_MIRROR && toMode === MODE_PLUGIN_ONLY) {
        question = '미러에서 플러그인 단독으로 전환합니다.\n\n서버에만 있는 자료까지 pluginStorage에 복원하고 재조회합니다.\n검증이 끝나면 서버 없이 동작합니다. 보관된 서버 자료는 이 설정으로 삭제하지 않습니다.\n\n괜찮으시겠습니까?';
      } else if (fromMode === MODE_MIRROR && toMode === MODE_SERVER_ONLY) {
        question = '미러에서 서버 단독으로 전환합니다.\n\n전환이 끝나면 pluginStorage는 사용하지 않고 서버 DATA를 정본으로 사용합니다.\n로컬 사본은 복구용으로 보존되며 정본으로 사용하지 않습니다.\n\n괜찮으시겠습니까?';
      } else {
        question = '저장 모드를 전환합니다. 계속하시겠습니까?';
      }
      if(preview)question=`이 플러그인의 전체 ${preview.discoveredScopes}개 대화와 과거 개별 경로 ${preview.legacyOverrides}개를 확인했습니다.\n대상: ${modeLabel(toMode)} · ${q('[data-url]').value}\n\n${question}`;
      // Host confirm may be asynchronous or blocked by a sandboxed/Tauri iframe.
      // Consent stays inside the mounted panel and never defaults to approval.
      const panel=q('[data-mode-confirm]'),approve=q('[data-mode-confirm-approve]'),cancel=q('[data-mode-confirm-cancel]'),apply=q('[data-apply]');
      const wasDisabled=apply.disabled;
      q('[data-mode-confirm-text]').textContent=question;
      panel.hidden=false;panel.style.display='grid';apply.disabled=true;cancel.focus();
      return await new Promise(resolve=>{
        let settled=false;
        const finish=value=>{if(settled)return;settled=true;clearInterval(detached);root.removeEventListener('keydown',keys);approve.onclick=cancel.onclick=null;panel.hidden=true;panel.style.display='none';apply.disabled=wasDisabled;if(root.isConnected)apply.focus();resolve(value);};
        const keys=event=>{if(event.key==='Escape'){event.preventDefault();finish(false);}};
        const detached=setInterval(()=>{if(!root.isConnected)finish(false);},200);try{detached?.unref?.();}catch(_){}
        root.addEventListener('keydown',keys);approve.onclick=()=>finish(root.isConnected!==false);cancel.onclick=()=>finish(false);
      });
    };

    q('[data-apply]').onclick = async()=>{
      if(q('[data-apply]').disabled)return;
      const targetUrl=q('[data-url]').value;
      const mode=root.querySelector(`input[name="${rootId}-mode"]:checked`)?.value;
      const selectionCurrent=()=>root.isConnected!==false&&q('[data-url]').value===targetUrl&&root.querySelector(`input[name="${rootId}-mode"]:checked`)?.value===mode;
      if (!mode) { setMessage('단독 모드를 선택해 전환을 완료해 주세요.','error'); return; }
      const writeGlobal = scopeTarget === 'global';
      try{
        const writeLabel = writeGlobal ? '전역' : '현재 스코프';
        // A global write is judged against the GLOBAL mode; a scope write against this chat's.
        const fromMode = writeGlobal ? (lastSettings.global?.set === true ? lastSettings.global.mode : MODE_PLUGIN_ONLY) : lastSettings.mode;
        if (!writeGlobal && !(await confirmModeTransition(fromMode, mode))) { setMessage('전환을 취소했습니다. 저장 모드는 그대로입니다.','good'); return; }
        if (writeGlobal) {
          const button=q('[data-apply]');button.disabled=true;
          try{
            q('[data-preview-diagnostics]').hidden=true;
            setMessage('전체 대화와 보존 자료를 확인하고 있습니다…');
            const preview=await previewGlobalMode(mode,{url:q('[data-url]').value});
            if(!preview.completeKnownScopes){
              q('[data-preview-diagnostics-text]').value=JSON.stringify({schema:'memory-suite.migration-preview-diagnostics.v1',namespace,discoveredScopes:preview.discoveredScopes,
                blockers:preview.blockers.map(row=>Object.fromEntries(['code','location','space','key','detail'].filter(key=>row[key]!=null).map(key=>[key,row[key]])))},null,2);
              q('[data-preview-diagnostics]').hidden=false;
              setMessage(`전체 이전을 시작할 수 없습니다. 발견 ${preview.discoveredScopes}개 · 미해결 ${preview.blockers.length}개\n${preview.blockers.slice(0,16).map(row=>[row.code,row.location,row.space,row.key,row.detail].filter(Boolean).join(' · ')).join('\n')}`,'error');return;}
            if(!(await confirmModeTransition(fromMode,mode,preview))){setMessage('전환을 취소했습니다. 원본과 저장 경로는 그대로입니다.','good');return;}
            if(!selectionCurrent()){setMessage('확인 중 대상 설정이 바뀌었습니다. 다시 적용해 주세요.','error');return;}
            setMessage(`전체 ${preview.discoveredScopes}개 대화 · 과거 개별 경로 ${preview.legacyOverrides}개\n${q('[data-url]').value}\n복사·재조회 검증 후 전역 설정을 적용합니다.`);
            const result=await withModeConfiguration(()=>persistGlobalMode(mode,{source:'user_global_setting',url:q('[data-url]').value,previewFingerprint:preview.inventoryFingerprint,refreshInventory:true}));
            await refreshPanelSettings();renderJob(getSyncJob());
            if(result.completeKnownScopes===true)setMessage(`전역 설정 적용 완료 · ${modeLabel(mode)}\n전체 ${result.verifiedScopes}/${result.discoveredScopes}개 대화 검증 완료. 새 대화도 이 설정을 따릅니다.`,'good');
            else setMessage('미완료 · 원본과 현재 경로를 보존했습니다. 이어서 진행할 수 있습니다.','error');
            return;
          }finally{button.disabled=false;}
        }
        if(!selectionCurrent()){setMessage('확인 중 대상 설정이 바뀌었습니다. 다시 적용해 주세요.','error');return;}
        if (mode === lastSettings.mode && normalizeServerUrl(q('[data-url]').value) === initial.url) { setMessage('변경할 설정이 없습니다.','good'); return; }
        const job=await scopedStartConnectionConfigurationJob({mode,url:q('[data-url]').value,scope:initial.scope});
        setMessage('설정 적용과 현재 스코프 초기 동기화를 시작했습니다.'); renderJob(job);
      }catch(error){setMessage(`설정 적용 시작 실패\n${error?.userMessage||error?.message||error}`,'error');}
    };
    if(globalModeEnabled){
      q('[data-global-pause]').onclick=async()=>{try{await pauseGlobalModeJob();setMessage('중단을 요청했습니다. 진행 중인 복사 검증을 마친 뒤 원본과 현재 경로를 보존합니다.');renderJob(getSyncJob());}catch(error){setMessage(error.code || error.message,'error');}};
      q('[data-global-resume]').onclick=async()=>{try{const job=getSyncJob();if(job?.kind!=='global_mode'||syncJobTerminal(job.status)){setMessage('재개할 전체 이전이 없습니다.');return;}await withModeConfiguration(()=>persistGlobalModeAllChats(job.targetMode,{url:q('[data-url]').value}));await refreshPanelSettings();renderJob(getSyncJob());}catch(error){setMessage(`전체 이전 재개 보류\n${error.code || error.message}`,'error');}};
    }
    refreshScopeNote();
    q('[data-sync]').onclick = async()=>{ try{const job=await scopedStartSynchronizationJob({scope:initial.scope});setMessage('현재 스코프 동기화를 시작했습니다.');renderJob(job);}catch(error){setMessage(`동기화 시작 실패\n${error?.userMessage||error?.message||error}`,'error');} };
    q('[data-restore]').onclick = async()=>{ try{const job=await scopedStartRestoreJob({scope:initial.scope});setMessage('현재 스코프 복구를 시작했습니다.');renderJob(job);}catch(error){setMessage(`복구 시작 실패\n${error?.userMessage||error?.message||error}`,'error');} };
    let armedUntil=0;
    q('[data-delete]').onclick = async()=>{ const button=q('[data-delete]'); if(Date.now()>armedUntil){button.disabled=true;setMessage('현재 스코프가 서버에 안전하게 보존됐는지 확인하고 있습니다…');try{await assertRecoveryActionAllowed(initial.scope,'delete_pluginstorage');const checked=await scopedVerifyPreservation(state.legacy.plugin,{scope:initial.scope});armedUntil=Date.now()+30000;button.textContent='검증 완료 · 다시 눌러 삭제';setMessage(`보존 검증 완료 · ${checked.checked}개\n30초 안에 다시 누르면 현재 스코프의 payload만 삭제합니다.`,'good');}catch(error){armedUntil=0;setMessage(`삭제 차단\n${error?.userMessage||error?.message||error}`,'error');}finally{button.disabled=false;}return;} armedUntil=0;button.disabled=true;try{const result=await scopedDeletePluginStorageAfterVerification({scope:initial.scope});button.textContent='현재 스코프 pluginStorage 삭제';setMessage(`삭제 완료 · ${result.deleted}개\n현재 스코프는 서버 단독입니다.`,'good');}catch(error){setMessage(`삭제 실패\n${error?.userMessage||error?.message||error}`,'error');}finally{button.disabled=false;} };
    q('[data-job-dismiss]').onclick=()=>{const job=getSyncJob();if(job&&syncJobTerminal(job.status)){dismissedJobId=job.jobId;renderJob(job);}};
    const unsubscribe=subscribeSyncJob(renderJob); const tick=setInterval(()=>{if(!root.isConnected){clearInterval(tick);unsubscribe();return;}renderJob(getSyncJob());},1000); try{tick?.unref?.();}catch(_){}
    try {
      renderConnectionSettings(await scopedGetConnectionSettings({ force:true }));
    } catch (error) {
      setControlsReady(false);
      setMessage(`설정 불러오기 실패\n${error?.message || error}`, 'error');
      return false;
    }
    await scopedResumePendingSyncJob().catch(()=>null); renderJob(getSyncJob());
    return true;
  };


  const ensureHandoffReady = async (options = {}) => {
    const phase = String(options.phase || 'handoff').trim() || 'handoff';
    const config = await readConfig(true);
    const base = {
      schema: 'memory-suite.handoff-storage.v1',
      namespace,
      pluginId,
      phase,
      mode: config.mode,
      modeLabel: modeLabel(config.mode),
      serverRequired: config.mode !== MODE_PLUGIN_ONLY,
      verified: true,
      pluginSync: null,
      localSync: null,
      integrity: null,
      checkedAt: Date.now()
    };
    if (config.mode === MODE_PLUGIN_ONLY) return base;

    const before = await remoteIntegrity();
    let pluginSync = null;
    let localSync = null;
    if (config.mode === MODE_MIRROR) {
      if (state.legacy.plugin) {
        pluginSync = await synchronizeLegacyWithServer(state.legacy.plugin, 'plugin', {
          allowOverwrite: true,
          restoreMissingLocal: true
        });
        if (Array.isArray(pluginSync?.failures) && pluginSync.failures.length) {
          const error = new Error(`memory_suite_handoff_plugin_sync_failed:${pluginSync.failures.length}`);
          error.code = 'MEMORY_SUITE_HANDOFF_SYNC_FAILED';
          error.sync = pluginSync;
          throw error;
        }
      }
      if (state.legacy.local && typeof state.legacy.local?.keys === 'function') {
        localSync = await synchronizeLegacyWithServer(state.legacy.local, 'local', {
          allowOverwrite: true,
          restoreMissingLocal: true
        });
        if (Array.isArray(localSync?.failures) && localSync.failures.length) {
          const error = new Error(`memory_suite_handoff_local_sync_failed:${localSync.failures.length}`);
          error.code = 'MEMORY_SUITE_HANDOFF_SYNC_FAILED';
          error.sync = localSync;
          throw error;
        }
      }
    }
    const after = await remoteIntegrity();
    const result = {
      ...base,
      checkedAt: Date.now(),
      pluginSync,
      localSync,
      integrity: after,
      integrityBefore: before
    };
    setStatus('handoff_storage_ready', '', {
      mode: config.mode,
      phase,
      serverVersion: state.status.serverVersion || '',
      records: Number(after?.records || 0) || 0
    });
    return result;
  };

  const serverGet = async (space, key) => await remoteGet(String(space || 'plugin'), String(key || ''));
  const serverGetMany = async (space = 'plugin', keys = []) => await remoteGetMany(String(space || 'plugin'), keys);
  const serverKeys = async (space = 'plugin', prefix = '') => await remoteKeys(String(space || 'plugin'), String(prefix || ''));
  const serverIntegrity = async () => await remoteIntegrity();

  const cloneDiagnosticValue = value => {
    if (!value || typeof value !== 'object') return value || null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return { ...value }; }
  };
  const offlineDiagnostics = async (error = null, manager = false) => {
    let scope = null;
    let mode = MODE_PLUGIN_ONLY;
    try {
      scope = await resolveCurrentScope(false);
      mode = (await readScopeMode(scope, false)).mode;
    } catch (error) { reportStorageFailure('state.snapshot.dispatch', error); }
    return {
      schema: manager ? 'memory-suite.manager-server-diagnostics.v1' : 'memory-suite.plugin-server-diagnostics.v1',
      generatedAt: Date.now(),
      reachable: false,
      namespace: manager ? '' : namespace,
      pluginId,
      pluginVersion,
      scope: scope ? { label: String(scope.label || ''), available: scope.available !== false } : null,
      storageMode: mode,
      error: compact(error?.message || error || 'server_unavailable', 900),
      status: { ...state.status }
    };
  };
  const getCachedDiagnostics = () => cloneDiagnosticValue(state.diagnostics.value) || {
    schema: 'memory-suite.plugin-server-diagnostics.v1',
    generatedAt: 0,
    reachable: null,
    namespace,
    pluginId,
    pluginVersion,
    status: { ...state.status },
    reason: 'diagnostics_not_loaded'
  };
  const getDiagnostics = async (options = {}) => {
    const force = options.force === true;
    const maxAgeMs = Math.max(0, Math.min(10 * 60 * 1000, Number(options.maxAgeMs ?? 30000) || 0));
    if (!force && state.diagnostics.value && Date.now() - Number(state.diagnostics.at || 0) <= maxAgeMs) return cloneDiagnosticValue(state.diagnostics.value);
    if (!force && state.diagnostics.pending) return await state.diagnostics.pending;
    const pending = (async () => {
      let scope = null;
      let mode = MODE_PLUGIN_ONLY;
      try {
        scope = normalizeScopeDescriptor(options.scope || await resolveCurrentScope(false));
        mode = (await readScopeMode(scope, false)).mode;
        if (mode === MODE_PLUGIN_ONLY && options.probeServer !== true) {
          const result = {
            schema: 'memory-suite.plugin-server-diagnostics.v1', generatedAt: Date.now(), reachable: null,
            reason: 'plugin_only_no_server_probe', namespace, pluginId, pluginVersion, storageMode: mode,
            scope: scope ? { label: String(scope.label || ''), available: scope.available !== false } : null,
            clientStatus: { ...state.status }
          };
          state.diagnostics.value = result;
          state.diagnostics.at = Date.now();
          return cloneDiagnosticValue(result);
        }
        const connection = await bootstrap(force, true);
        if (connection?.capabilities?.['server-diagnostics.v1'] !== true) {
          const result = {
            schema: 'memory-suite.plugin-server-diagnostics.v1',
            generatedAt: Date.now(),
            reachable: true,
            supported: false,
            reason: 'server_diagnostics_unsupported',
            namespace,
            pluginId,
            pluginVersion,
            storageMode: mode,
            scope: scope ? { label: String(scope.label || ''), available: scope.available !== false } : null,
            server: { version: String(connection?.version || ''), protocol: cloneDiagnosticValue(connection?.protocol || {}) },
            clientStatus: { ...state.status }
          };
          state.diagnostics.value = result;
          state.diagnostics.at = Date.now();
          return cloneDiagnosticValue(result);
        }
        const limit = Math.max(1, Math.min(1000, Number(options.limit || 500) || 500));
        const since = Math.max(0, Number(options.since || 0) || 0);
        const query = [
          `namespace=${encodeURIComponent(namespace)}`,
          `limit=${limit}`,
          `since=${since}`,
          `includeGlobal=${options.includeGlobal === false ? '0' : '1'}`,
          `includeTextLogs=${options.includeTextLogs === true ? '1' : '0'}`,
          ...(scope?.scopeId ? [`scopeId=${encodeURIComponent(scope.scopeId)}`] : [])
        ].join('&');
        const payload = await request('GET', `/v1/diagnostics?${query}`, null, { allowPluginOnly: true, scope, storageMode: mode, forceBootstrap: force });
        const result = {
          ...(payload?.result || {}),
          schema: 'memory-suite.plugin-server-diagnostics.v1',
          reachable: true,
          namespace,
          pluginId,
          pluginVersion,
          storageMode: mode,
          scope: scope ? { label: String(scope.label || ''), available: scope.available !== false } : null,
          clientStatus: { ...state.status }
        };
        state.diagnostics.value = result;
        state.diagnostics.at = Date.now();
        return cloneDiagnosticValue(result);
      } catch (error) {
        const result = await offlineDiagnostics(error, false);
        state.diagnostics.value = result;
        state.diagnostics.at = Date.now();
        return cloneDiagnosticValue(result);
      } finally {
        state.diagnostics.pending = null;
      }
    })();
    state.diagnostics.pending = pending;
    return await pending;
  };
  const refreshDiagnostics = async (options = {}) => await getDiagnostics({ ...options, force: true });
  const scheduleDiagnosticsRefresh = (delayMs = 0, options = {}) => {
    if (state.diagnostics.timer) clearLifecycleTimeout(state.diagnostics.timer);
    state.diagnostics.timer = scheduleLifecycleTimeout(() => {
      state.diagnostics.timer = null;
      void (async () => {
        const registry = await loadScopeRegistry(false, false);
        const hasServerScope = Object.values(registry?.entries || {}).some(row => normalizeMode(row?.mode) !== MODE_PLUGIN_ONLY);
        // Once legacy mode migration is complete, a fully plugin-only registry
        // needs no startup chat lookup and no diagnostics request.
        if (registry?.legacyGlobalModeImported === true && !hasServerScope) return;
        const scope = await resolveCurrentScope(false);
        if ((await readScopeMode(scope, false)).mode === MODE_PLUGIN_ONLY) return;
        await refreshDiagnostics(options);
      })().catch(() => {});
    }, Math.max(0, Number(delayMs || 0) || 0));
    return true;
  };

  const decorateDebugExport = async (payload, options = {}) => {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload };
    const memorySuite = await getDiagnostics({ force: options.force !== false, limit: options.limit || 500, since: options.since || 0, includeGlobal: options.includeGlobal !== false, includeTextLogs: options.includeTextLogs === true });
    return { ...source, memorySuite };
  };
  const decorateDebugExportSync = payload => {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload };
    return { ...source, memorySuite: getCachedDiagnostics() };
  };

  const assertManagerOwner = () => {
    if (pluginId !== 'flashback_hayaku_bridge') {
      const error = new Error('memory_suite_manager_is_retrace_only');
      error.code = 'MEMORY_SUITE_MANAGER_OWNER_REQUIRED';
      throw error;
    }
  };
  const managerHeaders = Object.freeze({
    'X-Memory-Suite-Manager': 'retrace',
    'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge'
  });
  const managerRequest = (...args) => withOwnerOperation({kind:'storage_operation',operation:'managerRequest'}, () => managerRequestImpl(...args));
  const managerRequestImpl = async (method, route, body = null) => {
    assertManagerOwner();
    return await request(method, route, body, { extraHeaders: managerHeaders, allowPluginOnly: true });
  };
  const managerConnection = (...args) => withOwnerOperation({kind:'storage_operation',operation:'managerConnection'}, () => managerConnectionImpl(...args));
  const managerConnectionImpl = async () => {
    assertManagerOwner();
    return await bootstrap(false, true);
  };
  const managerGetDiagnostics = async (options = {}) => {
    try {
      const connection = await managerConnection();
      if (connection?.capabilities?.['manager-diagnostics.v1'] !== true) {
        return {
          schema: 'memory-suite.manager-server-diagnostics.v1',
          generatedAt: Date.now(),
          reachable: true,
          supported: false,
          reason: 'manager_server_diagnostics_unsupported',
          pluginId,
          pluginVersion,
          server: { version: String(connection?.version || ''), protocol: cloneDiagnosticValue(connection?.protocol || {}) },
          clientStatus: { ...state.status }
        };
      }
      const limit = Math.max(1, Math.min(1000, Number(options.limit || 1000) || 1000));
      const since = Math.max(0, Number(options.since || 0) || 0);
      const namespaceFilter = String(options.namespace || '').trim().toLowerCase();
      const scope = options.scope || options.currentScope === true
        ? normalizeScopeDescriptor(options.scope || await resolveCurrentScope(false))
        : null;
      const query = [
        `limit=${limit}`,
        `since=${since}`,
        `includeGlobal=${options.includeGlobal === false ? '0' : '1'}`,
        `includeTextLogs=${options.includeTextLogs === false ? '0' : '1'}`,
        ...(namespaceFilter ? [`namespace=${encodeURIComponent(namespaceFilter)}`] : []),
        ...(scope?.scopeId ? [`scopeId=${encodeURIComponent(scope.scopeId)}`] : [])
      ].join('&');
      const payload = await managerRequest('GET', `/v1/manager/diagnostics?${query}`);
      return { ...(payload?.result || {}), reachable: true, pluginId, pluginVersion, clientStatus: { ...state.status } };
    } catch (error) {
      return await offlineDiagnostics(error, true);
    }
  };
  const managerServerGet = async (targetNamespace, space, key) => {
    const ns = String(targetNamespace || '').trim().toLowerCase();
    const payload = await managerRequest('GET', `/v1/kv/get?namespace=${encodeURIComponent(ns)}&space=${encodeURIComponent(String(space || 'plugin'))}&key=${encodeURIComponent(String(key || ''))}`);
    return payload?.result || {};
  };
  const managerServerGetMany = async (targetNamespace, space = 'plugin', keys = []) => {
    const ns = String(targetNamespace || '').trim().toLowerCase();
    const list = Array.isArray(keys) ? keys.map(String).filter(Boolean).slice(0, 512) : [];
    if (!list.length) return { values: {}, pages: 0, oversizedKeys: [] };
    const values = {};
    const oversizedKeys = new Set();
    let cursor = 0;
    let pages = 0;
    for (;;) {
      if (pages >= maxStoragePaginationPages) throw new Error('memory_suite_manager_get_many_pagination_limit_exceeded');
      const payload = await managerRequest('POST', '/v1/kv/get-many', {
        namespace: ns, space: String(space || 'plugin'), keys: list,
        paged: true, cursor, maxResponseBytes: getManyResponseBudgetBytes
      });
      pages += 1;
      const result = payload?.result || { values: {} };
      mergeStorageRecordValues(values, result.values);
      for (const key of Array.isArray(result.oversizedKeys) ? result.oversizedKeys : []) oversizedKeys.add(String(key));
      const nextCursor = result?.continuation?.nextCursor;
      if (nextCursor == null) break;
      const normalizedNext = Number(nextCursor);
      if (!Number.isInteger(normalizedNext) || normalizedNext <= cursor || normalizedNext > list.length) throw new Error('memory_suite_manager_get_many_pagination_cursor_invalid');
      cursor = normalizedNext;
    }
    for (const key of oversizedKeys) defineStorageRecordValue(values, key, await managerServerGet(ns, space, key));
    return { values, pages, oversizedKeys: [...oversizedKeys] };
  };
  const managerServerKeys = async (targetNamespace, space = 'plugin', prefix = '') => {
    const ns = String(targetNamespace || '').trim().toLowerCase();
    const normalizedSpace = String(space || 'plugin');
    const normalizedPrefix = String(prefix || '');
    const keys = [], tombstones = [], records = [];
    const seenKeys = new Set(), seenTombstones = new Set(), seenRecords = new Set();
    let cursor = '';
    let pages = 0;
    for (;;) {
      if (pages >= maxStoragePaginationPages) throw new Error('memory_suite_manager_keys_pagination_limit_exceeded');
      const payload = await managerRequest('GET', `/v1/kv/keys?namespace=${encodeURIComponent(ns)}&space=${encodeURIComponent(normalizedSpace)}&prefix=${encodeURIComponent(normalizedPrefix)}&paged=1&limit=${keyPageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      pages += 1;
      const result = payload?.result || { keys: [], tombstones: [], records: [] };
      for (const key of Array.isArray(result.keys) ? result.keys : []) { const value = String(key); if (!seenKeys.has(value)) { seenKeys.add(value); keys.push(value); } }
      for (const key of Array.isArray(result.tombstones) ? result.tombstones : []) { const value = String(key); if (!seenTombstones.has(value)) { seenTombstones.add(value); tombstones.push(value); } }
      for (const row of Array.isArray(result.records) ? result.records : []) { const identity = `${String(row?.space || normalizedSpace)}\u0000${String(row?.key || '')}`; if (!seenRecords.has(identity)) { seenRecords.add(identity); records.push(row); } }
      const nextCursor = String(result.nextCursor || result?.page?.nextCursor || '');
      if (!nextCursor) break;
      if (nextCursor === cursor) throw new Error('memory_suite_manager_keys_pagination_cursor_stalled');
      cursor = nextCursor;
    }
    return { keys, tombstones, records, page: { pages, complete: true } };
  };
  const managerServerIntegrity = async targetNamespace => {
    const ns = String(targetNamespace || '').trim().toLowerCase();
    const payload = await managerRequest('GET', `/v1/integrity?namespace=${encodeURIComponent(ns)}`);
    const result = payload?.result || {};
    if (result.ok !== true || String(result.result || '') !== 'ok') throw new Error(`memory_suite_manager_integrity_failed:${ns}:${result.result || 'unknown'}`);
    return result;
  };
  const managerReplaceScopeIndex = async (targetNamespace, scopes = []) => {
    const connection = await managerConnection();
    if (connection?.capabilities?.['scope-catalog.v1'] !== true) {
      const error = new Error('memory_suite_scope_catalog_capability_missing');
      error.code = 'MEMORY_SUITE_MANAGER_CAPABILITY_MISSING';
      throw error;
    }
    const response = await managerRequest('POST', '/v1/manager/scopes/index', {
      namespace: String(targetNamespace || namespace || ''),
      scopes: Array.isArray(scopes) ? scopes : []
    });
    return response?.result || null;
  };
  const managerListScopes = async () => {
    const response = await managerRequest('GET', '/v1/manager/scopes');
    return response?.result || { scopes: [] };
  };
  const managerPlanScopeDeletion = async payload => {
    const connection = await managerConnection();
    if (connection?.capabilities?.['scope-delete-preview.v1'] !== true) {
      const error = new Error('memory_suite_scope_delete_capability_missing');
      error.code = 'MEMORY_SUITE_MANAGER_CAPABILITY_MISSING';
      throw error;
    }
    const response = await managerRequest('POST', '/v1/manager/scope-delete/plan', payload || {});
    return response?.result || null;
  };
  const managerExecuteScopeDeletion = async (planId, mutationFingerprint, options = {}) => {
    const connection = await managerConnection();
    if (connection?.capabilities?.['scope-delete-commit.v1'] !== true) throw new Error('memory_suite_scope_delete_commit_capability_missing');
    const response = await managerRequest('POST', '/v1/manager/scope-delete/execute', {
      planId: String(planId || ''),
      statusOnly: options.statusOnly === true,
      mutationFingerprint: String(mutationFingerprint || '')
    });
    return response?.result || null;
  };
  const managerSetScopePinned = async (targetNamespace, scopeId, pinned) => {
    const connection = await managerConnection();
    if (connection?.capabilities?.['scope-pin.v1'] !== true) {
      const error = new Error('memory_suite_scope_pin_capability_missing');
      error.code = 'MEMORY_SUITE_MANAGER_CAPABILITY_MISSING';
      throw error;
    }
    const response = await managerRequest('POST', '/v1/manager/scope-pin', {
      namespace: String(targetNamespace || namespace || ''),
      scopeId: String(scopeId || ''),
      pinned: pinned === true
    });
    return response?.result || null;
  };

  const dispose = async () => {
    if (lifecycle.disposed) return false;
    for(const lease of graphStorageLeases.values())void lease.release();
    lifecycle.disposed = true;
    for (const timer of [...lifecycle.timers]) clearTimeout(timer);
    lifecycle.timers.clear();
    for (const controller of [...lifecycle.abortControllers]) {
      try { controller.abort(); } catch (_) {}
    }
    lifecycle.abortControllers.clear();
    state.management.timer = null;
    state.syncJob.retryTimer = null;
    state.syncJob.persistTimer = null;
    state.diagnostics.timer = null;
    state.syncJob.listeners.clear();
    state.scopeRouting.routeCache.clear();
    state.scopeRouting.transientModes.clear();
    state.transientMode = '';
    mutationTails.clear();
    resetBootstrapCache();
    try { state.management.root?.remove?.(); } catch (_) {}
    state.management.root = null;
    return true;
  };

  // v1.8.15: explicit, data-only, single-namespace server transactions.
  // This is NOT an atomic mirror or a general pluginStorage transaction.
  const conditionalBatchError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
  const conditionalBatchSHA = async value => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (!globalThis.crypto?.subtle) throw conditionalBatchError('MEMORY_SUITE_BATCH_CRYPTO_UNAVAILABLE');
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
  };
  const conditionalBatchClone = value => JSON.parse(JSON.stringify(value));
  const conditionalBatchBoundary = async () => {
    if (storageTransition) throw transitionBusyError();
    if (lifecycle.disposed) throw conditionalBatchError('MEMORY_SUITE_BATCH_DISPOSED');
    const scope = await resolveCurrentScope(true);
    const mode = (await readScopeMode(scope, true)).mode;
    if (mode !== MODE_SERVER_ONLY && !(namespace === 'libra' && mode === MODE_MIRROR)) throw conditionalBatchError('MEMORY_SUITE_BATCH_REQUIRES_SERVER_ONLY');
    if (!scope?.scopeId || await recoveryLockForScope(scope)) throw conditionalBatchError('MEMORY_SUITE_BATCH_SCOPE_UNAVAILABLE');
    const config = await readConfig();
    const connection = await bootstrap(false, true);
    if (connection?.capabilities?.['conditional-batch.v1'] !== true) throw conditionalBatchError('MEMORY_SUITE_BATCH_CAPABILITY_MISSING');
    return { namespace, scopeId: scope.scopeId, mode, url: config.url, serverUrl: connection.url,
      serverPin:durableServerPinFromConnection(connection,config.url) };
  };
  const conditionalBatchRoute = async (space, key, boundary) => {
    if (!['plugin','local'].includes(space) || typeof key !== 'string' || !key || !matchesRoute(space,key)) {
      throw conditionalBatchError('MEMORY_SUITE_BATCH_KEY_NOT_OWNED');
    }
    const route = await resolveScopedRoute(space,key,{forceScope:true,noCache:true});
    if (!route.routed || route.kind !== 'scope' || route.scopeId !== boundary.scopeId || route.mode !== boundary.mode
      || route.scopedContainer || route.projectValue || route.mergeValue || route.removeValue) {
      throw conditionalBatchError('MEMORY_SUITE_BATCH_ROUTE_UNSUPPORTED');
    }
    return {space, key, remoteKey:route.remoteKey, scopeId:route.scopeId};
  };
  const conditionalBatchRecord = async (space, key, readObserver = null) => {
    const lease = readObserver ? readObserver() : null;
    let stage = null;
    try {
      const row = await remoteGet(space,key,{allowPluginOnly:true});
      if (lease) { lease.accept(row.value ?? null); stage = lease.prepare(row.value ?? null); }
      if (typeof row.exists !== 'boolean' || typeof row.tombstone !== 'boolean' || row.exists && row.tombstone
        || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.digest !== 'string') {
        throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_INVALID');
      }
      if (row.revision === 0) {
        if (row.exists || row.tombstone || row.digest !== '') throw conditionalBatchError('MEMORY_SUITE_BATCH_ABSENCE_INVALID');
      } else if (!/^[a-f0-9]{64}$/.test(row.digest) || row.exists === row.tombstone) {
        throw conditionalBatchError('MEMORY_SUITE_BATCH_REVISION_INVALID');
      }
      if (row.exists && await conditionalBatchSHA(row.value) !== row.digest) throw conditionalBatchError('MEMORY_SUITE_BATCH_VALUE_DIGEST_MISMATCH');
      return row;
    } finally { stage?.release(); lease?.release(); }
  };

  const captureConditionalReadSet = async (keys = [], { readObserver = null } = {}) => {
    if (readObserver !== null && typeof readObserver !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_OBSERVER_INVALID');
    if(!Array.isArray(keys)||!keys.length||keys.length>64)throw conditionalBatchError('MEMORY_SUITE_BATCH_ITEM_LIMIT');
    const boundary=await conditionalBatchBoundary(),records=[],seen=new Set();
    for(const key of keys){const route=await conditionalBatchRoute('plugin',key,boundary);
      if(seen.has(route.remoteKey))throw conditionalBatchError('MEMORY_SUITE_BATCH_DUPLICATE_KEY');seen.add(route.remoteKey);
      const row=await conditionalBatchRecord(route.space,route.remoteKey,readObserver);
      records.push({...route,revision:row.revision,digest:row.digest,exists:row.exists,tombstone:row.tombstone});
    }
    if(jsonComparable(boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    const data={schema:'memory-suite.storage.read-set.v1',boundary,records,capturedAt:Date.now()};
    return {...data,payloadDigest:await conditionalBatchSHA(data)};
  };
  const assertConditionalReadSet = async (raw, { readObserver = null } = {}) => {
    if (readObserver !== null && typeof readObserver !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_OBSERVER_INVALID');
    const data=conditionalBatchClone(raw || {}),hash=data.payloadDigest;delete data.payloadDigest;
    if(data.schema!=='memory-suite.storage.read-set.v1' || !Array.isArray(data.records)||!data.records.length||data.records.length>64
      || hash!==await conditionalBatchSHA(data))throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SET_INVALID');
    if(jsonComparable(data.boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    for(const saved of data.records){const route=await conditionalBatchRoute(saved.space,saved.key,data.boundary);
      if(route.remoteKey!==saved.remoteKey)throw conditionalBatchError('MEMORY_SUITE_BATCH_ROUTE_CHANGED');
      const row=await conditionalBatchRecord(route.space,route.remoteKey,readObserver);
      if(row.revision!==saved.revision||row.digest!==saved.digest||row.exists!==saved.exists||row.tombstone!==saved.tombstone)throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SET_CHANGED',{storageMutationKey:saved.key});
    }
    return true;
  };
  const captureServerBinding=async()=>{
    for(let attempt=0;attempt<4;attempt++){
      const connection=await bootstrap(false,true),generation=dataBinding.generation;
      await assertConnectionCurrent(connection,generation);
      // A refresh temporarily clears bootstrap.value. Wait for its validated
      // result instead of misclassifying an unknown reset epoch as a change.
      if(state.bootstrap.pending||state.bootstrap.value!==connection)continue;
      if(dataBinding.generation!==generation)throw connectionStaleError();
      return serverBinding();
    }
    throw connectionStaleError();
  };
  // Server-only derived-store leases. Public DTOs and process-local Maps are
  // never accepted as a namespace fence by the storage owner.
  const graphStorageLeases=new Map();
  const graphLifecycleRequest=async(scopeKey,body)=>{
    const scope=await resolveCurrentScope(false),mode=(await readScopeMode(scope,false)).mode;
    if(scope.scopeKey!==scopeKey||![MODE_SERVER_ONLY,MODE_MIRROR].includes(mode))throw new Error('LIBRA_GRAPH_LEASE_ROUTE_CHANGED');
    const before=await conditionalBatchBoundary();
    const boot=await bootstrap(false,true);
    if(boot?.capabilities?.['libra-graph-lifecycle.v1']!==true)throw new Error('LIBRA_GRAPH_LEASE_UPGRADE_REQUIRED');
    // A v2 projection must only be published by a GC-aware storage owner.
    if(body.action==='acquire'&&body.kind==='build'&&boot?.capabilities?.['libra-graph-projection-pages.v1']!==true)throw new Error('LIBRA_GRAPH_PROJECTION_UPGRADE_REQUIRED');
    const payload=await request('POST','/v1/libra/graph-lifecycle',{scopeKey,...body},{allowPluginOnly:true,scopeId:scopeKey,storageMode:mode});
    if(jsonComparable(before)!==jsonComparable(await conditionalBatchBoundary()))throw new Error('LIBRA_GRAPH_LEASE_ROUTE_CHANGED');
    if(payload?.ok!==true||!payload.result)throw new Error('LIBRA_GRAPH_LEASE_RESPONSE_INVALID');
    return payload.result;
  };
  const acquireGraphStorageLease=async(scopeKey,kind)=>{
    const mode=(await readScopeMode(await resolveCurrentScope(false),false)).mode;
    if(![MODE_SERVER_ONLY,MODE_MIRROR].includes(mode)||kind==='gc'&&mode!==MODE_SERVER_ONLY)return null;
    let lease=await graphLifecycleRequest(scopeKey,{action:'acquire',kind,requestId:operationId('graph-lease')}),closed=false,timer=null,failure=null;
    const key=lease.token;
    const assertCurrent=async()=>{if(closed||failure)throw failure||new Error('LIBRA_GRAPH_LEASE_CLOSED');return await graphLifecycleRequest(scopeKey,{action:'assert',token:key});};
    const renew=async()=>{try{if(closed)return;lease=await graphLifecycleRequest(scopeKey,{action:'renew',token:key});}catch(error){failure=error;}finally{if(!closed&&!failure){timer=setTimeout(renew,20000);timer?.unref?.();}}};
    timer=setTimeout(renew,20000);timer?.unref?.();
    const session={scopeKey,kind,token:key,assertCurrent,
      command:async body=>{await assertCurrent();return await graphLifecycleRequest(scopeKey,{...body,token:key});},
      release:async()=>{if(closed)return;closed=true;clearTimeout(timer);graphStorageLeases.delete(key);try{await graphLifecycleRequest(scopeKey,{action:'release',token:key});}catch(_){/* durable expiration still revokes this lease */}}
    };
    graphStorageLeases.set(key,session);return Object.freeze(session);
  };
  const prepareConditionalBatch = async (input = {}) => {
    const mutations = input.mutations, conditions = input.conditions || [];
    if (!Array.isArray(mutations) || !mutations.length || !Array.isArray(conditions) || mutations.length+conditions.length>64) {
      throw conditionalBatchError('MEMORY_SUITE_BATCH_ITEM_LIMIT');
    }
    const boundary = await conditionalBatchBoundary();
    const pinnedSets=[...(input.readSet?[input.readSet]:[]),...(input.readSets||[])];
    if(!Array.isArray(input.readSets||[])||pinnedSets.length>4)throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SET_INVALID');
    for(const pin of pinnedSets)await assertConditionalReadSet(pin);
    const body = {namespace,operationId:input.operationId || operationId('conditional'),conditions:[],mutations:[]};
    if (!/^[A-Za-z0-9._:-]{8,240}$/.test(body.operationId)) throw conditionalBatchError('MEMORY_SUITE_BATCH_OPERATION_ID_INVALID');
    const routes=[],seen=new Set();
    for (const [kind,list] of [['conditions',conditions],['mutations',mutations]]) for (const item of list) {
      if (!item || typeof item !== 'object' || !item.expected || typeof item.expected.exists !== 'boolean'
        || item.expected.exists && !Object.prototype.hasOwnProperty.call(item.expected,'value')) throw conditionalBatchError('MEMORY_SUITE_BATCH_EXPECTATION_REQUIRED');
      if (kind === 'mutations' && (!['set','remove'].includes(item.kind) || (item.kind==='set' && item.value===undefined)
        || item.kind==='remove' && Object.prototype.hasOwnProperty.call(item,'value'))) throw conditionalBatchError('MEMORY_SUITE_BATCH_MUTATION_INVALID');
      const route=await conditionalBatchRoute(item.space || 'plugin',item.key,boundary),identity=`${route.space}\n${route.remoteKey}`;
      if (seen.has(identity)) throw conditionalBatchError('MEMORY_SUITE_BATCH_DUPLICATE_KEY');seen.add(identity);routes.push(route);
      const row=await conditionalBatchRecord(route.space,route.remoteKey);
      if (row.exists!==item.expected.exists || row.exists && jsonComparable(row.value)!==jsonComparable(item.expected.value)) {
        throw conditionalBatchError('MEMORY_SUITE_BATCH_EXPECTED_VALUE_CHANGED',{storageMutationKey:item.key});
      }
      const condition={space:route.space,key:route.remoteKey,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:row.exists,expectedTombstone:row.tombstone};
      body[kind].push(kind==='conditions'?condition:{...condition,kind:item.kind,...(item.kind==='set'?{value:conditionalBatchClone(item.value)}:{})});
    }
    for(const pin of pinnedSets)for(const saved of pin.records){
      const condition=[...body.conditions,...body.mutations].find(c=>c.space===saved.space&&c.key===saved.remoteKey);
      if(!condition||condition.expectedRevision!==saved.revision||condition.expectedDigest!==saved.digest||condition.expectedExists!==saved.exists||condition.expectedTombstone!==saved.tombstone)throw conditionalBatchError('MEMORY_SUITE_BATCH_PIN_NOT_BOUND');
    }
    const graphScope=/^libra:v1:scope:([^:]+):memory-graph:v1:/.exec(body.mutations[0]?.key||'')?.[1];
    if(graphScope&&body.mutations.some(m=>m.key.includes(':root:'))){
      const lease=[...graphStorageLeases.values()].find(x=>x.scopeKey===graphScope&&x.kind==='build');
      if(!lease)throw new Error('LIBRA_GRAPH_BUILD_LEASE_REQUIRED');await lease.assertCurrent();body.graphLease={scopeKey:graphScope,token:lease.token};
    }
    if (storageValueBytes(body)>4*1024*1024) throw conditionalBatchError('MEMORY_SUITE_BATCH_BODY_LIMIT');
    if (jsonComparable(boundary)!==jsonComparable(await conditionalBatchBoundary())) throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    const prepared={schema:'memory-suite.storage.prepared-batch.v1',boundary,body,routes,preparedAt:Date.now()};
    return {...prepared,payloadDigest:await conditionalBatchSHA(prepared)};
  };
  const validateConditionalBatchPrepared = async raw => {
    let prepared;try {prepared=conditionalBatchClone(raw);}catch(_){throw conditionalBatchError('MEMORY_SUITE_BATCH_PREPARED_INVALID');}
    const {payloadDigest,...data}=prepared || {};
    if (data.schema!=='memory-suite.storage.prepared-batch.v1' || !data.body || !Array.isArray(data.routes)
      || data.body.namespace!==namespace || payloadDigest!==await conditionalBatchSHA(data)
      || !Number.isSafeInteger(data.preparedAt) || data.preparedAt>Date.now()+60000
      || Date.now()-data.preparedAt>24*60*60*1000) throw conditionalBatchError('MEMORY_SUITE_BATCH_PREPARED_INVALID_OR_EXPIRED');
    const b=data.body;
    if(!Array.isArray(b.conditions)||!Array.isArray(b.mutations)||!b.mutations.length
      || b.conditions.length+b.mutations.length>64||data.routes.length!==b.conditions.length+b.mutations.length
      || !/^[A-Za-z0-9._:-]{8,240}$/.test(b.operationId)||storageValueBytes(b)>4*1024*1024)throw conditionalBatchError('MEMORY_SUITE_BATCH_PREPARED_BODY_INVALID');
    const seen=new Set();let index=0;
    for(const [kind,list]of [['conditions',b.conditions],['mutations',b.mutations]])for(const item of list){
      const route=data.routes[index++],identity=String(item?.space)+'\n'+String(item?.key);
      if(!route||item.space!==route.space||item.key!==route.remoteKey||seen.has(identity)
        || !Number.isSafeInteger(item.expectedRevision)||item.expectedRevision<0
        || typeof item.expectedDigest!=='string'||typeof item.expectedExists!=='boolean'||typeof item.expectedTombstone!=='boolean'
        || (kind==='mutations'&&(!['set','remove'].includes(item.kind)||(item.kind==='set'&&item.value===undefined))))throw conditionalBatchError('MEMORY_SUITE_BATCH_PREPARED_ROUTE_INVALID');
      seen.add(identity);
    }
    durableServerPinShape(data.boundary?.serverPin,data.boundary?.url);
    const boundary=await conditionalBatchBoundary();
    if (jsonComparable(boundary)!==jsonComparable(data.boundary)) throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    for(const route of data.routes)if(jsonComparable(await conditionalBatchRoute(route.space,route.key,boundary))!==jsonComparable(route))throw conditionalBatchError('MEMORY_SUITE_BATCH_ROUTE_CHANGED');
    return prepared;
  };
  const verifyConditionalBatchReceipt = async (prepared, payload) => {
    const r=payload?.result,b=prepared.body;
    if (payload?.ok!==true || r?.schema!=='memory-suite.storage.batch-receipt.v1' || r.namespace!==namespace
      || r.operationId!==b.operationId || r.atomicScope!=='single_namespace_sqlite' || r.durable!==true || r.verified!==true
      || r.checked!==b.conditions.length || !Array.isArray(r.receipts) || r.receipts.length!==b.mutations.length) {
      throw conditionalBatchError('MEMORY_SUITE_BATCH_RECEIPT_INVALID',{storageMutationIndeterminate:true,storageOperationId:b.operationId});
    }
    const receipts=new Map();for(const row of r.receipts){const k=`${row.space}\n${row.key}`;if(receipts.has(k))throw conditionalBatchError('MEMORY_SUITE_BATCH_RECEIPT_DUPLICATE');receipts.set(k,row);}
    for(const m of b.mutations){const row=receipts.get(`${m.space}\n${m.key}`);
      if (!row || row.kind!==m.kind || row.revision!==m.expectedRevision+1 || row.tombstone!==(m.kind==='remove')
        || !/^[a-f0-9]{64}$/.test(row.digest) || m.kind==='set' && row.digest!==await conditionalBatchSHA(m.value)) throw conditionalBatchError('MEMORY_SUITE_BATCH_RECEIPT_MISMATCH');
    }
    // Historical receipts attest a commit, not the current contents. Never repair
    // a later writer's data by blindly replaying this old transaction.
    for(const m of b.mutations){const receipt=receipts.get(`${m.space}\n${m.key}`),row=await conditionalBatchRecord(m.space,m.key);
      if(row.revision!==receipt.revision || row.digest!==receipt.digest || row.tombstone!==receipt.tombstone
        || m.kind==='set' && (!row.exists || jsonComparable(row.value)!==jsonComparable(m.value))) throw conditionalBatchError('MEMORY_SUITE_BATCH_COMMITTED_BUT_ADVANCED',{storageMutationCommitted:true,storageOperationId:b.operationId});
    }
    for(const c of b.conditions){const row=await conditionalBatchRecord(c.space,c.key);
      if(row.revision!==c.expectedRevision || row.digest!==c.expectedDigest || row.exists!==c.expectedExists || row.tombstone!==c.expectedTombstone)throw conditionalBatchError('MEMORY_SUITE_BATCH_COMMITTED_BOUNDARY_ADVANCED',{storageMutationCommitted:true,storageOperationId:b.operationId});
    }
    if(jsonComparable(prepared.boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_COMMITTED_BOUNDARY_CHANGED',{storageMutationCommitted:true,storageOperationId:b.operationId});
    const localMirror = { required:prepared.boundary.mode === MODE_MIRROR, verified:true, pending:[] };
    if (localMirror.required) for (const m of b.mutations) {
      const logical=prepared.routes.find(route=>route.space===m.space && route.remoteKey===m.key);
      const route=await resolveScopedRoute(logical.space,logical.key,{forceScope:true,noCache:true});
      const mirrored=await mirrorServerRow(logical.space,logical.key,route,await conditionalBatchRecord(m.space,m.key));
      if (!mirrored.verified) localMirror.pending.push(mirrored);
    }
    localMirror.verified=localMirror.pending.length===0;
    return {...conditionalBatchClone(r),endToEndVerified:true,localMirror};
  };
  const commitConditionalBatch = async raw => {
    const prepared=await validateConditionalBatchPrepared(raw);
    return await serializeMutationGroup(prepared.routes.map(route=>({space:route.space,key:route.remoteKey})),async()=>{
      let payload;
      try {
        // Use the same id/payload across response loss and restart. Never allocate a
        // replacement id or refetch predicates to force an old candidate through.
        payload=await request('POST','/v1/kv/batch',prepared.body,{allowPluginOnly:true,scopeId:prepared.boundary.scopeId,storageMode:prepared.boundary.mode});
      } catch(error) {
        if ([400,401,403,409,413].includes(error?.status)) {error.storageMutationRejected=true;throw error;}
        // One bounded read-only reconnect is allowed after a lost write response.
        // The ordinary circuit would otherwise hide an already committed receipt.
        // Never resubmit a write with fresh predicates or a replacement operation id.
        try {await bootstrap(true,true);payload=await statusReadback(prepared.body.operationId,{allowPluginOnly:true});}catch(_){}
        if(!payload){error.storageMutationIndeterminate=true;error.storageOperationId=prepared.body.operationId;throw error;}
      }
      try {return await verifyConditionalBatchReceipt(prepared,payload);}
      catch(error){if(!error.storageMutationCommitted)error.storageMutationIndeterminate=true;error.storageOperationId=prepared.body.operationId;throw error;}
    });
  };

  // Request-local route observation. Stored choices are read without import,
  // default initialization, bootstrap, synchronization, recovery or a writer.
  // This private instance brand does not certify a durable semantic mode epoch.
  const readonlyRouteHandles=new WeakMap(),readonlyRouteActive=new Set();
  const readonlyRouteFail=code=>{throw Object.assign(new Error(code),{code});};
  const readonlyRouteExact=(value,keys)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).sort().join('|')!==keys.slice().sort().join('|'))readonlyRouteFail('READ_ROUTE_REQUEST_INVALID');
    for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))readonlyRouteFail('READ_ROUTE_REQUEST_INVALID');}
  };
  const readonlyRouteId=value=>{if(typeof value!=='string'||!value||value.length>700||value.trim()!==value||/[\0\r\n]/.test(value))readonlyRouteFail('READ_ROUTE_IDENTITY_UNAVAILABLE');return value;};
  const readonlyRouteFence=()=>{
    if(namespace!=='libra'||lifecycle.disposed||modeConfigurationBusy||modeConfigurationFrozen||storageTransition||resetReloadRequired||dataBinding.rejected)readonlyRouteFail('READ_ROUTE_TRANSITION_UNAVAILABLE');
    return JSON.stringify([wholeDataInventoryEpoch,dataBinding.generation,dataBinding.url,dataBinding.dataInstanceId,dataBinding.certified]);
  };
  const readonlyRouteObject=raw=>{
    if(typeof raw!=='string'||raw.length>1024*1024)readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');
    let value;try{value=JSON.parse(raw);}catch(_){readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');}
    if(!value||typeof value!=='object'||Array.isArray(value))readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');return value;
  };
  const readReadonlyRoute=async (identity, ownerRead=false)=>{
    const fence=readonlyRouteFence(),plugin=rawPluginStorage(),device=await rawDeviceStorage({strict:true});
    if(typeof plugin?.getItem!=='function')readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');
    const rawScope=await plugin.getItem('libra:v1:scope-registry:v1'),registry=readonlyRouteObject(rawScope);
    const key=identity.characterId+'::'+identity.chatId,row=Object.hasOwn(registry,key)?registry[key]:null;
    if(!row||row.characterId!==identity.characterId||row.chatId!==identity.chatId)readonlyRouteFail('READ_ROUTE_SCOPE_UNAVAILABLE');
    const scope={characterId:identity.characterId,chatId:identity.chatId,scopeKey:readonlyRouteId(row.scopeKey)};
    const candidates=[],modePublicationCopies=[];let legacyModeImported=false;
    for(const store of [...new Set([plugin,device].filter(Boolean))]){
      const raw=await store.getItem(SCOPE_ROUTING_LOCAL_KEY);modePublicationCopies.push(raw);if(raw==null||raw==='')continue;
      const parsed=readonlyRouteObject(raw);
      if(parsed.schema!==SCOPE_ROUTING_SCHEMA||parsed.namespace!==namespace||!parsed.entries||typeof parsed.entries!=='object'||Array.isArray(parsed.entries))readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');
      if(parsed.legacyGlobalModeImported===true)legacyModeImported=true;
      const picked={};
      for(const id of [scope.scopeKey,GLOBAL_SCOPE_ID]){
        const value=Object.hasOwn(parsed.entries,id)?parsed.entries[id]:null;if(!value)continue;
        if(typeof value!=='object'||Array.isArray(value)||!VALID_MODES.has(value.mode)||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||(value.scopeId!==undefined&&value.scopeId!==id)||(value.scopeKey!==undefined&&value.scopeKey!==id)||(value.origin!==undefined&&typeof value.origin!=='string')||(value.removed!==undefined&&typeof value.removed!=='boolean'))readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');
        picked[id]={mode:value.mode,updatedAt:value.updatedAt,origin:value.origin||'',removed:value.removed===true};
      }
      candidates.push(picked);
    }
    const modePublication=await inspectModePublicationCopies(modePublicationCopies);
    if(!['absent','observed'].includes(modePublication.status))readonlyRouteFail('READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE');
    const pick=id=>{let out=null;for(const candidate of candidates){const value=candidate[id];if(!value)continue;if(out&&value.updatedAt===out.updatedAt&&JSON.stringify(value)!==JSON.stringify(out))readonlyRouteFail('READ_ROUTE_AMBIGUOUS');if(!out||value.updatedAt>out.updatedAt)out=value;}return out;};
    const stored=pick(scope.scopeKey),global=pick(GLOBAL_SCOPE_ID);
    if(stored?.removed||stored?.origin==='transition_pending'||state.scopeRouting.transientModes.has(scope.scopeKey))readonlyRouteFail('READ_ROUTE_SCOPE_UNAVAILABLE');
    const explicit=stored&&!['inherited','migrated'].includes(stored.origin);
    let selected=explicit?stored:global&&!global.removed?global:stored,ownerLocalWitness=null;
    // The owner's writer resolves an unrouted, unimported scope from the legacy
    // mode argument (readScopeModeValue). The owner's own engine observes the same
    // choice, so server-only data written that way stays readable for recall.
    const legacyMode=!selected&&ownerRead&&globalModeEnabled&&!legacyModeImported?normalizeMode(await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY)):MODE_PLUGIN_ONLY;
    if(!selected&&ownerRead&&legacyMode!==MODE_PLUGIN_ONLY){
      selected={mode:legacyMode,origin:'owner_observed_legacy_argument'};ownerLocalWitness=JSON.stringify(['legacy_argument',legacyMode]);
    }else if(!selected&&ownerRead){
      // Only the native owner's engine may observe the established fresh-local
      // default. Reuse the strict argument/transition/reset witness; never import
      // a mode, create routing rows or weaken the external readonly contract.
      const local=await inspectLocalHealthSnapshot({...scope,scopeId:scope.scopeKey},'libra:v1:scope:'+scope.scopeKey+':manifest',{strictPhysical:true});
      if(local.mode!==MODE_PLUGIN_ONLY)readonlyRouteFail('READ_ROUTE_MODE_UNAVAILABLE');
      selected={mode:MODE_PLUGIN_ONLY,origin:'owner_observed_local_default'};ownerLocalWitness=local.binding;
    }
    if(!selected||selected.removed||selected.mode===MODE_MIRROR&&!ownerRead||selected.origin==='transition_pending')readonlyRouteFail('READ_ROUTE_MODE_UNAVAILABLE');
    const reset=await plugin.getItem(resetChoiceKey);if(reset!=null&&reset!=='')readonlyRouteFail('READ_ROUTE_RESET_UNAVAILABLE');
    const currentDevice=await rawDeviceStorage({strict:true});
    if(readonlyRouteFence()!==fence||rawPluginStorage()!==plugin||currentDevice!==device)readonlyRouteFail('READ_ROUTE_CHANGED');
    // Includes only relevant routing rows; unrelated registry entries are harmless.
    return {scope,mode:selected.mode,scopeRow:stored,globalRow:explicit?null:global,modePublication,fence,plugin,device,ownerLocalWitness};
  };
  const readonlyRouteState=input=>{
    readonlyRouteExact(input,['handle','requestId']);const s=readonlyRouteHandles.get(input.handle);
    if(!s||s.requestId!==input.requestId)readonlyRouteFail('INVALID_READ_ROUTE_HANDLE');
    if(!s.active)readonlyRouteFail('READ_ROUTE_RELEASED');
    if(performance.now()>=s.deadline){s.active=false;readonlyRouteActive.delete(s);readonlyRouteFail('READ_ROUTE_EXPIRED');}
    return s;
  };
  const observeReadRoute=async (input,ownerRead)=>{
    readonlyRouteExact(input,['requestId','characterId','chatId','durationMs']);readonlyRouteId(input.requestId);readonlyRouteId(input.characterId);readonlyRouteId(input.chatId);
    if(!Number.isSafeInteger(input.durationMs)||input.durationMs<1||input.durationMs>120000)readonlyRouteFail('READ_ROUTE_REQUEST_INVALID');
    for(const s of readonlyRouteActive)if(performance.now()>=s.deadline&&!s.pending){s.active=false;readonlyRouteActive.delete(s);}
    if(readonlyRouteActive.size>=4)readonlyRouteFail('READ_ROUTE_LIMIT');
    const s={requestId:input.requestId,identity:{characterId:input.characterId,chatId:input.chatId},deadline:performance.now()+input.durationMs,pending:true,active:true,ownerRead};readonlyRouteActive.add(s);
    try{
      s.value=await readReadonlyRoute(s.identity,ownerRead);if(performance.now()>=s.deadline)readonlyRouteFail('READ_ROUTE_EXPIRED');
      const handle=Object.freeze({});readonlyRouteHandles.set(handle,s);
      const summary=Object.freeze({schema:'memory-suite.readonly-route-observation.v1',scope:Object.freeze({...s.value.scope}),mode:s.value.mode,routeEpoch:Object.freeze({kind:'sdk-instance-configuration-generation',generation:wholeDataInventoryEpoch}),semanticModeEpoch:null,modePublication:s.value.modePublication,usage:'request-local-route-observation',authorityQualified:false});
      return Object.freeze({handle,summary});
    }catch(error){s.active=false;readonlyRouteActive.delete(s);throw error;}finally{s.pending=false;}
  };
  const observeReadonlyRoute=input=>observeReadRoute(input,false);
  const observeOwnerReadonlyRoute=input=>observeReadRoute(input,true);
  const assertReadonlyRouteCurrent=async input=>{
    const s=readonlyRouteState(input);if(s.pending)readonlyRouteFail('READ_ROUTE_BUSY');s.pending=true;
    try{const current=await readReadonlyRoute(s.identity,s.ownerRead);readonlyRouteState(input);const binding=v=>JSON.stringify([v.scope,v.mode,v.scopeRow,v.globalRow,v.modePublication,v.fence,v.ownerLocalWitness]);
      if(current.plugin!==s.value.plugin||current.device!==s.value.device||binding(current)!==binding(s.value))readonlyRouteFail('READ_ROUTE_CHANGED');
      return Object.freeze({status:'request-local-current',semanticModeEpoch:null});
    }catch(error){s.active=false;readonlyRouteActive.delete(s);throw error;}finally{s.pending=false;}
  };
  const releaseReadonlyRouteObservation=input=>{readonlyRouteExact(input,['handle','requestId']);const s=readonlyRouteHandles.get(input.handle);if(!s||s.requestId!==input.requestId)readonlyRouteFail('INVALID_READ_ROUTE_HANDLE');s.active=false;s.value=null;if(!s.pending)readonlyRouteActive.delete(s);return Object.freeze({status:'READ_ROUTE_RELEASED'});};

  const inspectLocalHealthSnapshot = async (scopeInput, key, readOptions = {}) => {
    if (lifecycle.disposed || modeConfigurationFrozen || storageTransition || resetReloadRequired) throw new Error('HEALTH_STORAGE_TRANSITION_UNVERIFIED');
    const scope = normalizeScopeDescriptor(scopeInput);
    if (!scope?.scopeId) throw new Error('HEALTH_SCOPE_UNVERIFIED');
    // This diagnostics path deliberately does not invoke readScopeMode,
    // get/create proxies, legacy mode import, bootstrap, or mirror sync.
    const plugin = rawPluginStorage();
    if (typeof plugin?.getItem !== 'function') throw new Error('HEALTH_STORAGE_UNAVAILABLE');
    const device = await rawDeviceStorage({ strict: true });
    const pluginRaw = await plugin.getItem(SCOPE_ROUTING_LOCAL_KEY);
    const deviceRaw = typeof device?.getItem === 'function' ? await device.getItem(SCOPE_ROUTING_LOCAL_KEY) : null;
    for (const raw of [pluginRaw, deviceRaw]) if (raw != null && raw !== '') {
      let parsed; try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { throw new Error('HEALTH_ROUTE_UNVERIFIED'); }
      if (parsed?.schema !== 'memory-suite.scope-routing.v1' || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('HEALTH_ROUTE_UNVERIFIED');
      // Inspect unnormalized authority rows. The ordinary compatibility parser
      // intentionally defaults unknown modes to local and must not establish
      // authority for a read-only health check.
      for (const [id, row] of Object.entries(parsed.entries)) {
        if (!id.trim() || !row || typeof row !== 'object' || Array.isArray(row)
            || typeof row.mode !== 'string' || !VALID_MODES.has(row.mode)
            || (row.scopeId !== undefined && (typeof row.scopeId !== 'string' || row.scopeId !== id))
            || (row.origin !== undefined && typeof row.origin !== 'string')
            || (row.removed !== undefined && typeof row.removed !== 'boolean')) throw new Error('HEALTH_ROUTE_UNVERIFIED');
      }
    }
    const registry = mergeScopeRegistries(null, pluginRaw, deviceRaw);
    const stored = registry.entries?.[scope.scopeId], global = liveGlobalRow(registry);
    if (isRemovedScopeRow(stored)) throw new Error('HEALTH_SCOPE_REMOVED');
    // Core3 no longer imports/reset-writes legacy mode during ordinary startup.
    // Prove its fresh local default observationally; never default failed or
    // unknown argument reads to local authority, or initialize a registry here.
    let freshLocalAuthority = null;
    if (!registry.legacyGlobalModeImported && !stored && !global) {
      if (!globalModeEnabled) throw new Error('HEALTH_ROUTE_UNINITIALIZED');
      for (const value of [pluginRaw, deviceRaw]) if (value != null && value !== '') {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (parsed.namespace !== namespace || parsed.legacyGlobalModeImported !== undefined
            && typeof parsed.legacyGlobalModeImported !== 'boolean') throw new Error('HEALTH_ROUTE_UNVERIFIED');
      }
      if (typeof device?.getItem !== 'function') throw new Error('HEALTH_STORAGE_UNAVAILABLE');
      const epoch = wholeDataInventoryEpoch, generation = dataBinding.generation;
      const fence = {assertCurrent: () => {
        if (lifecycle.disposed || modeConfigurationBusy || modeConfigurationFrozen || storageTransition || resetReloadRequired
            || wholeDataInventoryEpoch !== epoch || dataBinding.generation !== generation) throw new Error('HEALTH_AUTHORITY_CHANGED');
      }};
      const routes = JSON.stringify([pluginRaw ?? null, deviceRaw ?? null]);
      const readWitness = async () => {
        fence.assertCurrent();
        let readable = false, selected = false;
        const reads = [], candidates = apiCandidates();
        for (const name of modeArguments) {
          for (let index = 0; index < candidates.length; index++) {
            const api = candidates[index]; let value, method;
            try {
              method = typeof api?.getArgument === 'function' ? 'getArgument' : typeof api?.getArg === 'function' ? 'getArg' : '';
              if (!method) continue;
              value = await api[method](name);
            } catch (_) { throw new Error('HEALTH_ROUTE_UNVERIFIED'); }
            readable = true;
            if (value != null && typeof value !== 'string') throw new Error('HEALTH_ROUTE_UNVERIFIED');
            if (typeof value === 'string' && value.length > 512) throw new Error('HEALTH_ROUTE_UNVERIFIED');
            reads.push([name, index, method, typeof value, value ?? null]);
            if (value == null || value.trim() === '') continue;
            const token = value.trim().toLowerCase().replace(/[ -]+/g, '_');
            if (!['off','plugin','plugin_only','standalone','local','local_only'].includes(token)) {
              if (['mirror','dual','coexist','coexistence','plugin_server','plugin+server','plugin_and_server','required','server','server_only','remote','remote_only'].includes(token)) throw new Error('HEALTH_LOCAL_MODE_REQUIRED');
              throw new Error('HEALTH_ROUTE_UNVERIFIED');
            }
            selected = true; break;
          }
          if (selected) break;
        }
        if (!readable) throw new Error('HEALTH_ROUTE_UNVERIFIED');
        const pending = await plugin.getItem(SYNC_JOB_STORAGE_KEY);
        if (pending != null && pending !== '' || state.syncJob.current && !syncJobTerminal(state.syncJob.current.status)) throw new Error('HEALTH_STORAGE_TRANSITION_UNVERIFIED');
        const reset = await plugin.getItem(resetChoiceKey);
        if (reset != null && reset !== '') throw new Error('HEALTH_RESET_REVIEW_REQUIRED');
        fence.assertCurrent();
        return JSON.stringify(reads);
      };
      const witness = await readWitness();
      freshLocalAuthority = { witness, assertCurrent: async () => {
        if (rawPluginStorage() !== plugin || await rawDeviceStorage({strict:true}) !== device) throw new Error('HEALTH_ROUTE_CHANGED');
        if (await readWitness() !== witness) throw new Error('HEALTH_ROUTE_CHANGED');
        const current = JSON.stringify([await plugin.getItem(SCOPE_ROUTING_LOCAL_KEY) ?? null, await device.getItem(SCOPE_ROUTING_LOCAL_KEY) ?? null]);
        if (current !== routes) throw new Error('HEALTH_ROUTE_CHANGED');
        fence.assertCurrent();
      }};
    }
    if (state.scopeRouting.transientModes.has(scope.scopeId) || stored?.origin === 'transition_pending') throw new Error('HEALTH_STORAGE_TRANSITION_UNVERIFIED');
    // Even an old or malformed reset decision is not permission to inspect a
    // retained local copy as current authority. Existing reset UI owns it.
    const reset = await plugin.getItem(resetChoiceKey);
    if (reset != null && reset !== '') throw new Error('HEALTH_RESET_REVIEW_REQUIRED');
    const explicit = stored && !['inherited','migrated'].includes(String(stored.origin || ''));
    const mode = explicit ? stored.mode : global ? global.mode : stored ? stored.mode : MODE_PLUGIN_ONLY;
    if (!VALID_MODES.has(mode) || mode !== MODE_PLUGIN_ONLY) throw new Error('HEALTH_LOCAL_MODE_REQUIRED');
    const space=readOptions.space||'plugin';
    if(!['plugin','local'].includes(space))throw new Error('HEALTH_STORAGE_SPACE_INVALID');
    const logicalKey=String(key||'');
    let raw;
    if(readOptions.strictPhysical===true){
      if(!matchesRoute(space,logicalKey))throw new Error('HEALTH_STORAGE_KEY_UNVERIFIED');
      const store=space==='local'?device:plugin;
      if(typeof store?.getItem!=='function')throw new Error('HEALTH_STORAGE_UNAVAILABLE');
      raw=await store.getItem(logicalKey);
    }else raw=await ownerLegacyRead(space,logicalKey);
    if (freshLocalAuthority) await freshLocalAuthority.assertCurrent();
    return { mode, raw, binding: JSON.stringify([scope.scopeId, stored || null, global || null, dataBinding.generation, ...(freshLocalAuthority ? ['fresh_local',freshLocalAuthority.witness] : [])]) };
  };
  /* END READ ONLY LOCAL HEALTH */

  const bridge = Object.freeze({
    namespace,
    pluginId,
    observeReadonlyRoute, observeOwnerReadonlyRoute, assertReadonlyRouteCurrent, releaseReadonlyRouteObservation,
    acquireGraphStorageLease,
    captureConditionalReadSet,
    assertConditionalReadSet,
    prepareConditionalBatch,
    commitConditionalBatch: (...args) => withOwnerIO('plugin','',()=>commitConditionalBatch(...args)),
    getConditionalBatchBoundary: conditionalBatchBoundary,
    inspectOwnedScopeHealth: async scopeKey => {
      // Diagnostic reads must remain available when a *write* recovery lock is
      // active. Never borrow a writable batch permit or clear that lock.
      const readBoundary=async()=>{
        if(lifecycle.disposed)throw new Error('libra_scope_health_disposed');
        const scope=await resolveCurrentScope(true),mode=(await readScopeMode(scope,true)).mode;
        if(namespace!=='libra'||!scope?.scopeId||![MODE_SERVER_ONLY,MODE_MIRROR].includes(mode))throw new Error('libra_scope_health_server_scope_required');
        const config=await readConfig();return {scopeId:scope.scopeId,mode,url:config.url};
      };
      const boundary=await readBoundary(),connection=await bootstrap(false,true);
      if(connection.capabilities?.['libra-scope-health.v1']!==true)throw new Error('libra_scope_health_server_update_required');
      const result=(await request('POST','/v1/owner/scope-health',{scopeKey},{scopeId:boundary.scopeId,storageMode:boundary.mode})).result;
      if(jsonComparable(boundary)!==jsonComparable(await readBoundary()))throw new Error('libra_scope_health_context_changed');
      return result;
    },
    planOwnedScopeDeletion: async scopeKey => {
      await conditionalBatchBoundary();
      return (await request('POST','/v1/owner/scope-delete/plan',{scopeKey})).result;
    },
    executeOwnedScopeDeletion: async plan => {
      await conditionalBatchBoundary();
      const result=(await request('POST','/v1/owner/scope-delete/execute',plan)).result;
      if(result?.verified!==true||result?.durable!==true)throw new Error('scope_delete_unverified');
      // Do not allow the old mirror cache to repopulate the deleted server.
      await acceptServerReset('owner_scope_deleted',result);
      return result;
    },
    get: scopedGet,
    set: scopedSet,
    remove: scopedRemove,
    keys: scopedKeys,
    bootstrap: scopedBootstrap,
    serverBinding,
    captureServerBinding,
    shouldRoute: matchesRoute,
    createPluginStorageProxy: legacy => createScopedProxy(legacy, 'plugin', proxyCache),
    createLocalStorageProxy: legacy => createScopedProxy(legacy, 'local', localProxyCache),
    synchronizeNow: async () => await withOwnerIO('plugin','',()=>scopedSynchronizeAll({ allowOverwrite: true, restoreMissingLocal: true })),
    startSynchronizationJob: scopedStartSynchronizationJob,
    startConnectionConfigurationJob: scopedStartConnectionConfigurationJob,
    startRestoreJob: scopedStartRestoreJob,
    resumePendingSyncJob: scopedResumePendingSyncJob,
    waitForSyncJob: scopedWaitForSyncJob,
    getSyncJob,
    subscribeSyncJob,
    verifyServerPreservation: async () => await scopedVerifyPreservation(state.legacy.plugin),
    restorePluginStorage: async () => await withOwnerIO('plugin','',()=>scopedRestoreAll({})),
    testConnection,
    setServerUrl: (...args) => withModeConfiguration(()=>persistServerUrl(...args)),
    configureConnection: (...args) => withModeConfiguration(()=>scopedConfigureConnection(...args)),
    getConnectionSettings: scopedGetConnectionSettings,
    mountConnectionPanel: scopedMountConnectionPanel,
    restoreServerSpaceToLegacy: (...args) => withOwnerIO(args[1] || 'plugin','',()=>scopedRestoreSpace(...args)),
    prepareServerScopeDeletion: scopedPrepareServerScopeDeletion,
    inspectScopeCatalog, manageScope, mountScopeManagementPanel,
    inspectWholeDataLocalInventory,
    migrateWholeData,
    ownerLegacyKeys,
    ownerLegacyRead,
    inspectLocalHealthSnapshot,
    ownerLegacyWrite: (...args) => withOwnerIO(args[0],args[1],()=>ownerLegacyWrite(...args)),
    ownerLegacyRemove: (...args) => withOwnerIO(args[0],args[1],()=>ownerLegacyRemove(...args)),
    deletePluginStorageAfterServerVerification: (...args) => withModeConfiguration(()=>withOwnerIO('plugin','',()=>scopedDeletePluginStorageAfterVerification(...args))),
    setMode: (...args) => withModeConfiguration(()=>scopedSetModeSafely(...args)),
    getMode: async () => (await readScopeMode(null, true)).mode,
    getStorageModeContract: () => STORAGE_MODE_CONTRACT,
    inspectModePublication,
    inspectServerModeAuthority,
    observeServerCanonicalFacts: input=>observeServerBackend(input),
    observeServerSourceClosure: input=>observeServerBackend(input,true),
    readServerObservation: input=>serverObservationAction('read',input),
    assertServerObservationCurrent: input=>serverObservationAction('current',input),
    releaseServerObservation: input=>serverObservationAction('release',input),
    getCurrentScope: async () => await resolveCurrentScope(true),
    getScopeMode: async scope => await readScopeMode(scope, true),
    // Core3 global changes verify all known scopes before retiring legacy overrides.
    // Other consumers preserve their legacy behavior. `getGlobalMode` reports the saved choice
    // (`set:false` means no governance, which is the pre-global behaviour).
    previewGlobalMode,
    pauseGlobalModeJob,
    getGlobalMode: async (force = true) => await readGlobalMode(force),
    setGlobalMode: async (mode, modeOptions = {}) => { requireOperationalMode(mode); return await withModeConfiguration(()=>persistGlobalMode(mode, modeOptions && typeof modeOptions === 'object' ? modeOptions : {})); },
    clearGlobalMode: async () => await withModeConfiguration(()=>clearGlobalMode()),
    listScopeModes: async (force = false) => {
      const registry = await loadScopeRegistry(force, false);
      return Object.values(registry.entries || {}).filter(row => !isRemovedScopeRow(row)).map(row => ({
        scopeId: String(row.scopeId || ''),
        scopeKey: String(row.scopeKey || ''),
        label: String(row.label || row.scopeId || ''),
        mode: normalizeMode(row.mode),
        ...modeLifecycle(normalizeMode(row.mode)),
        modeLabel: modeLabel(normalizeMode(row.mode)),
        origin: String(row.origin || ''),
        source: String(row.source || ''),
        global: isGlobalScopeId(row.scopeId),
        updatedAt: Number(row.updatedAt || 0) || 0
      }));
    },
    resolveScopeByAlias,
    createNativeBranchScopeCapability,
    getNativeBranchScopeCapabilityState,
    consumeNativeBranchScopeCapability,
    revokeNativeBranchScopeCapability,
    revalidateNativeBranchScopeCapability,
    openScopeView: openNativeBranchScopeView,
    getAtScope: explicitNativeBranchGet,
    setAtScope: explicitNativeBranchSet,
    removeAtScope: explicitNativeBranchRemove,
    keysAtScope: explicitNativeBranchKeys,
    inspectNativeBranchTargetLocalData,
    inspectNativeBranchRetiredLocalData,
    retireNativeBranchLocalTargetData,
    getScopeExecutionPolicy,
    getRecoveryState: async scope => await recoveryLockForScope(scope || await resolveCurrentScope(true)),
    setScopeMode: async (scope, mode, modeOptions = {}) => { requireOperationalMode(mode); return await withModeConfiguration(()=>scopedSetModeSafely(mode, { ...(modeOptions && typeof modeOptions === 'object' ? modeOptions : {}), scope })); },
    ensureHandoffReady: scopedEnsureHandoffReady,
    verifyNativeBranchSourceDurability,
    serverGet: scopedServerGet,
    serverGetMany: scopedServerGetMany,
    serverKeys: scopedServerKeys,
    serverIntegrity: scopedServerIntegrity,
    getDiagnostics,
    refreshDiagnostics,
    scheduleDiagnosticsRefresh,
    getCachedDiagnostics,
    decorateDebugExport,
    decorateDebugExportSync,
    managerPortable: async (action, body = {}) => {
      const allowed=['capabilities','export-start','upload-start','upload-chunk','upload-finish','download-chunk','status','cancel','restore-plan','restore-execute'];
      if(!allowed.includes(action))throw new Error('portable_action_not_supported');
      const connection=await managerConnection();
      if(connection.capabilities?.['portable-transfer.v1']!==true)throw new Error('portable_transfer_server_upgrade_required');
      return (await managerRequest('POST','/v1/manager/portable/'+action,body)).result;
    },
    managerControl: async (action, body = {}) => {
      const allowed=['status','backups','history','backup-create','backup-check','restore-plan','restore-execute'];
      if(!allowed.includes(action))throw new Error('control_action_not_supported');
      const connection=await managerConnection();
      if(connection.capabilities?.['manager-control.v1']!==true)throw new Error('manager_control_server_upgrade_required');
      return (await managerRequest(['status','backups','history'].includes(action)?'GET':'POST','/v1/manager/control/'+action,['status','backups','history'].includes(action)?null:body)).result;
    },
    managerGetDiagnostics,
    managerConnection,
    managerServerGet,
    managerServerGetMany,
    managerServerKeys,
    managerServerIntegrity,
    managerReplaceScopeIndex,
    managerListScopes,
    acceptServerReset,
    managerPlanReset: async namespaces => (await managerRequest('POST','/v1/manager/reset/plan',{namespaces})).result,
    managerExecuteReset: async body => (await managerRequest('POST','/v1/manager/reset/execute',body)).result,
    managerPlanScopeDeletion,
    managerExecuteScopeDeletion,
    managerSetScopePinned,
    dispose,
    openManagementDialog,
    registerManagementButton,
    status: () => ({
      ...state.status,
      serverBinding: serverBinding(),
      scope: state.scopeRouting.current ? { ...state.scopeRouting.current } : null,
      mode: state.config.mode,
      modeLabel: modeLabel(state.config.mode),
      ...modeLifecycle(state.config.mode), transition:storageTransition ? {...storageTransition} : null,
      storagePhase:storageTransition ? MODE_MIRROR : state.config.mode,
      lastLegacyImport: state.scopeRouting.lastLegacyImport,
      lastManagementResult: state.management.lastResult,
      migration: { plugin: { ...state.migration.plugin }, local: { ...state.migration.local } },
      syncJob: getSyncJob()
    })
  });
  scheduleManagementRegistration();
  if (startupDiagnosticsEnabled) {
    const startupDiagnosticsDelayMs = Math.max(1200, Math.min(15000, Number(options.startupDiagnosticsDelayMs || (3500 + (namespaceDelaySeed % 7) * 350)) || 3500));
    scheduleDiagnosticsRefresh(startupDiagnosticsDelayMs, { limit: 250 });
  }
  return bridge;

};
