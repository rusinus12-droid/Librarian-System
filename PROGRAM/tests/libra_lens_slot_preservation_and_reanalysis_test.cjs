'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

test('lens preserves notes on same chatId + intact quote after tag refresh, and re-extracts when chatId or quote changes', async () => {
  const seam = '    const scheduleChangedBatchLensReanalysis = ';
  const f = await lensFixture({
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(seam, '    globalThis.__scheduleChangedBatchLensReanalysis = (...args) => scheduleChangedBatchLensReanalysis(...args);\n' + seam);
    }
  });
  try {
    f.setReply({
      items: [{
        label: '약속',
        text: '지호가 은빛 열쇠를 오늘 돌려주겠다고 약속했다',
        refs: ['t2-a'],
        quote: '오늘 돌려주겠다고 약속했다'
      }]
    });
    await f.add('약속 렌즈', 'active', { cadence: { mode: 'every_batch' }, recall: { role: 'relevant' } });

    // 1) Tag/footer appended by another module (same chatId, quote still present) -> preserved without re-run
    const baseText = f.chat.message[3].data;
    f.chat.message[3].data = baseText + '\n\n◈CG\nTIME|2027.04.25(일)|21:31|휴일\n@|지호|jiho\n◈\n\n---\n \n---';

    const inspectedPreserved = await f.api.inspectScopeLenses();
    assert.equal(inspectedPreserved.memories.filter(m => m.sourceCurrent).length, 1);
    assert.equal(inspectedPreserved.memories.filter(m => !m.sourceCurrent).length, 0);

    const recallPreserved = await f.api.recallLensMemories({ query: '지호 은빛 열쇠 약속', canonicalBudgetChars: 12000 });
    assert.ok(recallPreserved.injectedItems.length > 0, 'preserved lens note is still recalled');

    // 2) Real text edit / reroll (quote removed & chatId changed) -> marked stale, then auto-reanalyzed
    f.chat.message[3].data = '지호는 은빛 열쇠 대신 붉은 열쇠를 내일 주겠다고 말했다.';
    f.chat.message[3].chatId = 'rerolled-assistant-chat-id';

    const inspectedStale = await f.api.inspectScopeLenses();
    assert.equal(inspectedStale.memories.filter(m => !m.sourceCurrent).length, 1);

    f.setReply({
      items: [{
        label: '약속',
        text: '지호가 붉은 열쇠를 내일 주겠다고 말했다',
        refs: ['t2-a'],
        quote: '붉은 열쇠를 내일 주겠다고 말했다'
      }]
    });

    const scope = (await f.api.getHostLineageStatus()).scopeKey;
    const queued = await f.r.context.__scheduleChangedBatchLensReanalysis({ scope: { scopeKey: scope }, turn: 2 });
    assert.equal(queued.queued.length, 1, 'stale batch is queued for automatic lens reanalysis');

    await f.api.waitForLensQueueIdle();
    await waitFor(() => true, 50);

    const inspectedRefreshed = await f.api.inspectScopeLenses();
    assert.equal(inspectedRefreshed.memories.filter(m => m.sourceCurrent).length, 1);
    assert.match(inspectedRefreshed.memories[0].text, /붉은 열쇠/);
  } finally {
    await f.close?.();
  }
});

test('legacy lens record without sourcePairs preserves via canonical fallback and whitespace-normalized quote check', async () => {
  const f = await lensFixture({
    beforeRun: async f => {
      f.chat.message[3].data = '안쪽이 굳었다.\n\n몇 초 동안 풀리지 않았다. 오늘 돌려주겠다고 약속했다';
    }
  });
  try {
    f.setReply({
      items: [{
        label: '몸 상태',
        text: '안쪽이 굳었다가 잠시 후 풀렸다',
        refs: ['t2-a'],
        quote: '안쪽이 굳었다. 몇 초 동안 풀리지 않았다.'
      }]
    });
    await f.add('몸 상태 렌즈', 'active', { cadence: { mode: 'every_batch' }, recall: { role: 'relevant' } });

    // Strip sourcePairs from stored lens record to simulate pre-patch legacy lens records in DB.
    for (const [k, raw] of f.r.values.entries()) {
      if (k.includes(':lens:') && k.endsWith(':records')) {
        const store = JSON.parse(raw);
        for (const rec of Object.values(store.records || {})) delete rec.sourcePairs;
        f.r.values.set(k, JSON.stringify(store));
      }
    }

    // Append non-XML tags so sourceDigest/rawSourceDigest no longer match, keeping chatId and text intact.
    f.chat.message[3].data += '\n\n◈CG\nTIME|2027.04.25(일)|21:31|휴일\n@|천소연|soyeon\n◈\n\n---\n \n---';

    const inspected = await f.api.inspectScopeLenses();
    assert.equal(inspected.memories.filter(m => m.sourceCurrent).length, 1);
    assert.equal(inspected.memories.filter(m => !m.sourceCurrent).length, 0);

    const ranges = await f.api.listReanalysisRanges({ kind: 'lens' });
    assert.equal(ranges.ranges[0].status, 'saved');

    const recalled = await f.api.recallLensMemories({ query: '안쪽이 굳었다', canonicalBudgetChars: 12000 });
    assert.ok(recalled.injectedItems.length > 0, 'legacy record with normalized quote stays recallable');
  } finally {
    await f.close?.();
  }
});
