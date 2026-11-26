'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

test('1) buildSceneBaton falls back to shared participant location and omits empty place/time row', async () => {
  const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' } });
  try {
    const t = h.hayaku._test;

    // Shared prefix fallback from participant locations
    const pWithChars = createValidPacket({ turn: 1, subject: '푸딩', scene: 'hotel-33', summary: '푸딩이 아린의 이불을 여며 주었다.' });
    pWithChars.world.location = '';
    pWithChars.world.time = '';
    pWithChars.entity.characters = [
      { name: '푸딩', location: '호텔 33층 객실', current_state: '책상에 엎드림' },
      { name: '서아린', location: '호텔 33층 객실 침대 위', current_state: '수면 중' }
    ];
    const batonFallback = t.buildSceneBaton([
      { raw: JSON.stringify(pWithChars), hash: 'h-fallback', worldlineOrdinal: 1, targetPairIndex: 1 }
    ], { memoryLanguage: 'ko' });
    assert.match(batonFallback.text, /- 장소 \/ 시간: 호텔 33층 객실$/m, 'shared participant prefix populates place/time');

    // Empty world location/time AND empty participant locations -> omit row altogether
    const pEmptyLoc = createValidPacket({ turn: 1, subject: '푸딩', scene: 'hotel-33', summary: '대화가 이어졌다.' });
    pEmptyLoc.world.location = '';
    pEmptyLoc.world.time = '';
    pEmptyLoc.entity.characters = [{ name: '푸딩', current_state: '대기 중' }];
    const batonOmitted = t.buildSceneBaton([
      { raw: JSON.stringify(pEmptyLoc), hash: 'h-empty', worldlineOrdinal: 1, targetPairIndex: 1 }
    ], { memoryLanguage: 'ko' });
    assert.doesNotMatch(batonOmitted.text, /장소 \/ 시간:/, 'empty place/time row is omitted instead of emitting trailing colon');
  } finally {
    await h.dispose();
  }
});

test('2) ingestPacket drops prior-turn carried-over critical_dialogue when sourceEvidence is supplied, and keeps synthetic calls unchanged', async () => {
  const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' } });
  try {
    const t = h.hayaku._test;
    const pkt = createValidPacket({ turn: 2, subject: '푸딩', scene: 'hotel-33', summary: '푸딩이 침대에 들지 않고 물러났다.' });
    pkt.narrative.critical_dialogue = [
      { speaker: '푸딩', text: '세탁하고 올게. 쉬고 있어.' },
      { speaker: '서아린', text: '돌아오면, 하나만 더 물어볼 게 있어요.' },
      { speaker: '푸딩', text: '안 돼.' },
      { speaker: '서아린', text: '일곱 시.' }
    ];

    const storeGrounded = t.emptyStore();
    t.ingestPacket(storeGrounded, JSON.stringify(pkt), 'pkt-grounded', {
      sourceEvidence: {
        lines: ['그가 손을 내렸다. "안 돼." 아린이 숨을 돌리며 "일곱 시."라고 중얼거렸다.'],
        outcomeLines: ['그가 손을 내렸다. "안 돼." 아린이 숨을 돌리며 "일곱 시."라고 중얼거렸다.'],
        allText: '그가 손을 내렸다. "안 돼." 아린이 숨을 돌리며 "일곱 시."라고 중얼거렸다.',
        roleSeparated: true
      }
    });
    const storedTexts = Array.from(storeGrounded.narrative.criticalDialogue.map(item => item.text || item.summary)).sort();
    assert.deepEqual(storedTexts, ['안 돼.', '일곱 시.'], 'prior-turn carried-over quotes filtered out');

    const storeNoEvidence = t.emptyStore();
    t.ingestPacket(storeNoEvidence, JSON.stringify(pkt), 'pkt-no-evidence', {});
    assert.equal(storeNoEvidence.narrative.criticalDialogue.length, 4, 'synthetic packets without sourceEvidence remain untouched');
  } finally {
    await h.dispose();
  }
});

