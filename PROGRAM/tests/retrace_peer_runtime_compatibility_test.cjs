'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const installedVersion = name => {
  const text = fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
  const version = text.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
  assert.ok(version, name + ' installation header');
  return version;
};

const pluginFiles = [
  'Flashback_Memory.js',
  'HAYAKU_Locator_Continuity.js',
  'LIA_Persona_Linker.js',
  'LIBRA.js',
  'RETRACE.js'
];
const requestChannels = [
  'flashback_memory_bridge_request_v1',
  'hayaku_memory_bridge_request_v1',
  'lia_persona_handoff_request_v1',
  'libra_memory_bridge_request_v1'
];
const responseSenders = Object.freeze({
  flashback_memory_bridge_response_v1: 'flashback_memory',
  hayaku_memory_bridge_response_v1: 'hayaku_locator_continuity',
  lia_persona_handoff_response_v1: 'lia_persona_linker',
  libra_memory_bridge_response_v1: 'libra'
});

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const createHost = () => {
  const listeners = new Map();
  const unloadHandlers = [];
  const pluginStorage = createStore();
  const safeLocalStorage = createStore();
  const emptyChat = { id: 'compat-chat', chatId: 'compat-chat', name: 'Compatibility', message: [], messages: [], bindedPersona: '' };
  const emptyCharacter = { id: 'compat-character', name: 'Compatibility', chats: [emptyChat] };
  const addListener = (channel, handler) => {
    const key = String(channel);
    const rows = listeners.get(key) || new Set();
    rows.add(handler);
    listeners.set(key, rows);
    return { channel: key, handler };
  };
  const removeListener = (channel, handler) => {
    const rows = listeners.get(String(channel));
    if (!rows) return false;
    rows.delete(handler);
    return true;
  };
  const host = {
    pluginStorage,
    safeLocalStorage,
    listeners,
    unloadHandlers,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
      if (String(name).includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('runtime compatibility fixture has no external server'); },
    async addPluginChannelListener(channel, handler) { return addListener(channel, handler); },
    async removePluginChannelListener(channel, handler) { return removeListener(channel, handler); },
    async removePluginChannelHandler(channel, handler) { return removeListener(channel, handler); },
    async offPluginChannelMessage(channel, handler) { return removeListener(channel, handler); },
    async postPluginChannelMessage(_target, channel, message) {
      const key = String(channel);
      const sender = responseSenders[key] || (requestChannels.includes(key) ? 'flashback_hayaku_bridge' : '');
      const rows = Array.from(listeners.get(key) || []);
      for (const handler of rows) await handler(message, { sender });
      return true;
    },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async addRisuChatListener() { return true; },
    async removeRisuChatListener() { return true; },
    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [emptyCharacter], plugins: [] };
      if (!Array.isArray(fields)) return all;
      return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
    },
    async setDatabase() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return emptyCharacter; },
    async getCharacterFromIndex() { return emptyCharacter; },
    async getChat() { return emptyChat; },
    async getCurrentChat() { return emptyChat; },
    async getChatFromIndex() { return emptyChat; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; }
  };
  return host;
};

