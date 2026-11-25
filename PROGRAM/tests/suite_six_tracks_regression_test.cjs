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
  assert.equal(reserve.targetTokens, Math.max(Math.floor(reserve.triggerTokens * 0.2), Math.floor(reserve.triggerTokens * (1 - 0.30))));
  assert.ok(reserve.triggerTokens - reserve.targetTokens >= Math.floor(reserve.triggerTokens * 0.25), 'v2 triggerWithReserve preserves staircase drop gap');

  // 3b. Staircase drop gap across balanced / heavy / ultra presets (never collapsing near 0)
  for (const presetId of ['balanced', 'heavy', 'ultra']) {
    const presetBudget = sdkCtx.SDK.memorySuiteRecallBudgetPresetValues(presetId, v2);
    const presetCtx = vm.createContext({
      CONTEXT_CUTTER_PROFILES: { tiktoken: { latinCharsPerToken: 4.0, cjkCharsPerToken: 1.5, overhead: 4 } },
      CONTEXT_CUTTER_TOKEN_MULTIPLIER: 1.15,
      UNIFIED_CLASSIC_HEADER: '[LIBRA MEMORY]',
      UNIFIED_CLASSIC_FOOTER: '[/LIBRA MEMORY]',
      RECALL_MAX_DYNAMIC_CHARS: 9000,
      memorySuiteRecallBudget: () => presetBudget,
      memorySuiteRecallBudgetContextPolicy: sdkCtx.SDK.memorySuiteRecallBudgetContextPolicy,
      clamp: (val, lo, hi, def) => {
        const n = Number(val);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
      },
      Math, Number
    });
    vm.runInContext(reserveSlice + ';globalThis.computeReserve = computeContextCutterRecallReserve;', presetCtx);
    const pr = presetCtx.computeReserve({}, 'tiktoken', 40000);
    const expectedTarget = Math.max(
      Math.floor(pr.triggerTokens * 0.2),
      Math.floor(pr.triggerTokens * (1 - presetBudget.contextCutter.trimPercent / 100))
    );
    assert.equal(pr.targetTokens, expectedTarget, `${presetId} preset keeps full trimPercent staircase drop`);
    assert.ok(pr.triggerTokens - pr.targetTokens >= Math.floor(pr.triggerTokens * 0.18), `${presetId} staircase gap is substantial`);
  }

  // 3c. applyLibraContextCutter batch-deferral vs commit gate
  const cutterSlice = slice(libraSrc, 'const CONTEXT_CUTTER_SCHEMA =', 'let latestRecallPublicationOwner = null;');
  const cutterBudget = sdkCtx.SDK.memorySuiteNormalizeRecallBudget({
    version: 2,
    enabled: true,
    totalChars: 12000,
    shares: { libra: 50, hayaku: 25, flashback: 25 },
    contextCutter: {
      enabled: true,
      onlyMemorized: true,
      maxContextTokens: 8000,
      trimPercent: 30,
      preserveMessages: 2,
      tokenizer: 'tiktoken',
      includeGradiaReserve: true,
      gradiaReserveChars: 2400,
      triggerWithReserve: true
    }
  });
  const cutterStateObj = { contextCutterStates: new Map() };
  const cutterCtx = vm.createContext({
    UNIFIED_CLASSIC_HEADER: '[LIBRA MEMORY]',
    UNIFIED_CLASSIC_FOOTER: '[/LIBRA MEMORY]',
    RECALL_MAX_DYNAMIC_CHARS: 9000,
    memorySuiteRecallBudget: () => cutterBudget,
    memorySuiteRecallBudgetContextPolicy: sdkCtx.SDK.memorySuiteRecallBudgetContextPolicy,
    clamp: (val, lo, hi, def) => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    },
    normalizeChoice: (val, allowed, def) => {
      const s = String(val || '').trim().toLowerCase();
      return allowed.includes(s) ? s : def;
    },
    string: val => (val == null ? '' : String(val)),
    asArray: val => (Array.isArray(val) ? val : []),
    clone: val => JSON.parse(JSON.stringify(val)),
    isPlainObject: val => Boolean(val && typeof val === 'object' && !Array.isArray(val)),
    contentToText: val => (typeof val === 'string' ? val : ''),
    nowIso: () => '2026-11-26T00:00:00.000Z',
    listCurrentMemoryRefs: () => [{ turnRange: { start: 1, end: 1 } }],
    state: cutterStateObj,
    storage: { getJson: async () => null, setJson: async () => {} },
    key: { contextCutter: s => `ctx:${s.scopeKey}` },
    Math, Number, Set, Map, Array, Object, String, RegExp
  });
  vm.runInContext(cutterSlice + ';globalThis.applyCutter = applyLibraContextCutter;globalThis.computeReserve = computeContextCutterRecallReserve;', cutterCtx);
  const mkUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cutterScope = { scopeKey: 'test_scope_batch' };
  const cutterReserve = cutterCtx.computeReserve({}, 'tiktoken', 8000);
  assert.ok(cutterReserve.triggerTokens < cutterReserve.effectiveMaxContext);
  // Build 4 turns (8 messages): turn 1 is small & memorized, turns 2-3 are unmemorized, turn 4 is protected latest
  const msgsSmallMem = [
    { role: 'user', memo: mkUuid(1), content: 'a'.repeat(400) },
    { role: 'assistant', memo: mkUuid(2), content: 'b'.repeat(400) },
    { role: 'user', memo: mkUuid(3), content: 'c'.repeat(5500) },
    { role: 'assistant', memo: mkUuid(4), content: 'd'.repeat(5500) },
    { role: 'user', memo: mkUuid(5), content: 'e'.repeat(5500) },
    { role: 'assistant', memo: mkUuid(6), content: 'f'.repeat(5500) },
    { role: 'user', memo: mkUuid(7), content: 'g'.repeat(1200) },
    { role: 'assistant', memo: mkUuid(8), content: 'h'.repeat(1200) }
  ];
  const pairsForCutter = [
    { turn: 1, user: { chatId: mkUuid(1) }, assistant: { chatId: mkUuid(2) } },
    { turn: 2, user: { chatId: mkUuid(3) }, assistant: { chatId: mkUuid(4) } },
    { turn: 3, user: { chatId: mkUuid(5) }, assistant: { chatId: mkUuid(6) } },
    { turn: 4, user: { chatId: mkUuid(7) }, assistant: { chatId: mkUuid(8) } }
  ];
  // Case 1: triggerTokens < currentTokens <= effectiveMaxContext, but memorized turn 1 is <50% of desired trim -> defer!
  const deferredKept = await cutterCtx.applyCutter(msgsSmallMem, {
    context: { scope: cutterScope },
    settings: {},
    completedPairs: pairsForCutter,
    requestManifest: { mocked: true },
    receiptSet: { requestedTurns: [1] }
  });
  const deferredState = cutterStateObj.contextCutterStates.get('test_scope_batch');
  assert.ok(deferredState.estimatedTokensBefore > cutterReserve.triggerTokens && deferredState.estimatedTokensBefore <= cutterReserve.effectiveMaxContext);
  assert.equal(deferredKept.length, msgsSmallMem.length, 'small partial memorized trim is deferred inside reserve cushion');
  assert.equal(deferredState.trimmedThisTurn, false);
  assert.equal(deferredState.deferredForCacheBatch, true);

  // Case 2: currentTokens > effectiveMaxContext (hard ceiling exceeded) -> commit trim immediately
  const msgsHardCeiling = msgsSmallMem.map((m, idx) => idx === 2 ? { ...m, content: 'c'.repeat(24000) } : m);
  const committedKept = await cutterCtx.applyCutter(msgsHardCeiling, {
    context: { scope: cutterScope },
    settings: {},
    completedPairs: pairsForCutter,
    requestManifest: { mocked: true },
    receiptSet: { requestedTurns: [1] }
  });
  const committedState = cutterStateObj.contextCutterStates.get('test_scope_batch');
  assert.ok(committedState.estimatedTokensBefore > cutterReserve.effectiveMaxContext);
  assert.equal(committedKept.length, msgsHardCeiling.length - 2, 'hard ceiling commits available memorized trim');
  assert.equal(committedState.trimmedThisTurn, true);
  assert.equal(committedState.deferredForCacheBatch, false);

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

