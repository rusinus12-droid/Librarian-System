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

test('7) multi-turn initiator ejaculation, female prose arousal, zone sensitivity/development, and reroll safety', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const scopeKey = 'puding-5turn-regression';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const settings = {
    enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'],
    mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'explicit', writingMode: 'rp'
  };
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' },
        { name: '천소연', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' }
      ]
    }
  });

  const hud = '\n◈CG\nTIME|2027.03.10(수)|23:10\nLOC|자매네 침실|bg_bedroom|clear\n@|천하연\n@|천소연\n◈';
  const turns = [
    {
      user: '푸딩은 양손의 손가락을 소연과 하연의 질내에 천천히 집어넣고 질벽을 살살 만졌다.',
      assistant: '두 손이 동시에 움직였다. 하연 쪽은 첫 마디부터 붙잡았다. 안쪽 살이 손가락을 감아 쥐는 힘이 분명했다. 하연의 숨이 목에서 끊겼다. 하연의 허리가 시트에서 떨어졌다.'
    },
    {
      user: '푸딩은 허리춤을 풀고 바지를 내렸다. 아직 천에 갇힌 남성기는 존재감을 드러내고 있었다. 하연은 몸을 일으켜 포복해서 그의 하체에 다가가 그것을 감싼 천을 내렸다. "한 번 빼줄게." 그녀의 손가락이 그것을 감싸고 비비기 시작했다.',
      assistant: '하연의 손이 그의 위에 감겨 움직였다.'
    },
    {
      user: '소연은 하연을 뒤에서 안고 하연의 옷을 한 꺼풀씩 벗겨냈다. 반쯤 벗겨내고 나서는 한 손으로는 언니의 가슴을, 한 손으로는 언니의 외음핵을 애무했다. 하연은 여전히 푸딩의 자지를 자극하고 있었다.',
      assistant: '소연이 언니의 뒤에서 물러나 앉았다.'
    },
    {
      user: '푸딩은 더 이상 참지 못하고 하연을 침대에 밀어넘어뜨리고 그녀의 양다리를 잡아 벌리고 잔뜩 화난 남성기를 질에 넣었다.',
      assistant: '하연의 다리는 아직 접힌 채 들려 있었다. 그녀의 배가 한 번 오므라들었다가 풀렸다.'
    },
    {
      user: '푸딩의 움직임이 격해진다. 곧 사정할 듯하다.',
      assistant: ''
    }
  ];

  const visible = [];
  const snapshots = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const recent = {
      latestUser: turn.user,
      visibleMessages: [...visible, { role: 'user', content: turn.user }],
      previousTurnUser: i > 0 ? turns[i - 1].user : '',
      latestAssistant: i > 0 ? (turns[i - 1].assistant + hud) : ''
    };
    const pkt = f.host.plugin.debugIntimacyPacket({
      characterName: 'ClauGem',
      personaName: '푸딩',
      scopeKey,
      profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
      recent,
      settings
    });
    f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings, parsed: { intimacyReadings: [] } });
    snapshots.push({ pkt, cards: pkt.cards });
    visible.push({ role: 'user', content: turn.user });
    if (turn.assistant) visible.push({ role: 'assistant', content: turn.assistant + hud });
  }

  // Turn 1: both females rise even before HUD; male stays 0
  const t1Hayeon = snapshots[0].pkt.gauges.find(g => g.name === '천하연');
  const t1Soyeon = snapshots[0].pkt.gauges.find(g => g.name === '천소연');
  const t1Puding = snapshots[0].pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(t1Hayeon && t1Hayeon.climaxGauge > 0);
  assert.ok(t1Soyeon && t1Soyeon.climaxGauge > 0);
  assert.equal(t1Puding?.ejaculationGauge, 0);

  // Turn 2: pudding ejaculation rises from handjob; assistant prose arousal + no false 'clear' ears zone
  const t2Puding = snapshots[1].pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(t2Puding && t2Puding.ejaculationGauge > 0);
  assert.equal(snapshots[1].cards.find(c => c.name === '천하연').zoneStats.ears.development, 0, 'HUD bg_bedroom|clear must not match ears');

  // Turn 3: '언니의 가슴을 ... 외음핵을' credits 천하연 only; '푸딩의 자지를 자극' raises 푸딩 WITHOUT breasts_nipples
  const t3Hayeon = snapshots[2].pkt.gauges.find(g => g.name === '천하연');
  const t3Soyeon = snapshots[2].pkt.gauges.find(g => g.name === '천소연');
  const t3Puding = snapshots[2].pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(t3Hayeon.climaxGauge > snapshots[1].pkt.gauges.find(g => g.name === '천하연').climaxGauge);
  assert.ok(!t3Soyeon.stimulatedParts.length, 'actor 천소연 must not get 천하연 breast/clit credit');
  assert.ok(t3Puding.ejaculationGauge > t2Puding.ejaculationGauge);
  assert.ok(!t3Puding.zoneDeltas?.breasts_nipples, 'male initiator must not receive female breasts_nipples credit');

  // Turn 4: '남성기를 질에 넣었다' engages intercourse and raises BOTH 푸딩 & 천하연
  assert.equal(snapshots[3].pkt.scene.phase, 'intercourse');
  const t4Hayeon = snapshots[3].pkt.gauges.find(g => g.name === '천하연');
  const t4Puding = snapshots[3].pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(t4Hayeon.lastTurnDeltaClimax > 0);
  assert.ok(t4Puding.lastTurnDeltaEjac > 0);

  // Turn 5: '푸딩의 움직임이 격해진다. 곧 사정할 듯하다.' drives 푸딩 to brink/climax (>=80) and continues 천하연 climax
  const t5Hayeon = snapshots[4].pkt.gauges.find(g => g.name === '천하연');
  const t5Puding = snapshots[4].pkt.gauges.find(g => g.name === '푸딩');
  assert.ok(t5Puding.ejaculationGauge >= 80, `expected 푸딩 ejaculation >= 80, got ${t5Puding.ejaculationGauge}`);
  assert.ok(t5Hayeon.lastTurnDeltaClimax > 0 && t5Hayeon.climaxGauge >= 80);

  // Preference cards progressed in sensitivity & development
  const finalHayeonCard = snapshots[4].cards.find(c => c.name === '천하연');
  assert.ok(finalHayeonCard.zoneStats.vaginal_canal.development > 2);
  assert.ok(finalHayeonCard.zoneStats.vaginal_canal.sensitivity > 2);
  assert.ok(finalHayeonCard.zoneStats.clitoris_vulva.development > 0);

  // Reroll of Turn 5 must NOT double-count zoneStats or gauges
  const devBeforeReroll = finalHayeonCard.zoneStats.vaginal_canal.development;
  const sensBeforeReroll = finalHayeonCard.zoneStats.vaginal_canal.sensitivity;
  const rerollRecent = {
    latestUser: turns[4].user,
    visibleMessages: [...visible.slice(0, -1), { role: 'user', content: turns[4].user }],
    previousTurnUser: turns[3].user,
    latestAssistant: turns[3].assistant + hud
  };
  const rerollPkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem', personaName: '푸딩', scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' }, recent: rerollRecent, settings
  });
  f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings, parsed: { intimacyReadings: [] } });
  const cardAfterReroll = rerollPkt.cards.find(c => c.name === '천하연');
  assert.equal(rerollPkt.gauges.find(g => g.name === '푸딩').ejaculationGauge, t5Puding.ejaculationGauge);
  assert.equal(cardAfterReroll.zoneStats.vaginal_canal.development, devBeforeReroll);
  assert.equal(cardAfterReroll.zoneStats.vaginal_canal.sensitivity, sensBeforeReroll);
});

