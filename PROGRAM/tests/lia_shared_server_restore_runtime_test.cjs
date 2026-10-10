'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');

const PLUGIN_PATH = path.join(__dirname, '..', 'plugins', 'LIA_Persona_Linker.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn, label, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) {}
    await delay(20);
  }
  throw new Error(`timeout:${label}`);
};

function memoryStore() {
  const map = new Map();
  return {
    map,
    async getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async setItem(key, value) { map.set(String(key), value); return true; },
    async removeItem(key) { map.delete(String(key)); return true; },
    async keys() { return Array.from(map.keys()); }
  };
}

function createHost(baseUrl, suffix) {
  const pluginStorage = memoryStore();
  const safeLocalStorage = memoryStore();
  const listeners = new Map();
  const unloadHandlers = [];
  const chat = {
    id:`lia-restore-chat-${suffix}`,
    chatId:`lia-restore-chat-${suffix}`,
    name:`LIA Restore ${suffix}`,
    title:`LIA Restore ${suffix}`,
    message:[], messages:[], bindedPersona:''
  };
  const character = {
    id:`lia-restore-character-${suffix}`,
    chaId:`lia-restore-character-${suffix}`,
    characterId:`lia-restore-character-${suffix}`,
    name:`LIA Restore Character ${suffix}`,
    chats:[chat], chatPage:0
  };
  const args = {
    memory_suite_server_url:baseUrl,
    memory_suite_server_mode:'',
    enable_gui:'false', mode:'off', live_sync_enabled:'false'
  };
  const addListener = (channel, handler) => {
    const key = String(channel);
    const rows = listeners.get(key) || new Set();
    rows.add(handler); listeners.set(key, rows);
    return { channel:key, handler };
  };
  const removeListener = (channel, handler) => {
    const rows = listeners.get(String(channel));
    if (!rows) return false;
    rows.delete(handler); return true;
  };
  const host = {
    apiVersion:'3.0', pluginStorage, safeLocalStorage, unloadHandlers,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) { return args[String(name)] ?? ''; },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument(name, value) { args[String(name)] = String(value); return true; },
    async nativeFetch(url, init) { return await fetch(url, init); },
    async addPluginChannelListener(channel, handler) { return addListener(channel, handler); },
    async removePluginChannelListener(channel, handler) { return removeListener(channel, handler); },
    async removePluginChannelHandler(channel, handler) { return removeListener(channel, handler); },
    async offPluginChannelMessage(channel, handler) { return removeListener(channel, handler); },
    async postPluginChannelMessage(_target, channel, message) {
      for (const handler of Array.from(listeners.get(String(channel)) || [])) {
        await handler(message, { sender:'flashback_hayaku_bridge' });
      }
      return true;
    },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async registerHamburger() { return true; },
    async registerChatButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async unregisterUIPart() { return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async addRisuChatListener() { return true; },
    async removeRisuChatListener() { return true; },
    async addEventListener() { return true; },
    async removeEventListener() { return true; },
    async getDatabase(fields) {
      const all = { personas:[], selectedPersona:'', characters:[character], plugins:[] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
    },
    async setDatabase() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getCurrentCharacter() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return chat; },
    async getCurrentChat() { return chat; },
    async getChatFromIndex() { return chat; },
    async getRequestState() { return null; },
    async setRequestState() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; },
    async getRuntimeInfo() { return { apiVersion:'3.0', platform:'node', saveMethod:'mock' }; },
    async log() { return true; },
    async alert() { return true; }
  };
  return { host, pluginStorage, safeLocalStorage, unloadHandlers };
}

