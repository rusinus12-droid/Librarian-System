'use strict';
const { releaseVersion, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(source, /const LIVE_TAIL_SOURCE_MODE = 'sanitized_completed_ua'/);
assert.match(source, /const liveTailBindingForManifest =/);
assert.match(source, /const pruneExpiredPendingBoundaryStore =/);
assert.match(source, /const liveTailRouteEnabled = \(\) => false;/, 'raw dialogue Live Tail injection is permanently retired');
const beforeRequestSource = source.slice(source.indexOf('const beforeRequest = async (messages, type) =>'), source.indexOf('const afterRequest = async (response, type) =>'));
assert.ok(beforeRequestSource.indexOf('liveTailAttempt = receiptView.liveTail') < beforeRequestSource.indexOf('let result = await recall('), 'Live Tail diagnostics are built before retrieval can fail');
assert.match(beforeRequestSource, /const preservedLiveTail = liveTailDiagnosticSnapshot\(/);
assert.match(beforeRequestSource, /liveTail: preservedLiveTail/);
assert.doesNotMatch(beforeRequestSource, /queryBundle\.liveTail\s*=/, 'Live Tail must not become a second recall-query source');

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA Live Tail runtime.');
};

const values = new Map();
let unload = null;
const storage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
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

const makeChat = (turns, options = {}) => {
  const message = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const user = turn === Number(options.carrierTurn || 0)
      ? `[LBDATA START]private carrier ${turn}[LBDATA END]\nVisible user ${turn}`
      : `Visible user ${turn}`;
    const assistant = turn === Number(options.oversizedTurn || 0)
      ? `Visible assistant ${turn} ${'x'.repeat(9000)}`
      : `Visible assistant ${turn}`;
    message.push({ role: 'user', data: user, chatId: `u-${turn}` });
    message.push({ role: 'assistant', data: assistant, chatId: `a-${turn}` });
  }
  return { id: options.id || `chat-${turns}`, message, messages: message };
};

const baseManifest = (observedTurn, refs = [], guardSuffix = '') => ({
  schema: 'libra.manifest.v1',
  scopeKey: 'character-a::chat-a',
  characterId: 'character-a',
  chatId: 'chat-a',
  frontiers: { observedTurn },
  branchGuard: {
    schema: 'libra.branch_guard.v1',
    status: 'ready',
    batchSignatures: [`guard-${guardSuffix}`],
    verifiedStarts: [],
    observedTurns: observedTurn,
    completeBatches: Math.floor(observedTurn / 5)
  },
  memories: Object.fromEntries(refs.map(start => [String(start), {
    status: 'committed',
    key: `memory-${start}`,
    memoryId: `memory-${start}`,
    revision: 1,
    sessionEpoch: 0,
    inheritedSessionHistory: false,
    logicalWorldlineId: 'branch-a',
    worldlineId: 'branch-a',
    turnRange: { start, end: start + 4 },
    sourceDigest: `digest-${start}`
  }]))
});

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA.js' });
  const api = await waitFor(() => context.__LIBRA__?.version === releaseVersion('libra') && typeof context.__LIBRA__?.debugBuildLiveTailContext === 'function' ? context.__LIBRA__ : null);
  assert.equal(api.version, releaseVersion('libra'));

  const settings = { classicLiveTailEnabled: true, liveContextEnabled: true, liveTailMaxTurns: 4, liveTailMaxChars: 24000 };
  const binding = { scopeKey: 'character-a::chat-a', characterId: 'character-a', chatId: 'chat-a', worldlineId: 'branch-a' };

  const firstPairs = api.debugBuildPairs(makeChat(4, { carrierTurn: 4, id: 'first-window' }), 'first-window');
  assert.equal(firstPairs.length, 4);
  for (const route of ['planner', 'sga', 'classic']) {
    assert.equal(api.debugBuildLiveTailContext(firstPairs, baseManifest(4), settings, route, binding), null,
      `compatibility entry points cannot reactivate retired raw-dialogue injection (${route})`);
  }

  assert.equal(api.debugLiveTailDiagnosticSnapshot(null), null);
  const diagnostic = api.debugLiveTailDiagnosticSnapshot({
    schema: 'libra.live_tail.v1',
    available: true,
    sourceMode: 'sanitized_completed_ua',
    selectionMode: 'recent_completed_dialogue',
    transcript: 'Visible user 4',
    sourcePairs: [{ turn: 4 }],
    binding: { worldlineId: 'branch-a', bindingDigest: 'digest-a' }
  });
  assert.equal(diagnostic.available, true);
  assert.equal(Object.hasOwn(diagnostic, 'transcript'), false);
  assert.equal(Object.hasOwn(diagnostic, 'sourcePairs'), false);
  assert.equal(diagnostic.binding.bindingDigest, 'digest-a');

  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f = await fixture({ args: { live_context_enabled: 'true', classic_live_tail_enabled: 'true' } });
  try {
    assert.equal((await f.run()).completed, 1);
    const calls = f.control.calls.length;
    const query = 'CURRENT_INPUT_ONLY';
    const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: query }], 'model');
    const responseContext = f.r.api.getLastResponseContext();
    const viewer = f.r.api.getLastMemoryRecallViewer();
    assert.equal(responseContext.route, 'classic');
    assert.equal(responseContext.scopeKey, f.getManifest().scopeKey);
    assert.equal(responseContext.values.currentInput, query);
    assert.equal(viewer.responseContextRequestId, responseContext.requestId);
    assert.equal(viewer.responseContextDigest, responseContext.contextDigest);
    const valid = await f.r.api.validateResponseContext(responseContext);
    assert.equal(valid.ok, true, JSON.stringify(valid));
    assert.equal(valid.current, true);
    const block = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
    assert.doesNotMatch(block, /RECENT DIALOGUE/, 'retired Live Tail block is never injected into Classic requests');
    assert.equal(viewer.liveTailInjected, false);
    assert.equal(f.control.calls.length, calls, 'Classic has no response-drafting provider dispatch');
  } finally { await f.r.cleanup(); }

  const now = Date.now();
  const pendingScope = { scopeKey: 'character-a::chat-a', characterId: 'character-a', chatId: 'chat-a' };
  const prune = await api.debugPruneExpiredPendingLiveBoundary({
    context: { scope: pendingScope },
    now,
    store: {
      schema: 'libra.pending_live_boundary_store.v1',
      scopeKey: pendingScope.scopeKey,
      entries: [{
        schema: 'libra.pending_live_boundary.v1', scopeKey: pendingScope.scopeKey,
        characterId: pendingScope.characterId, chatId: pendingScope.chatId,
        startTurn: 1, expectedEndTurn: 5, observedCompletedTurns: 4,
        prefixDigest: 'prefix', currentUserHash: 'input', currentUserChars: 10,
        requestType: 'model', createdAt: now - (8 * 24 * 60 * 60 * 1000), updatedAt: now
      }]
    }
  });
  assert.equal(prune.expiredPruned, 1);
  assert.equal(prune.durable, true);
  assert.equal(prune.store.entries.length, 0);

  if (unload) await unload();
  process.stdout.write('libra_live_tail_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