test('LIBRA Librarian freeze fix: loreJaccardSoftWeighted parity, passage/material speed + cooperative yields, and basis/candidate yielding', async () => {
  const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
  const libraSrc = fs.readFileSync(LIBRA_PATH, 'utf8');
  const tuningSrc = slice(libraSrc, 'const LORE_JACCARD_TUNING = Object.freeze({', '});') + '});';
  const stopSrc = slice(libraSrc, 'const LIBRA_CONTINUITY_ENTITY_STOP = new Set([', ']);') + ']);';
  const yieldSrc = slice(libraSrc, 'const yieldToMainThread = () =>', 'const ragCbsRenderCache =');
  const jacSrc = slice(libraSrc, 'const loreJaccardUnique =', 'const responseLoreStoryArcQuery =');

  let yieldCount = 0;
  const ctx = vm.createContext({
    console, Math, Date, JSON, RegExp, Map, Set, WeakMap, Array, Object, String, Number, Boolean, Error, Promise, Uint8Array,
    setTimeout: (fn, ms) => { yieldCount += 1; return globalThis.setTimeout(fn, ms); },
    text: v => (v == null ? '' : String(v)),
    compact: (v, n) => String(v || '').slice(0, n),
    compactMiddle: (v, n) => String(v || '').slice(0, n),
    clampInt: (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; },
    clampNumber: (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; },
    asArray: v => (Array.isArray(v) ? v : []),
    RESPONSE_LORE_PASSAGE_WHOLE_CHARS: 1600,
    RESPONSE_LORE_PASSAGE_TARGET_CHARS: 1100,
    RESPONSE_LORE_PASSAGE_OVERLAP_CHARS: 220,
    RESPONSE_LORE_MAX_PASSAGES_PER_ITEM: 3,
    RESPONSE_LORE_PASSAGE_VERSION: 'v1',
    RESPONSE_LORE_RRF_K: 40,
    RESPONSE_LORE_RRF_VERSION: 'v1',
    RESPONSE_LORE_MMR_LAMBDA: 0.72,
    RESPONSE_LORE_MMR_VERSION: 'v1',
    RESPONSE_LORE_STAGE_DEFS: { shared: { label: 'Shared', domainQuery: '' } },
    MIN_RESPONSE_LORE_START_COUNT: 2,
    MAX_RESPONSE_LORE_ITEMS: 15,
    DEFAULT_RESPONSE_LORE_START_COUNT: 4,
    DEFAULT_RESPONSE_LORE_MAX_ITEMS: 12,
    MIN_RESPONSE_LORE_CHARS: 800,
    MAX_RESPONSE_LORE_CHARS: 20000,
    DEFAULT_RESPONSE_LORE_MAX_CHARS: 6000,
    RESPONSE_LORE_ENGINE_VERSION: 'v1',
    RESPONSE_LORE_STAGE_SCHEMA: 'v1',
    stableDraftHash: s => String(String(s || '').length),
    renderRagCbsText: s => s
  });
  vm.runInContext(
    `${tuningSrc}\n${stopSrc}\n${yieldSrc}\n${jacSrc}\nglobalThis.api = { loreJaccardUnique, loreJaccardNormalizeKey, loreJaccardTokens, loreJaccardTokenWeight, loreJaccardTokenSimilarity, loreJaccardSoftWeighted, loreJaccardScoreText, responseLoreBuildPassageEvidence, createFrameYielder };`,
    ctx
  );

  // 1. Exact numerical parity against independent pairwise loreJaccardTokenSimilarity reference
  const refSoftWeighted = (leftTokens = [], rightTokens = []) => {
    const left = ctx.api.loreJaccardUnique(leftTokens, 180);
    const right = ctx.api.loreJaccardUnique(rightTokens, 300);
    if (!left.length || !right.length) return { jaccard: 0, coverage: 0, overlap: 0, overlapWeight: 0 };
    let leftWeight = 0, rightWeight = 0, overlapWeight = 0, overlap = 0;
    const used = new Set();
    left.forEach(leftToken => {
      const weight = ctx.api.loreJaccardTokenWeight(leftToken);
      leftWeight += weight;
      let bestIndex = -1, bestSimilarity = 0, bestWeight = 0;
      right.forEach((rightToken, index) => {
        if (used.has(index)) return;
        const similarity = ctx.api.loreJaccardTokenSimilarity(leftToken, rightToken);
        if (similarity > bestSimilarity) {
          bestIndex = index; bestSimilarity = similarity; bestWeight = ctx.api.loreJaccardTokenWeight(rightToken);
        }
      });
      if (bestIndex >= 0 && bestSimilarity >= 0.56) {
        used.add(bestIndex); overlap += 1; overlapWeight += Math.min(weight, bestWeight) * bestSimilarity;
      }
    });
    right.forEach(token => { rightWeight += ctx.api.loreJaccardTokenWeight(token); });
    const unionWeight = leftWeight + rightWeight - overlapWeight;
    return { jaccard: unionWeight > 0 ? overlapWeight / unionWeight : 0, coverage: leftWeight > 0 ? overlapWeight / leftWeight : 0, overlap, overlapWeight };
  };

  const pairs = [
    [
      ['archive', 'ribbon', 'lanterns', '기록', '천소연', 'cafeteria', 'zzzzq'],
      ['archive', 'ribbons', 'lantern', '기록이', '소연', 'cafe', 'unrelated']
    ],
    [
      ctx.api.loreJaccardTokens('허리의 움직임은 더욱 격해지고 사정이 가까워졌다 Alice opened the archive door near lantern corridor', 180),
      ctx.api.loreJaccardTokens('그룹공통교육파트 천소연 천하연 지원 푸딩 여행동아리 모텔 복도 대화 archive ribbons lanterns winter market', 360)
    ]
  ];
  for (const [lTok, rTok] of pairs) {
    const expected = refSoftWeighted(lTok, rTok);
    const actual = plain(ctx.api.loreJaccardSoftWeighted(lTok, rTok));
    assert.equal(actual.overlap, expected.overlap, 'overlap count must match reference exactly');
    assert.ok(Math.abs(actual.jaccard - expected.jaccard) < 1e-12, `jaccard parity: ${actual.jaccard} vs ${expected.jaccard}`);
    assert.ok(Math.abs(actual.coverage - expected.coverage) < 1e-12, `coverage parity: ${actual.coverage} vs ${expected.coverage}`);
    assert.ok(Math.abs(actual.overlapWeight - expected.overlapWeight) < 1e-12, `overlapWeight parity: ${actual.overlapWeight} vs ${expected.overlapWeight}`);
  }

  // 2. Large 24KB passage scoring completes quickly (<1000ms vs >5000ms prior) and yields cooperatively
  const bigLore = Array.from({ length: 48 }, (_, i) =>
    `### Section ${i + 1}\n천소연과 천하연이 그룹공통교육파트 여행동아리 합숙 ${i}일차에 모텔 복도와 객실에서 나눈 대화와 기록. archive ribbon lantern corridor ${i}.`
  ).join('\n\n');
  assert.ok(bigLore.length >= 4000);
  const hugeLore = bigLore.repeat(5); // ~24KB+
  const bigQuery = '허리의 움직임은 더욱 격해지고 천소연 천하연 지원 푸딩 그룹공통교육파트 archive lantern '.repeat(35);
  yieldCount = 0;
  const t0 = Date.now();
  const passage = await ctx.api.responseLoreBuildPassageEvidence(hugeLore, bigQuery, 2600, true, ctx.api.createFrameYielder(0));
  const elapsedPassageMs = Date.now() - t0;
  assert.ok(passage.passages.length > 0, 'passage evidence selected');
  assert.ok(elapsedPassageMs < 1000, `24KB passage evidence must run < 1000ms (got ${elapsedPassageMs}ms)`);
  assert.ok(yieldCount > 0, `cooperative frame yielder must yield during passage scoring (yields=${yieldCount})`);

  // End-to-end buildUnifiedResponseLoreMaterial via full LIBRA VM harness on multi-entry large lorebook
  const harness = await createLibraVmHarness();
  try {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      label: `Large Lore ${i + 1}`,
      key: `large_${i + 1}`,
      keys: ['천소연', `key_${i}`],
      alwaysActive: i < 4,
      mode: 'normal',
      sourceType: 'character',
      source: 'character',
      content: hugeLore.slice(0, 12000)
    }));
    const tMat0 = Date.now();
    const material = await harness.api.debugUnifiedLoreMaterial({
      candidates,
      currentInput: '천소연과 천하연이 대화하며 약속을 확인한다.',
      terminalScene: bigQuery.slice(0, 4000),
      supportText: '천소연 여행동아리 기록',
      consumers: ['memory_ariadne']
    });
    const matElapsedMs = Date.now() - tMat0;
    assert.ok(material?.available === true, 'multi-entry large lore material succeeds');
    assert.ok(matElapsedMs < 2500, `multi-entry large lore material must complete < 2500ms (got ${matElapsedMs}ms)`);
  } finally {
    await harness.cleanup?.();
  }

  // 3. captureUnifiedBasis uses cooperative manifest identity and buildContinuityCandidateContext yields every ref
  const basisSlice = slice(libraSrc, 'const captureUnifiedBasis = async (context, manifest, batch, options) => {', 'const assertUnifiedBasis = async');
  assert.match(basisSlice, /await unifiedManifestIdentityCooperative\(manifest\)/);
  assert.ok(!/headDigest:\s*digest\(rawHead\)/.test(basisSlice), 'captureUnifiedBasis yields between large digests');

  const candSlice = slice(libraSrc, 'const buildContinuityCandidateContext = async (basis,batch,signal=null) => {', 'const sameBatchThreadEvidenceForward =');
  assert.ok(!/\(index\+1\)%4===0/.test(candSlice), 'buildContinuityCandidateContext yields on every ref instead of every 4th');
  assert.ok(!/exposedRows\.forEach/.test(candSlice), 'exposedRows yields periodically instead of unchunked forEach');
});