function createContext(host) {
  const timeouts = new Set();
  const intervals = new Set();
  const trackedSetTimeout = (fn, ms, ...args) => {
    let timer;
    timer = setTimeout((...inner) => { timeouts.delete(timer); fn(...inner); }, ms, ...args);
    timeouts.add(timer); return timer;
  };
  const trackedSetInterval = (fn, ms, ...args) => {
    const timer = setInterval(fn, ms, ...args); intervals.add(timer); return timer;
  };
  const context = vm.createContext({
    risuai:host,
    console:{ log(){}, info(){}, warn(){}, error(){}, debug(){} },
    setTimeout:trackedSetTimeout,
    clearTimeout(timer) { timeouts.delete(timer); clearTimeout(timer); },
    setInterval:trackedSetInterval,
    clearInterval(timer) { intervals.delete(timer); clearInterval(timer); },
    queueMicrotask,
    AbortController, AbortSignal, DOMException,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto:globalThis.crypto || nodeCrypto.webcrypto,
    structuredClone:globalThis.structuredClone,
    performance:globalThis.performance,
    fetch:globalThis.fetch,
    Headers:globalThis.Headers,
    Request:globalThis.Request,
    Response:globalThis.Response,
    FormData:globalThis.FormData,
    Blob:globalThis.Blob,
    atob:globalThis.atob,
    btoa:globalThis.btoa,
    CompressionStream:globalThis.CompressionStream,
    DecompressionStream:globalThis.DecompressionStream,
    ReadableStream:globalThis.ReadableStream,
    WritableStream:globalThis.WritableStream,
    navigator:{language:'en-US',userAgent:'node-lia-restore-test'},
    confirm:()=>false, alert:()=>{}, prompt:()=>null
  });
  return {
    context,
    cleanup() {
      for (const timer of timeouts) clearTimeout(timer);
      for (const timer of intervals) clearInterval(timer);
      timeouts.clear(); intervals.clear();
    }
  };
}

function exposeSource(source) {
  const marker = '\n})();';
  const index = source.lastIndexOf(marker);
  if (index < 0) throw new Error('lia_closure_not_found');
  const helpers = `{
    RESULT_VAULT_STORAGE_KEY,
    WORLD_BLUEPRINT_STORAGE_KEY,
    LIVE_PERSONA_STORAGE_KEY,
    LIVE_PERSONA_INDEX_STORAGE_KEY,
    LIVE_PERSONA_INDEX_SCHEMA,
    LIVE_PERSONA_SCOPE_STORAGE_PREFIX,
    PERSONA_PROOF_STORAGE_KEY,
    PERSONA_VISUAL_ASSET_STORAGE_KEY,
    PERSONA_VISUAL_ASSET_PRESET_STORAGE_KEY,
    PERSONA_VISUAL_ASSET_BACKUP_PREFIX,
    PERSONA_BINDING_MANAGER_VERSION,
    hashText
  }`;
  return `${source.slice(0,index)}\n;globalThis.__LIA_TEST_BRIDGE = MemorySuiteStorageBridge; globalThis.__LIA_TEST_HELPERS = ${helpers};\n${source.slice(index)}`;
}

async function launch(suffix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `lia-shared-restore-${suffix}-`));
  const server = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir, autoBackup:false });
  const address = await server.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hostBundle = createHost(baseUrl, suffix);
  const vmBundle = createContext(hostBundle.host);
  const source = exposeSource(fs.readFileSync(PLUGIN_PATH, 'utf8'));
  const promise = vm.runInContext(source, vmBundle.context, { filename:'LIA_Persona_Linker.js', timeout:120000 });
  if (promise && typeof promise.then === 'function') await promise;
  const bridge = await waitFor(() => vmBundle.context.__LIA_TEST_BRIDGE, `${suffix}:bridge`);
  const helpers = vmBundle.context.__LIA_TEST_HELPERS;
  const scope = await waitFor(async () => {
    try { return await bridge.getCurrentScope(); } catch (_) { return null; }
  }, `${suffix}:scope`);
  return {
    server, dataDir, bridge, helpers, scope, ...hostBundle, ...vmBundle,
    async close() {
      for (const handler of hostBundle.unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
      vmBundle.cleanup();
      await server.close();
      fs.rmSync(dataDir, {recursive:true,force:true});
    }
  };
}

