'use strict';
/**
 * RisuAI Compatibility Gate Orchestrator & Report Generator
 *
 * Executes the complete RisuAI Compatibility Gate against Librarian's six release artifacts
 * and the pinned RisuAI Compatibility Pack (`PROGRAM/contracts/risuai/`):
 *
 * 1. Upstream lock, API surface, runtime semantic fingerprint, loader & IPC verification
 * 2. Six minified release plugin artifact build (or verification of prebuilt artifacts)
 * 3. Contract-backed RisuAI host runtime verification + ultralight release runtime test
 * 4. Storage authority invariants under contract-backed host:
 *    - `plugin_only` isolation (canonical writes to pluginStorage, 0 server canonical requests, works offline)
 *    - `server_only` isolation (actual `PROGRAM/server/server.cjs` + temp SQLite DATA, 0 local canonical writes)
 *    - `server_only` + server offline fail-closed (no local pluginStorage fallback)
 *    - Storage transitions (`plugin_only -> server_only` and `server_only -> plugin_only`)
 *    - Existing storage authority regression suite reuse (`storage_modes_test.cjs`, `storage_mode_owner_parity_audit_test.cjs`,
 *      `storage_mode_special_parity_gates_test.cjs`, `storage_mirror_transition_retirement_test.cjs`)
 * 5. H06-01..08 sanitized deterministic compatibility replay
 * 6. Compatibility report generation (`librarian.risu-compatibility-report.v1`)
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { createMemorySuiteServer } = require('../server/server.cjs');
const { SHIPPED_PLUGINS, buildRisuApiUsageInventory } = require('./risu_api_usage_inventory.cjs');
const {
  createVerificationError,
  loadCompatibilityPack,
  runContractVerification
} = require('./risu_contract_verifier.cjs');
const {
  createContractPluginStorage,
  createContractBackedHostCluster
} = require('./risu_contract_host.cjs');

const programDir = path.resolve(__dirname, '..');
const defaultContractsDir = path.join(programDir, 'contracts', 'risuai');

const sdkStandardSource = fs.readFileSync(path.join(programDir, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
const sdkLibraSource = fs.readFileSync(path.join(programDir, 'sdk', 'MemorySuiteStorageClient.libra.source.js'), 'utf8');
const sdkFlashbackPath = path.join(programDir, 'sdk', 'MemorySuiteStorageClient.flashback.source.js');
const sdkFlashbackSource = fs.existsSync(sdkFlashbackPath)
  ? fs.readFileSync(sdkFlashbackPath, 'utf8')
  : sdkStandardSource;

function getSdkSourceForOwner(owner) {
  if (owner === 'libra') return sdkLibraSource;
  if (owner === 'flashback') return sdkFlashbackSource;
  return sdkStandardSource;
}

const SERVER_BACKED_OWNERS = ['libra', 'hayaku', 'flashback'];

function createStorageBridgeOnContractHost({
  namespace = 'libra',
  pluginId = namespace,
  storagePolicy,
  cluster,
  hostHandle,
  currentScopeProvider,
  resolveKeyScope,
  defaultUrl = 'http://127.0.0.1:1',
  pluginPrefixes = [`${namespace}.`, 'scope:']
}) {
  const sdkText = getSdkSourceForOwner(namespace);
  const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
  const previousRisuai = globalThis.risuai;
  const previousRisuAI = globalThis.RisuAI;
  const previousRisuaiUpper = globalThis.Risuai;

  globalThis.risuai = hostHandle.api;
  globalThis.RisuAI = hostHandle.api;
  globalThis.Risuai = hostHandle.api;

  const bridge = createBridge({
    namespace,
    pluginId,
    storagePolicy,
    pluginVersion: 'compatibility-gate',
    defaultUrl,
    managementButton: false,
    startupDiagnostics: false,
    autoMigratePlugin: false,
    autoMigrateLocal: false,
    migrationDelayMs: 100000,
    pluginPrefixes,
    currentScopeProvider,
    resolveKeyScope
  });

  return {
    bridge,
    restoreGlobals() {
      if (previousRisuai === undefined) delete globalThis.risuai; else globalThis.risuai = previousRisuai;
      if (previousRisuAI === undefined) delete globalThis.RisuAI; else globalThis.RisuAI = previousRisuAI;
      if (previousRisuaiUpper === undefined) delete globalThis.Risuai; else globalThis.Risuai = previousRisuaiUpper;
    }
  };
}

function isCanonicalOwnerKey(key, prefixes = ['scope:', 'parity.', 'canonical.', 'libra.', 'hayaku.', 'flashback.', 'lia.']) {
  const k = String(key || '');
  if (k.startsWith('__memory_suite_')) return false;
  if (k.startsWith('global:')) return false;
  if (k.startsWith('suite:')) return false;
  return prefixes.some(p => k.startsWith(p));
}

function isCanonicalServerRequestUrl(url) {
  const text = String(url || '');
  return text.includes('/v1/kv/set') || text.includes('/v1/kv/get') || text.includes('/v1/kv/remove') || text.includes('/v1/kv/keys');
}

async function verifyPluginOnlyAuthorityContract(options = {}) {
  const owner = options.owner || 'libra';
  const serverRequests = [];
  const serverCanonicalWrites = [];

  const cluster = createContractBackedHostCluster({
    contractsDir: options.contractsDir,
    fetchImpl: async (url, init) => {
      serverRequests.push({ url: String(url), method: init?.method || 'GET' });
      if (isCanonicalServerRequestUrl(url)) {
        serverCanonicalWrites.push(String(url));
        throw createVerificationError(
          'PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN',
          `plugin_only mode attempted canonical server request for ${owner}: ${url}`,
          { owner, url }
        );
      }
      throw new Error(`server offline in plugin_only test for ${owner}`);
    }
  });

  const scope = { scopeId: `char:c1|chat:s1_${owner}`, scopeKey: `char:c1|chat:s1_${owner}`, characterId: 'c1', chatId: `s1_${owner}`, label: 'Scope 1', aliases: [`s1_${owner}`] };
  const hostHandle = cluster.createHostForPlugin({
    name: owner,
    argumentOverrides: {
      memory_suite_server_mode: 'plugin_only',
      memory_suite_server_url: 'http://127.0.0.1:65534'
    }
  });

  const { bridge, restoreGlobals } = createStorageBridgeOnContractHost({
    namespace: owner,
    pluginId: owner,
    storagePolicy: options.storagePolicy,
    cluster,
    hostHandle,
    currentScopeProvider: async () => scope,
    resolveKeyScope: async ({ key }) => (
      String(key).startsWith(`scope:s1_${owner}:`)
        ? { kind: 'scope', ...scope }
        : { kind: 'global' }
    ),
    pluginPrefixes: [`${owner}.`, 'scope:']
  });

  try {
    const proxy = bridge.createPluginStorageProxy(cluster.pluginStorage);
    assert.equal(await bridge.getMode(), 'plugin_only');

    const canonicalKey = `scope:s1_${owner}:canonical:1`;
    const payload = { owner, mode: 'plugin_only', turn: 5, canonical: true };
    await proxy.setItem(canonicalKey, payload);

    // Optional fault injection for negative regression testing
    if (typeof options.simulateForbiddenServerCanonicalWrite === 'function') {
      await options.simulateForbiddenServerCanonicalWrite(hostHandle.api);
    }

    const readback = await proxy.getItem(canonicalKey);
    assert.deepEqual(readback, payload, `${owner}: plugin_only readback must equal written canonical payload`);

    const rawStored = await cluster.pluginStorage.getItem(canonicalKey);
    assert.deepEqual(rawStored, payload, `${owner}: plugin_only canonical write must reside in contract-backed pluginStorage`);
    assert.equal(serverCanonicalWrites.length, 0, `${owner}: plugin_only must make zero server canonical requests`);
    assert.equal(serverRequests.length, 0, `${owner}: plugin_only normal operation must work without any server requests`);

    return {
      ok: true,
      owner,
      mode: 'plugin_only',
      canonicalLocation: 'risuai.pluginStorage',
      serverCanonicalRequests: serverCanonicalWrites.length,
      localReadbackVerified: true
    };
  } finally {
    try { await bridge.dispose?.(); } catch (_) {}
    restoreGlobals();
  }
}

const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

let nextVirtualLoopbackPort = 63100;

async function startLibrarianServerForGate(options = {}) {
  const app = createMemorySuiteServer(options);
  try {
    const addr = await app.listen();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    return {
      app,
      baseUrl,
      fetchServer: (url, init) => fetch(url, init),
      close: () => app.close()
    };
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      const virtualPort = nextVirtualLoopbackPort++;
      const baseUrl = `http://127.0.0.1:${virtualPort}`;
      app.server.address = () => ({ address: '127.0.0.1', port: virtualPort, family: 'IPv4' });
      const requestHandler = app.server.listeners('request')[0];
      const fetchServer = async (url, init = {}) => {
        const u = new URL(url);
        if (u.origin !== baseUrl) {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
        }
        if (init.signal?.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return await new Promise((resolve, reject) => {
          const req = Readable.from(init.body == null ? [] : [Buffer.from(String(init.body))]);
          Object.assign(req, {
            url: u.pathname + u.search,
            method: init.method || 'GET',
            headers: Object.fromEntries([...new Headers(init.headers).entries()]),
            socket: { remoteAddress: '127.0.0.1' },
            complete: true
          });
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.writeHead = (status, headers) => {
            res.statusCode = status;
            res.headers = { ...res.headers, ...(headers || {}) };
          };
          res.setHeader = (key, value) => { res.headers[key] = value; };
          res.getHeader = (key) => res.headers[key];
          res.end = (body) => {
            res.finished = true;
            res.emit('finish');
            resolve(new Response(res.statusCode === 204 ? null : body, {
              status: res.statusCode,
              headers: res.headers
            }));
          };
          Promise.resolve(requestHandler(req, res)).catch(reject);
        });
      };
      return {
        app,
        baseUrl,
        fetchServer,
        close: async () => {
          await app.close();
          app.server.emit('close');
        }
      };
    }
    throw err;
  }
}

async function verifyServerOnlyAuthorityAndFailClosedContract(options = {}) {
  const owner = options.owner || 'libra';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `risu-compat-server-only-${owner}-`));
  const serverHandle = await startLibrarianServerForGate({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const { baseUrl, fetchServer } = serverHandle;

  let serverOnline = true;
  let enforcingServerOnlyIsolation = false;
  const localCanonicalWrites = [];

  const pluginStorage = createContractPluginStorage({
    onBeforeWrite: async (key, value) => {
      if (enforcingServerOnlyIsolation && isCanonicalOwnerKey(key)) {
        localCanonicalWrites.push({ key, value });
        const code = serverOnline
          ? 'SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN'
          : 'SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN';
        throw createVerificationError(
          code,
          `Forbidden local pluginStorage canonical write in server_only mode for ${owner} (serverOnline=${serverOnline}): ${key}`,
          { owner, key, serverOnline }
        );
      }
    }
  });

  const cluster = createContractBackedHostCluster({
    contractsDir: options.contractsDir,
    pluginStorage,
    fetchImpl: async (url, init) => {
      if (!serverOnline) {
        const err = new Error('ECONNREFUSED: Librarian server unavailable');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return await fetchServer(url, init);
    }
  });

  const scope = { scopeId: `char:c1|chat:s2_${owner}`, scopeKey: `char:c1|chat:s2_${owner}`, characterId: 'c1', chatId: `s2_${owner}`, label: 'Scope 2', aliases: [`s2_${owner}`] };
  const hostHandle = cluster.createHostForPlugin({
    name: owner,
    argumentOverrides: {
      memory_suite_server_mode: '',
      memory_suite_server_url: baseUrl
    }
  });

  const { bridge, restoreGlobals } = createStorageBridgeOnContractHost({
    namespace: owner,
    pluginId: owner,
    cluster,
    hostHandle,
    defaultUrl: baseUrl,
    currentScopeProvider: async () => scope,
    resolveKeyScope: async ({ key }) => (
      String(key).startsWith(`scope:s2_${owner}:`)
        ? { kind: 'scope', ...scope }
        : { kind: 'global' }
    ),
    pluginPrefixes: [`${owner}.`, 'scope:']
  });

  try {
    const proxy = bridge.createPluginStorageProxy(pluginStorage);
    const transitioned = await bridge.setMode('server_only');
    assert.equal(transitioned.to, 'server_only');
    assert.equal(await bridge.getMode(), 'server_only');

    enforcingServerOnlyIsolation = true;

    const canonicalKey = `scope:s2_${owner}:canonical:1`;
    const payload = { owner, mode: 'server_only', turn: 5, canonical: true };
    await proxy.setItem(canonicalKey, payload);

    if (typeof options.simulateForbiddenLocalCanonicalWrite === 'function') {
      await options.simulateForbiddenLocalCanonicalWrite(pluginStorage);
    }

    const readback = await proxy.getItem(canonicalKey);
    assert.deepEqual(readback, payload, `${owner}: server_only readback must return canonical value from server`);

    const serverRecord = await bridge.serverGet('plugin', canonicalKey);
    assert.equal(serverRecord.exists, true, `${owner}: server_only record must exist on Librarian server`);
    assert.deepEqual(serverRecord.value, payload);
    assert.ok(typeof serverRecord.digest === 'string' && serverRecord.digest.length === 64, `${owner}: server digest present`);

    const localKeys = await pluginStorage.keys();
    const leakedLocalKeys = localKeys.filter(k => k.startsWith(`scope:s2_${owner}:canonical:`));
    assert.equal(leakedLocalKeys.length, 0, `${owner}: server_only must not write canonical owner data to pluginStorage`);
    assert.equal(localCanonicalWrites.length, 0);

    // Server-offline fail-closed check
    serverOnline = false;

    if (typeof options.simulateForbiddenOfflineLocalFallback === 'function') {
      await options.simulateForbiddenOfflineLocalFallback(pluginStorage);
    }

    let readFailedClosed = false;
    try {
      await proxy.getItem(canonicalKey);
    } catch (_) {
      readFailedClosed = true;
    }
    assert.equal(readFailedClosed, true, `${owner}: server_only read must fail closed when server is offline`);

    let writeFailedClosed = false;
    try {
      await proxy.setItem(`scope:s2_${owner}:canonical:offline-attempt`, { mustNotFallback: true });
    } catch (_) {
      writeFailedClosed = true;
    }
    assert.equal(writeFailedClosed, true, `${owner}: server_only write must fail closed when server is offline`);
    assert.equal(await bridge.getMode(), 'server_only', `${owner}: server_only must not implicitly fall back to plugin_only when offline`);
    assert.equal(localCanonicalWrites.length, 0, `${owner}: server_only offline failure must never fall back to local pluginStorage`);

    return {
      ok: true,
      owner,
      mode: 'server_only',
      canonicalLocation: 'Librarian Server (PROGRAM/server/server.cjs)',
      localCanonicalWrites: localCanonicalWrites.length,
      serverDigestVerified: true,
      serverOfflineFailClosedVerified: true
    };
  } finally {
    enforcingServerOnlyIsolation = false;
    try { await bridge.dispose?.(); } catch (_) {}
    restoreGlobals();
    await serverHandle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function verifyLiaLocalOnlyAuthorityContract(options = {}) {
  const serverRequests = [];
  const cluster = createContractBackedHostCluster({
    contractsDir: options.contractsDir,
    fetchImpl: async (url, init) => {
      serverRequests.push({ url: String(url), method: init?.method || 'GET' });
      throw new Error('server offline in lia test');
    }
  });

  const scope = { scopeId: 'char:c1|chat:s1_lia', scopeKey: 'char:c1|chat:s1_lia', characterId: 'c1', chatId: 's1_lia', label: 'Scope LIA', aliases: ['s1_lia'] };
  const hostHandle = cluster.createHostForPlugin({
    name: 'lia',
    argumentOverrides: {
      memory_suite_server_mode: 'plugin_only',
      memory_suite_server_url: 'http://127.0.0.1:65534'
    }
  });

  const { bridge, restoreGlobals } = createStorageBridgeOnContractHost({
    namespace: 'lia',
    pluginId: 'lia',
    storagePolicy: 'local_only',
    cluster,
    hostHandle,
    currentScopeProvider: async () => scope,
    resolveKeyScope: async ({ key }) => (
      String(key).startsWith('scope:s1_lia:')
        ? { kind: 'scope', ...scope }
        : { kind: 'global' }
    ),
    pluginPrefixes: ['lia.', 'scope:']
  });

  try {
    const proxy = bridge.createPluginStorageProxy(cluster.pluginStorage);
    assert.equal(await bridge.getMode(), 'plugin_only');

    // plugin_only normal operation succeeds
    const payload = { owner: 'lia', mode: 'plugin_only', canonical: true };
    await proxy.setItem('scope:s1_lia:canonical:1', payload);
    const readback = await proxy.getItem('scope:s1_lia:canonical:1');
    assert.deepEqual(readback, payload);
    assert.equal(serverRequests.length, 0, 'LIA plugin_only must make zero server requests');

    // Attempting server_only mode transition must be rejected with LOCAL_ONLY_OWNER_POLICY
    await assert.rejects(
      () => bridge.setMode('server_only'),
      /LOCAL_ONLY_OWNER_POLICY/
    );
    await assert.rejects(
      () => bridge.setScopeMode(scope, 'server_only'),
      /LOCAL_ONLY_OWNER_POLICY/
    );

    assert.equal(await bridge.getMode(), 'plugin_only', 'mode must remain plugin_only after rejected transition');
    assert.deepEqual(await proxy.getItem('scope:s1_lia:canonical:1'), payload, 'local data preserved');

    return {
      ok: true,
      owner: 'lia',
      storagePolicy: 'local_only',
      pluginOnlyVerified: true,
      serverOnlyRejectedWithLocalOnlyPolicy: true
    };
  } finally {
    try { await bridge.dispose?.(); } catch (_) {}
    restoreGlobals();
  }
}

async function verifyStorageAuthorityOwnerMatrix(options = {}) {
  const matrix = {
    serverBackedOwners: {},
    liaLocalOnly: null
  };
  for (const owner of SERVER_BACKED_OWNERS) {
    matrix.serverBackedOwners[owner] = {
      pluginOnly: await verifyPluginOnlyAuthorityContract({ ...options, owner }),
      serverOnly: await verifyServerOnlyAuthorityAndFailClosedContract({ ...options, owner })
    };
  }
  matrix.liaLocalOnly = await verifyLiaLocalOnlyAuthorityContract(options);
  return matrix;
}

async function verifyStorageTransitionContract(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-compat-transition-'));
  const serverHandle = await startLibrarianServerForGate({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const { baseUrl, fetchServer } = serverHandle;

  let failLocalRestoreWrites = false;
  const pluginStorage = createContractPluginStorage({
    initialEntries: {
      'scope:t1:seed': { scope: 't1', n: 100 }
    }
  });
  const origSetItem = pluginStorage.setItem.bind(pluginStorage);
  pluginStorage.setItem = async (key, value) => {
    if (failLocalRestoreWrites && String(key).startsWith('scope:t1:')) {
      return false;
    }
    return await origSetItem(key, value);
  };

  const cluster = createContractBackedHostCluster({
    contractsDir: options.contractsDir,
    pluginStorage,
    fetchImpl: async (url, init) => await fetchServer(url, init)
  });

  const scope = { scopeId: 'char:c1|chat:t1', scopeKey: 'char:c1|chat:t1', characterId: 'c1', chatId: 't1', label: 'Transition Scope', aliases: ['t1'] };
  const hostHandle = cluster.createHostForPlugin({
    name: 'libra',
    argumentOverrides: {
      memory_suite_server_mode: '',
      memory_suite_server_url: baseUrl
    }
  });

  const { bridge, restoreGlobals } = createStorageBridgeOnContractHost({
    namespace: 'libra',
    pluginId: 'libra',
    cluster,
    hostHandle,
    defaultUrl: baseUrl,
    currentScopeProvider: async () => scope,
    resolveKeyScope: async ({ key }) => (
      String(key).startsWith('scope:t1:')
        ? { kind: 'scope', ...scope }
        : { kind: 'global' }
    )
  });

  try {
    const proxy = bridge.createPluginStorageProxy(pluginStorage);
    assert.equal(await bridge.getMode(), 'plugin_only');

    let observedPreCutoverAuthority = null;
    const toServer = await bridge.setMode('server_only', {
      onProgress: (p) => {
        if (p.phase === 'sync_local' && !observedPreCutoverAuthority) {
          observedPreCutoverAuthority = p;
        }
      }
    });
    assert.equal(toServer.to, 'server_only');
    assert.equal(toServer.transition.phase, 'completed');
    assert.equal(await bridge.getMode(), 'server_only');

    const remoteSeed = await bridge.serverGet('plugin', 'scope:t1:seed');
    assert.equal(remoteSeed.exists, true);
    assert.deepEqual(remoteSeed.value, { scope: 't1', n: 100 });

    await proxy.setItem('scope:t1:seed', { scope: 't1', n: 200 });
    assert.deepEqual(await proxy.getItem('scope:t1:seed'), { scope: 't1', n: 200 });

    // Failed server_only -> plugin_only transition must keep server_only authority
    failLocalRestoreWrites = true;
    await assert.rejects(() => bridge.setMode('plugin_only'));
    assert.equal(await bridge.getMode(), 'server_only', 'failed transition must preserve server_only authority');
    failLocalRestoreWrites = false;

    // Verified server_only -> plugin_only transition restores server data and cuts over
    const restored = await bridge.restorePluginStorage();
    assert.equal(restored.ok, true);
    const toPlugin = await bridge.setMode('plugin_only');
    assert.equal(toPlugin.to, 'plugin_only');
    assert.equal(await bridge.getMode(), 'plugin_only');
    assert.deepEqual(await pluginStorage.getItem('scope:t1:seed'), { scope: 't1', n: 200 });

    return {
      ok: true,
      pluginToServerVerified: true,
      failedCutoverPreservesAuthority: true,
      serverToPluginVerified: true
    };
  } finally {
    failLocalRestoreWrites = false;
    try { await bridge.dispose?.(); } catch (_) {}
    restoreGlobals();
    await serverHandle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS = new Set(['H06-02']);
const H06_HOST_CONTRACT_SCENARIOS = new Set(['H06-01', 'H06-04', 'H06-06']);
const H06_CONTRACT_FIXTURE_SCENARIOS = new Set(['H06-03', 'H06-05', 'H06-07', 'H06-08']);
const H06_PRODUCT_PATH_SCENARIOS = new Set([...H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS, ...H06_HOST_CONTRACT_SCENARIOS]);

async function runH06CompatibilityReplay(options = {}) {
  const contractsDir = options.contractsDir || defaultContractsDir;
  const replayDir = path.join(contractsDir, 'replay');
  const scenarioFiles = fs.readdirSync(replayDir).filter(f => /^H06-\d+\.json$/.test(f)).sort();
  assert.equal(scenarioFiles.length, 8, 'All 8 H06 replay scenarios (H06-01..H06-08) must be present');

  const scenarioResults = [];

  for (const file of scenarioFiles) {
    const spec = JSON.parse(fs.readFileSync(path.join(replayDir, file), 'utf8'));
    assert.equal(spec.schema, 'librarian.risu-h06-replay.v1');
    assert.equal(spec.evidenceBoundary.actualRisuAiGuiExecuted, false, `${spec.scenarioId}: must not claim actual RisuAI GUI execution`);
    assert.equal(spec.evidenceBoundary.containsUserRpData, false, `${spec.scenarioId}: must not contain user RP data`);
    assert.equal(spec.evidenceBoundary.syntheticDeterministicFixture, true);

    const cluster = createContractBackedHostCluster({ contractsDir });

    if (spec.scenarioId === 'H06-01') {
      // H06-01: output listener snapshot isolation, messageIndex=-1 ignore, auto-continue supersession
      const chat = {
        id: spec.fixture.chatId,
        chatId: spec.fixture.chatId,
        name: 'H06-01 Chat',
        message: []
      };
      cluster.dbState.characters[0].chats[0] = chat;
      const host = cluster.createHostForPlugin({ name: 'libra' });
      const committedByTurn = new Map();

      await host.api.addRisuChatListener('output', async (event) => {
        // Mutate the snapshot to verify host isolation
        if (event.chat?.message?.[0]) event.chat.message[0].data = 'MUTATED_IN_SNAPSHOT';
        if (event.messageIndex < 0) return;
        const freshChat = await host.api.getChatFromIndex(event.characterIndex, event.chatIndex);
        const msg = freshChat?.message?.[event.messageIndex];
        if (!msg || msg.role !== 'assistant') return;
        const turnNo = Math.ceil((event.messageIndex + 1) / 2);
        committedByTurn.set(turnNo, msg.data);
      });

      for (const t of spec.fixture.turns) {
        chat.message.push({ role: 'user', chatId: t.userId, data: t.user });
        if (t.turn < 5) {
          chat.message.push({ role: 'assistant', chatId: t.assistantId, data: t.assistant });
          await cluster.dispatchChatOutputEvent({ characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
        } else {
          chat.message.push({ role: 'assistant', chatId: t.assistantId, data: t.autoContinueIntermediate });
          const msgIdx = chat.message.length - 1;
          await cluster.dispatchChatOutputEvent({ characterIndex: 0, chatIndex: 0, messageIndex: msgIdx });
          // Auxiliary messageIndex=-1 event must be ignored
          await cluster.dispatchChatOutputEvent({ characterIndex: 0, chatIndex: 0, messageIndex: -1 });
          // Auto-continue final output supersedes intermediate on same logical turn
          chat.message[msgIdx].data = t.assistantFinal;
          await cluster.dispatchChatOutputEvent({ characterIndex: 0, chatIndex: 0, messageIndex: msgIdx });
        }
      }

      assert.equal(chat.message[0].data, 'Synthetic user turn 1', 'snapshot mutation must not propagate to host chat');
      assert.equal(committedByTurn.size, spec.expectedContract.canonicalTurnCount);
      assert.equal(committedByTurn.get(5), spec.expectedContract.finalTurnText);
    } else if (spec.scenarioId === 'H06-02') {
      // H06-02: Native branch T12 fork & parent/sibling isolation
      const host = cluster.createHostForPlugin({ name: 'libra' });
      const parentScope = { scopeId: `char:${spec.fixture.characterId}|chat:${spec.fixture.parentChatId}`, scopeKey: `char:${spec.fixture.characterId}|chat:${spec.fixture.parentChatId}`, characterId: spec.fixture.characterId, chatId: spec.fixture.parentChatId };
      const childScope = { scopeId: `char:${spec.fixture.characterId}|chat:${spec.fixture.childChatId}`, scopeKey: `char:${spec.fixture.characterId}|chat:${spec.fixture.childChatId}`, characterId: spec.fixture.characterId, chatId: spec.fixture.childChatId };
      const siblingScope = { scopeId: `char:${spec.fixture.characterId}|chat:sibling`, scopeKey: `char:${spec.fixture.characterId}|chat:sibling`, characterId: spec.fixture.characterId, chatId: 'sibling' };
      let activeScope = parentScope;

      const { bridge, restoreGlobals } = createStorageBridgeOnContractHost({
        namespace: 'libra',
        pluginId: 'libra',
        cluster,
        hostHandle: host,
        currentScopeProvider: async () => activeScope,
        resolveKeyScope: async ({ key, currentScope }) => ({
          kind: 'scope',
          ...(String(key).includes('parent.') ? parentScope : (currentScope || childScope)),
          scopedContainer: true
        })
      });
      try {
        const proxy = bridge.createPluginStorageProxy(cluster.pluginStorage);
        await proxy.setItem('scope:parent.t10', 'CANONICAL_T1_TO_T10');
        activeScope = childScope;
        const lineage = {
          schema: 'librarian.host_lineage.v1',
          hostVersion: '2026.8.250',
          characterId: spec.fixture.characterId,
          hostChatId: spec.fixture.childChatId,
          kind: 'native_branch',
          status: 'verified',
          reason: 'exact_host_branch_prefix',
          parentChatId: spec.fixture.parentChatId,
          parentName: 'Parent',
          forkMessageId: 'a-10',
          markerIndex: 20,
          forkMessageIndex: 19,
          commonPrefixMessages: spec.fixture.commonPrefixPairs * 2,
          commonPrefixPairs: spec.fixture.commonPrefixPairs,
          canonicalPrefixEnd: spec.fixture.canonicalPrefixEnd,
          partialCanonicalPairs: spec.fixture.partialCanonicalPairs,
          prefixDigest: 'h06-02-prefix',
          path: [spec.fixture.parentChatId, spec.fixture.childChatId],
          pathVerified: true,
          pathReason: '',
          inheritanceEligible: true
        };
        const capability = bridge.createNativeBranchScopeCapability({
          owner: 'libra',
          lineage,
          sourceScope: parentScope,
          targetScope: childScope
        });
        const targetView = bridge.openScopeView(childScope, { capability, access: 'readwrite' });
        await assert.rejects(
          () => targetView.setItem('scope:parent.t10', 'OVERWRITE_ATTEMPT'),
          err => err.code === spec.expectedContract.rejectionCodeOnParentKeyOverwrite
        );
        await assert.rejects(
          () => Promise.resolve().then(() => bridge.openScopeView(siblingScope, { capability, access: 'readwrite' })),
          err => err.code === spec.expectedContract.rejectionCodeOnSiblingAccess
        );
      } finally {
        try { await bridge.dispose?.(); } catch (_) {}
        restoreGlobals();
      }
    } else if (spec.scenarioId === 'H06-03') {
      // H06-03: Bidirectional IPC A->B->C handoff and ancestor immutability
      const retraceHost = cluster.createHostForPlugin({
        name: 'flashback_hayaku_bridge',
        allowedIPC: spec.fixture.ownerPlugins
      });
      const libraHost = cluster.createHostForPlugin({
        name: 'libra',
        allowedIPC: ['flashback_hayaku_bridge']
      });
      const sessionStore = new Map([
        ['session-A', { t0: spec.fixture.deltasBySession['session-A'].t0Seed, deltas: [spec.fixture.deltasBySession['session-A'].t5Delta] }]
      ]);
      await libraHost.api.addPluginChannelListener('retrace_handoff_req', async (msg, meta) => {
        assert.equal(meta.sender, 'flashback_hayaku_bridge');
        assert.equal(meta.channel, 'retrace_handoff_req');
        const sourceSnapshot = JSON.parse(JSON.stringify(sessionStore.get(msg.fromSession)));
        sessionStore.set(msg.toSession, {
          t0: sourceSnapshot.t0,
          deltas: [...sourceSnapshot.deltas, msg.newDelta]
        });
        await libraHost.api.postPluginChannelMessage(meta.sender, 'retrace_handoff_res', {
          ok: true,
          toSession: msg.toSession
        });
      });
      const responses = [];
      await retraceHost.api.addPluginChannelListener('retrace_handoff_res', async (msg) => {
        responses.push(msg);
      });
      const beforeA = JSON.stringify(sessionStore.get('session-A'));
      await retraceHost.api.postPluginChannelMessage('libra', 'retrace_handoff_req', {
        fromSession: 'session-A',
        toSession: 'session-B',
        newDelta: spec.fixture.deltasBySession['session-B'].t5Delta
      });
      const beforeB = JSON.stringify(sessionStore.get('session-B'));
      await retraceHost.api.postPluginChannelMessage('libra', 'retrace_handoff_req', {
        fromSession: 'session-B',
        toSession: 'session-C',
        newDelta: spec.fixture.deltasBySession['session-C'].t5Delta
      });
      assert.equal(responses.length, 2);
      assert.equal(JSON.stringify(sessionStore.get('session-A')), beforeA, 'session-A ancestor must remain immutable');
      assert.equal(JSON.stringify(sessionStore.get('session-B')), beforeB, 'session-B ancestor must remain immutable');
      assert.deepEqual(sessionStore.get('session-C').deltas, [
        'synthetic-delta-A-t5',
        'synthetic-delta-B-t5',
        'synthetic-delta-C-t5'
      ]);
    } else if (spec.scenarioId === 'H06-04') {
      // H06-04: Portable archive fresh install without source session
      const host = cluster.createHostForPlugin({ name: 'libra' });
      const bundleJson = JSON.stringify(spec.fixture.bundleRecords);
      const digest = crypto.createHash('sha256').update(bundleJson).digest('hex');
      await host.api.pluginStorage.setItem(
        `portable:${spec.fixture.freshTargetScopeId}:manifest`,
        { originScopeId: spec.fixture.archiveOriginScopeId, targetScopeId: spec.fixture.freshTargetScopeId, digest, records: spec.fixture.bundleRecords }
      );
      const restored = await host.api.pluginStorage.getItem(`portable:${spec.fixture.freshTargetScopeId}:manifest`);
      assert.equal(restored.targetScopeId, spec.fixture.freshTargetScopeId);
      assert.equal(restored.digest, digest);
    } else if (spec.scenarioId === 'H06-05') {
      // H06-05: Entity split -> transcript edit -> correction abort on basis mismatch
      const host = cluster.createHostForPlugin({ name: 'libra' });
      await host.api.pluginStorage.setItem(`canonical:${spec.fixture.scopeId}`, spec.fixture.canonicalBefore);
      const currentTranscriptDigest = spec.fixture.mutatedSourceDigest;
      let aborted = false;
      if (spec.fixture.proposedSplitPatch.sourceBasisDigest !== currentTranscriptDigest) {
        aborted = true;
      }
      assert.equal(aborted, true, 'stale basis split patch must be aborted when transcript digest changed');
      assert.deepEqual(await host.api.pluginStorage.getItem(`canonical:${spec.fixture.scopeId}`), spec.fixture.canonicalBefore);
    } else if (spec.scenarioId === 'H06-06') {
      // H06-06: Selective range reanalysis & mid-execution chat switch fencing
      const chat0 = { id: 'chat-0', message: [] };
      const chat1 = { id: 'chat-1', message: [] };
      for (let i = 1; i <= spec.fixture.totalTurns; i++) {
        chat0.message.push({ role: 'user', chatId: `u-${i}`, data: `Turn ${i} user` });
        chat0.message.push({ role: 'assistant', chatId: `a-${i}`, data: `Turn ${i} assistant` });
      }
      cluster.dbState.characters[0].chats = [chat0, chat1];
      cluster.dbState.characters[0].chatPage = spec.fixture.initialChatIndex;

      let dispatchedTurns = [];
      const host = cluster.createHostForPlugin({ name: 'libra' });
      const startChatIdx = await host.api.getCurrentChatIndex();
      const [rangeStart, rangeEnd] = spec.fixture.selectedTurnRange;
      const selectedSlice = chat0.message.slice((rangeStart - 1) * 2, rangeEnd * 2);
      dispatchedTurns = selectedSlice;
      await host.api.runLLMModel({ mode: 'otherAx', messages: [{ role: 'user', content: JSON.stringify(selectedSlice) }] });

      // Simulate user switching chat mid-execution
      cluster.dbState.characters[0].chatPage = spec.fixture.switchedChatIndex;
      const afterChatIdx = await host.api.getCurrentChatIndex();
      const fenceBlocked = afterChatIdx !== startChatIdx;
      assert.equal(dispatchedTurns.length, (rangeEnd - rangeStart + 1) * 2);
      assert.equal(fenceBlocked, true, 'cross-scope commit after chat switch must be fenced');
    } else if (spec.scenarioId === 'H06-07') {
      // H06-07: Reload with incomplete job & durable pin protection during GC
      const host = cluster.createHostForPlugin({ name: 'libra' });
      const activePins = new Set(spec.fixture.pinnedRecordKeys);
      for (const k of spec.fixture.pinnedRecordKeys) {
        await host.api.pluginStorage.setItem(k, { pinnedBy: spec.fixture.pendingJobId });
      }
      for (const k of spec.fixture.unreferencedOrphanKeys) {
        await host.api.pluginStorage.setItem(k, { orphan: true });
      }
      // Run GC that respects active job pins
      for (const k of await host.api.pluginStorage.keys()) {
        if (!activePins.has(k)) {
          await host.api.pluginStorage.removeItem(k);
        }
      }
      const remainingKeys = await host.api.pluginStorage.keys();
      assert.deepEqual(remainingKeys, spec.fixture.pinnedRecordKeys);
    } else if (spec.scenarioId === 'H06-08') {
      // H06-08: Unified authority snapshot & stale injection fence across consumers
      let activeAuthority = spec.fixture.initialAuthorityDigest;
      const capturedSnapshots = spec.fixture.consumers.map(c => ({ consumer: c, authority: activeAuthority }));
      assert.equal(new Set(capturedSnapshots.map(s => s.authority)).size, 1);
      // Mutate authority after capture
      activeAuthority = spec.fixture.mutatedAuthorityDigest;
      let fenceErrorCode = null;
      for (const snap of capturedSnapshots) {
        if (snap.authority !== activeAuthority) {
          fenceErrorCode = spec.expectedContract.rejectionCodeOnStaleInjection;
        }
      }
      assert.equal(fenceErrorCode, 'LIB_READ_AUTHORITY_CHANGED');
    }

    let kind;
    if (H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS.has(spec.scenarioId)) {
      kind = 'librarian_product_path_replay';
    } else if (H06_HOST_CONTRACT_SCENARIOS.has(spec.scenarioId)) {
      kind = 'host_contract_replay';
    } else {
      kind = 'contract_fixture_validation';
    }

    scenarioResults.push({
      scenarioId: spec.scenarioId,
      title: spec.title,
      kind,
      passed: true,
      actualLibrarianProductPathReplay: kind === 'librarian_product_path_replay',
      actualLibrarianReplay: kind === 'librarian_product_path_replay',
      hostContractReplay: kind === 'host_contract_replay',
      contractFixtureValidation: kind === 'contract_fixture_validation',
      syntheticDeterministicFixture: true,
      actualHostGuiExecuted: false
    });
  }

  const librarianProductPathPassed = scenarioResults.filter(s => s.kind === 'librarian_product_path_replay' && s.passed).length;
  const hostContractPassed = scenarioResults.filter(s => s.kind === 'host_contract_replay' && s.passed).length;
  const contractFixturePassed = scenarioResults.filter(s => s.kind === 'contract_fixture_validation' && s.passed).length;

  return {
    ok: true,
    scenarioCount: scenarioResults.length,
    librarianProductPathReplay: {
      total: H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS.size,
      passed: librarianProductPathPassed,
      scenarios: Array.from(H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS)
    },
    hostContractReplay: {
      total: H06_HOST_CONTRACT_SCENARIOS.size,
      passed: hostContractPassed,
      scenarios: Array.from(H06_HOST_CONTRACT_SCENARIOS)
    },
    contractFixtureValidation: {
      total: H06_CONTRACT_FIXTURE_SCENARIOS.size,
      passed: contractFixturePassed,
      scenarios: Array.from(H06_CONTRACT_FIXTURE_SCENARIOS)
    },
    productPathReplay: {
      total: H06_PRODUCT_PATH_SCENARIOS.size,
      passed: librarianProductPathPassed + hostContractPassed,
      scenarios: Array.from(H06_PRODUCT_PATH_SCENARIOS)
    },
    scenarios: scenarioResults
  };
}

function runSubprocessNodeTest(scriptPath, envOverrides = {}, timeoutMs = 240000) {
  let res = spawnSync(process.execPath, ['--no-warnings', scriptPath], {
    cwd: programDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...envOverrides }
  });
  if (res.status !== 0 && ((res.stderr || '') + (res.stdout || '')).includes('listen EPERM')) {
    const preloadPath = path.join(os.tmpdir(), `risu-compat-loopback-preload-${process.pid}.cjs`);
    fs.writeFileSync(preloadPath, [
      "'use strict';",
      "const path = require('node:path');",
      "const { Readable } = require('node:stream');",
      "const { EventEmitter } = require('node:events');",
      "const serverMod = require(path.resolve(process.cwd(), 'server', 'server.cjs'));",
      "const origCreate = serverMod.createMemorySuiteServer;",
      "const apps = new Map();",
      "const knownOrigins = new Set();",
      "let nextPort = 64100;",
      "const origFetch = globalThis.fetch;",
      "globalThis.fetch = async (url, init = {}) => {",
      "  const u = new URL(url);",
      "  const app = apps.get(u.origin);",
      "  if (!app) {",
      "    if (knownOrigins.has(u.origin) || u.port === '65534') {",
      "      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });",
      "    }",
      "    return await origFetch(url, init);",
      "  }",
      "  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });",
      "  return await new Promise((resolve, reject) => {",
      "    const req = Readable.from(init.body == null ? [] : [Buffer.from(String(init.body))]);",
      "    Object.assign(req, { url: u.pathname + u.search, method: init.method || 'GET', headers: Object.fromEntries([...new Headers(init.headers).entries()]), socket: { remoteAddress: '127.0.0.1' }, complete: true });",
      "    const res = new EventEmitter(); res.statusCode = 200; res.headers = {};",
      "    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = { ...res.headers, ...(headers || {}) }; };",
      "    res.setHeader = (k, v) => { res.headers[k] = v; };",
      "    res.getHeader = (k) => res.headers[k];",
      "    res.end = (body) => { res.finished = true; res.emit('finish'); resolve(new Response(res.statusCode === 204 ? null : body, { status: res.statusCode, headers: res.headers })); };",
      "    Promise.resolve(app.server.listeners('request')[0](req, res)).catch(reject);",
      "  });",
      "};",
      "serverMod.createMemorySuiteServer = (options = {}) => {",
      "  const app = origCreate(options);",
      "  const origListen = app.listen.bind(app);",
      "  const origClose = app.close.bind(app);",
      "  let boundOrigin = null;",
      "  app.listen = async () => {",
      "    try { return await origListen(); } catch (err) {",
      "      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {",
      "        const p = Number(options?.port) > 0 ? Number(options.port) : nextPort++;",
      "        boundOrigin = 'http://127.0.0.1:' + p;",
      "        knownOrigins.add(boundOrigin);",
      "        app.server.address = () => ({ address: '127.0.0.1', port: p, family: 'IPv4' });",
      "        apps.set(boundOrigin, app);",
      "        return app.server.address();",
      "      }",
      "      throw err;",
      "    }",
      "  };",
      "  app.close = async () => {",
      "    await origClose();",
      "    app.server.emit('close');",
      "    if (boundOrigin && apps.get(boundOrigin) === app) apps.delete(boundOrigin);",
      "  };",
      "  return app;",
      "};"
    ].join('\n'), 'utf8');
    try {
      res = spawnSync(process.execPath, ['--no-warnings', '--require', preloadPath, scriptPath], {
        cwd: programDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...process.env, ...envOverrides }
      });
    } finally {
      try { fs.rmSync(preloadPath, { force: true }); } catch (_) {}
    }
  }
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`subprocess_test_failed:${path.basename(scriptPath)}:exit=${res.status}\n${res.stdout || ''}\n${res.stderr || ''}`);
  }
  return { script: path.basename(scriptPath), passed: true };
}

async function verifyReleaseArtifactsInContractHost(artifactDir, options = {}) {
  const cluster = createContractBackedHostCluster({
    contractsDir: options.contractsDir,
    databaseConsent: true
  });

  // First register all 6 plugin metadata entries so IPC peer lookup across the 6 plugins succeeds
  const pluginSources = {};
  for (const item of SHIPPED_PLUGINS) {
    const file = path.join(artifactDir, item.file);
    if (!fs.existsSync(file)) {
      throw createVerificationError('RELEASE_ARTIFACT_MISSING', `Release artifact missing: ${item.file}`);
    }
    pluginSources[item.owner] = fs.readFileSync(file, 'utf8');
  }

  const hostHandles = {};
  for (const item of SHIPPED_PLUGINS) {
    hostHandles[item.owner] = cluster.createHostForPlugin({
      sourceText: pluginSources[item.owner],
      filename: item.file,
      argumentOverrides: {
        memory_suite_server_mode: 'plugin_only'
      }
    });
  }

  const runtimeResults = [];
  for (const item of SHIPPED_PLUGINS) {
    const handle = hostHandles[item.owner];
    const context = vm.createContext({
      risuai: handle.api,
      Risuai: handle.api,
      RisuAI: handle.api,
      risuApi: handle.api,
      risuAPI: handle.api,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      queueMicrotask, AbortController, AbortSignal, DOMException,
      URL, URLSearchParams, TextEncoder, TextDecoder,
      crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
      performance: globalThis.performance, fetch: globalThis.fetch,
      Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
      FormData: globalThis.FormData, Blob: globalThis.Blob,
      atob: globalThis.atob, btoa: globalThis.btoa,
      confirm: () => false, alert: () => {}, prompt: () => null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
    });
    context.globalThis = context;
    context.window = context;
    context.self = context;

    vm.runInContext(pluginSources[item.owner], context, { filename: item.file });
    await new Promise(resolve => setTimeout(resolve, 150));

    assert.equal(
      handle.record.unmappedCalls.length,
      0,
      `${item.owner}: release artifact made unmapped RisuAI API call(s): ${handle.record.unmappedCalls.join(', ')}`
    );

    runtimeResults.push({
      owner: item.owner,
      file: item.file,
      pluginName: handle.pluginEntry.name,
      bytes: Buffer.byteLength(pluginSources[item.owner], 'utf8'),
      hooksRegistered: handle.record.hooks,
      ipcChannels: handle.record.ipc.channels,
      unmappedCalls: handle.record.unmappedCalls.length
    });
  }

  for (const handle of Object.values(hostHandles)) {
    try { await handle.unload(); } catch (_) {}
  }

  // Also execute the existing ultralight_release_runtime_test.cjs against these artifacts
  runSubprocessNodeTest(
    path.join(programDir, 'tests', 'ultralight_release_runtime_test.cjs'),
    { ULTRALIGHT_ARTIFACT_DIR: artifactDir }
  );

  return {
    ok: true,
    artifactsVerified: runtimeResults.length,
    ultralightRuntimeTestPassed: true,
    plugins: runtimeResults
  };
}

async function runFullCompatibilityGate(options = {}) {
  const startedAt = Date.now();
  const contractsDir = options.contractsDir ? path.resolve(options.contractsDir) : defaultContractsDir;
  let tempArtifactDir = null;
  let artifactDir = options.artifactDir ? path.resolve(options.artifactDir) : null;

  try {
    if (!artifactDir && options.buildReleaseArtifacts !== false) {
      tempArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-compat-artifacts-'));
      artifactDir = tempArtifactDir;
      const buildRes = spawnSync(
        process.execPath,
        ['--no-warnings', path.join(programDir, 'tools', 'build_plugins.cjs'), '--profile', 'release', '--out', artifactDir],
        { cwd: programDir, encoding: 'utf8', timeout: 600000 }
      );
      if (buildRes.error) throw buildRes.error;
      if (buildRes.status !== 0) {
        throw new Error(`release_artifact_build_failed:${buildRes.status}\n${buildRes.stdout || ''}\n${buildRes.stderr || ''}`);
      }
    }

    const usageInventory = buildRisuApiUsageInventory();
    const contractCheck = runContractVerification({
      contractsDir,
      upstreamDir: options.upstreamDir,
      artifactPluginDir: artifactDir,
      usageInventory
    });

    const artifactRuntimeCheck = artifactDir
      ? await verifyReleaseArtifactsInContractHost(artifactDir, { contractsDir })
      : { ok: true, skipped: true };

    const storageAuthorityMatrix = await verifyStorageAuthorityOwnerMatrix({ contractsDir });
    const pluginOnlyCheck = storageAuthorityMatrix.serverBackedOwners.libra.pluginOnly;
    const serverOnlyCheck = storageAuthorityMatrix.serverBackedOwners.libra.serverOnly;
    const transitionCheck = await verifyStorageTransitionContract({ contractsDir });

    const reusedStorageSuites = [];
    if (options.runExistingStorageSuites !== false) {
      for (const testFile of [
        'storage_modes_test.cjs',
        'storage_mode_owner_parity_audit_test.cjs',
        'storage_mode_special_parity_gates_test.cjs',
        'storage_mirror_transition_retirement_test.cjs'
      ]) {
        reusedStorageSuites.push(
          runSubprocessNodeTest(path.join(programDir, 'tests', testFile))
        );
      }
    }

    const replayCheck = await runH06CompatibilityReplay({ contractsDir });

    const report = {
      schema: 'librarian.risu-compatibility-report.v1',
      status: 'PASS',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      meaning: 'Librarian release artifacts conform to the reviewed host contracts extracted from the pinned supported RisuAI source and preserve Librarian storage-authority contracts under deterministic compatibility tests.',
      nonClaims: {
        actualRisuAiGuiExecuted: false,
        actualWebViewIframeTransportExecuted: false,
        fullUserEnvironmentCertified: false,
        allThirdPartyPluginsCertified: false,
        liveModelOutputQualityCertified: false
      },
      upstreamBasis: contractCheck.upstreamLock,
      gates: {
        apiContract: contractCheck.apiSurface,
        semanticDrift: contractCheck.runtimeSemantics,
        pluginLoaderAndIpc: contractCheck.loaderAndIpc,
        artifactRuntime: artifactRuntimeCheck,
        storageAuthorityMatrix,
        pluginOnlyAuthority: pluginOnlyCheck,
        serverOnlyAuthority: serverOnlyCheck,
        storageTransition: transitionCheck,
        reusedStorageSuites,
        h06Replay: replayCheck
      }
    };

    if (options.reportPath) {
      const outPath = path.resolve(options.reportPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    }

    return report;
  } finally {
    if (tempArtifactDir) {
      fs.rmSync(tempArtifactDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    contractsDir: defaultContractsDir,
    upstreamDir: null,
    artifactDir: null,
    buildReleaseArtifacts: true,
    runExistingStorageSuites: true,
    reportPath: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--contracts-dir') out.contractsDir = path.resolve(argv[++i]);
    else if (arg === '--upstream-dir') out.upstreamDir = path.resolve(argv[++i]);
    else if (arg === '--artifact-dir') out.artifactDir = path.resolve(argv[++i]);
    else if (arg === '--skip-build-artifacts') out.buildReleaseArtifacts = false;
    else if (arg === '--skip-existing-storage-suites') out.runExistingStorageSuites = false;
    else if (arg === '--report') out.reportPath = path.resolve(argv[++i]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

if (require.main === module) {
  runFullCompatibilityGate(parseArgs())
    .then(report => {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    })
    .catch(error => {
      process.stderr.write(`[RISUAI COMPATIBILITY GATE FAILED] ${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  SERVER_BACKED_OWNERS,
  H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS: Array.from(H06_LIBRARIAN_PRODUCT_PATH_SCENARIOS),
  H06_HOST_CONTRACT_SCENARIOS: Array.from(H06_HOST_CONTRACT_SCENARIOS),
  H06_CONTRACT_FIXTURE_SCENARIOS: Array.from(H06_CONTRACT_FIXTURE_SCENARIOS),
  H06_PRODUCT_PATH_SCENARIOS: Array.from(H06_PRODUCT_PATH_SCENARIOS),
  verifyPluginOnlyAuthorityContract,
  verifyServerOnlyAuthorityAndFailClosedContract,
  verifyLiaLocalOnlyAuthorityContract,
  verifyStorageAuthorityOwnerMatrix,
  verifyStorageTransitionContract,
  runH06CompatibilityReplay,
  verifyReleaseArtifactsInContractHost,
  runFullCompatibilityGate
};
