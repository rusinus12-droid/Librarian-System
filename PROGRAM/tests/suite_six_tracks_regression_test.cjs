'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SDK_PATH = path.join(ROOT, 'sdk', 'MemorySuiteSourceInput.libra.source.js');
const IPC_READ_PATH = path.join(ROOT, 'tools', 'gradia_plugin_read.cjs');
const LIBRA_PATH = path.join(ROOT, 'plugins', 'LIBRA.js');
const HAYAKU_PATH = path.join(ROOT, 'plugins', 'HAYAKU_Locator_Continuity.js');
const GRADIA_PATH = path.join(ROOT, 'plugins', 'GRADIA.js');

const slice = (source, startAnchor, endAnchor) => {
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, `start anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `end anchor not found after ${startAnchor}: ${endAnchor}`);
  return source.slice(start, end);
};

const plain = value => JSON.parse(JSON.stringify(value));

test('Track 1: Flashback clears false changedTurns on whitespace/CRLF/added-tag differences while detecting edits and rerolls', async () => {
  const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
  const f = await createFixture();
  try {
    const t = f.api._test;
    await f.api.setSourceEditRules({ version: 1, ignoredTags: ['img'], unwrapTags: [], sourceTags: [], controls: [] });
    f.currentChat.message = [
      { role: 'user', chatId: 'u1', data: 'Turn 1 user prompt\n<status-window>HP 10</status-window>' },
      { role: 'char', chatId: 'a1', data: 'Turn 1 original response.\n<status-window>MP 20</status-window>' }
    ];
    const [initialSource] = t.collectLiveChatSourcesFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });
    const legacyStoredRecord = {
      id: 'rec_t1',
      hash: 'hash_t1',
      scopeKey: 'char:test|chat:test',
      sourceType: 'response',
      role: 'assistant',
      turnIndex: 1,
      pairIndex: 1,
      userMessagePosition: initialSource.userMessagePosition,
      assistantMessagePosition: initialSource.assistantMessagePosition,
      sourceMessageIds: ['u1', 'a1'],
      chunkIndex: 0,
      chunkCount: 1,
      text: 'User:\r\nTurn 1 user prompt\r\n<status-window>HP 10</status-window>\r\n\r\n---\r\n\r\nAssistant:\r\nTurn 1 original response.\r\n<status-window>MP 20</status-window>',
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
      dim: 8,
      lifecycleStatus: 'active',
      metadata: {
        captureAuthority: { source: 'finalized_live_chat', provisional: false, liveConfirmed: true }
      }
    };

    await f.api.setSourceEditRules({ version: 1, ignoredTags: ['img', 'status-window'], unwrapTags: [], sourceTags: [], controls: [] });
    const [filteredSource] = t.collectLiveChatSourcesFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });

    const ruleCDiff = t.diffLiveChatSourcesAgainstRecords([filteredSource], [legacyStoredRecord]);
    assert.equal(ruleCDiff.changed.length, 0, 'added source tag + CRLF normalization must clear false changedTurns');
    assert.equal(ruleCDiff.unchanged.length, 1);

    const rerollSource = {
      ...filteredSource,
      sourceMessageIds: filteredSource.sourceMessageIds.map(id => (id === 'a1' ? 'a1-reroll' : id))
    };
    const rerollDiff = t.diffLiveChatSourcesAgainstRecords([rerollSource], [legacyStoredRecord]);
    assert.equal(rerollDiff.changed.length, 1, 'conflicting native message ID must still flag changed');

    f.currentChat.message[1].data = 'Turn 1 genuinely edited body.\n<status-window>MP 20</status-window>';
    const [editedSource] = t.collectLiveChatSourcesFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });
    const editedDiff = t.diffLiveChatSourcesAgainstRecords([editedSource], [legacyStoredRecord]);
    assert.equal(editedDiff.changed.length, 1, 'real content edit must still flag changed');
  } finally {
    await f.dispose();
  }
});

test('Track 1: HAYAKU hayakuSameTurnSource matches Rule C re-projected raw text and legacy visible hash, while rejecting edits', async () => {
  const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
  const packet = createValidPacket({ turn: 1, subject: 'Alice', scene: 'study', summary: 'Alice checked the map.' });
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      { role: 'user', chatId: 'u1', id: 'u1', data: 'Check the map.' },
      { role: 'assistant', chatId: 'a1', id: 'a1', data: hiddenPacketMessage('Alice checked the map.\n<status-window>HP 9</status-window>', packet) }
    ],
    llmResponder: async () => { throw new Error('unexpected LLM call'); }
  });
  try {
    const t = runtime.hayaku._test;
    await runtime.hayaku.setSourceEditRules({
      version: 1,
      ignoredTags: ['img', 'status-window'],
      unwrapTags: [],
      sourceTags: [],
      controls: ['html-comment', 'lbdata']
    });
    const scope = await t.currentChatScope();
    const snap = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    const pair = snap.historyPairs?.[0];
    assert.ok(pair?.assistantMessageIdHash && pair?.assistantVisibleHash && pair?.sourceRawDigest, 'authoritative history pair carries message id, visible hash, and raw digest');

    const hayakuSrc = fs.readFileSync(HAYAKU_PATH, 'utf8');
    const fnMatch = hayakuSrc.match(/function hayakuSameTurnSource\(stored, pair\) \{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'hayakuSameTurnSource definition present');
    const stripTag = v => String(v ?? '').replace(/<status-window>[\s\S]*?<\/status-window>/g, '');
    const ctx = vm.createContext({
      memorySuiteCanonicalSource: v => stripTag(v).replace(/\r\n/g, '\n').replace(/[ \t]+(?=\n|$)/g, '').replace(/\n{3,}/g, '\n\n').trim(),
      memorySuiteProjectSourceTags: v => stripTag(v)
    });
    vm.runInContext(fnMatch[0] + '; globalThis.hayakuSameTurnSource = hayakuSameTurnSource;', ctx);

    // 1. Legacy record stored pre-filter visible text & old visibleHash, same assistantMessageIdHash -> Rule C matches
    assert.equal(ctx.hayakuSameTurnSource(
      {
        assistantMessageIdHash: pair.assistantMessageIdHash,
        userMessageIdHash: pair.userMessageIdHash,
        userHash: 'old_user_hash',
        assistantVisibleHash: 'old_visible_hash',
        assistantVisibleText: 'Alice checked the map.\r\n<status-window>HP 9</status-window>'
      },
      { ...pair, assistantVisibleText: 'Alice checked the map.' }
    ), true);

    // 2. Legacy visible hash fallback matches
    assert.equal(ctx.hayakuSameTurnSource(
      {
        assistantMessageIdHash: pair.assistantMessageIdHash,
        userHash: pair.userHash,
        assistantVisibleHash: 'legacy_v1_hash'
      },
      { ...pair, assistantLegacyVisibleHash: 'legacy_v1_hash' }
    ), true);

    // 3. Real reply edit does NOT match Rule C
    assert.equal(ctx.hayakuSameTurnSource(
      {
        assistantMessageIdHash: pair.assistantMessageIdHash,
        userHash: pair.userHash,
        assistantVisibleHash: 'old_visible_hash',
        assistantVisibleText: 'Completely different reply.'
      },
      { ...pair, assistantVisibleText: 'Alice checked the map.' }
    ), false);

    // 4. Reroll (different assistantMessageIdHash and different packet) does NOT match
    assert.equal(ctx.hayakuSameTurnSource(
      {
        assistantMessageIdHash: 'other_msg_id_hash',
        userHash: pair.userHash,
        assistantVisibleHash: 'old_visible_hash',
        assistantVisibleText: 'Alice checked the map.'
      },
      { ...pair, assistantVisibleText: 'Alice checked the map.' }
    ), false);
  } finally {
    await runtime.dispose?.();
  }
});

test('Track 2 & Track 4: LIBRA Micro grid CSS prevents vertical wrapping & Story Clock .facts use clear labels/units', () => {
  const libraSrc = fs.readFileSync(LIBRA_PATH, 'utf8');

  // Track 2: Micro tile grid CSS
  assert.match(libraSrc, /\.micro-turns\.is-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(libraSrc, /\.micro-turn \.micro-turn__top\{display:flex;align-items:center;[^}]*flex-wrap:nowrap/);
  assert.match(libraSrc, /\.micro-turn \.micro-turn__top b\{[^}]*white-space:nowrap/);
  assert.match(libraSrc, /\.micro-turn \.micro-turn__top \.micro-turn__count\{[^}]*white-space:nowrap/);
  assert.match(libraSrc, /\.micro-turns\.is-grid \.micro-turn__top b\{[^}]*\}/);
  assert.match(libraSrc, /\.micro-turns\.is-grid \.micro-turn__top \.micro-turn__count\{[^}]*\}/);

  // Track 4: Story Clock card UI labels
  const clockCoreSource = slice(libraSrc, "const STORY_CLOCK_SCHEMA = 'libra.story_clock.v1';", 'const LENS_DEFAULT_OUTPUT_HINT =');
  const storyClockUiSource = slice(libraSrc, 'const storyClockPanelState = () => {', 'const buildApprovedMockupStory = () => {');
  const makeEl = (tag, attrs = {}, children = []) => ({
    tag,
    ...attrs,
    children: (Array.isArray(children) ? children : [children]).filter(Boolean)
  });
  const flatNodes = root => root ? [root, ...(Array.isArray(root.children) ? root.children.flatMap(flatNodes) : [])] : [];
  const ctx = vm.createContext({
    LibraMemoryCore: { peekSnapshot: () => ({ scope: { scopeKey: 's1' } }) },
    Gui: {},
    guiAsObject: v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    guiAsArray: v => (Array.isArray(v) ? v : []),
    text: v => String(v ?? ''),
    queueGuiNavigationRender: () => {},
    guiEl: makeEl,
    Date, Number, String, Boolean, Array, Object, Math, Promise, JSON, Map, Set
  });
  vm.runInContext(
    clockCoreSource + '\n' + storyClockUiSource + ';globalThis.buildCard=buildStoryClockCard;',
    ctx
  );
  const view = {
    schema: 'libra.story_clock_view.v1',
    scopeKey: 's1',
    anchorDate: '2026-04-25',
    derivedAnchorDate: '2026-04-25',
    effectiveAnchorDate: '2026-04-25',
    anchorSource: 'derived',
    corrections: { 2: { day: 2 } },
    basis: { turn: 65, day: 3, estimated: true },
    current: { asOfTurn: 65, day: 3, estimated: true },
    currentLabel: '이야기 3일째(추정)',
    entries: Array.from({ length: 65 }, (_, i) => ({ turn: i + 1, day: i === 64 ? null : 1, known: i !== 64 }))
  };
  ctx.Gui.storyClockPanel = { binding: 's1', view, loading: false, loaded: true, error: '', notice: '', selectedTurn: null };
  const card = ctx.buildCard();
  const texts = flatNodes(card).map(n => n.text).filter(Boolean);
  assert.ok(texts.includes('64턴') && texts.includes('확인 턴'), '확인 턴 card with 턴 unit present');
  assert.ok(texts.includes('1턴') && texts.includes('미확인 턴'), '미확인 턴 card with 턴 unit present');
  assert.ok(texts.includes('1건') && texts.includes('수동 정정'), '수동 정정 card with 건 unit present');
  assert.ok(!texts.includes('일차 확인 턴'), 'old 일차 확인 턴 label removed');
  assert.ok(!texts.includes('정정'), 'ambiguous standalone 정정 label removed');
});

test('Track 3: LIBRA freeze guards (empty request early return, CBS cache, single cbsDigest, skipSnapshotLoreActivation, torn-read retry)', () => {
  const libraSrc = fs.readFileSync(LIBRA_PATH, 'utf8');

  // Early return on empty requestBlocks in reuseRisuSelectedLorebooks
  const reuseSlice = slice(libraSrc, 'const reuseRisuSelectedLorebooks = (requestMessages = [], candidates = [], cbsContext = null) => {', 'const loadRisuContextSnapshot = async');
  assert.match(reuseSlice, /if\s*\(\s*!requestBlocks\.length\s*\)\s*\{\s*return\s*\{\s*activeLore:\s*\[\]/);

  // consumerSourceInventory computes single cbsDigest instead of calling cbs() per lore
  const invSlice = slice(libraSrc, 'const consumerSourceInventory = snapshot => {', 'const loadConsumerReferenceInventory =');
  assert.match(invSlice, /const cbsDigest = [\s\S]*hash\(\{\s*\.\.\.cbs,/);
  assert.ok(!/cbs\(lore\)/.test(invSlice), 'cbsDigest computed once, not per lore entry');

  // getMemoryReferencePool disables snapshot lore activation and yields cooperatively
  const poolSlice = slice(libraSrc, 'const getMemoryReferencePool = async batch => {', 'const buildAriadneReferenceContext = async');
  assert.match(poolSlice, /skipSnapshotLoreActivation:\s*true/);
  assert.match(poolSlice, /await yieldToMainThread\(\)/);

  // buildAriadneReferenceContext clones meta once & refreshSnapshot retries LIBRA_MEMORY_READER_BODY_CHANGED 3 times
  const ariadneSlice = slice(libraSrc, 'const buildAriadneReferenceContext = async batch => {', 'const buildItoLoreReferenceContext = async');
  assert.match(ariadneSlice, /const metaSnapshot = clone\(meta\)/);
  const refreshSlice = slice(libraSrc, 'const isTornSnapshotProjectionError =', 'nextSnapshot.currentStateView = clone(view);');
  assert.match(refreshSlice, /LIBRA_MEMORY_READER_BODY_CHANGED/);
  assert.match(refreshSlice, /for\s*\(let attempt = 0;\s*attempt < 3;\s*attempt \+= 1\)/);
  assert.match(refreshSlice, /setTimeout\(resolve,\s*150\)/);
});

test('Track 5: GRADIA allows previous stage analysis in lightweight mode and counts it in expectedTotalCallPlan', async () => {
  const { load } = require('./gradia/host.cjs');
  const host = await load();

  const plan = host.plugin.debugTotalCallPlan({
    multiPipelineMode: 'lightweight',
    previousStageMode: 'on',
    enableShadowAct: true
  });
  assert.equal(plan.previousCalls, 1, 'previous=on counts 1 call even in lightweight mode');
  assert.equal(plan.callsPerDraftStage, 1);
  assert.equal(plan.baseDraftCalls, 1);
  assert.equal(plan.internalLogicalCalls, 2);

  const gradiaSrc = fs.readFileSync(GRADIA_PATH, 'utf8');
  const stageModeBlock = slice(gradiaSrc, 'const MULTI_PIPELINE_MODES =', '\n  // 억결 AIDE');
  const beforeModelBody = slice(gradiaSrc, "async beforeModel(stage, phase, recovery = '') {", '\n      // A stage call that reaches its timeout');
  const ctx = vm.createContext({ Set, Object, String, Boolean, Number, Math, Array });
  vm.runInContext(
    `const normalizeChoice=(v,list,def)=>list.includes(v)?v:def;\n${stageModeBlock}\nfunction makeRun(settings){return{calls:new Set(),recoveries:new Set(),analysisRecoveries:new Set(),assertCurrent:async()=>{},fail(code){const e=new Error(code);e.code=code;return e;},canRecoverModel:()=>false,modelRecoverySet(){return new Set();},${beforeModelBody}};}\nglobalThis.makeRun=makeRun;`,
    ctx
  );
  const run = ctx.makeRun({ multiPipelineMode: 'lightweight', previousStageMode: 'on', selectedAgentIds: ['shadow_act'] });
  await run.beforeModel('previous', 'analysis');
  assert.ok(run.calls.has('previous:analysis'), 'previous:analysis permitted in lightweight + previous=on');
  await assert.rejects(
    () => run.beforeModel('tone_polisher', 'analysis'),
    err => err?.code === 'LIB_READ_RETRY_DISABLED',
    'non-previous stage analysis remains blocked in lightweight mode'
  );
});

test('Track 6: Shared Recall Budget v2 SDK, gradia_plugin_read recallBudgetChars IPC, LIBRA context cutter reserve, and GRADIA integration', async () => {
  const sdkSrc = fs.readFileSync(SDK_PATH, 'utf8');
  const sdkCtx = vm.createContext({ Math, Number, String, Boolean, Array, Object, JSON, Set, Map });
  vm.runInContext(
    sdkSrc + ';globalThis.SDK={MEMORY_SUITE_RECALL_BUDGET_PRESETS,memorySuiteNormalizeRecallBudget,memorySuiteRecallBudgetContextPolicy,memorySuiteRecallBudgetGradiaPolicy,memorySuiteRecallBudgetOwnerShares,memorySuiteRecallBudgetPresetValues,memorySuiteEstimateRecallTokens};',
    sdkCtx
  );
  const presetLabels = plain(sdkCtx.SDK.MEMORY_SUITE_RECALL_BUDGET_PRESETS).map(p => p.label);
  assert.deepStrictEqual(presetLabels, ['경량', '균형', '중량', '초중량']);
  const lightPreset = plain(sdkCtx.SDK.memorySuiteRecallBudgetPresetValues('light'));
  assert.equal(lightPreset.totalChars, 12000);
  assert.equal(lightPreset.contextCutter.maxContextTokens, 32000);
  assert.equal(lightPreset.contextCutter.trimPercent, 35);
  assert.equal(lightPreset.contextCutter.preserveMessages, 8);
  const balancedPreset = plain(sdkCtx.SDK.memorySuiteRecallBudgetPresetValues('balanced'));
  assert.equal(balancedPreset.totalChars, 24000);
  assert.equal(balancedPreset.contextCutter.maxContextTokens, 64000);
  assert.equal(balancedPreset.contextCutter.trimPercent, 30);
  assert.equal(balancedPreset.contextCutter.preserveMessages, 16);
  const heavyPreset = plain(sdkCtx.SDK.memorySuiteRecallBudgetPresetValues('heavy'));
  assert.equal(heavyPreset.totalChars, 48000);
  assert.equal(heavyPreset.contextCutter.maxContextTokens, 100000);
  assert.equal(heavyPreset.contextCutter.trimPercent, 25);
  assert.equal(heavyPreset.contextCutter.preserveMessages, 24);
  const ultraPreset = plain(sdkCtx.SDK.memorySuiteRecallBudgetPresetValues('ultra'));
  assert.equal(ultraPreset.totalChars, 72000);
  assert.equal(ultraPreset.contextCutter.maxContextTokens, 160000);
  assert.equal(ultraPreset.contextCutter.trimPercent, 20);
  assert.equal(ultraPreset.contextCutter.preserveMessages, 32);
  const maxAccepted = plain(sdkCtx.SDK.memorySuiteNormalizeRecallBudget({ enabled: true, totalChars: 120000, shares: { libra: 50, hayaku: 25, flashback: 25 } }));
  assert.equal(maxAccepted.totalChars, 120000);
  assert.throws(
    () => sdkCtx.SDK.memorySuiteNormalizeRecallBudget({ enabled: true, totalChars: 120001, shares: { libra: 50, hayaku: 25, flashback: 25 } }),
    /RECALL_BUDGET_INVALID/
  );
  const v1 = plain(sdkCtx.SDK.memorySuiteNormalizeRecallBudget({ enabled: true, totalChars: 12000, shares: { libra: 50, hayaku: 25, flashback: 25 } }));
  assert.equal(v1.version, 1);
  assert.deepStrictEqual(v1.shares, { libra: 50, hayaku: 25, flashback: 25 });

  const v2 = plain(sdkCtx.SDK.memorySuiteNormalizeRecallBudget({
    version: 2,
    enabled: true,
    totalChars: 10000,
    shares: { libra: 50, hayaku: 30, flashback: 20 },
    contextCutter: { maxContextTokens: 32000, includeGradiaReserve: true, gradiaReserveChars: 2400, triggerWithReserve: true },
    gradia: { followSharedBudget: true, redistributeDisabledOwners: true }
  }));
  assert.equal(v2.version, 2);
  assert.deepStrictEqual(plain(sdkCtx.SDK.memorySuiteRecallBudgetContextPolicy(v2)), {
    enabled: true,
    onlyMemorized: true,
    maxContextTokens: 32000,
    trimPercent: 30,
    preserveMessages: 6,
    tokenizer: 'tiktoken',
    includeGradiaReserve: true,
    gradiaReserveChars: 2400,
    triggerWithReserve: true
  });
  assert.deepStrictEqual(plain(sdkCtx.SDK.memorySuiteRecallBudgetGradiaPolicy(v2)), {
    followSharedBudget: true,
    redistributeDisabledOwners: true
  });
  const redistributed = plain(sdkCtx.SDK.memorySuiteRecallBudgetOwnerShares(v2, ['libra', 'hayaku']));
  assert.equal(redistributed.libra + redistributed.hayaku, 10000);
  assert.ok(redistributed.libra > 6000 && redistributed.hayaku > 3500, 'disabled owner share redistributed');

  // 2. gradia_plugin_read.cjs forwards valid recallBudgetChars over plugin IPC and omits invalid values
  const createGradiaPluginRead = require(IPC_READ_PATH);
  const listeners = new Map();
  const makeBus = senderId => ({
    addPluginChannelListener(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
    },
    postPluginChannelMessage(_targetPluginId, channel, payload) {
      for (const fn of listeners.get(channel) || []) Promise.resolve().then(() => fn(payload, { sender: senderId }));
    }
  });
  const primitives = {
    fingerprint: s => String(s).length + ':' + String(s).slice(0, 8),
    byteLength: s => Buffer.byteLength(String(s || ''), 'utf8')
  };
  let receivedBudget = 'unset';
  const scope = { scopeKey: 'c1:h1', characterId: 'c1', chatId: 'h1' };
  const owner = createGradiaPluginRead({
    role: 'owner',
    owner: 'libra',
    primitives,
    api: () => makeBus('libra'),
    boundary: async () => ({ scope, mode: 'plugin_only' }),
    select: async (_q, _check, hints) => {
      receivedBudget = Object.prototype.hasOwnProperty.call(hints || {}, 'recallBudgetChars') ? hints.recallBudgetChars : null;
      return { content: 'selected_ok' };
    }
  });
  await owner.start();
  const client = createGradiaPluginRead({ role: 'client', owner: 'gradia', primitives, api: () => makeBus('serial_gradation_agents_for_rp') });
  const res = await client.select('libra', scope, 'hello', undefined, { recallBudgetChars: 3456 });
  assert.equal(res.content, 'selected_ok');
  assert.equal(receivedBudget, 3456, 'owner handler receives exact recallBudgetChars');
  await assert.rejects(
    () => client.select('libra', scope, 'hello', undefined, { recallBudgetChars: -10 }),
    err => err?.code === 'LIB_READ_REQUEST_INVALID',
    'invalid negative recallBudgetChars rejected by owner IPC handler'
  );
  await owner.dispose();
  await client.dispose();

  // 3. LIBRA computeContextCutterRecallReserve v2 reserve + triggerWithReserve calculation
  const libraSrc = fs.readFileSync(LIBRA_PATH, 'utf8');
  const reserveSlice = slice(libraSrc, "const computeContextCutterRecallReserve = (settings, tokenizerName = 'tiktoken', maxContext = 40000) => {", 'const normalizeContextCutterState =');
  const libraCtx = vm.createContext({
    CONTEXT_CUTTER_PROFILES: { tiktoken: { latinCharsPerToken: 4.0, cjkCharsPerToken: 1.5, overhead: 4 } },
    CONTEXT_CUTTER_TOKEN_MULTIPLIER: 1.15,
    UNIFIED_CLASSIC_HEADER: '[LIBRA MEMORY]',
    UNIFIED_CLASSIC_FOOTER: '[/LIBRA MEMORY]',
    RECALL_MAX_DYNAMIC_CHARS: 9000,
    memorySuiteRecallBudget: () => v2,
    memorySuiteRecallBudgetContextPolicy: sdkCtx.SDK.memorySuiteRecallBudgetContextPolicy,
    clamp: (val, lo, hi, def) => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    },
    Math, Number
  });
  vm.runInContext(reserveSlice + ';globalThis.computeReserve = computeContextCutterRecallReserve;', libraCtx);
  const reserve = libraCtx.computeReserve({ contextCutterTrimPercent: 25 }, 'tiktoken', 40000);
  assert.equal(reserve.source, 'shared_recall_budget');
  assert.equal(reserve.effectiveMaxContext, 32000);
  assert.equal(reserve.triggerWithReserve, true);
  assert.equal(reserve.triggerTokens, 32000 - reserve.reserveTokens);
  assert.ok(reserve.gradiaReserveTokens > 0 && reserve.reserveTokens > reserve.recallReserveTokens);

  // 4. GRADIA gradiaSharedRecallPlan, libEvidenceBudget & GUI hooks
  const gradiaSrc = fs.readFileSync(GRADIA_PATH, 'utf8').replace(
    '  const publicApi = Object.freeze({',
    '  globalThis.__testTrack6 = { gradiaSharedRecallPlan, libEvidenceBudget, getGradiaSourceInput };\n  const publicApi = Object.freeze({'
  );
  const store = new Map();
  const gradiaCtx = vm.createContext({
    risuai: {
      getArgument: async () => undefined, setArgument: async () => {},
      pluginStorage: { getItem: async k => store.get(k), setItem: async (k, val) => store.set(k, val), removeItem: async k => store.delete(k) },
      getLocalPluginStorage: async () => gradiaCtx.risuai.pluginStorage,
      addRisuReplacer: async () => {}, addRisuScriptHandler: async () => {},
      requestPluginPermission: async () => true, onUnload: async () => {},
      getCharacter: async () => null, getDatabase: async () => ({ characters: [] }),
      getChatFromIndex: async () => null, getCurrentCharacterIndex: async () => -1, getCurrentChatIndex: async () => -1,
      fetch: async () => { throw new Error('no network'); }
    },
    console: { log() {}, warn() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, AbortController, structuredClone
  });
  gradiaCtx.risuai.nativeFetch = gradiaCtx.risuai.fetch;
  await vm.runInContext(gradiaSrc, gradiaCtx, { timeout: 10000 });
  const pol = gradiaCtx.__testTrack6.getGradiaSourceInput();
  await pol.ready();
  await pol.setRecallBudget(v2);
  const gradiaPlan = gradiaCtx.__testTrack6.gradiaSharedRecallPlan({ quickProfile: 'balanced' }, ['libra', 'hayaku']);
  assert.equal(gradiaPlan.enabled, true);
  assert.equal(gradiaPlan.contentTotalChars, 10000);
  assert.equal(gradiaPlan.redistributed, true);
  assert.ok(gradiaPlan.ownerShares.libra > 6000, 'gradiaSharedRecallPlan redistributes disabled flashback share to libra');
  const libBudget = gradiaCtx.__testTrack6.libEvidenceBudget({ quickProfile: 'balanced' });
  assert.equal(libBudget.source, 'memory_suite_shared');
  assert.equal(libBudget.ownerShares.libra, 5000);
  assert.equal(libBudget.ownerShares.hayaku, 3000);
  assert.equal(libBudget.ownerShares.flashback, 2000);
  assert.match(gradiaSrc, /data-gradia-recall-budget-card/);
  assert.match(gradiaSrc, /기억 상한 \(자 · 공통 예산 우선\)/);
});

test('LIBRA Settings Room renders 기억과 검색 cleanly with Shared Recall Budget OFF, v1 ON, v2 ON, and pipeline/logs tabs', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  win.scrollTo = () => {};
  const store = new Map();
  const api = {
    getArgument: async () => undefined,
    setArgument: async () => {},
    pluginStorage: { getItem: async k => store.get(k), setItem: async (k, v) => store.set(k, v), removeItem: async k => store.delete(k) },
    getLocalPluginStorage: async () => api.pluginStorage,
    addRisuReplacer: async () => {},
    addRisuScriptHandler: async () => {},
    addPluginChannelListener: async () => true,
    postPluginChannelMessage: async () => {},
    requestPluginPermission: async () => true,
    onUnload: async () => {},
    getCharacter: async () => ({ chaId: 'c1', name: 'Test', chats: [{ id: 'h1', message: [] }] }),
    getDatabase: async () => ({ characters: [{ chaId: 'c1', name: 'Test', chats: [{ id: 'h1', message: [] }] }], personas: [], modules: [] }),
    getChatFromIndex: async () => ({ id: 'h1', message: [] }),
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    registerSetting: async () => {},
    risuFetch: async () => ({ ok: false }),
    nativeFetch: async () => ({ ok: false }),
    fetch: async () => ({ ok: false })
  };
  win.risuai = api;
  const ctx = vm.createContext({
    window: win, document: win.document, Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node,
    Event: win.Event, CustomEvent: win.CustomEvent, MutationObserver: win.MutationObserver,
    DOMParser: win.DOMParser, localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    queueMicrotask, performance,
    risuai: api, Risuai: api,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, AbortController, structuredClone, fetch: api.fetch
  });
  let libraSrc = fs.readFileSync(LIBRA_PATH, 'utf8');
  libraSrc = libraSrc.replace(
    'async function renderSettingsGuiOnce() {',
    'globalThis.__testSettingsGui = { Gui, LibraMemoryCore, renderSettingsGui, selectBookSettingsRoomSection, hideSettingsGui: () => hideSettingsGui() };\n  async function renderSettingsGuiOnce() {'
  );
  await vm.runInContext(libraSrc, ctx, { timeout: 10000 });
  const g = ctx.__testSettingsGui;
  await g.LibraMemoryCore.readySourceRules();
  g.Gui.visible = true;
  g.Gui.root = win.document.createElement('div');
  win.document.body.appendChild(g.Gui.root);

  try {
    // 1. Shared Recall Budget OFF
    await g.LibraMemoryCore.setMemorySuiteRecallBudget({ version: 1, enabled: false, totalChars: 16000, shares: { libra: 50, hayaku: 25, flashback: 25 } });
    g.Gui.bookPage = 'settings';
    g.Gui.bookSettingsWorkbenchSection = 'settings';
    g.Gui.settingsHubSection = 'memory';
    assert.equal(await g.renderSettingsGui(), true);
    assert.ok(g.Gui.root.querySelector('.settings-layout'));
    assert.ok(g.Gui.root.querySelector('#libraRecallBudgetCard'));
    assert.ok(g.Gui.root.querySelector('[data-recall-budget]'));
    assert.ok(g.Gui.root.querySelector('[data-recall-budget-presets]'));
    assert.deepStrictEqual(
      [...g.Gui.root.querySelectorAll('[data-recall-budget-preset]')].map(n => n.dataset.recallBudgetPreset),
      ['light', 'balanced', 'heavy', 'ultra']
    );
    assert.ok(g.Gui.root.querySelector('[data-recall-budget-context]'));
    assert.match(g.Gui.root.querySelector('[data-recall-budget-libra-badge]')?.textContent || '', /LIBRA 실행 중/);
    assert.ok(g.Gui.root.querySelector('[data-context-cutter-reset]'));
    assert.equal(g.Gui.root.querySelector('[data-context-cutter-settings]'), null, 'standalone duplicate context cutter card removed');
    assert.ok(!g.Gui.root.querySelector('[data-settings-panel-error]'));

    // 2. Shared Recall Budget v1 ON
    await g.LibraMemoryCore.setMemorySuiteRecallBudget({ version: 1, enabled: true, totalChars: 12000, shares: { libra: 50, hayaku: 25, flashback: 25 } });
    assert.equal(await g.renderSettingsGui(), true);
    const v1Summary = g.Gui.root.querySelector('[data-recall-budget-presets] [data-recall-budget-summary]')?.textContent || '';
    assert.match(v1Summary, /기억 주입 공통 예산 사용 중:\s*LIBRA 몫\s*6,000자/);

    // 3. Shared Recall Budget v2 ON
    await g.LibraMemoryCore.setMemorySuiteRecallBudget({
      version: 2, enabled: true, totalChars: 12000, shares: { libra: 50, hayaku: 25, flashback: 25 },
      contextCutter: { maxContextTokens: 32000, trimPercent: 25, preserveMessages: 8, tokenizer: 'claude', includeGradiaReserve: true, gradiaReserveChars: 'auto', triggerWithReserve: true },
      gradia: { followSharedBudget: true, redistributeDisabledOwners: true }
    });
    g.Gui.recallBudgetPanel = null;
    g.Gui.recallBudgetPanelKey = '';
    assert.equal(await g.renderSettingsGui(), true);
    assert.ok(g.Gui.root.querySelector('.settings-layout'));
    assert.ok(g.Gui.root.querySelector('#libraRecallBudgetCard'));
    assert.ok(g.Gui.root.querySelector('[data-recall-budget]'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(g.Gui.root.querySelector('[data-recall-budget-max-context]')?.value, '32000');
    assert.match(g.Gui.root.querySelector('[data-recall-budget-breakdown]')?.textContent || '', /32,000 토큰 \(claude\)/);
    const v2Summary = g.Gui.root.querySelector('[data-recall-budget-presets] [data-recall-budget-summary]')?.textContent || '';
    assert.match(v2Summary, /기억 주입 공통 예산 사용 중:\s*LIBRA 몫\s*6,000자/);

    // 4. Switching to pipeline & logs tabs under 기억과 검색
    for (const sec of ['pipeline', 'logs']) {
      g.Gui.bookSettingsWorkbenchSection = 'settings';
      g.Gui.settingsHubSection = sec;
      assert.equal(await g.renderSettingsGui(), true);
      assert.ok(g.Gui.root.querySelector('.settings-layout'));
      assert.ok(!g.Gui.root.querySelector('[data-settings-panel-error]'));
    }
  } finally {
    g.Gui.visible = false;
    await g.hideSettingsGui().catch(() => {});
    dom.window.close();
  }
});

test('Unified Budget Panel: HAYAKU placement in 설정->기억 선택, 리브라 미감지 disable, and preset IPC sync to LIBRA', async () => {
  const { JSDOM } = require('jsdom');
  const waitFor = async (fn, limit = 6000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > limit) throw new Error('wait_timeout');
      await new Promise(r => setTimeout(r, 20));
    }
  };

  // 1. HAYAKU UI placement check + 리브라 미감지 when LIBRA is absent
  const hayakuDom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const hWin = hayakuDom.window;
  const hStore = new Map();
  const hListeners = new Map();
  const hApi = {
    getArgument: async () => undefined,
    setArgument: async () => {},
    pluginStorage: { getItem: async k => hStore.get(k), setItem: async (k, v) => hStore.set(k, v), removeItem: async k => hStore.delete(k) },
    getLocalPluginStorage: async () => hApi.pluginStorage,
    addRisuReplacer: async () => {},
    addRisuScriptHandler: async () => {},
    addPluginChannelListener: async (ch, fn) => {
      if (!hListeners.has(ch)) hListeners.set(ch, []);
      hListeners.get(ch).push(fn);
      return true;
    },
    postPluginChannelMessage: async () => {},
    requestPluginPermission: async () => true,
    onUnload: async () => {},
    getCharacter: async () => ({ chaId: 'c1', name: 'Test', chats: [{ id: 'h1', message: [] }] }),
    getDatabase: async () => ({ characters: [{ chaId: 'c1', name: 'Test', chats: [{ id: 'h1', message: [] }] }], personas: [], modules: [] }),
    getChatFromIndex: async () => ({ id: 'h1', message: [] }),
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    fetch: async () => ({ ok: false })
  };
  hApi.nativeFetch = hApi.fetch;
  hWin.risuai = hApi;
  const hCtx = vm.createContext({
    window: hWin, document: hWin.document, Element: hWin.Element, HTMLElement: hWin.HTMLElement, Node: hWin.Node,
    Event: hWin.Event, CustomEvent: hWin.CustomEvent, MutationObserver: hWin.MutationObserver,
    DOMParser: hWin.DOMParser, localStorage: hWin.localStorage, sessionStorage: hWin.sessionStorage,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    queueMicrotask, performance, risuai: hApi, Risuai: hApi,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, AbortController, structuredClone, fetch: hApi.fetch
  });
  let hayakuSrc = fs.readFileSync(HAYAKU_PATH, 'utf8').replace(
    'const HAYAKU_GUI_SETTING_SPECS =',
    'globalThis.__testHayakuUi={getSettingsHtml:()=>HAYAKU_MOCKUP_SETTINGS_PAGE,mountHayakuSourceInput,mountHayakuRecallBudgetPanel,getHayakuSourceRuleSync};\n  const HAYAKU_GUI_SETTING_SPECS ='
  );
  await vm.runInContext(hayakuSrc, hCtx, { timeout: 10000 });
  const hUi = hCtx.__testHayakuUi;
  const hRoot = hWin.document.createElement('div');
  hRoot.innerHTML = `<section id="hayakuSourceTrackingSettings"></section>${hUi.getSettingsHtml()}`;
  hWin.document.body.appendChild(hRoot);
  hUi.mountHayakuSourceInput(hRoot.querySelector('#hayakuSourceTrackingSettings'));
  hUi.mountHayakuRecallBudgetPanel(hRoot.querySelector('#hayakuRecallBudgetHost'));

  assert.equal(hRoot.querySelector('#hayakuSourceTrackingSettings [data-recall-budget]'), null, '원문 태그 필터 must not render recall budget');
  assert.ok(hRoot.querySelector('[data-hayaku-settings-section="pick"] #hayakuRecallBudgetHost [data-recall-budget]'), '기억 선택 must render unified budget panel');

  await waitFor(() => hRoot.querySelector('[data-recall-budget-context]')?.dataset.libraStatus === 'absent');
  assert.match(hRoot.querySelector('[data-recall-budget-libra-badge]')?.textContent || '', /리브라 미감지/);
  assert.equal(hRoot.querySelector('[data-recall-budget-cutter-enabled]')?.disabled, true);
  assert.equal(hRoot.querySelector('[data-recall-budget-max-context]')?.disabled, true);
  assert.equal(hRoot.querySelector('[data-recall-budget-trim-percent]')?.disabled, true);
  assert.equal(hRoot.querySelector('[data-recall-budget-gradia-follow]')?.disabled, false);
  hayakuDom.window.close();

  // 2. Shared IPC bus with LIBRA present: HAYAKU applies preset 중량 and syncs Context Cutter to LIBRA
  const controlsSrc = fs.readFileSync(path.join(ROOT, 'sdk', 'MemorySuiteSourceInputControls.source.js'), 'utf8');
  const sharedBusDom = new JSDOM('<!doctype html><html><body><div id="hayaku"></div><div id="libra"></div></body></html>', { url: 'http://localhost/' });
  const bWin = sharedBusDom.window;
  const stores = { libra: new Map(), hayaku: new Map() };
  const channelHandlers = { libra: new Map(), hayaku: new Map() };
  const pluginIdMap = { libra: 'libra', hayaku_locator_continuity: 'hayaku' };
  const makeBusApi = selfOwner => ({
    pluginStorage: {
      getItem: async k => stores[selfOwner].get(k),
      setItem: async (k, v) => stores[selfOwner].set(k, v),
      removeItem: async k => stores[selfOwner].delete(k)
    },
    addPluginChannelListener: async (ch, fn) => {
      if (!channelHandlers[selfOwner].has(ch)) channelHandlers[selfOwner].set(ch, []);
      channelHandlers[selfOwner].get(ch).push(fn);
      return true;
    },
    postPluginChannelMessage: async (targetPluginId, ch, payload) => {
      const targetOwner = pluginIdMap[targetPluginId];
      if (!targetOwner) return;
      const senderPluginId = selfOwner === 'libra' ? 'libra' : 'hayaku_locator_continuity';
      for (const fn of channelHandlers[targetOwner].get(ch) || []) {
        Promise.resolve().then(() => fn(payload, { sender: senderPluginId }));
      }
    }
  });
  const sdkInputSrc = fs.readFileSync(SDK_PATH, 'utf8');
  const bCtx = vm.createContext({
    window: bWin, document: bWin.document, Element: bWin.Element, HTMLElement: bWin.HTMLElement, Node: bWin.Node,
    Event: bWin.Event, Math, Number, String, Boolean, Array, Object, JSON, Set, Map, Promise, setTimeout, clearTimeout
  });
  vm.runInContext(`${sdkInputSrc}\n${controlsSrc}\nglobalThis.SDK={createMemorySuiteSourceInputPolicy,createMemorySuiteSourceRuleSync,mountMemorySuiteRecallBudgetPanel};`, bCtx);

  let syncedLibraCutter = null;
  const makePolicy = owner => bCtx.SDK.createMemorySuiteSourceInputPolicy({
    owner,
    read: async () => stores[owner].get('src') ? JSON.parse(stores[owner].get('src')) : null,
    write: async body => { stores[owner].set('src', body); },
    busy: () => false
  });
  const libraPolicy = makePolicy('libra');
  const hayakuPolicy = makePolicy('hayaku');
  const libraSync = bCtx.SDK.createMemorySuiteSourceRuleSync({ owner: 'libra', policy: libraPolicy, isDisposed: () => false, api: () => makeBusApi('libra') });
  const hayakuSync = bCtx.SDK.createMemorySuiteSourceRuleSync({ owner: 'hayaku', policy: hayakuPolicy, isDisposed: () => false, api: () => makeBusApi('hayaku') });
  libraSync.subscribeBudget(() => {
    const b = libraPolicy.recallBudget();
    if (b?.version === 2) syncedLibraCutter = b.contextCutter;
  });
  await Promise.all([libraPolicy.ready(), hayakuPolicy.ready(), libraSync.start(), hayakuSync.start()]);

  const hPanel = bCtx.SDK.mountMemorySuiteRecallBudgetPanel(bWin.document.getElementById('hayaku'), {
    owner: 'hayaku',
    policy: hayakuPolicy,
    sync: hayakuSync,
    isDisposed: () => false,
    getPreserveMismatchWarning: (_draftBudget, ctx) => {
      const preserve = Number(ctx?.preserveMessages || 0);
      return 16 > preserve ? `최근 턴 창(16메시지)이 LIBRA 보존 기준(${preserve}메시지)보다 큽니다.` : '';
    }
  });
  hPanel.load();
  await waitFor(() => bWin.document.querySelector('#hayaku [data-recall-budget-context]')?.dataset.libraStatus === 'connected');
  assert.match(bWin.document.querySelector('#hayaku [data-recall-budget-libra-badge]')?.textContent || '', /LIBRA 연동됨/);
  assert.equal(bWin.document.querySelector('#hayaku [data-recall-budget-max-context]')?.disabled, false);

  bWin.document.querySelector('#hayaku [data-recall-budget-preset="light"]').click();
  const warnEl = bWin.document.querySelector('#hayaku [data-recall-budget-warning]');
  assert.equal(warnEl?.hidden, false);
  assert.match(warnEl?.textContent || '', /8메시지/);
  bWin.document.querySelector('#hayaku [data-recall-budget-preset="balanced"]').click();
  assert.equal(warnEl?.hidden, true);
  assert.equal(warnEl?.textContent || '', '');

  bWin.document.querySelector('#hayaku [data-recall-budget-preset="heavy"]').click();
  assert.equal(bWin.document.querySelector('#hayaku [data-recall-budget-total]')?.value, '48000');
  assert.equal(bWin.document.querySelector('#hayaku [data-recall-budget-max-context]')?.value, '100000');
  await bWin.document.querySelector('#hayaku [data-recall-budget-apply]').onclick();
  await waitFor(() => syncedLibraCutter && syncedLibraCutter.maxContextTokens === 100000);
  assert.equal(syncedLibraCutter.trimPercent, 25);
  assert.equal(syncedLibraCutter.preserveMessages, 24);
  assert.equal(libraPolicy.recallBudget().totalChars, 48000);
  await libraSync.dispose();
  await hayakuSync.dispose();
  sharedBusDom.window.close();
});
