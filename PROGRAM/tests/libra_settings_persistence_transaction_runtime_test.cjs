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
  runtime: 'libra:v1:runtime-settings',
  agents: 'libra:v1:agent-slots',
  prompts: 'libra:v1:prompt-overrides',
  providers: 'libra:v1:provider-presets',
  journal: 'libra:v1:settings-transaction-journal',
  backendLocal: 'libra:v1:backend-hosting-token',
  backendSynced: 'libra:v1:backend-hosting-token-synced:v1'
});

const waitFor = async (read, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA settings transaction runtime did not initialize');
};
const plain = value => JSON.parse(JSON.stringify(value));
const stableMap = map => JSON.stringify([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

const store = new Map();
const argumentMap = new Map([['enable_gui', 'false']]);
const unloadHandlers = [];
let failNextKey = '';
let corruptNextKey = '';
const storage = {
  async getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  async setItem(key, value) {
    const name = String(key);
    if (name === failNextKey) {
      failNextKey = '';
      throw new Error(`simulated write failure:${name}`);
    }
    if (name === corruptNextKey) {
      corruptNextKey = '';
      store.set(name, '{"schema":"corrupted.settings.fixture","value":true}');
      return true;
    }
    store.set(name, value);
    return true;
  },
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
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    return '';
  },
  async getArg(name) { return await this.getArgument(name); },
  async setArgument(name, value) { argumentMap.set(String(name), String(value ?? '')); return true; },
  async setArg(name, value) { return await this.setArgument(name, value); },
  async nativeFetch() { throw new Error('offline settings transaction fixture'); },
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

const payloadFor = suffix => ({
  providers: {
    alpha: {
      provider: 'custom',
      url: `http://127.0.0.1:999${suffix}/v1`,
      model: `model-${suffix}`,
      temp: 0.25,
      max_tokens: 3200,
      timeout_ms: 45000,
      prompt_cache: 'off'
    }
  },
  backendToken: `backend-${suffix}`,
  runtime: {
    response_family: suffix === 'a' ? 'libra' : 'gradia',
    libra_response_mode: 'classic',
    gradia_writing_mode: suffix === 'a' ? 'author' : 'rp',
    input_writer_mode: suffix === 'a' ? 'rp' : 'author',
    injection_mode: suffix === 'a' ? 'classic' : 'sga',
    live_context_enabled: suffix === 'a' ? 'false' : 'true',
    default_preset: 'alpha',
    planner_preset: suffix === 'a' ? '' : 'alpha',
    selected_module_lore_ids: JSON.stringify([`module-${suffix}`]),
    excluded_module_lore_ids: JSON.stringify([`excluded-module-${suffix}`]),
    excluded_character_lore_ids: JSON.stringify([`excluded-character-${suffix}`]),
    enable_gui: 'false'
  },
  agents: {
    ariadne: {
      enabled: true,
      preset: 'alpha',
      max_chars: 18000,
      turn_window: 5,
      timeout_ms: 45000,
      execution_mode: 'draft_only',
      risu_refs: {
        author_note: true,
        persona: true,
        character_description: true,
        character_lorebook: true,
        module_lorebook: true
      }
    },
    state_character_observer: {
      enabled: true,
      preset: 'alpha',
      max_chars: 12000,
      turn_window: 5,
      timeout_ms: 45000,
      execution_mode: 'draft_only',
      risu_refs: {
        author_note: false,
        persona: true,
        character_description: true,
        character_lorebook: false,
        module_lorebook: true
      }
    }
  },
  prompts: {
    activeMemoryProfile: `memory-${suffix}`,
    memoryProfiles: {
      [`memory-${suffix}`]: {
        name: `memory-${suffix}`,
        version: 1,
        stages: {
          ariadne: {
            sections: {
              custom_addendum: { mode: 'append', text: `memory instruction ${suffix}` }
            }
          }
        }
      }
    },
    activePlannerProfile: `planner-${suffix}`,
    plannerProfiles: {
      [`planner-${suffix}`]: {
        name: `planner-${suffix}`,
        version: 1,
        sections: {
          custom_addendum: { mode: 'append', text: `planner instruction ${suffix}` }
        }
      }
    }
  },
  removePostProcessors: true,
  removeLegacySettings: true
});

(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  await api.getLibraProviderConfig();

  const initial = await api.debugReadSettingsPersistenceBasis();
  const baseline = await api.debugPersistStructuredSettingsState(payloadFor('a'), {
    expectedBasisHash: initial.semanticHash,
    label: 'settings_transaction_baseline'
  });
  assert.equal(baseline.result.ok, true);
  assert.equal(baseline.state.runtime.response_family, 'libra');
  assert.equal(baseline.state.runtime.libra_response_mode, 'classic');
  assert.equal(baseline.state.runtime.gradia_writing_mode, undefined, 'retired helper choice is not restored');
  assert.equal(baseline.state.runtime.input_writer_mode, undefined, 'retired helper choice is not restored');
  assert.equal(baseline.state.runtime.planner_preset, undefined, 'retired planner preset is not restored');
  assert.equal(baseline.state.providers.alpha.model, 'model-a');
  assert.equal(baseline.state.agents.ariadne.preset, 'alpha');
  assert.equal(baseline.state.agents.state_character_observer.risu_refs.persona, true);
  assert.equal(baseline.state.agents.state_character_observer.risu_refs.authorNote, false);
  assert.equal(baseline.state.prompts.activeMemoryProfile, 'memory-a');
  assert.equal(baseline.state.prompts.activePlannerProfile, undefined, 'retired profile bank is absent');
  assert.equal(baseline.state.prompts.plannerProfiles, undefined, 'retired profile content is not active');
  assert.equal(argumentMap.get('backend_hosting_token'), 'backend-a');
  assert.equal(store.has(KEYS.journal), false, 'successful transaction clears its journal');

  // Re-saving the same semantic state is idempotent at the aggregate basis level.
  const duplicate = await api.debugPersistStructuredSettingsState(payloadFor('a'), {
    expectedBasisHash: baseline.semanticHash,
    label: 'settings_transaction_idempotent'
  });
  assert.equal(duplicate.result.ok, true);
  assert.equal(duplicate.result.changed, false);
  assert.equal(duplicate.semanticHash, baseline.semanticHash);

  // Stale GUI/binding bases are rejected before any write occurs.
  const preExternal = await api.debugReadRuntimeSettings();
  await api.debugWriteRuntimeSettings({ ...preExternal.settings, live_context_enabled: 'true' }, {
    expectedSemanticHash: preExternal.semanticHash
  });
  const mapAfterExternal = stableMap(store);
  const argsAfterExternal = stableMap(argumentMap);
  await assert.rejects(
    api.debugPersistStructuredSettingsState(payloadFor('b'), {
      expectedBasisHash: baseline.semanticHash,
      label: 'settings_transaction_stale'
    }),
    error => error?.code === 'SETTINGS_STALE_BASIS'
  );
  assert.equal(stableMap(store), mapAfterExternal, 'stale save performs no durable write');
  assert.equal(stableMap(argumentMap), argsAfterExternal, 'stale save performs no argument write');

  // A failure after provider, token, and runtime writes restores every prior raw value.
  const current = await api.debugReadSettingsPersistenceBasis();
  const rawBeforeFailure = stableMap(store);
  const argsBeforeFailure = stableMap(argumentMap);
  failNextKey = KEYS.agents;
  await assert.rejects(
    api.debugPersistStructuredSettingsState(payloadFor('b'), {
      expectedBasisHash: current.semanticHash,
      label: 'settings_transaction_agent_failure'
    }),
    error => error?.code === 'SETTINGS_TRANSACTION_ROLLED_BACK'
      && error?.rollbackStatus === 'restored'
  );
  assert.equal(stableMap(store), rawBeforeFailure, 'mid-transaction failure restores exact plugin/local raw values');
  assert.equal(stableMap(argumentMap), argsBeforeFailure, 'mid-transaction failure restores backend argument');
  assert.equal(store.has(KEYS.journal), false, 'failed transaction clears its journal after rollback');
  const afterFailure = await api.debugReadSettingsPersistenceBasis();
  assert.equal(afterFailure.semanticHash, current.semanticHash);
  assert.equal(afterFailure.state.runtime.gradia_writing_mode, undefined, 'rollback does not re-enable retired helper');
  assert.equal(afterFailure.state.runtime.input_writer_mode, undefined, 'rollback does not re-enable retired helper');
  assert.equal(afterFailure.state.prompts.activeMemoryProfile, 'memory-a');

  // A storage adapter that returns success with corrupted data is caught by semantic readback.
  const rawBeforeCorruption = stableMap(store);
  const argsBeforeCorruption = stableMap(argumentMap);
  corruptNextKey = KEYS.agents;
  await assert.rejects(
    api.debugPersistStructuredSettingsState(payloadFor('b'), {
      expectedBasisHash: current.semanticHash,
      label: 'settings_transaction_corrupt_readback'
    }),
    error => error?.code === 'SETTINGS_TRANSACTION_ROLLED_BACK'
      && error?.rollbackStatus === 'restored'
  );
  assert.equal(stableMap(store), rawBeforeCorruption, 'semantic corruption restores exact prior raw state');
  assert.equal(stableMap(argumentMap), argsBeforeCorruption);
  assert.equal(store.has(KEYS.journal), false);

  const finalBasis = await api.debugReadSettingsPersistenceBasis();
  assert.equal(finalBasis.semanticHash, current.semanticHash);
  assert.deepEqual(
    plain({
      family: finalBasis.state.runtime.response_family,
      libra: finalBasis.state.runtime.libra_response_mode,
      gradia: finalBasis.state.runtime.gradia_writing_mode,
      writer: finalBasis.state.runtime.input_writer_mode,
      memoryProfile: finalBasis.state.prompts.activeMemoryProfile,
      plannerProfile: finalBasis.state.prompts.activePlannerProfile
    }),
    { family: 'libra', libra: 'classic', memoryProfile: 'memory-a' }
  );

  for (const handler of unloadHandlers.slice().reverse()) {
    try { await handler(); } catch (_) {}
  }
  process.stdout.write('libra_settings_persistence_transaction_runtime_test: PASS\n');
})().catch(async error => {
  for (const handler of unloadHandlers.slice().reverse()) {
    try { await handler(); } catch (_) {}
  }
  console.error(error);
  process.exitCode = 1;
});
