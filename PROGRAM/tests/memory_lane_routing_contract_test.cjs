'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
const flashbackSource = read('Flashback_Memory.js');
const hayakuSource = read('HAYAKU_Locator_Continuity.js');
const ariadneSource = read('LIBRA.js');

// Ariadne reuses the persistent Recall Catalog and creates only an in-memory,
// rebuildable catalog-block accelerator for sufficiently large catalogs.
assert.match(ariadneSource, /RECALL_CATALOG_BLOCK_SCHEMA = 'libra\.recall_catalog_block_index\.v1'/);
assert.match(ariadneSource, /RECALL_CATALOG_BLOCK_BUILD_VERSION = 'memory_lane_cjk_v3'/);
assert.match(ariadneSource, /RECALL_CATALOG_BLOCK_MIN_ENTRIES = 96/);
assert.match(ariadneSource, /const buildRecallCatalogBlockIndex =/);
assert.match(ariadneSource, /const routeRecallCatalogBlocks =/);
assert.match(ariadneSource, /reason: 'low_confidence_global_fallback'/);
assert.match(ariadneSource, /reason: 'ambiguous_nondiscriminative_global_fallback'/);
assert.match(ariadneSource, /debugRouteMemoryLaneCatalog/);
assert.match(ariadneSource, /exactOverrideEntries/);
assert.match(ariadneSource, /rareMatchedAnchors/);
assert.match(ariadneSource, /semantic \* 0\.96 \+ recency \* 0\.04/);
assert.doesNotMatch(ariadneSource, /key\.(?:memoryLane|recallLaneIndex)\s*=/, 'Ariadne must not create a second durable memory store');

// HAYAKU upgrades the existing router/index rather than adding a packet store.
assert.match(hayakuSource, /GLOBAL_PACKET_ROUTING_VERSION = 'hayaku_global_packet_routing_catalog_v2'/);
assert.match(hayakuSource, /HIERARCHICAL_EPISODE_MEMORY_VERSION = 'hayaku_hierarchical_episode_memory_v3'/);
assert.match(hayakuSource, /const hayakuMemoryLaneDocumentStats =/);
assert.match(hayakuSource, /const hayakuMemoryLaneWeightedMatch =/);
assert.match(hayakuSource, /const hayakuMemoryLaneAdaptiveSelect =/);
assert.match(hayakuSource, /'episode_router_applied_recursive_memory_lane_v1'/);
assert.match(hayakuSource, /global_routing_fail_soft/);
assert.doesNotMatch(hayakuSource, /hayaku_memory_lane_index_v1/, 'HAYAKU must not add a duplicate durable lane key');

