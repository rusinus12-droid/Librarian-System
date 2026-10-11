'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


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

const turnsOf = tail => Array.from(tail.sourcePairs, row => Number(row.turn));

(async () => {
  const testSource = source;
  vm.runInContext(testSource, context, { filename: 'LIBRA.js' });
  const api = await waitFor(() => context.__LIBRA__?.version === releaseVersion('libra') && typeof context.__LIBRA__?.debugBuildLiveTailContext === 'function' ? context.__LIBRA__ : null);
  assert.equal(api.version, releaseVersion('libra'));

  const settings = { classicLiveTailEnabled:true, liveContextEnabled: true, liveTailMaxTurns: 4, liveTailMaxChars: 24000 };
  const binding = { scopeKey: 'character-a::chat-a', characterId: 'character-a', chatId: 'chat-a', worldlineId: 'branch-a' };

  const firstPairs = api.debugBuildPairs(makeChat(4, { carrierTurn: 4, id: 'first-window' }), 'first-window');
  const first = api.debugBuildLiveTailContext(firstPairs, baseManifest(4), settings, 'planner', binding);
  assert.deepEqual(turnsOf(first), [1, 2, 3, 4]);
  assert.equal(first.sourceMode, 'sanitized_completed_ua');
  assert.equal(first.requestLocalOnly, true);
  assert.equal(first.persisted, false);
  assert.equal(first.internalCarrierRemoved, true);
  assert.doesNotMatch(first.transcript, /private carrier/);
  assert.match(first.transcript, /Visible user 4/);
  assert.match(first.promptBlock, /RECENT DIALOGUE/);
  assert.equal(first.binding.worldlineId, 'branch-a');
  assert.ok(first.binding.branchGuardDigest);
  assert.ok(first.binding.canonicalRefsDigest);
  assert.ok(first.binding.bindingDigest);
  assert.ok(first.sourcePairs[3].user.rawPayloadDigests[0]);
  assert.equal(Object.hasOwn(first.sourcePairs[3].user, 'rawValue'), false, 'provenance must not copy raw content');
  assert.doesNotMatch(JSON.stringify(first.sourcePairs), /private carrier/);

  const boundaryPairs = api.debugBuildPairs(makeChat(5, { id: 'boundary' }), 'boundary');
  const boundary = api.debugBuildLiveTailContext(boundaryPairs, baseManifest(5), settings, 'planner', binding);
  assert.deepEqual(turnsOf(boundary), [2, 3, 4, 5]);
  assert.equal(boundary.pendingBoundaryRescue, false);

  const secondPairs = api.debugBuildPairs(makeChat(9, { id: 'second-window' }), 'second-window');
  const second = api.debugBuildLiveTailContext(secondPairs, baseManifest(9, [1]), settings, 'sga', binding);
  assert.deepEqual(turnsOf(second), [6, 7, 8, 9], 'Live Tail repeats after the first canonical batch');
  assert.equal(second.selectionMode, 'recent_completed_dialogue');

  const thirdPairs = api.debugBuildPairs(makeChat(14, { id: 'third-window' }), 'third-window');
  const third = api.debugBuildLiveTailContext(thirdPairs, baseManifest(14, [1, 6]), settings, 'planner', binding);
  assert.deepEqual(turnsOf(third), [11, 12, 13, 14], 'Live Tail continues on later five-turn cycles');

  const committed = api.debugBuildLiveTailContext(boundaryPairs, baseManifest(5, [1]), settings, 'planner', binding);
  assert.deepEqual(turnsOf(committed), turnsOf(boundary), 'committing a batch must not remove recent dialogue');
  assert.equal(committed.transcript, boundary.transcript);
  assert.equal(committed.promptBlock, boundary.promptBlock, 'storage state must not alter the prompt');

  const gapPairs = api.debugBuildPairs(makeChat(17, { id: 'branch-gap' }), 'branch-gap');
  const gap = api.debugBuildLiveTailContext(gapPairs, baseManifest(17, [1, 11], 'gap'), settings, 'planner', binding);
  assert.deepEqual(turnsOf(gap), [14, 15, 16, 17], 'historical gaps must not displace recent dialogue');
  assert.equal(gap.branchRepairMode, false);
  assert.deepEqual(Array.from(gap.branchRepairTurns), []);
  const noMemory = api.debugBuildLiveTailContext(gapPairs, baseManifest(17), settings, 'planner', binding);
  assert.equal(noMemory.transcript, gap.transcript);
  const twoTurns = api.debugBuildLiveTailContext(gapPairs, baseManifest(17), { ...settings, liveTailMaxTurns: 2 }, 'planner', binding);
  assert.deepEqual(turnsOf(twoTurns), [16, 17], 'preserve configured turn budget');
  const pendingChat = makeChat(4);
  pendingChat.message.push({ role: 'user', data: 'UNANSWERED_INPUT', chatId: 'pending' });
  const pendingPairs = api.debugBuildPairs(pendingChat, 'pending-chat');
  const pending = api.debugBuildLiveTailContext(pendingPairs, baseManifest(4), settings, 'planner', binding);
  assert.doesNotMatch(pending.transcript, /UNANSWERED_INPUT/);

  // Current consumer delivery is proved through the registered hook, rather than
  // the retired Planner/Input Writer/SGA prompt compilers.
  const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
  const f=await fixture({args:{live_context_enabled:'true',classic_live_tail_enabled:'true'}});
  try {
    assert.equal((await f.run()).completed,1);
    const calls=f.control.calls.length;
    const query='CURRENT_INPUT_ONLY';
    const messages=await f.control.hooks.beforeRequest([{role:'user',content:query}],'model');
    const responseContext=f.r.api.getLastResponseContext();
    const viewer=f.r.api.getLastMemoryRecallViewer();
    assert.equal(responseContext.route,'classic');
    assert.equal(responseContext.scopeKey,f.getManifest().scopeKey);
    assert.equal(responseContext.values.currentInput,query);
    assert.equal(viewer.responseContextRequestId,responseContext.requestId);
    assert.equal(viewer.responseContextDigest,responseContext.contextDigest);
    const valid=await f.r.api.validateResponseContext(responseContext);
    assert.equal(valid.ok,true,JSON.stringify(valid));assert.equal(valid.current,true);
    const block=messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');
    const lastAssistant=f.chat.message.at(-1).data;
    assert.ok(block.includes(lastAssistant),'actual returned request includes the most recent completed assistant');
    assert.equal(block.split(lastAssistant).length-1,1,'recent dialogue is not duplicated');
    assert.equal(viewer.liveTailInjected,true);
    assert.equal(f.control.calls.length,calls,'Classic has no response-drafting provider dispatch');
  }finally{await f.r.cleanup();}

  const changedGuard = api.debugBuildLiveTailContext(firstPairs, baseManifest(4, [], 'changed'), settings, 'planner', binding);
  assert.notEqual(changedGuard.binding.bindingDigest, first.binding.bindingDigest);
  assert.notEqual(changedGuard.hash, first.hash, 'branch binding participates in the Live Tail hash');
  const changedWorldline = api.debugBuildLiveTailContext(firstPairs, baseManifest(4), settings, 'planner', { ...binding, worldlineId: 'branch-b' });
  assert.notEqual(changedWorldline.binding.bindingDigest, first.binding.bindingDigest);

  const oversizedPairs = api.debugBuildPairs(makeChat(4, { oversizedTurn: 4, id: 'oversized' }), 'oversized');
  const oversized = api.debugBuildLiveTailContext(oversizedPairs, baseManifest(4), { ...settings, liveTailMaxChars: 4000 }, 'planner', binding);
  assert.equal(oversized.truncated, true);
  assert.deepEqual(turnsOf(oversized), [4]);
  assert.match(oversized.transcript, /LOCAL SAFETY TRUNCATION/);

  assert.equal(api.debugBuildLiveTailContext(firstPairs, baseManifest(4), {...settings,classicLiveTailEnabled:false}, 'classic', binding), null);
  assert.ok(api.debugBuildLiveTailContext(firstPairs, baseManifest(4), { ...settings, classicLiveTailEnabled: true }, 'classic', binding));

  const diagnostic = api.debugLiveTailDiagnosticSnapshot(first);
  assert.equal(diagnostic.available, true);
  assert.equal(Object.hasOwn(diagnostic, 'transcript'), false);
  assert.equal(Object.hasOwn(diagnostic, 'sourcePairs'), false);
  assert.equal(diagnostic.binding.bindingDigest, first.binding.bindingDigest);

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