(async () => {
  const host = createHost();
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...innerArgs) => {
      activeTimeouts.delete(timer);
      handler(...innerArgs);
    }, delay, ...args);
    activeTimeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => {
    activeTimeouts.delete(timer);
    clearTimeout(timer);
  };
  const trackedSetInterval = (handler, delay, ...args) => {
    const timer = setInterval(handler, delay, ...args);
    activeIntervals.add(timer);
    return timer;
  };
  const trackedClearInterval = timer => {
    activeIntervals.delete(timer);
    clearInterval(timer);
  };
  const context = vm.createContext({
    risuai: host,
    console: quietConsole,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    queueMicrotask,
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    confirm: () => false,
    alert: () => {},
    prompt: () => null
  });

  for (const file of pluginFiles) {
    const source = fs.readFileSync(path.join(root, 'plugins', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  const retrace = await waitFor(() => context.__RETRACE, 'RE:TRACE public API');
  const hayakuRuntime = await waitFor(() => context.HAYAKU, 'HAYAKU public API');
  for (const channel of requestChannels) {
    await waitFor(() => (host.listeners.get(channel)?.size || 0) > 0, `${channel} owner listener`);
  }

  // v2.4.39 regression: an absent Recovery Vault is immutable raw storage (null).
  // Two read-only fingerprints separated in time must remain identical; the old
  // normalized empty-vault fingerprint changed because emptyRecoveryVault() minted
  // a fresh updatedAt on every read.
  const absentVaultBefore = await hayakuRuntime._test.recoveryVaultStorageFingerprint('compat-absent-recovery-vault');
  await new Promise(resolve => setTimeout(resolve, 12));
  const absentVaultAfter = await hayakuRuntime._test.recoveryVaultStorageFingerprint('compat-absent-recovery-vault');
  assert.equal(absentVaultBefore.present, false, 'absent Recovery Vault stays physically absent');
  assert.equal(absentVaultAfter.present, false, 'second Recovery Vault inspection stays physically absent');
  assert.equal(absentVaultAfter.fingerprint, absentVaultBefore.fingerprint, 'absent Recovery Vault source fingerprint is deterministic');

  // v1.9.54 regression: zero packet records do not mean zero HAYAKU-owned state.
  // RE:TRACE must still ask the authenticated owner so Recovery Vault-only history
  // can be adopted/verified. This fixture has no bridge marker, so HAYAKU should
  // reject the mutation -- but RE:TRACE must have attempted it instead of returning
  // the retired no_hayaku_records shortcut.
  const zeroPacketAdoption = await retrace.adoptHayakuSessionHandoff({
    targetChatId: 'compat-chat',
    transferId: 'compat-zero-packet-handoff',
    sourceScopeKey: 'compat-source-scope',
    expectedRecords: 0,
    attempts: 1
  });
  assert.equal(zeroPacketAdoption.attempted, true, 'zero-packet HAYAKU handoff still contacts owner');
  assert.notEqual(zeroPacketAdoption.reason, 'no_hayaku_records', 'zero-packet shortcut is removed');

  const expected = {
    flashback: { pluginId: 'flashback_memory', pluginVersion: installedVersion('Flashback_Memory.js'), transport: 'flashback_plugin_ipc', peerRole: 'episodic_memory', handoffContract: 'flashback_memory.handoff_immutable_source.v2', receiptSchema: 'flashback_memory.session_handoff_adoption.v4' },
    hayaku: { pluginId: 'hayaku_locator_continuity', pluginVersion: installedVersion('HAYAKU_Locator_Continuity.js'), transport: 'hayaku_plugin_ipc', peerRole: 'packet_continuity_memory', handoffContract: 'hayaku.handoff_immutable_source.v1', receiptSchema: 'hayaku.session_handoff.receipt.v1' },
    lia: { pluginId: 'lia_persona_linker', pluginVersion: installedVersion('LIA_Persona_Linker.js'), transport: 'lia_plugin_ipc', peerRole: 'live_persona_state', handoffContract: 'lia.live_persona_handoff_immutable_source.v1', receiptSchema: 'lia.live_persona_handoff.receipt.v1' },
    libra: { pluginId: 'libra', pluginVersion: installedVersion('LIBRA.js'), transport: 'libra_plugin_ipc', peerRole: 'canonical_long_term_memory', handoffContract: 'libra.handoff_immutable_source_lenses.v2', receiptSchema: 'libra.session_handoff.receipt.v1' }
  };

  for (const retiredDispatcher of ['requestFlashbackIpc', 'requestHayakuIpc', 'requestLibraIpc', 'requestLiaIpc']) {
    assert.equal(retiredDispatcher in retrace._test, false, `production _test must not expose generic owner dispatcher: ${retiredDispatcher}`);
  }
  const normalizedFlashbackStats = retrace._test.normalizeFlashbackStats({
    recordTotal: 148,
    tokenTotal: 4992,
    byType: {
      response: { records: 13, tokens: 4953 },
      episode_index: { records: 2, tokens: 39 }
    }
  }, []);
  assert.equal(normalizedFlashbackStats.byType.response.records, 13, 'Flashback response object stats');
  assert.equal(normalizedFlashbackStats.byType.episode_index.records, 2, 'Flashback episode object stats');
  assert.equal(normalizedFlashbackStats.tokenTotal, 4992, 'Flashback native tokenTotal');

  const storageRows = await Promise.all(
    Object.keys(expected).map(owner => retrace._test.requestMemorySuiteOwnerStorageStatus(owner))
  );
  const storageStatuses = Object.fromEntries(storageRows.map(row => {
    assert.equal(row.connected, true, `${row.owner} storage status failed: ${row.reason || ''}`);
    return [row.owner, row.payload];
  }));
  for (const [owner, status] of Object.entries(storageStatuses)) {
    assert.equal(status.mode, 'plugin_only', `${owner} current-scope storage status mode`);
    assert.ok(status.status && typeof status.status === 'object', `${owner} storage status payload`);
  }
  const results = {};
  for (const [key, contract] of Object.entries(expected)) {
    const result = await retrace._test.probeUniversalPeerCompatibility(key, {
      required: true,
      forceProbe: true,
      timeoutMs: 3000
    });
    results[key] = result;
    assert.equal(result.installed, true, `${key} owner is reachable through its real IPC listener`);
    assert.equal(result.ownerReachable, true, `${key} owner response is authenticated`);
    assert.equal(result.compatible, true, `${key} compatibility contract passes RE:TRACE evaluation`);
    assert.equal(result.blocking, false, `${key} does not block handoff`);
    assert.equal(result.status, 'compatible', `${key} compatibility status`);
    assert.equal(result.transport, contract.transport, `${key} negotiated IPC transport`);
    assert.equal(result.pluginId, contract.pluginId, `${key} stable plugin ID`);
    assert.equal(result.pluginVersion, contract.pluginVersion, `${key} current packaged version`);
    assert.equal(result.compatibility.protocolMajor, 1, `${key} protocol major`);
    assert.equal(result.compatibility.peerRole, contract.peerRole, `${key} peer role`);
    assert.equal(result.compatibility.handoff.contract, contract.handoffContract, `${key} immutable-source handoff contract`);
    assert.ok(result.compatibility.handoff.receiptSchemas.includes(contract.receiptSchema), `${key} durable receipt schema`);
    for (const feature of ['inspect', 'nextSessionHandoff', 'sourceImmutableHandoff', 'durableTargetReadback', 'idempotentHandoff', 'inheritedStateUsable']) {
      assert.equal(result.compatibility.features[feature], true, `${key} feature ${feature}`);
    }
  }

  // Diagnostic capabilities work even when the host has no selected character.
  const getCharacter = host.getCharacter, getCharacterFromIndex = host.getCharacterFromIndex;
  host.getCharacter = host.getCharacterFromIndex = async () => null;
  try {
    const standalone = await retrace.inspectCompatibility(null, { protocolOnly: true, forceProbe: true, timeoutMs: 3000 });
    assert.equal(standalone.protocolOnly, true);
    assert.equal(standalone.complete, true);
    assert.equal(standalone.respondingPeers, 4);
    assert.equal(standalone.compatible, true);
    assert.equal(standalone.handoffAllowed, false, 'no-chat diagnostics never authorizes handoff');
  } finally { host.getCharacter = getCharacter; host.getCharacterFromIndex = getCharacterFromIndex; }

  for (const handler of host.unloadHandlers.slice().reverse()) {
    try { await handler(); } catch (_) {}
  }
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  activeTimeouts.clear();
  activeIntervals.clear();

  process.stdout.write(`retrace_peer_runtime_compatibility_test: PASS ${Object.keys(results).join(',')}\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

