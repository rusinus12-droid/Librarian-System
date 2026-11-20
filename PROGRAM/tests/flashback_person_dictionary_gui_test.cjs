'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, until } = require('./fixtures/flashback_complete_gui_fixture.cjs');

test('Flashback GUI and recall no longer expose auto person dictionary or entityMismatch penalty', async () => {
  const s = await create('Flashback');
  try {
    const scope = await s.api.resolveCurrentScope();
    const scopeKey = scope.scopeKey;

    assert.equal(s.api._test.resolvePersonDictionaryForGui, undefined);
    assert.equal(s.api._test.renderPersonDictionaryDialogHtml, undefined);
    assert.equal(s.api._test.openPersonDictionaryDialog, undefined);

    const sources = [
      {
        role: 'response',
        sourceType: 'response',
        origin: 'live_chat',
        sourceId: 'turn_1',
        sourceHash: 'hash_1',
        turnIndex: 1,
        pairIndex: 1,
        text: '민아: "있잖아, 어제 서재에서 쓰잖아 그 열쇠."'
      },
      {
        role: 'response',
        sourceType: 'response',
        origin: 'live_chat',
        sourceId: 'turn_2',
        sourceHash: 'hash_2',
        turnIndex: 2,
        pairIndex: 2,
        text: '서연: "서재 열쇠는 내가 보관하고 있어."'
      }
    ];
    const records = await s.api._test.buildRecordsFromSources(sources, null, scope, { deferEmbedding: true });
    await s.api._test.saveAllRecords(records, null, scope);

    const recall = await s.api._test.prepareFlashbackRecall('있잖아, 서재 열쇠 어디 있어?', null, scope);
    assert.equal(recall.personIsolation, undefined);
    for (const item of recall.records || []) {
      assert.notEqual(item?.components?.entityMismatch, true);
    }

    const panelHtml = s.api._test.renderLastRecallPanel({
      scopeKey,
      at: Date.now(),
      latestUser: '있잖아, 서재 열쇠 어디 있어?',
      selected: []
    }, scopeKey);
    assert.doesNotMatch(panelHtml, /data-fb-open-person-dict|자동 인물 사전|인물 사전 열람/);

    await s.open();
    await until(() => s.doc.querySelector('#lastRecallPanel'), 'lastRecallPanel mounted');
    assert.equal(s.doc.querySelector('#openPersonDictBtn'), null);
    assert.equal(s.doc.querySelector('[data-fb-open-person-dict]'), null);
  } finally {
    await s.close();
  }
});
