'use strict';
// G02 — a slow lore snapshot must not silently drop ALL lore for the request.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §20
// ("6.5초 snapshot timeout은 대형 로어 DB에서 위험"). Its required regression:
//
//   libra_lore_slow_snapshot_runtime_test.cjs
//   "DB load를 7~10초로 지연시켜도 전체 lore가 null로 증발하지 않아야 한다."
//
// THE DEFECT: `loadResponseMaterialSource` raced its whole snapshot task against one fixed
// timer that resolved `null`:
//
//     const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), RESPONSE_LORE_TIMEOUT_MS); });
//     const result = await Promise.race([task, timeout]);
//     return result;                     // <- null means "no lore at all this turn"
//
// On a large WingLore / module-lore / WebRisu database — where getCharacter, getDatabase,
// module scan, CBS and candidate normalization can exceed 6.5 s — the WHOLE reference
// hydration was abandoned for that request. The user sees lore work on some turns and vanish
// on others, with no partial result and no diagnostic. The report contrasts this with the
// original GRADIA 0.25.77, which removed time-budget early exit precisely so candidates are
// never left un-evaluated.
//
// THE INVARIANT THIS TEST ASSERTS: when the snapshot is slower than the deadline,
//   * the caller still receives a usable snapshot, NOT a bare null;
//   * the overrun is OBSERVABLE, so the loss is diagnosable rather than silent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const programDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(programDir, 'plugins', 'LIBRA.js'), 'utf8');
const observations = {};

// --- 1. Structure: the deadline may not be able to produce a bare null ------------------
const timeoutConst = source.match(/const RESPONSE_LORE_TIMEOUT_MS = (\d+);/);
assert.ok(timeoutConst, 'the response-lore deadline constant must exist');
observations.deadlineMs = Number(timeoutConst[1]);

const fnStart = source.indexOf('const loadResponseMaterialSource = async');
assert.ok(fnStart > 0, 'loadResponseMaterialSource must exist');
const fnSlice = source.slice(fnStart, fnStart + 8000);

const racesAgainstNullTimer = /setTimeout\(\(\) => resolve\(null\), RESPONSE_LORE_TIMEOUT_MS\)/.test(fnSlice);
observations.racesAgainstNullTimer = racesAgainstNullTimer;
assert.equal(racesAgainstNullTimer, false,
  'the snapshot must not be raced against a timer that resolves null: a slow database would '
  + 'then drop the whole request\'s lore with no partial result and no diagnostic');

// The deadline is kept as a WAIT bound, so the timed-out path must be observable.
assert.match(fnSlice, /slowSnapshot/,
  'the timed-out path must record that the snapshot was slow, so the overrun is diagnosable');

// --- 2. Runtime: a slow snapshot must still yield a usable snapshot ---------------------
const vm = require('node:vm');

const slowMs = Number(process.env.G02_SLOW_MS || 9000);   // the report's 7-10 s window
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
const slowLore = 'WingLore entry: the archive key opens the lower vault. '.repeat(40);
const chat = {
  id: 'g02-chat', chatId: 'g02-chat', name: 'G02 Chat', bindedPersona: '', note: '',
  message: [
    { role: 'user', chatId: 'u1', data: 'WingLore의 archive key가 뭔가요?' },
    { role: 'assistant', chatId: 'a1', data: '기록을 확인해 보겠습니다.' }
  ]
};
chat.messages = chat.message;
const character = {
  id: 'g02-char', chaId: 'g02-char', name: 'G02 Character', chatPage: 0, chats: [chat],
  desc: 'G02 character description'
};

