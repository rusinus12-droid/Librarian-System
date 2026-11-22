'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const WORLD_SIM_LOG_KEY = 'serial_gradation_agents_for_rp:world_sim_log:v1';

test('1) captureLibNativeReadSetFromHost binds duplicate short messages monotonically without LIB_READ_NATIVE_ID_UNAVAILABLE', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  f.chat.message = [
    { role: 'user', chatId: 'u1', data: '응' },
    { role: 'char', chatId: 'a1', data: '첫 번째 응답입니다.' },
    { role: 'user', chatId: 'u2', data: '응' },
    { role: 'char', chatId: 'a2', data: '두 번째 응답입니다.' },
    { role: 'user', chatId: 'u3', data: '지금 입력입니다.' }
  ];
  const reqMessages = [
    { role: 'user', content: '응' },
    { role: 'assistant', content: '첫 번째 응답입니다.' },
    { role: 'user', content: '응' },
    { role: 'assistant', content: '두 번째 응답입니다.' },
    { role: 'user', content: '지금 입력입니다.' }
  ];
  const res = await f.host.plugin.debugCaptureLibNativeReadSetFromHost({
    messages: reqMessages,
    settings: { mode: 'normal', writingMode: 'novel', enableCharacterAide: false, enableWorldAide: false, enablePlotAide: false },
    baseRecent: { latestUser: '지금 입력입니다.' },
    scope: { characterId: f.character.chaId, chatId: f.chat.id }
  });
  assert.equal(res.messages[0].chatId, 'u1');
  assert.equal(res.messages[2].chatId, 'u2');
  assert.equal(res.messages[4].chatId, 'u3');
  assert.ok(res.snapshot && res.snapshot.currentInput.includes('지금 입력입니다.'));
});

test('2) HUD LOC|광안리 근처 모텔 2층 방|bg_officetel_day|맑음 classifies as private motel, never workplace', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'motel-fix-1',
    profileGenders: { 천하연: 'female', 천소연: 'female', 푸딩: 'male' },
    recent: {
      latestUser: '푸딩은 허리춤을 풀고 바지를 내렸다. 하연이 손가락으로 그의 남성기를 감싸고 비비기 시작했다.',
      visibleMessages: [
        {
          role: 'assistant',
          content: '소연이 시트를 끌어올렸다.\n\n◈CG\nTIME|2027.04.26(월)|12:10|출근일\nLOC|광안리 근처 모텔 2층 방|bg_officetel_day|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈'
        }
      ]
    }
  });
  assert.ok(pkt.externalReaction);
  assert.equal(pkt.externalReaction.spaceType, 'private');
  assert.equal(pkt.externalReaction.place, '광안리 근처 모텔 2층 방');
  assert.doesNotMatch(pkt.externalReaction.place, /교실|사무실|연구실/);
});

