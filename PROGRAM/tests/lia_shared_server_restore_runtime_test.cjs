'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createSnapshotBridge } = require('./fixtures/lia_legacy_recovery_snapshot_fixture.cjs');

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
    async nativeFetch() { throw Error('unexpected_network'); },
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
    hashText, createRecovery:createLiaLegacyServerRecovery, readStoredResultVault, readPersonaVisualAssetBackup
  }`;
  return `${source.slice(0,index)}\n;globalThis.__LIA_TEST_BRIDGE = MemorySuiteStorageBridge; globalThis.__LIA_TEST_HELPERS = ${helpers};\n${source.slice(index)}`;
}

async function launch(suffix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `lia-shared-restore-${suffix}-`));
  const baseUrl = '';
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
    dataDir, bridge, helpers, scope, ...hostBundle, ...vmBundle,
    async close() {
      for (const handler of hostBundle.unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
      vmBundle.cleanup();
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

function legacySnapshot(env, fixture, includeScope=true) {
  const h=env.helpers,entries=[...fixture.rows].filter(([key])=>includeScope||![h.LIVE_PERSONA_INDEX_STORAGE_KEY,fixture.shardKey,h.PERSONA_PROOF_STORAGE_KEY].includes(key));
  const file=path.join(env.dataDir,'preexisting-legacy-owner-response.json');fs.writeFileSync(file,JSON.stringify(entries));
  const transport=createSnapshotBridge(env.bridge,file),recovery=h.createRecovery(transport.api);
  return {file,entries,recovery,transport};
}
async function currentScopeAndSharedRestoreCase() {
  const env=await launch('full');
  try {
    const fixture=sharedFixture(env),snapshot=legacySnapshot(env,fixture),before=fs.readFileSync(snapshot.file,'utf8');
    const preview=await snapshot.recovery.preview();assert.equal(preview.validated,true);assert.equal(preview.conflicts.length,0);
    assert(fixture.rows.size>=10);for(const [key] of fixture.rows)assert.equal(await env.pluginStorage.getItem(key),null,'preview never publishes');
    const restored=await snapshot.recovery.publish(preview);assert.equal(restored.verified,true);assert.equal(restored.serverWrites,0);assert.equal(restored.serverDeletes,0);
    for(const [key,value] of fixture.rows)assert.equal(await env.pluginStorage.getItem(key),value,`explicit local publication exact physical bytes: ${key}`);
    const vault=await env.helpers.readStoredResultVault();assert(vault.some(row=>row.personaPrompt.includes('Archivist')),'actual owner reader sees restored body');
    assert.equal((await env.helpers.readPersonaVisualAssetBackup(fixture.backupId)).bytes.length,16,'actual owner reader validates restored image backup');
    assert.equal(fs.readFileSync(snapshot.file,'utf8'),before,'source bytes immutable');assert(snapshot.transport.calls.every(route=>route.startsWith('GET ')));
    await assert.rejects(()=>snapshot.recovery.publish(preview),/LIA_RECOVERY_PREVIEW_STALE/);
    return {restored:restored.restored,sourceUnchanged:true,readOnlyPreview:true,actualOwnerReadback:true};
  }finally{await env.close();}
}
async function sharedOnlyAndFailureCase() {
  const env=await launch('shared-only');
  try {
    const fixture=sharedFixture(env),snapshot=legacySnapshot(env,fixture,false);
    let preview=await snapshot.recovery.preview();assert.equal(preview.scopeCount,1);assert.equal(preview.conflicts.length,0);
    const originalWrite=env.pluginStorage.setItem,dropKey=fixture.backupChunkKey;
    const before=[...env.pluginStorage.map];env.pluginStorage.setItem=async(key,value)=>key===dropKey?true:originalWrite(key,value);
    await assert.rejects(()=>snapshot.recovery.publish(preview),/LIA_RECOVERY_LOCAL_READBACK_FAILED|memory_suite_pluginstorage_readback_mismatch/);
    assert.deepEqual([...env.pluginStorage.map],before,'failed publication rolls preceding rows back and leaves dropped row absent');
    env.pluginStorage.setItem=originalWrite;preview=await snapshot.recovery.preview();const restored=await snapshot.recovery.publish(preview);assert.equal(restored.verified,true);
    for(const [key,value] of snapshot.entries)assert.equal(await env.pluginStorage.getItem(key),value,`shared-only restore: ${key}`);
    // The current explicit importer retains remote deletion marks; it does not
    // delete a current local result because a historical server marked it gone.
    const vaultKey=env.helpers.RESULT_VAULT_STORAGE_KEY,vaultBefore=env.pluginStorage.map.get(vaultKey);
    fs.writeFileSync(snapshot.file,JSON.stringify({records:snapshot.entries.filter(([key])=>key!==vaultKey),tombstones:[vaultKey]}));
    preview=await snapshot.recovery.preview();assert.equal(preview.retainedServerTombstones,1);assert.equal((await snapshot.recovery.publish(preview)).verified,true);assert.equal(env.pluginStorage.map.get(vaultKey),vaultBefore,'historical server tombstone never deletes current local body');
    fs.writeFileSync(snapshot.file,JSON.stringify(snapshot.entries));
    const local=[...env.pluginStorage.map];const corrupted=snapshot.entries.map(([key,value])=>[key,key===dropKey?'!!!!':value]);fs.writeFileSync(snapshot.file,JSON.stringify(corrupted));
    await assert.rejects(()=>snapshot.recovery.preview(),/LIA_RECOVERY_VALIDATION_FAILED/);assert.deepEqual([...env.pluginStorage.map],local,'corrupt source never changes the restored local owner');
    fs.writeFileSync(snapshot.file,JSON.stringify(snapshot.entries));
    const key=env.helpers.RESULT_VAULT_STORAGE_KEY;env.pluginStorage.map.set(key,JSON.stringify({version:1,items:[{id:'local-current',personaPrompt:'Current local persona'}]}));
    preview=await snapshot.recovery.preview();assert(preview.conflicts.length>0);await assert.rejects(()=>snapshot.recovery.publish(preview),/LIA_RECOVERY_LOCAL_CONFLICT/);assert.match(env.pluginStorage.map.get(key),/Current local persona/,'legacy source never overwrites newer local body');
    return {restored:restored.restored,droppedWriteRejected:true,rollbackExact:true,retrySucceeded:true,corruptRejected:true,currentLocalConflictPreserved:true,historicalTombstoneRetained:true};
  }finally{await env.close();}
}
async function emptySnapshotCase() {
  const env=await launch('empty');
  try {
    const snapshot=legacySnapshot(env,{rows:new Map()});const before=[...env.pluginStorage.map];
    await assert.rejects(()=>snapshot.recovery.preview(),/LIA_RECOVERY_SNAPSHOT_EMPTY/);assert.deepEqual([...env.pluginStorage.map],before);
    return {rejected:true,code:'LIA_RECOVERY_SNAPSHOT_EMPTY'};
  }finally{await env.close();}
}

(async () => {
  const full = await currentScopeAndSharedRestoreCase();
  const sharedOnly = await sharedOnlyAndFailureCase();
  const empty = await emptySnapshotCase();
  process.stdout.write(`${JSON.stringify({
    schema:'lia.explicit-legacy-local-recovery.runtime-test.v2',
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
