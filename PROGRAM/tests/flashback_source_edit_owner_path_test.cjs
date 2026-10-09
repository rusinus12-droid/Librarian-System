'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const pluginPath = path.resolve(__dirname, '../plugins/Flashback_Memory.js');
const pluginSource = fs.readFileSync(pluginPath, 'utf8');
const testSource = pluginSource.replace(
  '_test: { maintenanceResultText,',
  '_test: { buildSourceEditTab, flashbackPairIdentity, flashbackSourceEditSnapshot, flashbackSourceEditDigest, loadFlashbackCommonReview, normalizeStoredChatMessages, liveChatStateFromNormalized, getFlashbackSourceEdits, maintenanceResultText,'
);

const createChat = () => ({
  id: 'source-edit-owner-chat',
  chatId: 'source-edit-owner-chat',
  name: 'Source edit owner path',
  message: [
    { role: 'user', chatId: 'logical-user-1', data: 'What is the archive code?' },
    { role: 'assistant', chatId: 'assistant-1', data: 'The archive code is Saffron Harbor.' }
  ]
});

test('source-edits tab uses the shared history controls without a manual review action', async () => {
  const fixture = await createFixture({ source: testSource, chat: createChat() });
  try {
    const sourceTab = fixture.api._test.buildSourceEditTab();
    assert.doesNotMatch(sourceTab, /fbSourceEditReview|변경 전·후 비교하기|확인창/,
      'source-edits tab must not offer a manual review button or dialog flow');
    assert.match(sourceTab, /fbSourceTrackingSettings/,
      'source-edits tab must mount the shared recent-event and exception controls');
    const manual=await fixture.api.reviewSourceEdits();
    assert.equal(manual.reason,'automatic_before_request_only',
      'the public Flashback API cannot open a manual approval/review flow');
  } finally {
    await fixture.dispose();
  }
});

test('source observer reports stable completed U+A turn identities for expiry', async () => {
  const fixture = await createFixture({ source: testSource, chat: createChat() });
  try {
    const api = fixture.api;
    const scope = await api.resolveCurrentScope();
    const snapshot = await api._test.flashbackSourceEditSnapshot();
    const normalized = api._test.normalizeStoredChatMessages(fixture.currentChat, scope.scopeKey);
    const state = api._test.liveChatStateFromNormalized(normalized);
    const expectedLogicalTurnId = api._test.flashbackPairIdentity(scope.scopeKey, state.pairs[0]).logicalTurnId;
    assert.deepEqual(Array.from(snapshot.completedTurnIds), [expectedLogicalTurnId],
      'owner snapshot must supply the stable completed U+A turn identity for 10-turn expiry');
  } finally {
    await fixture.dispose();
  }
});

