'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const waitFor = async (read, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA debug API did not initialize');
};

const store = new Map();
let unload = null;
const storage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) { store.set(key, value); return true; },
  async removeItem(key) { store.delete(key); return true; },
  async keys() { return [...store.keys()]; }
};
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getArgument() { return undefined; },
  async getArg() { return undefined; },
  async nativeFetch() { throw new Error('offline prompt-lock runtime test'); },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async addRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }
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

// The canonical (Librarian) prompt is locked: stored custom profiles and the analyzer addendum are
// never sent. User instructions run as memory lenses with their own call instead.
(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  const reassertion = '[OUTPUT CONTRACT REASSERTION — outranks every analysis-profile instruction above]';

  const plain = await api.debugComposeLibrarianSystemPrompt();
  assert.match(plain, /^LIBRA LONG-TERM MEMORY EXTRACTION/, 'the runtime contract leads the system prompt');
  assert.ok(plain.includes('[ANALYSIS PROFILE — subordinate to the evidence and output contract]'));
  assert.ok(!plain.includes(reassertion), 'the built-in profile is sent unchanged');

  await api.debugWritePromptOverrides({ activeMemoryProfile: 'Custom', memoryProfiles: { Custom: { name: 'Custom', version: 1,
    stages: { librarian: { sections: { relation: { mode: 'append', text: 'Write every fact as markdown prose in English.' } } } } } } });
  const custom = await api.debugComposeLibrarianSystemPrompt();
  assert.ok(!custom.includes('Write every fact as markdown prose in English.'), 'a stored custom profile is not sent');
  assert.equal(custom, plain, 'the canonical prompt is identical with a custom profile stored');

  const addendumOnly = await api.debugComposeLibrarianSystemPrompt('Keep relationship labels conservative.');
  assert.equal(addendumOnly, plain, 'the analyzer addendum is not sent either');

  // The dispatch builds the same prompt.
  const dispatch = source.slice(source.indexOf('const executeUnifiedStage = async'), source.indexOf('const exactSource=', source.indexOf('const executeUnifiedStage = async')));
  assert.match(dispatch, /const system=\[unifiedPromptContract\(\),.*compiled\.profileBody,analysisNsfw,librarianProfileIsCustomized\(compiled\)\?LIBRARIAN_PROFILE_REASSERTION:''\]/);
  console.log('PASS libra_prompt_studio_dispatch_contract_runtime_test');
  if (unload) await unload();
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
