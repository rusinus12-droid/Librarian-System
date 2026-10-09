'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(source, /const pairRevisionProjection = \(raw, index, cacheKeyInput = ''\) =>/);
assert.match(source, /const buildPairs = \(chat, cacheKeyInput = ''\) =>/);
assert.match(source, /pairRevisionCacheStats\.pairReuses/);
assert.match(source, /PAIR_REVISION_CACHE_MAX_RETAINED_CHARS/);

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA cache test runtime.');
};

const store = new Map();
let unload = null;
const storage = {
  async getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  async setItem(key, value) { store.set(String(key), value); return true; },
  async removeItem(key) { store.delete(String(key)); return true; },
  async keys() { return Array.from(store.keys()); }
};
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
    if (String(name).includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('no server'); },
  async onUnload(handler) { unload = handler; return true; },
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
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  AbortController,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  Blob: globalThis.Blob,
  atob: globalThis.atob,
  btoa: globalThis.btoa
});

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA.js' });
  const api = await waitFor(() => context.__LIBRA__);
  assert.equal(api.version, releaseVersion('libra'));

  const chat = { id: 'libra-cache-chat', message: [] };
  for (let turn = 1; turn <= 3; turn += 1) {
    chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
    chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
  }
  chat.messages = chat.message;
  const cacheKey = 'libra-cache-scope';

  const first = api.debugBuildPairs(chat, cacheKey);
  assert.equal(first.length, 3);
  let diag = api.getPairRevisionCacheDiagnostics();
  assert.equal(diag.stats.misses, 6, 'first build normalizes each message once');
  assert.equal(diag.stats.writes, 6);
  assert.equal(diag.stats.pairBuilds, 1);

  const second = api.debugBuildPairs(chat, cacheKey);
  assert.deepEqual(second, first, 'unchanged cache preserves exact U+A pairs');
  let next = api.getPairRevisionCacheDiagnostics();
  assert.equal(next.stats.misses, diag.stats.misses, 'unchanged chat creates no new message misses');
  assert.ok(next.stats.hits >= diag.stats.hits + 6, 'all unchanged messages hit the revision cache');
  assert.equal(next.stats.pairReuses, diag.stats.pairReuses + 1, 'completed U+A snapshot is reused');

  chat.message[3].data = 'Assistant 2 edited';
  const edited = api.debugBuildPairs(chat, cacheKey);
  assert.equal(edited[1].assistant.text, 'Assistant 2 edited');
  diag = api.getPairRevisionCacheDiagnostics();
  assert.equal(diag.stats.misses, next.stats.misses + 1, 'only edited Assistant projection is recomputed');
  assert.equal(diag.stats.invalidations, next.stats.invalidations + 1);
  assert.equal(diag.stats.pairBuilds, next.stats.pairBuilds + 1);

  chat.message = chat.message.slice(0, 4);
  chat.messages = chat.message;
  const rolledBack = api.debugBuildPairs(chat, cacheKey);
  assert.equal(rolledBack.length, 2);
  next = api.getPairRevisionCacheDiagnostics();
  assert.equal(next.stats.misses, diag.stats.misses, 'retained messages remain cached across rollback');
  assert.ok(next.stats.pruned >= diag.stats.pruned + 2, 'only disappeared suffix entries are pruned');

  chat.message.push({ role: 'user', data: 'User 3 new', chatId: 'u-3-new' });
  chat.message.push({ role: 'assistant', data: 'Assistant 3 new', chatId: 'a-3-new' });
  chat.messages = chat.message;
  const appended = api.debugBuildPairs(chat, cacheKey);
  assert.equal(appended.length, 3);
  diag = api.getPairRevisionCacheDiagnostics();
  assert.equal(diag.stats.misses, next.stats.misses + 2, 'append computes only the two new messages');

  if (unload) await unload();
  process.stdout.write('libra_long_chat_pair_revision_cache_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