function sharedFixture(env) {
  const h = env.helpers;
  const scopeKey = String(env.scope.scopeKey || env.scope.scopeId || '');
  const now = '2026-08-26T00:00:00.000Z';
  const shardKey = `${h.LIVE_PERSONA_SCOPE_STORAGE_PREFIX}${h.hashText(scopeKey).slice(0,24)}`;
  const binding = {
    scopeKey, enabled:true, policy:'conservative', managerVersion:h.PERSONA_BINDING_MANAGER_VERSION,
    livePersonaId:'lia-live-restored', livePersonaName:'Restored Persona',
    ledgers:[], liveState:[], coreOverlay:[], coreCandidateHistory:{}, createdAt:now, updatedAt:now
  };
  const bindingRaw = JSON.stringify(binding);
  const index = {
    schema:h.LIVE_PERSONA_INDEX_SCHEMA, version:2, updatedAt:now,
    entries:{ [scopeKey]: { storageKey:shardKey, digest:h.hashText(bindingRaw), livePersonaId:binding.livePersonaId, updatedAt:now } }
  };
  const proof = { version:1, proofs:{ [scopeKey]: { scopeKey, requestId:'proof-1', createdAt:now } } };
  const resultVault = {
    version:1,
    items:[{ id:'lia-result::server', title:'Server Result', createdAt:now, updatedAt:now,
      personaName:'Server Persona', personaPrompt:'Name: Server Persona\nRole: Archivist\nPersonality: Careful and consistent.' }]
  };
  const worldVault = {
    version:1,
    items:[{ key:'lia-world-blueprint:v1:test', createdAt:now, updatedAt:now,
      targetCharacterId:'char-test', targetCharacterName:'Test Character', blueprint:{ summary:'A test world preserved by the server.' } }]
  };
  const legacyStore = {
    version:h.PERSONA_BINDING_MANAGER_VERSION,
    bindings:{ 'legacy-scope': { scopeKey:'legacy-scope', enabled:true, policy:'conservative', ledgers:[], liveState:[], coreOverlay:[], createdAt:now, updatedAt:now } }
  };
  const backupId = 'asset-lia-restore-test';
  const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4,5,6,7,8]);
  const base64 = bytes.toString('base64');
  const backupManifestKey = `${h.PERSONA_VISUAL_ASSET_BACKUP_PREFIX}${backupId}::manifest`;
  const backupChunkKey = `${h.PERSONA_VISUAL_ASSET_BACKUP_PREFIX}${backupId}::chunk::0`;
  const assetStore = {
    version:2, updatedAt:now,
    sets:{
      'persona:test': {
        personaKey:'persona:test', personaId:'persona-test', personaName:'Test Persona', assetPrefix:'test-persona',
        sourceType:'persona', updatedAt:now, identityHash:'identity-1', images:{
          neutral:{ emotion:'neutral', assetPath:'test-persona/neutral.png', assetName:'neutral', mime:'image/png',
            generatedAt:now, backupId, backupBytes:bytes.length, isAnchor:true }
        }
      }
    }
  };
  const presetStore = {
    version:1, updatedAt:now,
    items:[{ id:'preset-1', name:'Server Preset', emotionText:'neutral', styleNotes:'',
      compositionPreset:'standard_waist_up', compositionNotes:'', createdAt:now, updatedAt:now }]
  };
  const backupManifest = { version:1, mime:'image/png', bytes:bytes.length, base64Chars:base64.length, chunks:1, savedAt:now };
  const rows = new Map([
    [h.LIVE_PERSONA_INDEX_STORAGE_KEY, JSON.stringify(index)],
    [shardKey, bindingRaw],
    [h.PERSONA_PROOF_STORAGE_KEY, JSON.stringify(proof)],
    [h.RESULT_VAULT_STORAGE_KEY, JSON.stringify(resultVault)],
    [h.WORLD_BLUEPRINT_STORAGE_KEY, JSON.stringify(worldVault)],
    [h.LIVE_PERSONA_STORAGE_KEY, JSON.stringify(legacyStore)],
    [h.PERSONA_VISUAL_ASSET_STORAGE_KEY, JSON.stringify(assetStore)],
    [h.PERSONA_VISUAL_ASSET_PRESET_STORAGE_KEY, JSON.stringify(presetStore)],
    [backupManifestKey, JSON.stringify(backupManifest)],
    [backupChunkKey, base64]
  ]);
  return { rows, shardKey, backupId, backupManifestKey, backupChunkKey, base64 };
}

