'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const defaultSourcePath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSourcePath;
const source = fs.readFileSync(sourcePath, 'utf8');

const extractConst = name => {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing helper: ${name}`);
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ';' && round === 0 && square === 0 && curly === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated helper: ${name}`);
};

const between = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `invalid source range: ${startMarker}`);
  return source.slice(start, end);
};

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading transformed LIBRA runtime.');
};

const createHarness = async (chat, character) => {
  const values = new Map();
  const storageWrites = [];
  const storageRemovals = [];
  const unloadHandlers = [];
  const storage = {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      storageWrites.push({ key: String(key), value });
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) {
      storageRemovals.push(String(key));
      values.delete(String(key));
      return true;
    },
    async keys() { return [...values.keys()]; }
  };
  const host = {
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getLocalPluginStorage() { return storage; },
    async getArgument(name) {
      const key = String(name);
      if (key === 'enable_gui') return 'false';
      if (key === 'input_writer_enabled') return 'true';
      if (key === 'input_writer_mode') return 'rp';
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      return '';
    },
    async getArg(name) { return await this.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('offline fixture'); },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
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
    async postPluginChannelMessage() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return chat; },
    async getCurrentChat() { return chat; },
    async getChatFromIndex() { return chat; },
    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
    }
  };
  const context = vm.createContext({
    risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, AbortSignal, DOMException, URL, URLSearchParams,
    TextEncoder, TextDecoder, crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone, performance: globalThis.performance,
    Blob: globalThis.Blob, Response: globalThis.Response, Headers: globalThis.Headers,
    atob: globalThis.atob, btoa: globalThis.btoa,
    confirm: () => false, alert: () => {}, prompt: () => null
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const api = await waitFor(() => context.__LIBRA__);
  return {
    api, values, storageWrites, storageRemovals,
    async cleanup() {
      for (const handler of unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
    }
  };
};

const createTextDigest = value => {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= 31;
  hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  // Static ownership contracts: a failed regeneration cannot replace the run or
  // snapshot that owns the still-visible candidates.
  const choicePicker = extractConst('showLibraInputWriterChoicePicker');
  assert.match(choicePicker, /selectedRunId:\s*text\(currentRun\?\.runId/);
  assert.match(choicePicker, /deliverySnapshot:\s*safeClone\(currentRun\?\.deliverySnapshot/);
  const explicitRun = between('const runExplicitLibraInputWriter =', 'const providerChoices =');
  assert.match(explicitRun, /const nextPreflight[\s\S]*const nextRun[\s\S]*if \(\(nextRun\?\.ok === true \|\| nextRun\?\.partial === true\)[\s\S]*preflight = nextPreflight;[\s\S]*run = nextRun;/,
    'regeneration commits ownership only after a complete or explicitly usable partial run; failures keep the current owner');
  assert.match(explicitRun, /const selectedSnapshot = picked\.deliverySnapshot/);
  assert.match(explicitRun, /deliverySnapshot: selectedSnapshot[\s\S]*runId: selectedRunId/);

  // Narrative Direction is read once for generation and passed into the sealed
  // snapshot. Validation omits it and therefore re-reads the current direction.
  const snapshotBuilder = extractConst('buildInputWriterDeliverySnapshot');
  assert.match(snapshotBuilder, /responseState, narrativeDirection/);
  assert.match(snapshotBuilder, /narrativeDirection === undefined[\s\S]*getPlannerNarrativeDirection/);
  const preflightSource = between('const prepareInputWriterEvidence =', 'const plannerEvidenceProfile =');
  assert.match(preflightSource, /const narrativeDirection = await getPlannerNarrativeDirection/);
  assert.match(preflightSource, /buildInputWriterDeliverySnapshot\([\s\S]*responseState,[\s\S]*narrativeDirection/);

  // Request-local recall must carry its non-persistence flag through the catalog
  // layer and guard every legacy-upgrade scheduling/write branch.
  assert.match(preflightSource, /queryBundle\.requestLocalReadOnly = true/);
  assert.match(preflightSource, /queryBundle\.persistRecallCatalog = false/);
  const recallSource = between('const recall = async', 'const buildRecallEvidencePacket =');
  assert.match(recallSource, /persistRecallCatalog[\s\S]*loadOrRefreshRecallCatalog\(context, manifest, guard, \{ persist: persistRecallCatalog \}\)/);
  const catalogSource = between('const loadOrRefreshRecallCatalog =', 'const recallCatalogBlockVectorCentroids =');
  assert.match(catalogSource, /optionsValue = \{\}[\s\S]*const persist =/);
  assert.equal((catalogSource.match(/if \(persist(?: && [^)]+)?\) scheduleRecallCatalogUpgrade/g) || []).length, 3,
    'all three legacy catalog upgrade paths must be persistence-gated');
  assert.match(catalogSource, /if \(catalog\.complete && persist\)[\s\S]*recall_catalog_write/);

  // The coordinator must finish host capability/readback preflight, revalidate
  // authority, and only then physically invoke sendChat.
  const dispatcherSource = extractConst('dispatchLibraInputWriterDelivery');
  const dispatcherContext = vm.createContext({
    Promise, Map, Set, Object, Array, String, Number, Boolean, Date,
    setTimeout, clearTimeout, queueMicrotask,
    text: value => String(value == null ? '' : value),
    compact: (value, max = 2000) => String(value == null ? '' : value).slice(0, max),
    safeClone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
    stableDraftHash: value => crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex'),
    digest: value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'),
    Runtime: { inputWriterDeliveryCycles: new Map() }, warn() {}
  });
  vm.runInContext(`${dispatcherSource}\nthis.dispatch = dispatchLibraInputWriterDelivery;`, dispatcherContext);
  const dispatch = dispatcherContext.dispatch;
  const snapshot = { schema: 'libra.input_writer_delivery_snapshot.v1', authorityDigest: 'authority' };

  {
    const events = [];
    let validationCount = 0;
    let resolveHost;
    const hostPromise = new Promise(resolve => { resolveHost = resolve; });
    const result = await dispatch({ action: 'send', content: 'ordered-send', snapshot, cycleId: 'ordered' }, {
      cycles: new Map(),
      async validateSnapshot() { validationCount += 1; events.push(`validate-${validationCount}`); return { ok: true, current: true, stale: false }; },
      async prepareSend() {
        events.push('prepare');
        return { ok: true, readbackBasis: { scopeKey: 'scope' }, dispatch() { events.push('physical-send'); return hostPromise; } };
      },
      sendChat(body, meta) { return meta.preparation.dispatch(body); },
      async readDeliveryReadback() { return { userMessagePresent: true, assistantCompleted: true }; }
    });
    assert.deepEqual(events, ['validate-1', 'prepare', 'validate-2', 'physical-send']);
    assert.equal(result.pending, true);
    assert.equal(result.accepted, true, 'pending is returned only after the physical sendChat call');
    resolveHost(true);
    await tick();
    await tick();
  }

  {
    let validationCount = 0;
    let physicalCalls = 0;
    const result = await dispatch({ action: 'send', content: 'became-stale', snapshot, cycleId: 'stale-after-preflight' }, {
      cycles: new Map(),
      async validateSnapshot() {
        validationCount += 1;
        return validationCount === 1
          ? { ok: true, current: true, stale: false }
          : { ok: false, current: false, stale: true, reason: 'worldline_changed_during_preflight' };
      },
      async prepareSend() { return { ok: true, readbackBasis: {}, dispatch() { physicalCalls += 1; return true; } }; },
      sendChat(body, meta) { return meta.preparation.dispatch(body); }
    });
    assert.equal(result.stale, true);
    assert.equal(result.accepted, false);
    assert.equal(physicalCalls, 0, 'final validation must block the physical send after a preflight race');
  }

  {
    let physicalCalls = 0;
    const result = await dispatch({ action: 'send', content: 'api-unavailable', snapshot, cycleId: 'unavailable' }, {
      cycles: new Map(),
      async validateSnapshot() { return { ok: true, current: true, stale: false }; },
      async prepareSend() { return { ok: false, unavailable: true, reason: 'send_chat_unavailable' }; },
      sendChat() { physicalCalls += 1; return true; }
    });
    assert.equal(result.accepted, false);
    assert.notEqual(result.pending, true);
    assert.equal(result.unavailable, true);
    assert.equal(physicalCalls, 0);
  }

  {
    const result = await dispatch({ action: 'send', content: 'sync-reject', snapshot, cycleId: 'sync-reject' }, {
      cycles: new Map(),
      async validateSnapshot() { return { ok: true, current: true, stale: false }; },
      async prepareSend() { return { ok: true, readbackBasis: {}, dispatch() { throw new Error('physical-send-rejected'); } }; },
      sendChat(body, meta) { return meta.preparation.dispatch(body); },
      async readDeliveryReadback() { return { userMessagePresent: false, assistantCompleted: false, ambiguous: false }; },
      warn() {}
    });
    assert.equal(result.accepted, false, 'a proven synchronous non-delivery must keep the editor available');
    assert.equal(result.status, 'rejected');
  }

  const deliveryPicker = extractConst('showLibraInputWriterDeliveryPicker');
  assert.match(deliveryPicker, /prepareSend: async value/);
  assert.doesNotMatch(deliveryPicker, /sendChat: async \(value, meta\)/,
    'the GUI must not return pending before host preflight and the physical call');
  assert.doesNotMatch(deliveryPicker, /getRootDocument|setTextContent\s*\(|querySelector\s*\([^)]*(?:textarea|chat-input)/i);

  // A real committed canonical ref forces recall catalog construction. The
  // request-local Input Writer path may populate RAM, but it must write no
  // recall-catalog (or any other durable) record.
  const chat = { id: 'iw-readonly-chat', chatId: 'iw-readonly-chat', message: [], bindedPersona: '' };
  for (let turn = 1; turn <= 5; turn += 1) {
    chat.message.push({ role: 'user', data: `fixture user ${turn}`, chatId: `u-${turn}` });
    chat.message.push({ role: 'assistant', data: `fixture assistant ${turn}`, chatId: `a-${turn}` });
  }
  chat.messages = chat.message;
  const character = { id: 'iw-readonly-character', name: 'Input Writer Readonly', chatPage: 0, chats: [chat] };
  const harness = await createHarness(chat, character);
  try {
    const initial = await harness.api.prepareInputWriterEvidence('fixture event');
    const scope = initial.scope;
    const pairs = harness.api.debugBuildPairs(chat, scope.scopeKey);
    const sourceDigest = createTextDigest(pairs.map(pair => ({
      turn: pair.turn,
      userChatId: pair.user.chatId,
      assistantChatId: pair.assistant.chatId,
      user: pair.user.text,
      assistant: pair.assistant.text
    })));
    const memoryKey = `libra:v1:scope:${scope.scopeKey}:memory:1:r1`;
    const manifestKey = `libra:v1:scope:${scope.scopeKey}:manifest`;
    const ref = {
      key: memoryKey,
      memoryId: 'iw-canonical-0001',
      revision: 1,
      status: 'committed',
      turnRange: { start: 1, end: 5 },
      sourceDigest,
      summary: 'fixture event canonical marker',
      sessionEpoch: 0,
      inheritedSessionHistory: false,
      worldlineId: 'main',
      logicalWorldlineId: 'main',
      embeddingStatus: 'pending'
    };
    harness.values.set(memoryKey, JSON.stringify({
      schema: 'libra.canonical_memory.v1',
      scopeKey: scope.scopeKey,
      characterId: scope.characterId,
      chatId: scope.chatId,
      memoryId: ref.memoryId,
      revision: 1,
      status: 'committed',
      turnRange: ref.turnRange,
      sourceDigest,
      sourcePairs: pairs.map(pair => ({ turn: pair.turn, userChatId: pair.user.chatId, assistantChatId: pair.assistant.chatId })),
      summary: ref.summary,
      text: '[SUMMARY]\nfixture event canonical marker\n\n[CHRONOLOGY]\nThe five fixture turns are established.',
      recallKeys: ['fixture', 'event', 'canonical', 'marker'],
      embedding: { status: 'pending' }
    }));
    harness.values.set(manifestKey, JSON.stringify({
      schema: 'libra.manifest.v1',
      version: '2.3.0',
      scopeKey: scope.scopeKey,
      characterId: scope.characterId,
      chatId: scope.chatId,
      memories: { 1: ref },
      inheritedMemories: [],
      runIds: [],
      inFlight: null,
      frontiers: { observedTurn: 5, committedTurn: 5, contiguousCommittedTurn: 5, firstGapStartTurn: 0, contiguousMemoryCount: 1 },
      branchGuard: {
        schema: 'libra.branch_guard.v1', status: 'ready', batchSignatures: [], verifiedStarts: [],
        observedTurns: 5, completeBatches: 1
      }
    }));
    harness.storageWrites.length = 0;
    harness.storageRemovals.length = 0;

    const preflight = await harness.api.prepareInputWriterEvidence('fixture event canonical marker');
    assert.equal(preflight.branchView.rejected.length, 0, 'the fixture must exercise a verified live canonical ref');
    assert.ok(preflight.branchView.verifiedStarts.includes(1));
    assert.ok(preflight.recallMemoryCount >= 1, 'the fixture must enter recall catalog construction/hydration');
    assert.deepEqual(harness.storageWrites, [],
      'request-local Input Writer recall with a real canonical ref must not persist a recall catalog or any durable key');
    assert.deepEqual(harness.storageRemovals, []);
    assert.equal([...harness.values.keys()].some(key => key.includes(':recall-catalog:')), false);
  } finally {
    await harness.cleanup();
  }

  process.stdout.write(`libra_input_writer_phase06_post_adoption_p1_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
