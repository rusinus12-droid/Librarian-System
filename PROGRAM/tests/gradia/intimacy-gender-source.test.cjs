'use strict';
// 성별 판정 단일 출처 회귀.
// 실측 사고: 인물별 보기(신체 도식)는 여성인데 게이지는 "남성"으로 표시되어 사정 축이 올랐다.
// 원인은 게이지가 card.gender(AIDE 추정)를 anatomyView(패널 값)보다 먼저 본 것이었다.
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture } = require('../fixtures/gradia_input_writer_unified_fixture.cjs');

const settings = {
  writingMode: 'rp', rpImpersonationScope: 'persona', enableIntimacyAide: true,
  enableCharacterAide: true, aideStageOrder: ['aide_character'],
  mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct'
};

test('anatomy view (what 인물별 보기 shows) outranks the estimated card gender', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  assert.equal(
    f.host.plugin.debugIntimacyResolveGender({ name: '천하연', card: { gender: 'male', anatomyView: 'female' } }),
    'female',
    'the panel body scheme wins over the model-estimated gender'
  );
  assert.equal(
    f.host.plugin.debugIntimacyResolveGender({ name: '푸딩', card: { gender: 'male', anatomyView: '' } }),
    'male'
  );
});

test('a female character with a stale male estimate never gains an ejaculation gauge', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const axes = f.host.plugin.debugIntimacyGaugeAxes({
    name: '천하연',
    card: { name: '천하연', gender: 'male', anatomyView: 'female' }
  });
  assert.equal(axes.gender, 'female');
  assert.equal(axes.showEjac, false, 'no ejaculation axis is computed for her');
  assert.equal(axes.showClimax, true, 'the climax axis is used instead');

  const unknown = f.host.plugin.debugIntimacyGaugeAxes({ name: '천소연', card: { name: '천소연', gender: '', anatomyView: '' } });
  assert.equal(unknown.showEjac, false, 'an unresolved gender never opens the male-only axis');
  assert.equal(unknown.showClimax, true);
});
