'use strict';
// FEATURE-FIRST nominal registered settings flows only. This is not the Task A/Task 6 edge matrix or host qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { profile } = require('./wm-analysis-preset-test-support.cjs');
const KEY = 'LMAI_Config';
const plain = x => JSON.parse(JSON.stringify(x));
const seed = () => ({ useLLM: true, debug: false, llm: profile('legacy'), llmPresets: { a: profile('A'), b: profile('B') }, llmDefaultPreset: 'a',
  hmeAssociativeGraphMode: 'deep', rpLongTermLongTtl: 777, injectionBudgetPreset: 'custom', injectionBudgetMaxTokens: 1600,
  coldArchiveHydrationEnabled: true, dualRecallMode: 'dual', hybridMemoryEngineEnabled: true, hybridScopeIndexEnabled: true, worldAdjustmentMode: 'strict', entityVisualCanonEnabled: true, embed: { provider: 'openai', model: 'embed-old', timeout: 23456, customSibling: 'stored-only', enabled: false },
  emotionEnabled: false, weights: { similarity: 0, importance: 0.37, customSibling: 'stored-only' }, customObject: { nested: 0, enabled: false } });
const observations = [];
const open = async store => loadGui({ observeCommonAnalysis: true, nativeInitialization: true, args: { use_llm: 'false' }, store });
const node = (f, id) => f.w.document.querySelector('#lmai-overlay').querySelector(id);
const until = async (fn, label) => { const end = Date.now() + 3500; while (!fn()) { assert(Date.now() < end, label); await new Promise(r => setTimeout(r, 5)); } };
const event = (f, id) => node(f, id).dispatchEvent(new f.w.Event('change', { bubbles: true }));
const save = async f => { node(f, '#btn-save-settings').click(); await until(() => ['saved', 'failed'].includes(node(f, '#settings-auto-save-status').dataset.state), 'settings save settles'); };
const addObservation = (label, f, extra = {}) => observations.push({ label, settingsWrites: f.calls.writes.filter(r => r.key === KEY).length, hostWrites: f.calls.hostWrites.length, ...extra });

test('normal debug save preserves unedited stored settings and separate latest live siblings', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store);
  try {
    const before = plain(f.w.LibraSettingsSchema.forStorage(JSON.parse(store.get(KEY))));
    f.api.MemoryEngine.CONFIG.weights = { similarity: 0.7, importance: 0.8, customSibling: 'live-only' };
    f.api.MemoryEngine.CONFIG.liveMarker = 'new-live-state';
    node(f, '#sdebug').checked = true;
    await save(f); // Manual Save detects a value difference without an input event.
    assert.equal(node(f, '#settings-auto-save-status').dataset.state, 'saved');
    const after = JSON.parse(store.get(KEY));
    assert.deepEqual(after, plain(f.w.LibraSettingsSchema.forStorage({ ...before, debug: true })));
    assert.equal(after.hmeAssociativeGraphMode, 'deep'); assert.equal(after.rpLongTermLongTtl, 777); assert.equal(after.injectionBudgetMaxTokens, 1600);
    assert.equal(after.emotionEnabled, false); assert.equal(after.weights.similarity, 0); assert(!Object.hasOwn(after, 'scoringWeights')); assert(!Object.hasOwn(after, 'maxLimit'));
    assert.deepEqual(plain(f.api.MemoryEngine.CONFIG.weights), { similarity: 0.7, importance: 0.8, customSibling: 'live-only' });
    assert.equal(f.api.MemoryEngine.CONFIG.liveMarker, 'new-live-state');
    assert.equal(f.calls.hostWrites.length, 0); addObservation('debug sparse manual save', f, { preservedLegacyCustomBudget: 1600 });
  } finally { f.close(); }
});

test('connection leaf save preserves removed numeric values and separate latest live siblings', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store);
  try {
    f.api.MemoryEngine.CONFIG.embed.customSibling = 'live-only';
    node(f, '#sem').value = 'embed-new'; event(f, '#sem');
    await until(() => node(f, '#settings-auto-save-status').dataset.state === 'saved', 'connection save settles');
    const stored = JSON.parse(store.get(KEY));
    assert.equal(stored.embed.model, 'embed-new'); assert.equal(stored.embed.timeout, 23456); assert.equal(stored.embed.customSibling, 'stored-only');
    assert.equal(f.api.MemoryEngine.CONFIG.embed.customSibling, 'live-only'); assert.equal(stored.hmeAssociativeGraphMode, 'deep');
    assert.equal(stored.injectionBudgetMaxTokens, 1600); assert.equal(stored.weights.similarity, 0);
    assert.equal(f.calls.hostWrites.length, 0); addObservation('connection owned leaf/custom values', f);
  } finally { f.close(); }
});

