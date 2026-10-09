'use strict';
// G01 follow-up — the unified engine must actually USE the semantic (Jaccard) evidence it collects.
//
// The E2E review of the G01 fix found that collapsing the modes to `unified` left the DOWNSTREAM
// branches comparing against the retired literals:
//
//     const retrievedActiveLore = loreActivationMode === 'libra_extended'   // never true now
//       ? activeLore.map(... jaccard retrieval ...)
//       : retrieveActiveLoreRisuStyle(activeLore, fullTextRetrievalEngine);
//
//     engine: loreActivationMode === 'libra_extended' ? LORE_JACCARD_ENGINE_VERSION : fullTextRetrievalEngine
//
// With `normalizeLoreActivationMode` returning 'unified' for every input (including every legacy
// alias), neither 'libra_extended' nor 'risu_selected' can ever be the runtime value - so the
// semantic retrieval map was DEAD CODE and the engine always fell through to the RisuAI-style
// full-text path, reporting engine 'risu_key_full_text_v1'.
//
// That defeats the point of G01: the unified engine exists so that host-selected, activation-key
// AND semantic evidence are all collected AND USED. Collecting semantic evidence and then
// discarding it is the same loss the mode branches caused, one layer down.
//
// CONTRACT: no code path may compare the runtime activation mode against a retired literal; the
// unified engine must reach its semantic retrieval branch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// --- 1. The retired literals must not be compared against the runtime mode ----------------
const retiredComparisons = [];
const comparisonPattern = /loreActivationMode\s*===\s*'(libra_extended|risu_selected|risu_key)'/g;
for (const match of source.matchAll(comparisonPattern)) {
  const line = source.slice(0, match.index).split('\n').length;
  retiredComparisons.push({ line, literal: match[1] });
}

// --- 2. The semantic retrieval branch must be reachable -----------------------------------
// The unified engine uses the Jaccard/entity retrieval for lore it promoted semantically, and
// falls back to the RisuAI-style full-text retrieval for the rest. Model that split by the lore's
// own activation route rather than by the retired mode.
const hasRouteBasedSplit = /activationRoute\s*===\s*'jaccard_current_input'\s*\|\|\s*lore\.activationRoute\s*===\s*'terminal_entity'/.test(source);
const jaccardEngineMentions = (source.match(/LORE_JACCARD_ENGINE_VERSION/g) || []).length;

console.log(JSON.stringify({
  test: 'libra_gradia_unified_semantic_retrieval',
  observations: { retiredComparisons, hasRouteBasedSplit, jaccardEngineMentions }
}, null, 1));

assert.deepEqual(retiredComparisons, [],
  `the runtime activation mode can never equal a retired literal (every value normalizes to `
  + `'unified'), so these comparisons are dead branches that silently discard collected `
  + `evidence: ${JSON.stringify(retiredComparisons)}`);

assert.equal(hasRouteBasedSplit, true,
  'the retrieval split must be decided by the lore\'s own activation route, so semantically '
  + 'promoted lore keeps its Jaccard retrieval while the rest uses the RisuAI-style path');

// --- 3. Runtime: a semantically promoted lore must keep its Jaccard retrieval --------------
const vm = require('node:vm');

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chat = {
  id: 'g01b-chat', chatId: 'g01b-chat', name: 'G01b Chat', bindedPersona: '', note: '',
  message: [
    { role: 'user', chatId: 'u1', data: '열쇠에 대해 알려줘.' },
    { role: 'assistant', chatId: 'a1', data: '서재 열쇠 이야기를 해 보겠습니다.' }
  ]
};
chat.messages = chat.message;
const character = {
  id: 'g01b-char', chaId: 'g01b-char', name: 'G01b Character', chatPage: 0, chats: [chat],
  desc: 'G01b runtime character'
};
const host = {
  pluginStorage, safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('no server'); },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload() { return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async registerUIPart() { return true; },
  async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [], modules: [], enabledModules: [] };
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
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() { return { lorebooks: [] }; }
};

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  AbortController, AbortSignal, DOMException, URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
});

// Expose the real retrieval helpers so the split can be exercised directly.
const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
assert.equal(source.split(anchor).length, 2, 'debug surface anchor must be unique');
const instrumented = source
  .replace(anchor, `      g01bInternals: { retrieveActiveLoreRisuStyle, normalizeLoreActivationMode },\n${anchor}`)
  .replace("    async getUnifiedStorageStatus() {",
    '    g01bInternals(){ return LibraMemoryCore.g01bInternals; },\n    async getUnifiedStorageStatus() {');

vm.runInContext(instrumented, context, { filename: 'LIBRA.js' });

const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

(async () => {
  const api = await waitFor(() => context.__LIBRA__, 'LIBRA API');
  const accessor = await waitFor(() => api?.g01bInternals, 'internals accessor');
  const internals = accessor();

  // The RisuAI-style helper must still be reachable for lore that was NOT semantically promoted.
  assert.equal(typeof internals.retrieveActiveLoreRisuStyle, 'function',
    'the RisuAI-style full-text retrieval must remain available for non-promoted lore');

  // And every legacy value must still normalize onto the unified engine.
  const normalize = internals.normalizeLoreActivationMode;
  for (const legacy of ['risu_selected', 'risu_key', 'libra_extended', 'host_selected', 'extended', '']) {
    assert.equal(normalize(legacy), 'unified', `'${legacy}' must normalize to the unified engine`);
  }

  process.stdout.write('libra_lore_unified_semantic_retrieval_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
