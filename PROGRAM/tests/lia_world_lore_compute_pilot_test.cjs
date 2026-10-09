'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins', 'LIA_Persona_Linker.js'), 'utf8');
const operation = 'lia.world-lore-rerank.v2';
const fingerprint = 'cbd91cc90d01c8fc052669390badab3d0c2c7a52c4b6c314ac2ca61716fc7a75';

assert.match(source, releasePattern("\\/\\/@version\\s+{lia}\\b", ""));
assert.match(source, /const createMemorySuiteComputeBridge\s*=/, 'embedded Compute factory is available to the owner');
assert.doesNotMatch(source, /\/\/@arg memory_suite_lia_compute_mode\b/);
assert.match(source, /MemorySuiteStorageBridge\.getScopeExecutionPolicy\(/);
assert.match(source, /const LIA_WORLD_LORE_COMPUTE_OPERATION = "lia\.world-lore-rerank\.v2"/);
assert.match(source, new RegExp(fingerprint));
assert.match(source, /MemorySuiteLiaComputeBridge\.execute\(/);
assert.match(source, /const worldLoreRerank = await rerankWorldLoreEntriesWithCompute/);
assert.match(source, /await MemorySuiteLiaComputeBridge\.dispose/);
assert.equal(DEFINITIONS[operation].fingerprint, fingerprint, 'plugin and server algorithm fingerprints match');

const values = new Map();
const pluginStorage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return [...values.keys()]; }
};
const safeLocalStorage = {
  async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; }
};
const chat = { id: 'lia-compute-chat', chatId: 'lia-compute-chat', name: 'Compute', message: [], messages: [], bindedPersona: '' };
const character = { id: 'lia-compute-character', chaId: 'lia-compute-character', name: 'Compute Character', chats: [chat], chatPage: 0, lore: [] };
const unloadHandlers = [];
let computeNetworkCalls = 0;
const api = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
    if (String(name).includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return await api.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch(url) { if (String(url).includes('/v1/compute/')) computeNetworkCalls += 1; throw new Error('offline fixture'); },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    if (!Array.isArray(fields)) return all;
    return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; },
  async getCharacterFromIndex() { return character; },
  async getChat() { return chat; },
  async getCurrentChat() { return chat; },
  async getChatFromIndex() { return chat; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async addEventListener(type, handler) { if (type === 'unload') unloadHandlers.push(handler); return { type, handler }; },
  async requestPluginPermission(permission) { return permission === 'replacer'; },
  async showContainer() { return true; },
  async hideContainer() { return true; }
};