test('AI pause saves, reopens and initializes a fresh runtime without changing selection or calling providers', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store); let fresh;
  let modelCalls = 0, embeddingPublications = 0;
  try {
    f.common.LLMProvider.call = async () => { modelCalls++; throw Error('basic smoke forbids model execution'); };
    const publish = f.api.MemoryEngine.EmbeddingEngine.noteConfigurationPublished;
    f.api.MemoryEngine.EmbeddingEngine.noteConfigurationPublished = (...args) => { embeddingPublications++; return publish(...args); };
    node(f, '#sllmpresetselect').value = 'b'; event(f, '#sllmpresetselect');
    node(f, '#sllmpm').value = 'unsaved-B'; node(f, '#sllmpm').dispatchEvent(new f.w.Event('input', { bubbles: true }));
    node(f, '#s-use-llm').checked = false; event(f, '#s-use-llm');
    await until(() => node(f, '#settings-auto-save-status').dataset.state === 'saved', 'pause save settles');
    assert.equal(JSON.parse(store.get(KEY)).useLLM, false); assert.equal(f.api.MemoryEngine.CONFIG.useLLM, false);
    assert.equal(JSON.parse(store.get(KEY)).llmDefaultPreset, 'a'); assert.equal(node(f, '#sllmpm').value, 'unsaved-B');
    assert.equal(JSON.parse(store.get(KEY)).llmPresets.b.model, 'B');
    assert.equal(node(f, '#home-llm-pill').textContent, '사용 중지');
    assert.match(node(f, '#home-llm-note').textContent, /연결 설정 유지/);
    assert.equal(node(f, '#s-use-llm-status').dataset.state, 'paused');
    assert.equal(f.common.resolveCommonAnalysisPreset(f.api.MemoryEngine.CONFIG).reason, 'analysis_disabled');
    node(f, '#xbtn').click(); node(f, '#common-ai-unsaved-discard').click();
    await f.callbacks.setting(); assert.equal(node(f, '#s-use-llm').checked, false);
    fresh = await open(store); fresh.common.LLMProvider.call = async () => { modelCalls++; throw Error('basic smoke forbids model execution'); };
    assert.equal(fresh.api.MemoryEngine.CONFIG.useLLM, false); assert.equal(node(fresh, '#s-use-llm').checked, false);
    assert.equal(node(fresh, '#settings-profile-connection-pill').textContent, '사용 중지');
    node(fresh, '#s-use-llm').checked = true; event(fresh, '#s-use-llm');
    await until(() => node(fresh, '#settings-auto-save-status').dataset.state === 'saved', 'enable save settles');
    assert.equal(JSON.parse(store.get(KEY)).useLLM, true); assert.equal(fresh.api.MemoryEngine.CONFIG.llmDefaultPreset, 'a');
    assert.equal(node(fresh, '#home-llm-pill').textContent, '설정됨'); assert.equal(modelCalls, 0);
    assert.equal(f.calls.hostWrites.length + fresh.calls.hostWrites.length, 0); assert.equal(embeddingPublications, 0);
    addObservation('pause/reopen/fresh native init/enable', f, { freshSettingsWrites: fresh.calls.writes.filter(r => r.key === KEY).length, modelCalls, embeddingPublications });
  } finally { fresh?.close(); f.close(); }
});

