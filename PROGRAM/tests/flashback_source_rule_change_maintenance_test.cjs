'use strict';
// 태그 규칙 변경: Flashback stores turn text and recalls it verbatim, so a tag rule added later is
// worth applying to stored turns, but only with the user's go-ahead. Inspection names those turns
// (ruleChangedTurns, plan line 태그 규칙) and one confirmed maintenance resyncs them in one step.
// It used to call them only 정제 필요, trim the stored text, and leave chunk offsets that the next
// maintenance rebuilt a second time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { syntheticFetch, configure } = require('./helpers/unload_recall_contract_fixture.cjs');

const RULES = { version: 1, ignoredTags: ['img', 'lb-lazy', 'lb-xnai', 'status-window', 'thoughts'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata'] };
const FACT = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';

test('a tag rule change is shown, applied only by a confirmed maintenance, and finishes in one run', async () => {
  const chat = { id: 'rule-chat', chatId: 'rule-chat', message: [
    { role: 'user', chatId: 'u1', data: 'Inspect the gauge.' },
    { role: 'assistant', chatId: 'a1', data: FACT + '\n<status-window>HP 10</status-window>' }] };
  const f = await createFixture({ chat });
  try {
    let embeddingCalls = 0;
    f.host.nativeFetch = (url, init) => { if (String(url).includes('unload-fixture')) embeddingCalls++; return syntheticFetch(url, init); };
    await configure(f, 'configured');
    await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await f.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
    const scope = await f.api.resolveCurrentScope();
    const records = async () => (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    const before = await records();
    assert.equal(before.length, 1);
    assert.match(before[0].text, /status-window/);
    const callsBefore = embeddingCalls;

    await f.api.setSourceEditRules(RULES);
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.ruleChangedTurns, 1, 'the turn is named as a tag-rule change');
    assert.equal(plan.changedTurns, 1);
    assert.equal(plan.dirtyRecords, 0, 'not counted again as a generic cleanup');
    assert.equal(plan.automatic.strategy, 'targeted_repair');

    // Nothing changes until the user confirms a maintenance; a plain reconcile leaves it alone.
    await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    assert.equal((await records())[0].id, before[0].id);
    assert.equal(embeddingCalls, callsBefore);

    await f.api.runMemoryMaintenance();
    await f.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
    const after = await records();
    assert.equal(after.length, 1, 'the turn is replaced, not duplicated');
    assert.doesNotMatch(after[0].text, /status-window/, 'the stored text follows the new rule');
    assert.ok(after[0].text.includes('red mark'));
    assert.equal(after[0].embeddingReceipt?.status, 'ready');
    assert.ok(embeddingCalls > callsBefore, 'the turn is embedded again once');

    const next = await f.api.inspectMemoryMaintenance();
    assert.equal(next.ruleChangedTurns, 0);
    assert.equal(next.liveChunkSchemaMismatch, 0, 'no second rebuild is left behind');
    assert.equal(next.automatic.strategy, 'no_action');
    const settled = embeddingCalls;
    await f.api.runMemoryMaintenance();
    assert.equal(embeddingCalls, settled, 'a later maintenance spends nothing');
  } finally { await f.dispose(); }
});

test('without saved rules nothing is reported as a tag-rule change', async () => {
  const chat = { id: 'plain-chat', chatId: 'plain-chat', message: [
    { role: 'user', chatId: 'u1', data: 'Inspect the gauge.' },
    { role: 'assistant', chatId: 'a1', data: FACT + '\n<status-window>HP 10</status-window>' }] };
  const f = await createFixture({ chat });
  try {
    f.host.nativeFetch = (url, init) => syntheticFetch(url, init);
    await configure(f, 'configured');
    await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await f.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.ruleChangedTurns, 0);
    assert.equal(plan.changedTurns, 0);
  } finally { await f.dispose(); }
});

// 원문 태그 필터 원칙: a rule change in either direction keeps the turn bound to its stored record
// (only an optional 태그 규칙 resync is offered), while a real edit, a reroll or a rollback is
// still a change. A slot match by turn position alone used to hide all three.
const DEFAULT_RULES = { version: 1, ignoredTags: ['img', 'lb-lazy', 'lb-xnai', 'thoughts'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata'] };
const ruleFixture = async () => {
  const chat = { id: 'bind-chat', chatId: 'bind-chat', message: [
    { role: 'user', chatId: 'u1', data: 'Inspect the gauge.' },
    { role: 'assistant', chatId: 'a1', data: FACT + '\n<status-window>HP 10</status-window>' }] };
  const f = await createFixture({ chat });
  f.host.nativeFetch = (url, init) => syntheticFetch(url, init);
  await configure(f, 'configured');
  await f.api.setSourceEditRules(RULES);
  await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
  await f.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
  const settled = await f.api.inspectMemoryMaintenance();
  assert.equal(settled.changedTurns, 0, 'stored under the rule: nothing to do');
  return { f, chat: f.currentChat };
};

test('removing a tag rule keeps the turn bound; only a 태그 규칙 resync is offered', async () => {
  const { f } = await ruleFixture();
  try {
    await f.api.setSourceEditRules(DEFAULT_RULES);
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.ruleChangedTurns, 1, 'same messages and raw bytes: a rule change, not an edit');
    assert.equal(plan.missingTurns, 0);
    assert.equal(plan.staleStoredTurns, 0, 'the stored turn is not orphaned');
  } finally { await f.dispose(); }
});

test('a real edit is still a change after the rules are saved', async () => {
  const { f, chat } = await ruleFixture();
  try {
    chat.message[1].data = 'The needle drops to zero and the valve is gone.\n<status-window>HP 10</status-window>';
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.changedTurns, 1, 'the visible text changed');
    assert.equal(plan.ruleChangedTurns, 0, 'an edit is not reported as a rule change');
  } finally { await f.dispose(); }
});

test('a reroll that keeps the chatId (cached reroll) is still a change', async () => {
  const { f, chat } = await ruleFixture();
  try {
    chat.message[1].data = 'A different reply entirely about the boiler room.\n<status-window>HP 10</status-window>';
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.changedTurns, 1);
    assert.equal(plan.ruleChangedTurns, 0);
  } finally { await f.dispose(); }
});

test('a reroll with a new message id is still a change', async () => {
  const { f, chat } = await ruleFixture();
  try {
    chat.message[1] = { role: 'assistant', chatId: 'a1-reroll', data: 'Another reply about the north wall.\n<status-window>HP 9</status-window>' };
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.changedTurns, 1);
    assert.equal(plan.ruleChangedTurns, 0);
  } finally { await f.dispose(); }
});

test('a rollback (the turn removed) leaves the stored turn stale, not bound', async () => {
  const { f, chat } = await ruleFixture();
  try {
    chat.message = []; chat.messages = [];
    const plan = await f.api.inspectMemoryMaintenance();
    assert.equal(plan.unchangedTurns, 0);
    assert.equal(plan.staleStoredTurns, 1, 'the stored turn no longer has a live turn');
  } finally { await f.dispose(); }
});