async function seedServerOnly(env, fixture, includeScope) {
  const h = env.helpers;
  for (const [key, value] of fixture.rows) {
    if (!includeScope && [h.LIVE_PERSONA_INDEX_STORAGE_KEY, fixture.shardKey, h.PERSONA_PROOF_STORAGE_KEY].includes(key)) continue;
    await env.pluginStorage.setItem(key, value);
  }
  await env.bridge.setMode('server_only');
  assert.equal(await env.bridge.getMode(), 'server_only');
}

async function removeFixtureLocals(env, fixture, includeScope) {
  const h = env.helpers;
  for (const key of fixture.rows.keys()) {
    if (!includeScope && [h.LIVE_PERSONA_INDEX_STORAGE_KEY, fixture.shardKey, h.PERSONA_PROOF_STORAGE_KEY].includes(key)) continue;
    await env.pluginStorage.removeItem(key);
  }
}

async function currentScopeAndSharedRestoreCase() {
  const env = await launch('full');
  try {
    const fixture = sharedFixture(env);
    await seedServerOnly(env, fixture, true);
    await removeFixtureLocals(env, fixture, true);
    const restored = await env.bridge.restorePluginStorage();
    assert.equal(restored.ok, true);
    assert.equal(restored.validation?.ok, true);
    assert.ok(Number(restored.validation?.metrics?.sharedStores || 0) >= 5);
    assert.equal(Number(restored.validation?.metrics?.visualAssetBackupManifests || 0), 1);
    assert.equal(Number(restored.validation?.metrics?.visualAssetBackupChunks || 0), 1);
    for (const [key, value] of fixture.rows) {
      assert.equal(await env.pluginStorage.getItem(key), value, `full restore physical readback: ${key}`);
    }
    await env.bridge.setMode('plugin_only');
    assert.equal(await env.bridge.getMode(), 'plugin_only');
    const proxy = env.bridge.createPluginStorageProxy(env.pluginStorage);
    assert.equal(await proxy.getItem(env.helpers.RESULT_VAULT_STORAGE_KEY), fixture.rows.get(env.helpers.RESULT_VAULT_STORAGE_KEY));
    return { restored:restored.restored, dependencies:restored.dependencyCandidateCount, metrics:restored.validation.metrics };
  } finally { await env.close(); }
}