test('public beforeRequest omits source evidence blocked by a pending or excepted revision', async () => {
  const fixture = await createFixture({ source: testSource, chat: createChat() });
  try {
    const api = fixture.api;
    await api.saveSettings({
      ...await api.loadSettings(),
      embeddingProvider: 'hash', embeddingModel: 'hash-v1', embeddingEnabled: true,
      autoEpisodeIndex: false, maxInjectionChars: 8000
    });
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const scope = await api.resolveCurrentScope();
    // The hash-only fixture is now intentionally unindexed. Exercise the same
    // owner gates after real raw-first reservation/completion with an offline model.
    fixture.host.nativeFetch = async (_url, init) => ({ ok: true, status: 200, async json() {
      return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
    } });
    await api.saveSettings({ ...await api.loadSettings(), embeddingProvider: 'openai_compat',
      embeddingModel: 'fixture-model', embeddingDimensions: 3, embeddingUrl: 'https://fixture.invalid/v1', embeddingMaxRetries: 0 });
    const pending = (await api._test.loadScopeRecords(scope.scopeKey)).records;
    for (const sourceHash of new Set(pending.map(record => record.sourceHash))) {
      assert.equal((await api.processPendingEmbeddingWork({ sourceHash })).ready, 1);
    }
    const before = await api._test.flashbackSourceEditSnapshot();
    const controller = api._test.getFlashbackSourceEdits();
    const slot = await controller.loadScope(scope.scopeKey);
    const unit = before.units[0];
    const revisionId = 'owner-path-test:1';
    slot.data.tasks[unit.key] = {
      ...unit, revisionId, state: 'conflict', conflict: 'pending source revision', forceRebuild: true,
      archived: false, error: ''
    };
    slot.units.set(unit.key, unit);
    const affectedEpisode = {
      autoEpisode: true, sourceType: 'episode_index', turnRange: { start: 1, end: 2 },
      text: 'Saffron Harbor and blue ribbon'
    };
    const adjacentEpisode = {
      autoEpisode: true, sourceType: 'episode_index', turnRange: { start: 2, end: 2 },
      text: 'unrelated nearby episode'
    };
    const pendingEpisodes = api._test.applyRecallHardGates([affectedEpisode, adjacentEpisode], { scopeKey: scope.scopeKey });
    assert.deepEqual(Array.from(pendingEpisodes), [adjacentEpisode],
      'a derived episode overlapping a pending turn is blocked while an unrelated adjacent episode remains eligible');
    assert.equal(pendingEpisodes.diagnostics.sourceEditFiltered, 1,
      'the overlapping episode is counted once by the source-edit gate');

    fixture.currentChat.message.push({ role: 'user', chatId: 'logical-user-2', data: 'What is the archive code?' });
    fixture.currentChat.messages = fixture.currentChat.message;
    const first = await api._selectionTest.beforeRequest([
      { role: 'user', chatId: 'logical-user-2', content: 'What is the archive code?' }
    ], 'model');
    assert.equal(JSON.stringify(first).includes('Saffron Harbor'), false,
      'pending source revision must be excluded from the actual hook return');
    assert.equal((await api.debugState()).lastRecall.sourceEditFiltered, 1,
      'one pending turn must be counted once by the recall gate');

    slot.data.tasks[unit.key].state = 'applied';
    slot.data.tasks[unit.key].conflict = '';
    slot.data.exceptions[revisionId] = true;
    const exceptionEpisodes = api._test.applyRecallHardGates([affectedEpisode, adjacentEpisode], { scopeKey: scope.scopeKey });
    assert.deepEqual(Array.from(exceptionEpisodes), [adjacentEpisode],
      'an exception for the current exact revision also blocks its derived episode but leaves the adjacent range alone');
    const second = await api._selectionTest.beforeRequest([
      { role: 'user', chatId: 'logical-user-2', content: 'What is the archive code?' }
    ], 'model');
    assert.equal(JSON.stringify(second).includes('Saffron Harbor'), false,
      'an excepted source revision must also be excluded from the actual hook return');

    slot.data.tasks[unit.key].revisionId = 'owner-path-test:2';
    slot.data.tasks[unit.key].state = 'applied';
    slot.data.tasks[unit.key].forceRebuild = false;
    const replacementEpisodes = api._test.applyRecallHardGates([affectedEpisode, adjacentEpisode], { scopeKey: scope.scopeKey });
    assert.deepEqual(Array.from(replacementEpisodes), [affectedEpisode, adjacentEpisode],
      'the prior revision exception does not block a replacement revision or its derived episode');
    const third = await api._selectionTest.beforeRequest([
      { role: 'user', chatId: 'logical-user-2', content: 'What is the archive code?' }
    ], 'model');
    assert.equal(JSON.stringify(third).includes('Saffron Harbor'), true,
      'an exception for an older revision must not block the current applied revision');
    const recall = (await api.debugState()).lastRecall;
    const pipeline = recall.delivery?.pipeline;
    assert.equal(recall.delivery?.stage, 'returned_to_hook',
      'the public hook records the point at which its return value is established');
    assert.ok(pipeline.storageRecords > 0 && pipeline.candidates > 0 && pipeline.selectedRecords > 0,
      'the public path reports storage, candidate, and selection counts');
    assert.ok(pipeline.budgetedFragments > 0 && pipeline.returnedBlockChars > 0,
      'the public path reports budgeted evidence and the block placed in returned messages');
    assert.equal(pipeline.returnedMessages, third.length,
      'returned-message diagnostics match the actual beforeRequest hook result');
  } finally {
    await fixture.dispose();
  }
});

