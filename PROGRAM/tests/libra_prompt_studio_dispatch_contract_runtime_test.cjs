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

// Prompt Studio text is lower priority than the Librarian output contract. The contract has to be
// in the prompt that is actually sent, not only in a compiled body nobody dispatches: a customized
// profile ends the system prompt with an output-contract reassertion, the default profile does not.
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
  assert.ok(custom.includes('Write every fact as markdown prose in English.'), 'the user text is sent');
  assert.ok(custom.trimEnd().endsWith(custom.slice(custom.indexOf(reassertion)).trimEnd()) && custom.indexOf(reassertion) > custom.indexOf('Write every fact'),
    'a customized profile ends with the reassertion, after the user text');

  await api.debugWritePromptOverrides({ activeMemoryProfile: 'default', memoryProfiles: {} });
  const addendumOnly = await api.debugComposeLibrarianSystemPrompt('Keep relationship labels conservative.');
  assert.ok(addendumOnly.includes(reassertion), 'the analyzer addendum alone also counts as customization');

  // The dispatch builds the same prompt.
  const dispatch = source.slice(source.indexOf('const executeUnifiedStage = async'), source.indexOf('const exactSource=', source.indexOf('const executeUnifiedStage = async')));
  assert.match(dispatch, /const system=\[unifiedPromptContract\(\),.*compiled\.profileBody,analysisNsfw,librarianProfileIsCustomized\(compiled\)\?LIBRARIAN_PROFILE_REASSERTION:''\]/);
  console.log('PASS libra_prompt_studio_dispatch_contract_runtime_test');
  if (unload) await unload();
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