const activeTimeouts = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer = null;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const context = vm.createContext({
  risuai: api,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout,
  clearTimeout: trackedClearTimeout,
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
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  confirm: () => false,
  alert: () => {},
  prompt: () => null
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => JSON.parse(JSON.stringify(value));

async function main() {
  vm.runInContext(source, context, { filename: 'LIA_Persona_Linker.js' });
  for (let attempt = 0; attempt < 40 && !context.__lia_persona_linker_runtime_v1__; attempt += 1) await sleep(25);
  const runtime = context.__lia_persona_linker_runtime_v1__;
  assert.ok(runtime, 'LIA runtime starts');
  const input = {
    version: 'lia_lore_reranker_v2',
    purpose: 'world',
    topK: 3,
    query: 'human only world law academy magic naming culture 세계관 규칙 학교',
    entries: [
      { position: 0, loreId: 'law', key: 'World Rules', secondkey: '', comment: 'Human only canon law', content: 'Magic does not exist and non-humans are forbidden.', mode: 'constant', alwaysActive: true, insertorder: 120, source: 'character_lore', score: 180 },
      { position: 1, loreId: 'academy', key: 'Academy', secondkey: 'school', comment: 'Institution', content: 'The central academy controls naming and class rules.', mode: 'normal', alwaysActive: false, insertorder: 30, source: 'module_lore', score: 80 },
      { position: 2, loreId: 'routine', key: 'Daily routine', secondkey: '', comment: 'Breakfast', content: 'Tea and bread every morning.', mode: 'normal', alwaysActive: false, insertorder: 0, source: 'chat_lore', score: 2 },
      { position: 3, loreId: 'geography', key: 'Geography', secondkey: '', comment: 'World setting', content: 'Northern geography and culture.', mode: 'normal', alwaysActive: false, insertorder: 10, source: 'character_lore', score: 30 }
    ]
  };
  const local = normalize(runtime.debugWorldLoreComputeLocal(input));
  const server = normalize(executeOperation(operation, input));
  assert.deepEqual(server, local, 'LIA local and server kernels have exact candidate, score, reason and ordering parity');
  assert.equal(local.selected[0].loreId, 'law', 'hard canon constraint leads the result');
  assert.equal(local.selected[0].rerankDecision, 'protected');
  assert.equal(local.selected[0].protectionTier, 'hard', 'explicit hard constraint is always retained');
  assert.ok(local.softProtectedCount <= local.softProtectedBudget, 'soft protected lore is budget bounded');
  const softStress = {
    ...input,
    topK: 4,
    entries: [input.entries[0], ...Array.from({ length: 12 }, (_, index) => ({
      position: index + 1,
      loreId: `soft-${index}`,
      key: `Routine ${index}`,
      comment: 'Always reference note',
      content: `Unrelated routine note ${index}`,
      mode: 'constant',
      alwaysActive: true,
      insertorder: 0,
      source: 'module_lore',
      score: 0
    })), input.entries[1]]
  };
  const softStressResult = normalize(runtime.debugWorldLoreComputeLocal(softStress));
  assert.equal(softStressResult.hardProtectedCount, 1, 'hard constraints remain outside the soft budget');
  assert.ok(softStressResult.softProtectedCount <= softStressResult.softProtectedBudget, 'many always-active rows cannot bypass Top-K through protection');
  assert.ok(softStressResult.selected.length <= 1 + softStress.topK, 'hard rows are extra, all other selections stay inside Top-K');
  assert.equal(runtime.debugWorldLoreComputeStatus().mode, 'local');
  assert.equal(computeNetworkCalls, 0, 'LIA local mode never probes Compute');
  const ownerEntries = input.entries.map((entry, index) => ({ ...entry, raw: { owner: `owner-${index}` }, label: `Lore ${index}` }));
  const ownerContext = {
    charIndex: 0,
    chatIndex: 0,
    char: character,
    chat,
    personaInfo: { persona: { name: 'User', personaPrompt: '', note: '' }, source: 'empty' },
    contextOptions: { characterLore: true, chatLore: false, moduleLore: false, richPersonaMode: true, generationMode: 'classic', selectedPersonaKey: 'auto', selectedModuleIds: [] },
    characterDescription: [],
    moduleDescriptions: [],
    loreCandidates: ownerEntries,
    allLoreSignals: ownerEntries,
    maxEntries: 12,
    maxChars: 900
  };
  const ownerResult = normalize(await runtime.debugRerankWorldLoreWithCompute(ownerEntries, ownerContext, 3));
  assert.deepEqual(ownerResult.selected.map(row => row.loreId), local.selected.map(row => row.loreId), 'the product wrapper preserves local selection order');
  assert.equal(ownerResult.selected[0].raw.owner, 'owner-0', 'the owner materializes server-shaped decisions onto its original lore object');
  assert.equal(computeNetworkCalls, 0, 'the product wrapper also stays fully local by default');
  await runtime.dispose();
  for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
  for (const timer of activeTimeouts) clearTimeout(timer);
  activeTimeouts.clear();
  process.stdout.write('lia_world_lore_compute_pilot_test: PASS\n');
}

main().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  activeTimeouts.clear();
  process.stderr.write(`lia_world_lore_compute_pilot_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