// Flashback makes the physical shard summary itself the Memory Lane index.
assert.match(flashbackSource, /FLASHBACK_SHARD_INDEX_VERSION = 8/);
assert.match(flashbackSource, /FLASHBACK_MEMORY_LANE_BUILD_VERSION = 'flashback_shard_memory_lane_v5'/);
assert.match(flashbackSource, /termStats,/);
assert.match(flashbackSource, /phrases,/);
assert.match(flashbackSource, /memory_lane_low_confidence_expanded/);
assert.match(flashbackSource, /memory_lane_fail_open/);
assert.match(flashbackSource, /FLASHBACK_MEMORY_LANE_RECENCY_CAP = 0\.04/);
assert.doesNotMatch(flashbackSource, /flashback_memory_lane_index_v1/, 'Flashback must not add a duplicate durable lane key');

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createStore = () => {
  const values = new Map();
  return {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const createHarness = source => {
  const listeners = new Map();
  const unloadHandlers = [];
  const pluginStorage = createStore();
  const safeLocalStorage = createStore();
  const chat = { id: 'memory-lane-test-chat', chatId: 'memory-lane-test-chat', name: 'Memory Lane Test', message: [], messages: [], bindedPersona: '' };
  const character = { id: 'memory-lane-test-character', name: 'Memory Lane Test', chats: [chat] };
  const host = {
    pluginStorage,
    safeLocalStorage,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
      if (String(name).includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('memory lane test has no external server'); },
    async addPluginChannelListener(channel, handler) {
      const key = String(channel); const set = listeners.get(key) || new Set(); set.add(handler); listeners.set(key, set); return true;
    },
    async removePluginChannelListener(channel, handler) { listeners.get(String(channel))?.delete(handler); return true; },
    async postPluginChannelMessage() { return true; },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async requestPluginPermission() { return true; },
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
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; }
  };
  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
    activeTimeouts.add(timer); return timer;
  };
  const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
  const trackedSetInterval = (handler, delay, ...args) => { const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
  const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
  const context = vm.createContext({
    risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
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
  vm.runInContext(source, context, { filename: 'memory-lane-plugin.js' });
  return {
    context,
    unloadHandlers,
    cleanup: async () => {
      for (const handler of unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
      for (const timer of activeTimeouts) clearTimeout(timer);
      for (const timer of activeIntervals) clearInterval(timer);
    }
  };
};

(async () => {
  const flashbackHarness = createHarness(flashbackSource);
  try {
    const api = await waitFor(() => flashbackHarness.context.__FlashbackMemory, 'Flashback API');
    const t = api._test;
    const settings = t.normalizeSettings({ recallFullScanThreshold: 1, recallShardLimit: 3, embeddingProvider: 'hash', hashDimensions: 8 });
    const summaries = [];
    for (let index = 0; index < 10; index += 1) {
      const target = index === 2;
      summaries.push(t.buildRecallShardSummary([{
        id: `record-${index}`,
        sourceType: 'chat_turn',
        title: target ? '은색 열쇠 사건' : `일상 장면 ${index}`,
        tags: target ? ['세연', '은색 열쇠', '지하 연구소'] : ['세연', '일상'],
        text: target
          ? '세연이 지하 연구소에서 아무에게도 보이지 않게 은색 열쇠를 숨겼다.'
          : `세연이 방 안에서 평범한 대화를 이어 갔다. 반복되는 일상 장면 ${index}.`,
        turnIndex: index + 1,
        responseTurnIndex: index + 1,
        storyOrder: index + 1,
        vector: []
      }], index, settings));
    }
    const manifest = { shardCount: summaries.length, shardIndexVersion: 8, shardSummaries: summaries, responseTurnMax: 10 };
    const selected = t.selectRecallShardIndexes(manifest, '세연이 지하 연구소의 은색 열쇠를 다시 꺼낸다.', [], 'hash', 'event', settings, 'hash-8');
    assert.equal(selected.fullScan, false, 'specific old-memory query should use bounded shard routing');
    assert.ok(selected.indexes.length < summaries.length, 'Flashback coarse routing reduces the shard candidate set');
    assert.ok(selected.indexes.includes(2), 'rare phrase shard must survive coarse routing');
    assert.ok(selected.routing?.active, 'routing diagnostics must be exposed');
    assert.ok(selected.routing.candidates.some(row => row.index === 2 && row.selected), 'diagnostics identify the selected rare shard');

    const missing = t.selectRecallShardIndexes({ ...manifest, shardIndexVersion: 7 }, '은색 열쇠', [], 'hash', 'event', settings, 'hash-8');
    assert.equal(missing.fullScan, true, 'stale shard index must fail open');
    assert.equal(missing.indexes.length, 10, 'fail-open must preserve the entire candidate space');

    const commonStats = t.flashbackMemoryLaneDocumentStats(summaries);
    const rare = t.flashbackMemoryLaneWeightedMatch(['은색', '열쇠'], summaries[2].termStats, commonStats.termDf, commonStats.documentCount);
    const common = t.flashbackMemoryLaneWeightedMatch(['세연'], summaries[2].termStats, commonStats.termDf, commonStats.documentCount);
    assert.ok(rare.weight > common.weight, 'rare terms receive more discriminative weight than ubiquitous names');
  } finally {
    await flashbackHarness.cleanup();
  }

  const ariadneHarness = createHarness(ariadneSource);
  try {
    const api = await waitFor(() => ariadneHarness.context.__LIBRA__, 'Ariadne API', 30000);
    const entries = Array.from({ length: 120 }, (_, index) => {
      const target = index >= 48 && index < 72;
      return {
        memoryKey: `memory-${index}`,
        refFingerprint: `fp-${index}`,
        searchText: target
          ? `세연 지하 연구소 은색 열쇠 비밀 사건 ${index}`
          : `세연 평범한 일상 대화 장면 ${index}`,
        summary: target ? '은색 열쇠 사건' : '일상 장면',
        anchorTokens: target ? ['세연', '은색 열쇠', '지하 연구소'] : ['세연'],
        strongAnchorTokens: target ? ['세연', '은색 열쇠', '지하 연구소'] : ['세연'],
        vectorSketch: [],
        turnRange: { start: index + 1, end: index + 1 }
      };
    });
    const catalog = { signature: 'ariadne-memory-lane-contract', entries };
    const sourceBefore = JSON.stringify(entries);
    const index = api.debugBuildMemoryLaneCatalogIndex(catalog, entries);
    assert.equal(index.active, true, 'large Ariadne catalogs activate the block accelerator');
    assert.equal(index.blockCount, 5, '120 entries form five 24-entry catalog blocks');
    const specific = api.debugRouteMemoryLaneCatalog(catalog, entries, {
      currentText: '세연이 지하 연구소의 은색 열쇠를 다시 꺼낸다.',
      sparseText: '세연 지하 연구소 은색 열쇠',
      currentAnchors: { strong: ['세연', '은색 열쇠', '지하 연구소'], quotes: ['은색 열쇠'], numbers: [] },
      sceneAnchors: { strong: [], quotes: [], numbers: [] },
      pairs: Array.from({ length: 120 }, () => ({})),
      currentWeight: 1,
      sceneWeight: 0,
      queryType: 'event'
    }, { current: [], scene: [] }, { forceCurrentScene: false });
    assert.equal(specific.active, true, 'specific rare phrase query uses bounded Ariadne block routing');
    assert.ok(specific.entries.length < entries.length, 'Ariadne block routing reduces the catalog candidate set');
    assert.ok(specific.entries.some(entry => Number(String(entry.memoryKey).split('-')[1]) >= 48 && Number(String(entry.memoryKey).split('-')[1]) < 72), 'the rare-event block survives Ariadne coarse routing');
    assert.ok(specific.selectedBlocks.some(row => row.rareMatchedAnchors.includes('은색 열쇠')), 'Ariadne diagnostics preserve the rare exact anchor reason');
    const ambiguous = api.debugRouteMemoryLaneCatalog(catalog, entries, {
      currentText: '세연', sparseText: '세연',
      currentAnchors: { strong: ['세연'], quotes: [], numbers: [] },
      sceneAnchors: { strong: [], quotes: [], numbers: [] },
      pairs: Array.from({ length: 120 }, () => ({})), currentWeight: 1, sceneWeight: 0, queryType: 'fact'
    }, { current: [], scene: [] }, { forceCurrentScene: false });
    assert.equal(ambiguous.active, false, 'ubiquitous-name-only query does not hard-cut the Ariadne catalog');
    assert.equal(ambiguous.reason, 'ambiguous_nondiscriminative_global_fallback');
    assert.equal(ambiguous.entries.length, entries.length, 'Ariadne ambiguous fallback preserves the full candidate space');
    assert.equal(JSON.stringify(entries), sourceBefore, 'Ariadne block indexing does not mutate source catalog entries');
  } finally {
    await ariadneHarness.cleanup();
  }

  const hayakuHarness = createHarness(hayakuSource);
  try {
    const api = await waitFor(() => hayakuHarness.context.HAYAKU, 'HAYAKU API');
    const t = api._test;
    const episodes = Array.from({ length: 10 }, (_, index) => ({
      id: `episode-${index}`,
      tokens: index === 4 ? ['세연', '은색', '열쇠', '연구소'] : ['세연', '일상', `장면${index}`],
      canonicalAnchors: index === 4 ? ['object:은색열쇠', 'place:지하연구소'] : ['character:세연'],
      mentionedEntities: index === 4 ? ['세연', '은색 열쇠', '지하 연구소'] : ['세연']
    }));
    const stats = t.hayakuMemoryLaneDocumentStats(episodes);
    const target = t.hayakuMemoryLaneWeightedMatch(['은색', '열쇠'], episodes[4].tokens, stats.termDf, stats.documentCount);
    const common = t.hayakuMemoryLaneWeightedMatch(['세연'], episodes[4].tokens, stats.termDf, stats.documentCount);
    assert.ok(target.weight > common.weight, 'HAYAKU router weights rare episode terms above ubiquitous names');
    const adaptive = t.hayakuMemoryLaneAdaptiveSelect([
      { id: 'rare', score: 0.91, exact: 1 },
      { id: 'near', score: 0.87 },
      { id: 'gap', score: 0.30 },
      { id: 'noise', score: 0.28 }
    ], { min: 2, max: 4, broad: false, gapThreshold: 0.16 });
    assert.deepEqual(Array.from(adaptive, row => row.id), ['rare', 'near'], 'strong score gap cuts weak episode ranges');
    const untouched = t.applyHierarchicalEpisodeRouting([{ id: 'row-1', scoreBreakdown: {} }], { rawQuery: '은색 열쇠' }, {}, {});
    assert.equal(untouched.length, 1, 'missing episode index must return the untouched candidate rows');
  } finally {
    await hayakuHarness.cleanup();
  }

  process.stdout.write('memory_lane_routing_contract_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