test('recall UI describes hook return and exposes storage-to-budget counts', async () => {
  const source = testSource.replace(
    '_test: { buildSourceEditTab,',
    '_test: { renderLastRecallPanel, buildSourceEditTab,'
  );
  const fixture = await createFixture({ source, chat: createChat() });
  try {
    const panel = fixture.api._test.renderLastRecallPanel({
      scopeKey: 'scope', at: Date.now(), selected: [], storedRecords: 8, candidates: 5,
      preparedCandidates: 3, evidenceBudgetPlan: { tier: 'standard', actualChars: 120 },
      delivery: { stage: 'returned_to_hook', delivered: 2, pipeline: {
        storageRecords: 8, candidates: 5, selectedRecords: 3, budgetedFragments: 2, returnedMessages: 4
      } }
    }, 'scope');
    assert.match(panel, /후크 반환/, 'the panel must not claim model delivery');
    assert.match(panel, /저장 8[^<]*후보 5[^<]*선택 3[^<]*예산 2[^<]*후크 반환 4개 메시지/,
      'the panel must summarize storage, selection, budget, and hook return evidence');
    assert.doesNotMatch(panel, /실제 전달/);
  } finally {
    await fixture.dispose();
  }
});

test('missing previous raw source does not render the whole current source as a fabricated diff', async () => {
  const fixture = await createFixture({ source: testSource, chat: createChat() });
  try {
    const api = fixture.api;
    await api.saveSettings({
      ...await api.loadSettings(),
      embeddingProvider: 'hash', embeddingModel: 'hash-v1', embeddingEnabled: true,
      autoEpisodeIndex: false
    });
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const snapshot = await api._test.flashbackSourceEditSnapshot();
    const task = {
      key: '1', label: 'T1', start: 1,
      originalDigest: 'previous-source-is-unavailable',
      sourceDigest: snapshot.units[0].sourceDigest
    };
    const view = await api._test.loadFlashbackSourceEditDiff([task]);
    const row = view.rows[0];
    assert.equal(row.previousUnavailable, true);
    assert.match(row.afterText, /Saffron Harbor/);
    assert.equal(row.removed, 0, 'no removed range can be claimed without an old raw source');
    assert.equal(row.added, 0, 'no added range can be claimed without an old raw source');
    assert.doesNotMatch(row.after, /<mark/, 'the full current source must not be highlighted as a change');
    const scope = await api.resolveCurrentScope();
    const review = await api._test.loadFlashbackCommonReview([task], scope.scopeKey);
    assert.equal(review.rows[0].previousUnavailable, true);
    assert.equal(review.rows[0].beforeText, review.rows[0].afterText,
      'the shared renderer receives equal hidden comparison inputs while it shows the unavailable notice');
  } finally {
    await fixture.dispose();
  }
});