test('ordinary settings have exactly three groups and tools remain accessible in material/work views', async () => {
  const f = await open(new Map([[KEY, JSON.stringify(seed())]]));
  try {
    const overlay = node(f, '#tab-settings').closest('#lmai-overlay');
    assert.deepEqual(Array.from(node(f, '#tab-settings').querySelectorAll('[data-settings-group]')).map(n => n.dataset.settingsGroup), ['ai', 'memory', 'story']);
    assert.deepEqual(Array.from(node(f, '#tab-settings').querySelectorAll('[data-settings-group] > h3')).map(n => n.textContent), ['AI 연결', '기억', '이야기']);
    for (const id of ['swmode','swsim','swimp','swrec','sscprof','sscword','smaxlimit','sthr','ssimthr','smempreset','sinjbtok','sdual-mode','sdual-hdepth','sdual-sdepth','sdual-rrf','sdual-budget','shme','shmegraph','shmedbg','srplt','srplttl','srplchars','sllmpt','sllmpto','sllmpmc','sllmprb','sfto','seto']) assert.equal(overlay.querySelector('#'+id), null, id+' removed');
    assert(node(f, '#semotion').closest('#tab-memory')); assert(node(f, '#svisual').closest('#tab-entity'));
    assert(node(f, '#sswi').closest('#tab-world')); assert(node(f, '#screfl').closest('#tab-work'));
    assert.match(node(f, '#screfl').parentNode.textContent, /自動|자동 실행 경로는 연결되어 있지/);
    for (const id of ['btn-cold-start','btn-cold-reanalyze','btn-add-user-lorebook','btn-health-scan','lmai-cache-reset','btn-export-settings-file','btn-import-settings-file','btn-reset-settings','lmai-data-reset']) assert(node(f, '#'+id).closest('#tab-work'), id);
    assert(node(f, '#sdebug').closest('#tab-logs')); assert(node(f, '#btn-export-debug-file').closest('#tab-logs'));
    assert(overlay.querySelector('#tab-work [data-wm-storage-panel]'));
    assert.equal(overlay.querySelectorAll('#sllmdefault').length, 1);
    assert.equal(node(f, '#sinjbp').value, 'custom'); assert.match(node(f, '#sinj-budget-status').textContent, /1,600.*12,000.*요청 시 결정/);
    assert.match(node(f, '#s-cold-archive-status').textContent, /dual.*연결되지/);
    overlay.querySelector('[data-tab="work"]').click(); assert(node(f, '#tab-work').classList.contains('on'));
    addObservation('three groups/material-work access', f, { ordinaryGroups: 3, removedNumericControls: true });
  } finally { f.close(); }
});

test('memory intents save and reopen without changing the retrieval path or deleting continuity data', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store); let fresh;
  try {
    node(f, '#s-related-recall').checked = false; await save(f);
    let saved = JSON.parse(store.get(KEY)); assert.equal(saved.hmeAssociativeGraphMode, 'off');
    assert.equal(saved.hybridMemoryEngineEnabled, true); assert.equal(saved.hybridScopeIndexEnabled, true); assert.equal(saved.dualRecallMode, 'dual');
    node(f, '#s-related-recall').checked = true; event(f, '#s-related-recall');
    await until(() => node(f, '#settings-auto-save-status').dataset.state === 'saved', 'graph enable settles');
    saved = JSON.parse(store.get(KEY)); assert.equal(saved.hmeAssociativeGraphMode, 'light'); assert.equal(saved.hybridMemoryEngineEnabled, true); assert.equal(saved.hybridScopeIndexEnabled, true);
    node(f, '#s-cold-archive').checked = false; node(f, '#s-rp-continuity').checked = false; await save(f);
    saved = JSON.parse(store.get(KEY)); assert.equal(saved.coldArchiveHydrationEnabled, false); assert.equal(saved.rpLongTermMemoryEnabled, false);
    assert.equal(saved.rpLongTermLongTtl, 777); assert.equal(saved.dualRecallMode, 'dual'); assert.equal(saved.injectionBudgetMaxTokens, 1600);
    fresh = await open(store); assert.equal(fresh.api.MemoryEngine.CONFIG.coldArchiveHydrationEnabled, false);
    assert.equal(fresh.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode, 'light'); assert.equal(fresh.api.MemoryEngine.CONFIG.hybridScopeIndexEnabled, true);
    assert.equal(node(fresh, '#s-cold-archive').checked, false); assert.equal(node(fresh, '#s-rp-continuity').checked, false);
    assert.equal(f.calls.hostWrites.length + fresh.calls.hostWrites.length, 0);
    addObservation('graph/archive/continuity nominal save and fresh init', f, { activePathPreserved: 'dual' });
  } finally { fresh?.close(); f.close(); }
});

