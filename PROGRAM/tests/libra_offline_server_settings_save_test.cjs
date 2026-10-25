'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const KEYS = Object.freeze({
  runtime: 'libra:v1:runtime-settings',
  agents: 'libra:v1:agent-slots',
  prompts: 'libra:v1:prompt-overrides',
  providers: 'libra:v1:provider-presets',
  journal: 'libra:v1:settings-transaction-journal'
});

const waitFor = async (read, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA did not initialize in time');
};

const store = new Map();
// Set server mode to server_only!
const argumentMap = new Map([
  ['enable_gui', 'false'],
  ['memory_suite_server_mode', 'server_only'],
  ['memory_suite_server_url', 'http://127.0.0.1:47630']
]);

const storage = {
  async getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  async setItem(key, value) { store.set(String(key), value); return true; },
  async removeItem(key) { store.delete(String(key)); return true; },
  async keys() { return [...store.keys()]; }
};

const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name);
    if (argumentMap.has(key)) return argumentMap.get(key);
    return '';
  },
  async getArg(name) { return await this.getArgument(name); },
  async setArgument(name, value) { argumentMap.set(String(name), String(value ?? '')); return true; },
  async setArg(name, value) { return await this.setArgument(name, value); },
  // Server is strictly OFFLINE:
  async nativeFetch() {
    const err = new Error('fetch failed: ECONNREFUSED 127.0.0.1:47630 (server offline)');
    err.code = 'ECONNREFUSED';
    throw err;
  },
  async onUnload() { return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; }
};

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  AbortController, AbortSignal, DOMException, URL, URLSearchParams,
  TextEncoder, TextDecoder, crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone, performance: globalThis.performance,
  Blob: globalThis.Blob, Response: globalThis.Response, Headers: globalThis.Headers,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);

  // Verify that reading settings basis succeeds without throwing memory_suite_server_unavailable
  const basis = await api.debugReadSettingsPersistenceBasis();
  assert.ok(basis && typeof basis.semanticHash === 'string', 'readSettingsPersistenceBasis succeeds when server is offline');

  // Verify that saving settings succeeds in server_only mode when server is offline
  const payload = {
    providers: {
      offline_preset: {
        provider: 'custom',
        url: 'http://127.0.0.1:11434/v1',
        model: 'deepseek-r1',
        temp: 0.7,
        max_tokens: 4096,
        timeout_ms: 60000,
        prompt_cache: 'off'
      }
    },
    backendToken: 'offline-token',
    runtime: {
      response_family: 'libra',
      libra_response_mode: 'classic',
      default_preset: 'offline_preset',
      enable_gui: 'false'
    },
    agents: {
      ariadne: {
        enabled: true,
        preset: 'offline_preset',
        max_chars: 18000,
        turn_window: 5,
        timeout_ms: 45000,
        execution_mode: 'draft_only'
      }
    },
    prompts: {
      activeMemoryProfile: 'default'
    },
    removePostProcessors: true,
    removeLegacySettings: false
  };

  const saveResult = await api.debugPersistStructuredSettingsState(payload, {
    expectedBasisHash: basis.semanticHash,
    label: 'offline_server_settings_save'
  });

  assert.equal(saveResult.result.ok, true, 'Settings save succeeds even when server is offline and server_only mode is configured');
  assert.equal(saveResult.state.providers.offline_preset.model, 'deepseek-r1', 'Saved provider preset is retained in basis state');

  // Read back the basis again to verify durability
  const updatedBasis = await api.debugReadSettingsPersistenceBasis();
  assert.equal(updatedBasis.semanticHash, saveResult.semanticHash, 'Durable basis matches saved semantic hash');
  assert.equal(updatedBasis.state.providers.offline_preset.model, 'deepseek-r1', 'Readback confirms preset is stored locally');

  console.log('libra_offline_server_settings_save_test: PASS');
})().catch(err => {
  console.error('libra_offline_server_settings_save_test FAILED:', err);
  process.exit(1);
});
