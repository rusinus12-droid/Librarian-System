'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA test runtime.');
};

const createLibraVmHarness = async (argumentOverrides = {}, hostOverrides = {}, testOptions = {}) => {
  const program = path.resolve(__dirname, '..', '..');
  let source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN ? path.resolve(process.env.LIBRA_TEST_PLUGIN) : path.join(program, 'plugins', 'LIBRA.js'), 'utf8');
  if(typeof testOptions.transformSource==='function')source=testOptions.transformSource(source);
  // Native producer tests can seed historical records without reviving retired
  // public manual-analysis entry points. This export exists only in the fixture.
  source=source.replace('const memoryStageEnabledForSettings =','globalThis.__fixtureNativeMemoryCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =');
  const values = new Map(testOptions.initialValues || []);
  const storageReads = [];
  const storageWrites = [];
  const storageRemovals = [];
  const unloadHandlers = [];
  const storage = {
    async getItem(key) { storageReads.push(String(key)); return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      storageWrites.push({ key: String(key), value });
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) {
      storageRemovals.push(String(key));
      values.delete(String(key));
      return true;
    },
    async keys() { return [...values.keys()]; }
  };
  const host = {
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getLocalPluginStorage() { return storage; },
    async getArgument(name) {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(argumentOverrides, key)) return argumentOverrides[key];
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key.includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await this.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch(...args) {
      if (typeof hostOverrides.nativeFetch === 'function') return await hostOverrides.nativeFetch(...args);
      throw new Error('offline fixture');
    },
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
  Object.assign(host, hostOverrides);
  const registeredHooks={},originalAddReplacer=host.addRisuReplacer;
  host.addRisuReplacer=async(k,f)=>{registeredHooks[k]=f;return originalAddReplacer?.call(host,k,f);};
  const context = vm.createContext({
    risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, AbortSignal, DOMException, URL, URLSearchParams,
    TextEncoder, TextDecoder, crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone, performance: globalThis.performance,
    Blob: globalThis.Blob, Response: globalThis.Response, Headers: globalThis.Headers, atob: globalThis.atob, btoa: globalThis.btoa,
    confirm: () => false, alert: () => {}, prompt: () => null,
    ...(testOptions.contextGlobals || {})
  });
  vm.runInContext(source, context, { filename: 'LIBRA-test-runtime.js' });
  const api = await waitFor(() => context.__LIBRA__?.version && typeof context.__LIBRA__?.getRuntime === 'function' ? context.__LIBRA__ : null);
  return {
    api,
    core:context.__fixtureNativeMemoryCore,
    context,
    source,
    values,
    storageReads,
    storageWrites,
    storageRemovals,
    async sourceEditBoundary(){await registeredHooks.beforeRequest([{role:'user',content:'Continue.'}],'model');await registeredHooks.afterRequest('Next response.','model');},
    async cleanup() {
      for (const handler of unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
    }
  };
};

module.exports = { createLibraVmHarness, waitFor };
