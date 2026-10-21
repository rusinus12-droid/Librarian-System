'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const MIGRATION_KEY = 'libra:v1:migration';
const AGENT_SLOTS_KEY = 'libra:v1:agent-slots';
const RUNTIME_SETTINGS_KEY = 'libra:v1:runtime-settings';
const REFERENCE_BUDGET_KEY = 'libra:v1:reference-budget-migration';
const CORE_ITO_IDS = ['character_ito', 'world_ito', 'plot_ito'];

const waitFor = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while loading LIBRA test runtime.');
};

const completeMarker = overrides => ({
  version: 2,
  ragRouteVersion: 2,
  stageDefaultsVersion: 4,
  easyLengthVersion: 1,
  referenceBudgetVersion: 3,
  migrated: false,
  migratedAt: '2026-08-20T00:00:01.000Z',
  source: 'fresh',
  ...overrides
});

const slotRecord = (enabled = true, savedAt = '2026-08-20T00:00:00.000Z') => ({
  version: 2,
  savedAt,
  slots: Object.fromEntries(['ariadne', ...CORE_ITO_IDS].map(stageId => [stageId, { enabled }]))
});

const runPlugin = async initialObjects => {
  const store = new Map(Object.entries(initialObjects || {}).map(([key, value]) => [key, JSON.stringify(value)]));
  let unload = null;
  const storage = {
    async getItem(key) { return store.has(key) ? store.get(key) : null; },
    async setItem(key, value) { store.set(key, value); },
    async removeItem(key) { store.delete(key); }
  };
  const host = {
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getArgument() { return undefined; },
    async getArg() { return undefined; },
    async nativeFetch() { throw new Error('test host has no Librarian System server'); },
    async onUnload(handler) { unload = handler; return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async addRisuReplacer() { return true; },
    async addRisuChatListener() { return true; },
    async addRisuScriptHandler() { return true; }
  };
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = vm.createContext({
    risuai: host,
    console: quietConsole,
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
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  await api.getLibraProviderConfig();
  const runtime = api.getRuntime();
  const plain = value => JSON.parse(JSON.stringify(value));
  const responseModes = {
    legacyPlanner: plain(api.debugResolveResponseModeState({ injection_mode: 'planner' })),
    legacyClassic: plain(api.debugResolveResponseModeState({ injection_mode: 'classic' })),
    legacySgaNovel: plain(api.debugResolveResponseModeState({ injection_mode: 'sga', input_writer_mode: 'author' })),
    rememberedGradiaRp: plain(api.debugResolveResponseModeState({ response_family: 'gradia', libra_response_mode: 'classic', gradia_writing_mode: 'rp' })),
    rememberedLibraClassic: plain(api.debugResolveResponseModeState({ response_family: 'libra', libra_response_mode: 'classic', gradia_writing_mode: 'author', injection_mode: 'sga' }))
  };
  const readObject = key => store.has(key) ? JSON.parse(store.get(key)) : null;
  if (unload) await unload();
  return { runtime, readObject, responseModes };
};

(async () => {
  const fresh = await runPlugin({});
  assert.equal(fresh.runtime.settings.enableShadowAct, true, 'fresh Ariadne is enabled');
  assert.equal(fresh.runtime.settings.enableCharacterAide, false, 'fresh Character ito is disabled');
  assert.equal(fresh.runtime.settings.enableWorldAide, false, 'fresh World ito is disabled');
  assert.equal(fresh.runtime.settings.enablePlotAide, false, 'fresh Plot ito is disabled');
  for(const [label,mode]of Object.entries(fresh.responseModes)) assert.deepEqual(mode,{responseFamily:'libra',libraResponseMode:'classic',injectionMode:'classic'},label+' cannot activate retired response executors');
  const freshSlots = fresh.readObject(AGENT_SLOTS_KEY).slots;
  assert.equal(freshSlots.ariadne.enabled, true, 'fresh storage persists Ariadne ON');
  for (const stageId of CORE_ITO_IDS) assert.equal(freshSlots[stageId].enabled, false, `fresh storage persists ${stageId} OFF`);

  const legacySga = await runPlugin({
    [MIGRATION_KEY]: completeMarker({}),
    [REFERENCE_BUDGET_KEY]: { version: 3, migratedAt: '2026-08-20T00:00:01.000Z', source: 'test' },
    [AGENT_SLOTS_KEY]: slotRecord(false),
    [RUNTIME_SETTINGS_KEY]: { version: 3, settings: { injection_mode: 'sga', input_writer_mode: 'author' } }
  });
  assert.equal(legacySga.runtime.settings.responseFamily, 'libra', 'stored legacy SGA loads as the GRADIA family');
  assert.equal(legacySga.runtime.settings.gradiaWritingMode, undefined, 'stored legacy author mode loads as GRADIA Novel');
  assert.equal(legacySga.runtime.settings.injectionMode, 'classic', 'stored legacy SGA retains the internal execution route');

  const explicitFamilies = await runPlugin({
    [MIGRATION_KEY]: completeMarker({}),
    [REFERENCE_BUDGET_KEY]: { version: 3, migratedAt: '2026-08-20T00:00:01.000Z', source: 'test' },
    [AGENT_SLOTS_KEY]: slotRecord(false),
    [RUNTIME_SETTINGS_KEY]: { version: 3, settings: { response_family: 'libra', libra_response_mode: 'classic', gradia_writing_mode: 'author', injection_mode: 'sga' } }
  });
  assert.equal(explicitFamilies.runtime.settings.injectionMode, 'classic', 'explicit LIBRA family overrides the compatibility SGA route');
  assert.equal(explicitFamilies.runtime.settings.gradiaWritingMode, undefined, 'inactive GRADIA Novel choice remains loaded');

  const explicitOn = await runPlugin({
    [MIGRATION_KEY]: completeMarker({}),
    [REFERENCE_BUDGET_KEY]: { version: 3, migratedAt: '2026-08-20T00:00:01.000Z', source: 'test' },
    [AGENT_SLOTS_KEY]: slotRecord(true, '2026-08-20T00:10:00.000Z')
  });
  assert.equal(explicitOn.runtime.settings.enableCharacterAide, true, 'current explicit Character ito ON is preserved');
  assert.equal(explicitOn.runtime.settings.enableWorldAide, true, 'current explicit World ito ON is preserved');
  assert.equal(explicitOn.runtime.settings.enablePlotAide, true, 'current explicit Plot ito ON is preserved');

  const affectedV1084 = await runPlugin({
    [MIGRATION_KEY]: completeMarker({ stageDefaultsVersion: 3 }),
    [REFERENCE_BUDGET_KEY]: { version: 3, migratedAt: '2026-08-20T00:00:01.000Z', source: 'test' },
    [AGENT_SLOTS_KEY]: slotRecord(true, '2026-08-20T00:00:00.000Z')
  });
  for (const stageId of CORE_ITO_IDS) assert.equal(affectedV1084.readObject(AGENT_SLOTS_KEY).slots[stageId].enabled, false, `untouched v1.0.94 ${stageId} is repaired OFF`);
  assert.equal(affectedV1084.readObject(MIGRATION_KEY).stageDefaultsVersion, 4, 'affected migration advances to v4');
  assert.equal(affectedV1084.readObject(MIGRATION_KEY).stageDefaultsMigration.applied, true, 'affected migration records applied repair');

  const laterUserSave = await runPlugin({
    [MIGRATION_KEY]: completeMarker({ stageDefaultsVersion: 3 }),
    [REFERENCE_BUDGET_KEY]: { version: 3, migratedAt: '2026-08-20T00:00:01.000Z', source: 'test' },
    [AGENT_SLOTS_KEY]: slotRecord(true, '2026-08-20T00:10:00.000Z')
  });
  for (const stageId of CORE_ITO_IDS) assert.equal(laterUserSave.readObject(AGENT_SLOTS_KEY).slots[stageId].enabled, true, `later user-saved ${stageId} ON is preserved`);
  assert.equal(laterUserSave.readObject(MIGRATION_KEY).stageDefaultsMigration.applied, false, 'later save is not auto-repaired');
  assert.equal(laterUserSave.readObject(MIGRATION_KEY).stageDefaultsMigration.reason, 'agent_slots_saved_after_initialization');

  const sharedRouterStart = source.indexOf('const resolveSharedNavigationTarget =');
  const sharedRouterEnd = source.indexOf('const applySharedNavigationTarget =', sharedRouterStart);
  const sharedRouter = source.slice(sharedRouterStart, sharedRouterEnd);
  assert.match(sharedRouter,/requested\.startsWith\('agent_'\)/);
  assert.match(sharedRouter,/memoryPipelineStage:LIBRA_MEMORY_PIPELINE_STAGES\.includes\(stage\)\?stage:LIBRARIAN_STAGE_ID/,'retired stage links redirect to Librarian');
  // The approved mockup Settings room (5e1db38) replaced the pipeline workspace shell:
  // its Pipeline destination mounts the Librarian analyzer itself.
  const memoryPipelineStart = source.indexOf('const buildApprovedMockupSettingsPanel =');
  const memoryPipelineEnd = source.indexOf("if(sectionId==='logs')", memoryPipelineStart);
  assert.ok(memoryPipelineStart >= 0 && memoryPipelineEnd > memoryPipelineStart, 'Settings room destination builder is present');
  const memoryPipeline = source.slice(memoryPipelineStart, memoryPipelineEnd);
  assert.ok(source.includes('const LIBRA_MEMORY_PIPELINE_STAGES = Object.freeze([LIBRARIAN_STAGE_ID])'), 'new memory execution exposes only Librarian; old slots above remain preserved');
  assert.ok(memoryPipeline.includes("if(sectionId==='pipeline')return buildLibrarianAnalyzerPanel(false,false);"), 'Pipeline > Memory generation opens the selected stage detail directly');
  const analyzerStart = source.indexOf('const buildLibrarianAnalyzerPanel = (compactView=false, advancedOnly=false) => {');
  assert.ok(analyzerStart >= 0, 'Librarian analyzer stage detail is present');
  const analyzer = source.slice(analyzerStart, source.indexOf('\n  const ', analyzerStart + 10));
  assert.ok(analyzer.includes("text:'Librarian 기억 분석'}") && analyzer.includes("checkboxNode(slot.enabled!==false,'사용',change(value=>{slot.enabled=value;}))"), 'the dedicated stage detail exposes the Librarian enable switch');
  assert.match(source, /Object\.freeze\(\{ id: 'memory', label: '기억', icon: '◫', group: '기억과 세계' \}\)/, 'desktop sidebar exposes the shared Memory page');
  assert.ok(source.includes('SHARED_SIDEBAR_PAGE_REGISTRY.map(page => Object.freeze({'), 'mobile navigation derives from the same shared page registry');
  const memoryGateStart = source.indexOf('const memoryStageEnabledForSettings =');
  const memoryGateEnd = source.indexOf('const activeMemoryStageOrderForSettings =', memoryGateStart);
  const memoryGate = source.slice(memoryGateStart, memoryGateEnd);
  assert.ok(memoryGate.includes('stageName===LIBRARIAN_STAGE_ID'), 'only Librarian can execute');
  assert.ok(memoryGate.includes('settings.enableLibrarian!==false'), 'explicit memory OFF remains respected');
  assert.doesNotMatch(memoryGate,/enableCharacterAide|enableWorldAide|enablePlotAide/,'old flags are configuration history, not execution authority');

  process.stdout.write('libra_ariadne_only_defaults_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
