'use strict';
// Task 12: reusable 3-mode feature harness. Runs one owner feature operation in
// plugin_only, mirror, and server_only and returns comparable observations:
// semantic result, local/server authoritative rows, logical digest, owner/scope
// identity, parent/sibling mutation, Librarian backend request count (separate
// from external LLM/embedding provider calls), reload result, retry/idempotency
// result, and fault result.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemorySuiteServer } = require('../../server/server.cjs');

const ROOT = path.resolve(__dirname, '../..');
const MODES = Object.freeze(['plugin_only', 'mirror', 'server_only']);
const sdkText = fs.readFileSync(path.join(ROOT, 'sdk/MemorySuiteStorageClient.source.js'), 'utf8');
const libraSdkText = fs.readFileSync(path.join(ROOT, 'sdk/MemorySuiteStorageClient.libra.source.js'), 'utf8');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableJson = value => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};
const logicalDigest = rows => sha256(stableJson(rows));

function createInstrumentedStore() {
  const values = new Map();
  const counters = { reads: 0, writes: 0, removes: 0 };
  return {
    values, counters,
    getItem: async key => { counters.reads += 1; return values.get(String(key)) ?? null; },
    setItem: async (key, value) => { counters.writes += 1; values.set(String(key), value); return true; },
    removeItem: async key => { counters.removes += 1; values.delete(String(key)); return true; },
    keys: async () => [...values.keys()]
  };
}

// Counts only Librarian backend calls, never external LLM/embedding provider calls.
function createBackendRequestCounter(fetchImpl) {
  const state = { count: 0, routes: {} };
  const wrapped = async (url, init) => {
    const text = String(url || '');
    if (text.includes('/v1/kv/') || text.includes('/v1/integrity') || text.includes('/bootstrap') || text.includes('/v1/manager/')) {
      state.count += 1;
      const route = text.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      state.routes[route] = (state.routes[route] || 0) + 1;
    }
    return await fetchImpl(url, init);
  };
  return { state, fetch: wrapped };
}

// A provider counter is deliberately separate so plugin_only can assert
// backend=0 even when an embedding provider was legitimately called.
function createProviderCounter() {
  const state = { calls: 0 };
  return { state, call: async () => { state.calls += 1; return []; } };
}

function buildBridge({ namespace = 'flashback', owner, store, currentScope, resolveKeyScope, url, fetchImpl, pluginPrefixes }) {
  const source = namespace === 'libra' ? libraSdkText : sdkText;
  const create = new Function(`${source}\nreturn createMemorySuiteStorageBridge`)();
  const previous = globalThis.risuai;
  globalThis.risuai = {
    pluginStorage: store,
    getArgument: async name => (String(name).includes('url') ? url : 'plugin_only'),
    setArgument: async () => true,
    nativeFetch: fetchImpl
  };
  const bridge = create({
    namespace,
    pluginId: owner,
    pluginVersion: 'harness',
    managementButton: false,
    pluginPrefixes: pluginPrefixes || [`${owner}.`],
    currentScopeProvider: async () => currentScope(),
    resolveKeyScope,
    preResolveKeyScope: true,
    scopeCacheMs: 0,
    autoMigratePlugin: false,
    autoMigrateLocal: false,
    migrationDelayMs: 100000
  });
  return { bridge, restore: () => { globalThis.risuai = previous; } };
}

async function listLocalRows(store, prefix) {
  const keys = await store.keys();
  const rows = {};
  for (const key of keys.filter(item => String(item).startsWith(prefix))) rows[key] = store.values.get(key);
  return rows;
}

async function listServerRows(bridge, prefix = '') {
  const listing = await bridge.serverKeys('plugin', prefix);
  return [...(listing.keys || [])].sort();
}

