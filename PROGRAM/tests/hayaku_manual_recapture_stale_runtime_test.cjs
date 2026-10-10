'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const messagesFor = userText => [
  { role: 'user', chatId: 'user-1', data: userText },
  { role: 'assistant', chatId: 'assistant-1', data: `Alice found a silver compass inside the archive.\n${hiddenPacketMessage('', createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: 'Alice found a silver compass inside the archive.' }))}` }
];
const storageBytes = storage => Array.from(storage.values.entries(), ([key, value]) => [key, String(value)])
  .sort(([a], [b]) => a.localeCompare(b));

(async () => {
  const sourceChanged = await createHayakuRuntime({ autoRepair: false, messages: messagesFor('Alice opens the archive.'), chatId: 'manual-recapture-stale-source' });
  try {
    const preview = await sourceChanged.hayaku.ledger.manualRecapture.preview();
    sourceChanged.setMessages(messagesFor('Alice closes the archive instead.'));
    const before = storageBytes(sourceChanged.pluginStorage);
    const result = await sourceChanged.hayaku.ledger.manualRecapture.adopt({ previewId: preview.previewId, selection: 'selected', turns: [1] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'selected_turn_source_changed');
    assert.deepEqual(storageBytes(sourceChanged.pluginStorage), before, 'changed source rejects adoption without writing');
  } finally {
    await sourceChanged.dispose();
  }

  const ledgerChanged = await createHayakuRuntime({ autoRepair: false, messages: messagesFor('Alice opens the archive.'), chatId: 'manual-recapture-stale-ledger' });
  try {
    const preview = await ledgerChanged.hayaku.ledger.manualRecapture.preview();
    const scope = await ledgerChanged.hayaku._test.currentChatScope();
    const key = `hayaku.v2.ledger.${scope.key}`;
    const emptyLedger = ledgerChanged.hayaku._test.normalizeStorageLedger(null, scope);
    await ledgerChanged.pluginStorage.setItem(key, JSON.stringify({ ...emptyLedger, externalRevision: 'changed-after-preview' }));
    const before = storageBytes(ledgerChanged.pluginStorage);
    const result = await ledgerChanged.hayaku.ledger.manualRecapture.adopt({ previewId: preview.previewId, selection: 'all' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ledger_changed_before_adoption');
    assert.deepEqual(storageBytes(ledgerChanged.pluginStorage), before, 'ledger compare-and-swap rejection preserves the concurrent writer bytes');
  } finally {
    await ledgerChanged.dispose();
  }
  console.log('PASS manual recapture rejects changed transcript and changed ledger revisions without overwriting either');
})().catch(error => { console.error(error); process.exitCode = 1; });
