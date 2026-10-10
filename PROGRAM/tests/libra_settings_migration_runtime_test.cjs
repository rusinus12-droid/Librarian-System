'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const KEYS = Object.freeze({
  migration: 'libra:v1:migration',
  runtime: 'libra:v1:runtime-settings',
  referenceBudget: 'libra:v1:reference-budget-migration'
});

const waitFor = async (read, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA settings migration runtime did not initialize');
};

const completeMarker = overrides => ({
  version: 2,
  ragRouteVersion: 2,
  stageDefaultsVersion: 4,
  easyLengthVersion: 1,
  referenceBudgetVersion: 3,
  migrated: false,
  migratedAt: '2026-09-02T00:00:00.000Z',
  source: 'test',
  ...overrides
});

const raw = value => JSON.stringify(value);
const readJson = (store, key) => store.has(key) ? JSON.parse(store.get(key)) : null;
const plain = value => JSON.parse(JSON.stringify(value));

const boot = async (store = new Map(), argumentSeed = {}) => {
  const unloadHandlers = [];
  const argumentsMap = new Map(Object.entries(argumentSeed));
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
      if (argumentsMap.has(key)) return argumentsMap.get(key);
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key === 'enable_gui') return 'false';
      return '';
    },
    async getArg(name) { return await this.getArgument(name); },
    async setArgument(name, value) { argumentsMap.set(String(name), String(value ?? '')); return true; },
    async setArg(name, value) { return await this.setArgument(name, value); },
    async nativeFetch() { throw new Error('offline settings migration fixture'); },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
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
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  await api.getLibraProviderConfig();
  return {
    api,
    store,
    argumentsMap,
    async cleanup() {
      for (const handler of unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
    }
  };
};

