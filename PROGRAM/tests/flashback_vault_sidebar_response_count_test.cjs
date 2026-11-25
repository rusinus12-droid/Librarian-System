'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');

const PROGRAM = path.resolve(__dirname, '..');

test('storageResponseCountLabel counts only active scope response records and handles unloaded states', async () => {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const label = f.api._test.storageResponseCountLabel;
    assert.equal(label(null), '—');
    assert.equal(label({ scope: { scopeKey: '' }, stats: { byType: { response: { records: 5 } } } }), '—');
    assert.equal(label({ scope: { scopeKey: 'scope-a' }, stats: null }), '—');
    assert.equal(label({ scope: { scopeKey: 'scope-a' }, stats: { byType: {} } }), '0');
    assert.equal(
      label({
        scope: { scopeKey: 'scope-a' },
        stats: {
          byType: {
            response: { records: 21 },
            chat_turn: { records: 2 },
            episode_index: { records: 3 }
          }
        }
      }),
      '23',
      'counts only response (including legacy chat_turn alias), never episode_index'
    );
    assert.equal(
      label({
        scope: { scopeKey: 'scope-a' },
        manifest: { stats: { byType: { response: { records: 1234 }, episode_index: { records: 50 } } } }
      }),
      '1,234'
    );
  } finally {
    await f.cleanup();
  }
});

test('sidebar 필름 보관함 badge (#nav-scope-n) renders response record count instead of scope count', async () => {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const htmlBefore = await f.api._test.buildUiHtml();
    assert.match(htmlBefore, /<span class="count" id="nav-scope-n">—<\/span>/, 'before loading current stats, badge shows placeholder dash');

    const scopeA = await f.api.resolveCurrentScope(false);
    await f.api._test.saveAllRecords([
      { id: 'r1', hash: 'h1', sourceType: 'response', type: 'response', turnIndex: 1, pairIndex: 1, text: 'Response one', dim: 3, vector: [1, 0, 0] },
      { id: 'r2', hash: 'h2', sourceType: 'response', type: 'response', turnIndex: 2, pairIndex: 2, text: 'Response two', dim: 3, vector: [1, 0, 0] },
      { id: 'r3', hash: 'h3', sourceType: 'response', type: 'response', turnIndex: 3, pairIndex: 3, text: 'Response three', dim: 3, vector: [1, 0, 0] },
      { id: 'e1', hash: 'e1', sourceType: 'episode_index', type: 'episode_index', autoEpisode: true, text: 'Episode summary', dim: 3, vector: [1, 0, 0] }
    ], null, scopeA);

    const scopeB = { ...scopeA, scopeKey: 'other-scope-for-badge-test', chatId: 'other-chat', canonicalChatId: 'other-chat', chatTitle: 'Other chat' };
    await f.api._test.saveAllRecords([
      { id: 'b1', hash: 'bh1', sourceType: 'response', type: 'response', turnIndex: 1, pairIndex: 1, text: 'Other response', dim: 3, vector: [1, 0, 0] }
    ], null, scopeB);

    const stats = await f.api._test.currentScopeStats({ force: true });
    assert.equal(stats.stats.byType.response.records, 3);
    assert.equal(stats.stats.byType.episode_index.records, 1);

    const htmlAfter = await f.api._test.buildUiHtml();
    assert.match(htmlAfter, /<span class="count" id="nav-scope-n">3<\/span>/, 'sidebar badge shows 3 response records, not 2 scopes or 4 total records');
    assert.match(htmlAfter, /<span class="count" id="tab-scope-n">—<\/span>/, 'scopes subtab badge remains independent from nav-scope-n');
  } finally {
    await f.cleanup();
  }
});