test('All four plugins register location:chat GUI entry buttons and cleanly unregister on unload', async () => {
  const { create } = require('./fixtures/libra_gui_memory_dom_host.cjs');
  const { load: loadGradia } = require('./gradia/host.cjs');
  const { JSDOM } = require('jsdom');

  const specs = [
    ['LIBRA', 'libra-v1-settings-chat-button', 'LIBRA 설정'],
    ['HAYAKU', 'hayaku-ledger-viewer-chat-button', 'HAYAKU 원장 뷰어'],
    ['Flashback', 'vector-rag-memory-chat', 'FLASHBACK Memory']
  ];

  for (const [owner, expectedId, expectedName] of specs) {
    const unregistered = [];
    const f = await create(owner, 'Full', {
      host: {
        unregisterUIPart: async id => {
          unregistered.push(id);
          return true;
        }
      }
    });
    let closed = false;
    try {
      const chatButtons = f.regs.filter(r => r.kind === 'button' && r.location === 'chat');
      const entry = chatButtons.find(r => r.id === expectedId);
      assert.ok(entry, `${owner} must register chat button ${expectedId}`);
      assert.equal(entry.name, expectedName);
      assert.equal(entry.iconType, 'html');
      assert.equal(typeof entry.callback, 'function');

      const beforeShow = f.calls.show;
      await entry.callback();
      assert.ok(f.calls.show > beforeShow, `${owner} chat entry button opens its GUI`);

      await f.close();
      closed = true;
      assert.ok(unregistered.includes(expectedId), `${owner} unregisters ${expectedId} on unload`);
    } finally {
      if (!closed) await f.close();
    }
  }

  // Verify GRADIA registers its settings GUI chat entry button alongside the existing input writer chat button
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://offline.invalid/' });
  const gradiaButtons = [];
  const gradiaUnregistered = [];
  const gradiaUnloads = [];
  let gradiaShows = 0;
  try {
    await loadGradia({
      api: {
        getArgument: async k => (k === 'enable_gui' ? 'true' : undefined),
        showContainer: async () => { gradiaShows += 1; return true; },
        hideContainer: async () => true,
        registerSetting: async (name, cb, icon, type, id) => ({ id: id || name }),
        registerButton: async (opts, callback) => {
          gradiaButtons.push({ ...opts, callback });
          return { id: opts.id };
        },
        unregisterUIPart: async id => {
          gradiaUnregistered.push(id);
          return true;
        },
        onUnload: async fn => { gradiaUnloads.push(fn); return true; }
      },
      testGlobals: {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        HTMLElement: dom.window.HTMLElement,
        Node: dom.window.Node,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
      }
    });
    await new Promise(resolve => setTimeout(resolve, 60));

    const gradiaChatButtons = gradiaButtons.filter(b => b.location === 'chat');
    const settingsChatBtn = gradiaChatButtons.find(b => b.id === 'serial-gradation-agents-for-rp-settings-chat-button');
    const continueChatBtn = gradiaChatButtons.find(b => b.id === 'serial-gradation-agents-for-rp-continue');
    assert.ok(continueChatBtn, 'GRADIA keeps its existing input writer chat button');
    assert.ok(settingsChatBtn, 'GRADIA registers settings GUI entry button in location: chat');
    assert.equal(settingsChatBtn.name, 'GRADIA 설정');
    assert.equal(settingsChatBtn.iconType, 'html');

    await settingsChatBtn.callback();
    assert.ok(gradiaShows > 0, 'GRADIA chat entry button opens settings GUI');

    for (const fn of gradiaUnloads.reverse()) await fn();
    assert.ok(gradiaUnregistered.includes('serial-gradation-agents-for-rp-settings-chat-button'), 'GRADIA unregisters settings chat button on unload');
    assert.ok(gradiaUnregistered.includes('serial-gradation-agents-for-rp-continue'), 'GRADIA unregisters input writer chat button on unload');
  } finally {
    dom.window.close();
  }
});