(async () => {
  // Fresh installation: defaults are materialized into a versioned runtime store.
  const freshStore = new Map();
  const fresh = await boot(freshStore);
  const freshConfig = await fresh.api.getLibraProviderConfig();
  assert.equal(freshConfig.responseFamily, 'libra');
  assert.equal(freshConfig.libraResponseMode, 'classic');
  assert.equal(freshConfig.gradiaWritingMode, 'rp');
  assert.equal(freshConfig.inputWriterMode, 'rp');
  const freshEnvelope = readJson(freshStore, KEYS.runtime);
  assert.equal(freshEnvelope.schema, 'libra.runtime_settings_store.v4');
  assert.equal(freshEnvelope.version, 4);
  assert.equal(freshEnvelope.settings.settings_schema_version, 1);
  assert.equal(freshEnvelope.settings.response_family, 'libra');
  assert.equal(freshEnvelope.settings.libra_response_mode, 'classic');
  assert.equal(freshEnvelope.settings.gradia_writing_mode, 'rp');
  assert.equal(freshEnvelope.settings.input_writer_mode, 'rp');
  assert.equal(readJson(freshStore, KEYS.migration).settingsSchemaVersion, 1);
  await fresh.cleanup();

  // A legacy one-field install keeps historical behavior only for the one-time migration.
  const legacyStore = new Map([
    [KEYS.migration, raw(completeMarker({ settingsSchemaVersion: 0 }))],
    [KEYS.referenceBudget, raw({ version: 3, source: 'test' })],
    [KEYS.runtime, raw({ version: 3, settings: {
      injection_mode: 'sga',
      input_writer_mode: 'author',
      live_context_enabled: 'false',
      planner_preset: '',
      response_lore_start_count: '3'
    } })]
  ]);
  const legacy = await boot(legacyStore);
  const legacyConfig = await legacy.api.getLibraProviderConfig();
  assert.equal(legacyConfig.responseFamily, 'gradia');
  assert.equal(legacyConfig.gradiaWritingMode, 'author', 'legacy shared field initializes GRADIA once');
  assert.equal(legacyConfig.inputWriterMode, 'author', 'legacy shared field initializes Input Writer once');
  const migratedLegacy = (await legacy.api.debugReadRuntimeSettings()).settings;
  assert.equal(migratedLegacy.live_context_enabled, 'false');
  assert.equal(migratedLegacy.planner_preset, '', 'explicit empty preset binding is preserved');
  assert.equal(migratedLegacy.response_lore_start_count, '3');
  assert.equal(migratedLegacy.settings_schema_version, 1);
  await legacy.cleanup();

  // Both mode-local fields remain independent and survive a full plugin reload.
  const independentStore = new Map([
    [KEYS.migration, raw(completeMarker({ settingsSchemaVersion: 0 }))],
    [KEYS.referenceBudget, raw({ version: 3, source: 'test' })],
    [KEYS.runtime, raw({ version: 3, settings: {
      response_family: 'libra',
      libra_response_mode: 'classic',
      gradia_writing_mode: 'author',
      input_writer_mode: 'rp',
      injection_mode: 'classic',
      live_context_enabled: 'false',
      risuai_aux_allow_plugins: 'false',
      planner_preset: '',
      selected_module_lore_ids: '["module-a","module-b"]',
      excluded_character_lore_ids: '["char-lore-x"]'
    } })]
  ]);
  const firstBoot = await boot(independentStore);
  const firstConfig = await firstBoot.api.getLibraProviderConfig();
  assert.deepEqual(
    plain({
      responseFamily: firstConfig.responseFamily,
      libraResponseMode: firstConfig.libraResponseMode,
      gradiaWritingMode: firstConfig.gradiaWritingMode,
      inputWriterMode: firstConfig.inputWriterMode,
      injectionMode: firstConfig.injectionMode
    }),
    { responseFamily: 'libra', libraResponseMode: 'classic', gradiaWritingMode: 'author', inputWriterMode: 'rp', injectionMode: 'classic' }
  );
  const firstRead = await firstBoot.api.debugReadRuntimeSettings();
  assert.equal(firstRead.settings.live_context_enabled, 'false');
  assert.equal(firstRead.settings.risuai_aux_allow_plugins, 'false');
  assert.equal(firstRead.settings.planner_preset, '');
  assert.equal(firstRead.settings.selected_module_lore_ids, '["module-a","module-b"]');
  assert.equal(firstRead.settings.excluded_character_lore_ids, '["char-lore-x"]');

  const switched = await firstBoot.api.saveLibraProviderConfig({
    responseFamily: 'gradia',
    libraResponseMode: 'classic',
    gradiaWritingMode: 'rp',
    inputWriterMode: 'author'
  });
  assert.deepEqual(
    plain({
      responseFamily: switched.responseFamily,
      libraResponseMode: switched.libraResponseMode,
      gradiaWritingMode: switched.gradiaWritingMode,
      inputWriterMode: switched.inputWriterMode,
      injectionMode: switched.injectionMode
    }),
    { responseFamily: 'gradia', libraResponseMode: 'classic', gradiaWritingMode: 'rp', inputWriterMode: 'author', injectionMode: 'sga' }
  );
  const switchedStored = (await firstBoot.api.debugReadRuntimeSettings()).settings;
  assert.equal(switchedStored.gradia_writing_mode, 'rp');
  assert.equal(switchedStored.input_writer_mode, 'author');
  assert.equal(switchedStored.libra_response_mode, 'classic');
  assert.equal(switchedStored.live_context_enabled, 'false', 'saving modes does not replace an explicit non-default setting');
  await firstBoot.cleanup();

  const reloaded = await boot(independentStore);
  const reloadConfig = await reloaded.api.getLibraProviderConfig();
  assert.equal(reloadConfig.responseFamily, 'gradia');
  assert.equal(reloadConfig.libraResponseMode, 'classic');
  assert.equal(reloadConfig.gradiaWritingMode, 'rp');
  assert.equal(reloadConfig.inputWriterMode, 'author');
  assert.equal(reloadConfig.injectionMode, 'sga');

  const backToLibra = await reloaded.api.saveLibraProviderConfig({ responseFamily: 'libra' });
  assert.equal(backToLibra.responseFamily, 'libra');
  assert.equal(backToLibra.libraResponseMode, 'classic', 'LIBRA restores its mode-local Classic selection');
  assert.equal(backToLibra.gradiaWritingMode, 'rp', 'inactive GRADIA selection remains remembered');
  assert.equal(backToLibra.inputWriterMode, 'author', 'Input Writer selection remains independent');
  assert.equal(backToLibra.injectionMode, 'classic');
  await reloaded.cleanup();

  process.stdout.write('libra_settings_migration_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