test('supported budget choices and contextual story/world controls save and reopen', async () => {
  const store = new Map([[KEY, JSON.stringify(seed())]]), f = await open(store); let fresh;
  try {
    for (const [preset, tokens] of [['compact',12000],['large',20000],['max',32000]]) {
      node(f, '#sinjbp').value = preset; await save(f);
      assert.equal(JSON.parse(store.get(KEY)).injectionBudgetPreset, preset); assert.equal(JSON.parse(store.get(KEY)).injectionBudgetMaxTokens, tokens);
      assert.match(node(f, '#sinj-budget-status').textContent, new RegExp(tokens.toLocaleString()));
    }
    node(f, '#ssam').value = 'supportive'; node(f, '#sdm').value = 'light'; node(f, '#snsfwm').value = 'soft';
    node(f, '#sngp').checked = false; node(f, '#sapf').checked = false; node(f, '#semotion').checked = true;
    node(f, '#svisual').checked = false; node(f, '#sswi').checked = false; node(f, '#sworldconflict').value = 'soft'; await save(f);
    const saved = JSON.parse(store.get(KEY)); assert.equal(saved.storyAuthorMode, 'supportive'); assert.equal(saved.storyAuthorEnabled, true);
    assert.equal(saved.directorMode, 'light'); assert.equal(saved.directorEnabled, true); assert.equal(saved.nsfwMode, 'soft'); assert.equal(saved.nsfwEnabled, true);
    assert.equal(saved.nsfwGuidancePromptEnabled, false); assert.equal(saved.assistantPrefillEnabled, false); assert.equal(saved.worldAdjustmentMode, 'soft');
    assert.equal(saved.entityVisualCanonEnabled, false); assert.equal(saved.emotionEnabled, true); assert.equal(saved.weights.similarity, 0);
    fresh = await open(store); assert.equal(node(fresh, '#sworldconflict').value, 'soft'); assert.equal(fresh.api.MemoryEngine.CONFIG.worldAdjustmentMode, 'soft');
    assert.equal(node(fresh, '#svisual').checked, false); assert.equal(node(fresh, '#ssam').value, 'supportive'); assert.equal(node(fresh, '#sngp').checked, false);
    assert.equal(f.calls.hostWrites.length + fresh.calls.hostWrites.length, 0); addObservation('budgets/story/contextual save and reopen', f);
  } finally { fresh?.close(); f.close(); }
});

test('preset edit preserves absent numeric and untouched independent options', async () => {
  const config = seed(); Object.assign(config.llmPresets.a, { temp: 0, timeout: 33333, maxCompletionTokens: 4321, reasoningBudgetTokens: 987, reasoningEffort: 'high', serviceTier: 'priority', unknownNested: { enabled: false, n: 0 } });
  const store = new Map([[KEY, JSON.stringify(config)]]), f = await open(store);
  try {
    node(f, '#sllmpresetselect').value = 'a'; event(f, '#sllmpresetselect');
    const before = plain(JSON.parse(store.get(KEY)).llmPresets.a);
    node(f, '#sllmpm').value = 'edited-model'; node(f, '#sllmpm').dispatchEvent(new f.w.Event('input', { bubbles: true }));
    node(f, '#btn-llmp-save').click(); await until(() => node(f, '#common-ai-save-status').dataset.state === 'saved', 'preset save settles');
    const after = JSON.parse(store.get(KEY)).llmPresets.a;
    for (const key of ['temp','timeout','maxCompletionTokens','reasoningBudgetTokens','reasoningEffort','serviceTier','unknownNested']) assert.deepEqual(after[key], before[key], key);
    assert.equal(after.model, 'edited-model'); assert.equal(JSON.parse(store.get(KEY)).llmDefaultPreset, 'a');
    assert.equal(f.calls.hostWrites.length, 0); addObservation('sparse preset edit numeric preservation', f);
  } finally { f.close(); }
});

test.after(() => { if (process.env.WM_BASIC_CHECKPOINT) fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT, 'BASIC-SMOKE-OBSERVATIONS.json'), JSON.stringify({ observations, limits: 'Normal synthetic GUI settings flows only; no edge/failure/restart-job matrix, regression, independent review, actual host, Full/Min parity or product qualification.' }, null, 2) + '\n'); });