async function sharedOnlyAndFailureCase() {
  const env = await launch('shared-only');
  try {
    const h = env.helpers;
    const fixture = sharedFixture(env);
    await seedServerOnly(env, fixture, false);
    await removeFixtureLocals(env, fixture, false);
    const restored = await env.bridge.restorePluginStorage();
    assert.equal(restored.ok, true, 'shared-only restore succeeds');
    assert.equal(restored.scopeCandidateCount, 0, 'no current-scope payload is required');
    assert.ok(restored.dependencyCandidateCount >= 7, 'shared durable rows are explicit restore dependencies');
    for (const [key, value] of fixture.rows) {
      if ([h.LIVE_PERSONA_INDEX_STORAGE_KEY, fixture.shardKey, h.PERSONA_PROOF_STORAGE_KEY].includes(key)) continue;
      assert.equal(await env.pluginStorage.getItem(key), value, `shared-only physical readback: ${key}`);
    }

    const proxy = env.bridge.createPluginStorageProxy(env.pluginStorage);
    // Authoritative shared tombstones must remove stale browser data.
    await proxy.removeItem(h.RESULT_VAULT_STORAGE_KEY);
    await env.pluginStorage.setItem(h.RESULT_VAULT_STORAGE_KEY, JSON.stringify({version:1,items:[{id:'stale',personaPrompt:'stale'}]}));
    const tombstoneRestore = await env.bridge.restorePluginStorage();
    assert.equal(tombstoneRestore.ok, true);
    assert.equal(await env.pluginStorage.getItem(h.RESULT_VAULT_STORAGE_KEY), null, 'shared tombstone removed stale local value');
    assert.ok(Number(tombstoneRestore.validation?.metrics?.sharedTombstones || 0) >= 1);

    // Corrupt a server backup chunk. Restore must fail closed and roll local rows back.
    await proxy.setItem(fixture.backupChunkKey, '!!!!');
    for (const [key] of fixture.rows) {
      if ([h.LIVE_PERSONA_INDEX_STORAGE_KEY, fixture.shardKey, h.PERSONA_PROOF_STORAGE_KEY,h.RESULT_VAULT_STORAGE_KEY].includes(key)) continue;
      await env.pluginStorage.removeItem(key);
    }
    let failure = null;
    try { await env.bridge.restorePluginStorage(); } catch (error) { failure = error; }
    assert.ok(failure, 'corrupt shared backup is rejected');
    assert.equal(failure.code, 'MEMORY_SUITE_RESTORE_SEMANTIC_VALIDATION_FAILED');
    assert.equal(await env.bridge.getMode(), 'server_only');
    assert.ok(await env.bridge.getRecoveryState(env.scope), 'recovery_required lock persisted');
    assert.equal(await env.pluginStorage.getItem(fixture.backupChunkKey), null, 'failed restore rolled corrupt chunk back to absence');

    await proxy.setItem(fixture.backupChunkKey, fixture.base64);
    const retry = await env.bridge.restorePluginStorage();
    assert.equal(retry.ok, true);
    assert.equal(await env.pluginStorage.getItem(fixture.backupChunkKey), fixture.base64);
    assert.equal(await env.bridge.getRecoveryState(env.scope), null, 'verified retry clears recovery lock');

    return {
      restored:restored.restored,
      scopeCandidates:restored.scopeCandidateCount,
      dependencies:restored.dependencyCandidateCount,
      tombstoneRemoved:true,
      corruptRejected:true,
      retrySucceeded:true
    };
  } finally { await env.close(); }
}


async function emptySnapshotCase() {
  const env = await launch('empty');
  try {
    await env.bridge.setMode('server_only');
    assert.equal(await env.bridge.getMode(), 'server_only');
    let failure = null;
    try { await env.bridge.restorePluginStorage(); } catch (error) { failure = error; }
    assert.ok(failure, 'a truly empty server snapshot is rejected');
    assert.equal(failure.code, 'MEMORY_SUITE_RESTORE_SEMANTIC_VALIDATION_FAILED');
    assert.ok(await env.bridge.getRecoveryState(env.scope), 'empty restore persists recovery_required');
    assert.equal(await env.bridge.getMode(), 'server_only');
    return { rejected:true, code:failure.code };
  } finally { await env.close(); }
}

(async () => {
  const full = await currentScopeAndSharedRestoreCase();
  const sharedOnly = await sharedOnlyAndFailureCase();
  const empty = await emptySnapshotCase();
  process.stdout.write(`${JSON.stringify({
    schema:'lia.shared-server-restore.runtime-test.v1',
    pluginVersion:fs.readFileSync(PLUGIN_PATH,'utf8').match(/const PLUGIN_VERSION = ["']([^"']+)/)[1],
    full,
    sharedOnly,
    empty,
    result:'PASS'
  }, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`lia_shared_server_restore_runtime_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