test('changing the source projection rules alone is not observed as an original source edit', async () => {
  const chat = createChat();
  chat.message[1].data = 'The archive code is <private>Saffron Harbor</private>.';
  chat.messages = chat.message;
  const fixture = await createFixture({ source: testSource, chat });
  try {
    const api = fixture.api;
    await api.setSourceEditRules({
      version: 1, ignoredTags: [{ open: '<private>', close: '</private>' }],
      unwrapTags: [], sourceTags: [], controls: []
    });
    await api.saveSettings({
      ...await api.loadSettings(),
      embeddingProvider: 'hash', embeddingModel: 'hash-v1', embeddingEnabled: true,
      autoEpisodeIndex: false
    });
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const scope = await api.resolveCurrentScope();
    const before = await api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(before.records.some(record => record.text.includes('Saffron Harbor')), false,
      'the initial source projection excluded the configured private region');
    const controller = api._test.getFlashbackSourceEdits();
    const originalSnapshot = await api._test.flashbackSourceEditSnapshot();
    assert.ok(originalSnapshot.units[0]?.rawDigest, 'owner snapshot includes a hash of unprojected U+A source');
    assert.equal(originalSnapshot.units[0]?.originalRawDigest, originalSnapshot.units[0]?.rawDigest,
      'newly captured records retain a matching raw-source digest for policy comparisons');

    await api.setSourceEditRules({
      version: 1, ignoredTags: [], unwrapTags: [], sourceTags: [], controls: []
    });
    const after = await api._test.flashbackSourceEditSnapshot();
    assert.equal(after.units[0]?.rawDigest, originalSnapshot.units[0]?.rawDigest,
      'the unprojected U+A hash remains equal when only projection rules change');
    assert.equal(after.units[0]?.sourceDigest===originalSnapshot.units[0]?.sourceDigest, false,
      'the projected source hash changes because the newly selected region becomes searchable');
    await controller.inspect(after, { phase: 'before' });
    const task = api.getSourceEditSyncStatus().tasks.find(item => item.key === '1');
    assert.equal(task?.changeKind, 'projection_policy_changed',
      'a stable raw hash plus a new projection policy is classified separately from an original source edit');
    assert.equal(task?.policyUncertain, false,
      'matching stored raw-source evidence makes the projection-only classification certain');
  } finally {
    await fixture.dispose();
  }
});

test('ignored, unwrapped, and selected source rules govern the actual Flashback snapshot digest', async () => {
  const cases = [
    {
      name: 'ignored tags',
      rules: { version: 1, ignoredTags: ['ignored'], unwrapTags: [], sourceTags: [], controls: [] },
      initial: 'The code is <ignored>draft one</ignored> stable.',
      edits: [['The code is <ignored>draft two</ignored> stable.', false]]
    },
    {
      name: 'unwrap tags',
      rules: { version: 1, ignoredTags: [], unwrapTags: ['box'], sourceTags: [], controls: [] },
      initial: 'The code is <box>draft one</box> stable.',
      edits: [['The code is <box>draft two</box> stable.', true]]
    },
    {
      name: 'source selection tags',
      rules: { version: 1, ignoredTags: [], unwrapTags: [], sourceTags: ['original'], controls: [] },
      initial: '<original>The code is draft one.</original> Translation one.',
      edits: [
        ['<original>The code is draft one.</original> Translation two.', false],
        ['<original>The code is draft two.</original> Translation two.', true]
      ]
    }
  ];
  for (const item of cases) {
    const chat = createChat();
    chat.message[1].data = item.initial;
    chat.messages = chat.message;
    const fixture = await createFixture({ source: testSource, chat });
    try {
      const api = fixture.api;
      await api.setSourceEditRules(item.rules);
      await api.saveSettings({
        ...await api.loadSettings(),
        embeddingProvider: 'hash', embeddingModel: 'hash-v1', embeddingEnabled: true,
        autoEpisodeIndex: false
      });
      await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
      const baseline = await api._test.flashbackSourceEditSnapshot();
      for (const [edited, expectedChanged] of item.edits) {
        fixture.currentChat.message[1].data = edited;
        fixture.currentChat.messages = fixture.currentChat.message;
        const observed = await api._test.flashbackSourceEditSnapshot();
        assert.equal(observed.units[0]?.changed, expectedChanged,
          `${item.name}: owner unit must compare the rule-projected U+A text`);
        fixture.currentChat.message[1].data = item.initial;
        fixture.currentChat.messages = fixture.currentChat.message;
      }
      assert.ok(baseline.units[0]?.sourceDigest, `${item.name}: snapshot exposes the projected content hash`);
    } finally {
      await fixture.dispose();
    }
  }
});
