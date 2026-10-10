'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(10);
  }
  throw new Error('LIBRA runtime load timeout');
};

const createRuntime = async (argumentsByName = {}) => {
  const values = new Map();
  const storage = {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; }
  };
  const llmCalls = [];
  const llmQueue = [];
  let unload = null;
  const host = {
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getArgument(name) { return argumentsByName[String(name)]; },
    async getArg(name) { return await host.getArgument(name); },
    async nativeFetch() { throw new Error('offline runtime fixture'); },
    async onUnload(handler) { unload = handler; return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async addRisuReplacer() { return true; },
    async addRisuChatListener() { return true; },
    async addRisuScriptHandler() { return true; },
    async runLLMModel(options) {
      llmCalls.push(structuredClone(options));
      if (!llmQueue.length) return { type: 'success', result: 'OK' };
      const next = llmQueue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return await next(options);
      return next;
    }
  };
  const context = vm.createContext({
    risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, AbortSignal, DOMException,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
    performance: globalThis.performance, Blob: globalThis.Blob,
    atob: globalThis.atob, btoa: globalThis.btoa
  });
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  return {
    api, host, context, llmCalls, llmQueue,
    async cleanup() { if (unload) await unload(); }
  };
};

(async () => {
  const fresh = await createRuntime();
  try {
    const config = await fresh.api.getLibraProviderConfig();
    assert.equal(fresh.api.version, releaseVersion('libra'));
    assert.equal(config.defaultPresetName, 'risuai_aux', 'fresh installs use the built-in auxiliary connection');
    assert.equal(config.providerPresets.risuai_aux.provider, 'risuai_aux');
    assert.equal(config.providerPresets.risuai_aux.key, undefined, 'the built-in route exposes no provider key');
    assert.equal(config.risuAuxAllowPlugins, true, 'fresh installs allow RisuAI plugin-provided auxiliary models');

    delete fresh.context.risuai;
    const result = await fresh.api.testLibraLlmProvider('ariadne');
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'risuai_aux');
    assert.equal(result.model, 'RisuAI auxiliary (otherAx)');
    assert.equal(fresh.llmCalls.length, 1, 'one test performs one physical runLLMModel call');
    assert.equal(fresh.llmCalls[0].mode, 'otherAx');
    assert.equal(fresh.llmCalls[0].allowPlugins, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(fresh.llmCalls[0], 'staticModel'), 'RisuAI owns auxiliary model selection');
    assert.deepEqual(fresh.llmCalls[0].messages.map(message => message.role), ['system', 'user']);
    assert.equal(fresh.api.getRuntime().risuAuxiliary.apiSource, 'captured_startup_api', 'captured API survives hidden aliases');

    const probe = await fresh.api.testRisuAuxiliaryCall();
    assert.equal(probe.schema, 'libra.risuai_auxiliary_call_probe.v1');
    assert.equal(probe.ok, true);
    assert.equal(probe.status, 'success');
    assert.equal(probe.submitted, true);
    assert.equal(probe.transport, 'risuai.runLLMModel');
    assert.equal(probe.mode, 'otherAx');
    assert.equal(probe.apiSource, 'captured_startup_api');
    assert.equal(probe.responsePreview, 'OK');
    assert.equal(fresh.llmCalls.length, 2, 'the dedicated call probe performs exactly one additional physical call');
    assert.equal(fresh.llmCalls[1].mode, 'otherAx');
    assert.equal(fresh.llmCalls[1].allowPlugins, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(fresh.llmCalls[1], 'staticModel'));
    assert.equal(fresh.api.getRuntime().risuAuxiliary.lastProbe.status, 'success', 'the session diagnostic retains the latest probe');
  } finally {
    await fresh.cleanup();
  }

  const existing = await createRuntime({
    default_preset: 'legacy_direct',
    ariadne_preset: 'legacy_direct',
    model_presets_json: JSON.stringify({
      legacy_direct: {
        provider: 'openai', url: 'https://api.openai.com/v1/chat/completions',
        key: 'fixture-secret', model: 'fixture-model'
      }
    })
  });
  try {
    const config = await existing.api.getLibraProviderConfig();
    assert.equal(config.defaultPresetName, 'legacy_direct', 'an existing explicit global default is preserved');
    assert.equal(config.stagePresetNames.ariadne, 'legacy_direct', 'an existing stage override remains authoritative');
    assert.equal(config.providerPresets.risuai_aux.provider, 'risuai_aux', 'the convenience route is still available');
    assert.equal(existing.llmCalls.length, 0);
  } finally {
    await existing.cleanup();
  }

  const legacyImplicitDefault = await createRuntime({
    llm_provider: 'openai',
    llm_url: 'https://api.openai.com/v1/chat/completions',
    llm_key: 'legacy-key',
    llm_model: 'legacy-model'
  });
  try {
    const config = await legacyImplicitDefault.api.getLibraProviderConfig();
    assert.equal(config.defaultPresetName, 'risuai_aux',
      'legacy llm_* fallback arguments no longer create the reserved default connection');
    assert.equal(Object.hasOwn(config.providerPresets, 'default'), false);
    assert.equal(Object.values(config.providerPresets).some(preset => preset?.model === 'legacy-model'), false);
    assert.equal(legacyImplicitDefault.llmCalls.length, 0);
  } finally {
    await legacyImplicitDefault.cleanup();
  }

  const reservedDefault = await createRuntime({
    default_preset: 'default',
    ariadne_preset: 'default',
    model_presets_json: JSON.stringify({
      default: {
        provider: 'ollama_cloud', model: 'glm-5.3-flash'
      }
    })
  });
  try {
    const config = await reservedDefault.api.getLibraProviderConfig();
    assert.equal(config.defaultPresetName, 'risuai_aux',
      'a historical reserved default binding migrates to the built-in auxiliary connection');
    assert.equal(config.stagePresetNames.ariadne, '',
      'a historical stage-level default alias is cleared so it inherits the shared auxiliary connection');
    assert.equal(Object.hasOwn(config.providerPresets, 'default'), false,
      'a stored reserved default preset is omitted from the runtime and GUI provider bank');
    assert.equal(config.providerPresets.risuai_aux.provider, 'risuai_aux');
    assert.equal(reservedDefault.llmCalls.length, 0);
  } finally {
    await reservedDefault.cleanup();
  }

  const pluginModel = await createRuntime({ risuai_aux_allow_plugins: 'true' });
  try {
    pluginModel.llmQueue.push({ type: 'success', result: 'PLUGIN OK' });
    const result = await pluginModel.api.testLibraLlmProvider('ariadne');
    assert.equal(result.ok, true);
    assert.equal(pluginModel.llmCalls[0].allowPlugins, true, 'an explicit true setting reaches the host call');
  } finally {
    await pluginModel.cleanup();
  }

  const pluginModelBlocked = await createRuntime({ risuai_aux_allow_plugins: 'false' });
  try {
    pluginModelBlocked.llmQueue.push({ type: 'success', result: 'STANDARD OK' });
    const result = await pluginModelBlocked.api.testLibraLlmProvider('ariadne');
    assert.equal(result.ok, true);
    assert.equal(pluginModelBlocked.llmCalls[0].allowPlugins, false, 'an explicit false setting continues to block plugin-provided models');
  } finally {
    await pluginModelBlocked.cleanup();
  }

  const failure = await createRuntime();
  try {
    failure.llmQueue.push(new Error('provider offline'));
    await assert.rejects(failure.api.testLibraLlmProvider('ariadne'), /provider offline/);
    assert.equal(failure.llmCalls.length, 1, 'a settled transport failure is never automatically retried');
  } finally {
    await failure.cleanup();
  }

  const probeFailure = await createRuntime();
  try {
    probeFailure.llmQueue.push(new Error('auxiliary probe offline'));
    const probe = await probeFailure.api.testRisuAuxiliaryCall();
    assert.equal(probe.ok, false);
    assert.equal(probe.status, 'failed');
    assert.equal(probe.submitted, true);
    assert.match(probe.error, /auxiliary probe offline/);
    assert.equal(probeFailure.llmCalls.length, 1, 'a failed call probe is never retried');
  } finally {
    await probeFailure.cleanup();
  }

  const serial = await createRuntime();
  try {
    let finishFirst;
    serial.llmQueue.push(
      () => new Promise(resolve => { finishFirst = resolve; }),
      { type: 'success', result: 'SECOND' }
    );
    const first = serial.api.testLibraLlmProvider('ariadne');
    await waitFor(() => typeof finishFirst === 'function');
    const second = serial.api.testLibraLlmProvider('ariadne');
    await wait(40);
    assert.equal(serial.llmCalls.length, 1, 'a second auxiliary request waits instead of overlapping');
    finishFirst({ type: 'success', result: 'FIRST' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.content, 'FIRST');
    assert.equal(secondResult.content, 'SECOND');
    assert.equal(serial.llmCalls.length, 2);
  } finally {
    await serial.cleanup();
  }

  process.stdout.write('libra_risuai_auxiliary_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