test('3-6) gender-filtered gauges, off-scene exclusion, persona ejaculation, and post-reading updates', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const scopeKey = 'motel-fix-2';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const settings = {
    enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'],
    mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'novel'
  };

  // Seed cards: 천하연(female), 천소연(female), 민태오(male, off-scene)
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: 'lore' },
        { name: '천소연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: 'lore' },
        { name: '민태오', gender: 'male', sensitive_zones: '귀두', dull_zones: '', basis: 'lore' }
      ]
    }
  });

  const pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 천하연: 'female', 천소연: 'female', 민태오: 'male', 푸딩: 'male' },
    recent: {
      latestUser: '푸딩은 허리춤을 풀고 바지를 내렸다. 하연은 포복해서 그의 하체에 다가가 남성기를 감싼 천을 내리고 손가락으로 감싸고 비비기 시작했다.',
      visibleMessages: [
        { role: 'assistant', content: '민태오는 어제 카페에서 나갔다.' },
        { role: 'assistant', content: '소연이 하연의 이마에 손을 댔다.' },
        { role: 'assistant', content: '모텔 2층 방 안에서 조용히 숨을 골랐다.\n◈CG\nLOC|광안리 근처 모텔 2층 방|bg_officetel_day|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈' }
      ]
    }
  });

  // 4) Off-scene 민태오 must NOT be in gauges
  assert.equal(pkt.gauges.some(g => g.name === '민태오'), false, 'off-scene 민태오 excluded');

  // 3) Female characters must NOT get penis_shaft_scrotum / 음경 stimulation
  const hayeon = pkt.gauges.find(g => g.name === '천하연');
  const soyeon = pkt.gauges.find(g => g.name === '천소연');
  assert.ok(hayeon && soyeon);
  assert.equal(hayeon.showClimax, true);
  assert.equal(hayeon.showEjac, false);
  assert.equal(hayeon.stimulatedParts.length, 0, 'giver-only 천하연 has no received stimulation');
  assert.ok(!hayeon.zoneDeltas.penis_shaft_scrotum, 'female must not get penis zoneDelta');
  assert.match(hayeon.line, /do NOT claim their climax\/ejaculation is rising/);

  // 6) Persona 푸딩 IS included with male ejaculation gauge
  const pudding = pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(pudding, 'active persona 푸딩 included in encounter gauges');
  assert.equal(pudding.gender, 'male');
  assert.equal(pudding.showEjac, true);
  assert.equal(pudding.showClimax, false);
  assert.ok(pudding.ejaculationGauge > 0, '푸딩 ejaculation gauge rises from handjob');

  // Post-reading update for 천소연 self-stimulation
  const rec = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [
        { participant: '천하연', phase: 'foreplay', position: '', summary: '손으로 음경을 감싸 위아래로 훑는 중' },
        { participant: '천소연', phase: 'foreplay', position: '', summary: '시트 아래에서 스스로를 자극하며 얕은 숨을 내쉬는 상태' },
        { participant: '푸딩', phase: 'foreplay', position: '', summary: '수음 자극에 허리가 들썩이는 상태' }
      ],
      intimacyProfiles: []
    }
  });
  const soyeonCard = rec.cards.find(c => c.name === '천소연');
  assert.ok(soyeonCard.zoneStats.clitoris_vulva.development > 0, '천소연 clitoris_vulva develops from self-stimulation reading');
  assert.equal(soyeonCard.zoneStats.penis_shaft_scrotum.development, 0, 'female card never develops penis zone');
});

