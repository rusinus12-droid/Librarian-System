'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createMemorySuiteServer } = require('../server/server.cjs');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins', 'LIBRA.js'), 'utf8');
const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while loading LIBRA product Compute runtime.');
};

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-libra-product-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeWorkers: 2 });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const store = new Map();
  const pluginStorage = {
    async getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
    async setItem(key, value) { store.set(String(key), value); return true; },
    async removeItem(key) { store.delete(String(key)); return true; },
    async keys() { return [...store.keys()]; }
  };
  const chat = {
    id: 'libra-product-chat',
    chatId: 'libra-product-chat',
    name: 'Compute Product',
    message: [
      { role: 'user', data: '아카데미 규칙을 조사한다.', chatId: 'u-1' },
      { role: 'assistant', data: '금지된 도서관의 문이 보였다.', chatId: 'a-1' }
    ]
  };
  chat.messages = chat.message;
  const character = { id: 'libra-product-character', chaId: 'libra-product-character', name: 'LIBRA Product', chats: [chat], chatPage: 0 };
  const scopeKey = 'libra-product-compute-scope';
  store.set('libra:v1:scope-registry:v1', JSON.stringify({
    [`${character.id}::${chat.id}`]: { scopeKey, characterId: character.id, chatId: chat.id, source: 'test_fixture' }
  }));
  store.set('__memory_suite_internal_scope_routes_v1__:libra', JSON.stringify({
    schema: 'memory-suite.scope-routing.v1',
    version: 1,
    legacyGlobalModeImported: true,
    updatedAt: Date.now(),
    entries: {
      [scopeKey]: { scopeId: scopeKey, scopeKey, characterId: character.id, chatId: chat.id, mode: 'mirror', updatedAt: Date.now(), source: 'test_fixture' }
    }
  }));
  const routes = [];
  let failExecute = false;
  let unload = null;
  const host = {
    pluginStorage,
    safeLocalStorage: pluginStorage,
    async getLocalPluginStorage() { return pluginStorage; },
    async getArgument(name) {
      const key = String(name);
      if (key === 'memory_suite_server_url') return baseUrl;
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key.includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await this.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch(url, init = {}) {
      const pathname = new URL(String(url)).pathname;
      routes.push(pathname);
      if (failExecute && pathname === '/v1/compute/execute') throw new Error('test_compute_unavailable');
      return await fetch(url, init);
    },
    async getCharacter() { return character; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
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
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    fetch,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    atob: globalThis.atob,
    btoa: globalThis.btoa
  });
  const rows = [
    { id: 'memory-a:r1', memory: { retrieval: { sparseFields: { summary: '아카데미 금지 규칙', recall_keys: 'academy forbidden law', characters_relations: '', narrative_open_threads: '도서관 조사', chronology: '첫째 날', world_scene: '왕립 아카데미', facts_uncertainty: '', full_text: 'Magic is forbidden.' } } } },
    { id: 'memory-b:r1', memory: { retrieval: { sparseFields: { summary: '아침 식사', recall_keys: 'tea bread', characters_relations: '', narrative_open_threads: '', chronology: '둘째 날', world_scene: '정원', facts_uncertainty: '', full_text: 'Quiet breakfast.' } } } }
  ];
  const query = '아카데미 금지 규칙과 도서관 academy forbidden law';
  try {
    vm.runInContext(source, context, { filename: 'LIBRA.js' });
    const api = await waitFor(() => context.__LIBRA__);
    const cold = await api.debugRecallBm25fScoresWithCurrentOwner(rows, query);
    assert.equal(cold.length, 2);
    let status = api.getMemorySuiteComputeStatus();
    assert.equal(status.counters.local, 0, 'current product call adopts the verified server scorer');
    assert.equal(status.counters.server, 1, 'current product call is delegated to the server');
    const warm = await api.debugRecallBm25fScoresWithCurrentOwner(rows, query);
    assert.deepEqual(warm, cold, 'repeated direct candidate preserves exact product scores');
    status = api.getMemorySuiteComputeStatus();
    assert.equal(status.counters.local, 0, 'repeated server call does not rerun the local scorer');
    assert.equal(status.counters.server, 2, 'repeated product call delegates the current request again');
    failExecute = true;
    chat.message[1].data = '수정된 세계선에서는 도서관 문이 사라졌다.';
    chat.messages = chat.message;
    const changed = await api.debugRecallBm25fScoresWithCurrentOwner(rows, query);
    assert.deepEqual(changed, cold, 'branch change preserves deterministic score values');
    status = api.getMemorySuiteComputeStatus();
    assert.equal(status.counters.local, 1, 'server failure after branch digest change falls back locally once');
    assert.ok(routes.includes('/v1/compute/bootstrap'));
    assert.ok(routes.includes('/v1/compute/execute'));
    assert.equal(routes.includes('/v1/compute/jobs'), false, 'foreground LIBRA uses bounded direct execute, not a warm-cache Job');
    assert.equal(routes.includes('/bootstrap'), true, 'mirror mode verifies the shared Storage connection that owns Compute routing');
    if (unload) await unload();
    process.stdout.write('libra_recall_bm25f_product_server_integration_test: PASS\n');
  } finally {
    try { if (unload) await unload(); } catch (_) {}
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`libra_recall_bm25f_product_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
