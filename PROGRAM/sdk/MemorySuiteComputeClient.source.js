/* LIBRARIAN SYSTEM COMPUTE SDK v0.3.8
 * Optional deterministic-compute client shared by Librarian System owner plugins.
 *
 * The plugin remains authoritative: local execution is always available, the
 * server only returns a candidate, and a remote result is adopted only after
 * exact operation/fingerprint/digest/binding validation.
 */
const createMemorySuiteComputeBridge = (rawOptions = {}) => {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const namespace = String(options.namespace || '').trim().toLowerCase();
  const pluginId = String(options.pluginId || namespace || 'plugin').trim();
  const pluginVersion = String(options.pluginVersion || '').trim();
  if (!namespace || !/^[a-z0-9._:-]{1,80}$/.test(namespace)) throw new Error('memory_suite_compute_namespace_invalid');

  const MODE_LOCAL = 'local';
  const MODE_PREFER_SERVER = 'prefer_server';
  const VALID_MODES = new Set([MODE_LOCAL, MODE_PREFER_SERVER]);
  const defaultMode = VALID_MODES.has(String(options.defaultMode || '').trim().toLowerCase())
    ? String(options.defaultMode).trim().toLowerCase()
    : MODE_LOCAL;
  const modeArgument = String(options.modeArgument || `memory_suite_${namespace.replace(/[^a-z0-9_]/g, '_')}_compute_mode`).trim();
  const urlArgument = String(options.urlArgument || 'memory_suite_server_url').trim();
  const defaultUrl = String(options.defaultUrl || 'http://127.0.0.1:47630').replace(/\/+$/, '');
  const connectionCacheMs = Math.max(1000, Math.min(5 * 60 * 1000, Number(options.connectionCacheMs || 30000) || 30000));
  const modeCacheMs = Math.max(0, Math.min(30000, Number(options.modeCacheMs || 1000) || 1000));
  const defaultDeadlineMs = Math.max(100, Math.min(120000, Number(options.defaultDeadlineMs || 1800) || 1800));
  const defaultLocalReserveMs = Math.max(0, Math.min(60000, Number(options.localReserveMs || 350) || 350));
  const probeTimeoutMs = Math.max(250, Math.min(10000, Number(options.probeTimeoutMs || 1800) || 1800));
  const circuitFailureThreshold = Math.max(1, Math.min(20, Number(options.circuitFailureThreshold || 2) || 2));
  const circuitBaseCooldownMs = Math.max(250, Math.min(5 * 60 * 1000, Number(options.circuitBaseCooldownMs || 5000) || 5000));
  const circuitMaxCooldownMs = Math.max(circuitBaseCooldownMs, Math.min(30 * 60 * 1000, Number(options.circuitMaxCooldownMs || 60000) || 60000));
  const maxInputBytes = Math.max(1024, Math.min(32 * 1024 * 1024, Number(options.maxInputBytes || 8 * 1024 * 1024) || 8 * 1024 * 1024));
  const maxResultBytes = Math.max(1024, Math.min(32 * 1024 * 1024, Number(options.maxResultBytes || 8 * 1024 * 1024) || 8 * 1024 * 1024));
  const maxBindingBytes = Math.max(256, Math.min(256 * 1024, Number(options.maxBindingBytes || 64 * 1024) || 64 * 1024));
  const maxJsonDepth = Math.max(4, Math.min(128, Number(options.maxJsonDepth || 64) || 64));
  const maxJsonNodes = Math.max(100, Math.min(1000000, Number(options.maxJsonNodes || 1000000) || 1000000));
  const derivedCacheTtlMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(options.derivedCacheTtlMs || 5 * 60 * 1000) || 5 * 60 * 1000));
  const maxDerivedCacheEntries = Math.max(1, Math.min(1000, Number(options.maxDerivedCacheEntries || 64) || 64));
  const jobPollIntervalMs = Math.max(25, Math.min(2000, Number(options.jobPollIntervalMs || 100) || 100));
  const disposeCancelGraceMs = Math.max(0, Math.min(2000, Number(options.disposeCancelGraceMs ?? 250) || 0));
  const maxBackgroundJobs = Math.max(1, Math.min(64, Number(options.maxBackgroundJobs || 6) || 6));
  const FAILED_JOB_CANCEL_TIMEOUT_MS = 250;
  // A Job context past its deadline plus this grace can no longer produce an
  // adoptable result; it is released on the next submission.
  const JOB_CONTEXT_GRACE_MS = 30000;
  // Response bodies larger than the result limit plus the envelope overhead
  // are rejected before they are parsed.
  const maxResponseChars = maxResultBytes + maxBindingBytes + 64 * 1024;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const codedError = (message, code, extra = null) => {
    const error = new Error(String(message || code || 'memory_suite_compute_error'));
    if (code) error.code = String(code);
    if (extra && typeof extra === 'object') Object.assign(error, extra);
    return error;
  };
  const compact = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const normalizeMode = raw => {
    const value = String(raw || '').trim().toLowerCase().replace(/[ -]+/g, '_');
    if (['prefer_server', 'server_preferred', 'prefer_backend', 'backend_preferred', 'auto'].includes(value)) return MODE_PREFER_SERVER;
    // Legacy shadow/compare values adopted the local result. Preserve that
    // outcome while retiring shadow as a configurable execution mode.
    return MODE_LOCAL;
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
      throw codedError(`invalid_memory_suite_compute_server_url:${compact(error?.message || error, 180)}`, 'MEMORY_SUITE_COMPUTE_INVALID_SERVER_URL');
    }
  };

  const lifecycle = {
    disposed: false,
    disposing: false,
    disposePromise: null,
    epoch: 1,
    timers: new Set(),
    delayWakers: new Set(),
    abortControllers: new Set(),
    background: new Set()
  };
  const state = {
    mode: { value: defaultMode, at: 0, transient: '' },
    connection: { value: null, at: 0, pending: null },
    unsupported: false,
    status: { state: 'idle', reason: '', at: now() },
    circuit: { state: 'closed', failures: 0, trips: 0, openUntil: 0, halfOpenInFlight: false },
    counters: {
      local: 0, server: 0, fallbacks: 0, remoteFailures: 0,
      jobsSubmitted: 0, jobsSucceeded: 0, jobsFailed: 0, cacheHits: 0, cacheMisses: 0, cacheStale: 0
    },
    inFlight: 0,
    listeners: new Set(),
    jobContexts: new Map(),
    jobRuns: new Map(),
    jobRunCallbacks: new Map(),
    jobGeneration: 1,
    cacheGeneration: 1,
    cacheOperationGenerations: new Map(),
    derivedCache: new Map()
  };
  // The current half-open attempt. Kept outside state.circuit so status()
  // keeps its shape; a lease older than its budget is reclaimable.
  let halfOpenLease = null;

  const assertActive = expectedEpoch => {
    if (lifecycle.disposed || (expectedEpoch != null && expectedEpoch !== lifecycle.epoch)) {
      throw codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
    }
  };
  const scheduleLifecycleTimeout = (callback, delayMs) => {
    if (lifecycle.disposed) return null;
    let timer = null;
    timer = setTimeout(() => {
      lifecycle.timers.delete(timer);
      if (lifecycle.disposed) return;
      try { callback(); } catch (_) {}
    }, Math.max(0, Number(delayMs || 0) || 0));
    lifecycle.timers.add(timer);
    try { timer?.unref?.(); } catch (_) {}
    return timer;
  };
  const trackBackground = promise => {
    if (lifecycle.disposed) return Promise.resolve(null);
    let tracked = null;
    tracked = Promise.resolve(promise)
      .catch(() => null)
      .finally(() => lifecycle.background.delete(tracked));
    lifecycle.background.add(tracked);
    return tracked;
  };
  const trackBackgroundTask = promise => {
    if (lifecycle.disposed) return Promise.reject(codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED'));
    let tracked = null;
    tracked = Promise.resolve(promise).finally(() => lifecycle.background.delete(tracked));
    lifecycle.background.add(tracked);
    tracked.catch(() => null);
    return tracked;
  };
  const backgroundDelay = async (delayMs, expectedEpoch) => {
    assertActive(expectedEpoch);
    // Tracked so dispose() clears the timer and wakes the waiter at once. It is
    // deliberately not unref'd: callers await it, and an unref'd timer could let
    // a Node host exit in the middle of an awaited waitForJob().
    await new Promise(resolve => {
      let timer = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        lifecycle.timers.delete(timer);
        lifecycle.delayWakers.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, Math.max(0, Number(delayMs || 0) || 0));
      lifecycle.timers.add(timer);
      lifecycle.delayWakers.add(wake);
    });
    assertActive(expectedEpoch);
  };

  const status = () => ({
    namespace,
    pluginId,
    mode: state.mode.transient || state.mode.value || defaultMode,
    state: state.status.state,
    reason: state.status.reason,
    at: state.status.at,
    serverVersion: String(state.connection.value?.version || ''),
    capabilities: state.connection.value ? { ...state.connection.value.capabilities } : {},
    operationCount: state.connection.value?.operations instanceof Map ? state.connection.value.operations.size : 0,
    circuit: { ...state.circuit },
    inFlight: state.inFlight,
    counters: { ...state.counters },
    backgroundJobs: state.jobRuns.size,
    derivedCacheEntries: state.derivedCache.size,
    disposed: lifecycle.disposed
  });
  const emitStatus = (nextState, reason = '', extra = null) => {
    // Work that settles after dispose (e.g. an aborted probe) must not
    // overwrite the terminal 'disposed' status.
    if (lifecycle.disposed) return status();
    state.status ={ state: String(nextState || 'idle'), reason: compact(reason, 500), at: now(), ...(extra && typeof extra === 'object' ? extra : {}) };
    const snapshot = status();
    for (const listener of [...state.listeners]) {
      try { listener(snapshot); } catch (_) {}
    }
    return snapshot;
  };
  const subscribe = listener => {
    assertActive();
    if (typeof listener !== 'function') throw codedError('memory_suite_compute_listener_invalid', 'MEMORY_SUITE_COMPUTE_LISTENER_INVALID');
    state.listeners.add(listener);
    try { listener(status()); } catch (_) {}
    return () => state.listeners.delete(listener);
  };

  const collectApis = () => {
    const apis = [];
    const captureApi = value => {
      if (value && (typeof value === 'object' || typeof value === 'function') && !apis.includes(value)) apis.push(value);
    };
    captureApi(options.api);
    try { if (typeof risuai !== 'undefined') captureApi(risuai); } catch (_) {}
    try { if (typeof risuApi !== 'undefined') captureApi(risuApi); } catch (_) {}
    try { if (typeof risuAPI !== 'undefined') captureApi(risuAPI); } catch (_) {}
    try { if (typeof Risuai !== 'undefined') captureApi(Risuai); } catch (_) {}
    try { if (typeof RisuAI !== 'undefined') captureApi(RisuAI); } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        captureApi(globalThis.risuai);
        captureApi(globalThis.risuApi);
        captureApi(globalThis.risuAPI);
        captureApi(globalThis.Risuai);
        captureApi(globalThis.RisuAI);
        captureApi(globalThis.__pluginApis__);
      }
    } catch (_) {}
    return apis;
  };
  const capturedFetch = (...args) => {
    if (typeof options.fetch === 'function') return options.fetch(...args);
    for (const api of collectApis()) {
      if (typeof api?.nativeFetch === 'function') return api.nativeFetch(...args);
      if (typeof api?.risuFetch === 'function') return api.risuFetch(...args);
    }
    if (typeof fetch === 'function') return fetch(...args);
    return null;
  };
  const capturedGetArgument = (...args) => {
    if (typeof options.getArgument === 'function') return options.getArgument(...args);
    for (const api of collectApis()) {
      if (typeof api?.getArgument === 'function') return api.getArgument(...args);
      if (typeof api?.getArg === 'function') return api.getArg(...args);
    }
    return null;
  };
  const capturedSetArgument = (...args) => {
    if (typeof options.setArgument === 'function') return options.setArgument(...args);
    for (const api of collectApis()) {
      if (typeof api?.setArgument === 'function') return api.setArgument(...args);
      if (typeof api?.setArg === 'function') return api.setArg(...args);
    }
    return null;
  };

  const readMode = async (force = false, timeoutMs = null) => {
    assertActive();
    if (!force && state.mode.transient) return state.mode.transient;
    if (!force && state.mode.at && now() - state.mode.at < modeCacheMs) return state.mode.value;
    let raw = defaultMode;
    try {
      // An owner/host mode read that never settles must not hold the caller
      // past its budget; the cached (or default) mode is used instead.
      const bound = Math.max(25, Math.min(probeTimeoutMs, Number(timeoutMs ?? probeTimeoutMs) || probeTimeoutMs));
      raw = await withTimeout(Promise.resolve().then(() => (typeof options.modeProvider === 'function'
        ? options.modeProvider({ namespace, pluginId })
        : capturedGetArgument(modeArgument))), bound, 'Librarian System compute mode read');
    } catch (_) { raw = state.mode.value || defaultMode; }
    const value = normalizeMode(raw || defaultMode);
    state.mode = { value, at: now(), transient: state.mode.transient };
    return value;
  };
  const setMode = async rawMode => {
    assertActive();
    const value = normalizeMode(rawMode);
    state.mode.transient = value;
    try {
      if (typeof options.modeSetter === 'function') {
        const accepted = await options.modeSetter(value, { namespace, pluginId });
        if (accepted === false) throw new Error('compute_mode_write_rejected');
      } else if (typeof options.setArgument === 'function' || collectApis().some(a => typeof a?.setArgument === 'function' || typeof a?.setArg === 'function')) {
        const accepted = await capturedSetArgument(modeArgument, value);
        if (accepted === false) throw new Error('compute_mode_write_rejected');
      } else {
        throw codedError('memory_suite_compute_mode_persistence_unavailable', 'MEMORY_SUITE_COMPUTE_MODE_PERSISTENCE_UNAVAILABLE');
      }
      state.mode.at = 0;
      state.mode.transient = '';
      const verified = await readMode(true);
      if (verified !== value) throw codedError(`memory_suite_compute_mode_readback_mismatch:${verified}->${value}`, 'MEMORY_SUITE_COMPUTE_MODE_READBACK_MISMATCH');
      if (value === MODE_LOCAL) {
        state.connection = { value: null, at: 0, pending: null };
        // Background Jobs started under the previous mode stop polling at
        // their next step and never populate the derived cache.
        state.jobGeneration += 1;
      }
      emitStatus('mode_changed', '', { mode: value });
      if (value !== MODE_LOCAL) scheduleProbe(0);
      return value;
    } catch (error) {
      state.mode.transient = '';
      state.mode.at = 0;
      throw error;
    }
  };

  const utf8Bytes = value => {
    const text = String(value || '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const bytes = [];
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
        }
      }
      if (code <= 0x7f) bytes.push(code);
      else if (code <= 0x7ff) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
      else if (code <= 0xffff) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 0x3f), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return new Uint8Array(bytes);
  };
  const canonicalJson = value => {
    const seen = new Set();
    let nodes = 0;
    const visit = (current, depth) => {
      nodes += 1;
      if (nodes > maxJsonNodes) throw codedError('memory_suite_compute_json_node_limit', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
      if (depth > maxJsonDepth) throw codedError('memory_suite_compute_json_depth_limit', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
      if (current === null) return 'null';
      const type = typeof current;
      if (type === 'string' || type === 'boolean') return JSON.stringify(current);
      if (type === 'number') {
        if (!Number.isFinite(current)) throw codedError('memory_suite_compute_json_non_finite_number', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
        return JSON.stringify(Object.is(current, -0) ? 0 : current);
      }
      if (type !== 'object') throw codedError(`memory_suite_compute_json_type_unsupported:${type}`, 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
      if (seen.has(current)) throw codedError('memory_suite_compute_json_cycle', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
      const tag = Object.prototype.toString.call(current);
      if (tag !== '[object Object]' && tag !== '[object Array]') {
        throw codedError(`memory_suite_compute_json_object_unsupported:${tag}`, 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
      }
      if (!Array.isArray(current)) {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== null && String(prototype?.constructor?.name || '') !== 'Object') {
          throw codedError('memory_suite_compute_json_non_plain_object', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
        }
      }
      seen.add(current);
      let encoded;
      if (Array.isArray(current)) {
        const items = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw codedError('memory_suite_compute_json_sparse_array', 'MEMORY_SUITE_COMPUTE_INPUT_INVALID');
          }
          items.push(visit(current[index], depth + 1));
        }
        encoded = `[${items.join(',')}]`;
      } else {
        const keys = Object.keys(current).sort();
        encoded = `{${keys.map(key => `${JSON.stringify(key)}:${visit(current[key], depth + 1)}`).join(',')}}`;
      }
      seen.delete(current);
      return encoded;
    };
    return visit(value, 0);
  };
  const sha256Hex = value => {
    const bytes = utf8Bytes(value);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    data[paddedLength - 8] = (high >>> 24) & 0xff;
    data[paddedLength - 7] = (high >>> 16) & 0xff;
    data[paddedLength - 6] = (high >>> 8) & 0xff;
    data[paddedLength - 5] = high & 0xff;
    data[paddedLength - 4] = (low >>> 24) & 0xff;
    data[paddedLength - 3] = (low >>> 16) & 0xff;
    data[paddedLength - 2] = (low >>> 8) & 0xff;
    data[paddedLength - 1] = low & 0xff;
    const constants = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
    let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a;
    let h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;
    const words = new Uint32Array(64);
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        const at = offset + i * 4;
        words[i] = ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
        const s1 = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
        words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
      }
      let a=h0, b=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choice + constants[i] + words[i]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h=g; g=f; f=e; e=(d + temp1) >>> 0; d=c; c=b; b=a; a=(temp1 + temp2) >>> 0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(word => word.toString(16).padStart(8, '0')).join('');
  };
  const freezeDeep = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  };
  const makeSnapshot = (value, label, byteLimit) => {
    let canonical;
    try { canonical = canonicalJson(value); }
    catch (error) {
      if (!error.code) error.code = 'MEMORY_SUITE_COMPUTE_INPUT_INVALID';
      error.field = label;
      throw error;
    }
    const bytes = utf8Bytes(canonical).length;
    if (bytes > byteLimit) throw codedError(`memory_suite_compute_${label}_too_large:${bytes}`, 'MEMORY_SUITE_COMPUTE_PAYLOAD_TOO_LARGE', { field: label, bytes, limit: byteLimit });
    return { value: freezeDeep(JSON.parse(canonical)), canonical, digest: sha256Hex(canonical), bytes };
  };

  const operationRegistry = new Map();
  const registerDescriptor = (operationValue, rawDescriptor) => {
    const operation = String(operationValue || rawDescriptor?.operation || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(operation)) throw codedError(`memory_suite_compute_operation_invalid:${operation}`, 'MEMORY_SUITE_COMPUTE_OPERATION_INVALID');
    const descriptor = rawDescriptor && typeof rawDescriptor === 'object' ? rawDescriptor : {};
    const algorithmFingerprint = String(descriptor.algorithmFingerprint || '').trim();
    if (!algorithmFingerprint || algorithmFingerprint.length > 256) {
      throw codedError(`memory_suite_compute_algorithm_fingerprint_invalid:${operation}`, 'MEMORY_SUITE_COMPUTE_FINGERPRINT_INVALID');
    }
    if (typeof descriptor.local !== 'function' && typeof descriptor.executeLocal !== 'function') {
      throw codedError(`memory_suite_compute_local_executor_missing:${operation}`, 'MEMORY_SUITE_COMPUTE_LOCAL_EXECUTOR_MISSING');
    }
    operationRegistry.set(operation, Object.freeze({
      operation,
      algorithmFingerprint,
      local: typeof descriptor.local === 'function' ? descriptor.local : descriptor.executeLocal,
      validateResult: typeof descriptor.validateResult === 'function' ? descriptor.validateResult : null
    }));
  };
  if (Array.isArray(options.operations)) {
    for (const descriptor of options.operations) registerDescriptor(descriptor?.operation, descriptor);
  } else if (options.operations && typeof options.operations === 'object') {
    for (const [operation, descriptor] of Object.entries(options.operations)) registerDescriptor(operation, descriptor);
  }

  const operationId = operation => {
    let unique = '';
    try { unique = globalThis?.crypto?.randomUUID?.() || ''; } catch (_) {}
    if (!unique) unique = `${now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    const prefix = `${namespace}_${operation}_${pluginId}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 100);
    return `${prefix}_${unique.replace(/[^A-Za-z0-9._:-]/g, '')}`.slice(0, 240);
  };

  const withTimeout = async (promise, timeoutMs, label, abort = null) => {
    const effective = Math.max(25, Number(timeoutMs || 0) || 25);
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { abort?.(); } catch (_) {}
            reject(codedError(`${label || 'Librarian System compute request'} timed out after ${effective}ms`, 'MEMORY_SUITE_COMPUTE_TIMEOUT', { retryable: true }));
          }, effective);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  // Owner callbacks (binding validation/readback, result validation) run
  // inside the caller's remote budget. A callback that does not settle in
  // time rejects with `code` so the caller falls back to local execution.
  const boundOwnerCallback = async (callback, budgetMs, label, code) => {
    try {
      return await withTimeout(Promise.resolve().then(callback), Math.max(25, Math.floor(Number(budgetMs) || 0)), label);
    } catch (error) {
      if (error?.code === 'MEMORY_SUITE_COMPUTE_TIMEOUT' && !error.ownerCallbackTimeout && String(error.message || '').startsWith(label)) {
        throw codedError(`${label} exceeded the remote budget`, code, { ownerCallbackTimeout: true, retryable: true });
      }
      throw error;
    }
  };
  const responseText = async response => {
    if (typeof response?.text === 'function') return await response.text();
    if (typeof response?.json === 'function') return JSON.stringify(await response.json());
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')) {
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    }
    return JSON.stringify(response || {});
  };
  const responseTooLarge = size => codedError(`memory_suite_compute_response_too_large:${size}`, 'MEMORY_SUITE_COMPUTE_RESULT_INVALID', { bytes: size, limit: maxResponseChars });
  const declaredContentLength = response => {
    try {
      const headers = response?.headers;
      const value = typeof headers?.get === 'function'
        ? headers.get('content-length')
        : (headers && typeof headers === 'object' ? (headers['content-length'] ?? headers['Content-Length']) : null);
      const length = Number(value);
      return Number.isFinite(length) && length >= 0 ? length : -1;
    } catch (_) { return -1; }
  };
  const parseResponsePayload = (response, raw) => {
    if (typeof raw === 'string' && raw.length > maxResponseChars) throw responseTooLarge(raw.length);
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (parseError) {
      throw codedError('memory_suite_compute_server_invalid_json', 'MEMORY_SUITE_COMPUTE_SERVER_INVALID_JSON', { status: Number(response?.status || 0), cause: parseError });
    }
    const statusCode = Number(response?.status || payload?.status || 0);
    const responseOk = typeof response?.ok === 'boolean' ? response.ok : (statusCode ? statusCode >= 200 && statusCode < 300 : payload?.ok === true);
    if (!responseOk || payload?.ok !== true) {
      throw codedError(payload?.error || `memory_suite_compute_http_${statusCode || 'unknown'}`, payload?.code || 'MEMORY_SUITE_COMPUTE_HTTP_ERROR', { status: statusCode, payload });
    }
    return payload;
  };
  const LATE_RESPONSE_CODES = new Set(['MEMORY_SUITE_COMPUTE_TIMEOUT', 'MEMORY_SUITE_COMPUTE_ABORTED', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED']);
  // lateResponse(payload) is invoked when this call gave up (timeout, abort or
  // dispose) but the transport still delivers a successful response later.
  const fetchJson = async (url, init, label, timeoutMs, expectedEpoch, lateResponse = null) => {
    assertActive(expectedEpoch);
    if (!capturedFetch) throw codedError('memory_suite_compute_fetch_unavailable', 'MEMORY_SUITE_COMPUTE_FETCH_UNAVAILABLE');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) lifecycle.abortControllers.add(controller);
    const abort = () => { try { controller?.abort?.(); } catch (_) {} };
    const requestDeadlineAt = now() + Math.max(25, Number(timeoutMs || probeTimeoutMs) || probeTimeoutMs);
    const remaining = () => Math.max(25, requestDeadlineAt - now());
    let responsePromise = null;
    let textPromise = null;
    let parsedPayload = null;
    const readText = response => {
      if (!textPromise) {
        const length = declaredContentLength(response);
        textPromise = length > maxResponseChars ? Promise.reject(responseTooLarge(length)) : responseText(response);
        textPromise.catch(() => null);
      }
      return textPromise;
    };
    try {
      const requestInit = {
        ...(init || {}),
        ...(controller ? { signal: controller.signal } : {}),
        networkRoute: 'local_network',
        requestTimeoutMs: Math.max(25, Number(timeoutMs || probeTimeoutMs) || probeTimeoutMs),
        logFetch: false
      };
      responsePromise = Promise.resolve(capturedFetch(url, requestInit));
      responsePromise.catch(() => null);
      const response = await withTimeout(responsePromise, remaining(), label, abort);
      const raw = await withTimeout(readText(response), remaining(), `${label} response`, abort);
      const payload = parseResponsePayload(response, raw);
      parsedPayload = payload;
      assertActive(expectedEpoch);
      return payload;
    } catch (error) {
      if (typeof lateResponse === 'function' && responsePromise && (error?.name === 'AbortError' || LATE_RESPONSE_CODES.has(String(error?.code || '')))) {
        const deliver = parsedPayload
          ? Promise.resolve(parsedPayload)
          : responsePromise.then(response => readText(response).then(raw => parseResponsePayload(response, raw)));
        deliver.then(payload => lateResponse(payload)).catch(() => null);
      }
      if (error?.name === 'AbortError' && error?.code !== 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED') {
        throw codedError('memory_suite_compute_request_aborted', 'MEMORY_SUITE_COMPUTE_ABORTED', { retryable: true });
      }
      throw error;
    } finally {
      if (controller) lifecycle.abortControllers.delete(controller);
    }
  };

  const resolveServerUrl = async () => {
    let value = defaultUrl;
    if (typeof options.urlProvider === 'function') value = await options.urlProvider({ namespace, pluginId });
    else if (urlArgument) value = await capturedGetArgument(urlArgument);
    return normalizeServerUrl(value || defaultUrl);
  };
  const validateComputeBootstrap = (payload, requestedUrl) => {
    if (payload?.schema !== 'memory-suite.compute.bootstrap.v1' || !payload?.token || !payload?.url) {
      throw codedError('memory_suite_compute_bootstrap_contract_mismatch', 'MEMORY_SUITE_COMPUTE_BOOTSTRAP_INVALID');
    }
    const authorization = payload.authorization || {};
    if (String(authorization.pluginId || '') !== pluginId
      || String(authorization.namespace || '') !== namespace
      || !Array.isArray(authorization.roles)
      || !authorization.roles.includes('compute')) {
      throw codedError('memory_suite_compute_authorization_mismatch', 'MEMORY_SUITE_COMPUTE_AUTHORIZATION_INVALID');
    }
    if (payload.capabilities?.['compute.v1'] !== true) {
      throw codedError('memory_suite_compute_capability_missing', 'MEMORY_SUITE_COMPUTE_UNSUPPORTED');
    }
    const operations = new Map();
    for (const item of Array.isArray(payload.operations) ? payload.operations : []) {
      const name = String(item?.operation || '').trim();
      const fingerprint = String(item?.algorithmFingerprint || '').trim();
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(name) || !fingerprint) continue;
      operations.set(name, { operation: name, algorithmFingerprint: fingerprint, maxDeadlineMs: Math.max(0, Number(item?.maxDeadlineMs || 0) || 0) });
    }
    return {
      requestedUrl: normalizeServerUrl(requestedUrl),
      url: normalizeServerUrl(requestedUrl || payload.url),
      advertisedUrl: normalizeServerUrl(payload.url),
      token: String(payload.token),
      version: String(payload.version || ''),
      capabilities: { ...(payload.capabilities || {}) },
      limits: payload.limits && typeof payload.limits === 'object' ? { ...payload.limits } : {},
      operations
    };
  };
  const resetConnection = () => { state.connection = { value: null, at: 0, pending: null }; };
  const ensureComputeConnectionRaw = async (force, timeoutMs, expectedEpoch) => {
    assertActive(expectedEpoch);
    // Never bootstrap (or follow a changed URL) while dispose is cancelling.
    if (lifecycle.disposing && force === true) throw codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
    if (force === true) {
      state.unsupported = false;
      resetConnection();
    }
    if (state.unsupported && force !== true) throw codedError('memory_suite_compute_unsupported', 'MEMORY_SUITE_COMPUTE_UNSUPPORTED');
    if (state.connection.value && now() - state.connection.at < connectionCacheMs) return state.connection.value;
    if (lifecycle.disposing) throw codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
    if (state.connection.pending) return await withTimeout(state.connection.pending, timeoutMs, 'Librarian System compute bootstrap');
    const pending = (async () => {
      const baseUrl = await resolveServerUrl();
      const payload = await fetchJson(`${baseUrl}/v1/compute/bootstrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memory-Suite-Plugin': pluginId,
          'X-Memory-Suite-Plugin-Version': pluginVersion
        },
        body: JSON.stringify({ namespace })
      }, 'Librarian System compute bootstrap', timeoutMs, expectedEpoch);
      return validateComputeBootstrap(payload, baseUrl);
    })();
    state.connection = { value: null, at: 0, pending };
    // The shared bootstrap settles the connection state itself. A caller whose
    // own (shorter) budget expires only stops waiting; it must not wipe a
    // bootstrap that other callers are still joined to.
    pending.then(value => {
      if (state.connection.pending === pending && !lifecycle.disposed && lifecycle.epoch === expectedEpoch) {
        state.connection = { value, at: now(), pending: null };
      }
    }, () => {
      if (state.connection.pending === pending && !lifecycle.disposed) state.connection = { value: null, at: 0, pending: null };
    });
    const value = await withTimeout(pending, timeoutMs, 'Librarian System compute bootstrap');
    assertActive(expectedEpoch);
    return value;
  };
  // Credential refresh after a 401/403. Concurrent callers that failed with
  // the same stale connection share one forced bootstrap.
  const refreshConnection = async (staleConnection, timeoutMs, expectedEpoch) => {
    assertActive(expectedEpoch);
    if (lifecycle.disposing) throw codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
    const current = state.connection;
    if (current.value && current.value !== staleConnection && now() - current.at < connectionCacheMs) return current.value;
    if (current.pending && current.refreshOf === staleConnection) {
      const value = await withTimeout(current.pending, timeoutMs, 'Librarian System compute bootstrap');
      assertActive(expectedEpoch);
      return value;
    }
    const refreshed = ensureComputeConnectionRaw(true, timeoutMs, expectedEpoch);
    if (state.connection.pending) state.connection.refreshOf = staleConnection;
    return await refreshed;
  };

  const acquireCircuit = (force = false, budgetMs = 0) => {
    const current = now();
    // A half-open attempt that outlived its own budget (for example because a
    // transport or owner callback never settled) no longer blocks recovery.
    if (state.circuit.halfOpenInFlight && (!halfOpenLease || current - halfOpenLease.at > halfOpenLease.staleAfterMs)) {
      state.circuit.halfOpenInFlight = false;
      halfOpenLease = null;
    }
    const grantHalfOpen = () => {
      const ticket = { halfOpen: true };
      state.circuit.halfOpenInFlight = true;
      halfOpenLease = { ticket, at: current, staleAfterMs: Math.max(probeTimeoutMs, Number(budgetMs || 0) || 0) };
      return ticket;
    };
    if (state.circuit.state === 'open') {
      if (current < state.circuit.openUntil && force !== true) return null;
      if (state.circuit.halfOpenInFlight) return null;
      state.circuit.state = 'half_open';
      const ticket = grantHalfOpen();
      emitStatus('circuit_half_open');
      return ticket;
    }
    if (state.circuit.state === 'half_open') {
      if (state.circuit.halfOpenInFlight) return null;
      return grantHalfOpen();
    }
    return { halfOpen: false };
  };
  const releaseHalfOpen = ticket => {
    if (!ticket?.halfOpen || halfOpenLease?.ticket !== ticket) return false;
    state.circuit.halfOpenInFlight = false;
    halfOpenLease = null;
    return true;
  };
  const circuitRelevant = error => ![
    'MEMORY_SUITE_COMPUTE_UNSUPPORTED',
    'MEMORY_SUITE_COMPUTE_OPERATION_UNAVAILABLE',
    'MEMORY_SUITE_COMPUTE_DEADLINE_RESERVED',
    'MEMORY_SUITE_COMPUTE_BINDING_STALE',
    'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED'
  ].includes(String(error?.code || ''));
  const circuitSuccess = ticket => {
    releaseHalfOpen(ticket);
    if (lifecycle.disposed) return;
    state.circuit.state = 'closed';
    state.circuit.failures = 0;
    state.circuit.openUntil = 0;
  };
  const circuitFailure = (ticket, error) => {
    const ownsLease = releaseHalfOpen(ticket);
    // A reclaimed (stale) half-open attempt, or work aborted by dispose, says
    // nothing about the server's current health.
    if ((ticket?.halfOpen && !ownsLease) || lifecycle.disposed) return;
    if (!circuitRelevant(error)) {
      if (state.circuit.state === 'half_open') state.circuit.state = 'closed';
      return;
    }
    state.circuit.failures += 1;
    state.counters.remoteFailures += 1;
    if (ticket?.halfOpen || state.circuit.failures >= circuitFailureThreshold) {
      state.circuit.trips += 1;
      const cooldown = Math.min(circuitMaxCooldownMs, circuitBaseCooldownMs * (2 ** Math.max(0, state.circuit.trips - 1)));
      state.circuit.state = 'open';
      state.circuit.openUntil = now() + cooldown;
      emitStatus('circuit_open', error?.code || error?.message || error, { openUntil: state.circuit.openUntil });
    }
  };

  const probe = async (probeOptions = {}) => {
    const epoch = lifecycle.epoch;
    assertActive(epoch);
    const force = probeOptions.force === true;
    const mode = await readMode(false);
    if (mode === MODE_LOCAL && !force) return { ok: false, skipped: true, reason: 'local_mode', mode };
    const probeBudgetMs = Math.max(250, Number(probeOptions.timeoutMs || probeTimeoutMs) || probeTimeoutMs);
    const ticket = acquireCircuit(force, probeBudgetMs);
    if (!ticket) return { ok: false, skipped: true, reason: 'circuit_open', mode, retryAt: state.circuit.openUntil };
    emitStatus('probing', String(probeOptions.reason || ''));
    try {
      const connection = await ensureComputeConnectionRaw(force, probeBudgetMs, epoch);
      if (probeOptions.deep === true) {
        const checked = await fetchJson(connection.url + '/v1/compute/capabilities', {
          method: 'GET', headers: { Authorization: 'Bearer ' + connection.token,
            'X-Memory-Suite-Plugin': pluginId, 'X-Memory-Suite-Plugin-Version': pluginVersion }
        }, 'Librarian System compute capabilities', Math.max(250, Number(probeOptions.timeoutMs || probeTimeoutMs)), epoch);
        if (checked?.ok !== true) throw Object.assign(new Error('compute_capabilities_probe_failed'), { code: 'MEMORY_SUITE_COMPUTE_PROBE_FAILED' });
      }
      circuitSuccess(ticket);
      emitStatus('ready');
      return {
        ok: true,
        mode,
        url: connection.url,
        version: connection.version,
        capabilities: { ...connection.capabilities },
        operations: [...connection.operations.values()].map(item => ({ ...item }))
      };
    } catch (error) {
      circuitFailure(ticket, error);
      if (lifecycle.disposed || lifecycle.epoch !== epoch) {
        return { ok: false, mode, error: compact(error?.message || error, 500), code: 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED', retryAt: 0 };
      }
      if (error?.code === 'MEMORY_SUITE_COMPUTE_UNSUPPORTED') emitStatus('unsupported', error.code);
      else emitStatus('unavailable', error?.code || error?.message || error);
      return { ok: false, mode, error: compact(error?.message || error, 500), code: String(error?.code || ''), retryAt: state.circuit.openUntil || 0 };
    }
  };
  function scheduleProbe(delayMs = null) {
    if (lifecycle.disposed || options.backgroundProbe === false) return null;
    const seed = Array.from(namespace).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const delay = delayMs == null
      ? Math.max(0, Number(options.backgroundProbeDelayMs ?? (1200 + (seed % 7) * 180)) || 0)
      : Math.max(0, Number(delayMs || 0) || 0);
    return scheduleLifecycleTimeout(() => {
      trackBackground((async () => {
        const mode = await readMode(false);
        if (mode === MODE_LOCAL) return null;
        return await probe({ reason: 'background' });
      })());
    }, delay);
  }

  const prepareCall = async rawRequest => {
    const request = rawRequest && typeof rawRequest === 'object' ? rawRequest : {};
    const operation = String(request.operation || '').trim();
    const descriptor = operationRegistry.get(operation);
    if (!descriptor) throw codedError(`memory_suite_compute_operation_not_registered:${operation}`, 'MEMORY_SUITE_COMPUTE_OPERATION_NOT_REGISTERED');
    if (request.algorithmFingerprint && String(request.algorithmFingerprint) !== descriptor.algorithmFingerprint) {
      throw codedError('memory_suite_compute_algorithm_fingerprint_mismatch', 'MEMORY_SUITE_COMPUTE_FINGERPRINT_MISMATCH');
    }
    const input = makeSnapshot(request.input, 'input', maxInputBytes);
    const startedAt = now();
    const deadlineMs = Math.max(50, Math.min(120000, Number(request.deadlineMs || defaultDeadlineMs) || defaultDeadlineMs));
    const localReserveMs = Math.max(0, Math.min(deadlineMs - 1, Number(request.localReserveMs ?? defaultLocalReserveMs) || 0));
    let bindingValue = request.binding;
    let bindingUnavailable = false;
    if (bindingValue === undefined && typeof options.bindingProvider === 'function') {
      // The owner binding read is bounded by the remote budget. If it does not
      // settle, the call stays local-only (no remote candidate can be bound).
      try {
        bindingValue = await boundOwnerCallback(() => options.bindingProvider({ operation, input: input.value, inputDigest: input.digest }),
          deadlineMs - localReserveMs, 'Librarian System compute binding provider', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
      } catch (error) {
        if (!error?.ownerCallbackTimeout) throw error;
        bindingValue = {};
        bindingUnavailable = true;
      }
    }
    if (bindingValue === undefined) bindingValue = {};
    const binding = makeSnapshot(bindingValue, 'binding', maxBindingBytes);
    const lane = ['interactive', 'background', 'maintenance'].includes(String(request.lane || 'interactive')) ? String(request.lane || 'interactive') : 'interactive';
    const id = String(request.operationId || operationId(operation)).trim();
    if (!/^[A-Za-z0-9._:-]{12,240}$/.test(id)) throw codedError('memory_suite_compute_operation_id_invalid', 'MEMORY_SUITE_COMPUTE_OPERATION_ID_INVALID');
    return {
      request,
      descriptor,
      operation,
      algorithmFingerprint: descriptor.algorithmFingerprint,
      input,
      binding,
      deadlineMs,
      deadlineAt: startedAt + deadlineMs,
      localReserveMs,
      lane,
      operationId: id,
      bindingUnavailable
    };
  };
  const preparedCacheKey = prepared => [
    prepared.operation,
    prepared.algorithmFingerprint,
    prepared.input.digest,
    prepared.binding.digest
  ].join('|');
  const pruneDerivedCache = () => {
    const current = now();
    for (const [key, entry] of state.derivedCache.entries()) {
      if (!entry || entry.expiresAt <= current) state.derivedCache.delete(key);
    }
    if (state.derivedCache.size <= maxDerivedCacheEntries) return;
    // Least recently used first: a cache hit refreshes lastUsedAt.
    const usedAt = entry => Number(entry.lastUsedAt || entry.cachedAt || 0);
    const ordered = [...state.derivedCache.entries()].sort((left, right) => usedAt(left[1]) - usedAt(right[1]));
    while (state.derivedCache.size > maxDerivedCacheEntries && ordered.length) state.derivedCache.delete(ordered.shift()[0]);
  };
  const cachedEnvelopeFor = async (prepared, expectedEpoch) => {
    pruneDerivedCache();
    if (prepared.bindingUnavailable) {
      state.counters.cacheMisses += 1;
      return null;
    }
    const key = preparedCacheKey(prepared);
    const cached = state.derivedCache.get(key);
    if (!cached) {
      state.counters.cacheMisses += 1;
      return null;
    }
    try {
      const envelope = { ...cached.envelope, bindingValidation: '' };
      envelope.bindingValidation = await validateCurrentBinding(prepared, envelope, expectedEpoch, remainingRemoteBudget(prepared));
      assertActive(expectedEpoch);
      state.counters.cacheHits += 1;
      cached.lastUsedAt = now();
      return Object.freeze({ ...envelope, source: 'server_cache', cachedAt: cached.cachedAt });
    } catch (_) {
      state.derivedCache.delete(key);
      state.counters.cacheStale += 1;
      return null;
    }
  };
  const validateCurrentBinding = async (prepared, remoteEnvelope, expectedEpoch, budgetMs) => {
    assertActive(expectedEpoch);
    const validator = typeof prepared.request.validateBinding === 'function'
      ? prepared.request.validateBinding
      : (typeof options.validateBinding === 'function' ? options.validateBinding : null);
    if (validator) {
      const accepted = await boundOwnerCallback(() => validator(prepared.binding.value, {
        namespace,
        pluginId,
        operation: prepared.operation,
        operationId: prepared.operationId,
        inputDigest: prepared.input.digest,
        result: remoteEnvelope.result,
        resultDigest: remoteEnvelope.resultDigest
      }), budgetMs, 'Librarian System compute binding validation', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
      if (accepted !== true) throw codedError('memory_suite_compute_binding_stale', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
      return 'validator';
    }
    if (typeof options.bindingProvider === 'function') {
      const current = await boundOwnerCallback(() => options.bindingProvider({ operation: prepared.operation, input: prepared.input.value, inputDigest: prepared.input.digest, revalidate: true }),
        budgetMs, 'Librarian System compute binding readback', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
      const currentSnapshot = makeSnapshot(current === undefined ? {} : current, 'binding', maxBindingBytes);
      if (currentSnapshot.canonical !== prepared.binding.canonical) throw codedError('memory_suite_compute_binding_stale', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
      return 'provider_readback';
    }
    return 'echo_only';
  };
  const validateRemoteResultEnvelope = async (prepared, result, expectedEpoch, budget) => {
    if (!result || typeof result !== 'object' || String(result.schema || '') !== 'memory-suite.compute.result.v1') {
      throw codedError('memory_suite_compute_response_contract_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
    }
    if (String(result.operationId || '') !== prepared.operationId
      || String(result.namespace || '') !== namespace
      || String(result.operation || '') !== prepared.operation
      || String(result.algorithmFingerprint || '') !== prepared.algorithmFingerprint
      || String(result.inputDigest || '').toLowerCase() !== prepared.input.digest) {
      throw codedError('memory_suite_compute_response_binding_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
    }
    const responseBinding = makeSnapshot(result.binding === undefined ? {} : result.binding, 'binding', maxBindingBytes);
    if (responseBinding.canonical !== prepared.binding.canonical) {
      throw codedError('memory_suite_compute_binding_echo_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
    }
    let resultSnapshot;
    try { resultSnapshot = makeSnapshot(result.result, 'result', maxResultBytes); }
    catch (error) {
      // A malformed or oversized server result is a result defect, not an input one.
      if (error?.code === 'MEMORY_SUITE_COMPUTE_INPUT_INVALID') error.code = 'MEMORY_SUITE_COMPUTE_RESULT_INVALID';
      throw error;
    }
    if (String(result.resultDigest || '').toLowerCase() !== resultSnapshot.digest) {
      throw codedError('memory_suite_compute_result_digest_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_DIGEST_MISMATCH');
    }
    if (prepared.descriptor.validateResult) {
      const accepted = await boundOwnerCallback(() => prepared.descriptor.validateResult(resultSnapshot.value, { source: 'server', input: prepared.input.value, binding: prepared.binding.value }),
        budget(), 'Librarian System compute result validation', 'MEMORY_SUITE_COMPUTE_DEADLINE_RESERVED');
      if (accepted !== true) throw codedError('memory_suite_compute_result_validation_failed', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
    }
    const envelope = {
      result: resultSnapshot.value,
      source: 'server',
      operationId: prepared.operationId,
      operation: prepared.operation,
      inputDigest: prepared.input.digest,
      resultDigest: resultSnapshot.digest,
      algorithmFingerprint: prepared.algorithmFingerprint,
      binding: prepared.binding.value,
      bindingValidation: '',
      timing: result.timing && typeof result.timing === 'object' ? { ...result.timing } : {},
      jobId: String(result.jobId || '')
    };
    envelope.bindingValidation = await validateCurrentBinding(prepared, envelope, expectedEpoch, budget());
    assertActive(expectedEpoch);
    return Object.freeze(envelope);
  };
  const remainingRemoteBudget = prepared => Math.floor(prepared.deadlineAt - now() - prepared.localReserveMs);

  const remoteExecute = async (prepared, expectedEpoch) => {
    assertActive(expectedEpoch);
    let budget = remainingRemoteBudget(prepared);
    if (budget < 25) throw codedError('memory_suite_compute_deadline_reserved_for_local', 'MEMORY_SUITE_COMPUTE_DEADLINE_RESERVED');
    if (prepared.bindingUnavailable) throw codedError('memory_suite_compute_binding_unavailable', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
    const ticket = acquireCircuit(false, budget);
    if (!ticket) throw codedError('memory_suite_compute_circuit_open', 'MEMORY_SUITE_COMPUTE_CIRCUIT_OPEN', { retryAt: state.circuit.openUntil });
    state.inFlight += 1;
    emitStatus('running_server', '', { operation: prepared.operation });
    try {
      let connection = await ensureComputeConnectionRaw(false, budget, expectedEpoch);
      budget = remainingRemoteBudget(prepared);
      if (budget < 25) throw codedError('memory_suite_compute_deadline_reserved_for_local', 'MEMORY_SUITE_COMPUTE_DEADLINE_RESERVED');
      const advertised = connection.operations.get(prepared.operation);
      if (!advertised || advertised.algorithmFingerprint !== prepared.algorithmFingerprint) {
        throw codedError('memory_suite_compute_operation_unavailable', 'MEMORY_SUITE_COMPUTE_OPERATION_UNAVAILABLE');
      }
      const advertisedMaxDeadline = Math.max(0, Number(advertised.maxDeadlineMs || 0) || 0);
      const globalMaxDeadline = Math.max(0, Number(connection.limits?.maxExecuteDeadlineMs || connection.limits?.maxDeadlineMs || 0) || 0);
      const deadlineLimits = [advertisedMaxDeadline, globalMaxDeadline].filter(value => value > 0);
      const serverMaxDeadline = deadlineLimits.length ? Math.min(...deadlineLimits) : 0;
      const serverDeadlineMs = Math.max(1, serverMaxDeadline ? Math.min(budget, serverMaxDeadline) : budget);
      const body = {
        namespace,
        operation: prepared.operation,
        operationId: prepared.operationId,
        algorithmFingerprint: prepared.algorithmFingerprint,
        input: prepared.input.value,
        inputDigest: prepared.input.digest,
        binding: prepared.binding.value,
        lane: prepared.lane,
        deadlineMs: serverDeadlineMs
      };
      if (/^(flashback|hayaku|libra)\.memory-search\.v1$/.test(prepared.operation) && prepared.request.transportInput?.corpusId) {
        const transport = makeSnapshot(prepared.request.transportInput, 'transport', maxInputBytes).value;
        const corpusId = makeSnapshot(prepared.input.value.corpus, 'corpus', maxInputBytes).digest;
        const reconstructed = { ...transport, corpus: prepared.input.value.corpus };
        delete reconstructed.corpusId;
        if (transport.corpusId === corpusId && makeSnapshot(reconstructed, 'transport_readback', maxInputBytes).digest === prepared.input.digest) body.input = transport;
      }
      let corpusRetry = true;
      const send = async authRetry => {
        try {
          return await fetchJson(`${connection.url}/v1/compute/execute`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${connection.token}`,
              'Content-Type': 'application/json',
              'X-Memory-Suite-Plugin': pluginId,
              'X-Memory-Suite-Plugin-Version': pluginVersion
            },
            body: JSON.stringify(body)
          }, 'Librarian System compute execute', Math.max(25, remainingRemoteBudget(prepared)), expectedEpoch);
        } catch (error) {
          if (corpusRetry && body.input !== prepared.input.value && Number(error?.status || 0) === 410 && remainingRemoteBudget(prepared) >= 50) {
            corpusRetry = false;
            body.input = prepared.input.value;
            return await send(authRetry);
          }
          if (authRetry && [401, 403].includes(Number(error?.status || 0)) && remainingRemoteBudget(prepared) >= 50) {
            connection = await refreshConnection(connection, remainingRemoteBudget(prepared), expectedEpoch);
            return await send(false);
          }
          throw error;
        }
      };
      const payload = await send(true);
      const result = payload?.result;
      if (payload?.schema !== 'memory-suite.compute.execute-response.v1') {
        throw codedError('memory_suite_compute_response_contract_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
      }
      const envelope = await validateRemoteResultEnvelope(prepared, result, expectedEpoch, () => remainingRemoteBudget(prepared));
      circuitSuccess(ticket);
      state.counters.server += 1;
      emitStatus('ready');
      return envelope;
    } catch (error) {
      circuitFailure(ticket, error);
      if (!lifecycle.disposed) emitStatus('server_failed', error?.code || error?.message || error, { operation: prepared.operation });
      throw error;
    } finally {
      state.inFlight = Math.max(0, state.inFlight - 1);
    }
  };

  const remainingJobBudget = prepared => Math.floor(prepared.deadlineAt - now());
  const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled', 'expired'];
  const disposedError = () => codedError('memory_suite_compute_bridge_disposed', 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
  const assertAcceptingJobs = expectedEpoch => {
    assertActive(expectedEpoch);
    if (lifecycle.disposing) throw disposedError();
  };
  const validateJobStatus = (prepared, job, expectedJobId = '') => {
    if (!job || typeof job !== 'object' || String(job.schema || '') !== 'memory-suite.compute.job.v1') {
      throw codedError('memory_suite_compute_job_contract_mismatch', 'MEMORY_SUITE_COMPUTE_JOB_INVALID');
    }
    const jobId = String(job.jobId || '');
    if (!/^[A-Za-z0-9._:-]{8,240}$/.test(jobId)
      || (expectedJobId && jobId !== expectedJobId)
      || String(job.operationId || '') !== prepared.operationId
      || String(job.namespace || '') !== namespace
      || String(job.operation || '') !== prepared.operation
      || String(job.algorithmFingerprint || '') !== prepared.algorithmFingerprint
      || String(job.inputDigest || '').toLowerCase() !== prepared.input.digest) {
      throw codedError('memory_suite_compute_job_binding_mismatch', 'MEMORY_SUITE_COMPUTE_JOB_INVALID');
    }
    const responseBinding = makeSnapshot(job.binding === undefined ? {} : job.binding, 'binding', maxBindingBytes);
    if (responseBinding.canonical !== prepared.binding.canonical) {
      throw codedError('memory_suite_compute_job_binding_echo_mismatch', 'MEMORY_SUITE_COMPUTE_JOB_INVALID');
    }
    return Object.freeze({ ...job, jobId });
  };
  const jobHeaders = (connection, extra = null) => ({
    Authorization: `Bearer ${connection.token}`,
    'X-Memory-Suite-Plugin': pluginId,
    'X-Memory-Suite-Plugin-Version': pluginVersion,
    ...(extra || {})
  });
  // Best-effort cancel of an accepted Job on the exact endpoint/token that
  // accepted it, with a short budget of its own. It never bootstraps, follows a
  // later URL change or carries the input. `detached` sends it outside the
  // lifecycle (late responses, dispose); otherwise dispose aborts it.
  const cancelAcceptedJob = async (jobId, connection, expectedEpoch, detached = false) => {
    if (!jobId || !connection) return null;
    const url = `${connection.url}/v1/compute/jobs/${encodeURIComponent(jobId)}/cancel`;
    const init = { method: 'POST', headers: jobHeaders(connection) };
    if (!detached) {
      if (lifecycle.disposed || lifecycle.epoch !== expectedEpoch) return null;
      return await fetchJson(url, init, 'Librarian System accepted job cancel', FAILED_JOB_CANCEL_TIMEOUT_MS, expectedEpoch);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abort = () => { try { controller?.abort?.(); } catch (_) {} };
    await withTimeout(Promise.resolve(capturedFetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
      networkRoute: 'local_network',
      requestTimeoutMs: FAILED_JOB_CANCEL_TIMEOUT_MS,
      logFetch: false
    })).then(response => responseText(response)), FAILED_JOB_CANCEL_TIMEOUT_MS, 'Librarian System detached job cancel', abort);
    return null;
  };
  // Releases the input snapshot first, then cancels remotely, so a failing or
  // hanging cancel can neither retain the context nor mask the original error.
  const releaseAcceptedJob = async (jobId, entry, expectedEpoch) => {
    if (!entry || state.jobContexts.get(jobId) !== entry) return;
    state.jobContexts.delete(jobId);
    try { await cancelAcceptedJob(jobId, entry.connection, expectedEpoch); } catch (_) {}
  };
  const pruneJobContexts = () => {
    const current = now();
    for (const [jobId, entry] of [...state.jobContexts.entries()]) {
      if (current > Number(entry?.prepared?.deadlineAt || 0) + JOB_CONTEXT_GRACE_MS) state.jobContexts.delete(jobId);
    }
  };
  const submitJobRequest = async (prepared, body, expectedEpoch) => {
    let connection = await ensureComputeConnectionRaw(false, Math.max(25, remainingJobBudget(prepared)), expectedEpoch);
    const match = { operationId: prepared.operationId, operation: prepared.operation, inputDigest: prepared.input.digest };
    const send = async authRetry => {
      const sentWith = connection;
      // The server may accept a submission whose response only arrives after
      // this call gave up (timeout, abort or dispose). Cancel that Job instead
      // of leaving it to run unowned.
      const lateResponse = payload => {
        const job = payload?.result;
        if (payload?.schema !== 'memory-suite.compute.job-response.v1' || !job || typeof job !== 'object'
          || String(job.namespace || '') !== namespace
          || String(job.operationId || '') !== match.operationId
          || String(job.operation || '') !== match.operation
          || String(job.inputDigest || '').toLowerCase() !== match.inputDigest) return;
        const jobId = String(job.jobId || '');
        if (!/^[A-Za-z0-9._:-]{8,240}$/.test(jobId) || state.jobContexts.has(jobId)) return;
        cancelAcceptedJob(jobId, sentWith, expectedEpoch, true).catch(() => null);
      };
      try {
        const payload = await fetchJson(`${connection.url}/v1/compute/jobs`, {
          method: 'POST',
          headers: jobHeaders(connection, { 'Content-Type': 'application/json' }),
          body
        }, 'Librarian System compute job submit', Math.max(25, remainingJobBudget(prepared)), expectedEpoch, lateResponse);
        if (payload?.schema !== 'memory-suite.compute.job-response.v1') {
          throw codedError('memory_suite_compute_job_response_contract_mismatch', 'MEMORY_SUITE_COMPUTE_JOB_INVALID');
        }
        return { rawJob: payload?.result, connection };
      } catch (error) {
        if (authRetry && [401, 403].includes(Number(error?.status || 0)) && remainingJobBudget(prepared) >= 50) {
          connection = await refreshConnection(connection, remainingJobBudget(prepared), expectedEpoch);
          return await send(false);
        }
        throw error;
      }
    };
    return await send(true);
  };
  // Status/result/cancel for an accepted Job go only to the server that
  // accepted it. A credential refresh is allowed when it lands on that same
  // server; a changed URL is never followed, and nothing bootstraps while
  // dispose is cancelling.
  const acceptedJobRequest = async (jobId, entry, suffix, method, label, expectedSchema, expectedEpoch) => {
    const budget = () => Math.max(25, remainingJobBudget(entry.prepared));
    const send = async authRetry => {
      const connection = entry.connection;
      try {
        const payload = await fetchJson(`${connection.url}/v1/compute/jobs/${encodeURIComponent(jobId)}${suffix}`, {
          method,
          headers: jobHeaders(connection)
        }, label, budget(), expectedEpoch);
        if (payload?.schema !== expectedSchema) {
          throw codedError('memory_suite_compute_job_response_contract_mismatch', 'MEMORY_SUITE_COMPUTE_JOB_INVALID');
        }
        return payload?.result;
      } catch (error) {
        if (authRetry && [401, 403].includes(Number(error?.status || 0)) && !lifecycle.disposing && remainingJobBudget(entry.prepared) >= 50) {
          const refreshed = await refreshConnection(connection, remainingJobBudget(entry.prepared), expectedEpoch);
          if (refreshed.url !== connection.url) throw error;
          entry.connection = refreshed;
          return await send(false);
        }
        throw error;
      }
    };
    return await send(true);
  };
  const remoteSubmitPreparedJob = async (prepared, expectedEpoch, acceptedJob = null) => {
    assertAcceptingJobs(expectedEpoch);
    if (prepared.bindingUnavailable) throw codedError('memory_suite_compute_binding_unavailable', 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
    pruneJobContexts();
    const ticket = acquireCircuit(false, remainingJobBudget(prepared));
    if (!ticket) throw codedError('memory_suite_compute_circuit_open', 'MEMORY_SUITE_COMPUTE_CIRCUIT_OPEN', { retryAt: state.circuit.openUntil });
    state.inFlight += 1;
    emitStatus('submitting_job', '', { operation: prepared.operation });
    try {
      const connection = await ensureComputeConnectionRaw(false, Math.max(25, remainingJobBudget(prepared)), expectedEpoch);
      const advertised = connection.operations.get(prepared.operation);
      if (!advertised || advertised.algorithmFingerprint !== prepared.algorithmFingerprint) {
        throw codedError('memory_suite_compute_operation_unavailable', 'MEMORY_SUITE_COMPUTE_OPERATION_UNAVAILABLE');
      }
      const advertisedMaxDeadline = Math.max(0, Number(advertised.maxDeadlineMs || 0) || 0);
      const globalMaxDeadline = Math.max(0, Number(connection.limits?.maxDeadlineMs || 0) || 0);
      const deadlineLimits = [advertisedMaxDeadline, globalMaxDeadline].filter(value => value > 0);
      const serverMaxDeadline = deadlineLimits.length ? Math.min(...deadlineLimits) : prepared.deadlineMs;
      const body = {
        namespace,
        operation: prepared.operation,
        operationId: prepared.operationId,
        algorithmFingerprint: prepared.algorithmFingerprint,
        input: prepared.input.value,
        inputDigest: prepared.input.digest,
        binding: prepared.binding.value,
        lane: prepared.lane,
        deadlineMs: Math.max(1, Math.min(prepared.deadlineMs, serverMaxDeadline))
      };
      const accepted = await submitJobRequest(prepared, JSON.stringify(body), expectedEpoch);
      const job = validateJobStatus(prepared, accepted.rawJob);
      if (lifecycle.disposing || lifecycle.disposed || lifecycle.epoch !== expectedEpoch) {
        // Accepted while dispose was already cancelling: dispose has taken its
        // snapshot of outstanding Jobs, so cancel this one directly.
        cancelAcceptedJob(job.jobId, accepted.connection, expectedEpoch, true).catch(() => null);
        throw disposedError();
      }
      const entry = { prepared, connection: accepted.connection };
      state.jobContexts.set(job.jobId, entry);
      if (acceptedJob) {
        acceptedJob.jobId = job.jobId;
        acceptedJob.entry = entry;
      }
      state.counters.jobsSubmitted += 1;
      circuitSuccess(ticket);
      emitStatus('job_submitted', '', { operation: prepared.operation, jobId: job.jobId });
      return job;
    } catch (error) {
      circuitFailure(ticket, error);
      throw error;
    } finally {
      state.inFlight = Math.max(0, state.inFlight - 1);
    }
  };
  const preparedForJob = jobOrId => {
    const jobId = String(typeof jobOrId === 'string' ? jobOrId : jobOrId?.jobId || '');
    const entry = state.jobContexts.get(jobId);
    if (!entry) throw codedError('memory_suite_compute_job_context_missing', 'MEMORY_SUITE_COMPUTE_JOB_CONTEXT_MISSING', { jobId });
    return { jobId, entry, prepared: entry.prepared };
  };
  const getPreparedJobStatus = async (jobOrId, expectedEpoch = lifecycle.epoch) => {
    const { jobId, entry, prepared } = preparedForJob(jobOrId);
    const rawJob = await acceptedJobRequest(jobId, entry, '', 'GET',
      'Librarian System compute job status', 'memory-suite.compute.job-response.v1', expectedEpoch);
    return validateJobStatus(prepared, rawJob, jobId);
  };
  const getPreparedJobResult = async (jobOrId, expectedEpoch = lifecycle.epoch) => {
    const { jobId, entry, prepared } = preparedForJob(jobOrId);
    const result = await acceptedJobRequest(jobId, entry, '/result', 'GET',
      'Librarian System compute job result', 'memory-suite.compute.result-response.v1', expectedEpoch);
    if (result && typeof result === 'object' && result.jobId !== undefined && String(result.jobId) !== jobId) {
      throw codedError('memory_suite_compute_job_result_id_mismatch', 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
    }
    const envelope = await validateRemoteResultEnvelope(prepared, result, expectedEpoch, () => remainingJobBudget(prepared));
    if (state.jobContexts.get(jobId) === entry) state.jobContexts.delete(jobId);
    return envelope;
  };
  const cancelPreparedJob = async (jobOrId, expectedEpoch = lifecycle.epoch) => {
    const { jobId, entry, prepared } = preparedForJob(jobOrId);
    const rawJob = await acceptedJobRequest(jobId, entry, '/cancel', 'POST',
      'Librarian System compute job cancel', 'memory-suite.compute.cancel-response.v1', expectedEpoch);
    const job = validateJobStatus(prepared, rawJob, jobId);
    if (TERMINAL_JOB_STATES.includes(String(job.state || '')) && state.jobContexts.get(jobId) === entry) state.jobContexts.delete(jobId);
    return job;
  };
  const waitForPreparedJob = async (jobOrId, waitOptions = {}, expectedEpoch = lifecycle.epoch, guard = null) => {
    const intervalMs = Math.max(25, Math.min(2000, Number(waitOptions.pollIntervalMs || jobPollIntervalMs) || jobPollIntervalMs));
    const { jobId, entry, prepared } = preparedForJob(jobOrId);
    try {
      while (true) {
        assertActive(expectedEpoch);
        if (guard) guard();
        const statusResult = await getPreparedJobStatus(jobId, expectedEpoch);
        if (guard) guard();
        const jobState = String(statusResult.state || '');
        if (jobState === 'succeeded') return await getPreparedJobResult(jobId, expectedEpoch);
        if (['failed', 'cancelled', 'expired'].includes(jobState)) {
          if (state.jobContexts.get(jobId) === entry) state.jobContexts.delete(jobId);
          throw codedError(statusResult.error || `memory_suite_compute_job_${jobState}`, statusResult.code || 'MEMORY_SUITE_COMPUTE_JOB_FAILED', { jobId, state: jobState });
        }
        if (remainingJobBudget(prepared) <= 25) {
          await releaseAcceptedJob(jobId, entry, expectedEpoch);
          throw codedError('memory_suite_compute_job_wait_deadline', 'MEMORY_SUITE_COMPUTE_TIMEOUT', { jobId });
        }
        await backgroundDelay(Math.min(intervalMs, Math.max(25, remainingJobBudget(prepared) - 1)), expectedEpoch);
      }
    } finally {
      // Every exit that neither adopted a result nor observed a terminal state
      // (transport error, server restart, invalid result, deadline, dispose)
      // releases the context and best-effort cancels the accepted Job.
      await releaseAcceptedJob(jobId, entry, expectedEpoch);
    }
  };
  const submitJob = async rawRequest => {
    const epoch = lifecycle.epoch;
    assertAcceptingJobs(epoch);
    const mode = rawRequest?.mode === undefined ? await readMode(false) : normalizeMode(rawRequest.mode);
    if (mode === MODE_LOCAL) return Object.freeze({ scheduled: false, skipped: true, reason: 'local_mode', mode });
    const prepared = await prepareCall(rawRequest);
    return await remoteSubmitPreparedJob(prepared, epoch);
  };
  const getJobStatus = async jobOrId => await getPreparedJobStatus(jobOrId, lifecycle.epoch);
  const getJobResult = async jobOrId => await getPreparedJobResult(jobOrId, lifecycle.epoch);
  const cancelJob = async jobOrId => await cancelPreparedJob(jobOrId, lifecycle.epoch);
  const waitForJob = async (jobOrId, waitOptions = {}) => await waitForPreparedJob(jobOrId, waitOptions, lifecycle.epoch);
  const derivedCallbackFor = request => (typeof request?.onDerivedResult === 'function'
    ? request.onDerivedResult
    : (typeof options.onDerivedResult === 'function' ? options.onDerivedResult : null));
  const cacheGenerationFor = operation => `${state.cacheGeneration}:${state.cacheOperationGenerations.get(operation) || 0}`;
  // Returns the shared task, or null when no background Job may be started
  // (active Job limit reached, or no binding is available for a remote call).
  const schedulePreparedJob = (prepared, expectedEpoch) => {
    const key = preparedCacheKey(prepared);
    const existing = state.jobRuns.get(key);
    if (existing) {
      // Coalesced callers each get their own derived-result callback.
      const callback = derivedCallbackFor(prepared.request);
      const callbacks = state.jobRunCallbacks.get(key);
      if (callback && callbacks && !callbacks.includes(callback)) callbacks.push(callback);
      return existing;
    }
    if (lifecycle.disposing || lifecycle.disposed || lifecycle.epoch !== expectedEpoch) {
      const rejected = Promise.reject(disposedError());
      rejected.catch(() => null);
      return rejected;
    }
    if (prepared.bindingUnavailable || state.jobRuns.size >= maxBackgroundJobs) return null;
    const jobGeneration = state.jobGeneration;
    const cacheGeneration = cacheGenerationFor(prepared.operation);
    const guard = () => {
      if (state.jobGeneration !== jobGeneration) {
        throw codedError('memory_suite_compute_job_superseded_by_mode_change', 'MEMORY_SUITE_COMPUTE_ABORTED', { retryable: true });
      }
    };
    const own = derivedCallbackFor(prepared.request);
    const callbacks = own ? [own] : [];
    let task = null;
    task = trackBackgroundTask((async () => {
      const acceptedJob = { jobId: '', entry: null };
      try {
        const job = await remoteSubmitPreparedJob(prepared, expectedEpoch, acceptedJob);
        const envelope = await waitForPreparedJob(job, {}, expectedEpoch, guard);
        guard();
        const cachedAt = now();
        // A cache clear while this Job ran makes its result stale for caching.
        if (cacheGenerationFor(prepared.operation) === cacheGeneration) {
          state.derivedCache.set(key, { envelope, cachedAt, lastUsedAt: cachedAt, expiresAt: cachedAt + derivedCacheTtlMs });
          pruneDerivedCache();
        }
        state.counters.jobsSucceeded += 1;
        let callbackFailed = false;
        let callbackError = null;
        for (const callback of [...callbacks]) {
          try { await callback(envelope, { cacheKey: key, cachedAt }); }
          catch (error) {
            if (!callbackFailed) { callbackFailed = true; callbackError = error; }
          }
        }
        if (callbackFailed) throw callbackError;
        emitStatus('job_cached', '', { operation: prepared.operation, jobId: envelope.jobId });
        return envelope;
      } catch (error) {
        state.counters.jobsFailed += 1;
        if (!lifecycle.disposed) emitStatus('job_failed', error?.code || error?.message || error, { operation: prepared.operation });
        throw error;
      } finally {
        // Normally already released by waitForPreparedJob; this also covers an
        // exit between acceptance and waiting.
        if (acceptedJob.jobId) await releaseAcceptedJob(acceptedJob.jobId, acceptedJob.entry, expectedEpoch);
        if (state.jobRuns.get(key) === task) state.jobRuns.delete(key);
        if (state.jobRunCallbacks.get(key) === callbacks) state.jobRunCallbacks.delete(key);
      }
    })());
    state.jobRuns.set(key, task);
    state.jobRunCallbacks.set(key, callbacks);
    return task;
  };
  const prime = async rawRequest => {
    const epoch = lifecycle.epoch;
    assertActive(epoch);
    const mode = rawRequest?.mode === undefined ? await readMode(false) : normalizeMode(rawRequest.mode);
    if (mode === MODE_LOCAL) return Object.freeze({ scheduled: false, skipped: true, reason: 'local_mode', mode });
    const prepared = await prepareCall(rawRequest);
    const cached = await cachedEnvelopeFor(prepared, epoch);
    if (cached) return cached;
    const scheduled = schedulePreparedJob(prepared, epoch);
    if (!scheduled) {
      return Object.freeze({ scheduled: false, skipped: true, reason: prepared.bindingUnavailable ? 'binding_unavailable' : 'background_job_limit', mode });
    }
    return await scheduled;
  };
  const clearDerivedCache = operationValue => {
    const operation = String(operationValue || '').trim();
    // In-flight Jobs compare this generation before caching their result.
    if (operation) state.cacheOperationGenerations.set(operation, (state.cacheOperationGenerations.get(operation) || 0) + 1);
    else state.cacheGeneration += 1;
    let removed = 0;
    for (const key of [...state.derivedCache.keys()]) {
      if (!operation || key.startsWith(`${operation}|`)) {
        state.derivedCache.delete(key);
        removed += 1;
      }
    }
    return removed;
  };

  const localExecute = async (prepared, expectedEpoch, fallbackReason = '') => {
    assertActive(expectedEpoch);
    const startedAt = now();
    const rawResult = await prepared.descriptor.local(prepared.input.value, {
      namespace,
      pluginId,
      operation: prepared.operation,
      operationId: prepared.operationId,
      algorithmFingerprint: prepared.algorithmFingerprint,
      inputDigest: prepared.input.digest,
      binding: prepared.binding.value,
      deadlineAt: prepared.deadlineAt,
      localReserveMs: prepared.localReserveMs
    });
    assertActive(expectedEpoch);
    const resultSnapshot = makeSnapshot(rawResult, 'result', maxResultBytes);
    if (prepared.descriptor.validateResult) {
      const accepted = await boundOwnerCallback(() => prepared.descriptor.validateResult(resultSnapshot.value, { source: 'local', input: prepared.input.value, binding: prepared.binding.value }),
        Math.max(prepared.deadlineAt - now(), prepared.localReserveMs), 'Librarian System compute local result validation', 'MEMORY_SUITE_COMPUTE_LOCAL_RESULT_INVALID');
      if (accepted !== true) throw codedError('memory_suite_compute_local_result_validation_failed', 'MEMORY_SUITE_COMPUTE_LOCAL_RESULT_INVALID');
    }
    state.counters.local += 1;
    if (fallbackReason) state.counters.fallbacks += 1;
    emitStatus('local_ready', fallbackReason, { operation: prepared.operation });
    return Object.freeze({
      result: resultSnapshot.value,
      source: 'local',
      operationId: prepared.operationId,
      operation: prepared.operation,
      inputDigest: prepared.input.digest,
      resultDigest: resultSnapshot.digest,
      algorithmFingerprint: prepared.algorithmFingerprint,
      binding: prepared.binding.value,
      bindingValidation: 'local_owner',
      timing: { clientMs: Math.max(0, now() - startedAt) },
      jobId: '',
      fallbackReason: compact(fallbackReason, 300)
    });
  };

  const execute = async rawRequest => {
    const epoch = lifecycle.epoch;
    assertActive(epoch);
    const prepared = await prepareCall(rawRequest);
    assertActive(epoch);
    const mode = rawRequest?.mode === undefined ? await readMode(false, remainingRemoteBudget(prepared)) : normalizeMode(rawRequest.mode);
    let localPromise = null;
    const runLocalOnce = fallbackReason => {
      if (!localPromise) localPromise = Promise.resolve().then(() => localExecute(prepared, epoch, fallbackReason));
      return localPromise;
    };
    if (mode === MODE_LOCAL) return await runLocalOnce('');
    try {
      return await remoteExecute(prepared, epoch);
    } catch (error) {
      if (lifecycle.disposed || epoch !== lifecycle.epoch || error?.code === 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED') throw error;
      return await runLocalOnce(error?.code || error?.message || 'memory_suite_compute_server_fallback');
    }
  };
  const getDerivedResult = async rawRequest => {
    const epoch = lifecycle.epoch;
    assertActive(epoch);
    const prepared = await prepareCall(rawRequest);
    return await cachedEnvelopeFor(prepared, epoch);
  };
  const executeCachedOrLocal = async rawRequest => {
    const epoch = lifecycle.epoch;
    assertActive(epoch);
    const prepared = await prepareCall(rawRequest);
    const mode = rawRequest?.mode === undefined ? await readMode(false, remainingRemoteBudget(prepared)) : normalizeMode(rawRequest.mode);
    let localPromise = null;
    const runLocalOnce = fallbackReason => {
      if (!localPromise) localPromise = Promise.resolve().then(() => localExecute(prepared, epoch, fallbackReason));
      return localPromise;
    };
    if (mode === MODE_LOCAL) return await runLocalOnce('');
    const cached = await cachedEnvelopeFor(prepared, epoch);
    if (cached) return cached;
    // When the active background Job limit is reached nothing is scheduled;
    // the local answer below is authoritative either way.
    const remote = schedulePreparedJob(prepared, epoch);
    if (remote) remote.catch(() => null);
    return await runLocalOnce('MEMORY_SUITE_COMPUTE_CACHE_MISS');
  };

  const whenIdle = async () => {
    const pending = [...lifecycle.background];
    if (pending.length) await Promise.allSettled(pending);
    return status();
  };
  const cancelOutstandingJobsBeforeDispose = async expectedEpoch => {
    const jobIds = [...state.jobContexts.keys()];
    if (!jobIds.length || disposeCancelGraceMs <= 0) return;
    const cancellations = Promise.allSettled(jobIds.map(jobId => (
      cancelPreparedJob(jobId, expectedEpoch).catch(() => null)
    )));
    let timer = null;
    try {
      await Promise.race([
        cancellations,
        new Promise(resolve => { timer = setTimeout(resolve, disposeCancelGraceMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const dispose = async () => {
    if (lifecycle.disposed) return false;
    // Concurrent callers join the dispose already in progress.
    if (lifecycle.disposePromise) {
      await lifecycle.disposePromise;
      return false;
    }
    lifecycle.disposing = true;
    lifecycle.disposePromise = disposeOnce(lifecycle.epoch);
    await lifecycle.disposePromise;
    return true;
  };
  const disposeOnce = async epoch => {
    try { await cancelOutstandingJobsBeforeDispose(epoch); } catch (_) {}
    lifecycle.disposed = true;
    lifecycle.epoch += 1;
    for (const timer of [...lifecycle.timers]) clearTimeout(timer);
    lifecycle.timers.clear();
    for (const wake of [...lifecycle.delayWakers]) {
      try { wake(); } catch (_) {}
    }
    lifecycle.delayWakers.clear();
    for (const controller of [...lifecycle.abortControllers]) {
      try { controller.abort(); } catch (_) {}
    }
    lifecycle.abortControllers.clear();
    state.listeners.clear();
    state.jobContexts.clear();
    state.jobRuns.clear();
    state.jobRunCallbacks.clear();
    state.derivedCache.clear();
    state.connection = { value: null, at: 0, pending: null };
    state.status = { state: 'disposed', reason: '', at: now() };
  };

  const bridge = Object.freeze({
    namespace,
    pluginId,
    modes: Object.freeze({ local: MODE_LOCAL, preferServer: MODE_PREFER_SERVER }),
    execute,
    executeCachedOrLocal,
    prime,
    submitJob,
    getJobStatus,
    getJobResult,
    waitForJob,
    cancelJob,
    getDerivedResult,
    clearDerivedCache,
    probe,
    scheduleProbe,
    getMode: readMode,
    setMode,
    status,
    subscribe,
    whenIdle,
    dispose
  });
  scheduleProbe();
  return bridge;
};