test('4-5) off-scene male gauge shows 사정 (not 절정) when present, and World Sim persists events + profile/contraception/pregnancy + male restriction', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  await f.host.plugin.debugWorldSimLoadLogs();
  const scopeKey = 'wsim-fix-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');

  const settings = {
    enableWorldDynamicsAide: true,
    enableIntimacyAide: true,
    enableCharacterAide: true,
    enableWorldAide: true,
    aideStageOrder: ['aide_character', 'aide_world', 'aide_world_dynamics'],
    mode: 'normal',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'direct',
    writingMode: 'novel',
    worldSimulatorMaleRestriction: 'none'
  };

  // Seed cards for off-scene cast: 천소연(female), 민태오(male)
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천소연', gender: 'female', sensitive_zones: '질내', dull_zones: '', basis: 'lore' },
        { name: '민태오', gender: 'male', sensitive_zones: '귀두', dull_zones: '', basis: 'lore' }
      ]
    }
  });

  // Record a surfaced off-scene intimate event via aide_world_dynamics
  const wRec = f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_world_dynamics',
    settings,
    parsed: {
      worldReadings: [
        {
          movement: '민태오·천소연 숙소 밀회',
          status: 'surfaced',
          summary: '두 사람이 모텔 3층 방에서 피임 없이 관계를 맺었다.',
          actors: ['민태오', '천소연'],
          place: '모텔 3층 방',
          cause: '연수원 회식 후 단둘이 남음',
          kind: 'offscene_intimacy',
          intimate_outcome: {
            occurred: true,
            zones: ['vaginal_canal', 'penis_glans'],
            contraception: 'none'
          }
        }
      ]
    }
  });

  assert.equal(wRec.logs.length, 1, 'persistent off-scene event saved');
  assert.equal(wRec.logs[0].place, '모텔 3층 방');
  assert.equal(wRec.logs[0].cause, '연수원 회식 후 단둘이 남음');
  assert.equal(wRec.logs[0].intimate.contraception, 'none');
  assert.equal(wRec.logs[0].intimate.pregnancyChecked, true);
  assert.ok(['risk', 'conceived'].includes(wRec.logs[0].intimate.pregnancyOutcome));

  // Verify profile zoneStats updated anatomy-validly
  const soyeonCard = wRec.cards.find(c => c.name === '천소연');
  const taeoCard = wRec.cards.find(c => c.name === '민태오');
  assert.ok(soyeonCard.zoneStats.vaginal_canal.development > 0);
  assert.equal(soyeonCard.zoneStats.penis_glans.development, 0);
  assert.ok(taeoCard.zoneStats.penis_glans.development > 0);
  assert.equal(taeoCard.zoneStats.vaginal_canal.development, 0);

  // Verify storage persisted and packet injects [PERSISTENT OFF-SCENE RECORDS]
  const rawStored = f.values.get(WORLD_SIM_LOG_KEY) ?? f.local.get(WORLD_SIM_LOG_KEY);
  assert.ok(rawStored, 'world_sim_log:v1 persisted to storage');
  const wdPacket = f.host.plugin.debugWorldDynamicsPacket({
    settings,
    recent: { latestUser: '창밖을 바라본다.', visibleMessages: [{ role: 'assistant', content: '조용한 오후였다.' }] }
  });
  assert.match(wdPacket, /\[PERSISTENT OFF-SCENE RECORDS\]/);
  assert.match(wdPacket, /모텔 3층 방/);

  // Verify Male NPC restriction settings round-trip + prompt injection + cast filtering
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    worldSimulatorMaleRestriction: 'no_interaction'
  });
  const reloaded = await f.host.plugin.getRuntimeSettings();
  assert.equal(reloaded.worldSimulatorMaleRestriction, 'no_interaction');

  const restrictedBlock = f.host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world_dynamics',
    settings: { ...settings, worldSimulatorMaleRestriction: 'no_interaction' },
    recent: {
      latestUser: '거실에 혼자 앉아 있다.',
      offSceneCast: ['민태오', '천소연'],
      visibleMessages: [{ role: 'assistant', content: '거실은 조용했다.' }]
    }
  });
  assert.match(restrictedBlock, /\[OFF-SCENE MALE NPC RESTRICTION\]/);
  assert.match(restrictedBlock, /Off-scene male NPCs must NOT act autonomously/);
  assert.doesNotMatch(restrictedBlock, /Off-scene cast pool:.*민태오/);
  assert.match(restrictedBlock, /Off-scene cast pool:.*천소연/);

  const noRomanceBlock = f.host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world_dynamics',
    settings: { ...settings, worldSimulatorMaleRestriction: 'no_romance' },
    recent: {
      latestUser: '거실에 혼자 앉아 있다.',
      offSceneCast: ['민태오', '천소연'],
      visibleMessages: [{ role: 'assistant', content: '거실은 조용했다.' }]
    }
  });
  assert.match(noRomanceBlock, /\[OFF-SCENE MALE NPC RESTRICTION\]/);
  assert.match(noRomanceBlock, /must NOT develop romantic or sexual relationships/);

  // Non-person lorebook/system headings like Rules, System, Settings, 규칙, 세계관 must be excluded from off-scene cast
  const nonPersonFiltered = f.host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world_dynamics',
    settings: { ...settings, worldSimulatorMaleRestriction: 'none' },
    recent: {
      latestUser: '거실에 혼자 앉아 있다.',
      offSceneCast: ['Rules', 'System', 'Settings', '규칙', '세계관', '정현석', '이지원', '구민지', '주시후'],
      visibleMessages: [{ role: 'assistant', content: '거실은 조용했다.' }]
    }
  });
  assert.doesNotMatch(nonPersonFiltered, /Off-scene cast pool:.*(?:Rules|System|Settings|규칙|세계관)/);
  assert.match(nonPersonFiltered, /Off-scene cast pool:.*정현석, 이지원, 구민지, 주시후/);
});
