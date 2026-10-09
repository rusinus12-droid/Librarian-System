'use strict';
// G01 (runtime half) — the unified engine must keep a lore whose ONLY evidence is its
// activation key.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §27:
//
//   libra_gradia_unified_lore_activation_test.cjs
//   "한 lore가: host-selected 아님 / activation key 일치 / semantic 중간 점수
//    일 때도 보호/선택되는지 확인."
//
// That is the precise behaviour the mode branches lost. Under the retired default
// (`risu_selected`) the activation-key producer was never called at all, so such a lore could
// only compete semantically and was dropped. Under the unified engine all three producers run
// on every turn and their outputs are combined, so the key-matched lore survives.
//
// This drives the REAL producers through the plugin's own debug surface and asserts the
// combining behaviour, rather than only inspecting the constants (which the sibling test does).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const programDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(programDir, 'plugins', 'LIBRA.js'), 'utf8');

// --- 1. Structural: the three producers are called unconditionally, then combined ---------
const activation = source.indexOf('// UNIFIED ACTIVATION:');
assert.ok(activation > 0, 'the unified activation block must exist');
const activationEnd = source.indexOf('if (!inputAssistTerminalPath) {', activation);
assert.ok(activationEnd > activation, 'the unified activation block must be bounded');
const block = source.slice(activation, activationEnd);

