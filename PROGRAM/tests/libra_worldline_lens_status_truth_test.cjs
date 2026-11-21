'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

test('listReanalysisRanges reports stale lens records as missing instead of falsely saved', async () => {
  const f = await lensFixture();
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

    const before = await f.api.listReanalysisRanges({ kind: 'lens' });
    assert.equal(before.ranges.length, 1);
    assert.equal(before.ranges[0].status, 'saved');

    // Non-XML tag refresh with intact quote and same chatId -> still saved
    f.chat.message[3].data += '\n\n◈CG\nTIME|2027.04.25(일)|21:31|휴일\n◈\n\n---\n \n---';
    const afterTag = await f.api.listReanalysisRanges({ kind: 'lens' });
    assert.equal(afterTag.ranges[0].status, 'saved');

    // Real text edit / reroll removing the quote -> must report missing (not falsely saved)
    f.chat.message[3].data = '완전히 다른 응답으로 교체되었습니다.';
    const afterEdit = await f.api.listReanalysisRanges({ kind: 'lens' });
    assert.equal(afterEdit.ranges[0].status, 'missing');
  } finally {
    await f.close?.();
  }
});