// Builds one isolated 3-mode environment (own temp DATA + real HTTP server).
async function createEnvironment(options = {}) {
  const namespace = options.namespace || 'flashback';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `storage-mode-harness-${namespace}-`));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const store = createInstrumentedStore();
  const backend = createBackendRequestCounter(fetch);
  let bridgeHandle = null;
  const env = {
    namespace, dataDir, url, store, backend,
    get bridge() { return bridgeHandle?.bridge || null; },
    boot() {
      bridgeHandle = buildBridge({
        namespace, owner: options.owner || namespace, store,
        currentScope: options.currentScope, resolveKeyScope: options.resolveKeyScope,
        url, fetchImpl: backend.fetch, pluginPrefixes: options.pluginPrefixes
      });
      return bridgeHandle.bridge;
    },
    async close() {
      try { await bridgeHandle?.bridge?.dispose?.(); } catch (_) {}
      bridgeHandle?.restore?.();
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  return env;
}

async function runFeatureAcrossModes(config) {
  const {
    owner, featureId, namespace = owner,
    arrange, act, scopeKey = 'harness-scope', peerScopeKey = null,
    reload = null, faultCases = [], resolveKeyScope
  } = config || {};
  const results = {};
  for (const mode of MODES) {
    const env = await createEnvironment({
      namespace, owner,
      currentScope: () => ({ scopeId: scopeKey, scopeKey, characterId: 'harness-char', chatId: scopeKey, aliases: [scopeKey] }),
      resolveKeyScope
    });
    const observation = {
      mode, owner, featureId,
      semanticResult: null, localRows: null, serverRows: null, logicalDigest: '',
      ownerScopeIdentity: null, parentOrSiblingMutated: null,
      librarianBackendRequests: 0, librarianBackendRoutes: {}, providerCalls: null,
      reloadResult: null, retryIdempotency: null, faultResult: null
    };
    try {
      const bridge = env.boot();
      // Register the backing store before any mode transition, exactly like the
      // owner plugins do at startup.
      bridge.createPluginStorageProxy(env.store);
      const scope={scopeId:scopeKey,scopeKey,characterId:'harness-char',chatId:scopeKey,aliases:[scopeKey]};
      if(mode==='mirror') await require('./legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,env.store,scope);
      else await bridge.setScopeMode(scope,mode);
      observation.modeRole=mode==='mirror'?'legacy_transition_compatibility':'operational';
      const context = { env, bridge, mode, scopeKey, peerScopeKey, backend: env.backend, store: env.store };
      if (typeof arrange === 'function') await arrange(context);
      let rawObservation = {};
      try {
        const actResult = typeof act === 'function' ? await act(context) : null;
        rawObservation = actResult && typeof actResult === 'object' ? actResult : { semanticResult: actResult };
        observation.semanticResult = rawObservation.semanticResult ?? null;
        const localPrefix = rawObservation.localPrefix || '';
        observation.localRows = await listLocalRows(env.store, localPrefix);
        // A plugin_only scope has no server view; only enumerate the server when
        // the requested mode is server-backed, so a listing failure can never
        // overwrite a valid semantic result.
        observation.serverRows = mode === 'plugin_only' ? [] : await listServerRows(bridge, rawObservation.serverPrefix || '');
        observation.logicalDigest = logicalDigest({ local: observation.localRows, server: observation.serverRows });
        observation.parentOrSiblingMutated = rawObservation.parentOrSiblingMutated ?? false;
      } catch (error) {
        observation.semanticResult = observation.semanticResult ?? { error: String(error?.code || error?.message || error) };
        observation.observationError = String(error?.code || error?.message || error);
      }
      observation.ownerScopeIdentity = { scopeId: scopeKey, namespace };
      observation.librarianBackendRequests = env.backend.state.count;
      observation.librarianBackendRoutes = { ...env.backend.state.routes };
      observation.providerCalls = context.providerCalls ?? 0;
      if (typeof reload === 'function') observation.reloadResult = await reload(context);
      if (typeof rawObservation.observeRetry === 'function') observation.retryIdempotency = await rawObservation.observeRetry(context);
      for (const fault of Array.isArray(faultCases) ? faultCases : []) {
        observation.faultResult = await fault({ ...context, observation });
      }
    } catch (error) {
      observation.semanticResult = observation.semanticResult ?? { error: String(error?.code || error?.message || error) };
      observation.observationError = String(error?.code || error?.message || error);
      observation.librarianBackendRequests = env.backend.state.count;
    } finally {
      await env.close();
    }
    results[mode] = observation;
  }
  return results;
}

module.exports = {
  MODES, runFeatureAcrossModes, createEnvironment, buildBridge,
  createInstrumentedStore, createBackendRequestCounter, createProviderCounter,
  logicalDigest, stableJson, sha256, listLocalRows, listServerRows
};
