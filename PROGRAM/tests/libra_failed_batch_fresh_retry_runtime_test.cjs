'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const targetPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));

const values = new Map();
let runLlmCalls = 0;
let legacyOutputHandler = null;
const storage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};

const chat = { id: 'failed-retry-chat', chatId: 'failed-retry-chat', name: 'Failed Retry', message: [], bindedPersona: '' };
const appendTurn = turn => {
  chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
  chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
};
for (let turn = 1; turn <= 10; turn += 1) appendTurn(turn);
chat.messages = chat.message;
const character = { id: 'failed-retry-character', name: 'Failed Retry', chatPage: 0, chats: [chat] };
const unloadHandlers = [];
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name);
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    if (key.includes('enable_character_ito') || key.includes('enable_world_ito') || key.includes('enable_plot_ito')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async runLLMModel() {
    runLlmCalls += 1;
    const error = new Error('synthetic terminal provider failure');
    error.risuaiRunLlmSubmitted = true;
    throw error;
  },
  async nativeFetch() { throw new Error('runtime test has no server or provider'); },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; }, async unregisterSetting() { return true; },
  async registerButton() { return true; }, async unregisterButton() { return true; },
  async registerUIPart() { return true; }, async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; }, async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return false; }, async removeRisuChatListener() { return true; },
  async addRisuScriptHandler(type, handler) { if (type === 'output') legacyOutputHandler = handler; return true; }, async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; }, async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
  async getChat() { return chat; }, async getCurrentChat() { return chat; }, async getChatFromIndex() { return chat; },
  async showContainer() { return true; }, async hideContainer() { return true; }, async getRootContainer() { return null; }, async getPluginRoot() { return null; }
};

const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => {
  const timer = setInterval(handler, delay, ...args);
  activeIntervals.add(timer);
  return timer;
};
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
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
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timed out');
};
const manifestEntry = () => Array.from(values.entries()).find(([key]) => key.endsWith(':manifest'));
const readManifest = () => JSON.parse(manifestEntry()[1]);
const readRun = runId => {
  const entry = Array.from(values.entries()).find(([key]) => key.endsWith(`:run:${runId}`));
  return entry ? JSON.parse(entry[1]) : null;
};
const readWork = startTurn => {
  const entry = Array.from(values.entries()).find(([key]) => key.endsWith(`:work:${startTurn}`));
  return entry ? JSON.parse(entry[1]) : null;
};

(async () => {
  try {
    vm.runInContext(source, context, { filename: 'LIBRA-failed-batch-fresh-retry.js' });
    const api = await waitFor(() => context.__LIBRA__);
    await waitFor(() => legacyOutputHandler);

    const first = await api.startManualCanonicalScan({ startTurns: [1] });
    assert.equal(first.failed, 1);
    assert.equal(runLlmCalls, 1, 'the first terminal provider failure consumes one physical submission');
    let manifest = readManifest();
    assert.equal(manifest.inFlight, null, 'a terminal failure is not crash-resumable in-flight work');
    assert.ok(manifest.failedBatches['1'], 'the failed source identity has a dedicated durable marker');
    const firstRunId = manifest.failedBatches['1'].runId;
    const firstOperationId = manifest.failedBatches['1'].providerOperationId;
    assert.equal(readWork(1).status, 'failed');

    appendTurn(11);
    const beforeNonBoundary = runLlmCalls;
    assert.equal(legacyOutputHandler('unchanged output'), 'unchanged output');
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(runLlmCalls, beforeNonBoundary, 'legacy output at turn 11 does not schedule a Canonical provider call');

    const retried = await api.retryFailedMemoryAnalysis({ startTurns: [1] });
    assert.equal(retried.failed, 1);
    assert.equal(runLlmCalls, beforeNonBoundary + 1, 'explicit retry creates exactly one fresh physical submission');
    manifest = readManifest();
    const secondRunId = manifest.failedBatches['1'].runId;
    const secondOperationId = manifest.failedBatches['1'].providerOperationId;
    assert.notEqual(secondRunId, firstRunId, 'explicit retry creates a new run instead of resuming failed work');
    assert.notEqual(secondOperationId, firstOperationId, 'explicit retry creates a new provider operation budget');
    assert.equal(manifest.inFlight, null);
    assert.equal(readWork(1).runId, secondRunId);
    assert.equal(readRun(secondRunId).retry, undefined, 'new analysis does not inherit a parent operation');
    assert.equal(readRun(firstRunId), null, 'the discarded failed run is physically absent');
    assert.doesNotMatch(readRun(secondRunId).errors.at(-1).message, /budget_already_exhausted/);

    for (let turn = 12; turn <= 15; turn += 1) appendTurn(turn);
    const beforeLaterBoundary = runLlmCalls;
    legacyOutputHandler('turn 15 output');
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(runLlmCalls,beforeLaterBoundary+1,'the new complete range gets one independent analysis; earlier failed work is not retried');
    manifest=readManifest();assert.equal(manifest.failedBatches['1'].runId,secondRunId,'earlier failure identity remains untouched');
    assert.ok(![...values.keys()].some(k=>k.endsWith(':continuity-state')),'State cannot cross the missing earlier ranges');
    const ranges=await api.listCanonicalBatchRanges();assert.ok(ranges.ranges.some(r=>r.startTurn===11),'the new failed range remains available for an explicit fresh analysis');

    console.log('libra_failed_batch_fresh_retry_runtime_test: PASS');
  } finally {
    for (const handler of unloadHandlers.reverse()) await handler();
    for (const timer of activeTimeouts) clearTimeout(timer);
    for (const timer of activeIntervals) clearInterval(timer);
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
