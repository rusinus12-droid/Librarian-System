'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist', 'LIBRA World Manager Full.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const checks = [];
const check = (name, ok, detail = null) => {
  checks.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

(async () => {
  const chatA = {
    id: 'chat-A', localLore: [], isStreaming: false,
    message: [{ role: 'user', data: 'A의 장면을 계속해.', chatId: 'a-user-1', time: Date.now() - 1000 }]
  };
  const chatB = {
    id: 'chat-B', localLore: [], isStreaming: false,
    message: [{ role: 'user', data: 'B의 장면', chatId: 'b-user-1', time: Date.now() - 1000 }]
  };
  const character = { id: 'char-1', chaId: 'char-1', name: 'Cross Chat', chatPage: 0, chats: [chatA, chatB], globalLore: [] };
  let activeChatIndex = 0;
  const storage = new Map();
  const replacers = new Map();
  const scripts = new Map();
  const chatWrites = [];
  let hangProviderFetch = false;
  let hangingProviderFetchCalls = 0;
  const args = new Map(Object.entries({
    debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off',
    after_request_maintenance_mode: 'background', internal_data_language_mode: 'follow_main_response'
  }));
  const risuai = {
    apiVersion: '3.0-test',
    async getRuntimeInfo(){ return { apiVersion: '3.0-test', platform: 'node-test' }; },
    async getArgument(name){ return args.get(name); },
    async requestPluginPermission(){ return true; },
    async getCharacter(){ const next = clone(character); next.chatPage = activeChatIndex; return next; },
    async getCurrentCharacterIndex(){ return 0; },
    async getCurrentChatIndex(){ return activeChatIndex; },
    async getCharacterFromIndex(index){ return index === 0 ? clone(character) : null; },
    async getChatFromIndex(charIndex, chatIndex){ return charIndex === 0 ? clone(character.chats[chatIndex] || null) : null; },
    async setChatToIndex(charIndex, chatIndex, next){
      chatWrites.push({ charIndex, chatIndex, chatId: next && next.id });
      if (charIndex !== 0 || !character.chats[chatIndex]) return false;
      character.chats[chatIndex] = clone(next);
      return true;
    },
    async setCharacterToIndex(index, next){ if(index !== 0) return false; Object.assign(character, clone(next)); return true; },
    async setCharacter(next){ Object.assign(character, clone(next)); return true; },
    async addRisuReplacer(type, handler){ replacers.set(type, handler); return true; },
    async removeRisuReplacer(type){ replacers.delete(type); return true; },
    async addRisuScriptHandler(type, handler){ scripts.set(type, handler); return true; },
    async removeRisuScriptHandler(type){ scripts.delete(type); return true; },
    async registerBodyIntercepter(){ return 'cross-chat-test'; },
    async unregisterBodyIntercepter(){ return true; },
    async onUnload(){ return true; },
    async registerSetting(){ return true; }, async registerButton(){ return true; },
    async showContainer(){ return true; }, async hideContainer(){ return true; },
    async getDatabase(){ return { personas: [], selectedPersona: null }; },
    pluginStorage: {
      async getItem(key){ return storage.get(key) ?? null; },
      async setItem(key, value){ storage.set(key, String(value)); return true; },
      async removeItem(key){ storage.delete(key); return true; },
      async keys(){ return [...storage.keys()]; }
    },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } }; },
    async nativeFetch(){
      if (hangProviderFetch) { hangingProviderFetchCalls += 1; return await new Promise(() => {}); }
      throw new Error('network must not run in response hooks');
    }
  };

  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async () => { throw new Error('network must not run'); },
    risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  let pluginCode = fs.readFileSync(dist, 'utf8');
  const closeIndex = pluginCode.lastIndexOf('\n})();');
  if (closeIndex < 0) throw new Error('plugin IIFE close not found');
  pluginCode = pluginCode.slice(0, closeIndex)
    + '\n;globalThis.__LIBRA_CROSS_CHAT_TEST__={LLMProvider,MemoryEngine};\n'
    + pluginCode.slice(closeIndex);
  const result = vm.runInContext(pluginCode, context, { filename: dist, timeout: 20000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(resolve => setTimeout(resolve, 80));

  const before = replacers.get('beforeRequest');
  const after = replacers.get('afterRequest');
  check('hooks_registered', typeof before === 'function' && typeof after === 'function');

  const prefill = { role: 'assistant', content: '### Response\n' };
  const hostMessages = [
    { role: 'system', content: '한국어로 5문단을 작성하라.' },
    { role: 'user', content: 'A의 장면을 계속해.' },
    prefill
  ];
  const beforeResult = await before(hostMessages, 'model');
  check('terminal_prefill_remains_last', beforeResult[beforeResult.length - 1] === prefill
    && beforeResult[beforeResult.length - 1].content === '### Response\n', { roles: beforeResult.map(item => item.role) });

  activeChatIndex = 1;
  const bBefore = clone(character.chats[1]);
  const started = performance.now();
  const response = 'A의 응답은 그대로 표시된다.';
  const afterResult = await after(response, 'model');
  const elapsed = performance.now() - started;
  check('after_request_returns_identity_immediately', afterResult === response && elapsed < 100, { elapsed, afterResult });
  await new Promise(resolve => setTimeout(resolve, 300));

  const receipts = require('./libra_generation_capture_receipt_fixture.cjs').readLedgerReceipts(storage);
  check('response_wal_written_for_original_chat', receipts.length === 1
    && receipts[0].chatId === 'chat-A'
    && receipts[0].assistantText === response
    && receipts[0].analysisStatus === 'deferred', receipts);
  check('switched_chat_is_untouched', JSON.stringify(character.chats[1]) === JSON.stringify(bBefore), { writes: chatWrites });
  check('no_cross_chat_write', !chatWrites.some(write => write.chatId === 'chat-B' || write.chatIndex === 1), chatWrites);

  const outputHandler = scripts.get('output');
  const outputStarted = performance.now();
  const outputValue = outputHandler ? await outputHandler('stream chunk') : '';
  check('stream_output_is_identity_and_fast', outputValue === 'stream chunk' && performance.now() - outputStarted < 100);

  // A provider that never resolves must still release the analysis caller at
  // the absolute shared deadline; it cannot hold the post-response worker for
  // the provider's own 120-second timeout.
  const exported = context.__LIBRA_CROSS_CHAT_TEST__;
  const deadlineConfig = clone(exported.MemoryEngine.CONFIG || {});
  deadlineConfig.useLLM = true;
  deadlineConfig.llm = {
    ...(deadlineConfig.llm || {}), provider: 'openai', url: 'https://hang.invalid/v1',
    key: 'test-key', model: 'test-model', timeout: 120000, stream: false
  };
  deadlineConfig.llmPresets = { deadline_fixture: { ...deadlineConfig.llm, enabled: true } };
  deadlineConfig.llmDefaultPreset = 'deadline_fixture';
  check('deadline_fixture_selected_common_preset_is_configured', exported.LLMProvider.isConfigured(deadlineConfig));
  const deadlineAt = Date.now() + 2200;
  deadlineConfig.__analysisDeadlineAt = deadlineAt;
  hangProviderFetch = true;
  const deadlineStarted = performance.now();
  let deadlineError = null;
  try {
    await exported.LLMProvider.call(deadlineConfig, 'Return JSON.', '{}', {
      deadlineAt, domain: 'turn_maintenance', label: 'hanging-provider-test'
    });
  } catch (error) {
    deadlineError = error;
  }
  hangProviderFetch = false;
  const deadlineElapsed = performance.now() - deadlineStarted;
  check('hanging_provider_obeys_absolute_deadline', !!deadlineError
    && /ANALYSIS_DEADLINE|analysis deadline/i.test(String(deadlineError.code || deadlineError.message || deadlineError))
    && hangingProviderFetchCalls > 0
    && deadlineElapsed < 2700,
    { elapsed: deadlineElapsed, fetchCalls: hangingProviderFetchCalls, code: deadlineError && deadlineError.code, message: deadlineError && deadlineError.message });

  const report = { ok: true, checks, receipt: receipts[0], chatWrites, checkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-output', 'cross-chat-wal-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  const report = { ok: false, checks, error: String(error && error.stack || error), checkedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-output', 'cross-chat-wal-test.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
