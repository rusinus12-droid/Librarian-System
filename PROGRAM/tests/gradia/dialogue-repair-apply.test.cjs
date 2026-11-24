'use strict';
// 화술·대화 AIDE 판독이 지목한 대사가 실제로 초안에 반영되는지 확인한다.
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./host.cjs');

test('a named dialogue repair lands in the draft even when the patch missed it', async () => {
  const host = await load();
  const draft = '그가 창가에 섰다. "오늘 왔어?" "왔어." 그녀는 고개를 들지 않았다.';
  const out = host.plugin.debugDialogueApplyRepairs({
    draftText: draft,
    repairs: [
      { draft_quote: '왔어.', replacement: '그럼 안 왔으면 어떻게 했을 것 같아.' },
      { draft_quote: '없는 대사', replacement: '바뀌면 안 됨' }
    ]
  });
  assert.equal(out.count, 1, 'only the quote that exists in the draft is applied');
  assert.ok(out.draftText.includes('그럼 안 왔으면 어떻게 했을 것 같아.'));
  assert.ok(!out.draftText.includes('"왔어."'), 'the echo answer is gone from the page');
  assert.ok(!out.draftText.includes('바뀌면 안 됨'), 'a quote missing from the draft changes nothing');
});

test('a repair with no replacement wording leaves the draft alone', async () => {
  const host = await load();
  const draft = '아무 말도 없었다.';
  const out = host.plugin.debugDialogueApplyRepairs({
    draftText: draft,
    repairs: [{ draft_quote: '아무 말도 없었다.', replacement: '아무 말도 없었다.' }]
  });
  assert.equal(out.count, 0);
  assert.equal(out.draftText, draft);
});

test('the speechcraft duty reaches the host stage when the AIDE is on, and stays out when it is off', async () => {
  const host = await load();
  const recent = {
    latestUser: '그가 창가에 섰다. "오늘 왔어?"',
    visibleMessages: [
      { role: 'assistant', content: '그녀가 고개를 들었다. "왔어?" "왔어."' },
      { role: 'user', content: '문을 닫는다.' }
    ]
  };
  const on = host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    recent,
    settings: { enableDialogueAide: true, mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: false }
  });
  assert.match(on, /DIALOGUE & SPEECHCRAFT/);
  assert.match(on, /echo/i);
  const off = host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    recent,
    settings: { enableDialogueAide: false, mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: false }
  });
  assert.equal(off, '', 'no speechcraft duty is injected when the AIDE is off');
});
