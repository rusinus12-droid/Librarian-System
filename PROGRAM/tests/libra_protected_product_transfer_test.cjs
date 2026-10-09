'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, releasePattern("^\\/\\/@display-name LIBRA v{libra}\\s*$", "m"));
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.match(source, /LIBRA_PROTECTED_PRODUCT_TRANSFER_SCHEMA = 'libra\.protected_product_transfer\.v1'/);
assert.doesNotMatch(source, /SGA_PROTECTED_ANALYSIS_SCHEMA =/);
assert.match(source, /const plannerProtectedProductView = plan => clone\(asObject\(plan\)\);/);

const plannerRenderer = between('const renderPlannerBlock = plannerRun => {', 'const chronologicalRecallRows = rows =>');
assert.match(plannerRenderer, /const sourceBrief = plannerBriefClean\(plannerRun\?\.brief/);
assert.match(plannerRenderer, /legacyView = !sourceBrief/);
assert.match(plannerRenderer, /memory_grounded_reaction_brief\.v1/);
assert.doesNotMatch(plannerRenderer, /compactPlannerInjectionView\(/,
  'protected Planner transfer must not run the lossy compatibility projection');
assert.doesNotMatch(plannerRenderer, /const compressed =|const minimal =|maxJsonChars|plannerJson\.length\s*>/,
  'protected Planner transfer must not field-drop merely to satisfy the preferred cap');
assert.match(plannerRenderer, /fieldDroppingApplied: false/);
assert.match(plannerRenderer, /fullProductPreserved/);

const sgaRenderer = between('const renderSgaBlock =', 'const memoryInjectionScopeMatches =');
assert.doesNotMatch(sgaRenderer, /protectedAnalysis|SGA_PRIVATE_ANALYSIS|analysisTransferChars/,
  'final-model overlay must not transfer stage analysis');
assert.match(sgaRenderer, /fullDraftPreserved/);
assert.match(sgaRenderer, /fullProductPreserved/);
assert.match(sgaRenderer, /capExceededToPreserveProduct/);
assert.match(sgaRenderer, /sga_finalization_cap_expanded_for_complete_product/);
assert.match(source, /const CLASSIC_MAX_INJECTION_CHARS = 20000;/,
  'Classic remains the evidence-budgeted route');

const waitFor = async (predicate, label, timeoutMs = 30000) => {
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

const createHarness = () => {
  const listeners = new Map();
  const unloadHandlers = [];
  const pluginStorage = createStore();
  const safeLocalStorage = createStore();
  const chat = { id: 'protected-product-chat', chatId: 'protected-product-chat', name: 'Protected Product Test', message: [], messages: [], bindedPersona: '' };
  const character = { id: 'protected-product-character', name: 'Protected Product Test', chats: [chat] };
  const host = {
    pluginStorage,
    safeLocalStorage,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      const key = String(name);
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key.includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('protected product test has no external server'); },
    async addPluginChannelListener(channel, handler) {
      const key = String(channel);
      const set = listeners.get(key) || new Set();
      set.add(handler); listeners.set(key, set); return true;
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
  vm.runInContext(source, context, { filename: 'LIBRA-protected-product-test.js' });
  return {
    context,
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
  const harness = createHarness();
  try {
    const api = await waitFor(() => harness.context.__LIBRA__?.version === releaseVersion('libra') && typeof harness.context.__LIBRA__?.debugPlannerFinalOverlay === 'function' ? harness.context.__LIBRA__ : null, 'LIBRA API');

    const plannerSentinels = Array.from({ length: 7 }, (_, index) => `PLANNER_FULL_${index}_${String(index).repeat(2800)}`);
    const plannerPlan = {
      schema: 'libra.turn_planner.v2',
      ok: true,
      input_contract: { user_intent: plannerSentinels[0], enacted_user_actions: [plannerSentinels[1]], open_user_choices: [], response_obligations: [] },
      scene_anchor: { situation: plannerSentinels[2], location_time_social: [], positions_objects_physical: [] },
      evidence: { memory_facts: [plannerSentinels[3]], entity_facts: [], world_facts: [], narrative_facts: [], uncertainties: [], conflicts_resolved: [] },
      character_plan: { active_characters: [], user_agency_boundaries: [plannerSentinels[4]] },
      world_plan: { active_constraints: [plannerSentinels[5]], physical_causality: [], social_institutional_constraints: [], remote_effect_bridges: [], state_application: { exact: [], directional: [], pending: [], proposed: [] } },
      narrative_plan: { scene_purpose: plannerSentinels[6], primary_tension: '', active_threads: [], must_address: [], recommended_beats: [], open_questions: [], payoff_candidates: [], do_not_resolve_yet: [], pacing: [] },
      recommended_guidelines: [],
      director_brief: { required_outcomes: [], forbidden_moves: [], continuity_locks: [], staging_instructions: [], dialogue_rhythm: [], ending_requirement: '' },
      additional_information: []
    };
    const plannerBlock = api.debugPlannerFinalOverlay({ ok: true, plan: plannerPlan });
    assert.match(plannerBlock, /<LIBRA_CURRENT_TURN_BRIEF>/);
    assert.doesNotMatch(plannerBlock, /<LIBRA_CURRENT_TURN_PLANNER>/);
    assert.doesNotMatch(plannerBlock, /\"input_contract\"/);
    assert.ok(plannerBlock.length > 14000, 'fixture must exceed the old preferred Planner cap');
    for (const sentinel of plannerSentinels) assert.ok(plannerBlock.includes(sentinel), 'complete normalized Planner field was lost');
    const plannerMeta = api.getLastPlannerTransfer();
    assert.equal(plannerMeta.fullProductPreserved, true);
    assert.equal(plannerMeta.fieldDroppingApplied, false);
    assert.equal(plannerMeta.compressionApplied, false);
    assert.equal(plannerMeta.preferredCapExceeded, true);
    assert.equal(api.getLastProtectedProductTransfer().product, 'planner');

    const draft = `DRAFT_START\n${'완성된 같은 턴 초안 문장입니다. '.repeat(520)}\nDRAFT_END.`;
    const stageSentinels = ['SHADOW_PRIVATE_COMPLETE', 'SHADOW_SCENE_COMPLETE', 'CHAR_PRIVATE_COMPLETE', 'CHAR_INTEGRATED_COMPLETE', 'WORLD_PRIVATE_COMPLETE', 'WORLD_INTEGRATED_COMPLETE', 'PLOT_PRIVATE_COMPLETE', 'PLOT_INTEGRATED_COMPLETE'];
    const stages = [
      { stage: 'sga_shadow', label: 'SHADOW', ok: true, changed: true, privateAnalysis: { summary: `${stageSentinels[0]} ${'a'.repeat(1500)}`, constraints: [`${stageSentinels[0]}_C`] }, analysis: { purpose: `${stageSentinels[1]} ${'b'.repeat(1500)}`, beats: [`${stageSentinels[1]}_B`] } },
      { stage: 'sga_character_aide', label: 'Character AIDE', ok: true, changed: true, editCount: 2, appliedEdits: 2, privateAnalysis: { summary: `${stageSentinels[2]} ${'c'.repeat(1500)}`, constraints: [`${stageSentinels[2]}_C`], risks: [`${stageSentinels[2]}_R`], directives: [`${stageSentinels[2]}_D`] }, analysis: { summary: `${stageSentinels[3]} ${'d'.repeat(1500)}`, constraints: [`${stageSentinels[3]}_C`], risks: [`${stageSentinels[3]}_R`] } },
      { stage: 'sga_world_aide', label: 'World AIDE', ok: true, changed: true, editCount: 1, appliedEdits: 1, privateAnalysis: { summary: `${stageSentinels[4]} ${'e'.repeat(1500)}`, constraints: [`${stageSentinels[4]}_C`] }, analysis: { summary: `${stageSentinels[5]} ${'f'.repeat(1500)}`, risks: [`${stageSentinels[5]}_R`] } },
      { stage: 'sga_plot_aide', label: 'Plot AIDE', ok: true, changed: true, editCount: 1, appliedEdits: 1, privateAnalysis: { summary: `${stageSentinels[6]} ${'g'.repeat(1500)}`, directives: [`${stageSentinels[6]}_D`] }, analysis: { summary: `${stageSentinels[7]} ${'h'.repeat(1500)}`, constraints: [`${stageSentinels[7]}_C`] } }
    ];
    const run = {
      ok: true,
      draft,
      draftChars: draft.length,
      stages,
      continuityLocks: ['FINAL_CONTINUITY_LOCK_COMPLETE'],
      userAgencyLocks: ['FINAL_AGENCY_LOCK_COMPLETE'],
      doNotReveal: ['FINAL_SECRET_LOCK_COMPLETE'],
      sceneDesign: { purpose: 'FINAL_SCENE_DESIGN_COMPLETE', beats: ['FINAL_SCENE_BEAT_COMPLETE'] },
      extraProviderCalls: 0
    };
    const settings = {
      multiPipelineMode: 'heavyweight',
      informationTransferMode: 'draft_and_analysis',
      maxInjectionChars: 6000,
      outputMode: 'draft_guided',
      gradiaWritingMode: 'rp',
      inputWriterMode: 'rp',
      internalDraftLanguage: 'follow_source'
    };
    const evidence = { current_input: '문을 열고 안으로 들어간다.', terminal_scene: '문 앞에 서 있다.' };
    const sgaBlock = api.debugSgaFinalOverlay(run, settings, evidence);
    assert.ok(sgaBlock.includes(`<LIBRA_SGA_SAME_TURN_CANDIDATE>\n${draft}\n</LIBRA_SGA_SAME_TURN_CANDIDATE>`), 'complete draft must remain byte-identical inside the protected candidate block');
    for (const sentinel of stageSentinels) assert.equal(sgaBlock.includes(sentinel), false, `final overlay leaked analysis ${sentinel}`);
    for (const lock of ['FINAL_CONTINUITY_LOCK_COMPLETE', 'FINAL_AGENCY_LOCK_COMPLETE', 'FINAL_SECRET_LOCK_COMPLETE']) assert.ok(sgaBlock.includes(lock), `final overlay omitted ${lock}`);
    const sgaMeta = api.getLastSgaFinalization();
    assert.equal(sgaMeta.fullDraftPreserved, true);
    assert.equal(sgaMeta.fullProductPreserved, true);
    assert.equal(sgaMeta.analysisTransferChars, undefined);
    const productMeta = api.getLastProtectedProductTransfer();
    assert.equal(productMeta.product, 'sga_draft');
    assert.equal(productMeta.fullProductPreserved, true);
    assert.equal(productMeta.fieldDroppingApplied, false);

    const draftOnlyBlock = api.debugSgaFinalOverlay(run, { ...settings, informationTransferMode: 'draft_only' }, evidence);
    assert.equal(draftOnlyBlock, sgaBlock, 'legacy transfer setting must behave as draft-only');
    for (const sentinel of stageSentinels) assert.equal(draftOnlyBlock.includes(sentinel), false, 'draft-only mode must not leak private analysis');
    assert.equal(api.getLastProtectedProductTransfer().product, 'sga_draft');
  } finally {
    await harness.cleanup();
  }

  process.stdout.write('libra_protected_product_transfer_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