test('3) Leave preset & GRADIA World AIDE carry updated object-count & split-transfer cues', () => {
  const root = path.resolve(__dirname, '..', '..');
  const preset = JSON.parse(fs.readFileSync(path.join(root, 'PROGRAM', 'prompt', 'Leave_RisuAI_Preset.json'), 'utf8'));
  const tpl0 = preset.promptTemplate[0].text;
  const tpl20 = preset.promptTemplate[20].text;
  assert.ok(tpl0.includes('attire/location/object-count cues'), 'promptTemplate[0] updated');
  assert.ok(tpl20.includes('attire/location/object-count cue'), 'promptTemplate[20] updated');

  const gradiaSrc = fs.readFileSync(path.join(root, 'PROGRAM', 'plugins', 'GRADIA.js'), 'utf8');
  assert.ok(gradiaSrc.includes('Verify exact object counts, splits, and custody transfers against the latest turn'));
  assert.ok(gradiaSrc.includes('object count, custody, and transfer splits'));

  const hayakuSrc = fs.readFileSync(path.join(root, 'PROGRAM', 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
  assert.ok(hayakuSrc.includes("spoken in TARGET TURN\\'s visible response only"));
});

test('4) Leave preset caches chat history before lorebook and strips am-illustration-projection on request', () => {
  const root = path.resolve(__dirname, '..', '..');
  const preset = JSON.parse(fs.readFileSync(path.join(root, 'PROGRAM', 'prompt', 'Leave_RisuAI_Preset.json'), 'utf8'));
  const tpl = preset.promptTemplate || [];
  const firstCacheIdx = tpl.findIndex(item => item.type === 'cache');
  const chatHistIdx = tpl.findIndex(item => item.type === 'chat' && item.rangeStart === 0 && item.rangeEnd === -1);
  const secondCacheIdx = tpl.findIndex((item, idx) => idx > firstCacheIdx && item.type === 'cache');
  const loreIdx = tpl.findIndex(item => item.type === 'lorebook');
  const memIdx = tpl.findIndex(item => item.type === 'memory');
  const authorNoteIdx = tpl.findIndex(item => item.type === 'authornote');
  const lastChatIdx = tpl.findIndex(item => item.type === 'chat' && item.rangeStart === -1);

  assert.ok(firstCacheIdx >= 0 && chatHistIdx > firstCacheIdx && secondCacheIdx > chatHistIdx, 'cachePoints wrap chat history cleanly');
  assert.ok(loreIdx > secondCacheIdx && memIdx > loreIdx, 'dynamic lorebook and memory sit after second cachePoint');
  assert.ok(authorNoteIdx > memIdx && lastChatIdx > authorNoteIdx, 'authornote and final chat stay after lorebook/memory');

  const stripRule = (preset.regex || []).find(item => item.type === 'editprocess' && String(item.in || '').includes('am-illustration-projection'));
  assert.ok(stripRule, 'editprocess strip regex exists');
  assert.equal(stripRule.ableFlag, true);
  assert.equal(stripRule.out, '');

  const re = new RegExp(stripRule.in, stripRule.flag);
  const sample = [
    '본문 첫 문장입니다.',
    '',
    '<div class="am-illustration-projection" data-am-message-id="id1"><span class="am-image" style="display:flex"><img class="am-image__media" src="{{raw::a.png}}" width="832" height="1216"></span></div>',
    '',
    '<img="Ah-rin_Normal">',
    '<div class="note">keep</div>',
    '본문 끝 문장입니다.'
  ].join('\n');
  const cleaned = sample.replace(re, stripRule.out);
  assert.doesNotMatch(cleaned, /am-illustration-projection/);
  assert.ok(cleaned.includes('<img="Ah-rin_Normal">'), 'character emote command preserved');
  assert.ok(cleaned.includes('<div class="note">keep</div>'), 'unrelated div preserved');
  assert.ok(cleaned.includes('본문 첫 문장입니다.') && cleaned.includes('본문 끝 문장입니다.'), 'surrounding prose preserved');
});