const observations = {
  callsKeyProducer: /activeRisuLorebooks\s*\(/.test(block),
  callsHostProducer: /reuseRisuSelectedLorebooks\s*\(/.test(block),
  callsSemanticProducer: /renderIndependentActiveLorebooks\s*\(/.test(block),
  hasCombineLoop: /for \(const lore of \[\.\.\.hostLoreSelection\.activeLore, \.\.\.independentRendering\.activeLore\]\)/.test(block),
  branchesOnMode: /loreActivationMode\s*===\s*'/.test(block)
};

// Every producer must run on every turn: that is what makes them independent evidence.
assert.equal(observations.callsHostProducer, true, 'the host-selected producer must always run');
assert.equal(observations.callsKeyProducer, true, 'the activation-key producer must always run');
assert.equal(observations.callsSemanticProducer, true, 'the semantic producer must always run');
assert.equal(observations.hasCombineLoop, true, 'the three signals must be combined, not chosen between');

// A mode ternary here is exactly the regression: it would discard one producer's output.
assert.equal(observations.branchesOnMode, false,
  'the activation site must not branch on a mode: choosing one signal is the regression the '
  + 'original removed, and it is what loses a key-matched but not-host-selected lore');

// --- 2. Runtime: run the real producers and combine them the way the engine does ----------
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

// KEY_MATCHED lore: its activation key appears in the recent context, but RisuAI did NOT inject
// it and its semantic relevance is only middling. Under the old default this lore was lost.
const KEY_MATCHED = {
  id: 'lore-key-matched',
  label: 'KEY_MATCHED_LORE',
  keys: ['열쇠'],
  content: 'KEY_MATCHED_LORE: 열쇠의 규칙은 서재 관리자만 연다.',
  sourceType: 'character',
  priority: 100
};
const HOST_SELECTED = {
  id: 'lore-host-selected',
  label: 'HOST_SELECTED_LORE',
  keys: ['문'],
  content: 'HOST_SELECTED_LORE: 리수AI가 직접 넣은 기록.',
  sourceType: 'character',
  priority: 100
};

const chat = {
  id: 'g01-rt-chat', chatId: 'g01-rt-chat', name: 'G01 Runtime Chat', bindedPersona: '', note: '',
  message: [
    { role: 'user', chatId: 'u1', data: '열쇠에 대해 알려줘.' },
    { role: 'assistant', chatId: 'a1', data: '서재 열쇠 이야기를 해 보겠습니다.' }
  ]
};
chat.messages = chat.message;
const character = {
  id: 'g01-rt-char', chaId: 'g01-rt-char', name: 'G01 Runtime Character', chatPage: 0, chats: [chat],
  desc: 'G01 runtime character description'
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
  async nativeFetch() { throw new Error('no server in G01 runtime test'); },
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
    const all = {
      personas: [], selectedPersona: '', characters: [character], plugins: [],
      modules: [], enabledModules: []
    };
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
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() {
    // Both lore entries live in the character's lorebook; only HOST_SELECTED is injected by
    // the "host" into the request.
    return {
      lorebooks: [{
        id: 'char-lore', name: 'Character Lore', entries: [KEY_MATCHED, HOST_SELECTED]
      }]
    };
  }
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

// Expose the three real producers plus the combiner through the plugin's debug surface.
const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
assert.equal(source.split(anchor).length, 2, 'the debug surface anchor must appear once');
const instrumented = source
  .replace(anchor, `      g01Internals: { activeRisuLorebooks, reuseRisuSelectedLorebooks, renderIndependentActiveLorebooks, loadRisuContextSnapshot, loadMemorySettings },\n${anchor}`)
  .replace('    async getUnifiedStorageStatus() {',
    '    g01Internals(){ return LibraMemoryCore.g01Internals; },\n    async getUnifiedStorageStatus() {');

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
  const internalsAccessor = await waitFor(() => api?.g01Internals, 'G01 internals accessor');
  const internals = internalsAccessor();
  for (const name of ['activeRisuLorebooks', 'reuseRisuSelectedLorebooks', 'renderIndependentActiveLorebooks']) {
    assert.equal(typeof internals[name], 'function', `${name} must be reachable`);
  }

  // --- host-selected producer: the host injected only HOST_SELECTED ---------------------
  const requestMessages = [
    { role: 'system', content: `[활성 로어북]\n${HOST_SELECTED.content}` },
    { role: 'user', content: '열쇠에 대해 알려줘.' },
    { role: 'assistant', content: '서재 열쇠 이야기를 해 보겠습니다.' }
  ];
  const candidates = [KEY_MATCHED, HOST_SELECTED];
  const hostResult = internals.reuseRisuSelectedLorebooks(requestMessages, candidates, null);

  // --- key/semantic producer: the activation key '열쇠' is in the recent context ---------
  const recent = {
    latestUser: '열쇠에 대해 알려줘.',
    text: '열쇠에 대해 알려줘.\n서재 열쇠 이야기를 해 보겠습니다.',
    visibleText: '열쇠에 대해 알려줘.\n서재 열쇠 이야기를 해 보겠습니다.',
    completeTurnsText: '',
    turns: [],
    messages: requestMessages
  };
  const activatedRaw = internals.activeRisuLorebooks(recent, candidates, {
    loreBookDepth: 10, loreBookToken: 2000, loreFullWordMatching: false,
    loreRecursiveScanning: true, loreContinuityTurns: 0, loreContinuityActiveIds: [],
    loreChatVars: {}, loreGreetingIndex: -1
  });
  const independent = internals.renderIndependentActiveLorebooks(activatedRaw, requestMessages, null);

  const labelOf = lore => String(lore?.label ?? lore?.name ?? lore?.id ?? '');
  const hostLabels = (hostResult.activeLore || []).map(labelOf);
  const independentLabels = (independent.activeLore || []).map(labelOf);

  observations.hostSelected = hostLabels;
  observations.independent = independentLabels;

  // --- The engine's own combining rule ---------------------------------------------------
  const identity = lore => String(lore?.id ?? lore?.loreId ?? lore?.key ?? lore?.label ?? lore?.name ?? '').trim().toLowerCase();
  const seen = new Set();
  const combined = [];
  for (const lore of [...(hostResult.activeLore || []), ...(independent.activeLore || [])]) {
    if (!lore) continue;
    const id = identity(lore);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    combined.push(lore);
  }
  const combinedLabels = combined.map(labelOf);
  observations.combined = combinedLabels;

  console.log(JSON.stringify({ test: 'libra_gradia_unified_lore_activation_runtime', observations }, null, 1));

  // 1. The host-selected lore is present (the host injected it).
  assert.ok(combinedLabels.includes(HOST_SELECTED.label),
    `the host-selected lore must survive into the combined set (got ${JSON.stringify(combinedLabels)})`);

  // 2. THE REPORT'S CASE: a lore that is NOT host-selected but whose activation key matches
  //    must also survive. Under the retired single-signal default it did not.
  assert.ok(combinedLabels.includes(KEY_MATCHED.label),
    `a lore reached by its activation key (not host-selected) must be protected by the unified `
    + `engine; host=${JSON.stringify(hostLabels)} independent=${JSON.stringify(independentLabels)}`);

  // 3. No duplicates: a lore reached by both routes appears once.
  assert.equal(new Set(combinedLabels).size, combinedLabels.length,
    `the combined set must not duplicate a lore reached by more than one signal `
    + `(got ${JSON.stringify(combinedLabels)})`);

  process.stdout.write('libra_lore_unified_activation_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