test('8) multi-stage same-run telemetry preservation: later aide_world and aide_plot do not clobber aide_character readings', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  // Full multi-stage beforeRequest run using fixture cast 민아 (female) & 준호 (male) via HUD
  const stagePrompts = {};
  f.controls.onModel = (_idx, body) => {
    const sys = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const stage = (sys.match(/"stage":\s*"([^"]+)"/) || [])[1] || '';
    stagePrompts[stage] = (stagePrompts[stage] || '') + '\n' + body.messages.map(m => m.content).join('\n');
    const extras = stage === 'aide_character' ? {
      intimacy_profiles: [
        { name: '민아', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' },
        { name: '준호', gender: 'male', sensitive_zones: '', dull_zones: '', basis: 'lore' }
      ],
      intimacy_readings: [
        { participant: '준호', phase: 'foreplay', position: '', summary: '긴장한 채 숨을 고르는 상태' },
        { participant: '민아', phase: 'foreplay', position: '', summary: '긴장한 채 숨을 고르는 상태' }
      ],
      intimacy_body_responses: [
        { name: '준호', zone: 'penis_shaft_scrotum', physical: '단단하게 팽팽해지며 숨이 거칠어짐', reaction: '허리가 미세하게 들썩임' },
        { name: '민아', zone: 'breasts_nipples', physical: '유두가 굳어지며 떨림', reaction: '작게 신음을 삼킴' }
      ]
    } : {};
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_analysis_v4', stage,
        ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {},
        rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...extras
      });
    } else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage,
        ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {},
        rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], edits: [], ...extras
      });
    } else {
      f.controls.output = '민아의 손길이 이어졌다.';
    }
  };
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', writing_mode: 'rp', nsfw_mode: 'direct', nsfwGuidanceEnabled: true,
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true,
    enable_world_aide: true, enable_plot_aide: true, enable_intimacy_aide: true,
    failure_mode: 'hard', lore_activation_mode: 'off'
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_intimacy: { ...(slots.aide_intimacy || {}), enabled: true } });

  f.chat.message.push(
    { role: 'char', chatId: 'a-ms-1', data: '민아가 침대 위에서 숨을 골랐다.\n◈CG\nLOC|자매네 침실|bg_bedroom|clear\n@|민아\n@|준호\n◈' },
    { role: 'user', chatId: 'u-ms-2', data: '준호는 민아의 가슴을 만졌다.' }
  );
  await f.host.hooks.beforeRequest(
    f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    'model'
  );
  await new Promise(r => setTimeout(r, 25));
  const actualScope = f.host.plugin.debugActiveScopeKey();
  const reloaded = await f.host.plugin.debugGaugeContinuityLoad();
  const settledAll = reloaded.intimacyGauges?.[actualScope]?.settled || {};
  const settledJunho = Object.values(settledAll).find(v => v.name === '준호');
  const settledMina = Object.values(settledAll).find(v => v.name === '민아');
  assert.ok(settledJunho && settledJunho.gender === 'male' && settledJunho.ejaculation > 0, 'settled male ejaculation preserved after aide_world and aide_plot');
  assert.ok(settledMina && settledMina.climax > 0, 'settled female climax preserved after aide_world and aide_plot');
  assert.match(stagePrompts.aide_world || '', /사정 수치\(ejaculation\): [1-9]/, 'aide_world saw settled post-reading male gauge instead of clobbering it');
  assert.match(stagePrompts.aide_plot || '', /사정 수치\(ejaculation\): [1-9]/, 'aide_plot saw settled post-reading male gauge instead of clobbering it');
});
