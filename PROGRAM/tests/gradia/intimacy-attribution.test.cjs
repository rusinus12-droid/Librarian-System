'use strict';
// 자극 귀속 회귀: 본문에 적힌 부위가 "그 사람의 몸"으로 적립되는지 확인한다.
// 실측 사고: "소연이 뒤에서 하연의 … 외음부를 애무" 인 장면에서 외음부가 소연의 게이지로
// 적립되고, 여성 인물(하연)에게 사정 게이지가 표시됐다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./host.cjs');

let hostPromise = null;
const host = () => {
  hostPromise = hostPromise || load({
    transformSource: source => source.replace(
      'const publicApi = Object.freeze({',
      'const publicApi = Object.freeze({ __testZoneOwners: intimacyBodyPartOwners, __testNormalizeGender: intimacyNormalizeGender,'
    )
  });
  return hostPromise;
};
const ownersText = (map, zone) => {
  const set = map.get(zone);
  return set ? [...set].sort().join(',') : '';
};

test('a body part named for another person is not credited to the actor', async () => {
  const h = await host();
  const map = h.plugin.__testZoneOwners('소연이 뒤에서 하연의 몸을 열고 가슴과 외음부를 애무했다.', ['소연', '하연']);
  assert.equal(ownersText(map, 'clitoris_vulva'), '하연', '외음부는 하연의 몸');
  assert.equal(ownersText(map, 'breasts_nipples'), '하연', '가슴도 하연의 몸');

  const fullNameMap = h.plugin.__testZoneOwners('소연이 뒤에서 하연의 몸을 열고 가슴과 외음부를 애무했다.', ['천소연', '천하연']);
  assert.equal(ownersText(fullNameMap, 'clitoris_vulva'), '천하연', '성이 빠진 본문 표기도 전체 이름 소유자로 매핑');

  const coordMap = h.plugin.__testZoneOwners('푸딩은 소연과 하연의 질내에 손가락을 집어넣었다.', ['푸딩', '천소연', '천하연']);
  assert.equal(ownersText(coordMap, 'vaginal_canal'), '천소연,천하연', '과/와로 묶인 공동 소유자는 둘 다 적립');

  const pronounMap = h.plugin.__testZoneOwners('하연은 포복해서 그의 하체에 다가가 남성기를 감쌌다.', ['푸딩', '천하연']);
  assert.equal(ownersText(pronounMap, 'penis_shaft_scrotum'), '', '주격(하연은) 뒤 대명사(그의)의 의를 주어 소유로 오인하지 않음');
});

test('a zone the character owns herself is credited to her', async () => {
  const h = await host();
  const map = h.plugin.__testZoneOwners('하연의 허벅지 안쪽을 애무했다.', ['소연', '하연']);
  assert.equal(ownersText(map, 'inner_thighs'), '하연');
});

test('an unowned clause with one participant stays that participant', async () => {
  const h = await host();
  const map = h.plugin.__testZoneOwners('가슴을 감싸다.', ['하연']);
  // 소유자가 문장에 없어도 참가자가 한 명이면 그 사람의 몸으로 남는다.
  assert.ok([...map.get('breasts_nipples')].includes('하연'));
});

test('an unowned clause with two participants is left unattributed', async () => {
  const h = await host();
  const map = h.plugin.__testZoneOwners('가슴을 감싸다.', ['소연', '하연']);
  assert.equal(ownersText(map, 'breasts_nipples'), '');
});

test('gender values are normalized before they gate a gauge', async () => {
  const h = await host();
  const norm = h.plugin.__testNormalizeGender;
  assert.equal(norm('M'), 'male');
  assert.equal(norm('남성'), 'male');
  assert.equal(norm('여'), 'female');
  assert.equal(norm('vulva'), 'female');
  assert.equal(norm('penis'), 'male');
  assert.equal(norm('unknown'), '');
  assert.equal(norm(''), '');
});

test('a waistband mention is not read as a male cue', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/GRADIA.js'), 'utf8');
  const start = source.indexOf('const inferGenderFromIntimacyText');
  const end = source.indexOf('\n  const intimacyNormalizeGender', start);
  const block = source.slice(start, end);
  assert.ok(block.includes('maleCue'), 'the male cue block must be present');
  assert.equal(block.includes('허리춤'), false, '허리춤은 성별 단서가 아니다');
});
