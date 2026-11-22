'use strict';
// 억결 시뮬레이터의 '요구 전개'가 비트 이름이 아니라 실제 행동이어야 한다.
// 실측 사고: 패널에 "행동: 천소연이 푸딩에게 구체적인 행동을 한다"가 떴다 — 카테고리 이름을
// 행동처럼 적어 둔 문장이었다.
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./host.cjs');

const intent = (host, args) => host.plugin.debugForcedBondBeatIntent(args);

test('a beat is rendered as a concrete act, never as its category name', async () => {
  const host = await load();
  for (const beatType of ['emotional_shift', 'relational_action', 'stage_push', 'absent_contact']) {
    for (const lang of ['ko', 'en']) {
      const line = intent(host, { beatType, from: '천소연', to: '푸딩', lang });
      assert.ok(line.length > 8, `${beatType}/${lang} must say something: ${line}`);
      assert.ok(!/구체적인 행동|one concrete thing/.test(line), `${beatType}/${lang} must not use a placeholder: ${line}`);
      assert.match(line, lang === 'ko' ? /천소연/ : /천소연/, `${beatType}/${lang} names the actor: ${line}`);
    }
  }
});

test('the card tone decides the act, so the line is specific to the relationship', async () => {
  const host = await load();
  const jealousy = intent(host, { beatType: 'relational_action', from: '천소연', to: '푸딩', tones: ['jealousy'], lang: 'ko' });
  const affection = intent(host, { beatType: 'relational_action', from: '천소연', to: '푸딩', tones: ['affection'], lang: 'ko' });
  assert.match(jealousy, /누구를 보고 있었는지 묻는다/, jealousy);
  assert.match(affection, /한 걸음 다가가 손을 뻗는다/, affection);
  assert.notEqual(jealousy, affection, 'different tones must produce different acts');
});

test('a stage push names what moves the pair across the line', async () => {
  const host = await load();
  const line = intent(host, {
    beatType: 'stage_push', from: '천소연', to: '푸딩', lang: 'ko',
    stagePush: { from: 'tension', to: 'expressed', chance: 90, roll: 48, success: true }
  });
  assert.match(line, /더는 숨기지 않고/, line);
  assert.doesNotMatch(line, /장면이 나온다/, 'no "a scene appears" hand-wave');
});