let slowReads = 0;
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
  async nativeFetch() { throw new Error('no server in G02 test'); },
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
  // The slow database: lore-bearing reads exceed the deadline.
  async getDatabase(fields) {
    slowReads += 1;
    await new Promise(resolve => setTimeout(resolve, slowMs));
    const all = {
      personas: [], selectedPersona: '', characters: [character], plugins: [],
      modules: [{ id: 'winglore', name: 'WingLore', enabled: true, lore: [{ key: 'archive key', content: slowLore }] }],
      enabledModules: ['winglore']
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
  async getPluginRoot() { return null; }
};

const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => { let t; t = setTimeout((...i) => { activeTimeouts.delete(t); handler(...i); }, delay, ...args); activeTimeouts.add(t); return t; };
const trackedClearTimeout = t => { activeTimeouts.delete(t); clearTimeout(t); };
const trackedSetInterval = (handler, delay, ...args) => { const t = setInterval(handler, delay, ...args); activeIntervals.add(t); return t; };
const trackedClearInterval = t => { activeIntervals.delete(t); clearInterval(t); };

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
  setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
});

// Expose the real core through the plugin's own debug surface (the technique the existing
// consumer fixture uses), so this drives PRODUCTION code rather than a re-implementation.
const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
assert.equal(source.split(anchor).length, 2, 'the debug surface anchor must appear once');
const instrumented = source.replace(anchor, `      g02Internals: { loadResponseMaterialSource, loadMemorySettings, Runtime },\n${anchor}`)
  .replace('    async getUnifiedStorageStatus() {',
    '    g02Internals(){ return LibraMemoryCore.g02Internals; },\n    async getUnifiedStorageStatus() {');

vm.runInContext(instrumented, context, { filename: 'LIBRA.js' });

const waitFor = async (predicate, label, timeoutMs = 25000) => {
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
  const internalsAccessor = await waitFor(() => api?.g02Internals, 'G02 internals accessor');
  const internals = internalsAccessor();
  assert.ok(internals && typeof internals === 'object', 'the internals object must be reachable');
  assert.equal(typeof internals.loadResponseMaterialSource, 'function',
    'loadResponseMaterialSource must be reachable through the internals surface');
  const settings = await internals.loadMemorySettings();
  const slowSettings = {
    ...settings,
    activeStageName: 'planner',
    enableShadowRisuContext: true,
    activeStageOptions: {
      ...(settings?.activeStageOptions || {}),
      risuRefs: { authorNote: false, persona: false, characterDescription: true, characterLorebook: true, moduleLorebook: true }
    }
  };

  const startedAt = Date.now();
  const result = await internals.loadResponseMaterialSource({
    messages: chat.message,
    queryBundle: { currentText: 'WingLore의 archive key가 뭔가요?' },
    settings: slowSettings
  });
  const elapsedMs = Date.now() - startedAt;

  observations.elapsedMs = elapsedMs;
  observations.slowReads = slowReads;
  observations.resultIsNullish = result === null || result === undefined;
  observations.candidateCount = Array.isArray(result?.candidates) ? result.candidates.length : null;
  observations.activeLoreCount = Array.isArray(result?.activeLore) ? result.activeLore.length : null;
  observations.slowSnapshotFlag = internals.Runtime?.lastResponseMaterialSource?.slowSnapshot === true;

  console.log(JSON.stringify({ test: 'libra_gradia_slow_lore_snapshot', observations }, null, 1));

  // The report's assertion: a slow database must not evaporate the whole lore snapshot.
  assert.notEqual(result, null,
    `a snapshot slower than the ${observations.deadlineMs} ms deadline must not return null — `
    + `the whole request's lore would silently vanish (elapsed ${elapsedMs} ms)`);
  assert.ok(result && typeof result === 'object',
    'a slow snapshot must still resolve to a snapshot object');
  assert.ok(Array.isArray(result.candidates) || Array.isArray(result.activeLore),
    'the snapshot must carry candidate/active lore fields');
  // The overrun is diagnosable rather than silent.
  assert.equal(observations.slowSnapshotFlag, true,
    'the slow-snapshot overrun must be recorded so it can be diagnosed');

  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stdout.write('libra_lore_slow_snapshot_runtime_test: PASS\n');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
