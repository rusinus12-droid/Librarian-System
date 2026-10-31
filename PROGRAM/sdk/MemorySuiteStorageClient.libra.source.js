/* LIBRARIAN SYSTEM STORAGE SDK v1.8.35
 * Scope-routed durable storage client shared by Flashback, HAYAKU, LIBRA, LIA and RE:TRACE.
 * The server stores opaque values. Each plugin keeps ownership of its own data schema.
 */
const createMemorySuiteStorageBridge = (rawOptions = {}) => {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const localOnlyOwner = options.storagePolicy === 'local_only';
  const managerOnly = options.storagePolicy === 'manager_only';
  const managerOnlyError = () => Object.assign(new Error('MEMORY_SUITE_MANAGER_ONLY_POLICY'), {code:'MEMORY_SUITE_MANAGER_ONLY_POLICY'});
  const localOnlyError = () => Object.assign(new Error('MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY'), {code:'MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY'});
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
  let cleanupDialogController = null;
  let modeConfigurationBusy = false;
  let modeConfigurationFrozen = false;
  let deferredGlobalTerminalNotification = false;
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
    try { return await factory(); } finally {
      modeConfigurationFrozen = false;
      modeConfigurationBusy = false;
      if (deferredGlobalTerminalNotification) {
        deferredGlobalTerminalNotification = false;
        // Owner startup reads must follow both verified journal persistence and
        // release of the physical mode operation, including its outer owner gate.
        scheduleLifecycleTimeout(() => {
          if (state.syncJob.current?.kind === 'global_mode' && syncJobTerminal(state.syncJob.current.status)) notifySyncJob();
        }, 0);
      }
    }
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
  const autoMigratePlugin = !localOnlyOwner && !managerOnly && options.autoMigratePlugin !== false;
  const autoMigrateLocal = !localOnlyOwner && !managerOnly && options.autoMigrateLocal !== false;
  const migrationConcurrency = Math.max(1, Math.min(4, Number(options.migrationConcurrency || 2) || 2));
  const migrationRetryMs = Math.max(5000, Math.min(10 * 60 * 1000, Number(options.migrationRetryMs || 30000) || 30000));
  const currentScopeProvider = typeof options.currentScopeProvider === 'function' ? options.currentScopeProvider : null;
  const resolveKeyScopeProvider = typeof options.resolveKeyScope === 'function' ? options.resolveKeyScope : null;
  // Payload-bound owner keys must not fall back to the open scope on I/O failure.
  const strictPluginScopePrefixes = (Array.isArray(options.strictPluginScopePrefixes) ? options.strictPluginScopePrefixes : []).map(String).filter(Boolean);
  // Opt-in only: the plugin's resolver must be able to classify global/shared
  // keys and explicit scope-key records correctly when currentScope is null.
  const preResolveKeyScope = options.preResolveKeyScope === true;
  const scopeRoutingEnabled = !managerOnly && options.scopeRouting !== false;
  const startupDiagnosticsEnabled = !localOnlyOwner && !managerOnly && options.startupDiagnostics !== false;
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
    legacy: { plugin: options.pluginStorage || null, local: options.localStorage || null },
    management: { registered: false, registering: false, handle: null, timer: null, root: null, lastResult: null },
    syncJob: { current: null, promise: null, retryTimer: null, persistTimer: null, loaded: false, listeners: new Set(), dismissedJobId: '' },
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
    if (state.syncJob.current?.kind === 'global_mode' && syncJobTerminal(state.syncJob.current.status) && modeConfigurationBusy) {
      deferredGlobalTerminalNotification = true;
      return;
    }
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
    // A panel opened during the final journal write must wait for the same
    // durable completion event as subscribers registered before migration.
    if (!(state.syncJob.current?.kind === 'global_mode' && syncJobTerminal(state.syncJob.current.status) && modeConfigurationBusy)) {
      try { listener(cloneSyncJob(state.syncJob.current)); } catch (_) {}
    }
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
        if (parsed.dismissed === true) { state.syncJob.dismissedJobId = String(parsed.jobId || ''); }
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
  const assertDurableJobIdentity = async job => {
    await assertStoredDurableJobMetadata(job);
    if(job.kind==='global_mode' && await globalDigest(job.globalPlan)!==job.globalPlanDigest)throw durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
    for (const role of durableJobPinRoles(job)) if (role.required) {
      const expected=durableServerPinShape(job.serverPins?.[role.role],role.url);
      const actual=await captureDurableServerPin(role.url);
      if (jsonComparable(expected)!==jsonComparable(actual)) throw durableServerPinError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
    }
  };
  const assertDurableJobAdmission = async job => {
    if (job.resumeExpired === true) throw durableServerPinError('MEMORY_SUITE_JOB_RESUME_EXPIRED');
    await assertDurableJobIdentity(job);
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
    const mode = localOnlyOwner || managerOnly ? MODE_PLUGIN_ONLY : state.transientMode && VALID_MODES.has(state.transientMode) ? state.transientMode : normalizeMode(rawMode);
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
  // Reads are served during a backup; callers that wait on read maintenance keep their own UI.
  const MAINTENANCE_RETRY_LIMIT = 5, MAINTENANCE_RETRY_BASE_MS = 300, MAINTENANCE_RETRY_ROUTES = ['/v1/kv/set', '/v1/kv/remove', '/v1/kv/batch'];
  const requestImpl = async (method, route, body = null, requestOptions = {}) => {
    if (localOnlyOwner && !(method === 'GET' && (route.startsWith('/v1/kv/get?') || route.startsWith('/v1/kv/keys?') || route.startsWith('/v1/integrity?')))) throw localOnlyError();
    const connection = await bootstrap(requestOptions.forceBootstrap === true, requestOptions.allowPluginOnly === true);
    if (!connection) throw new Error('memory_suite_server_not_enabled');
    const bindingGeneration = requestOptions.bindingGeneration ?? dataBinding.generation;
    await assertConnectionCurrent(connection, bindingGeneration);
    const resetEpoch=Number(connection.resetEpochs?.[namespace]||0);
    const isManagerOperation = managerOnly || route.startsWith('/v1/manager/') || requestOptions.extraHeaders?.['X-Memory-Suite-Manager'] === 'retrace';
    if(resetEpoch && !isManagerOperation){
      const choice=await readResetChoice(connection);
      if(resetReloadRequired || choice?.epoch!==resetEpoch || choice?.url!==(connection.requestedUrl||connection.url)){
        throw new Error('서버 자료가 초기화 또는 복원되었습니다. 서버 연결 설정에서 서버 자료 사용 또는 로컬 기억 다시 업로드를 선택한 뒤 RisuAI를 새로고침하세요.');
      }
    }
    const requestScope = requestOptions.scope && typeof requestOptions.scope === 'object'
      ? requestOptions.scope
      : state.scopeRouting.current;
    let requestScopeId = String(requestOptions.scopeId || requestScope?.scopeId || '').trim();
    if ((!requestScopeId || !requestScopeId.startsWith('memory-suite:')) && state.scopeRouting.registry) {
      const alias = requestScopeId || requestScope?.scopeKey || requestScope?.chatId;
      if (alias) {
        const aliasRow = registryEntryByAlias(state.scopeRouting.registry, alias);
        if (aliasRow?.scopeId) requestScopeId = aliasRow.scopeId;
      }
    }
    if ((!requestScopeId || !requestScopeId.startsWith('memory-suite:')) && state.scopeRouting.current?.scopeId && (
      !requestScope?.scopeKey ||
      state.scopeRouting.current.scopeKey === requestScope?.scopeKey ||
      state.scopeRouting.current.chatId === requestScope?.chatId
    )) {
      requestScopeId = state.scopeRouting.current.scopeId;
    }
    const registeredMode = requestScopeId ? state.scopeRouting.registry?.entries?.[requestScopeId]?.mode : '';
    const transientMode = requestScopeId ? state.scopeRouting.transientModes.get(requestScopeId) : '';
    const globalStored = state.scopeRouting.registry ? liveGlobalRow(state.scopeRouting.registry) : null;
    const globalMode = globalStored?.mode ? normalizeMode(globalStored.mode) : '';
    const requestMode = normalizeMode(requestOptions.storageMode || transientMode || registeredMode || globalMode || state.config.mode || MODE_PLUGIN_ONLY);
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
      // A backup gates writes for a second or two and the server refuses before running
      // anything, so the identical write (same operationId and expectations) is retried.
      const maintenanceAttempt = Number(requestOptions.maintenanceAttempt || 0);
      if (error?.status === 503 && error?.payload?.error === 'server_maintenance_in_progress' && maintenanceAttempt < MAINTENANCE_RETRY_LIMIT
        && requestOptions.maintenanceRetry !== false && method === 'POST' && MAINTENANCE_RETRY_ROUTES.includes(route)) {
        await new Promise(resolve => setTimeout(resolve, MAINTENANCE_RETRY_BASE_MS * (maintenanceAttempt + 1)));
        return await requestImpl(method, route, body, { ...requestOptions, bindingGeneration, maintenanceAttempt: maintenanceAttempt + 1 });
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
    state.syncJob.dismissedJobId = '';
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
          <div class="mscx-actions"><button data-mscx-apply class="primary" type="button">설정 적용</button><button data-mscx-restore type="button">서버 → pluginStorage 복구</button><button data-mscx-delete class="danger" type="button">플러그인 스토리지 삭제</button></div>
          <div class="mscx-card mscx-job" data-mscx-job hidden><div class="mscx-job-head"><strong data-mscx-job-title>초기 서버 동기화</strong><span class="mscx-job-badge" data-mscx-job-badge>작업 중</span></div><div class="mscx-progress" data-mscx-progress><i></i></div><div><div class="mscx-job-phase" data-mscx-job-phase>작업 준비</div><div class="mscx-job-message" data-mscx-job-message></div></div><div class="mscx-job-stats"><div class="mscx-job-stat"><span>진행</span><b data-mscx-job-items>-</b></div><div class="mscx-job-stat"><span>처리 용량</span><b data-mscx-job-bytes>-</b></div><div class="mscx-job-stat"><span>전송·복구</span><b data-mscx-job-transfer>-</b></div><div class="mscx-job-stat"><span>경과 시간</span><b data-mscx-job-elapsed>-</b></div><div class="mscx-job-stat"><span>마지막 활동</span><b data-mscx-job-activity>-</b></div><div class="mscx-job-stat"><span>재시도 / 실패</span><b data-mscx-job-retry>-</b></div></div><div class="mscx-job-current" data-mscx-job-current>현재 작업을 준비하고 있습니다.</div><div class="mscx-actions" style="margin-top:6px;display:flex;gap:8px"><button data-mscx-job-retry class="primary" type="button" style="display:none">즉시 재시도</button><button data-mscx-job-cancel class="danger" type="button" style="display:none">작업 취소 · 원래 모드 복구</button></div><div class="mscx-note">이 화면을 닫아도 작업은 계속됩니다. 새로고침 후에는 저장된 작업 영수증을 읽고 이미 서버에 일치하는 항목을 다시 전송하지 않고 이어서 확인합니다.</div></div>
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
      const isPaused = job.status === 'paused';
      const isFailed = job.status === 'failed';
      const total = Math.max(0, Number(job.totalItems || 0) || 0);
      const processed = Math.max(0, Number(job.processedItems || 0) || 0);
      const percent = total > 0 ? Math.max(0, Math.min(100, processed / total * 100)) : 0;
      const progressNode = q('[data-mscx-progress]');
      if (progressNode) {
        progressNode.classList.toggle('indeterminate', !terminal && total <= 0);
        const bar = progressNode.querySelector('i'); if (bar && total > 0) bar.style.width = `${percent.toFixed(2)}%`; else if (bar && terminal) bar.style.width = job.status === 'completed' ? '100%' : '0%';
      }
      q('[data-mscx-job-title]').textContent = jobTitle(job);
      q('[data-mscx-job-badge]').textContent = job.status === 'completed' ? '완료' : (job.status === 'failed' ? '실패' : (job.status === 'paused' ? '일시 중지 · 대기' : (total > 0 ? `${percent.toFixed(1)}%` : '작업 중')));
      q('[data-mscx-job-phase]').textContent = phaseLabel(job.phase);
      q('[data-mscx-job-message]').textContent = job.message || (job.error ? job.error : '');
      q('[data-mscx-job-items]').textContent = total > 0 ? `${processed.toLocaleString()} / ${total.toLocaleString()}건` : `${processed.toLocaleString()}건 확인`;
      q('[data-mscx-job-bytes]').textContent = fmtBytes(job.processedBytes || 0);
      q('[data-mscx-job-transfer]').textContent = fmtBytes(job.transferredBytes || 0);
      const endAt = job.finishedAt || Date.now(); q('[data-mscx-job-elapsed]').textContent = fmtDuration(endAt - Number(job.startedAt || endAt));
      const activityAge = Math.max(0, Date.now() - Number(job.lastActivityAt || job.updatedAt || Date.now())); q('[data-mscx-job-activity]').textContent = activityAge < 1500 ? '방금 전' : `${fmtDuration(activityAge)} 전`;
      q('[data-mscx-job-retry]').textContent = `${Number(job.retryCount || 0)} / ${Number(job.failures || 0)}`;
      const currentBits = [job.currentAction, job.currentSpace ? `[${job.currentSpace}]` : '', job.currentKey].filter(Boolean); q('[data-mscx-job-current]').textContent = currentBits.join(' · ') || (terminal ? (job.status === 'completed' ? '모든 검증이 완료되었습니다.' : (job.error || '작업이 중단되었습니다.')) : '현재 작업을 준비하고 있습니다.');
      const retryBtn = q('button[data-mscx-job-retry]');
      const cancelBtn = q('button[data-mscx-job-cancel]');
      if (retryBtn) {
        retryBtn.style.display = isPaused ? 'inline-block' : 'none';
        retryBtn.onclick = async () => {
          retryBtn.disabled = true;
          setMessage('작업 재시도를 시작합니다…');
          try {
            await scopedResumePendingSyncJob();
            await refreshActionState();
          } catch (error) {
            setMessage(`재시도 시작 실패: ${error?.message || error}`, 'error');
            retryBtn.disabled = false;
          }
        };
      }
      if (cancelBtn) {
        const globalJob = job.kind === 'global_mode';
        cancelBtn.style.display = (isPaused || (isFailed && !globalJob)) ? 'inline-block' : 'none';
        cancelBtn.textContent = globalJob ? '취소 · 이전 경로 복구' : '작업 취소 · 원래 모드 복구';
        cancelBtn.onclick = async () => {
          cancelBtn.disabled = true;
          setMessage(globalJob ? '전체 이전을 멈추고 변경된 저장 경로를 복구합니다…' : '작업을 취소하고 원래 모드로 복구하고 있습니다…');
          try {
            const result = await scopedCancelSyncJob();
            await refreshActionState();
            if (globalJob) {
              setMessage(result?.rollbackComplete
                ? '전체 이전을 취소하고 변경된 저장 경로를 이전 설정으로 복구했습니다.'
                : result?.status === 'cancelled'
                  ? '효과가 발생하기 전에 전체 이전을 취소했습니다.'
                  : '취소 요청을 받았습니다. 현재 스코프 처리가 끝나면 저장 경로를 복구합니다.', 'good');
            } else {
              setMessage('이전 작업이 취소되었습니다. 기존 모드가 유지됩니다.', 'good');
            }
          } catch (error) {
            setMessage(`취소 실패: ${error?.message || error}`, 'error');
            cancelBtn.disabled = false;
          }
        };
      }
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
      const job = getSyncJob();
      const terminal = !job || syncJobTerminal(job.status);
      const isPaused = !!job && job.status === 'paused';
      const activeRunningJob = !!job && !terminal && !isPaused;
      const modeLabelNode = q('[data-mscx-mode-label]'); if (modeLabelNode) modeLabelNode.textContent = modeLabel(current.mode);
      q('[data-mscx-apply]').disabled = activeRunningJob;
      q('[data-mscx-restore]').disabled = activeRunningJob || current.mode !== MODE_SERVER_ONLY;
      q('[data-mscx-delete]').disabled = activeRunningJob || current.mode === MODE_PLUGIN_ONLY;
      modeInputs().forEach(input => {
        input.disabled = activeRunningJob;
        input.checked = input.value === (activeRunningJob ? (job.targetMode || current.mode) : current.mode);
      });
      updateModeSelectionStyles();
      const url = q('[data-mscx-url]');
      if (url) {
        url.disabled = activeRunningJob;
        if (typeof document === 'undefined' || document.activeElement !== url) {
          url.value = activeRunningJob ? (job.targetUrl || current.url) : current.url;
        }
      }
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

  // RisuAI API v3 returns a fresh remote proxy from every getLocalPluginStorage()
  // call. Reuse the first proxy per host API so storage identity fences compare
  // the same provider instead of failing on every real-host re-read.
  const localPluginStorageByApi = new WeakMap();
  const stableLocalPluginStorage = async api => {
    if (localPluginStorageByApi.has(api)) return localPluginStorageByApi.get(api);
    const store = await api.getLocalPluginStorage();
    if (localPluginStorageByApi.has(api)) return localPluginStorageByApi.get(api);
    if (store?.getItem && store?.setItem) localPluginStorageByApi.set(api, store);
    return store;
  };

  const rawDeviceStorage = async (readOptions = {}) => {
    if (state.legacy.local?.getItem && state.legacy.local?.setItem) return state.legacy.local;
    for (const api of apiCandidates()) {
      try {
        if (typeof api?.getLocalPluginStorage === 'function') {
          const store = await stableLocalPluginStorage(api);
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
      let primaryRaw=null;
      try {primaryRaw=plugin?await plugin.getItem(SCOPE_ROUTING_LOCAL_KEY):null;} catch (_) {return modePublicationView('unavailable');}
      const stores=(plugin&&(primaryRaw!=null&&primaryRaw!==''||!device))?[plugin]:[device].filter(Boolean);
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
      entries[scope.scopeId] = {
        ...scope,
        mode: normalizeMode(row.mode),
        updatedAt: Math.max(0, Number(row.updatedAt || 0) || 0),
        source: String(row.source || 'registry').slice(0, 100),
        ...(row.removed === true ? { removed: true } : {}),
        ...(typeof row.origin === 'string' ? { origin: row.origin.slice(0, 100) } : {}),
        ...(row.pendingTargetMode && VALID_MODES.has(row.pendingTargetMode) ? { pendingTargetMode: row.pendingTargetMode } : {}),
        ...(typeof row.globalMigrationJobId === 'string' ? { globalMigrationJobId: row.globalMigrationJobId.slice(0, 100) } : {}),
        ...(row.recoveryRequired ? { recoveryRequired: row.recoveryRequired } : {}),
        ...(typeof row.recoveryState === 'string' ? { recoveryState: row.recoveryState.slice(0, 50) } : {}),
        ...(typeof row.recoveryReason === 'string' ? { recoveryReason: row.recoveryReason.slice(0, 200) } : {})
      };
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
      // Success means the primary pluginStorage copy reads back exactly. The device
      // copy is an emergency backup and only decides success when pluginStorage is absent.
      let pluginSuccess = false, deviceSuccess = false;
      const pluginStore = rawPluginStorage();
      if (pluginStore?.setItem) {
        try {
          const result = await pluginStore.setItem(SCOPE_ROUTING_LOCAL_KEY, payload);
          if (result !== false) {
            const readback = await pluginStore.getItem?.(SCOPE_ROUTING_LOCAL_KEY);
            pluginSuccess = String(readback || '') === payload;
          }
        } catch (error) { reportStorageFailure('scope.routing.plugin.write', error); }
      }
      const deviceStore = await rawDeviceStorage().catch(() => null);
      if (deviceStore?.setItem) {
        try {
          const result = await deviceStore.setItem(SCOPE_ROUTING_LOCAL_KEY, payload);
          const readback = await deviceStore.getItem?.(SCOPE_ROUTING_LOCAL_KEY);
          deviceSuccess = result !== false && String(readback || '') === payload;
        } catch (error) { reportStorageFailure('scope.routing.device.write', error); }
      }
      const success = pluginStore?.setItem ? pluginSuccess : deviceSuccess;
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
      // The pluginStorage copy is the routing table. The device copy and the server
      // copy are emergency sources only: they are read when the plugin copy is lost,
      // and the recovered table is written back to the plugin copy.
      let pluginRaw = null, deviceRaw = null, serverRaw = null, source = 'plugin';
      const pluginStore = rawPluginStorage();
      try { pluginRaw = await pluginStore?.getItem?.(SCOPE_ROUTING_LOCAL_KEY); } catch (error) { reportStorageFailure('storage.scope.route.read.plugin', error); }
      if (!pluginRaw) {
        source = 'device';
        const deviceStore = await rawDeviceStorage().catch(() => null);
        try { deviceRaw = await deviceStore?.getItem?.(SCOPE_ROUTING_LOCAL_KEY); } catch (error) { reportStorageFailure('storage.scope.route.read.device', error); }
      }
      if (!pluginRaw && !deviceRaw && (tryServer || (!state.scopeRouting.serverRestoreAttempted && !!dataBinding?.url))) {
        source = 'server';
        state.scopeRouting.serverRestoreAttempted = true;
        try {
          const remote = await remoteGet('plugin', SCOPE_ROUTING_SERVER_KEY, { allowPluginOnly: true });
          if (remote.exists === true) serverRaw = remote.value;
        } catch (error) { reportStorageFailure('storage.scope.route.read.server', error); }
      }
      const registry = mergeScopeRegistries(pluginRaw || deviceRaw || serverRaw);
      if (!pluginRaw && (deviceRaw || serverRaw) && Object.keys(registry.entries || {}).length) scheduleScopeRegistryRestore(registry, source);
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

  // Writes a table recovered from an emergency copy back through the normal writer.
  // At most one restore runs at a time and a failed restore waits a minute.
  const scheduleScopeRegistryRestore = (registry, source) => {
    const routing = state.scopeRouting;
    if (routing.restoreInFlight || Date.now() - Number(routing.restoreAttemptAt || 0) < 60000) return;
    routing.restoreInFlight = true; routing.restoreAttemptAt = Date.now();
    setTimeout(() => {
      void writeScopeRegistryLocal(registry, { reason: source === 'server' ? 'routing_restored_server' : 'routing_restored_device' })
        .then(() => setStatus('scope_routes_restored', '', { source }))
        .catch(error => reportStorageFailure('storage.scope.route.restore.' + source, error))
        .finally(() => { routing.restoreInFlight = false; });
    }, 0);
  };

  const synchronizeScopeRegistryToServer = (...args) => withOwnerOperation({kind:'storage_operation',operation:'synchronizeScopeRegistryToServer'}, () => synchronizeScopeRegistryToServerImpl(...args));
  const synchronizeScopeRegistryToServerImpl = async (registryValue, syncOptions = {}) => {
    const registry = parseScopeRegistry(registryValue || await loadScopeRegistry());
    try {
      await remoteMutate('set', 'plugin', SCOPE_ROUTING_SERVER_KEY, registry, { allowPluginOnly: true });
      return true;
    } catch (error) {
      setStatus('scope_route_server_pending', error?.message || error);
      if(syncOptions.strict===true)throw error;
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

  // Discovery, ordinary reads and rollback must agree on removed/inherited rows.
  const registryScopeMode = (registry, scopeId, legacyMode = MODE_PLUGIN_ONLY) => {
    const row = registry.entries[scopeId];
    const stored = isRemovedScopeRow(row) ? null : row;
    if (stored && !['inherited','migrated'].includes(String(stored.origin || ''))) return normalizeMode(stored.mode);
    const global = liveGlobalRow(registry);
    if (global) return normalizeMode(global.mode);
    if (stored) return normalizeMode(stored.mode);
    return globalModeEnabled && !registry.legacyGlobalModeImported ? normalizeMode(legacyMode) : MODE_PLUGIN_ONLY;
  };
  const readScopeModeValue = async (scopeInput = null, force = false) => {
    const scope = normalizeScopeDescriptor(scopeInput || await resolveCurrentScope(force));
    if (localOnlyOwner) return { scope, mode: MODE_PLUGIN_ONLY, modeLabel: modeLabel(MODE_PLUGIN_ONLY), explicit: true, modeOrigin: 'owner_policy', storagePolicy: 'local_only', localOnly: true };
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
    let storedRow = registry.entries[scope.scopeId];
    if (!storedRow) {
      storedRow = registryEntryByAlias(registry, scope.scopeId)
        || (scope.scopeKey ? registryEntryByAlias(registry, scope.scopeKey) : null)
        || (scope.chatId ? registryEntryByAlias(registry, scope.chatId) : null);
    }
    if (!storedRow && state.scopeRouting.current?.scopeId && (
      state.scopeRouting.current.scopeKey === scope.scopeKey ||
      state.scopeRouting.current.chatId === scope.chatId
    )) {
      storedRow = registry.entries[state.scopeRouting.current.scopeId];
    }
    if (storedRow && !scope.scopeId.startsWith('memory-suite:') && storedRow.scopeId) {
      scope.scopeId = storedRow.scopeId;
    }
    const stored = isRemovedScopeRow(storedRow) ? null : storedRow;
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
    const fallbackMode = registryScopeMode(registry,scope.scopeId,globalModeEnabled && !registry.legacyGlobalModeImported ? await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY) : MODE_PLUGIN_ONLY);
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
  let globalMigrationPreview = null;
  const globalIssueMetadata = row => Object.fromEntries(['code','location','space','key','detail','manifestState']
    .filter(key=>row[key]!=null).map(key=>[key,row[key]]));
  const globalWarningMetadata = value => {
    const warnings=(Array.isArray(value?.warnings)?value.warnings:[])
      .filter(row=>row&&typeof row==='object'&&!Array.isArray(row)).slice(0,256).map(globalIssueMetadata);
    return {warnings,warningCount:Number.isSafeInteger(value?.warningCount)&&value.warningCount>=warnings.length?value.warningCount:warnings.length};
  };
  const globalWarningText = value => value?.warningCount > 0
    ? `경고 ${value.warningCount}건 · ${value.warnings?.some(row=>row.code==='flashback_global_vector_payload_absent')?'벡터가 없는 기억은 키워드로 검색됩니다.':'상세 진단을 확인해 주세요.'}` : '';
  let globalJobRunning = false;
  const globalRollbackPending = job => job?.kind === 'global_mode' && job.rollbackComplete !== true
    && (job.cancelRequested === true || job.phase === 'rollback_routes' || job.failedPhase === 'rollback_routes' || String(job.error||'').startsWith('MEMORY_SUITE_GLOBAL_ROLLBACK_'));
  const globalLocalCancellationNeeded = job => job?.kind==='global_mode'&&!syncJobTerminal(job.status)
    && (job.localCancellationIntent || ['MEMORY_SUITE_JOB_SERVER_PIN_CHANGED','MEMORY_SUITE_DATA_INSTANCE_CHANGED'].includes(String(job.errorDetails?.cause||job.error||'')));
  const globalResumeLabel = job => globalLocalCancellationNeeded(job)&&!job.localCancellationIntent?'기기 원본 확인 후 취소':globalRollbackPending(job)?'취소 복구 계속':'중단한 이전 재개';
  const globalRollbackView = job => {
    if(job?.kind!=='global_mode'||!globalRollbackPending(job)&&job.rollbackComplete!==true)return null;
    const progress=job.rollbackProgress||{},total=Math.max(0,Number(progress.totalScopes||Number(job.discoveredScopes||0)+1));
    const checked=Math.min(total,Math.max(0,Number(progress.checkedScopes||0))),verified=Math.min(total,Math.max(0,Number(progress.verifiedScopes||0)));
    const complete=job.rollbackComplete===true,active=job.status==='running'&&job.phase==='rollback_routes';
    const stage={prepare_routes:'원래 저장 경로 확인',write_routes:'기기의 저장 경로 복구',publish_routes:'원래 서버 응답·적용 확인',verify_routes:'복구한 저장 경로 검증',complete:'저장 경로 복구 완료'}[progress.stage]||'복구 준비';
    const started=Number(job.attemptStartedAt||0),now=Date.now(),end=Number(job.attemptFinishedAt||(active?now:job.updatedAt)||now);
    const elapsed=Math.max(0,Math.floor((end-started)/1000)),idle=Math.max(0,Math.floor((now-Number(job.lastActivityAt||now))/1000));
    return {active,complete,checked,verified,total,stage,percent:complete?100:total?Math.min(99,Math.round((checked+verified)/(2*total)*100)):0,
      title:complete?'취소 복구 완료':active?'취소 복구 실행 중':'취소 복구 중단 · 조치 필요',
      phase:complete?stage:active?`복구 중 · ${stage}`:`조치 대기 · ${stage}에서 중단`,
      count:complete?'저장 경로 복구 완료 · 이전 설정으로 돌아왔습니다.':`경로 확인: ${checked.toLocaleString()} / ${total.toLocaleString()} · 복구 검증: ${verified.toLocaleString()} / ${total.toLocaleString()}`,
      time:!started?'이번 복구 시간: 기록 없음':complete?`복구 소요: ${elapsed}초`:active?`이번 복구: ${elapsed}초 · 마지막 진행 ${idle}초 전`:`이번 복구 시도: ${elapsed}초 · 중단됨`};
  };
  const focusSyncJobPanel = container => {
    const card=container?.querySelector?.('[data-job]');
    if(!card){container?.scrollIntoView?.({behavior:'smooth',block:'nearest'});return false;}
    const button=container.querySelector('button[data-job-retry]');
    const actions=container.querySelector('[data-job-stalled-actions]');
    const target=button&&!button.disabled&&actions?.style.display!=='none'?button:card;
    if(target===card)card.tabIndex=-1;
    target.scrollIntoView?.({behavior:'smooth',block:'nearest'});target.focus?.();
    return true;
  };
  const globalModeError = (code, details) => Object.assign(new Error(code), {code, ...(details ? {details} : {})});
  const globalCanonical = value => JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
  const globalDigest = async value => {
    const text=globalCanonical(value);
    if(typeof text !== 'string' || typeof globalThis.crypto?.subtle?.digest !== 'function') throw globalModeError('MEMORY_SUITE_GLOBAL_FINGERPRINT_UNAVAILABLE');
    const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  };
  const globalValueDifferenceMetadata = (expected,actual) => {
    const object=value=>value!==null&&typeof value==='object';
    const decode=value=>{if(typeof value==='string'){try{return JSON.parse(value);}catch(_){return null;}}return value;};
    const left=decode(expected),right=decode(actual);
    if(!object(left)||!object(right))return {};
    const jsonEquivalent=globalCanonical(left)===globalCanonical(right);
    if(Array.isArray(left)||Array.isArray(right))return {jsonEquivalent};
    const different=[...new Set([...Object.keys(left),...Object.keys(right)])].sort()
      .filter(key=>globalCanonical(left[key])!==globalCanonical(right[key]));
    // Known structural field names only. Values and arbitrary user-authored
    // dictionary keys must never appear in the exported diagnostics.
    const fields=new Set(('schema version pluginVersion scopeKey storageHash characterId chatId personaId characterName chatTitle personaName '
      +'chatMessageCount chatFingerprint chatTailHash createdAt updatedAt count shardCount shardSize shardIndexVersion shardSummaries nextId stats '
      +'responseTurnMax responseTurnCount copiedFromScopeKey copiedFromChatId copiedFromChatTitle copiedAt copyAdoptedCompleteAt copyAdoptedComplete '
      +'copyAdoptionMode externalRetirementVersion externalRetiredAt externalRetiredRecords externalRetiredByType episodeSourceDigest episodeIndexedAt '
      +'episodeCount episodeChildCount turnWorldlineLiveHash turnWorldlineRevision archiveRef archiveOwner archiveId archiveGeneration archiveDigest '
      +'vectorStorageMode vectorStorageBackend vectorSidecarCount vectorSidecarBytes vectorSidecarMissing commitId records memories entries text summary vector vectors metadata').split(' '));
    return {jsonEquivalent,differingTopLevelFieldCount:different.length,
      differingTopLevelFields:different.filter(key=>fields.has(key)).slice(0,32)};
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
  // Global inventory may discover device storage before an owner wraps it.
  // Copy and restore the exact audited adapters, including retained local vectors.
  const globalLegacyStore = space => globalMigrationContext?.stores?.[space] || state.legacy[space];
  const globalPayloadRecord = row => ['scope','shared'].includes(row.classification) && row.artifact !== true;
  const inspectLocalCancellation = async job => {
    if(!job?.globalPlan?.registry?.entries||!Array.isArray(job.globalPlan.scopes)||!Array.isArray(job.globalPlan.sources))throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_PLAN_INVALID');
    await assertStoredDurableJobMetadata(job);
    if(await globalDigest(job.globalPlan)!==job.globalPlanDigest)throw durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
    const legacyMode=job.globalPlan.legacyMode??await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY);
    const original=job.globalPlan.registry;
    const globalMode=normalizeMode(liveGlobalRow(original)?.mode||MODE_PLUGIN_ONLY);
    if(globalMode!==MODE_PLUGIN_ONLY)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED',{reason:'original_global_mode',scopeId:GLOBAL_SCOPE_ID,mode:globalMode});
    const remoteScope=[...job.globalPlan.scopes.map(scope=>scope.scopeId),...Object.keys(original.entries).filter(id=>id!==GLOBAL_SCOPE_ID)]
      .find(id=>registryScopeMode(original,id,legacyMode)!==MODE_PLUGIN_ONLY);
    if(remoteScope)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED',{
      reason:'original_scope_mode',scopeId:remoteScope,mode:registryScopeMode(original,remoteScope,legacyMode),origin:String(original.entries[remoteScope]?.origin||'')
    });
    const stores={plugin:rawPluginStorage()},keysBySpace=new Map(),verified=[],verifiedLocalKeys=new Set();
    for(const source of job.globalPlan.sources){
      const parts=String(source.identity||'').split('\u0000');
      const [location,space,key]=parts;
      if(parts.length!==3||!key||!['plugin','local'].includes(space)||!['server',space==='plugin'?'plugin':'device'].includes(location))throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED',{
        reason:'source_location_unverified',location,space,key
      });
      // Old plans can retain server witnesses even when the saved routing says
      // every original scope was local. Accept only an exact physical local
      // counterpart; never discard that witness or assume its payload exists.
      const remoteOwnerKey=chunkOwnerKey(key);
      const localKey=location!=='server'?key:remoteOwnerKey
        ?scopedRemoteKeyInfo(remoteOwnerKey).logicalKey+key.slice(remoteOwnerKey.length):scopedRemoteKeyInfo(key).logicalKey;
      const artifactOwnerKey=chunkOwnerKey(localKey),decoded=scopedRemoteKeyInfo(artifactOwnerKey||localKey);
      if(!matchesRoute(space,artifactOwnerKey||localKey)&&!matchesRoute(space,decoded.logicalKey))throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_UNVERIFIED',{space,key});
      if(!stores[space])stores[space]=await rawDeviceStorage({strict:true});
      const store=stores[space];
      if(!keysBySpace.has(space)){
        const keys=await store?.keys?.();
        if(!Array.isArray(keys)||keys.some(value=>typeof value!=='string')||new Set(keys).size!==keys.length)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_UNVERIFIED',{space});
        keysBySpace.set(space,new Set(keys));
      }
      const remoteWitnessError=localStatus=>globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED',{
        reason:'server_source_witness',location,space,key,localKey,localStatus
      });
      if(!keysBySpace.get(space).has(localKey))throw location==='server'?remoteWitnessError('missing'):globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_MISSING',{space,key});
      let value;try{value=JSON.parse(globalExactJson(await store.getItem(localKey)));}catch(_){throw location==='server'?remoteWitnessError('unreadable'):globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_UNVERIFIED',{space,key});}
      if(await globalDigest([false,value])!==source.fingerprint)throw location==='server'?remoteWitnessError('different'):globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_CHANGED',{space,key});
      verified.push([source.identity,source.fingerprint]);
      verifiedLocalKeys.add(JSON.stringify([space,localKey]));
    }
    const sourceFingerprint=await globalDigest([job.jobId,job.globalPlanDigest,verified]);
    const resetPreferenceRaw=await stores.plugin.getItem(resetChoiceKey)??null;
    return {sourceFingerprint,resetPreferenceRaw,localSourceRecords:verifiedLocalKeys.size,
      fingerprint:await globalDigest([sourceFingerprint,resetPreferenceRaw])};
  };
  const assertLocalCancellationIntent = async job => {
    const proof=await inspectLocalCancellation(job),intent=job.localCancellationIntent;
    if(!intent||intent.sourceFingerprint!==proof.sourceFingerprint
      ||globalCanonical(proof.resetPreferenceRaw)!==globalCanonical(intent.resetPreferenceRaw)&&proof.resetPreferenceRaw!==null)
      throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_CHANGED');
    return proof;
  };
  const previewLocalCancellation = async () => {
    await loadPersistedSyncJob();const job=getSyncJob();
    if(!globalLocalCancellationNeeded(job))throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REVIEW_REQUIRED');
    const proof=await inspectLocalCancellation(job);
    return {schema:'memory-suite.local-cancellation-preview.v1',jobId:job.jobId,fingerprint:proof.fingerprint,
      discoveredScopes:job.globalPlan.scopes.length,localSourceRecords:proof.localSourceRecords,
      workflow:{kind:'local_cancel',targetMode:MODE_PLUGIN_ONLY,localSourceRecords:proof.localSourceRecords}};
  };
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
          const listing=await remoteKeys(space,'',{allowPluginOnly:true,strictInventory:true,inventoryRequest,storageMode:inventoryOptions.serverManagement?MODE_SERVER_ONLY:undefined});
          const metadata=new Map(listing.records.map(row=>[String(row.key),row]));
          const all=[...listing.keys,...listing.tombstones];
          for(let offset=0;offset<all.length;offset+=512){
            const keys=all.slice(offset,offset+512),batch=await remoteGetMany(space,keys,{allowPluginOnly:true,strictInventory:true,inventoryRequest,storageMode:inventoryOptions.serverManagement?MODE_SERVER_ONLY:undefined});
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
      }catch(error){
        if(inventoryOptions.allowServerOffline===true||inventoryOptions.localManagement===true){
          // Server offline during local management must not block local scope operations
        }else{
          blockers.push({code:String(error.code || error.message || 'remote_inventory_unavailable')});
        }
      }
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
      return registryScopeMode(sourceRegistry,scope.scopeId,legacyMode);
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
      if(!inventoryOptions.serverManagement&&lacksLocal&&globalRecordScopeIds(row).some(id=>scoped.find(scope=>scope.scopeId===id)?.sourceMode===MODE_PLUGIN_ONLY))
        blockers.push({code:'remote_source_route_unverified',space:row.space,key:row.logicalKey,scopeId:row.scopeId});
    }
    const catalog={hostScopes,scopes:scopes.map(scope=>[scope.scopeId,scope.scopeKey,scope.characterId,scope.chatId,scope.aliases]),
      keys:[...new Set(safeRecords.filter(row=>row.classification!=='control').map(row=>globalCanonical([row.space,row.logicalKey,row.classification,row.scopeId,row.dependencyScopeIds])))].sort()};
    const catalogFingerprint=await digestInventory(catalog);
    return {schema:'memory-suite.global-inventory.v1',namespace,targetUrl,targetMode:target,scopes:scoped,records:safeRecords,registry,registryCopies,hostScopes,legacyMode,
      stores,remoteRequired,serverManagement:inventoryOptions.serverManagement===true,serverPin,catalogFingerprint,inventoryFingerprint:await digestInventory([catalogFingerprint,safeRecords.filter(row=>row.classification!=='control').map(row=>[globalRecordIdentity(row),row.fingerprint,row.revision,row.digest])]),
      blockers,...globalWarningMetadata(owner),completeKnownScopes:owner.completeKnownScopes===true&&blockers.length===0};
  };
  const globalWorkflowSummary = (inventory, job = state.syncJob.current) => {
    const remoteTarget=inventory.targetMode!==MODE_PLUGIN_ONLY;
    const existing=inventory.records.filter(row=>globalPayloadRecord(row)&&!row.deleted&&(remoteTarget?row.location==='server':row.location!=='server'));
    const existingScopes=new Set(existing.filter(row=>row.classification==='scope').flatMap(globalRecordScopeIds));
    const pending=job?.kind==='global_mode'&&!syncJobTerminal(job.status)&&job.targetMode===inventory.targetMode&&job.targetUrl===inventory.targetUrl;
    const newCheckRequired=pending&&['MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED','MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'].includes(job.error);
    return {kind:!inventory.completeKnownScopes?'inspection':pending?globalRollbackPending(job)?'rollback':newCheckRequired?'reuse':'resume':existing.length?'reuse':'initial',newCheckRequired,
      targetMode:inventory.targetMode,totalScopes:inventory.scopes.length,existingDestinationScopes:existingScopes.size,
      existingDestinationItems:existing.length,previousVerifiedScopes:pending?Number(job.verifiedScopes||0):0};
  };
  const globalJobWorkflow = job => {
    if(job.rollbackComplete===true)return {kind:'rollback_complete',targetMode:job.targetMode};
    if(globalRollbackPending(job))return {...job.workflow,kind:'rollback',targetMode:job.targetMode};
    if(job.status==='paused'&&['MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED','MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'].includes(job.error))return {...job.workflow,kind:'resume',checkRequired:true,targetMode:job.targetMode,totalScopes:Number(job.discoveredScopes||0),previousVerifiedScopes:Number(job.verifiedScopes||0)};
    if(job.status==='paused')return {...job.workflow,kind:'resume',targetMode:job.targetMode,totalScopes:Number(job.discoveredScopes||0),previousVerifiedScopes:Number(job.verifiedScopes||0)};
    if(job.workflow)return job.workflow;
    return {kind:'resume',targetMode:job.targetMode,totalScopes:Number(job.discoveredScopes||0),previousVerifiedScopes:Number(job.verifiedScopes||0)};
  };
  const globalWorkflowView = workflow => {
    const destination=workflow.targetMode===MODE_PLUGIN_ONLY?'기기':'서버';
    if(workflow.kind==='local_cancel')return {title:'새 서버를 보존하고 이전 취소',approve:'기기 경로 복구로 취소',
      detail:`이전 시작 때의 기기 원본 ${Number(workflow.localSourceRecords||0).toLocaleString()}개가 그대로 남아 있는지 확인했습니다. 원래 기기 저장 경로로 돌아가며, 복원된 현재 서버의 기억과 저장 경로는 변경하지 않습니다. 기존 서버 초기화 이후 선택은 해제합니다.`};
    if(workflow.kind==='rollback_complete')return {title:'이전 취소 · 저장 경로 복구 완료',approve:'복구 완료',detail:'이전 저장 위치로 복구했습니다. 서버 사본은 그대로 보존했습니다.'};
    if(workflow.kind==='rollback')return {title:'이전 취소 · 저장 경로 복구',approve:'저장 경로 복구 계속',
      detail:'원래 저장 위치로 복구하는 작업입니다. 서버 사본은 보존됩니다. 서버 이전은 경로 복구가 끝난 뒤 다시 적용할 수 있습니다.'};
    if(workflow.kind==='resume')return {title:'중단된 이전 재개',approve:'중단한 이전 재개',
      detail:`${workflow.checkRequired?'재개 전에 자료와 대화 목록을 다시 확인합니다. 변경이 있으면 추가 확인창이 열립니다. ':''}이전에 확인한 대화 ${Number(workflow.previousVerifiedScopes||0).toLocaleString()} / ${Number(workflow.totalScopes||0).toLocaleString()}개의 기록을 이어서 사용합니다. 완료 항목도 다시 조회하며, 일치하는 자료는 재전송하지 않습니다.`};
    if(workflow.kind==='reuse')return {title:`기존 ${destination} 자료 확인 후 이전`,approve:'기존 자료 확인 후 계속',
      detail:`${workflow.newCheckRequired?'자료가 변경되어 기존 미완료 작업을 새 검사로 다시 확인합니다. ':''}${workflow.existingDestinationItems?`${destination}에 기존 자료가 있습니다.`:`${destination}에 보존된 자료를 다시 확인합니다.`}${workflow.existingDestinationScopes?` 자료가 발견된 대화 ${Number(workflow.existingDestinationScopes).toLocaleString()}개.`:''} 전체 대화 검증은 다시 시작하지만, 일치하는 자료는 재전송하지 않고 없는 항목만 옮깁니다. 다른 내용은 보존하고 충돌을 알립니다.`};
    if(workflow.kind==='inspection')return {title:'이전 자료 확인 필요',approve:'자료 확인 후 계속',detail:'기존 자료를 모두 확인한 뒤 이전 방법을 안내합니다.'};
    return {title:`처음 ${destination} 이전`,approve:'처음 이전 시작',detail:`${destination}에서 이 플러그인의 기존 자료가 발견되지 않았습니다. 전체 대화를 확인하며 자료를 옮깁니다.`};
  };
  const globalInventorySummary = inventory => ({schema:inventory.schema,namespace,targetUrl:inventory.targetUrl,targetMode:inventory.targetMode,completeKnownScopes:inventory.completeKnownScopes,
    discoveredScopes:inventory.scopes.length,legacyOverrides:inventory.scopes.filter(scope=>{const row=inventory.registry.entries[scope.scopeId];return row&&!['inherited','migrated'].includes(String(row.origin||''));}).length,
    directions:Object.fromEntries([MODE_PLUGIN_ONLY,MODE_SERVER_ONLY,MODE_MIRROR].map(mode=>[mode,inventory.scopes.filter(scope=>scope.sourceMode===mode).length])),
    workflow:globalWorkflowSummary(inventory),blockers:inventory.blockers,...globalWarningMetadata(inventory),catalogFingerprint:inventory.catalogFingerprint,inventoryFingerprint:inventory.inventoryFingerprint});
  const syncJobActionGuidance = (error, details, job) => {
    const errCode = String(error || '').trim();
    const rawDetails = typeof details === 'string' ? details : (details?.preview || JSON.stringify(details || ''));
    const jobRaw = job ? JSON.stringify(job) : '';
    const hasResetBlocker = rawDetails.includes('서버 자료가 초기화 또는 복원되었습니다')
      || rawDetails.includes('server_reset_epoch_mismatch')
      || jobRaw.includes('서버 자료가 초기화 또는 복원되었습니다');

    if(job?.kind==='global_mode'&&!syncJobTerminal(job.status)&&(errCode||hasResetBlocker)){
      const label=globalResumeLabel(job),next=`진행 화면의 [${label}]를 누르세요.`;
      const finish=blockerReason=>({blockerReason,actionRequired:next,remedySteps:['1. 상세 진단과 연결 상태에서 원인 확인',`2. ${next}`]});
      if(errCode==='MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED')return {
        blockerReason:details?.reason==='original_global_mode'?'이전 시작 당시 전역 설정이 서버를 사용하는 모드였습니다.'
          :details?.reason==='original_scope_mode'?`이전 시작 당시 서버를 사용하던 대화가 있습니다: ${details.scopeId}`
          :details?.reason==='server_source_witness'?`예전 원본 목록에 서버 저장 키가 있습니다: ${details.key}`
          :'원래 저장 모드 또는 원본 목록에 서버 자료가 포함되어 있어 기기만으로 취소할 수 없습니다.',
        actionRequired:'상세 진단의 reason·scopeId·저장 키로 원래 저장 모드와 서버 원본을 확인해야 합니다. 기기 원본이 없다는 뜻은 아니며, 작업 기록과 현재 서버는 보존됩니다.',
        remedySteps:['1. 상세 진단에서 reason·scopeId·저장 키 확인','2. 원래 서버 자료와 복원된 현재 서버 자료의 일치 여부 확인']};
      if(errCode.startsWith('MEMORY_SUITE_LOCAL_CANCEL_'))return {
        blockerReason:'기기 원본만으로 이전 취소를 완료할 수 있는지 확인하지 못했습니다.',
        actionRequired:'상세 진단의 부족하거나 변경된 저장 키를 확인해 원래 기기 기억을 복구해야 합니다. 작업 기록과 현재 서버는 보존됩니다.',
        remedySteps:['1. 상세 진단의 오류와 저장 키 확인','2. 원래 기기 기억 또는 원래 서버 DATA에서 부족한 원본 복구']};
      if(globalLocalCancellationNeeded(job))return {
        blockerReason:'서버 복원·초기화 또는 DATA 교체로 이전 작업의 서버 식별 정보가 달라졌습니다.',
        actionRequired:`진행 화면의 [${label}]에서 기기 원본을 검증하고 취소 방법을 확인하세요. 현재 서버는 변경하지 않습니다.`,
        remedySteps:[`1. 진행 화면의 [${label}] 선택`,'2. 기기 원본 검증 결과와 현재 서버 보존 안내 확인']};
      if([errCode,details?.cause].some(code=>['server_maintenance_in_progress','maintenance_in_progress','MEMORY_SUITE_SERVER_MAINTENANCE'].includes(code)))return {
        blockerReason:'서버가 백업·복원·업데이트 작업으로 잠겨 있어 작업을 잠시 중단했습니다.',
        actionRequired:`서버 또는 RE:TRACE의 진행 중인 작업이 끝난 뒤 ${next} 진행 기록과 기억 원본은 유지됩니다. ${globalRollbackPending(job)?'원래 저장 경로 복구가 끝나면 취소가 완료됩니다.':'대화 검증이 모두 끝났어도 최종 서버 확인과 전체 설정 적용이 남아 있을 수 있습니다.'}`,
        remedySteps:['1. 서버 또는 RE:TRACE에서 백업·복원·업데이트 작업 상태 확인',`2. 해당 작업 완료 후 ${next}`]};
      if(globalRollbackPending(job)||errCode.startsWith('MEMORY_SUITE_GLOBAL_ROLLBACK_'))return {
        blockerReason:'이전 취소 후 저장 경로 복구가 아직 완료되지 않았습니다.',
        actionRequired:`이전을 시작했던 서버가 실행 중인지 확인한 뒤 ${next} 기억 원본과 서버 사본은 보존됩니다.`,
        remedySteps:['1. 이전을 시작했던 서버의 실행 상태와 주소 확인',`2. ${next}`]
      };
      if(hasResetBlocker)return {blockerReason:'서버 초기화 또는 복원이 감지되어 자료 사용 방법을 먼저 선택해야 합니다.',
        actionRequired:`고급 작업에서 서버 자료 사용 또는 로컬 기억 업로드를 선택하고 새로고침한 뒤 ${next}`,
        remedySteps:['1. 고급 작업의 서버 초기화·복원 이후 선택에서 자료 사용 방법 선택','2. RisuAI 새로고침',`3. ${next}`]};
      if(['MEMORY_SUITE_GLOBAL_SOURCE_CHANGED','MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'].includes(errCode))return {
        blockerReason:'자료와 대화 목록을 다시 확인해야 합니다.',actionRequired:`${next} 추가 확인창이 나오면 내용을 확인해 승인하면 됩니다.`,
        remedySteps:[`1. ${next}`,'2. 재검사 결과 확인 및 승인 · 기존에 일치하는 자료는 재전송하지 않음']};
      if(['MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED','MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'].includes(errCode))return {
        blockerReason:details?.reason==='destination_tombstone'?'이전 대상에 삭제 기록이 있어 원본 복사를 중단했습니다.'
          :details?.reason==='destination_value_mismatch'?'이전 대상의 값이 원본과 달라 검증을 중단했습니다.'
          :details?.reason==='destination_missing'?'이전 대상에서 원본과 같은 저장 항목을 확인하지 못했습니다.'
          :'이전 대상의 저장 항목을 검증하지 못했습니다.',
        actionRequired:'상세 진단의 space·key·reason과 원본·대상의 지문을 확인해야 합니다. 현재 대화의 원본과 대상 사본은 보존되며, 값 차이나 삭제 기록을 자동으로 덮어쓰지 않습니다.',
        remedySteps:['1. 상세 진단에서 저장 공간·키·검증 실패 이유 확인','2. 원본과 대상의 차이를 확인한 뒤 자료 선택 또는 복구 방법 결정']};
      if(['MEMORY_SUITE_SERVER_UNAVAILABLE','MEMORY_SUITE_SERVER_NOT_FOUND'].includes(errCode))return {
        blockerReason:'이전을 시작했던 서버에 연결할 수 없습니다.',actionRequired:`서버를 실행하고 연결 테스트를 통과한 뒤 ${next}`,
        remedySteps:['1. 원래 서버 실행 및 주소 확인','2. 연결 테스트',`3. ${next}`]};
      if(errCode==='MEMORY_SUITE_JOB_SERVER_PIN_CHANGED')return {
        blockerReason:'작업에 기록된 서버와 현재 서버가 일치하지 않습니다.',actionRequired:`이전을 시작했던 서버 주소와 DATA를 확인한 뒤 ${next}`,
        remedySteps:['1. 작업을 시작했던 원래 서버 주소와 DATA 확인',`2. ${next}`]};
      return finish(`작업을 계속하기 전에 오류 원인을 확인해야 합니다: ${errCode}`);
    }
    if (errCode === 'MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED' || hasResetBlocker) {
      if (hasResetBlocker) {
        return {
          blockerReason: '서버 자료 복원 또는 초기화가 감지되어 데이터 덮어쓰기 방지 잠금이 활성화되었습니다.',
          actionRequired: '고급 작업 메뉴에서 [서버 자료 사용] 또는 [로컬 기억 다시 업로드]를 선택한 뒤 브라우저를 새로고침(F5)하고 재개하세요.',
          remedySteps: [
            '1. 로컬 Librarian 서버가 켜져 있는지 확인',
            '2. 플러그인 설정 > [고급 작업] 메뉴 열기',
            '3. [서버 자료 사용 · 로컬 업로드 안 함] (권장) 또는 [초기화 후 로컬 기억 다시 업로드] 클릭',
            '4. RisuAI 브라우저 창 새로고침 (F5)',
            '5. 다시 [고급 작업] > [미완료 전체 이전 재개] 클릭'
          ]
        };
      }
      return {
        blockerReason: '전체 대화 목록 또는 스코프 인벤토리의 변경이 감지되어 재검색이 필요합니다.',
        actionRequired: '서버 연결 상태를 확인하고 설정을 다시 적용하거나 브라우저를 새로고침한 뒤 재개하세요.',
        remedySteps: [
          '1. [연결 테스트] 버튼으로 서버 정상 응답 확인',
          '2. RisuAI 새로고침(F5) 후 재개 시도'
        ]
      };
    }
    if (errCode === 'MEMORY_SUITE_SERVER_UNAVAILABLE' || errCode === 'MEMORY_SUITE_SERVER_NOT_FOUND') {
      return {
        blockerReason: 'Librarian System 서버에 연결할 수 없습니다.',
        actionRequired: 'PROGRAM/1_서버_실행.bat을 실행하여 로컬 서버를 켜고 포트(47630) 연결을 확인하세요.',
        remedySteps: [
          '1. PROGRAM/1_서버_실행.bat 실행',
          '2. [연결 테스트] 버튼으로 연결 확인',
          '3. 작업 재시도'
        ]
      };
    }
    if (errCode === 'MEMORY_SUITE_JOB_SERVER_PIN_CHANGED') {
      return {
        blockerReason: '이전을 시작했던 서버 주소와 현재 설정된 서버 주소가 다릅니다.',
        actionRequired: '작업 시작 시 사용한 원래 서버 주소를 입력하거나 작업을 취소 후 다시 시작하세요.',
        remedySteps: [
          '1. 원래 서버 주소(URL) 확인 및 입력',
          '2. 필요 시 [이전 작업 취소] 후 새 서버 주소로 다시 시작'
        ]
      };
    }
    if (errCode === 'MEMORY_SUITE_GLOBAL_SOURCE_CHANGED') {
      return {
        blockerReason: '이전 준비 중 로컬 대화 기록에 변경사항이 발생했습니다.',
        actionRequired: 'RisuAI를 새로고침하고 전체 이전 설정을 다시 적용하세요.',
        remedySteps: [
          '1. 브라우저 새로고침(F5)',
          '2. 서버 모드 설정 다시 적용'
        ]
      };
    }
    if (errCode.startsWith('MEMORY_SUITE_GLOBAL_ROLLBACK_')) {
      return {
        blockerReason: '취소 중 이전 저장 경로 복구 검증에 실패했습니다.',
        actionRequired: '원본 데이터는 안전하게 보존되어 있습니다. [고급 작업] > [전체 이전 관리] > [이전 작업 취소 · 기존 경로 복구]를 다시 클릭하거나 브라우저 새로고침(F5) 후 재시도하세요.',
        remedySteps: [
          '1. [상세 진단 복사]로 오류 상세 정보 확인',
          '2. RisuAI 브라우저 새로고침(F5)',
          '3. [고급 작업] > [전체 이전 관리] > [이전 작업 취소 · 기존 경로 복구] 다시 클릭'
        ]
      };
    }
    if (errCode) {
      return {
        blockerReason: `작업 중 오류 발생: ${errCode}`,
        actionRequired: '상세 진단을 복사하여 확인하거나 필요 시 작업을 일시 중지 후 재시도하세요.',
        remedySteps: [
          '1. [상세 진단 복사] 버튼을 눌러 로그 확인',
          '2. 브라우저 새로고침(F5) 후 재시도'
        ]
      };
    }
    return null;
  };
  const syncJobDiagnostics = job => {
    if (!job) return null;
    const result=job.result&&typeof job.result==='object'?job.result:{};
    const guidance = syncJobActionGuidance(job.error, job.errorDetails, job);
    const rollback=globalRollbackView(job);
    // Export operation evidence, never the admitted source inventory or server pins.
    return cloneSyncJob({schema:'memory-suite.scope-sync-diagnostics.v1',namespace,pluginVersion,
      jobId:job.jobId,kind:job.kind,status:job.status,phase:job.phase,failedPhase:job.failedPhase||'',
      requestedMode:job.requestedMode||job.targetMode||'',effectiveMode:job.effectiveMode||job.sourceMode||'',
      currentScopeId:job.currentScopeId||job.scopeId||'',currentSpace:job.currentSpace||'',currentKey:job.currentKey||'',currentAction:job.currentAction||'',
      ...(job.kind==='global_mode'?{workflow:globalJobWorkflow(job)}:{}),
      discoveredScopes:job.discoveredScopes,verifiedScopes:job.verifiedScopes,startedAt:job.startedAt,updatedAt:job.updatedAt,lastActivityAt:job.lastActivityAt,
      ...(rollback?{attemptStartedAt:job.attemptStartedAt||0,attemptFinishedAt:job.attemptFinishedAt||0,rollbackProgress:job.rollbackProgress||null,
        recoveryState:rollback.complete?'complete':rollback.active?'running':'action_required',waitingForUser:!rollback.active&&!rollback.complete}:{}),
      ...(job.rollbackPublication?{rollbackPublication:job.rollbackPublication}:{}),
      ...(job.serverWait?{serverWait:job.serverWait,
        ...(job.serverWait.active&&job.status==='running'?{recoveryState:'waiting_server',waitingForUser:false}
          :job.error==='MEMORY_SUITE_SERVER_MAINTENANCE'?{recoveryState:'action_required',waitingForUser:true}:{})}:{}),
      error:job.error||'',details:job.errorDetails||null,
      ...(guidance ? {
        blockerReason: guidance.blockerReason,
        actionRequired: guidance.actionRequired,
        remedySteps: guidance.remedySteps
      } : {}),
      recoveryRequired:job.recoveryRequired===true,
      failures:job.failureDetails||result.failures||[],validation:job.validation||result.validation||null,
      metrics:job.metrics||result.metrics||{},currentProgress:job.currentProgress||null,result});
  };
  const withMigrationPreview = value => ({ ...value,
    ...(globalMigrationPreview ? { migrationPreview:cloneDiagnosticValue(globalMigrationPreview) } : {}),
    ...(state.syncJob.current ? {syncJob:syncJobDiagnostics(state.syncJob.current)} : {}) });
  const rememberGlobalPreview = summary => {
    // Keep the last read-only result available to ordinary debug exports even
    // when plugin_only skips a server probe. Never retain inventory payloads.
    globalMigrationPreview = cloneDiagnosticValue({
      schema:'memory-suite.migration-preview-diagnostics.v1',generatedAt:Date.now(),namespace,pluginVersion,
      targetMode:summary.targetMode,completeKnownScopes:summary.completeKnownScopes,discoveredScopes:summary.discoveredScopes,workflow:summary.workflow,
      blockers:summary.blockers.map(globalIssueMetadata),...globalWarningMetadata(summary)
    });
    return summary;
  };
  const previewGlobalMode = async (mode,previewOptions={}) => {
    const target=requireOperationalMode(mode);
    if(!globalModeEnabled)throw globalModeError('MEMORY_SUITE_GLOBAL_OWNER_UNSUPPORTED');
    await loadPersistedSyncJob();
    const url=await configuredServerUrlNow(),targetUrl=normalizeServerUrl(previewOptions.url||url);
    if(targetUrl!==url){const old=await collectGlobalInventory(MODE_PLUGIN_ONLY);
      if(!old.completeKnownScopes)return rememberGlobalPreview(globalInventorySummary(old));
      if(old.scopes.some(scope=>scope.sourceMode!==MODE_PLUGIN_ONLY))return rememberGlobalPreview({...globalInventorySummary(old),completeKnownScopes:false,blockers:[{code:'MEMORY_SUITE_SERVER_URL_IN_USE'}]});}
    const first=await collectGlobalInventory(target,{url:targetUrl});
    if(first.completeKnownScopes){const second=await collectGlobalInventory(target,{url:targetUrl});
      if(!second.completeKnownScopes||first.catalogFingerprint!==second.catalogFingerprint||first.inventoryFingerprint!==second.inventoryFingerprint
        ||globalCanonical(first.registryCopies)!==globalCanonical(second.registryCopies)){first.completeKnownScopes=false;first.blockers.push({code:'inventory_changed_during_preview'});}}
    return rememberGlobalPreview(globalInventorySummary(first));
  };
  const globalSaveJob = async patch => {
    state.syncJob.current={...state.syncJob.current,...patch,updatedAt:Date.now(),lastActivityAt:Date.now()};
    state.syncJob.loaded=true;
    const terminal=syncJobTerminal(state.syncJob.current.status);
    if(!terminal)notifySyncJob();
    if(!await persistSyncJobNow())throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');
    if(terminal)notifySyncJob();
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
        const actual=Object.hasOwn(destination,'logicalValue')?destination.logicalValue:destination.value;
        const expectedFingerprint=await globalDigest([row.deleted,projected]),actualFingerprint=await globalDigest([destination.deleted,actual]);
        if(row.deleted!==destination.deleted||expectedFingerprint!==actualFingerprint)
          throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT',{
            scopeId:scope.scopeId,space:row.space,key:row.logicalKey,...(!sourceRemote?{remoteKey:route.remoteKey}:{}),targetMode:inventory.targetMode,sourceLocation:row.location,
            reason:destination.deleted&&!row.deleted?'destination_tombstone':'destination_value_mismatch',repairable:false,sourceMode:scope.sourceMode,
            actualExists:!destination.deleted,actualTombstone:destination.deleted,actualRevision:Number(destination.revision||0),
            expectedValueType:Array.isArray(projected)?'array':projected===null?'null':typeof projected,
            actualValueType:destination.deleted?'absent':Array.isArray(actual)?'array':actual===null?'null':typeof actual,
            expectedFingerprint,actualFingerprint,...globalValueDifferenceMetadata(projected,actual)
          });
      }
    }
  };
  const readGlobalDestination = async (space,key,job) => {
    const maxRetries=5,originalAction=state.syncJob.current?.currentAction,originalMessage=state.syncJob.current?.message;
    let waited=false;
    try{
      for(let attempt=0;;attempt++){
        try{
          if(waited){await bootstrap(true,true);await assertDurableJobAdmission(job);}
          return await remoteGet(space,key,{allowPluginOnly:true});
        }catch(error){
          if(!job||error?.status!==503||error?.payload?.error!=='server_maintenance_in_progress')throw error;
          if(lifecycle.disposed||state.syncJob.current?.jobId!==job.jobId)throw connectionStaleError();
          if(state.syncJob.current.pauseRequested||state.syncJob.current.cancelRequested)throw globalModeError('MEMORY_SUITE_GLOBAL_WAIT_INTERRUPTED');
          if(attempt===maxRetries)throw globalModeError('MEMORY_SUITE_SERVER_MAINTENANCE',{
            reason:'server_maintenance_in_progress',space,key,readOnly:true,retries:attempt,maxRetries
          });
          waited=true;
          const delay=(attempt+1)*500;
          const now=Date.now();
          // The durable final-verify checkpoint already exists. Keep transient
          // waits in memory so delayed timer writes cannot replace completion.
          Object.assign(state.syncJob.current,{serverWait:{reason:'maintenance',active:true,retry:attempt+1,maxRetries,nextRetryAt:now+delay},
            currentSpace:space,currentKey:key,currentAction:`서버 점검 종료 대기 · ${attempt+1} / ${maxRetries}`,
            message:'서버의 백업·복원·업데이트 작업 종료를 잠시 기다리고 있습니다. 대화 검증 기록은 유지됩니다.',updatedAt:now,lastActivityAt:now});
          notifySyncJob();
          // Only this exact read is retried. No writes or whole-job replay;
          // restored/replaced DATA must pass the original admission again.
          await new Promise(resolve=>setTimeout(resolve,delay));
          if(lifecycle.disposed||state.syncJob.current?.jobId!==job.jobId)throw connectionStaleError();
          if(state.syncJob.current.pauseRequested||state.syncJob.current.cancelRequested)throw globalModeError('MEMORY_SUITE_GLOBAL_WAIT_INTERRUPTED');
        }
      }
    }finally{
      if(waited&&state.syncJob.current?.jobId===job.jobId){
        Object.assign(state.syncJob.current,{serverWait:{...state.syncJob.current.serverWait,active:false,nextRetryAt:0},currentAction:originalAction,message:originalMessage});
        notifySyncJob();
      }
    }
  };
  const verifyGlobalScopeDestination = async (inventory,scope,target,verifyOptions={}) => {
    let verified=0,copiedMissingRecords=0,notifiedAt=0;
    const rows=inventory.records.filter(row=>globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(scope.scopeId)
      &&(scope.sourceMode===MODE_SERVER_ONLY?row.location==='server':row.location!=='server'));
    for(const row of rows){
      if(verifyOptions.job){
        const now=Date.now();Object.assign(state.syncJob.current,{currentSpace:row.space,currentKey:row.logicalKey,currentAction:target===MODE_SERVER_ONLY?'서버 저장 항목 재조회·검증':'기기 저장 항목 재조회·검증',updatedAt:now,lastActivityAt:now});
        // Large plans are cloned for listeners; keep readback progress visible
        // without cloning the full journal for every record.
        if(now-notifiedAt>=200){notifiedAt=now;notifySyncJob();}
      }
      const route=await globalRouteForRecord(row,scope);
      if(target===MODE_SERVER_ONLY){
        let remote=await readGlobalDestination(row.space,route.remoteKey,verifyOptions.job);
        const logical=Object.hasOwn(row,'logicalValue')?row.logicalValue:row.value;
        const expected=row.location==='server'?logical:await routeProjectValue(route,logical);
        const job=verifyOptions.job;
        const source=job?.globalPlan?.sources?.find(source=>source.identity===globalRecordIdentity(row));
        const originalMode=job?registryScopeMode(job.globalPlan.registry,scope.scopeId,job.globalPlan.legacyMode??MODE_PLUGIN_ONLY):scope.sourceMode;
        // A route/checkpoint can survive an interrupted copy or a partial logical
        // restore. It proves routing progress, never the presence of each value.
        // Fill only an absent slot from an unchanged admitted physical source.
        // A server tombstone or a different value always remains a conflict.
        const canFill=!!job&&job.targetMode===target&&originalMode!==MODE_SERVER_ONLY&&row.location!=='server'
          &&!row.deleted&&source?.fingerprint===row.fingerprint;
        if(canFill&&remote.exists===false&&remote.tombstone===false&&remote.revision===0){
          await assertDurableJobAdmission(job);
          let value;try{value=JSON.parse(globalExactJson(await inventory.stores[row.space]?.getItem(row.key)));}
          catch(_){throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{space:row.space,key:row.logicalKey,reason:'source_readback_unavailable'});}
          if(await globalDigest([false,value])!==source.fingerprint)throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{space:row.space,key:row.logicalKey});
          Object.assign(state.syncJob.current,{currentSpace:row.space,currentKey:row.logicalKey,currentAction:'누락된 서버 항목 복사·검증'});notifySyncJob();
          await remoteMutate('set',row.space,route.remoteKey,expected,{allowPluginOnly:true,expectedRevision:0});
          await assertDurableJobAdmission(job);
          remote=await readGlobalDestination(row.space,route.remoteKey,job);copiedMissingRecords++;
        }
        if(row.deleted?remote.tombstone!==true:remote.exists!==true||globalCanonical(remote.value)!==globalCanonical(expected))throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED',{
          scopeId:scope.scopeId,space:row.space,key:row.logicalKey,remoteKey:route.remoteKey,targetMode:target,sourceLocation:row.location,
          reason:remote.tombstone===true&&!row.deleted?'destination_tombstone':remote.exists!==true&&!row.deleted?'destination_missing':'destination_value_mismatch',
          repairable:false,sourceMode:originalMode,currentMode:route.mode,actualExists:remote.exists===true,actualTombstone:remote.tombstone===true,
          actualRevision:Number(remote.revision||0),expectedValueType:Array.isArray(expected)?'array':expected===null?'null':typeof expected,
          actualValueType:remote.exists!==true?'absent':Array.isArray(remote.value)?'array':remote.value===null?'null':typeof remote.value,
          expectedFingerprint:await globalDigest([row.deleted,expected]),actualFingerprint:await globalDigest([remote.tombstone===true,remote.exists===true?remote.value:null]),
          ...(remote.exists===true?globalValueDifferenceMetadata(expected,remote.value):{})
        });
      }else{
        const store=inventory.stores[row.space],value=await legacyRead(store,row.logicalKey);
        if(row.deleted?!isNullishStorageValue(value):globalCanonical(await routeProjectValue(route,value))!==globalCanonical(Object.hasOwn(row,'logicalValue')?row.logicalValue:row.value))throw globalModeError('MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED',{
          scopeId:scope.scopeId,space:row.space,key:row.logicalKey,targetMode:target,sourceLocation:row.location,
          reason:!row.deleted&&isNullishStorageValue(value)?'destination_missing':'destination_value_mismatch',repairable:false
        });
      }
      verified++;
    }
    return {scopeId:scope.scopeId,verifiedRecords:verified,...(copiedMissingRecords?{copiedMissingRecords}:{})};
  };
  const runGlobalModeJob = async (job,initialInventory=null) => {
    if(globalJobRunning)throw transitionBusyError();
    globalJobRunning=true;
    try{
      // The outer mode-configuration gate owns admission through final publication.
      do{await Promise.allSettled([...ownerIOWork]);if(typeof whenFlashbackWritersIdle==='function')await whenFlashbackWritersIdle();await Promise.allSettled([...mutationTails.values()]);}
      while(ownerIOWork.size||mutationTails.size);
      modeConfigurationFrozen=true;
      if(globalRollbackPending(job))return await rollbackGlobalModeRoutes(job);
      // Admitted writers may have completed during drain; never reuse the prepare snapshot.
      let inventory=await collectGlobalInventory(job.targetMode,{url:job.targetUrl});
      if(await configuredServerUrlNow()!==job.targetUrl){
        if(await configuredServerUrlNow()!==job.globalPlan.previousUrl)throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
        await assertDurableJobAdmission(job);
        const old=await collectGlobalInventory(MODE_PLUGIN_ONLY);
        if(!old.completeKnownScopes||old.scopes.some(scope=>scope.sourceMode!==MODE_PLUGIN_ONLY))throw globalModeError('MEMORY_SUITE_SERVER_URL_IN_USE');
        if(old.inventoryFingerprint!==job.globalPlan.previousInventoryFingerprint)throw globalModeError('MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');
        if(state.syncJob.current.pauseRequested)return state.syncJob.current.cancelRequested===true
          ?await rollbackGlobalModeRoutes(job):await globalSaveJob({status:'cancelled',phase:'cancelled_before_effects'});
        await assertGlobalPlanCurrent(job,inventory,true);
        globalMigrationContext=inventory;await globalPreflightDestinations({...inventory,scopes:job.globalPlan.scopes});globalMigrationContext=null;
        await globalSaveJob({phase:'configure_url',effectsStarted:true});
        await persistServerUrl(job.targetUrl);
        inventory=await collectGlobalInventory(job.targetMode);
      }
      await assertGlobalPlanCurrent(job,inventory);
      globalMigrationContext=inventory;
      await globalPreflightDestinations({...inventory,scopes:job.globalPlan.scopes});
      const firstPass=job.status==='queued'&&job.phase==='prepared';
      const workflow={...globalWorkflowSummary(inventory,firstPass?null:job),...(!firstPass?{kind:'resume',newCheckRequired:false}:job.workflow?.newCheckRequired?{kind:'reuse',newCheckRequired:true}:{})};
      await globalSaveJob({status:'running',phase:'copy_verify',workflow,error:'',failedPhase:'',errorDetails:null,failureDetails:[],failures:0,result:null,metrics:null,serverWait:null,
        message:globalWorkflowView(workflow).title+' · 대화별 자료를 검증하고 있습니다.'});
      for(const scope of job.globalPlan.scopes){
        if(state.syncJob.current.pauseRequested){
          if(state.syncJob.current.cancelRequested===true)return await rollbackGlobalModeRoutes(job);
          const touched=Object.keys(state.syncJob.current.checkpoints||{}).length>0||state.syncJob.current.effectsStarted;
          return await globalSaveJob({status:touched?'paused':'cancelled',phase:touched?'paused_resumable':'cancelled_before_effects',message:touched?'미완료 · 원본과 현재 경로를 보존했습니다. 이어서 진행할 수 있습니다.':'효과 발생 전에 취소했습니다.'});
        }
        await assertDurableJobAdmission(job);
        await globalSaveJob({currentScopeId:scope.scopeId,currentKey:'',currentAction:'대화 자료 확인',currentProgress:null,effectsStarted:true});
        const sameMode=scope.sourceMode===job.targetMode;
        const actual=(await readScopeMode(scope,true)).mode;
        const completed=actual===job.targetMode&&inventory.registry.entries[scope.scopeId]?.globalMigrationJobId===job.jobId;
        const hasRecords=inventory.records.some(row=>globalPayloadRecord(row)&&globalRecordScopeIds(row).includes(scope.scopeId));
        const hasLiveScopeRecords=inventory.records.some(row=>row.classification==='scope'&&!row.deleted&&row.scopeId===scope.scopeId&&(scope.sourceMode===MODE_SERVER_ONLY?row.location==='server':row.location!=='server'));
        if(!sameMode&&!completed&&hasRecords){
          await scopedSetModeSafely(job.targetMode,{scope,source:'global_allchat_transition',origin:'transition_pending',recordExplicit:false,
            globalMigrationJobId:job.jobId,allowEmptyRestore:!hasLiveScopeRecords,assertServerPins:()=>assertDurableJobAdmission(job),
            onProgress:progress=>{state.syncJob.current={...state.syncJob.current,currentSpace:progress.space,currentKey:progress.currentKey||'',currentAction:progress.currentAction||'',
              currentProgress:Object.fromEntries(['phase','space','totalItems','processedItems','processedBytes','transferredBytes','uploaded','restored','matched','dryRun','failureCount','conflictCount'].filter(key=>progress[key]!=null).map(key=>[key,progress[key]]))};notifySyncJob();}});
        }
        const evidence=await verifyGlobalScopeDestination(inventory,scope,job.targetMode,{job});
        if(sameMode||completed||!hasRecords)await persistScopedMode(job.targetMode,scope,{origin:'transition_pending',source:'global_allchat_verified',globalMigrationJobId:job.jobId});
        await globalSaveJob({checkpoints:{...state.syncJob.current.checkpoints,[scope.scopeId]:evidence},verifiedScopes:Object.keys({...state.syncJob.current.checkpoints,[scope.scopeId]:evidence}).length});
      }
      if(state.syncJob.current.pauseRequested){if(state.syncJob.current.cancelRequested===true)return await rollbackGlobalModeRoutes(job);return await globalSaveJob({status:'paused',phase:'paused_resumable',message:'미완료 · 검증된 경로와 원본을 보존했습니다. 전체 적용은 재개 후 완료합니다.'});}
      await globalSaveJob({phase:'final_verify',currentAction:'최종 저장 상태 재검증 준비',message:'대화별 검증 완료 · 최종 저장 상태 재검증과 전체 설정 적용을 진행하고 있습니다.'});
      inventory=await collectGlobalInventory(job.targetMode);
      await assertGlobalPlanCurrent(job,inventory);
      globalMigrationContext=inventory;
      for(const scope of job.globalPlan.scopes)await verifyGlobalScopeDestination(inventory,scope,job.targetMode,{job});
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
      for(const store of [inventory.stores.plugin||inventory.stores.local].filter(Boolean)){
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
      for(const store of [inventory.stores.plugin||inventory.stores.local].filter(Boolean)){
        if(String(await store.getItem(SCOPE_ROUTING_LOCAL_KEY))!==JSON.stringify(saved))throw globalModeError('MEMORY_SUITE_GLOBAL_REGISTRY_READBACK_FAILED');
      }
      if(inventory.remoteRequired){
        if(!await synchronizeScopeRegistryToServer(saved))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_PENDING');
        const remote=await remoteGet('plugin',SCOPE_ROUTING_SERVER_KEY,{allowPluginOnly:true});
        if(remote.exists!==true||globalCanonical(parseScopeRegistry(remote.value))!==globalCanonical(parseScopeRegistry(saved)))throw globalModeError('MEMORY_SUITE_GLOBAL_PUBLICATION_READBACK_FAILED');
      }
      const result={scope:globalScopeDescriptor(),mode:job.targetMode,effectiveMode:job.targetMode,requestedMode:job.targetMode,modeLabel:modeLabel(job.targetMode),
        completeKnownScopes:true,discoveredScopes:job.globalPlan.scopes.length,verifiedScopes:job.globalPlan.scopes.length,migrated:job.globalPlan.scopes.map(scope=>scope.scopeId),failed:[],
        ...globalWarningMetadata(job.globalPlan.warnings?job.globalPlan:inventory),registry:saved};
      await globalSaveJob({status:'completed',phase:'completed',effectiveMode:job.targetMode,result,finishedAt:Date.now(),message:'전체 대화 이전과 전역 설정 적용이 완료되었습니다.'});
      state.config={...state.config,mode:job.targetMode,at:Date.now()};state.scopeRouting.routeCache.clear();
      return result;
    }catch(error){
      if(error.code==='MEMORY_SUITE_GLOBAL_WAIT_INTERRUPTED'&&state.syncJob.current?.pauseRequested&&!state.syncJob.current?.cancelRequested){
        return await globalSaveJob({status:'paused',phase:'paused_resumable',error:'',errorDetails:null,currentAction:'사용자 요청으로 중단·보존',message:'요청에 따라 이전을 멈췄습니다. 대화 검증 기록과 원본은 유지되며 이어서 진행할 수 있습니다.'});
      }
      if(state.syncJob.current?.cancelRequested===true&&state.syncJob.current?.phase!=='rollback_routes'){
        try{return await rollbackGlobalModeRoutes(job);}catch(rollbackError){error=rollbackError;}
      }
      const errCode = String(error.code || error.message);
      const guidance = syncJobActionGuidance(errCode, error.details, state.syncJob.current);
      const failureMsg = guidance
        ? `미완료 · ${guidance.blockerReason} [대처] ${guidance.actionRequired}`
        : '미완료 · 원본과 실제 경로를 보존했습니다. 문제를 확인한 뒤 이어서 진행하세요.';
      try{await globalSaveJob({status:'paused',phase:state.syncJob.current?.phase==='commit_pending'?'commit_pending':'recovery_pending',error:errCode,
        ...(globalRollbackPending(state.syncJob.current)?{attemptFinishedAt:Date.now()}:{}),
        failedPhase:state.syncJob.current?.phase||'',errorDetails:compactRestoreEvidence(error.details||null),
        actionRequired:guidance?.actionRequired||null,blockerReason:guidance?.blockerReason||null,remedySteps:guidance?.remedySteps||null,
        result:compactRestoreEvidence(error.result||null),failureDetails:compactRestoreEvidence(error.result?.failures||[]),
        metrics:compactRestoreEvidence(error.metrics||error.result?.metrics||null),validation:compactRestoreEvidence(error.validation||error.result?.validation||null),
        recoveryRequired:!!error.recoveryLock,failures:Math.max(1,Number(error.result?.failures?.length||0)),
        message:failureMsg});}catch(_){}
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
      if(globalRollbackPending(pending))return await runGlobalModeJob(state.syncJob.current);
      await assertDurableJobAdmission(pending);
      if(operationOptions.refreshInventory===true&&operationOptions.previewFingerprint
        &&['MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED','MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'].includes(pending.error))superseded=pending;
      else {await globalSaveJob({pauseRequested:false,cancelRequested:false});return await runGlobalModeJob(state.syncJob.current);}
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
    const globalPlan={schema:'memory-suite.global-mode-plan.v1',namespace,targetMode:target,scopes:inventory.scopes,...globalWarningMetadata(inventory),
      registry:inventory.registry,registryCopies:inventory.registryCopies,legacyMode:inventory.legacyMode,catalogFingerprint:inventory.catalogFingerprint,
      inventoryFingerprint:inventory.inventoryFingerprint,sources:globalSourceWitness(inventory),remoteRequired:inventory.remoteRequired,
      previousUrl:previousInventory?url:null,previousInventoryFingerprint:previousInventory?.inventoryFingerprint||null,
      supersedesJobId:superseded?.jobId||null};
    if(superseded){const key=SYNC_JOB_STORAGE_KEY+':superseded:'+superseded.jobId;
      if(!await legacyWriteVerified(state.legacy.plugin,key,JSON.stringify(superseded)))throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');}
    state.syncJob.dismissedJobId = '';
    state.syncJob.current={schema:SYNC_JOB_SCHEMA,namespace,pluginId,pluginVersion,jobId,id:jobId,kind:'global_mode',scopeId:GLOBAL_SCOPE_ID,
      sourceMode:inventory.remoteRequired?MODE_SERVER_ONLY:MODE_PLUGIN_ONLY,sourceUrl:targetUrl,targetMode:target,targetUrl,requestedMode:target,
      effectiveMode:normalizeMode(liveGlobalRow(inventory.registry)?.mode||MODE_PLUGIN_ONLY),serverPins:{source:inventory.serverPin,target:target!==MODE_PLUGIN_ONLY?inventory.serverPin:null},
      globalPlan,globalPlanDigest:await globalDigest(globalPlan),workflow:{...globalWorkflowSummary(inventory,null),...(superseded?{kind:'reuse',newCheckRequired:true}:{})},checkpoints:{},verifiedScopes:0,discoveredScopes:inventory.scopes.length,
      status:'queued',phase:'prepared',startedAt:now,updatedAt:now,lastActivityAt:now,pauseRequested:false,cancelRequested:false,effectsStarted:false};
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
  const rollbackGlobalModeRoutes = async job => {
    if(!job?.globalPlan?.registry?.entries||!Array.isArray(job.globalPlan.scopes))throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_PLAN_INVALID');
    await assertStoredDurableJobMetadata(job);
    if(await globalDigest(job.globalPlan)!==job.globalPlanDigest)throw durableServerPinError('MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');
    const localOnly=!!job.localCancellationIntent;
    if(localOnly)await assertLocalCancellationIntent(job);
    const rollbackScopes=[...job.globalPlan.scopes,globalScopeDescriptor()];
    let progress={stage:'prepare_routes',checkedScopes:0,restoredScopes:0,verifiedScopes:0,totalScopes:rollbackScopes.length};
    await globalSaveJob({status:'running',phase:'rollback_routes',attemptStartedAt:Date.now(),attemptFinishedAt:0,
      rollbackProgress:progress,currentScopeId:'',currentSpace:'plugin',currentKey:'',currentAction:'원래 저장 경로 확인',currentProgress:null,
      error:'',failedPhase:'',errorDetails:null,failures:0,failureDetails:[],result:null,metrics:null,validation:null,
      message:'취소 복구 실행 중 · 원래 저장 경로를 확인하고 있습니다.'});
    let notifiedAt=Date.now();
    const reportProgress=async (patch,scopeId='')=>{
      progress={...progress,...patch};
      const now=Date.now();
      // Scanning edits only the in-memory registry. The original immutable plan
      // can replay it after a crash; progress is not a durable per-route commit.
      Object.assign(state.syncJob.current,{rollbackProgress:progress,currentScopeId:scopeId,updatedAt:now,lastActivityAt:now});
      if(now-notifiedAt>=100||progress.checkedScopes===progress.totalScopes&&progress.stage==='prepare_routes'
        ||progress.verifiedScopes===progress.totalScopes){
        notifiedAt=now;notifySyncJob();
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    };
    const registry=parseScopeRegistry(await loadScopeRegistry(true,false));
    const originalEntries=job.globalPlan.registry.entries;
    let restored=0;
    // Final publication may already have changed the global entry before a
    // server/readback failure. Restore it along with the individual routes.
    for(const scope of rollbackScopes.slice().reverse()){
      const current=registry.entries[scope.scopeId]||null,original=originalEntries[scope.scopeId]||null;
      if((current?.globalMigrationJobId===job.jobId&&current.mode===job.targetMode)||(current?.removed===true&&current?.source==='global_allchat_cancel_rollback')){
        const restoredRow=original?structuredClone(original):{...current,removed:true,source:'global_allchat_cancel_rollback'};
        restoredRow.updatedAt=Math.max(Date.now(),Number(current.updatedAt||0)+1);
        registry.entries[scope.scopeId]=restoredRow;
        restored++;
      }else if(original?current?.mode!==original.mode||current?.origin!==original.origin:!!current&&current.removed!==true){
        throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_ROUTE_CONFLICT',{scopeId:scope.scopeId});
      }
      await reportProgress({checkedScopes:progress.checkedScopes+1,restoredScopes:restored},scope.scopeId);
    }
    registry.legacyGlobalModeImported=registry.legacyGlobalModeImported||job.globalPlan.registry.legacyGlobalModeImported===true;
    if(localOnly)await assertLocalCancellationIntent(job);
    progress={...progress,stage:'write_routes'};
    await globalSaveJob({rollbackProgress:progress,currentScopeId:'',currentAction:'기기의 저장 경로 복구',message:'취소 복구 실행 중 · 기기의 저장 경로를 복구하고 있습니다.'});
    const saved=await writeScopeRegistryLocal(registry);
    if(globalCanonical(parseScopeRegistry(saved).entries)!==globalCanonical(parseScopeRegistry(registry).entries))throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_READBACK_FAILED');
    if(job.globalPlan.remoteRequired&&!localOnly){
      try{
        progress={...progress,stage:'publish_routes'};
        await globalSaveJob({rollbackProgress:progress,currentAction:'원래 서버 연결 및 저장 경로 적용 확인',message:'취소 복구 실행 중 · 원래 서버의 응답과 저장 경로 적용을 확인하고 있습니다.'});
        // Recovery is an explicit retry: do not reuse a startup/offline failure.
        // Rebind to a fresh response and verify the admitted server before writes.
        // Transfer admission can expire, but restoring the original routes must
        // remain possible. Keep plan and physical DATA checks without renewing it.
        await bootstrap(true,true);
        await assertDurableJobIdentity(job);
        await synchronizeScopeRegistryToServer(saved,{strict:true});
      }
      catch(error){throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING',{cause:String(error.code||error.message||error)});}
      const remote=await remoteGet('plugin',SCOPE_ROUTING_SERVER_KEY,{allowPluginOnly:true});
      if(remote.exists!==true||globalCanonical(parseScopeRegistry(remote.value))!==globalCanonical(parseScopeRegistry(saved)))throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_READBACK_FAILED');
    }
    if(localOnly){
      const proof=await assertLocalCancellationIntent(job);
      if(proof.resetPreferenceRaw!==null&&!await legacyRemoveVerified(rawPluginStorage(),resetChoiceKey))throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_RESET_PREFERENCE_FAILED');
      resetChoice=null;resetReloadRequired=false;
      for(const scope of rollbackScopes)state.scopeRouting.transientModes.delete(scope.scopeId);
      await globalSaveJob({rollbackPublication:{status:'skipped_changed_server',reason:'local_sources_verified',localSourceRecords:proof.localSourceRecords},
        currentAction:'기기 원본 검증 완료 · 현재 서버 보존',message:'기기 원본을 검증했습니다. 복원된 현재 서버는 변경하지 않고 이전을 취소하고 있습니다.'});
    }
    progress={...progress,stage:'verify_routes'};
    await globalSaveJob({rollbackProgress:progress,currentAction:'복구한 저장 경로 검증',message:'취소 복구 실행 중 · 복구한 저장 경로를 검증하고 있습니다.'});
    state.scopeRouting.routeCache.clear();
    const previousGlobalMode=normalizeMode(liveGlobalRow(job.globalPlan.registry)?.mode||job.effectiveMode||MODE_PLUGIN_ONLY);
    state.config={...state.config,at:0,mode:previousGlobalMode};
    if((await readScopeMode(globalScopeDescriptor(),true)).mode!==previousGlobalMode)throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_READBACK_FAILED',{scopeId:GLOBAL_SCOPE_ID});
    await reportProgress({verifiedScopes:1},GLOBAL_SCOPE_ID);
    const originalLegacyMode=job.globalPlan.legacyMode ?? await getArgumentValue(modeArguments,MODE_PLUGIN_ONLY);
    for(const scope of job.globalPlan.scopes){
      // Older admitted plans counted removed server rows as live sources. Restore
      // the saved routing settings, then verify their effective mode with the
      // same semantics as normal reads; never rewrite the immutable plan.
      const expectedMode=registryScopeMode(job.globalPlan.registry,scope.scopeId,originalLegacyMode);
      const actual=await readScopeMode(scope,true);
      if(actual.mode!==expectedMode)throw globalModeError('MEMORY_SUITE_GLOBAL_ROLLBACK_READBACK_FAILED',{
        scopeId:scope.scopeId,expectedMode,actualMode:actual.mode,recordedSourceMode:scope.sourceMode,modeOrigin:actual.modeOrigin
      });
      await reportProgress({verifiedScopes:progress.verifiedScopes+1},scope.scopeId);
    }
    if(localOnly)await assertLocalCancellationIntent(state.syncJob.current);

    return await globalSaveJob({status:'cancelled',phase:'cancelled_rolled_back',rollbackComplete:true,finishedAt:Date.now(),attemptFinishedAt:Date.now(),rollbackProgress:{...progress,stage:'complete'},currentScopeId:'',currentKey:'',currentAction:'이전 저장 경로 복구 완료',error:'',errorDetails:null,failedPhase:'',failures:0,recoveryRequired:false,message:'취소했습니다. 변경된 저장 경로를 이전 설정으로 복구했고 원본 데이터는 보존했습니다.'});
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
    if (localOnlyOwner) return false;
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
  const scopedServerGet = async (space, key, readOptions = {}) => await remoteGet(String(space || 'plugin'), String(key || ''), { allowPluginOnly: true,storageMode:readOptions.serverManagement?MODE_SERVER_ONLY:undefined });
  const scopedServerGetMany = async (space = 'plugin', keys = []) => await remoteGetMany(String(space || 'plugin'), keys, { allowPluginOnly: true });
  const scopedServerKeys = async (space = 'plugin', prefix = '', readOptions = {}) => await remoteKeys(String(space || 'plugin'), String(prefix || ''), { allowPluginOnly: true,storageMode:readOptions.serverManagement?MODE_SERVER_ONLY:undefined });
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
    if (localOnlyOwner) { return typeof legacyGet === 'function' ? await legacyGet() : null; }
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
    if (localOnlyOwner) { return typeof legacySet === 'function' ? await legacySet(value) : false; }
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
    if (localOnlyOwner) { return typeof legacyRemove === 'function' ? await legacyRemove() : false; }
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
    if (localOnlyOwner) {
      const rows = typeof legacyKeysFn === 'function' ? await legacyKeysFn() : [];
      const keys = [...new Set((Array.isArray(rows) ? rows : []).map(String).filter(key=>key && key.startsWith(String(prefix || ''))))];
      return keys;
    }
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
      schema: 'memory-suite.sync-progress.v2', namespace, space, scopeId: scope.scopeId, scopeLabel: scope.label, dryRun,
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
    await runPart(globalLegacyStore('plugin'), 'plugin');
    await runPart(globalLegacyStore('local'), 'local');
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
      if (!globalLegacyStore('plugin') || typeof globalLegacyStore('plugin').getItem !== 'function' || typeof globalLegacyStore('plugin').setItem !== 'function') {
        const error = new Error('memory_suite_restore_adapter_unavailable:plugin');
        error.code = 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE'; throw error;
      }
      if ((localInventory.candidates.length || localInventory.tombstones.length)
        && (!globalLegacyStore('local') || typeof globalLegacyStore('local').getItem !== 'function' || typeof globalLegacyStore('local').setItem !== 'function')) {
        const error = new Error('memory_suite_restore_adapter_unavailable:local');
        error.code = 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE'; throw error;
      }
      if (!allowEmptyRestore && restoreOptions.allowEmptyRestore !== true && scopeCandidates === 0) {
        const error = new Error(`memory_suite_restore_snapshot_empty:${scope.scopeId}:dependencies=${result.dependencyCandidateCount},tombstones=${allTombstones}`);
        error.code = 'MEMORY_SUITE_RESTORE_SNAPSHOT_EMPTY'; throw error;
      }
      await captureRestoreOriginals('plugin', pluginInventory, globalLegacyStore('plugin'));
      await captureRestoreOriginals('local', localInventory, globalLegacyStore('local'));
      result.plugin = await scopedRestoreSpace(globalLegacyStore('plugin'), 'plugin', { ...restoreOptions, scope, inventory:pluginInventory, onProgress:forward });
      if (localInventory.candidates.length || localInventory.tombstones.length) {
        result.local = await scopedRestoreSpace(globalLegacyStore('local'), 'local', { ...restoreOptions, scope, inventory:localInventory, onProgress:forward });
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
        readback:async (spaceValue,key)=>await legacyRead(spaceValue==='local'?globalLegacyStore('local'):globalLegacyStore('plugin'),String(key||'')),
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

  const scopedVerifyPreservation = async (_legacy = globalLegacyStore('plugin'), verifyOptions = {}) => {
    if (verifyOptions?.global === true) return await globalVerifyPreservation(verifyOptions);
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
    result.spaces.plugin = await verifySpace(globalLegacyStore('plugin'), 'plugin');
    result.spaces.local = await verifySpace(globalLegacyStore('local'), 'local');
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
    state.syncJob.dismissedJobId = '';
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
      if(globalLocalCancellationNeeded(job)&&!job.localCancellationIntent)return job;
      if(globalRollbackPending(job))return await scopedCancelSyncJobImpl();
      // A changed inventory needs explicit in-panel review before a new plan.
      if(['MEMORY_SUITE_GLOBAL_SOURCE_CHANGED','MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'].includes(job.error))return job;
      await globalSaveJob({pauseRequested:false,cancelRequested:false});
      void withModeConfiguration(()=>runGlobalModeJob(state.syncJob.current)).catch(()=>{});
      return getSyncJob();
    }
    const scope = await resolveCurrentScope(false);
    if (!scope.scopeId || String(job.scopeId || '') !== scope.scopeId) return job;
    void scopedExecuteBackgroundJob().catch(() => {});
    return getSyncJob();
  };
  const scopedCancelSyncJob = (...args) => state.syncJob.current?.kind==='global_mode'&&globalJobRunning
    ?scopedCancelSyncJobImpl(...args):withOwnerOperation({kind:'job_admission',operation:'scopedCancelSyncJob'}, () => scopedCancelSyncJobImpl(...args));
  const scopedCancelSyncJobImpl = async (cancelOptions={}) => {
    if(state.syncJob.current?.kind==='global_mode'&&globalJobRunning){state.syncJob.current.cancelRequested=true;state.syncJob.current.pauseRequested=true;notifySyncJob();return getSyncJob();}
    if (state.syncJob.retryTimer) {
      clearLifecycleTimeout(state.syncJob.retryTimer);
      state.syncJob.retryTimer = null;
    }
    await loadPersistedSyncJob();
    const job = state.syncJob.current;
    if (!job) {
      await clearPersistedSyncJob();
      notifySyncJob();
      return job;
    }
    if (syncJobTerminal(job.status)) {
      const incompleteGlobal = job.kind === 'global_mode'
        && job.status !== 'completed'
        && job.rollbackComplete !== true
        && (job.effectsStarted === true || Object.keys(job.checkpoints || {}).length > 0);
      if (incompleteGlobal) return job;
      await clearPersistedSyncJob();
      notifySyncJob();
      return job;
    }
    state.syncJob.creating = false;
    if (job.kind === 'global_mode') {
      state.syncJob.current.cancelRequested=true;
      state.syncJob.current.pauseRequested=true;
      await globalSaveJob({message:'취소 요청 · 안전한 지점에서 변경된 저장 경로를 복구합니다.'});
      if(globalJobRunning||modeConfigurationBusy)return getSyncJob();
      return await withModeConfiguration(async()=>{
        try{
          if(cancelOptions.localOnly===true&&!state.syncJob.current.localCancellationIntent){
            if(!globalLocalCancellationNeeded(state.syncJob.current)||!cancelOptions.previewFingerprint)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_REVIEW_REQUIRED');
            const proof=await inspectLocalCancellation(state.syncJob.current);
            if(proof.fingerprint!==cancelOptions.previewFingerprint)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_CHANGED');
            const store=rawPluginStorage(),backupKey=SYNC_JOB_STORAGE_KEY+':local-cancel:'+job.jobId;
            const existing=await store.getItem(backupKey);
            if(existing==null){
              if(!await legacyWriteVerified(store,backupKey,JSON.stringify({schema:'memory-suite.local-cancellation-backup.v1',job:getSyncJob(),resetPreferenceRaw:proof.resetPreferenceRaw})))throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');
            }else{
              let backup;try{backup=typeof existing==='string'?JSON.parse(existing):existing;}catch(_){}
              if(backup?.schema!=='memory-suite.local-cancellation-backup.v1'||backup.job?.jobId!==job.jobId||backup.job?.globalPlanDigest!==job.globalPlanDigest)throw globalModeError('MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');
            }
            await globalSaveJob({localCancellationIntent:{sourceFingerprint:proof.sourceFingerprint,resetPreferenceRaw:proof.resetPreferenceRaw,approvedAt:Date.now()}});
          }
          return await rollbackGlobalModeRoutes(state.syncJob.current);
        }
        catch(error){
          const guidance=syncJobActionGuidance(error.code||error.message||error,error.details,state.syncJob.current);
          await globalSaveJob({
            status:'paused',
            phase:'recovery_pending',
            attemptFinishedAt:Date.now(),
            error:String(error.code||error.message||error),
            failedPhase:state.syncJob.current?.phase||'recovery_pending',
            errorDetails:compactRestoreEvidence(error.details||null),
            actionRequired:guidance?.actionRequired||null,
            blockerReason:guidance?.blockerReason||null,
            remedySteps:guidance?.remedySteps||null,
            message:'취소 복구 중단 · 조치 필요. 복구 정보를 보존했습니다. 원인을 확인한 뒤 진행 화면의 복구 버튼을 사용하세요.'
          });
          throw error;
        }
      });
    }
    updateSyncJob({
      status: 'cancelled',
      phase: 'cancelled_by_user',
      currentAction: '사용자 요청으로 취소됨',
      message: '이전 작업을 취소했습니다. 기존 저장 모드와 원본 데이터가 안전하게 유지됩니다.',
      nextRetryAt: 0,
      finishedAt: Date.now()
    }, { persist: 'immediate' });
    await clearPersistedSyncJob();
    notifySyncJob();
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
    if (deleteOptions?.global === true) return await globalDeletePluginStorageAfterVerification(deleteOptions);
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

  const normalizeJsonVal = val => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (_) { return val; }
    }
    return val;
  };

  const readCleanupLocalValue = async (legacy, key) => {
    const raw = await legacyRead(legacy, key);
    const manifest = normalizeJsonVal(raw);
    if (namespace !== 'libra' || manifest?.__libraChunkedStorageV1 !== true) return raw;
    // The registered legacy store may be the raw host adapter. Compare the
    // logical payload saved on the server, while retaining the physical root
    // and its chunks until all preservation checks have passed.
    const size = 512 * 1024, chunks = manifest.chunks, length = manifest.length;
    const prefix = `${key}::chunk:v1:`;
    const first = Array.isArray(chunks) ? chunks[0] : null;
    const stamp = typeof first === 'string' && first.startsWith(prefix) && first.endsWith(':0000')
      ? first.slice(prefix.length, -5) : '';
    if (manifest.schemaVersion !== 1 || manifest.key !== key || !Number.isSafeInteger(length) || length <= size
      || !Array.isArray(chunks) || chunks.length !== Math.ceil(length / size) || !stamp
      || chunks.some((chunk, index) => chunk !== `${prefix}${stamp}:${String(index).padStart(4, '0')}`))
      throw globalModeError('MEMORY_SUITE_LOCAL_CHUNK_INVALID', { key });
    const bodies = [];
    for (let index = 0; index < chunks.length; index++) {
      const body = await legacy.getItem(chunks[index]);
      if (typeof body !== 'string' || body.length !== Math.min(size, length - index * size))
        throw globalModeError('MEMORY_SUITE_LOCAL_CHUNK_INCOMPLETE', { key, chunkKey: chunks[index] });
      bodies.push(body);
    }
    if (jsonComparable(await legacy.getItem(key)) !== jsonComparable(raw))
      throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED', { key });
    return bodies.join('');
  };

  const cleanupProgress = async (options, phase, fields = {}) => {
    if (options.signal?.aborted) throw globalModeError('MEMORY_SUITE_CLEANUP_CANCELLED');
    try { options.onProgress?.({ phase, ...fields }); } catch (_) {}
    // Yield to paint even when host storage reads resolve synchronously.
    if ((fields.current || 0) % 25 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const cleanupRemoteFingerprint = async remote => await globalDigest([
    remote?.exists === true, remote?.tombstone === true, remote?.revision || 0,
    remote?.digest || '', remote?.exists ? normalizeJsonVal(remote.value) : null
  ]);
  const cleanupCondition = (space, key, remote) => ({ space, key,
    expectedRevision: remote.revision, expectedDigest: remote.digest,
    expectedExists: remote.exists === true, expectedTombstone: remote.tombstone === true });
  const inspectDuplicateCleanup = async (verifyOptions = {}) => {
    const direction = verifyOptions.direction === 'server' ? 'server' : 'local';
    await cleanupProgress(verifyOptions, 'connecting');
    const config = await readConfig(true), registry = await loadScopeRegistry(true, false);
    const globalMode = normalizeMode(liveGlobalRow(registry)?.mode || config.mode);
    const requiredMode = direction === 'server' ? MODE_PLUGIN_ONLY : MODE_SERVER_ONLY;
    if (globalMode !== requiredMode) {
      const error = globalModeError(direction === 'server' ? 'MEMORY_SUITE_DELETE_REQUIRES_PLUGIN_MODE' : 'MEMORY_SUITE_DELETE_REQUIRES_SERVER_MODE');
      error.userMessage = direction === 'server'
        ? '먼저 플러그인 단독을 선택하고 설정 적용으로 전체 자료 이동을 완료하세요. 이동 후 서버 사본을 정리할 수 있습니다.'
        : '기기 중복 데이터 삭제는 서버 단독 모드에서만 실행할 수 있습니다. 먼저 전역 설정을 서버 단독으로 적용해 주세요.';
      throw error;
    }
    for (const row of Object.values(registry.entries || {})) {
      if (row.removed) continue;
      const lock = await recoveryLockForScope(row);
      if (lock) throw recoveryRequiredError(row, lock, 'delete_pluginstorage');
      if (direction === 'server' && registryScopeMode(registry, row.scopeId, globalMode) !== MODE_PLUGIN_ONLY)
        throw globalModeError('MEMORY_SUITE_DELETE_REQUIRES_PLUGIN_MODE', { scopeId: row.scopeId });
    }
    const integrity = await remoteIntegrity({ allowPluginOnly: true }).catch(cause => {
      const error = globalModeError(normalizeServerAvailabilityError(cause)?.code || 'MEMORY_SUITE_SERVER_VERIFICATION_FAILED');
      error.cause = cause; error.userMessage = `서버 연결 및 무결성 확인 실패: ${cause?.message || cause}`; throw error;
    });
    if (integrity?.ok !== true) throw globalModeError('MEMORY_SUITE_SERVER_INTEGRITY_FAILED');
    if (direction === 'server' && (await bootstrap(false, true)).capabilities?.['duplicate-cleanup.v1'] !== true) {
      const error = globalModeError('MEMORY_SUITE_DUPLICATE_CLEANUP_SERVER_UPDATE_REQUIRED');
      error.userMessage = '서버 사본 정리를 지원하는 새 server.cjs로 서버를 업데이트한 뒤 다시 시도하세요.'; throw error;
    }
    const result = { schema:'memory-suite.global-preservation.v1', namespace, direction,
      checked:0, items:[], candidates:[], failures:[], serverSnapshot:[], retainedDependencies:[], spaces:{plugin:null,local:null} };
    const inventory=direction==='server'?await collectGlobalInventory(MODE_PLUGIN_ONLY,{readOnlyCatalog:true}):null;
    const stores=inventory?.stores||{plugin:rawPluginStorage(),local:await rawDeviceStorage({strict:true})};
    // Adapters remain internal. A serializable review never contains a storage
    // object or memory body, but execution must use the discovered physical stores.
    Object.defineProperty(result,'stores',{value:stores});
    for (const space of ['plugin','local']) {
      const legacy = stores[space];
      if (direction === 'local' && (!legacy || typeof legacy.keys !== 'function')) continue;
      const listing=direction==='server'?await remoteKeys(space,'',{allowPluginOnly:true,strictInventory:true}):null;
      if(listing)result.serverSnapshot.push(...listing.records.map(row=>({space,key:row.key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:!listing.tombstones.includes(row.key),expectedTombstone:listing.tombstones.includes(row.key)})));
      const keys=listing?listing.keys:await listRoutedLegacyKeys(legacy,space,true);
      const spaceItems = [];
      for (let index=0; index<keys.length; index++) {
        const physicalKey = keys[index];
        await cleanupProgress(verifyOptions,'verify',{space,key:physicalKey,current:index,total:keys.length});
        const decoded = direction === 'server' ? scopedRemoteKeyInfo(physicalKey) : null;
        const key = decoded?.logicalKey || physicalKey;
        if (key.startsWith('__memory_suite_') || isOwnedChunkArtifact(space,key) || !matchesRoute(space,key)) continue;
        let route = await resolveScopedRoute(space,key,{noCache:true,...(decoded?.scopeId?{scope:registry.entries[decoded.scopeId]||{scopeId:decoded.scopeId,scopeKey:decoded.scopeId}}:{})});
        const wholeRecord=direction==='server'&&['global','shared'].includes(route.kind)&&inventory.records.some(row=>row.location==='server'&&row.space===space&&row.key===physicalKey&&globalPayloadRecord(row));
        // Native shared archives and memory indexes are payloads too. Settings
        // remain excluded by the owner's audited inventory classification.
        if(wholeRecord)route={...route,kind:'scope',scopeId:GLOBAL_SCOPE_ID,scope:globalScopeDescriptor()};
        if (route.kind !== 'scope' || !route.scopeId || direction === 'server' && route.remoteKey !== physicalKey) continue;
        if (registryScopeMode(registry,route.scopeId,globalMode) !== requiredMode) continue;
        await assertStorageTransitionComplete(route.scope,{mode:requiredMode});
        const descriptor=registry.entries[route.scopeId]||route.scope||{};
        const item = { id:JSON.stringify([space,key]),space,key,remoteKey:route.remoteKey,scopeId:route.scopeId,
          label:descriptor.label||[descriptor.characterName,descriptor.chatTitle].filter(Boolean).join(' / ')||route.scopeId,
          dataLabel:/manifest/i.test(key)?'기억 목록':/(?:local[-_:]vector|:vector:|:embedding:|vector-shard)/i.test(key)?'벡터 자료':/(?:shard|:memory:|records|ledger|canonical)/i.test(key)?'기억 자료':'저장 자료',
          status:'unverified',canDelete:false,wholeRecord,route };
        let local, projected, remote;
        try {
          local = await readCleanupLocalValue(legacy,key);
          if (direction === 'local' && isNullishStorageValue(local)) continue;
          projected = isNullishStorageValue(local) ? null : await routeProjectValue(route,local);
          if (direction === 'local' && isNullishStorageValue(projected)) continue;
          item.localSize=isNullishStorageValue(projected)?0:(typeof projected==='string'?projected:JSON.stringify(projected)).length;
          item.localFingerprint = await globalDigest(normalizeJsonVal(projected));
        } catch(error) { item.reason='local_unreadable'; item.error=compact(error?.message||error,240); }
        try {
          remote = await remoteGet(space,route.remoteKey,{allowPluginOnly:true});
          item.remoteSize=remote?.exists?(typeof remote.value==='string'?remote.value:JSON.stringify(remote.value)).length:0;
          item.remoteFingerprint = await cleanupRemoteFingerprint(remote);
          item.remoteCondition = cleanupCondition(space,route.remoteKey,remote);
        } catch(error) { item.reason='server_unavailable'; item.error=compact(error?.message||error,240); }
        if (!item.reason) {
          item.reason = !remote?.exists || remote.tombstone ? (remote?.tombstone?'server_tombstone':'server_missing')
            : isNullishStorageValue(projected) ? 'local_missing'
            : jsonComparable(normalizeJsonVal(remote.value)) === jsonComparable(normalizeJsonVal(projected)) ? 'matched' : 'value_mismatch';
          item.status = item.reason === 'matched' ? 'matched' : 'unverified';
          // Only explicit local deletion can discard an unpreserved copy.
          item.canDelete = direction === 'local' || item.status === 'matched';
        }
        item.fingerprint = await globalDigest([direction,item.id,item.scopeId,item.remoteKey,item.localFingerprint||'',item.remoteFingerprint||'',item.reason]);
        spaceItems.push(item);result.items.push(item);
        if (item.status === 'matched') result.candidates.push(item);
        else result.failures.push({space,key,remoteKey:route.remoteKey,scopeId:route.scopeId,reason:item.reason,...(item.error?{error:item.error}:{})});
      }
      result.spaces[space]={space,checked:spaceItems.length,failures:result.failures.filter(row=>row.space===space)};
      result.checked+=spaceItems.length;
    }
    if(direction==='server') {
      const records=inventory.records.filter(row=>row.location==='server'&&!row.deleted&&globalPayloadRecord(row));
      const byKey=new Map(result.items.map(item=>[JSON.stringify([item.space,item.remoteKey]),item]));
      for(const row of records) {
        const evidence={space:row.space,key:row.logicalKey,scopeId:row.scopeId,dependencyKeys:row.dependencyKeys||[],dependencyScopeIds:row.dependencyScopeIds||[]};
        const item=byKey.get(JSON.stringify([row.space,row.key]));
        if(item)Object.assign(item,evidence,{key:item.key,scopeId:item.scopeId});else result.retainedDependencies.push(evidence);
      }
      if(!inventory.completeKnownScopes||inventory.blockers.length)for(const item of result.items){item.canDelete=false;if(item.status==='matched'){item.reason='inventory_unverified';item.status='unverified';}}
      for(const item of result.items)item.fingerprint=await globalDigest([item.fingerprint,item.canDelete,item.reason,item.dependencyKeys||[],item.dependencyScopeIds||[]]);
      result.candidates=result.items.filter(item=>item.status==='matched');
      result.failures=result.items.filter(item=>item.status!=='matched').map(item=>({space:item.space,key:item.key,reason:item.reason}));
    }
    result.ok=result.failures.length===0;
    await cleanupProgress(verifyOptions,'review',{current:result.checked,total:result.checked,verified:result.candidates.length,unverified:result.failures.length});
    return result;
  };
  const cleanupSelectionItems = (review,selection) => {
    const selected=new Set(review.items.filter(item=>item.canDelete&&(selection?selection[item.id]?.action==='delete':item.status==='matched')));
    if(review.direction==='server') {
      let changed;
      do {changed=false;const retained=[...review.retainedDependencies,...review.items.filter(item=>!selected.has(item))];
        for(const item of selected)if(retained.some(row=>row.scopeId===item.scopeId
          ||(row.dependencyScopeIds||[]).includes(item.scopeId)
          ||row.space===item.space&&(row.dependencyKeys||[]).some(key=>key===item.key||key===item.remoteKey))){selected.delete(item);changed=true;}
      }while(changed);
    }
    return [...selected];
  };
  const cleanupVerificationError = result => {
    const error = globalModeError('MEMORY_SUITE_GLOBAL_PRESERVATION_FAILED');
    error.result=result;error.userMessage=`보존 검증에서 ${result.failures.length}개 항목을 확인하지 못했습니다. 항목별 목록에서 보존·제외·삭제를 선택하세요.`;
    return error;
  };
  const globalVerifyPreservation = async (options = {}) => {
    const result=await inspectDuplicateCleanup({...options,direction:'local'});
    if (!result.ok && options.review !== true) throw cleanupVerificationError(result);
    return result;
  };
  const globalDeletePluginStorageAfterVerification = (...args) => withModeConfiguration(()=>executeDuplicateCleanup({...args[0],direction:'local'}));
  const globalDeleteServerDuplicates = (...args) => withModeConfiguration(()=>executeDuplicateCleanup({...args[0],direction:'server'}));
  const executeDuplicateCleanup = async (deleteOptions = {}) => {
    await cleanupProgress(deleteOptions,'draining',{current:0,total:0});
    do {
      await Promise.allSettled([...ownerIOWork]);
      if (typeof whenFlashbackWritersIdle === 'function') await whenFlashbackWritersIdle();
      await Promise.allSettled([...mutationTails.values()]);
    } while (ownerIOWork.size || mutationTails.size);
    modeConfigurationFrozen=true;
    const review=await inspectDuplicateCleanup(deleteOptions), selection=deleteOptions.selection;
    if (!selection && !review.ok) throw cleanupVerificationError(review);
    const itemsById=new Map(review.items.map(item=>[item.id,item]));
    if (selection) for (const [id,choice] of Object.entries(selection)) {
      if (!['keep','exclude','delete'].includes(choice?.action)) throw globalModeError('MEMORY_SUITE_CLEANUP_SELECTION_INVALID');
      if (choice.action!=='delete') continue;
      const item=itemsById.get(id);
      if (!item || choice.fingerprint!==item.fingerprint) throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{key:item?.key});
      if (!item.canDelete || item.status!=='matched' && deleteOptions.allowUnpreserved!==true)
        throw globalModeError('MEMORY_SUITE_CLEANUP_UNPRESERVED_CONFIRMATION_REQUIRED',{key:item.key});
    }
    const selected=cleanupSelectionItems(review,selection);
    const result={ok:true,schema:'memory-suite.duplicate-cleanup-result.v1',namespace,direction:review.direction,
      checked:review.checked,deleted:0,deletedItems:0,kept:review.items.filter(item=>!selection||selection[item.id]?.action!=='exclude').length-selected.length,
      excluded:review.items.filter(item=>selection?.[item.id]?.action==='exclude').length,failures:[],backupIds:[]};
    const serverMutations=[];
    const cleanupId=operationId('duplicates').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,150);
    if (typeof deleteOptions.beforeDelete==='function') await deleteOptions.beforeDelete();
    for (let index=0;index<selected.length;index++) {
      const item=selected[index],legacy=review.stores[item.space];
      try {
        await cleanupProgress(deleteOptions,'delete',{current:index,total:selected.length,key:item.key,deleted:result.deleted,kept:result.kept,excluded:result.excluded});
        const mode=await readScopeMode(item.route.scope,true),required=review.direction==='server'?MODE_PLUGIN_ONLY:MODE_SERVER_ONLY;
        if (mode.mode!==required) throw globalModeError('MEMORY_SUITE_CLEANUP_MODE_CHANGED');
        await assertStorageTransitionComplete(item.route.scope,mode);
        await assertRecoveryActionAllowed(item.route.scope,'delete_pluginstorage');
        let route=await resolveScopedRoute(item.space,item.key,{noCache:true,scope:item.route.scope});
        if(item.wholeRecord&&['global','shared'].includes(route.kind))route={...route,kind:'scope',scopeId:GLOBAL_SCOPE_ID,scope:globalScopeDescriptor()};
        if (route.kind!=='scope'||route.scopeId!==item.scopeId||route.remoteKey!==item.remoteKey) throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED');
        const readCurrent=async()=>{
          const value=await readCleanupLocalValue(legacy,item.key), projected=await routeProjectValue(route,value);
          if (await globalDigest(normalizeJsonVal(projected))!==item.localFingerprint) throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{key:item.key});
          return value;
        };
        await readCurrent();
        const remote=await remoteGet(item.space,item.remoteKey,{allowPluginOnly:true});
        if (await cleanupRemoteFingerprint(remote)!==item.remoteFingerprint) throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{key:item.key});
        if (review.direction==='server') {
          await readCurrent();
          serverMutations.push(cleanupCondition(item.space,item.remoteKey,remote));
        } else {
          const ok=await routeRemoveLocal(route,readCurrent,
            async next=>{await readCurrent();return await legacyWriteVerified(legacy,item.key,next);},
            async()=>{await readCurrent();return await legacyRemoveVerified(legacy,item.key);});
          if(!ok)throw new Error('global_local_delete_readback_failed');
          result.deleted++;
          if(isNullishStorageValue(await legacyRead(legacy,item.key))) {
            for(const chunk of await listRoutedLegacyKeys(legacy,item.space,true))if(isOwnedChunkArtifact(item.space,chunk)&&chunkOwnerKey(chunk)===item.key){
              if(!await legacyRemoveVerified(legacy,chunk))throw new Error('global_chunk_delete_readback_failed');
              result.deleted++;
            }
          }
        }
        if(review.direction==='local')result.deletedItems++;
      }catch(error){
        if (error.code==='MEMORY_SUITE_CLEANUP_CANCELLED') {error.result=result;throw error;}
        result.failures.push({space:item.space,key:item.key,error:compact(error?.message||error,240)});
      }
    }
    if(review.direction==='server'&&selected.length&&result.failures.length===0) {
      try {
        // Recheck every destination after the complete read pass. One exact
        // namespace transaction then removes the selected server copies together.
        for(const item of selected){
          const value=await readCleanupLocalValue(review.stores[item.space],item.key);
          if(await globalDigest(normalizeJsonVal(await routeProjectValue(item.route,value)))!==item.localFingerprint)
            throw globalModeError('MEMORY_SUITE_GLOBAL_SOURCE_CHANGED',{key:item.key});
        }
        await cleanupProgress(deleteOptions,'server_commit',{current:0,total:selected.length});
        const condition=await remoteGet('plugin',SCOPE_ROUTING_SERVER_KEY,{allowPluginOnly:true});
        const id=operationId('duplicate-cleanup');
        let response;
        try {
          response=await request('POST','/v1/owner/duplicate-cleanup',{
            namespace,cleanupId,operationId:id,snapshot:review.serverSnapshot,
            registryCondition:cleanupCondition('plugin',SCOPE_ROUTING_SERVER_KEY,condition),mutations:serverMutations,localVerified:true
          },{allowPluginOnly:true,storageMode:MODE_PLUGIN_ONLY});
        }catch(error){
          // A lost response must not turn a committed purge into a second job.
          // Only this operation's durable receipt can resolve the uncertainty.
          response=await statusReadback(id,{allowPluginOnly:true,storageMode:MODE_PLUGIN_ONLY,forceBootstrap:true}).catch(()=>null);
          if(!response?.result)throw error;
        }
        const receipt=response?.result,purged=receipt?.receipts?.filter(row=>row.kind==='purge')||[];
        if(!receipt?.verified||!receipt.durable||receipt.operationId!==id||receipt.namespace!==namespace
          ||purged.length!==selected.length||new Set(purged.map(row=>JSON.stringify([row.space,row.key]))).size!==selected.length
          ||purged.some(row=>!selected.some(item=>item.space===row.space&&item.remoteKey===row.key)))
          throw globalModeError('MEMORY_SUITE_CLEANUP_SERVER_RECEIPT_UNVERIFIED');
        if(receipt.backupId)result.backupIds.push(receipt.backupId);
        result.deleted=result.deletedItems=selected.length;
      }catch(error){if(error.code==='MEMORY_SUITE_CLEANUP_CANCELLED'){error.result=result;throw error;}result.failures.push({key:'server',error:compact(error?.message||error,240)});}
    }
    result.ok=result.failures.length===0;
    await cleanupProgress({...deleteOptions,signal:null},'complete',{current:selected.length,total:selected.length,...result});
    if (!result.ok) {
      const error=globalModeError('MEMORY_SUITE_GLOBAL_DELETE_INCOMPLETE');error.message=`memory_suite_global_delete_incomplete:${result.failures.length}`;error.failures=result.failures;error.result=result;
      error.userMessage=`정리 ${result.deletedItems}개 · 보존 ${result.kept}개 · 제외 ${result.excluded}개 · 실패 ${result.failures.length}개. 실패한 항목을 확인한 뒤 다시 시도하세요.`;throw error;
    }
    return result;
  };

  const bindDuplicateCleanupDialog = (root, { setMessage, refreshPanelSettings }) => {
    const inline=root.querySelector('[data-cleanup-dialog]'),body=root.ownerDocument?.body;
    if(body&&cleanupDialogController){inline.remove();cleanupDialogController.rebind(root,{setMessage,refreshPanelSettings});return cleanupDialogController;}
    const dialog=inline,q=selector=>dialog.querySelector(selector)||root.querySelector(selector);
    if(body)body.appendChild(dialog);
    let review=null,busy=false,controller=null,previousFocus=null;
    const labels={matched:'일치 · 중복 사본',value_mismatch:'두 사본의 내용이 다름',server_missing:'서버 사본 없음',server_tombstone:'서버 삭제 표식 있음',local_missing:'플러그인 사본 없음',local_unreadable:'기기 자료를 읽을 수 없음',server_unavailable:'서버 자료 확인 실패',inventory_unverified:'자료 목록·참조 관계 확인 필요'};
    const esc=value=>safeText(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const setBusy=value=>{
      busy=value;q('[data-cleanup-continue]').disabled=value||!review;
      q('[data-cleanup-close]').disabled=value;q('[data-cleanup-stop]').hidden=!value;
    };
    const progress=event=>{
      const phases={draining:'진행 중인 저장 작업 마무리 대기',connecting:'서버 연결·저장 위치 확인',verify:'사본 내용 비교',review:'항목별 선택 대기',delete:'선택한 사본 정리',server_commit:'서버 백업 생성·사본 삭제 확인',complete:'정리 완료'};
      q('[data-cleanup-phase]').textContent=phases[event.phase]||event.phase;
      q('[data-cleanup-stop]').disabled=event.phase==='server_commit';
      const current=Number(event.current||0),total=Number(event.total||0);
      q('[data-cleanup-progress]').max=Math.max(1,total);q('[data-cleanup-progress]').value=current;
      q('[data-cleanup-count]').textContent=`${current} / ${total} · 정리 ${event.deleted||0} · 보존 ${event.kept||0} · 제외 ${event.excluded||0}`;
      q('[data-cleanup-current]').textContent=event.key||'';
    };
    const selection=()=>{
      const choices=new Map([...dialog.querySelectorAll('[data-cleanup-choice]')].map(node=>[Number(node.getAttribute('data-cleanup-choice')),node.value]));
      return Object.fromEntries((review?.items||[]).map((item,index)=>[item.id,{
        fingerprint:item.fingerprint,action:choices.get(index)||(item.status==='matched'?'delete':'keep')
      }]));
    };
    const syncChoices=()=>{
      if(!review||busy)return;
      const choices=selection(),deleting=cleanupSelectionItems(review,choices);
      if(review.direction==='server') {
        const selectedIds=new Set(deleting.map(item=>item.id));
        for(const node of dialog.querySelectorAll('[data-cleanup-choice]')){const item=review.items[Number(node.getAttribute('data-cleanup-choice'))];if(node.value==='delete'&&!selectedIds.has(item.id))node.value='keep';}
      }
      const unpreserved=deleting.filter(item=>item.status!=='matched').length;
      q('[data-cleanup-ack-row]').hidden=unpreserved===0;
      q('[data-cleanup-continue]').disabled=deleting.length===0||unpreserved>0&&!q('[data-cleanup-ack]').checked;
      q('[data-cleanup-continue]').textContent=`선택한 ${deleting.length}개 사본 삭제`;
      q('[data-cleanup-summary]').textContent=`전체 ${review.checked}개 · 일치 ${review.candidates.length}개 · 확인 필요 ${review.failures.length}개 · 삭제 선택 ${deleting.length}개${unpreserved?` (서버 미보존 ${unpreserved}개 포함)`:''}`;
    };
    const finishError=error=>{
      const partial=error.result;
      q('[data-cleanup-phase]').textContent=error.code==='MEMORY_SUITE_CLEANUP_CANCELLED'?'중단됨 · 남은 사본 보존':'작업 확인 필요';
      q('[data-cleanup-summary]').textContent=`${error.userMessage||error.message||error}${partial?`\n정리 ${partial.deleted||0}개 · 보존 ${partial.kept||0}개 · 실패 ${partial.failures?.length||0}개`:''}`;
      if(partial?.failures?.length)q('[data-cleanup-errors]').textContent=partial.failures.map(row=>`${row.key}: ${labels[row.reason]||row.error||row.reason}`).join('\n');
      review=null;setMessage(q('[data-cleanup-summary]').textContent,'error');
    };
    const execute=async()=>{
      if(busy||!review)return;
      syncChoices();if(q('[data-cleanup-continue]').disabled)return;
      const plan=review, choices=selection();controller=new AbortController();setBusy(true);
      q('[data-cleanup-items]').hidden=true;
      try{
        const options={selection:choices,allowUnpreserved:q('[data-cleanup-ack]').checked,signal:controller.signal,onProgress:progress};
        const result=await (plan.direction==='server'?globalDeleteServerDuplicates(options):globalDeletePluginStorageAfterVerification(options));
        const message=`정리 완료 · ${result.deletedItems}개 항목 삭제 · ${result.kept}개 보존 · ${result.excluded}개 제외${result.backupIds.length?`\n서버 삭제 전 백업: ${result.backupIds.join(', ')}`:''}`;
        q('[data-cleanup-summary]').textContent=message;setMessage(message,'good');review=null;
        await refreshPanelSettings();
      }catch(error){finishError(error);}finally{setBusy(false);q('[data-delete]').textContent='중복 pluginStorage 전체 삭제';q('[data-cleanup-close]').focus?.();}
    };
    const open=async(direction='local')=>{
      if(busy)return;
      previousFocus=root.ownerDocument?.activeElement;review=null;controller=new AbortController();
      dialog.hidden=false;dialog.style.display='flex';q('[data-cleanup-ack]').checked=false;
      q('[data-cleanup-errors]').textContent='';q('[data-cleanup-items]').innerHTML='';q('[data-cleanup-items]').hidden=false;
      q('[data-cleanup-title]').textContent=direction==='server'?'이동 완료한 서버 사본 정리':'기기의 중복 플러그인 데이터 정리';
      q('[data-cleanup-summary]').textContent='사본을 비교하고 있습니다. 확인이 끝나면 항목별로 보존·제외·삭제를 선택하세요.';
      setBusy(true);q('[data-cleanup-stop]').focus?.();
      try{
        review=await withModeConfiguration(()=>inspectDuplicateCleanup({direction,signal:controller.signal,onProgress:progress}));
        q('[data-cleanup-items]').innerHTML=review.items.map((item,index)=>`<article class="mscx-cleanup-item"><div><b>${esc(item.label)} · ${esc(item.dataLabel)}</b><small>${esc(labels[item.reason]||item.reason)} · ${esc(item.space==='local'?'기기 저장소':'플러그인 저장소')} · 기기 ${item.localSize??'미확인'}자 / 서버 ${item.remoteSize??'미확인'}자</small><details><summary>저장 키 확인</summary><code>${esc(item.key)}</code>${item.error?`<p>${esc(item.error)}</p>`:''}</details></div><label>처리<select data-cleanup-choice="${index}" ${item.canDelete?'':'disabled'} aria-label="${esc(item.label)} 처리"><option value="keep" ${item.status==='matched'?'':'selected'}>사본 보존</option><option value="exclude">이번 정리에서 제외</option><option value="delete" ${item.status==='matched'?'selected':''} ${item.canDelete?'':'disabled'}>${item.status==='matched'?'중복 사본 삭제':'로컬 사본 삭제'}</option></select></label></article>`).join('')||'<p>정리할 사본이 없습니다.</p>';
        q('[data-delete]').textContent='검증 완료 · 선택 검토 후 삭제';
      }catch(error){finishError(error);}finally{setBusy(false);syncChoices();q(q('[data-cleanup-continue]').disabled?'[data-cleanup-close]':'[data-cleanup-continue]').focus?.();}
    };
    q('[data-cleanup-items]').addEventListener?.('change',()=>{q('[data-cleanup-ack]').checked=false;syncChoices();});
    q('[data-cleanup-ack]').onchange=syncChoices;
    q('[data-cleanup-continue]').onclick=execute;
    q('[data-cleanup-stop]').onclick=()=>{controller?.abort();q('[data-cleanup-phase]').textContent='중단 요청됨 · 현재 항목 처리가 끝나면 멈춥니다.';};
    q('[data-cleanup-close]').onclick=()=>{if(busy)return;review=null;dialog.hidden=true;dialog.style.display='none';q('[data-delete]').textContent='중복 pluginStorage 전체 삭제';(previousFocus?.isConnected?previousFocus:q('[data-delete]'))?.focus?.();};
    dialog.addEventListener?.('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();if(busy)q('[data-cleanup-stop]').onclick();else q('[data-cleanup-close]').onclick();}
      if(event.key==='Tab'){
        const controls=[...dialog.querySelectorAll('button:not([disabled]):not([hidden]),select:not([disabled]),input:not([disabled])')].filter(node=>!node.closest('[hidden]'));
        const first=controls[0],last=controls.at(-1),active=root.ownerDocument?.activeElement;
        if(event.shiftKey&&active===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&active===last){event.preventDefault();first?.focus();}
      }
    });
    const api={open,execute,hasReview:()=>!!review,
      rebind(nextRoot,callbacks){root=nextRoot;setMessage=callbacks.setMessage;refreshPanelSettings=callbacks.refreshPanelSettings;if(!dialog.isConnected)root.ownerDocument.body.appendChild(dialog);},
      dispose(){controller?.abort();dialog.remove();}
    };
    if(body)cleanupDialogController=api;
    return api;
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
    if (localOnlyOwner) return;
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
  const scopeDataPlan = (inventory,scope,server = false) => {
    const owned=inventory.records.filter(row=>(server?row.location==='server':row.location!=='server')&&!row.deleted&&row.classification==='scope'&&row.scopeId===scope.scopeId);
    const keys=new Set(owned.flatMap(row=>[row.key,row.logicalKey]));
    const artifacts=inventory.records.filter(row=>(server?row.location==='server':row.location!=='server')&&!row.deleted&&row.classification==='artifact'&&row.scopeId===scope.scopeId
      &&owned.some(parent=>parent.key===row.artifactOwnerKey&&parent.space===row.space&&parent.location===row.location));
    const referenced=inventory.records.some(row=>(server?row.location==='server':row.location!=='server')&&!row.deleted&&!owned.includes(row)&&!artifacts.includes(row)
      &&!(options.scopeRegistryKeys||[]).includes(row.logicalKey)
      &&((row.dependencyKeys||[]).some(key=>keys.has(key))||server&&row.scopeId!==scope.scopeId&&(row.dependencyScopeIds||[]).includes(scope.scopeId)));
    const registryEdits=[];let registryConflict=false;
    for(const row of inventory.records.filter(row=>(server?row.location==='server':row.location!=='server')&&!row.deleted&&(options.scopeRegistryKeys||[]).includes(row.logicalKey))){
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
  const localScopeDataPlan = (inventory,scope) => scopeDataPlan(inventory,scope,false);
  const serverScopeDataPlan = (inventory,scope) => scopeDataPlan(inventory,scope,true);
  const inspectScopeCatalog = async (inspectOptions = {}) => {
    requireScopeManagement();
    return await scopeCatalogFromInventory(await collectGlobalInventory(
      ['server','both'].includes(inspectOptions.deleteTarget)?MODE_SERVER_ONLY:MODE_PLUGIN_ONLY,
      {
        readOnlyCatalog:true,
        serverManagement:true,
        localManagement:inspectOptions.deleteTarget==='local',
        allowServerOffline:inspectOptions.deleteTarget==='local'
      }
    ));
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
      const plan=localScopeDataPlan(inventory,scope),serverPlan=serverScopeDataPlan(inventory,scope);
      let dataSummary='',dataMetrics={primary:null,secondary:null,updatedAt:null};
      try{if(typeof options.scopeDataSummary==='function'){
        const summary=options.scopeDataSummary({scope,records:live});
        dataSummary=String(summary&&typeof summary==='object'?summary.label||'':summary||'').slice(0,240);
        if(summary&&typeof summary==='object'){
          for(const key of ['primary','secondary'])if(Number.isSafeInteger(summary[key])&&summary[key]>=0)dataMetrics[key]=summary[key];
          const at=typeof summary.updatedAt==='number'?summary.updatedAt:typeof summary.updatedAt==='string'?Date.parse(summary.updatedAt):NaN;
          if(Number.isFinite(at)&&at>0&&at<=8640000000000000)dataMetrics.updatedAt=at;
        }
      }}catch(_){}
      const eligible=inventory.completeKnownScopes&&!!current?.scopeId&&[MODE_PLUGIN_ONLY,MODE_SERVER_ONLY].includes(activeMode)
        &&[MODE_PLUGIN_ONLY,MODE_SERVER_ONLY].includes(scope.sourceMode)&&!!scope.characterId&&!!scope.chatId&&current.scopeId!==scope.scopeId;
      const localPresent=plan.owned.length>0||plan.registryEdits.length>0,serverPresent=serverPlan.owned.length>0||serverPlan.registryEdits.length>0;
      const canDeleteLocal=eligible&&!plan.referenced&&localPresent;
      const canDeleteServer=eligible&&['hayaku','libra'].includes(namespace)&&inventory.remoteRequired&&!serverPlan.referenced&&serverPresent;
      const canDeleteBoth=eligible&&['hayaku','libra'].includes(namespace)&&inventory.remoteRequired&&!plan.referenced&&!serverPlan.referenced&&(localPresent||serverPresent);
      const canDelete=scope.sourceMode===MODE_SERVER_ONLY?canDeleteServer:canDeleteLocal;
      const fingerprint=typeof globalThis.crypto?.subtle?.digest==='function'?await globalDigest([scope,current?.scopeId,inventory.hostScopes,records.filter(row=>!(options.scopeRegistryKeys||[]).includes(row.logicalKey)).map(row=>[globalRecordIdentity(row),row.fingerprint,row.revision,row.digest]),[...plan.registryEdits,...serverPlan.registryEdits].map(edit=>[globalRecordIdentity(edit.row),edit.removedEntries]),issues,general]):'';
      rows.push({scopeId:scope.scopeId,scopeKey:scope.scopeKey,characterName:scope.characterName||'',chatTitle:scope.chatTitle||'',label:scope.label||scope.scopeKey,
        detached:!!(scope.canonicalCharacterId||scope.characterId)&&!!(scope.canonicalChatId||scope.chatId)&&!inventory.hostScopes.some(host=>(scope.canonicalCharacterId||scope.characterId)===host.characterId&&(scope.canonicalChatId||scope.chatId)===host.chatId),current:current?.scopeId===scope.scopeId,mode:scope.sourceMode,modeLabel:modeLabel(scope.sourceMode),
        recordCount:keys.length,ownedRecordCount:new Set(owned.map(row=>row.logicalKey)).size,ownedLocalRecords:owned.filter(row=>row.location!=='server').length,localRecords:live.filter(row=>row.location!=='server').length,serverRecords:live.filter(row=>row.location==='server').length,
        locations,keys,issues,fingerprint,dataSummary,dataMetrics,canDelete,canDeleteLocal,canDeleteServer,canDeleteBoth,localReferenced:plan.referenced,serverReferenced:serverPlan.referenced,localDataPresent:localPresent,serverDataPresent:serverPresent,deleteBlockedReason:canDelete?'':current?.scopeId===scope.scopeId?'현재 채팅은 삭제 대상에서 제외됩니다.':scope.sourceMode!==MODE_PLUGIN_ONLY||activeMode!==MODE_PLUGIN_ONLY?'플러그인 단독 모드에서만 로컬 자료를 정리합니다.':!scope.characterId||!scope.chatId?'원본 캐릭터·채팅 식별 미확인':plan.referenced?'다른 자료에서 참조 중':!inventory.completeKnownScopes?'전체 목록·참조 검사가 완료되지 않았습니다.':'정리할 로컬 자료가 없습니다.',registryEntries:plan.registryEdits.reduce((n,edit)=>n+edit.removed,0),referenced:plan.referenced,serverChecked:inventory.remoteRequired&&!!inventory.serverPin&&general.length===0,canManage:!!current?.scopeId&&owned.length>0&&issues.length===0&&general.length===0});
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
    if(!row.canDeleteLocal||action==='prune'&&plan.owned.length)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_BLOCKED');
    const currentId=await resolveCurrentScope(true).then(scope=>scope.scopeId);
    const hostBinding=globalCanonical(inventory.hostScopes),generation=dataBinding.generation;
    const assertCurrent=async()=>{
      if(lifecycle.disposed||resetReloadRequired||dataBinding.generation!==generation
        ||(await resolveCurrentScope(true)).scopeId!==currentId||currentId===scope.scopeId
        ||(await readScopeMode(scope,true)).mode!==scope.sourceMode
        ||globalCanonical(await globalHostCatalog())!==hostBinding)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
    };
    const assertLocalCurrent=assertCurrent;
    const validate=async()=>{
      await assertLocalCurrent();
      for(const copy of inventory.registryCopies.filter(copy=>copy.location!=='server')){
        if(globalCanonical(await inventory.stores[copy.location==='plugin'?'plugin':'local'].getItem(SCOPE_ROUTING_LOCAL_KEY))!==globalCanonical(copy.raw))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      }
    };
    const edits=[...plan.artifacts,...plan.owned].map(row=>({row,next:null})).concat(plan.registryEdits);
    for(const edit of edits){edit.store=inventory.stores[edit.row.space];edit.before=await edit.store.getItem(edit.row.key);
      if(globalCanonical(edit.before)!==globalCanonical(edit.row.value))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');}
    const applied=[];
    try{
      for(const edit of edits){await validate();
        if(globalCanonical(await edit.store.getItem(edit.row.key))!==globalCanonical(edit.before))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
        applied.push(edit);
        const ok=edit.next===null?await legacyRemoveVerified(edit.store,edit.row.key):await legacyWriteVerified(edit.store,edit.row.key,edit.next);
        if(!ok)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_FAILED');
      }
      await validate();
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
  const deleteOwnedServerScope = async (inventory, scope, row) => {
    if (!row.canDeleteServer) throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_BLOCKED');
    const connection = await bootstrap(false, true);
    if (connection.capabilities?.['owner-server-scope-delete.v1'] !== true) throw Error('서버 스코프 직접 삭제를 지원하는 버전으로 서버를 업데이트해 주세요.');
    const planData=serverScopeDataPlan(inventory,scope);
    const mutations=[...planData.artifacts,...planData.owned].map(item=>({kind:'remove',space:item.space,key:item.key,expectedRevision:item.revision,
      expectedDigest:item.digest,expectedExists:true,expectedTombstone:false})).concat(planData.registryEdits.map(edit=>({kind:'set',space:edit.row.space,key:edit.row.key,value:edit.next,
        expectedRevision:edit.row.revision,expectedDigest:edit.row.digest,expectedExists:true,expectedTombstone:false})));
    if(!mutations.length)throw Error('owner_scope_copy_delete_empty_inventory');
    const currentId = (await resolveCurrentScope(false)).scopeId;
    const hostWitness = globalCanonical(inventory.hostScopes), generation = dataBinding.generation, authorityEpoch = wholeDataInventoryEpoch;
    const assertCurrent = async () => {
      if (lifecycle.disposed || resetReloadRequired || dataBinding.generation !== generation || wholeDataInventoryEpoch !== authorityEpoch
        || (await resolveCurrentScope(false)).scopeId !== currentId || currentId === scope.scopeId) throw Error('owner_scope_copy_delete_context_changed');
      for (const copy of inventory.registryCopies.filter(copy => copy.location !== 'server')) {
        const store = inventory.stores[copy.location === 'plugin' ? 'plugin' : 'local'];
        if (globalCanonical(await store.getItem(SCOPE_ROUTING_LOCAL_KEY)) !== globalCanonical(copy.raw)) throw Error('owner_scope_copy_delete_context_changed');
      }
      const mode = await readScopeMode(scope, true);
      if (mode.mode !== scope.sourceMode || mode.transition || mode.migrationRequired
        || globalCanonical(await globalHostCatalog()) !== hostWitness
        || normalizeServerUrl(await configuredServerUrlNow()) !== inventory.targetUrl
        || globalCanonical(durableServerPinFromConnection(state.bootstrap.value, inventory.targetUrl)) !== globalCanonical(inventory.serverPin)) throw Error('owner_scope_copy_delete_context_changed');
      if ((await resolveCurrentScope(false)).scopeId !== currentId || dataBinding.generation !== generation || wholeDataInventoryEpoch !== authorityEpoch) throw Error('owner_scope_copy_delete_context_changed');
    };
    await assertCurrent();
    const requestOptions = { allowPluginOnly:true, scope, storageMode:MODE_SERVER_ONLY };
    const plan = (await request('POST', '/v1/owner/scope-copy-delete/plan', {
      namespace, scopeId:scope.scopeId, scopeKey:scope.scopeKey, directServerDelete:true, mutations
    }, requestOptions)).result;
    if (plan?.schema !== 'memory-suite.scope-delete-plan.v1' || plan.ownerServerDelete !== true
      || plan.namespace !== namespace || plan.scopeId !== scope.scopeId || !plan.planId || !plan.backupId
      || !plan.conditionsVerified || !/^[a-f0-9]{64}$/.test(plan.mutationFingerprint || '')) throw Error('owner_scope_copy_delete_plan_unverified');
    // A backup/confirmation can outlive the inventory used to select this
    // scope. Recheck ownership and references without restoring any local data.
    const fresh = await collectGlobalInventory(inventory.targetMode, {readOnlyCatalog:true,serverManagement:inventory.serverManagement});
    if (!fresh.completeKnownScopes || fresh.inventoryFingerprint !== inventory.inventoryFingerprint
      || globalCanonical(fresh.registryCopies) !== globalCanonical(inventory.registryCopies)) throw Error('owner_scope_copy_delete_context_changed');
    await assertCurrent();
    const result = (await request('POST', '/v1/owner/scope-copy-delete/execute', {
      planId:plan.planId, mutationFingerprint:plan.mutationFingerprint
    }, requestOptions)).result;
    if (result?.schema !== 'memory-suite.scope-delete-receipt.v1' || result.namespace !== namespace || result.scopeId !== scope.scopeId
      || result.planId !== plan.planId || result.backupId !== plan.backupId || result.verified !== true || result.durable !== true
      || result.ownerServerDelete !== true) throw Error('owner_scope_copy_delete_receipt_unverified');
    return { ...result, ok:true, deleted:result.counts?.total||0,serverOnly:true, localRestoreRequired:false };
  };
  const manageScope = async scopeRequest => {
    requireScopeManagement();
    if(!['sync','restore','cleanup','delete','prune','export'].includes(scopeRequest?.action)||!scopeRequest.scopeId||!scopeRequest.expectedFingerprint)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_REQUEST_INVALID');
    if(scopeRequest.deleteTarget!==undefined&&!['local','server','both'].includes(scopeRequest.deleteTarget))throw globalModeError('MEMORY_SUITE_SCOPE_DELETE_TARGET_INVALID');
    return await withModeConfiguration(async()=>{
      if(state.syncJob.creating||state.syncJob.current&&!syncJobTerminal(state.syncJob.current.status))throw transitionBusyError();
      do{await Promise.allSettled([...ownerIOWork]);await Promise.allSettled([...mutationTails.values()]);}while(ownerIOWork.size||mutationTails.size);
      modeConfigurationFrozen=true;
      const inventory=await collectGlobalInventory(
        ['server','both'].includes(scopeRequest.deleteTarget)?MODE_SERVER_ONLY:MODE_PLUGIN_ONLY,
        {
          serverManagement:true,
          localManagement:scopeRequest.deleteTarget==='local',
          allowServerOffline:scopeRequest.deleteTarget==='local'
        }
      ),catalog=await scopeCatalogFromInventory(inventory);
      const row=catalog.rows.find(row=>row.scopeId===scopeRequest.scopeId),scope=inventory.scopes.find(scope=>scope.scopeId===scopeRequest.scopeId);
      if(!row||row.fingerprint!==scopeRequest.expectedFingerprint||!row.fingerprint)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      if(scopeRequest.action==='delete'){
        const deleteTarget=scopeRequest.deleteTarget||(row.mode===MODE_SERVER_ONLY?'server':'local');
        const allowed=deleteTarget==='local'?row.canDeleteLocal:deleteTarget==='server'?row.canDeleteServer:row.canDeleteBoth;
        if(!allowed)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_DELETE_BLOCKED');
        const activeId=(await resolveCurrentScope(false)).scopeId;
        const outcome={deleteTarget,scopeId:scope.scopeId,local:null,server:null,partial:false};
        try{
          if(deleteTarget!=='local')outcome.server=row.serverDataPresent?await deleteOwnedServerScope(inventory,scope,row):{ok:true,deleted:0,alreadyEmpty:true};
          if(deleteTarget!=='server'){
            if((await resolveCurrentScope(false)).scopeId!==activeId)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
            outcome.local=row.localDataPresent?await deleteLocalScopeData(inventory,scope,row,'delete'):{ok:true,deleted:0,alreadyEmpty:true};
          }
          return {...(deleteTarget==='local'?outcome.local:deleteTarget==='server'?outcome.server:{}),...outcome,ok:true,
            deleted:Number(outcome.local?.deleted||0)+Number(outcome.server?.deleted||0)};
        }catch(error){
          if(deleteTarget!=='local'&&!outcome.server)outcome.server={ok:false,error:error.code||error.message};
          if(deleteTarget!=='server'&&!outcome.local)outcome.local={ok:false,notAttempted:deleteTarget==='both'&&!outcome.server?.ok,error:error.code||error.message,rollback:error.rollback};
          outcome.partial=!!outcome.server?.ok&&Number(outcome.server.deleted||0)>0;
          error.deletionResult=outcome;throw error;
        }
      }
      if(scopeRequest.action==='prune')return await deleteLocalScopeData(inventory,scope,row,scopeRequest.action);
      if(scopeRequest.action==='export'){
        if(!catalog.completeKnownScopes||row.mode!==MODE_PLUGIN_ONLY)throw globalModeError('MEMORY_SUITE_SCOPE_DATA_EXPORT_BLOCKED');
        const records=inventory.records.filter(item=>item.location!=='server'&&!item.deleted&&globalRecordScopeIds(item).includes(scope.scopeId)&&item.classification!=='control');
        return {ok:true,schema:'memory-suite.scope-data-backup.v1',namespace,scope,exportedAt:Date.now(),records:records.map(item=>({space:item.space,key:item.key,value:item.value}))};
      }
      if(!row.canManage)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CHANGED');
      if(scopeRequest.action==='sync'&&row.mode===MODE_SERVER_ONLY)throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_LOCAL_SOURCE_REQUIRED');
      if(scopeRequest.action!=='sync'&&(!catalog.completeKnownScopes||row.mode!==MODE_SERVER_ONLY))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_REQUIRES_SERVER_ONLY');
      if(scopeRequest.action==='cleanup'&&(row.current||!row.ownedLocalRecords))throw globalModeError('MEMORY_SUITE_SCOPE_MANAGEMENT_CLEANUP_BLOCKED');
      globalMigrationContext=inventory;
      try{
        if(scopeRequest.action==='sync'){
          const result=await scopedSynchronizeAll({scope,allowOverwrite:false,restoreMissingLocal:false});
          await verifyGlobalScopeDestination(inventory,scope,MODE_SERVER_ONLY);return result;
        }
        if(scopeRequest.action==='restore')return await scopedRestoreAll({scope});
        return await cleanupManagedScope(inventory,scope);
      }finally{globalMigrationContext=null;}
    });
  };
  const mountScopeManagementPanel = async container => {
    requireScopeManagement();
    const esc=value=>safeText(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const countHeader=namespace==='libra'?'정본 / Micro':'패킷 / 슬롯';
    container.innerHTML=`<section class="card" data-scope-manager><style>
      [data-scope-manager]{width:100%;min-width:0;box-sizing:border-box;background:var(--surface,#faf8f2);color:var(--text,#302b28);padding:16px;border:1px solid var(--border,#d6d0c4);border-radius:12px}
      [data-scope-manager] .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}
      [data-scope-manager] button{font:inherit;font-size:12px;color:inherit;background:var(--surface2,#f0ece3);border:1px solid var(--border2,#b6ad9d);border-radius:8px;padding:8px 10px;cursor:pointer}
      [data-scope-manager] button:disabled{opacity:.5;cursor:default}[data-scope-manager] .muted{color:var(--text2,#62594f);font-size:12px;line-height:1.65}
      [data-scope-manager] [data-scope-action=delete],[data-scope-manager] [data-scope-delete-one]{color:var(--danger,#ad3331);border-color:var(--danger-line,#e1aaa5);background:var(--danger-soft,#f9e2df)}
      [data-scope-manager] textarea{box-sizing:border-box;color:inherit;background:var(--surface2,#f0ece3)}
      [data-scope-manager] .scope-data-note{padding:10px 12px;border:1px solid var(--warn-line,#dcc487);border-radius:8px;background:var(--warn-soft,#f4e9d0);color:var(--warn-ink,#654410);font-size:12px;line-height:1.6}
      [data-scope-manager] [data-scope-filter]{width:100%;box-sizing:border-box}[data-scope-manager] [data-scope-search]{min-width:120px;flex:1}
      [data-scope-manager] .scope-data-table-wrap{max-width:100%;min-width:0;overflow-x:auto;border:1px solid var(--border,#d6d0c4);border-radius:10px}
      [data-scope-manager] .scope-data-table{width:100%;min-width:600px;border-collapse:collapse;table-layout:fixed;font-size:12px}
      [data-scope-manager] th,[data-scope-manager] td{padding:10px 7px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--border,#d6d0c4);overflow-wrap:anywhere}
      [data-scope-manager] th{background:var(--surface2,#f0ece3);font-weight:600;color:var(--text2,#62594f)}
      [data-scope-manager] tbody tr:last-child td{border-bottom:0}[data-scope-manager] tr[data-current=true]{background:var(--accent-soft,#f1dfd8)}
      [data-scope-manager] .scope-data-name b,[data-scope-manager] .scope-data-name span{display:block;overflow-wrap:anywhere}
      [data-scope-manager] .scope-data-name>span{color:var(--text2,#62594f)}[data-scope-manager] .scope-data-name details{margin-top:5px}
      [data-scope-manager] .scope-data-name details[open]{min-width:150px}[data-scope-manager] .scope-data-name pre{white-space:pre-wrap;overflow-wrap:anywhere}
      [data-scope-manager] .scope-data-reason{display:block;margin-top:4px;color:var(--text3,#7b7265);font-size:11px;line-height:1.5}
      [data-scope-manager] [data-scope-select]:disabled{pointer-events:none}[data-scope-manager] td[data-scope-select-cell]{cursor:default}
      [data-scope-manager] tr[data-selectable=false] td[data-scope-select-cell]{cursor:help}
      [data-scope-manager] .scope-data-state{display:inline-block;padding:3px 6px;border:1px solid var(--border2,#b6ad9d);border-radius:12px;font-size:11px}
      </style><h3>스코프 데이터 관리</h3>
      <p class="scope-data-note">삭제·정리는 실행 전에 대상과 참조 관계를 다시 검사합니다. 확인할 수 없는 자료는 보존합니다. 저장 모드와 별개로 로컬 데이터 삭제, 서버 데이터 삭제, 둘 다 삭제를 선택할 수 있습니다. 서버 삭제 전에는 백업하며 저장 모드는 바꾸지 않습니다.</p>
      <p class="scope-data-note" data-scope-readonly hidden role="status">이 화면은 보안 연결이 아니어서 목록 보기만 가능합니다. 브라우저가 암호화 기능(WebCrypto)을 제공하지 않아 삭제·백업 대상을 안전하게 확인할 수 없습니다. https 또는 localhost 주소로 접속하면 선택할 수 있습니다.</p>
      <select data-scope-filter aria-label="스코프 분류"><option value="all">전체</option><option value="memory">기억 저장소</option><option value="empty">빈 목록 · 정리 후보</option><option value="detached">고아 데이터</option><option value="issues">확인 필요</option><option value="server_only">서버 관리 대상</option></select>
      <div class="actions"><input data-scope-search type="search" aria-label="스코프 검색" placeholder="캐릭터 / 채팅 이름 · 스코프 키로 찾기"><button type="button" data-scope-action="export">선택 로컬 데이터 백업</button><label>삭제 대상 <select data-scope-delete-target aria-label="스코프 삭제 대상"><option value="local">로컬 데이터 삭제</option><option value="server">서버 데이터 삭제</option><option value="both">둘 다 삭제</option></select></label><button type="button" data-scope-action="delete">선택 삭제</button></div>
      <div class="actions"><button type="button" data-scope-refresh>새로고침</button><button type="button" data-scope-inspect>목록 상태 검사</button><button type="button" data-scope-pick="empty">빈 목록 선택</button><button type="button" data-scope-action="prune">선택 항목 로컬 정리</button><button type="button" data-scope-pick="orphan">고아 데이터 선택</button><span class="muted" data-scope-selection>선택 0개</span></div>
      <p class="muted" data-scope-summary role="status" aria-live="polite">목록을 확인하고 있습니다…</p>
      <div data-scope-confirm hidden style="display:none" role="alertdialog" aria-label="선택 스코프 작업 확인"><p data-scope-confirm-text></p><label data-scope-delete-ack-row hidden><input type="checkbox" data-scope-delete-ack> 필요한 데이터를 백업했으며 선택 자료의 영구 삭제에 동의합니다.</label><div class="actions"><button type="button" data-scope-cancel>취소</button><button type="button" data-scope-approve>확인하고 실행</button></div></div>
      <div data-scope-result role="status" aria-live="polite"></div>
      <div class="scope-data-table-wrap" tabindex="0" role="region" aria-label="스코프 데이터 목록 · 좁은 화면에서는 좌우로 스크롤"><table class="scope-data-table"><colgroup><col style="width:30px"><col><col style="width:72px"><col style="width:55px"><col style="width:85px"><col style="width:90px"><col style="width:60px"></colgroup><thead><tr><th><input type="checkbox" data-scope-select-all aria-label="검색 결과의 관리 가능 스코프 모두 선택"></th><th scope="col">캐릭터 / 채팅</th><th scope="col">${countHeader}</th><th scope="col">저장 키</th><th scope="col">상태</th><th scope="col">업데이트</th><th scope="col">관리</th></tr></thead><tbody data-scope-rows></tbody></table></div>
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
        &&(filter==='all'||filter==='issues'&&(row.issues.length>0||row.unavailable)||filter==='memory'&&row.ownedRecordCount>0&&!row.detached||filter==='detached'&&row.detached&&row.ownedRecordCount>0||filter==='empty'&&row.ownedRecordCount===0&&!row.unavailable&&row.issues.length===0&&catalog.completeKnownScopes||row.mode===filter)).sort((x,y)=>Number(y.current===true)-Number(x.current===true));};
    // Like Flashback's scope cleanup: any non-current, non-server scope can be ticked; the safety checks run
    // when an action is started and say which rows were skipped and why.
    const deleteTarget=()=>q('[data-scope-delete-target]').value;
    const targetLabel=()=>({local:'로컬 데이터 삭제',server:'서버 데이터 삭제',both:'둘 다 삭제'})[deleteTarget()];
    const canDeleteSelected=row=>!row.current&&!row.unavailable&&catalog?.completeKnownScopes&&({local:row.canDeleteLocal,server:row.canDeleteServer,both:row.canDeleteBoth})[deleteTarget()];
    const actionable=row=>!row.current&&(row.canDeleteLocal||row.canManage&&row.mode===MODE_PLUGIN_ONLY);
    const selectable=row=>!row.current&&!row.unavailable&&(canDeleteSelected(row)||deleteTarget()==='local'&&(row.mode===MODE_PLUGIN_ONLY||row.localRecords>0||row.registryEntries>0))&&!readOnlyCrypto();
    const permitted=(row,action)=>action==='export'?actionable(row)&&row.mode===MODE_PLUGIN_ONLY:action==='prune'?!!row.canDeleteLocal&&!row.current&&row.ownedLocalRecords===0:canDeleteSelected(row);
    // Why a row cannot be selected, in the user's words: a silently disabled box looks broken.
    const readOnlyCrypto=()=>!!catalog?.blockers?.some(issue=>issue.code==='scope_catalog_read_only_crypto_unavailable');
    const blockReason=row=>row.current?'현재 열려 있는 채팅은 선택할 수 없습니다.'
      :readOnlyCrypto()?'보안 연결이 아니어서 목록 보기만 가능합니다. https 또는 localhost 주소로 접속하세요.'
      :row.unavailable?'조회하지 못해 보존합니다. 새로고침 후 다시 확인하세요.'
      :row.issues.length?'확인이 필요한 항목이 있어 보존합니다. 상세에서 확인하세요.'
      :(deleteTarget()!=='server'&&row.localReferenced||deleteTarget()!=='local'&&row.serverReferenced)?'다른 스코프가 참조 중이므로 삭제·정리에서는 제외합니다. 백업은 가능합니다.'
      :canDeleteSelected(row)?''
      :deleteTarget()!=='local'&&!row.serverChecked?'서버 자료의 소유권·참조 확인이 필요합니다. 새로고침해 주세요.'
      :!catalog?.completeKnownScopes?'전체 목록 확인이 끝나지 않았습니다. 새로고침 후 다시 확인하세요.'
      :'선택한 위치에 삭제할 자료가 없거나 소유권 검증이 필요합니다.';
    const updateSelection=()=>{
      const rows=filtered().filter(selectable),all=q('[data-scope-select-all]');all.disabled=busy||rows.length===0;
      all.checked=rows.length>0&&rows.every(row=>selected.has(row.scopeId));all.indeterminate=!all.checked&&rows.some(row=>selected.has(row.scopeId));
      q('[data-scope-selection]').textContent=`선택 ${selected.size}개`;
      const chosen=(catalog?.rows||[]).filter(row=>selected.has(row.scopeId));
      root.querySelectorAll('[data-scope-action]').forEach(button=>{const action=button.getAttribute('data-scope-action');button.disabled=busy||!chosen.length||!chosen.some(row=>permitted(row,action));});
      root.querySelectorAll('[data-scope-pick],[data-scope-inspect]').forEach(button=>{button.disabled=busy;});
      q('[data-scope-delete-target]').disabled=busy;
    };
    const render=()=>{
      const rows=filtered();q('[data-scope-readonly]').hidden=!readOnlyCrypto();q('[data-scope-summary]').textContent=catalog?`확인된 스코프 ${catalog.rows.length}개 · 표시 ${rows.length}개 · 미해결 ${catalog.blockers.length}개${catalog.completeKnownScopes?'':' · 전체 확인 미완료'}`:'목록을 확인하고 있습니다…';
      q('[data-scope-rows]').innerHTML=rows.slice(0,limit).map(row=>{
        const status=row.unavailable?'조회 미확인':row.issues.length?'확인 필요':row.current?'현재':row.mode!==MODE_PLUGIN_ONLY?'서버 관리':row.referenced?'참조 중':row.detached&&row.ownedRecordCount?'고아 데이터':row.ownedRecordCount?'저장 자료':row.registryEntries?'목록 잔재':'자료 없음';
        const at=row.unavailable?null:row.dataMetrics?.updatedAt;
        const updated=at?new Date(at).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
        const note=blockReason(row),why=selectable(row)?'':note;
        return `<tr data-scope-row="${esc(row.scopeId)}" data-current="${row.current?'true':'false'}" data-selectable="${why?'false':'true'}">
        <td data-scope-select-cell ${why?`title="${esc(why)}" data-scope-why="${esc(why)}"`:''}><input type="checkbox" data-scope-select="${esc(row.scopeId)}" aria-label="${esc(row.label)} 선택${why?' · '+esc(why):''}" ${selected.has(row.scopeId)?'checked':''} ${busy||!selectable(row)?'disabled':''}></td>
        <td class="scope-data-name"><b>${esc(row.characterName||row.label)}</b><span>${esc(row.chatTitle||'채팅 이름 미확인')}</span>${note?`<small class="scope-data-reason" data-scope-reason>${esc(note)}</small>`:''}
        <details data-scope-detail><summary>상세</summary><div>${esc(row.scopeKey)}</div><div>${esc(row.modeLabel)}</div><div>${esc(row.dataSummary)}</div><div>${esc(row.locations.map(location=>({plugin:'플러그인 저장소',device:'기기 저장소',server:'서버'})[location]||location).join(' · ')||'저장 항목 없음')}</div><div>로컬 ${row.localRecords} / 서버 ${row.unavailable?'미확인':row.serverChecked?row.serverRecords:'미조회'}</div><div>${esc(row.deleteBlockedReason||'확인 후 선택 자료 삭제 가능')}</div><pre>${esc(row.issues.map(issue=>[issue.code,issue.key,issue.detail].filter(Boolean).join(' · ')).join('\n')||'확인된 오류 없음')}</pre><details><summary>저장 키 ${row.keys.length}개</summary><pre>${esc(row.keys.join('\n'))}</pre></details></details></td>
        <td title="${esc(row.dataSummary)}" data-scope-counts>${row.unavailable?'—':row.dataMetrics?.primary??'—'} / ${row.unavailable?'—':row.dataMetrics?.secondary??'—'}</td><td>${row.unavailable?'—':row.ownedRecordCount}</td><td><span class="scope-data-state">${status}</span></td><td><time ${at?'datetime="'+new Date(at).toISOString()+'"':''}>${updated}</time></td><td><button type="button" data-scope-delete-one="${esc(row.scopeId)}" aria-label="${esc(row.label)} 삭제" ${busy||!canDeleteSelected(row)?'disabled':''}>삭제</button></td></tr>`;
      }).join('')||'<tr><td colspan="7" class="muted">표시할 스코프가 없습니다.</td></tr>';
      q('[data-scope-more]').hidden=rows.length<=limit;
      if(catalog){q('[data-scope-diagnostics-text]').value=JSON.stringify(catalog,null,2);
        q('[data-scope-unresolved]').innerHTML=catalog.unresolved.length?`<details open><summary>스코프 식별 미확인 자료 ${catalog.unresolved.length}개 · 자동 연결·삭제 안 함</summary>${catalog.unresolved.map(row=>`<div class="mscx-scope-row"><b>${esc(row.key)}</b><span>${esc(row.location+' · '+row.space)}</span><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.issues.map(issue=>[issue.code,issue.detail].filter(Boolean).join(' · ')).join('\n'))}</pre></div>`).join('')}</details>`:'';
      }
      updateSelection();
    };
    const refresh=async()=>{
      const ticket=++serial;q('[data-scope-refresh]').disabled=true;q('[data-scope-summary]').textContent='전체 스코프와 저장 항목을 확인하고 있습니다…';
      try{const next=await inspectScopeCatalog({deleteTarget:deleteTarget()});if(ticket!==serial||!root.isConnected)return;
        if(!next.completeKnownScopes&&catalog){for(const old of catalog.rows)if(!next.rows.some(row=>row.scopeId===old.scopeId))next.rows.push({...old,canManage:false,canDelete:false,unavailable:true,issues:[{code:'scope_not_observed_in_incomplete_refresh'}]});}
        catalog=next;for(const id of selected)if(!catalog.rows.some(row=>row.scopeId===id&&selectable(row)))selected.delete(id);render();
      }catch(error){if(ticket===serial&&root.isConnected){q('[data-scope-summary]').textContent=`목록 확인 실패 · 이전 목록을 보존합니다: ${error.code||error.message}`;if(catalog){catalog={...catalog,completeKnownScopes:false,rows:catalog.rows.map(row=>({...row,unavailable:true,canManage:false,canDelete:false}))};selected.clear();render();q('[data-scope-result]').textContent=String(error.code||error.message);}}}
      finally{if(ticket===serial&&root.isConnected)q('[data-scope-refresh]').disabled=false;}
    };
    q('[data-scope-delete-target]').onchange=()=>{if(!busy){selected.clear();void refresh();}};
    q('[data-scope-refresh]').onclick=()=>{if(!busy)void refresh();};
    q('[data-scope-inspect]').onclick=async()=>{if(busy)return;await refresh();q('[data-scope-diagnostics]').open=true;};
    root.addEventListener('click',event=>{const button=event.target.closest?.('[data-scope-delete-one]');if(!button||button.disabled||busy)return;selected.clear();selected.add(button.getAttribute('data-scope-delete-one'));render();void q('[data-scope-action=delete]').onclick();});
    q('[data-scope-search]').oninput=q('[data-scope-filter]').onchange=()=>{limit=50;render();};
    q('[data-scope-more]').onclick=()=>{limit+=50;render();};
    q('[data-scope-select-all]').onchange=event=>{for(const row of filtered().filter(selectable)){if(event.target.checked)selected.add(row.scopeId);else selected.delete(row.scopeId);}render();};
    root.addEventListener('click',event=>{const cell=event.target.closest?.('td[data-scope-select-cell]');if(!cell||!cell.getAttribute('data-scope-why'))return;
      q('[data-scope-result]').textContent='선택할 수 없음 · '+cell.getAttribute('data-scope-why');});
    root.addEventListener('change',event=>{const id=event.target.getAttribute?.('data-scope-select');if(!id)return;const row=catalog?.rows.find(row=>row.scopeId===id);if(!busy&&row&&selectable(row)){if(event.target.checked)selected.add(id);else selected.delete(id);}updateSelection();});
    for(const button of root.querySelectorAll('[data-scope-pick]'))button.onclick=()=>{
      if(busy)return;const orphan=button.getAttribute('data-scope-pick')==='orphan';
      q('[data-scope-filter]').value=orphan?'detached':'empty';selected.clear();limit=50;
      for(const row of filtered())if(canDeleteSelected(row))selected.add(row.scopeId);render();
      q('[data-scope-result]').textContent='정리 후보를 선택했습니다. 아직 삭제하지 않았습니다.';
    };
    let confirmation=null;
    const finishConfirmation=value=>{if(!confirmation)return;const resolve=confirmation;confirmation=null;q('[data-scope-confirm]').hidden=true;q('[data-scope-confirm]').style.display='none';resolve(value);};
    q('[data-scope-delete-ack]').onchange=()=>{q('[data-scope-approve]').disabled=!q('[data-scope-delete-ack-row]').hidden&&!q('[data-scope-delete-ack]').checked;};
    q('[data-scope-approve]').onclick=()=>{if(!q('[data-scope-approve]').disabled)finishConfirmation(true);};q('[data-scope-cancel]').onclick=()=>finishConfirmation(false);
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&confirmation){event.preventDefault();event.stopPropagation();finishConfirmation(false);}});
    for(const button of root.querySelectorAll('[data-scope-action]'))button.onclick=async()=>{
      if(busy||!selected.size)return;
      const action=button.getAttribute('data-scope-action'),chosen=catalog.rows.filter(row=>selected.has(row.scopeId));
      const destructive=action==='delete'||action==='prune',chosenTarget=deleteTarget();
      const rows=chosen.filter(row=>permitted(row,action)),skipped=chosen.filter(row=>!permitted(row,action));
      const skipReason=row=>(action==='prune'&&row.canDeleteLocal&&row.ownedLocalRecords>0?'자료가 있어 목록 정리 대상이 아닙니다. 선택 삭제를 사용하세요.':blockReason(row))||'권한을 확인할 수 없어 보존합니다.';
      const skipText=skipped.map(row=>row.label+' · '+skipReason(row)).join('\n');
      if(!rows.length){q('[data-scope-result]').textContent='실행할 수 있는 스코프가 없습니다.\n'+skipText;q('[data-scope-result]').style.whiteSpace='pre-wrap';return;}
      q('[data-scope-delete-ack-row]').hidden=!destructive;q('[data-scope-delete-ack]').checked=false;q('[data-scope-approve]').disabled=destructive;
      busy=true;render();q('[data-scope-confirm-text]').textContent=`${button.textContent} · ${rows.length}개\n${rows.map(row=>row.label+' · '+row.scopeKey).join('\n')}\n${action==='delete'?targetLabel()+' · '+({local:'로컬 데이터만 삭제하며 서버 데이터는 유지합니다.',server:'서버 백업 후 서버 데이터만 삭제합니다. 기존 로컬 데이터는 유지하며 로컬 복구는 하지 않습니다.',both:'서버 백업 후 서버와 로컬 데이터를 모두 삭제합니다. 한쪽만 실패하면 부분 완료로 표시합니다.'})[chosenTarget]:'로컬 정리 또는 백업을 실행합니다.'} 저장 모드는 바꾸지 않습니다. 현재 채팅은 변경하지 않습니다.${skipped.length?`\n\n제외 ${skipped.length}개 (보존)\n${skipText}`:''}`;
      q('[data-scope-confirm]').hidden=false;q('[data-scope-confirm]').style.display='block';q('[data-scope-confirm-text]').style.whiteSpace='pre-wrap';q('[data-scope-cancel]').focus();
      let monitor=null;const accepted=await new Promise(resolve=>{confirmation=resolve;monitor=setInterval(()=>{if(!root.isConnected)finishConfirmation(false);},200);try{monitor?.unref?.();}catch(_){}});clearInterval(monitor);
      try{if(!accepted||!root.isConnected)return;let completed=0;const summaries=[];
        for(const row of rows){q('[data-scope-result]').textContent=`진행 ${completed}/${rows.length} · ${row.label}`;
          const result=await manageScope({scopeId:row.scopeId,action,deleteTarget:chosenTarget,expectedFingerprint:row.fingerprint});
          if(result.ok===false)throw new Error('선택 스코프 작업 미완료');
          if(action==='export'){
            const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
            const link=root.ownerDocument.createElement('a');link.href=url;link.download=namespace+'-scope-backup-'+Date.now()+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          }
          if(action==='delete')summaries.push(row.label+' · '+(result.local?'로컬 '+result.local.deleted+'개 삭제':'로컬 유지')+' / '+(result.server?'서버 '+result.server.deleted+'개 삭제':'서버 유지'));
          completed++;selected.delete(row.scopeId);if(!root.isConnected)break;}
        if(root.isConnected){q('[data-scope-result]').textContent=`완료 ${completed}/${rows.length}개${summaries.length?'\n'+summaries.join('\n'):''}${skipped.length?` · 제외 ${skipped.length}개\n${skipText}`:''}`;q('[data-scope-result]').style.whiteSpace='pre-wrap';}
      }catch(error){if(root.isConnected)q('[data-scope-result]').textContent=`작업 보류 · ${error.deletionResult?.partial?'부분 완료: 서버 삭제 완료 / 로컬 삭제 실패 · ':''}${error.code||error.message}${error.rollback?.restored===false?' · 일부 값 복구 미완료: '+error.rollback.failures.join(', '):error.rollback?.restored===true?' · 로컬 변경을 원래대로 복구했습니다.':''}`;}
      finally{busy=false;if(root.isConnected)await refresh();}
    };
    await refresh();return true;
  };
  // END OWNER SCOPE MANAGEMENT v1

  const scopedMountConnectionPanel = async (container, panelOptions = {}) => {
    if (!container || typeof container.innerHTML === 'undefined') throw new Error('memory_suite_connection_panel_container_required');
    const bookTheme = String(panelOptions.theme || '').toLowerCase() === 'book';
    const initial = await scopedGetConnectionSettings({ force:true });
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
      #${rootId} .mscx-group{display:grid;gap:6px;border:1px solid var(--border,#34425b);border-radius:9px;padding:10px;min-width:0} #${rootId} .mscx-group>b{font-size:13px} #${rootId} .mscx-group>.muted{font-size:12px;line-height:1.55;overflow-wrap:anywhere} #${rootId} .mscx-group.danger{border-color:#b77c71;border-style:dashed}
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
      #${rootId} .mscx-group{background:#fffaf2;border-color:#cbb89d} #${rootId} .mscx-group.danger{background:#f8ece8;border-color:#b77c71}
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
          <b data-mode-confirm-title>저장 위치 전환 확인</b><p data-mode-confirm-text style="white-space:pre-wrap;overflow-wrap:anywhere"></p>
          <div class="actions"><button type="button" data-mode-confirm-cancel>취소 · 원본 유지</button><button type="button" class="primary" data-mode-confirm-approve>동의하고 이전</button></div>
        </section>
        <details class="mscx-advanced"><summary>고급 작업 <small>상황별 관리 도구</small></summary><div class="mscx-advanced-body"><div class="muted">평소에는 쓰지 않아도 됩니다. 지금 겪는 상황과 맞는 항목만 사용하세요.</div>
        ${globalModeEnabled ? '<section class="mscx-group" data-advanced-group="migration"><b>🚚 전체 이전 관리</b><div class="muted">언제: 저장 위치 전체 이전이 진행 중이거나 중간에 멈췄을 때<br>· 중단·보존: 진행 중인 이전을 안전하게 멈춥니다. 원본은 그대로 남습니다.<br>· 재개: 진행 화면의 [중단한 이전 재개] 버튼을 사용합니다. 취소 복구는 [취소 복구 계속]으로 표시됩니다.<br>· 취소·경로 복구: 이미 바뀐 저장 경로를 이전 설정으로 돌립니다. 원본과 서버 사본은 지우지 않습니다.</div><div class="actions"><button data-global-pause>전체 이전 중단·보존</button><button data-global-resume>진행 화면으로 이동</button><button data-global-cancel class="danger" disabled>이전 작업 취소 · 기존 경로 복구</button></div></section>' : ''}
        <section class="mscx-group" data-advanced-group="restore"><b>🛟 기기 기억 복구</b><div class="muted">언제: 이 기기(RisuAI pluginStorage)의 기억이 사라지거나 손상됐을 때. 서버에 보존된 정본으로 현재 스코프를 되살립니다.</div><div class="actions"><button data-restore>서버 → pluginStorage 복구</button></div></section>
        <section class="mscx-group" data-advanced-group="reset"><b>♻️ 서버 초기화·복원 이후 선택</b><div class="muted">언제: "서버 자료가 초기화 또는 복원되었습니다" 안내가 떴을 때만 사용합니다. 둘 중 하나를 고른 뒤 RisuAI를 새로고침하세요.<br>· 서버 자료 사용(권장): 복원된 서버 기억을 그대로 씁니다.<br>· 로컬 기억 다시 업로드: 이 기기의 기억으로 서버를 다시 채웁니다.</div><div class="actions"><button data-reset-empty>서버 자료 사용 · 로컬 업로드 안 함</button><button data-reset-upload>초기화 후 로컬 기억 다시 업로드</button></div></section>
        ${globalModeEnabled ? '<section class="mscx-group" data-advanced-group="server-cleanup"><b>📦 플러그인으로 이동한 서버 사본 정리</b><div class="muted">먼저 플러그인 단독을 선택하고 설정 적용으로 전체 자료 이동을 완료하세요. 이동 후 플러그인 사본과 일치하는 서버 자료를 확인하고 삭제합니다. 삭제 전 서버 백업을 만듭니다.</div><div class="actions"><button type="button" data-server-delete>이동 완료한 서버 사본 검토 · 삭제</button></div></section>' : ''}
        <section class="mscx-group danger" data-advanced-group="cleanup"><b>🗑️ 기기 저장 공간 정리 · 주의</b><div class="muted">${globalModeEnabled ? '언제: 서버 단독으로 옮긴 뒤 이 기기에 남은 중복 pluginStorage 사본을 지우고 싶을 때. 서버 보존을 먼저 검증하고, 한 번 더 눌러야 삭제됩니다.' : '언제: 현재 스코프를 서버 단독으로 옮긴 뒤 이 기기의 중복 사본을 지우고 싶을 때. 서버 보존을 먼저 검증하고, 한 번 더 눌러야 삭제됩니다.'}</div><div class="actions"><button class="danger" data-delete>${globalModeEnabled ? '중복 pluginStorage 전체 삭제' : '현재 스코프 pluginStorage 삭제'}</button></div></section></div></details><div class="status"><div data-current-mode></div><div data-status>서버 상태를 확인할 수 있습니다.</div></div>
        <details data-preview-diagnostics hidden><summary>이전 검사 상세 · 대화 본문과 API 키 제외</summary><textarea data-preview-diagnostics-text aria-label="이전 검사 상세" readonly style="width:100%;min-height:180px"></textarea></details>
      </div>
      <section id="${rootId}-cleanup" data-cleanup-dialog hidden role="dialog" aria-modal="true" aria-label="사본 정리 진행" style="display:none;position:fixed;inset:0;z-index:2147483000;background:#0009;align-items:center;justify-content:center;padding:12px">
        <style>
          #${rootId}-cleanup .mscx-cleanup-box{background:${bookTheme?'#fffaf2':'#111a2a'};color:${bookTheme?'#392b20':'#e8eefc'};font-family:system-ui,sans-serif;border:1px solid #8190a5;border-radius:16px;padding:20px;width:min(900px,100%);max-height:94vh;overflow:auto;display:grid;gap:12px;box-sizing:border-box}
          #${rootId}-cleanup .mscx-cleanup-item{display:flex;align-items:start;justify-content:space-between;gap:16px;border-top:1px solid #8190a566;padding:12px 0;min-width:0}
          #${rootId}-cleanup .mscx-cleanup-item>div{min-width:0;flex:1;overflow-wrap:anywhere} #${rootId}-cleanup .mscx-cleanup-item small{display:block;margin:6px 0}
          #${rootId}-cleanup .mscx-cleanup-item select{max-width:100%;padding:8px;background:${bookTheme?'#fffaf2':'#172236'};color:${bookTheme?'#392b20':'#e8eefc'};font-family:system-ui,sans-serif;border:1px solid #8190a5;border-radius:8px}
          #${rootId}-cleanup [data-cleanup-items]{max-height:48vh;overflow:auto} #${rootId}-cleanup [data-cleanup-current],#${rootId}-cleanup [data-cleanup-errors]{overflow-wrap:anywhere;white-space:pre-wrap}
          #${rootId}-cleanup [data-cleanup-summary]{white-space:pre-wrap} #${rootId}-cleanup [data-cleanup-progress]{width:100%;height:14px}
          @media(max-width:600px){#${rootId}-cleanup .mscx-cleanup-item{flex-direction:column;gap:6px}}
          #${rootId}-cleanup .actions{display:flex;flex-wrap:wrap;gap:8px} #${rootId}-cleanup button{padding:10px 14px;border:1px solid #8190a5;border-radius:8px;color:inherit;background:${bookTheme?'#f5ebdc':'#172236'};cursor:pointer} #${rootId}-cleanup button:disabled{opacity:.5;cursor:default}
        </style>
        <div class="mscx-cleanup-box"><h3 data-cleanup-title>사본 정리</h3>
          <b data-cleanup-phase role="status" aria-live="polite"></b><progress data-cleanup-progress max="1" value="0"></progress>
          <div data-cleanup-count></div><small data-cleanup-current></small><p data-cleanup-summary></p>
          <p class="muted">보존·제외한 항목은 이번 작업에서 삭제하지 않습니다. 일치하는 사본만 삭제 대상으로 기본 선택됩니다. 서버 자료는 보존한 대화에서 참조하는 자료도 함께 보존됩니다.</p>
          <div data-cleanup-items></div><label data-cleanup-ack-row hidden><input type="checkbox" data-cleanup-ack> 서버에 보존되지 않은 로컬 사본도 삭제하도록 직접 선택했으며, 해당 기기 자료가 사라지는 데 동의합니다.</label>
          <pre data-cleanup-errors></pre><div class="actions"><button type="button" data-cleanup-close>닫기</button><button type="button" data-cleanup-stop hidden>중단 요청</button><button type="button" class="danger" data-cleanup-continue disabled>선택한 사본 삭제</button></div>
        </div>
      </section>
      <div class="job" data-job><b data-job-title>작업 진행 중</b><div class="bar"><i data-job-bar></i></div><div class="grid"><span data-job-phase></span><span data-job-count></span><span data-job-bytes></span><span data-job-time></span><span data-job-retry></span><span data-job-key></span></div><div class="muted" data-job-workflow style="white-space:pre-wrap;margin:8px 0"></div><div class="muted" data-job-transfer style="white-space:pre-wrap;margin:8px 0"></div><div class="result" data-job-result></div><textarea data-job-diagnostics aria-label="저장 이전 상세 진단" readonly style="display:none"></textarea><button data-job-copy type="button">상세 진단 복사</button><div class="actions" data-job-stalled-actions style="display:none;margin-top:6px;gap:8px"><button data-job-retry class="primary" type="button">즉시 재시도</button><button data-job-cancel class="danger" type="button">이전 작업 취소 · 기존 모드 유지</button></div><div class="actions" data-job-terminal-actions style="display:none"><button data-job-dismiss type="button">결과 확인 닫기</button></div></div>
    </div>`;
    const root = container.querySelector(`#${rootId}`);
    const q = sel => root.querySelector(sel);
    const renderAppliedMode = settings => {
      const mode = globalModeEnabled
        ? (settings?.global?.mode || MODE_PLUGIN_ONLY)
        : (settings?.scopeId ? settings.mode : (settings?.mode || MODE_PLUGIN_ONLY));
      q('[data-current-mode]').textContent = globalModeEnabled
        ? `현재 전역 모드: ${modeLabel(mode)}`
        : `현재 모드: ${settings?.scopeId ? settings.modeLabel : '현재 스코프 확인 불가'}`;
    };
    renderAppliedMode(initial);
    const panelJobDiagnostics = job => ({...syncJobDiagnostics(job),
      ...(globalMigrationPreview?{migrationPreview:cloneDiagnosticValue(globalMigrationPreview)}:{})});
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
      q('[data-delete]').disabled=active;
      if(globalModeEnabled)q('[data-server-delete]').disabled=active;
      if(active){const serverOnly=root.querySelector(`input[name="${rootId}-mode"][value="server_only"]`);if(serverOnly)serverOnly.checked=true;}
      syncModePresentation();
    };
    applyRecoveryGuard(initial.recoveryRequired);
    for(const input of root.querySelectorAll(`input[name="${rootId}-mode"]`)) input.addEventListener('change',syncModePresentation);
    syncModePresentation();
    const formatBytes = bytes => { const n=Math.max(0,Number(bytes||0)); if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; };
    let dismissedJobId=state.syncJob.dismissedJobId || (getSyncJob()?.dismissed ? getSyncJob().jobId : ''),terminalRefreshId='',manualResumePromise=null;
    const renderJob = job => {
      const card=q('[data-job]');
      if(globalModeEnabled){
        q('[data-global-cancel]').disabled=job?.kind!=='global_mode'||syncJobTerminal(job.status);
        const pendingGlobal=job?.kind==='global_mode'&&!syncJobTerminal(job.status);
        q('[data-global-resume]').textContent='진행 화면으로 이동';q('[data-global-resume]').disabled=!pendingGlobal;
        q('[data-apply]').textContent=pendingGlobal?'진행 화면으로 이동':'설정 적용';
        q('[data-global-cancel]').textContent=globalRollbackPending(job)?'취소 복구 진행 화면 보기':'이전 작업 취소 · 기존 경로 복구';
        q('[data-global-cancel]').disabled=q('[data-global-cancel]').disabled||!!manualResumePromise;
      }
      if (!job || (job.kind !== 'global_mode' && job.scopeId !== initial.scopeId) || job.jobId === dismissedJobId || job.jobId === state.syncJob.dismissedJobId || job.dismissed === true) { card.classList.remove('show','terminal','failed'); return; }
      const terminal=syncJobTerminal(job.status),showResult=terminal||job.status==='paused';
      const rollback=globalRollbackView(job),waiting=job.status==='paused'&&job.phase==='recovery_pending';
      const workflow=job.kind==='global_mode'?globalWorkflowView(globalJobWorkflow(job)):null;
      q('[data-job-workflow]').textContent=workflow?`${workflow.title}\n${workflow.detail}\n현재 전체 설정: ${modeLabel(job.effectiveMode||job.sourceMode)}${globalRollbackPending(job)||job.rollbackComplete?'':` · 목표 설정: ${modeLabel(job.targetMode)}\n진행률은 대화 검증 기준이며, 이미 옮긴 자료 재조회도 포함합니다.`}`:'';
      const progress=job.currentProgress;
      const hasCopyCounts=progress&&['matched','uploaded','restored'].some(key=>Object.hasOwn(progress,key));
      q('[data-job-transfer]').textContent=job.kind==='global_mode'&&!globalRollbackPending(job)&&!job.rollbackComplete
        ? progress?.dryRun?'현재 대화: 전송 전 비교 검사 중 · 실제 전송 전':hasCopyCounts?`현재 대화: 일치 확인 ${Number(progress.matched||0).toLocaleString()}건 · 새 전송 ${Number(progress.uploaded||0).toLocaleString()}건 · 기기 복원 ${Number(progress.restored||0).toLocaleString()}건`:'대화 검증 진행률입니다. 기존 자료 조회도 포함하며, 일치하는 기억 자료는 다시 업로드하지 않습니다.'
        :'';
      card.classList.add('show'); const total=Math.max(0,Number(job.kind==='global_mode'?job.discoveredScopes||0:job.totalItems||0)), done=Math.max(0,Number(job.kind==='global_mode'?job.verifiedScopes||0:job.processedItems||0)); const percent=rollback?rollback.percent:total?Math.min(100,Math.round(done/total*100)):0;
      card.classList.toggle('terminal',terminal); card.classList.toggle('failed',job.status==='failed');
      q('[data-job-title]').textContent = `${rollback?rollback.title:waiting?'이전 중단 · 조치 필요':job.message || (terminal?'작업 결과':'작업 진행 중')}${total ? ` · ${terminal&&job.status==='completed'?100:percent}%` : ''}`; q('[data-job-bar]').style.width=`${terminal&&job.status==='completed'?100:percent}%`;
      const phaseLabel=job.serverWait?.active&&job.status==='running'?'서버 작업 종료 대기':job.phase==='final_verify'?'최종 저장 상태 검증':job.phase||'준비';
      q('[data-job-phase]').textContent=`현재 단계: ${rollback?rollback.phase:waiting?'조치 대기 · 자동 진행하지 않음':phaseLabel}`; q('[data-job-count]').textContent=rollback?rollback.count:`${job.kind==='global_mode'?'대화 검증':'진행'}: ${done.toLocaleString()} / ${total || terminal ? total.toLocaleString() : '조사 중'}${job.status==='completed' && total===0 ? ' · 이동할 데이터 없음' : ''}`;
      q('[data-job-bytes]').textContent=rollback?`복구 대상 경로: ${Number(job.rollbackProgress?.restoredScopes||0).toLocaleString()}개 · 전체 설정 포함 · 원본과 서버 사본 보존`:job.kind==='global_mode'
        ? job.rollbackComplete?'저장 경로 복구 완료':job.status==='completed'?'전체 대화 검증 완료':terminal?'이전 작업 종료 · 결과를 확인하세요.':progress?.dryRun?'전송 전 비교 검사 중':progress&&Object.hasOwn(progress,'transferredBytes')?`현재 대화 확인: ${formatBytes(progress.processedBytes)} · 현재 대화 전송: ${formatBytes(progress.transferredBytes)}`:'기존 자료를 조회·검증하고 있습니다. 전송량은 대화별로 표시합니다.'
        :`처리: ${formatBytes(job.processedBytes)} · 전송: ${formatBytes(job.transferredBytes)}`; q('[data-job-time]').textContent=rollback?rollback.time:`${waiting?'중단까지':'경과'}: ${Math.max(0,Math.floor(((waiting?Number(job.updatedAt):Date.now())-Number(job.startedAt||Date.now()))/1000))}초`;
      q('[data-job-retry]').textContent=`재시도 ${Number(job.retryCount||0)} · 실패 ${Number(job.failures||0)}`; q('[data-job-key]').textContent=rollback?`현재: ${rollback.stage}${job.currentScopeId?' · '+job.currentScopeId:''}`:`현재: ${job.currentKey || job.currentAction || '-'}`;
      const stalledActions = q('[data-job-stalled-actions]');
      const isPaused = job.status === 'paused';
      const isFailed = job.status === 'failed';
      if (stalledActions) {
        stalledActions.style.display = (isPaused || isFailed) ? 'flex' : 'none';
      }
      const retryBtn = q('button[data-job-retry]');
      if(retryBtn){retryBtn.textContent=job.kind==='global_mode'?globalResumeLabel(job):'즉시 재시도';if(job.kind==='global_mode')retryBtn.disabled=!!manualResumePromise;}
      if (retryBtn && !retryBtn.dataset.bound) {
        retryBtn.dataset.bound = '1';
        retryBtn.onclick = async () => {
          if(getSyncJob()?.kind==='global_mode')return await resumeFromPanel();
          retryBtn.disabled = true;
          setMessage('작업 재시도를 시작합니다…');
          try {
            await scopedResumePendingSyncJob();
            renderJob(getSyncJob());
          } catch (error) {
            setMessage(`재시도 시작 실패: ${error?.message || error}`, 'error');
            retryBtn.disabled = false;
          }
        };
      }
      const cancelBtn = q('button[data-job-cancel]');
      if(cancelBtn){cancelBtn.textContent=job.kind==='global_mode'?'이전 작업 취소 · 기존 경로 복구':'이전 작업 취소 · 기존 모드 유지';cancelBtn.style.display=globalRollbackPending(job)?'none':'';if(job.kind==='global_mode')cancelBtn.disabled=!!manualResumePromise;}
      if (cancelBtn && !cancelBtn.dataset.bound) {
        cancelBtn.dataset.bound = '1';
        cancelBtn.onclick = async () => {
          cancelBtn.disabled = true;
          setMessage('작업을 취소하고 원래 상태로 복구하고 있습니다…');
          try {
            await scopedCancelSyncJob();
            await refreshPanelSettings();
            renderJob(getSyncJob());
            setMessage('이전 작업을 취소했습니다. 기존 모드와 원본 데이터가 유지됩니다.', 'good');
          } catch (error) {
            setMessage(`취소 실패: ${error?.message || error}`, 'error');
            cancelBtn.disabled = false;
          }
        };
      }
      const terminalActions=q('[data-job-terminal-actions]'); terminalActions.style.display=terminal?'flex':'none';
      const result=job.result&&typeof job.result==='object'?job.result:{};
      const guidance=syncJobActionGuidance(job.error,job.errorDetails,job);
      q('[data-job-result]').style.display=showResult?'block':'none';
      q('[data-job-result]').textContent=showResult
        ? [rollback?rollback.title:job.status==='completed'?'완료 결과':job.status==='paused'?'작업 보류':'실패 결과',`요청 모드: ${modeLabel(job.requestedMode || job.targetMode || initial.mode)}`,`현재 적용 모드: ${modeLabel(job.effectiveMode || result.effectiveMode || job.sourceMode || initial.mode)}`,job.status==='failed'?'전환 미완료 · 현재 적용 모드를 확인하세요.':'',rollback?rollback.count:job.kind==='global_mode'?`대화 검증 ${Number(job.verifiedScopes||0)} / ${Number(job.discoveredScopes||0)} · 일치 자료는 재전송 없이 확인`:`복원 ${Number(job.restored||result.restored||0)} · 업로드 ${Number(job.uploaded||result.uploaded||0)} · 일치 ${Number(job.matched||result.matched||0)}`,job.kind==='global_mode'?'':`삭제 표식 ${Number(job.removedByTombstone||result.removed||0)} · 검증 ${Number(result.verified||0)}`,job.kind==='global_mode'&&!terminal?`전체 이전 보호: 활성 · ${globalRollbackPending(job)?'취소 복구':'이전'}가 끝나면 기억 읽기·쓰기가 재개됩니다.`:job.recoveryRequired?'복구 필수 잠금: 활성 · 서버 단독 유지':'복구 필수 잠금: 없음',job.error?`오류: ${job.error}`:'',guidance?`사유: ${guidance.blockerReason}\n대처 방법: ${guidance.actionRequired}`:''].filter(Boolean).join('\n')
        : '';
      if(terminal&&globalWarningText(result))q('[data-job-result]').textContent+='\n'+globalWarningText(result);
      const diagnosticText = JSON.stringify(panelJobDiagnostics(job),null,2);
      const diagnosticBox = q('[data-job-diagnostics]');
      if(diagnosticBox){
        if(diagnosticBox.ownerDocument?.activeElement!==diagnosticBox)diagnosticBox.value=diagnosticText;
        diagnosticBox.style.display=showResult||diagnosticBox.dataset.revealed==='1'?'block':'none';
      }
      const copyButton=q('[data-job-copy]');
      if(copyButton&&!copyButton.dataset.bound){copyButton.dataset.bound='1';copyButton.onclick=async()=>{
        const box=q('[data-job-diagnostics]');if(!box)return;
        box.value=JSON.stringify(panelJobDiagnostics(getSyncJob()),null,2);box.dataset.revealed='1';box.style.display='block';
        let copied=false;
        try{if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){await navigator.clipboard.writeText(box.value);copied=true;}}catch(_){}
        if(!copied){try{box.focus();box.select();box.setSelectionRange?.(0,box.value.length);copied=(box.ownerDocument||document).execCommand?.('copy')===true;}catch(_){}}
        if(copied)setMessage('상세 진단을 복사했습니다.','good');
        else{setMessage('자동 복사를 사용할 수 없습니다. 아래 진단이 선택되어 있습니다. Ctrl+C 또는 ⌘C로 복사해 주세요.');box.focus();box.select();box.setSelectionRange?.(0,box.value.length);}
      };}
      if(terminal&&job.jobId!==terminalRefreshId){terminalRefreshId=job.jobId;scheduleLifecycleTimeout(()=>{void refreshPanelSettings();},0);}
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
        renderAppliedMode(settings);
        lastSettings = {
          mode: normalizeMode(settings.mode),
          modeExplicit: settings.modeExplicit === true,
          inheritedFromGlobal: settings.inheritedFromGlobal === true,
          global: settings.global && typeof settings.global === 'object' ? settings.global : { set:false, mode:MODE_PLUGIN_ONLY }
        };
        const pending=getSyncJob();
        if(globalModeEnabled&&(!pending||syncJobTerminal(pending.status))){
          const actual=settings.global?.mode||MODE_PLUGIN_ONLY;
          for(const input of root.querySelectorAll(`input[name="${rootId}-mode"]`))input.checked=input.value===actual;
        }
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
        const pending=getSyncJob();
        scopeNoteNode.textContent=globalRollbackPending(pending)?'이전 취소 · 원래 저장 경로 복구 중입니다. 서버 사본은 보존됩니다.':pending?.kind==='global_mode'&&!syncJobTerminal(pending.status)
          ? `현재 전체 설정: ${modeLabel(lastSettings.global?.mode||MODE_PLUGIN_ONLY)} · 목표: ${modeLabel(pending.targetMode)} · 전체 검증 전이라 전환은 아직 미완료입니다.`
          : '전역 단일 설정 · 이 플러그인의 모든 대화를 확인합니다. 기존 서버 자료가 있으면 비교 후 일치 항목의 재전송을 건너뜁니다.';
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
      const workflow=preview?.workflow?globalWorkflowView(preview.workflow):null;
      if(preview?.workflow?.kind==='local_cancel')question='예전 이전 작업을 취소하고 원래 기기 저장 경로로 돌아가시겠습니까? 현재 서버에 자료를 전송하거나 서버 자료를 바꾸지 않습니다.';
      else if(preview?.workflow?.kind==='rollback')question='기억 원본과 서버 사본을 보존한 채 저장 경로 복구를 계속하시겠습니까?';
      else if(workflow&&preview.workflow.kind!=='initial')question=`검증이 모두 끝나면 ${modeLabel(toMode)} 설정이 적용됩니다. 계속하시겠습니까?`;
      if(preview)question=[workflow?.detail,preview.workflow?.kind==='local_cancel'?`기기 원본 ${preview.localSourceRecords}개 · 대화 ${preview.discoveredScopes}개\n적용할 저장 위치: 플러그인 단독`:`이 플러그인의 전체 ${preview.discoveredScopes}개 대화와 과거 개별 경로 ${preview.legacyOverrides}개를 확인했습니다.\n대상: ${modeLabel(toMode)} · ${q('[data-url]').value}`,globalWarningText(preview),question].filter(Boolean).join('\n\n');
      // Host confirm may be asynchronous or blocked by a sandboxed/Tauri iframe.
      // Consent stays inside the mounted panel and never defaults to approval.
      const panel=q('[data-mode-confirm]'),approve=q('[data-mode-confirm-approve]'),cancel=q('[data-mode-confirm-cancel]'),apply=q('[data-apply]');
      const wasDisabled=apply.disabled;
      q('[data-mode-confirm-title]').textContent=workflow?.title||'저장 위치 전환 확인';
      panel.setAttribute('aria-label',workflow?.title||'저장 위치 전환 확인');
      approve.textContent=workflow?.approve||'동의하고 이전';
      cancel.textContent=(['resume','rollback','local_cancel'].includes(preview?.workflow?.kind)||preview?.workflow?.newCheckRequired)?'닫기 · 미완료 작업 유지':'취소 · 원본 유지';
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

    const showPendingJob = () => {
      const job=getSyncJob();
      focusSyncJobPanel(root);
      setMessage(job?.kind==='global_mode'&&!syncJobTerminal(job.status)
        ? `미완료 작업은 진행 화면의 [${globalResumeLabel(job)}]에서 계속합니다.`
        : '현재 재개할 미완료 작업이 없습니다.');
    };
    const resumeFromPanel = () => {
      if(manualResumePromise)return manualResumePromise;
      const operation=(async()=>{
        try{
          await loadPersistedSyncJob();const job=getSyncJob();
          if(job?.kind!=='global_mode'||syncJobTerminal(job.status)){showPendingJob();return job;}
          if(globalJobRunning||modeConfigurationBusy){setMessage('이전이 진행 중입니다. 이 진행 화면에서 상태를 확인하세요.');return job;}
          const label=globalResumeLabel(job);
          if(normalizeServerUrl(q('[data-url]').value)!==job.targetUrl)throw globalModeError('MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');
          setMessage(`[${label}] · 기록된 작업과 서버를 확인하고 있습니다…`);
          let result;
          if(globalLocalCancellationNeeded(job)&&!job.localCancellationIntent){
            setMessage('기기에 남은 이전 원본을 검증하고 있습니다. 현재 서버는 변경하지 않습니다.');
            const preview=await previewLocalCancellation();
            if(!await confirmModeTransition(MODE_PLUGIN_ONLY,MODE_PLUGIN_ONLY,preview)){setMessage('확인창을 닫았습니다. 미완료 작업과 현재 서버는 유지됩니다.');return getSyncJob();}
            if(!root.isConnected||getSyncJob()?.jobId!==job.jobId||syncJobTerminal(getSyncJob()?.status)||normalizeServerUrl(q('[data-url]').value)!==job.targetUrl)throw globalModeError('MEMORY_SUITE_LOCAL_CANCEL_SOURCE_CHANGED');
            result=await scopedCancelSyncJob({localOnly:true,previewFingerprint:preview.fingerprint});
          }
          else if(globalRollbackPending(job))result=await scopedCancelSyncJob();
          else{
            // Every explicit resume gets a fresh connection, including after an
            // offline startup. The admitted server pin still guards all writes.
            await bootstrap(true,true);
            const options={url:job.targetUrl};
            let reviewNeeded=false;
            if(['MEMORY_SUITE_GLOBAL_SOURCE_CHANGED','MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'].includes(job.error)){
              const inventory=await collectGlobalInventory(job.targetMode,{url:job.targetUrl});
              try{await assertGlobalPlanCurrent(job,inventory,true);}
              catch(error){if(['MEMORY_SUITE_GLOBAL_SOURCE_CHANGED','MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'].includes(error.code))reviewNeeded=true;else throw error;}
            }
            if(reviewNeeded){
              const preview=await previewGlobalMode(job.targetMode,{url:job.targetUrl});
              if(!preview.completeKnownScopes){
                q('[data-preview-diagnostics-text]').value=JSON.stringify({schema:'memory-suite.migration-preview-diagnostics.v1',namespace,discoveredScopes:preview.discoveredScopes,blockers:preview.blockers.map(globalIssueMetadata),...globalWarningMetadata(preview)},null,2);
                q('[data-preview-diagnostics]').hidden=false;
                setMessage(`재검사 보류 · 미해결 ${preview.blockers.length}개. 상세 진단에서 원인을 확인한 뒤 진행 화면의 [${label}]를 사용하세요.`,'error');return getSyncJob();
              }
              const selection=JSON.stringify([q('[data-url]').value,selectedMode()]);
              if(!await confirmModeTransition(lastSettings.global?.mode||MODE_PLUGIN_ONLY,job.targetMode,preview)){
                setMessage('확인창을 닫았습니다. 기존 미완료 작업은 유지됩니다.');return getSyncJob();
              }
              if(!root.isConnected||selection!==JSON.stringify([q('[data-url]').value,selectedMode()])||getSyncJob()?.jobId!==job.jobId||syncJobTerminal(getSyncJob()?.status)){
                setMessage(`확인 중 대상이나 작업이 바뀌었습니다. 진행 화면의 [${label}]에서 다시 확인하세요.`,'error');return getSyncJob();
              }
              Object.assign(options,{previewFingerprint:preview.inventoryFingerprint,refreshInventory:true});
            }
            result=await withModeConfiguration(()=>persistGlobalModeAllChats(job.targetMode,options));
          }
          await refreshPanelSettings();renderJob(getSyncJob());
          setMessage(result?.rollbackComplete?'취소 복구 완료 · 이전 저장 경로로 돌아왔습니다. 서버 사본은 보존했습니다.':result?.completeKnownScopes?'중단된 이전을 재개하여 전체 검증을 완료했습니다.':`미완료 작업을 보존했습니다. 진행 화면의 [${globalResumeLabel(getSyncJob())}]에서 계속할 수 있습니다.`,result?.rollbackComplete||result?.completeKnownScopes?'good':'');
          return result;
        }catch(error){
          if(String(error.code||'').startsWith('MEMORY_SUITE_LOCAL_CANCEL_')&&getSyncJob()?.kind==='global_mode'&&!syncJobTerminal(getSyncJob().status)){
            await globalSaveJob({error:error.code,errorDetails:{...error.details,cause:'MEMORY_SUITE_JOB_SERVER_PIN_CHANGED'},status:'paused',phase:'recovery_pending'});
            renderJob(getSyncJob());
          }
          const job=getSyncJob(),guidance=syncJobActionGuidance(error.code||error.message,error.details,job);
          setMessage(guidance?`${guidance.blockerReason}\n${guidance.actionRequired}`:`재개 보류 · ${error.code||error.message}`,'error');
          return job;
        }
      })();
      manualResumePromise=operation;renderJob(getSyncJob());
      const finish=()=>{manualResumePromise=null;if(root.isConnected)renderJob(getSyncJob());};
      operation.then(finish,finish);
      return operation;
    };
    q('[data-apply]').onclick = async()=>{
      if(q('[data-apply]').disabled)return;
      const pending=getSyncJob();
      if(globalModeEnabled&&pending?.kind==='global_mode'&&!syncJobTerminal(pending.status)){showPendingJob();return;}
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
            if(!preview.completeKnownScopes||preview.warningCount>0){
              q('[data-preview-diagnostics-text]').value=JSON.stringify({schema:'memory-suite.migration-preview-diagnostics.v1',namespace,discoveredScopes:preview.discoveredScopes,
                blockers:preview.blockers.map(globalIssueMetadata),...globalWarningMetadata(preview)},null,2);
              q('[data-preview-diagnostics]').hidden=false;
            }
            if(!preview.completeKnownScopes){
              renderJob(getSyncJob());
              setMessage(`새 이전 검사에서 미해결 항목이 발견되었습니다. 발견 ${preview.discoveredScopes}개 · 미해결 ${preview.blockers.length}개\n이 검사로 저장 설정은 변경되지 않았습니다.\n${preview.blockers.slice(0,16).map(row=>[row.code,row.location,row.space,row.key,row.detail].filter(Boolean).join(' · ')).join('\n')}`,'error');return;}
            if(!(await confirmModeTransition(fromMode,mode,preview))){setMessage(['resume','rollback'].includes(preview.workflow?.kind)?'확인창을 닫았습니다. 기존 미완료 작업은 유지됩니다.':'이번 이전 신청을 취소했습니다. 원본과 저장 경로는 그대로입니다.','good');return;}
            if(!selectionCurrent()){setMessage('확인 중 대상 설정이 바뀌었습니다. 다시 적용해 주세요.','error');return;}
            setMessage([preview.workflow?globalWorkflowView(preview.workflow).title+'\n'+globalWorkflowView(preview.workflow).detail:'',`전체 ${preview.discoveredScopes}개 대화 · 과거 개별 경로 ${preview.legacyOverrides}개\n${q('[data-url]').value}\n복사·재조회 검증 후 전역 설정을 적용합니다.`,globalWarningText(preview)].filter(Boolean).join('\n'));
            const result=await withModeConfiguration(()=>persistGlobalMode(mode,{source:'user_global_setting',url:q('[data-url]').value,previewFingerprint:preview.inventoryFingerprint,refreshInventory:true}));
            await refreshPanelSettings();renderJob(getSyncJob());
            if(result.completeKnownScopes===true)setMessage([`전역 설정 적용 완료 · ${modeLabel(mode)}\n전체 ${result.verifiedScopes}/${result.discoveredScopes}개 대화 검증 완료. 새 대화도 이 설정을 따릅니다.`,globalWarningText(result)].filter(Boolean).join('\n'),'good');
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
      q('[data-global-cancel]').onclick=async()=>{if(globalRollbackPending(getSyncJob())){showPendingJob();return;}const button=q('[data-global-cancel]');button.disabled=true;try{const result=await scopedCancelSyncJob();await refreshPanelSettings();renderJob(getSyncJob());setMessage(result?.rollbackComplete?'이전 작업을 취소하고 저장 경로를 이전 설정으로 복구했습니다. 원본과 서버 사본은 보존했습니다.':'취소를 요청했습니다. 현재 스코프 처리가 끝나면 저장 경로를 복구합니다.','good');}catch(error){renderJob(getSyncJob());setMessage(`경로 복구 보류: ${error.code||error.message}`,'error');}};
      q('[data-global-pause]').onclick=async()=>{try{await pauseGlobalModeJob();setMessage('중단을 요청했습니다. 진행 중인 복사 검증을 마친 뒤 원본과 현재 경로를 보존합니다.');renderJob(getSyncJob());}catch(error){setMessage(error.code || error.message,'error');}};
      q('[data-global-resume]').onclick=showPendingJob;
    }
    refreshScopeNote();
    q('[data-restore]').onclick = async()=>{ try{const job=await scopedStartRestoreJob({scope:initial.scope});setMessage('현재 스코프 복구를 시작했습니다.');renderJob(job);}catch(error){setMessage(`복구 시작 실패\n${error?.userMessage||error?.message||error}`,'error');} };
    const cleanupDialog=globalModeEnabled?bindDuplicateCleanupDialog(root,{setMessage,refreshPanelSettings}):null;
    if(globalModeEnabled)q('[data-server-delete]').onclick=()=>cleanupDialog.open('server');
    let armedUntil=0;
    q('[data-delete]').onclick=async()=>{
      if(globalModeEnabled)return cleanupDialog.hasReview()?await cleanupDialog.execute():await cleanupDialog.open('local');
      const button=q('[data-delete]');button.disabled=true;
      try{
        if(Date.now()>armedUntil){
          await assertRecoveryActionAllowed(initial.scope,'delete_pluginstorage');
          const checked=await scopedVerifyPreservation(state.legacy.plugin,{scope:initial.scope});
          armedUntil=Date.now()+30000;button.textContent='검증 완료 · 다시 눌러 삭제';
          setMessage(`보존 검증 완료 · ${checked.checked}개\n30초 안에 다시 누르면 현재 스코프의 payload만 삭제합니다.`,'good');return;
        }
        armedUntil=0;
        const result=await scopedDeletePluginStorageAfterVerification({scope:initial.scope});
        button.textContent='현재 스코프 pluginStorage 삭제';setMessage(`삭제 완료 · ${result.deleted}개\n현재 스코프는 서버 단독입니다.`,'good');
      }catch(error){armedUntil=0;button.textContent='현재 스코프 pluginStorage 삭제';setMessage(`삭제 차단\n${error?.userMessage||error?.message||error}`,'error');}
      finally{button.disabled=false;}
    };
    q('[data-job-dismiss]').onclick=()=>{const job=getSyncJob();if(job&&syncJobTerminal(job.status)){dismissedJobId=job.jobId;state.syncJob.dismissedJobId=job.jobId;try{updateSyncJob({dismissed:true},{persist:'immediate'});}catch(_){}renderJob(job);}};
    const unsubscribe=subscribeSyncJob(renderJob); const tick=setInterval(()=>{if(!root.isConnected){clearInterval(tick);unsubscribe();return;}renderJob(getSyncJob());},1000); try{tick?.unref?.();}catch(_){}
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
  const getCachedDiagnostics = () => withMigrationPreview(cloneDiagnosticValue(state.diagnostics.value) || {
    schema: 'memory-suite.plugin-server-diagnostics.v1',
    generatedAt: 0,
    reachable: null,
    namespace,
    pluginId,
    pluginVersion,
    status: { ...state.status },
    reason: 'diagnostics_not_loaded'
  });
  const getDiagnostics = async (options = {}) => {
    const force = options.force === true;
    const maxAgeMs = Math.max(0, Math.min(10 * 60 * 1000, Number(options.maxAgeMs ?? 30000) || 0));
    if (!force && state.diagnostics.value && Date.now() - Number(state.diagnostics.at || 0) <= maxAgeMs) return getCachedDiagnostics();
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
          return getCachedDiagnostics();
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
          return getCachedDiagnostics();
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
        return getCachedDiagnostics();
      } catch (error) {
        const result = await offlineDiagnostics(error, false);
        state.diagnostics.value = result;
        state.diagnostics.at = Date.now();
        return getCachedDiagnostics();
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
    cleanupDialogController?.dispose();cleanupDialogController=null;
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
  const validateConditionalBatchRecord = async (row, lease = null) => {
    let stage = null;
    try {
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
    } finally { stage?.release(); }
  };

  const conditionalBatchRecord = async (space, key, readObserver = null) => {
    const lease = readObserver ? readObserver() : null;
    try { return await validateConditionalBatchRecord(await remoteGet(space,key,{allowPluginOnly:true}),lease); }
    finally { lease?.release(); }
  };
  // Opt-in read batching keeps the same per-value admission and cryptographic
  // validation. The caller sizes each batch from its current shared I/O budget.
  const conditionalBatchRecords = async (routes, readObserver, readBatchSize) => {
    const result=[];
    for(let offset=0;offset<routes.length;){
      const size=readBatchSize?readBatchSize():1;
      if(!Number.isSafeInteger(size)||size<1||size>4)throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SIZE_INVALID');
      const space=routes[offset].space,part=[];
      for(const route of routes.slice(offset,offset+size)){if(route.space!==space)break;part.push(route);}
      offset+=part.length;
      if(part.length===1){result.push(await conditionalBatchRecord(space,part[0].remoteKey,readObserver));continue;}
      const leases=[];
      try{
        for(const _ of part)leases.push(readObserver?readObserver():null);
        const rows=await remoteGetMany(space,part.map(row=>row.remoteKey),{allowPluginOnly:true});
        for(const [index,route]of part.entries()){
          if(!Object.hasOwn(rows?.values||{},route.remoteKey))throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_INVALID');
          result.push(await validateConditionalBatchRecord(rows.values[route.remoteKey],leases[index]));
          leases[index]?.release();leases[index]=null;
        }
      }finally{for(const lease of leases)lease?.release();}
    }
    return result;
  };

  const captureConditionalReadSet = async (keys = [], { readObserver = null, readBatchSize = null } = {}) => {
    if (readObserver !== null && typeof readObserver !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_OBSERVER_INVALID');
    if (readBatchSize !== null && typeof readBatchSize !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SIZE_INVALID');
    if(!Array.isArray(keys)||!keys.length||keys.length>64)throw conditionalBatchError('MEMORY_SUITE_BATCH_ITEM_LIMIT');
    const boundary=await conditionalBatchBoundary(),records=[],seen=new Set(),routes=[];
    for(const key of keys){const route=await conditionalBatchRoute('plugin',key,boundary);
      if(seen.has(route.remoteKey))throw conditionalBatchError('MEMORY_SUITE_BATCH_DUPLICATE_KEY');seen.add(route.remoteKey);
      routes.push(route);
    }
    const rows=await conditionalBatchRecords(routes,readObserver,readBatchSize);
    for(const [index,route]of routes.entries()){
      const row=rows[index];
      records.push({...route,revision:row.revision,digest:row.digest,exists:row.exists,tombstone:row.tombstone});
    }
    if(jsonComparable(boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    const data={schema:'memory-suite.storage.read-set.v1',boundary,records,capturedAt:Date.now()};
    return {...data,payloadDigest:await conditionalBatchSHA(data)};
  };
  const assertConditionalReadSet = async (raw, { readObserver = null, readBatchSize = null } = {}) => {
    if (readObserver !== null && typeof readObserver !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_OBSERVER_INVALID');
    if (readBatchSize !== null && typeof readBatchSize !== 'function') throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SIZE_INVALID');
    const data=conditionalBatchClone(raw || {}),hash=data.payloadDigest;delete data.payloadDigest;
    if(data.schema!=='memory-suite.storage.read-set.v1' || !Array.isArray(data.records)||!data.records.length||data.records.length>64
      || hash!==await conditionalBatchSHA(data))throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SET_INVALID');
    if(jsonComparable(data.boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
    const routes=[];
    for(const saved of data.records){const route=await conditionalBatchRoute(saved.space,saved.key,data.boundary);
      if(route.remoteKey!==saved.remoteKey)throw conditionalBatchError('MEMORY_SUITE_BATCH_ROUTE_CHANGED');
      routes.push(route);
    }
    const rows=await conditionalBatchRecords(routes,readObserver,readBatchSize);
    for(const [index,saved]of data.records.entries()){
      const row=rows[index];
      if(row.revision!==saved.revision||row.digest!==saved.digest||row.exists!==saved.exists||row.tombstone!==saved.tombstone)throw conditionalBatchError('MEMORY_SUITE_BATCH_READ_SET_CHANGED',{storageMutationKey:saved.key});
    }
    if(jsonComparable(data.boundary)!==jsonComparable(await conditionalBatchBoundary()))throw conditionalBatchError('MEMORY_SUITE_BATCH_BOUNDARY_CHANGED');
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
    const graphScope=/^libra:v1:scope:(.+?):memory-graph:v1:/.exec(body.mutations[0]?.key||'')?.[1];
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
  const readReadonlyRoute=async (identity, ownerRead=false, publicationAttempt=0)=>{
    const fence=readonlyRouteFence(),plugin=rawPluginStorage(),device=await rawDeviceStorage({strict:true});
    if(typeof plugin?.getItem!=='function')readonlyRouteFail('READ_ROUTE_STORAGE_UNAVAILABLE');
    const rawScope=(await plugin.getItem('libra:v1:scope-registry:v1'))||(await device?.getItem?.('libra:v1:scope-registry:v1')),registry=readonlyRouteObject(rawScope);
    const key=identity.characterId+'::'+identity.chatId,row=Object.hasOwn(registry,key)?registry[key]:null;
    if(!row||row.characterId!==identity.characterId||row.chatId!==identity.chatId)readonlyRouteFail('READ_ROUTE_SCOPE_UNAVAILABLE');
    const scope={characterId:identity.characterId,chatId:identity.chatId,scopeKey:readonlyRouteId(row.scopeKey)};
    const candidates=[],modePublicationCopies=[];let legacyModeImported=false;
    // One authoritative copy: pluginStorage, or the device backup when it is missing.
    const primaryRouteRaw=await plugin.getItem(SCOPE_ROUTING_LOCAL_KEY);
    for(const store of (primaryRouteRaw!=null&&primaryRouteRaw!==''||!device)?[plugin]:[device]){
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
    if(!['absent','observed'].includes(modePublication.status)){
      // Two stores are published separately. Reobserve a briefly unsettled pair
      // (startup sync on slow hosts needs up to ~1s: 40/80 then 120ms steps, 0.84s),
      // without accepting either half or crossing an authority/configuration fence.
      if(['unsettled','conflict'].includes(modePublication.status)&&publicationAttempt<8){
        await new Promise(resolve=>setTimeout(resolve,Math.min(120,40*2**publicationAttempt)));
        if(fence!==readonlyRouteFence())readonlyRouteFail('READ_ROUTE_AUTHORITY_CHANGED');
        return readReadonlyRoute(identity,ownerRead,publicationAttempt+1);
      }
      throw Object.assign(new Error('READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE'),{
        code:'READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE',modePublicationStatus:modePublication.status,
        modePublicationAttempts:publicationAttempt+1
      });
    }
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
    const reset=await plugin.getItem(resetChoiceKey);let resetWitness=null;
    if(reset!=null&&reset!==''){
      // A saved, already accepted reset choice is not a pending reset. Only the
      // native owner may reuse its certified server binding; observing a route
      // must never bootstrap, accept a reset or expose a retained local copy.
      const connection=state.bootstrap.value;
      let candidate;try{candidate=typeof reset==='string'?JSON.parse(reset):reset;}catch(_){}
      if(!ownerRead||selected.mode===MODE_PLUGIN_ONLY||!resetPreferenceMatches(candidate,connection)
        ||dataBinding.certified!==true||dataBinding.dataInstanceId!==connection.dataInstanceId
        ||dataBinding.url!==(connection.requestedUrl||connection.url)
        ||normalizeServerUrl(await getArgumentValue(urlArguments,defaultUrl))!==(connection.requestedUrl||connection.url)
        ||deletedScopesForResetChoice(candidate).includes(scope.scopeKey))readonlyRouteFail('READ_ROUTE_RESET_UNAVAILABLE');
      resetWitness=JSON.stringify(candidate);
    }
    const currentDevice=await rawDeviceStorage({strict:true});
    if(readonlyRouteFence()!==fence||rawPluginStorage()!==plugin||currentDevice!==device)readonlyRouteFail('READ_ROUTE_CHANGED');
    // Includes only relevant routing rows; unrelated registry entries are harmless.
    return {scope,mode:selected.mode,scopeRow:stored,globalRow:explicit?null:global,modePublication,fence,plugin,device,ownerLocalWitness,resetWitness};
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
    try{const current=await readReadonlyRoute(s.identity,s.ownerRead);readonlyRouteState(input);const binding=v=>JSON.stringify([v.scope,v.mode,v.scopeRow,v.globalRow,v.modePublication,v.fence,v.ownerLocalWitness,v.resetWitness]);
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

  const rejectLocalOwnerManagement = () => withOwnerOperation({kind:'local_only_policy'},async()=>{throw localOnlyError();});
  const localOwnerMode = async scope => ({scope:normalizeScopeDescriptor(scope || await resolveCurrentScope(true)),mode:MODE_PLUGIN_ONLY,modeLabel:modeLabel(MODE_PLUGIN_ONLY),explicit:true,modeOrigin:'owner_policy',localOnly:true,storagePolicy:'local_only'});
  const localOwnerSetMode = async mode => {if(mode !== MODE_PLUGIN_ONLY)throw localOnlyError();return {changed:false,from:MODE_PLUGIN_ONLY,to:MODE_PLUGIN_ONLY,effectiveMode:MODE_PLUGIN_ONLY};};
  const localOwnerConnection = async options => {const row=await localOwnerMode(options?.scope);return {...row,namespace,pluginId,supportedStorageModes:[MODE_PLUGIN_ONLY],serverStorage:false,recoveryRequired:false,transition:null,migrationRequired:false,syncJob:null,executionPolicy:scopeExecutionPolicyFromModeState(row),status:{state:'local_only',mode:MODE_PLUGIN_ONLY,localOnly:true,recoveryRequired:false}};};

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
    cancelSyncJob: scopedCancelSyncJob,
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
    focusSyncJobPanel,
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
    deletePluginStorageAfterServerVerification: (...args) => args[0]?.global === true ? globalDeletePluginStorageAfterVerification(...args) : withModeConfiguration(()=>withOwnerIO('plugin','',()=>scopedDeletePluginStorageAfterVerification(...args))),
    globalVerifyPreservation: (...args) => withModeConfiguration(()=>withOwnerIO('plugin','',()=>globalVerifyPreservation(...args))),
    globalDeletePluginStorageAfterVerification,
    previewDuplicateCleanup: (...args) => withModeConfiguration(()=>inspectDuplicateCleanup(...args)),
    globalDeleteServerDuplicates,
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
    getScopeMode: async (scope, force = false) => await readScopeMode(scope, force),
    // Core3 global changes verify all known scopes before retiring legacy overrides.
    // Other consumers preserve their legacy behavior. `getGlobalMode` reports the saved choice
    // (`set:false` means no governance, which is the pre-global behaviour).
    previewGlobalMode,
    previewLocalCancellation,
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
    }),
    ...(localOnlyOwner ? {
      storagePolicy:'local_only', localOnly:true, supportedStorageModes:Object.freeze([MODE_PLUGIN_ONLY]), serverStorage:false,
      getStorageModeContract:()=>Object.freeze({schema:'memory-suite.storage-mode-contract.v2',operationalModes:Object.freeze([MODE_PLUGIN_ONLY]),storagePolicy:'local_only',localOnly:true,legacyMirrorReadable:false,mirrorSelectable:false}),
      getMode:async()=>MODE_PLUGIN_ONLY,getScopeMode:localOwnerMode,getConnectionSettings:localOwnerConnection,
      getGlobalMode:async()=>({set:false,mode:MODE_PLUGIN_ONLY,storagePolicy:'local_only'}),
      setMode:localOwnerSetMode,setScopeMode:async(_scope,mode)=>localOwnerSetMode(mode),setGlobalMode:localOwnerSetMode,clearGlobalMode:rejectLocalOwnerManagement,
      synchronizeNow:rejectLocalOwnerManagement,startSynchronizationJob:rejectLocalOwnerManagement,startConnectionConfigurationJob:rejectLocalOwnerManagement,startRestoreJob:rejectLocalOwnerManagement,
      resumePendingSyncJob:async()=>({skipped:true,reason:'local_only_owner_policy'}),getSyncJob:()=>null,
      restorePluginStorage:rejectLocalOwnerManagement,restoreServerSpaceToLegacy:rejectLocalOwnerManagement,
      configureConnection:rejectLocalOwnerManagement,setServerUrl:rejectLocalOwnerManagement,
      prepareServerScopeDeletion:rejectLocalOwnerManagement,deletePluginStorageAfterServerVerification:rejectLocalOwnerManagement,
      migrateWholeData:rejectLocalOwnerManagement,retireNativeBranchLocalTargetData:rejectLocalOwnerManagement,acceptServerReset:rejectLocalOwnerManagement,
      mountConnectionPanel:rejectLocalOwnerManagement,openManagementDialog:rejectLocalOwnerManagement,
      status:()=>({state:'local_only',mode:MODE_PLUGIN_ONLY,localOnly:true,storagePolicy:'local_only',serverStorage:false,syncJob:null,transition:null,migrationRequired:false})
    } : {})
  });
  scheduleManagementRegistration();
  if (startupDiagnosticsEnabled) {
    const startupDiagnosticsDelayMs = Math.max(1200, Math.min(15000, Number(options.startupDiagnosticsDelayMs || (3500 + (namespaceDelaySeed % 7) * 350)) || 3500));
    scheduleDiagnosticsRefresh(startupDiagnosticsDelayMs, { limit: 250 });
  }
  return bridge;

};
