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

test('9) LIB-backed menstruation overrides stale/random cycle guesses without leaking raw LIB text', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const secretToken = 'SECRET_LIB_RAW_STRING_9918';
  const libBlock = `2026-11-22 천하연은 생리 중이라 하복부 통증을 느끼며 생리대를 갈았다. (${secretToken})`;
  const settings = {
    writing_mode: 'rp',
    bodyStateCards: {
      'lib-period-9': [
        { name: '천하연', gender: 'female', lastPeriodStart: '2026-11-09', cycleLength: 28 }
      ]
    },
    npcDisposition: {
      'lib-period-9': {
        default: 'like',
        npcs: [{ name: '천하연', level: 'affection', note: '나른하고 무심하지만 정에 약한 고양이 같은 성격' }]
      }
    }
  };

  const pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'lib-period-9',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings,
    libEvidence: libBlock,
    recent: {
      visibleMessages: [
        { role: 'char', content: '천하연이 침대 끝에 기대 푸딩을 바라봤다.' }
      ],
      latestUser: '푸딩은 천하연의 허리를 감싸 안고 그대로 안으로 삽입했다.'
    }
  });

  assert.equal(pkt.contraception.length, 1);
  const verdict = pkt.contraception[0];
  assert.equal(verdict.cycleWindow, 'menstrual_safe');
  assert.equal(verdict.cycleSource, 'LIB 기록');
  assert.equal(verdict.stanceCode, 'safe_day_allow');
  assert.doesNotMatch(JSON.stringify(pkt), new RegExp(secretToken), 'raw LIB text never leaks into intimacy packet');

  const bodyPkt = f.host.plugin.debugBodyStatePacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'lib-period-9-body',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    libText: '천하연은 생리 중이다. 생리통으로 몸이 조금 무겁다.',
    settings: { mode: 'normal', writing_mode: 'rp', bodyStateCards: {} },
    recent: {
      visibleMessages: [{ role: 'char', content: '천하연이 이불을 끌어올렸다.' }],
      latestUser: '푸딩이 천하연 옆에 누웠다.'
    }
  });
  assert.match(bodyPkt, /→ menstrual;/, 'bodyStatePacket reports ongoing LIB menstruation instead of auto fixed-seed fertile guess');
  assert.doesNotMatch(bodyPkt, /auto \(fixed seed/, 'ongoing LIB menstruation overrides auto fixed-seed cycle calculation');
});

test('10) rubber condom/slippage recognition, prior-encounter isolation, no-phantom-condom lock, and resigned "밖에." withdrawal', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const baseArgs = {
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'condom-fix-10',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: {
        'condom-fix-10': { default: 'like', npcs: [{ name: '천하연', level: 'like', note: '나른하고 솔직한 편' }] }
      }
    }
  };

  // 10a: Rubber euphemism rolling down to base -> protected condom
  const rolledPkt = f.host.plugin.debugIntimacyPacket({
    ...baseArgs,
    recent: {
      visibleMessages: [{ role: 'char', content: '고무가 팽팽하게 늘어나며 밑으로 굴러 내려갔다. 곧 뿌리까지 덮이고 천하연과 숨결이 얽혔다.' }],
      latestUser: '푸딩이 천하연의 안으로 천천히 삽입했다.'
    }
  });
  assert.equal(rolledPkt.contraception[0].method, 'condom');
  assert.equal(rolledPkt.contraception[0].protected, true);
  assert.equal(rolledPkt.contraception[0].stanceCode, 'protected_confirmed');

  // 10b: Rubber bunched at base exposing lower shaft skin while glans stays covered -> condom_slip_risk (NOT definitive failure)
  const slippedPkt = f.host.plugin.debugIntimacyPacket({
    ...baseArgs,
    recent: {
      visibleMessages: [
        { role: 'char', content: '푸딩이 천하연의 안으로 삽입해 허리를 움직였다.' },
        { role: 'char', content: '푸딩이 그 자리를 내려다봤다. 고무가 밑동 쪽으로 뭉쳐 있었다. 한참을 움직인 탓이었다. 뭉친 자리 아래로 맨살이 조금 드러나 있었다.' }
      ],
      latestUser: '푸딩은 천하연의 허리를 잡은 채 멈칫하며 숨을 삼켰다.'
    }
  });
  assert.equal(slippedPkt.contraception[0].method, 'condom_slip_risk');
  assert.equal(slippedPkt.contraception[0].protected, false);
  assert.equal(slippedPkt.contraception[0].stanceCode, 'condom_slip_risk_check');
  assert.match(slippedPkt.contraception[0].promptDirective, /이탈 위험|귀두|완전한 피임 실패|노콘|생으로/);

  // 10c: Resolved previous encounter condom must NOT carry into a new bare encounter + continuity lock active
  const isolatedPkt = f.host.plugin.debugIntimacyPacket({
    ...baseArgs,
    recent: {
      visibleMessages: [
        { role: 'char', content: '푸딩은 콘돔을 끼우고 천하연을 안았다.' },
        { role: 'char', content: '한참 뒤 두 사람은 옷을 다 챙겨 입고 방을 나섰다.' },
        { role: 'char', content: '다음 날 밤, 침대 위에서 천하연이 시트를 쥐었다.' }
      ],
      latestUser: '푸딩이 아무 준비도 없이 바로 허리를 붙여 천하연의 안으로 삽입했다.'
    }
  });
  assert.equal(isolatedPkt.contraception[0].method, 'none_implicit');
  assert.equal(isolatedPkt.contraception[0].protected, false);
  assert.match(isolatedPkt.contraception[0].promptDirective, /연속성 잠금.*콘돔/);

  // 10d: Resigned terse "밖에." cue -> withdrawal
  const withdrawalPkt = f.host.plugin.debugIntimacyPacket({
    ...baseArgs,
    recent: {
      visibleMessages: [
        { role: 'char', content: '푸딩이 그대로 안으로 삽입하자 천하연이 나른한 한숨을 흘리며 낮게 읊조렸다.\n"……밖에."' }
      ],
      latestUser: '푸딩이 움직임을 멈칫하며 천하연을 바라봤다.'
    }
  });
  assert.equal(withdrawalPkt.contraception[0].method, 'withdrawal');
  assert.equal(withdrawalPkt.contraception[0].protected, false);
  assert.match(withdrawalPkt.contraception[0].promptDirective, /밖에\.|질외/);
});

test('11) Contraception/menstruation directives diversify reaction tone per character lore', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });

  const lazyPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'lore-div-lazy',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    libEvidence: '천하연은 생리 중이다.',
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'lore-div-lazy': { default: 'like', npcs: [{ name: '천하연', level: 'like', note: '나른하고 무심하며 체념이 빠른 고양이 같은 성격, 직설적' }] } }
    },
    recent: {
      visibleMessages: [{ role: 'char', content: '천하연과 푸딩의 숨결이 얽혔다.' }],
      latestUser: '푸딩이 콘돔 없이 천하연의 안으로 천천히 삽입했다.'
    }
  });

  const shyPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '서윤',
    personaName: '푸딩',
    scopeKey: 'lore-div-shy',
    profileGenders: { 서윤: 'female', 푸딩: 'male' },
    libEvidence: '서윤은 생리 중이다.',
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'lore-div-shy': { default: 'like', npcs: [{ name: '서윤', level: 'like', note: '수줍음이 많고 내성적이며 조심스러운 성격' }] } }
    },
    recent: {
      visibleMessages: [{ role: 'char', content: '서윤과 푸딩의 숨결이 얽혔다.' }],
      latestUser: '푸딩이 콘돔 없이 서윤의 안으로 천천히 삽입했다.'
    }
  });

  const strictPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '진아',
    personaName: '푸딩',
    scopeKey: 'lore-div-strict',
    profileGenders: { 진아: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'lore-div-strict': { default: 'like', npcs: [{ name: '진아', level: 'like', note: '원칙적이고 계획적이며 이성적인 성격' }] } }
    },
    recent: {
      visibleMessages: [{ role: 'char', content: '진아와 푸딩의 숨결이 얽혔다.' }],
      latestUser: '푸딩이 콘돔 없이 진아의 안으로 천천히 삽입했다.'
    }
  });

  const lazyDir = lazyPkt.contraception[0].promptDirective;
  const shyDir = shyPkt.contraception[0].promptDirective;
  const strictDir = strictPkt.contraception[0].promptDirective;

  assert.doesNotMatch(lazyDir, /수줍게 속삭이며/, 'lazy/blunt character never forced into cookie-cutter shyness');
  assert.match(lazyDir, /나른한 한숨|체념|직설/);
  assert.match(shyDir, /머뭇거림|붉어진|조심스러운 속삭임/);
  assert.match(strictDir, /이성적 경계|현실적 위험/);
  assert.notEqual(lazyDir, shyDir);
});

test('12) Lore-based male genitalia size estimation, persistent recording, and female penetrative stimulation scaling', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });

  // 12a: Lore estimator unit checks + stature/height false-positive guard
  const cmEst = f.host.plugin.debugEstimateMaleSizeFromLore({ name: '푸딩', loreText: '남성기 19.5cm의 거근' });
  assert.equal(cmEst.size, 'very_large');
  assert.equal(cmEst.cm, 19.5);

  assert.equal(f.host.plugin.debugEstimateMaleSizeFromLore({ name: '준호', loreText: '평균 이하의 작은 물건을 가진 편' }).size, 'small');
  assert.equal(f.host.plugin.debugEstimateMaleSizeFromLore({ name: '민수', loreText: '극소 왜소 콤플렉스가 있다.' }).size, 'very_small');
  assert.equal(f.host.plugin.debugEstimateMaleSizeFromLore({ name: '태오', loreText: '키 183cm의 평범한 회사원이다.' }).size, 'average');
  const muscular = f.host.plugin.debugEstimateMaleSizeFromLore({ name: '강현', loreText: '190cm 건장한 근육질 체격의 격투기 선수' });
  assert.ok(['large', 'very_large'].includes(muscular.size));
  assert.equal(f.host.plugin.debugEstimateMaleSizeFromLore({ name: '지민', loreText: '단신에 왜소한 체격의 미소년' }).size, 'small');
  assert.equal(f.host.plugin.debugEstimateMaleSizeFromLore({ name: '무명', loreText: '' }).size, 'average');

  // 12b: Male persona size estimated from lore is recorded in debugIntimacyMaleSizes without creating an RP persona preference card
  const autoPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'male-size-auto-12',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    recent: {
      personaText: '푸딩은 대물 거근으로 알려져 있다.',
      visibleMessages: [{ role: 'char', content: '천하연이 침대 위에서 푸딩을 바라보았다.' }],
      latestUser: '푸딩이 천하연의 안으로 깊이 삽입해 허리를 움직였다.'
    }
  });
  const recorded = f.host.plugin.debugIntimacyMaleSizes({ scopeKey: 'male-size-auto-12' });
  const pudingEntry = Object.values(recorded).find(item => item?.name === '푸딩');
  assert.ok(pudingEntry && pudingEntry.size === 'very_large', 'male persona size recorded persistently');
  const autoFemale = autoPkt.gauges.find(g => g.name === '천하연');
  assert.equal(autoFemale.partnerSizeModifier?.size, 'very_large');
  assert.match(autoFemale.line, /남성기/);
  const loadedAfterAuto = await f.host.plugin.debugIntimacyLoadCards();
  assert.equal((loadedAfterAuto['male-size-auto-12'] || []).some(c => c.name === '푸딩'), false, 'RP mode does not pollute preference cards with a persona card');

  // 12c: User-set male size (origin === 'user') is preserved against subsequent lore/profile overwrites
  await f.host.plugin.debugSetIntimacyMaleSize({
    scopeKey: 'male-size-user-lock',
    name: '강현',
    size: 'small',
    cm: 11,
    basis: '사용자 직접 설정'
  });
  const novelIntimacySettings = {
    ...(await f.host.plugin.getRuntimeSettings()),
    mode: 'normal',
    writingMode: 'novel',
    nsfwMode: 'direct',
    nsfwGuidanceEnabled: true,
    enableCharacterAide: true,
    enableIntimacyAide: true
  };
  const recAfterLock = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: novelIntimacySettings,
    parsed: {
      intimacyReadings: [{ participant: '강현', phase: 'intercourse', position: '정상위', summary: '강현이 움직였다.' }],
      intimacyProfiles: [{
        name: '강현',
        gender: 'male',
        male_size: 'very_large',
        male_size_cm: 21,
        male_size_basis: '임의 로어',
        liked_positions: '정상위',
        disliked_positions: '',
        sensitive_zones: '귀두',
        dull_zones: '',
        zone_defaults: [{ zone: 'penis_glans', sensitivity: 40, development: 30 }],
        foreplay_stance: 'likes',
        foreplay_style: '차분함',
        intercourse_stance: 'likes',
        intercourse_style: '꾸준함',
        afterplay_stance: 'likes',
        afterplay_style: '다정함',
        basis: '테스트'
      }]
    }
  });
  const lockedEntry = Object.values(f.host.plugin.debugIntimacyMaleSizes({ scopeKey: 'male-size-user-lock' })).find(item => item?.name === '강현');
  assert.equal(lockedEntry?.size, 'small', 'user-set male size must not be overwritten by subsequent lore estimate');
  assert.equal(recAfterLock.cards.find(c => c.name === '강현')?.maleSize, 'small', 'newly created card inherits user-locked size');

  // 12d: Monotonic female penetrative stimulation scaling across all 5 tiers + non-penetrative foreplay invariance
  const deltas = {};
  const lubs = {};
  const foreplayDeltas = {};
  for (const tier of ['very_small', 'small', 'average', 'large', 'very_large']) {
    const sk = `male-size-scale-${tier}`;
    await f.host.plugin.debugSetIntimacyMaleSize({ scopeKey: sk, name: '푸딩', size: tier });
    const penPkt = f.host.plugin.debugIntimacyPacket({
      characterName: '천하연',
      personaName: '푸딩',
      scopeKey: sk,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      recent: {
        visibleMessages: [{ role: 'char', content: '천하연이 시트를 움켜쥐며 푸딩을 받아들였다.' }],
        latestUser: '푸딩이 천하연의 질내 깊숙이 삽입해 허리를 움직였다.'
      }
    });
    const fGauge = penPkt.gauges.find(g => g.name === '천하연');
    deltas[tier] = fGauge.climaxGauge;
    lubs[tier] = fGauge.lubricationGauge;

    const skForeplay = `male-size-foreplay-${tier}`;
    await f.host.plugin.debugSetIntimacyMaleSize({ scopeKey: skForeplay, name: '푸딩', size: tier });
    const forePkt = f.host.plugin.debugIntimacyPacket({
      characterName: '천하연',
      personaName: '푸딩',
      scopeKey: skForeplay,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      recent: {
        visibleMessages: [{ role: 'char', content: '천하연이 작게 숨을 삼켰다.' }],
        latestUser: '푸딩이 천하연의 입술에 키스하고 가슴을 부드럽게 애무했다.'
      }
    });
    foreplayDeltas[tier] = forePkt.gauges.find(g => g.name === '천하연').climaxGauge;
  }

  assert.ok(deltas.very_small < deltas.small, `expected very_small (${deltas.very_small}) < small (${deltas.small})`);
  assert.ok(deltas.small < deltas.average, `expected small (${deltas.small}) < average (${deltas.average})`);
  assert.ok(deltas.average < deltas.large, `expected average (${deltas.average}) < large (${deltas.large})`);
  assert.ok(deltas.large < deltas.very_large, `expected large (${deltas.large}) < very_large (${deltas.very_large})`);
  assert.ok(lubs.very_small < lubs.average && lubs.average < lubs.very_large, `expected lubrication monotonic (${JSON.stringify(lubs)})`);
  assert.equal(foreplayDeltas.very_small, foreplayDeltas.very_large, 'non-penetrative foreplay stimulation must not change with male genitalia size');
});

test('13) Climax vocalization directives, chronological condom re-wear, bystander exclusion, and personality×affection contraception reactions', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });

  // 13a: Chronological condom re-wear after base bunching ("고무가 밑동 쪽으로 몰려... 아까 그때. 다시 끼웠어.") -> protected condom
  const rewearPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'condom-rewear-13a',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'condom-rewear-13a': { default: 'like', npcs: [{ name: '천하연', level: 'like', note: '나른하고 솔직한 편' }] } }
    },
    recent: {
      visibleMessages: [
        { role: 'char', content: '고무가 밑동 쪽으로 몰려 접혀 있었다. 푸딩이 "아까 그때. 다시 끼웠어."라고 말하며 하연의 안으로 삽입했다.' }
      ],
      latestUser: '푸딩이 움직임을 이어갔다.'
    }
  });
  assert.equal(rewearPkt.contraception[0].method, 'condom');
  assert.equal(rewearPkt.contraception[0].protected, true);
  assert.equal(rewearPkt.contraception[0].stanceCode, 'protected_confirmed');
  assert.match(rewearPkt.contraception[0].promptDirective, /재착용|확인됨/);

  // 13b: Multi-female bystander exclusion (BOTH females in femaleNpcGauges so multi-female branch runs; only 천하연 penetrated; 천소연 watches/speaks nearby)
  await f.host.plugin.debugIntimacyLoadCards();
  f.host.plugin.debugSetActiveScope('bystander-exclude-13b', '푸딩');
  const cardSeedSettings = {
    enableIntimacyAide: true,
    enableCharacterAide: true,
    aideStageOrder: ['aide_character'],
    mode: 'normal',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'direct',
    writingMode: 'rp'
  };
  const seededRec = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: cardSeedSettings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', liked_positions: '정상위', disliked_positions: '', sensitive_zones: '질내', dull_zones: '', foreplay_stance: 'likes', foreplay_style: '차분함', intercourse_stance: 'likes', intercourse_style: '나른함', afterplay_stance: 'likes', afterplay_style: '다정함', basis: '테스트' },
        { name: '천소연', gender: 'female', liked_positions: '정상위', disliked_positions: '', sensitive_zones: '입술', dull_zones: '', foreplay_stance: 'likes', foreplay_style: '조심스러움', intercourse_stance: 'likes', intercourse_style: '차분함', afterplay_stance: 'likes', afterplay_style: '조용함', basis: '테스트' }
      ]
    }
  });
  assert.ok(seededRec.cards.some(c => c.name === '천하연') && seededRec.cards.some(c => c.name === '천소연'), 'both female cards seeded');
  const bystanderPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'bystander-exclude-13b',
    profileGenders: { 천하연: 'female', 천소연: 'female', 푸딩: 'male' },
    settings: {
      ...cardSeedSettings,
      writing_mode: 'rp',
      npcDisposition: { 'bystander-exclude-13b': { default: 'like', npcs: [{ name: '천하연', level: 'like' }, { name: '천소연', level: 'like' }] } }
    },
    recent: {
      visibleMessages: [
        { role: 'char', content: '잠시 전 푸딩이 천소연의 뺨에 입을 맞췄다. 이어서 푸딩이 하연의 안으로 삽입해 허리를 움직였다. 고무가 밑동 쪽으로 몰려 접혀 있었다.' },
        { role: 'char', content: '소연이 그 말을 들었다. 그녀의 손이 어깨에서 떨어졌다가 목덜미에 걸쳤다. 천소연이 천하연과 푸딩을 보며 물었다. "지금 그거, 진짜로 하는 말이지."' }
      ],
      latestUser: '푸딩은 하연의 허리를 쥔 채 숨을 삼켰다.'
    }
  });
  assert.ok(bystanderPkt.gauges.filter(g => g.gender === 'female').length >= 2, 'multi-female gauges branch actually executes');
  assert.equal(bystanderPkt.contraception.length, 1, 'contraception verdict issues ONLY for penetrated female');
  assert.equal(bystanderPkt.contraception[0].name, '천하연');

  // 13c: Genuine condom failure (tip torn / completely slipped off) branches across fierce vs meek vs high-affection trust
  const failRecentFor = name => ({
    visibleMessages: [
      { role: 'char', content: `푸딩이 콘돔을 끼우고 ${name}의 안으로 삽입해 움직이다가 콘돔 끝부분이 찢어져 완전히 벗겨졌다.` }
    ],
    latestUser: `푸딩이 멈칫하며 ${name}의 앞에서 찢어진 콘돔을 확인했다.`
  });
  const fierceFail = f.host.plugin.debugIntimacyPacket({
    characterName: '강서연',
    personaName: '푸딩',
    scopeKey: 'fail-fierce-13c',
    profileGenders: { 강서연: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'fail-fierce-13c': { default: 'like', npcs: [{ name: '강서연', level: 'like', note: '기가 세고 드세며 원칙적인 성격' }] } }
    },
    recent: failRecentFor('강서연')
  });
  assert.equal(fierceFail.contraception[0].method, 'condom_failed');
  assert.equal(fierceFail.contraception[0].stanceCode, 'condom_failed_fierce_resist');
  assert.match(fierceFail.contraception[0].promptDirective, /격렬한 제지·저항/);

  const meekFail = f.host.plugin.debugIntimacyPacket({
    characterName: '한유진',
    personaName: '푸딩',
    scopeKey: 'fail-meek-13c',
    profileGenders: { 한유진: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'fail-meek-13c': { default: 'like', npcs: [{ name: '한유진', level: 'like', note: '기가 약하고 소심하며 수줍음이 많은 편' }] } }
    },
    recent: failRecentFor('한유진')
  });
  assert.equal(meekFail.contraception[0].method, 'condom_failed');
  assert.equal(meekFail.contraception[0].stanceCode, 'condom_failed_meek_protest');
  assert.match(meekFail.contraception[0].promptDirective, /조용한 항의/);

  const trustFail = f.host.plugin.debugIntimacyPacket({
    characterName: '이채원',
    personaName: '푸딩',
    scopeKey: 'fail-trust-13c',
    profileGenders: { 이채원: 'female', 푸딩: 'male' },
    settings: {
      mode: 'normal',
      writing_mode: 'rp',
      npcDisposition: { 'fail-trust-13c': { default: 'affection', npcs: [{ name: '이채원', level: 'affection', note: '오래된 연인이자 깊은 신뢰를 보내는 다정한 성격' }] } }
    },
    recent: failRecentFor('이채원')
  });
  assert.equal(trustFail.contraception[0].method, 'condom_failed');
  assert.equal(trustFail.contraception[0].stanceCode, 'condom_failed_trust_accept');
  assert.match(trustFail.contraception[0].promptDirective, /책임질 거라면 괜찮아/);

  // 13d: Female climax 100/100 directive enforces involuntary vocalization matched to mouth state
  const scopeClimax = 'climax-vocal-13d';
  f.host.plugin.debugSetActiveScope(scopeClimax, '천하연');
  await f.host.plugin.debugIntimacySetCard({
    name: '천하연',
    patch: {
      gender: 'female',
      sensitiveZones: '질내·음핵',
      zoneStats: {
        vaginal_canal: { sensitivity: 95, development: 80 },
        clitoris_vulva: { sensitivity: 95, development: 80 }
      }
    }
  });
  let climaxPkt = null;
  const msgs13d = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    const uText = `(${turn}회차) 푸딩이 천하연의 질내 깊숙이 찔러대며 음핵을 강하게 몰아붙인다.`;
    climaxPkt = f.host.plugin.debugIntimacyPacket({
      characterName: '천하연',
      personaName: '푸딩',
      scopeKey: scopeClimax,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      recent: {
        visibleMessages: [...msgs13d],
        latestUser: uText
      }
    });
    msgs13d.push({ role: 'user', content: uText });
    msgs13d.push({ role: 'char', content: `(${turn}회차) 천하연이 숨을 헐떡이며 허리를 떨었다.` });
    if (climaxPkt.gauges.find(g => g.name === '천하연')?.climaxTriggeredThisTurn) break;
  }
  const fGauge = climaxPkt.gauges.find(g => g.name === '천하연');
  assert.equal(fGauge.climaxTriggeredThisTurn, true, 'climax triggers within intense escalating turns');
  assert.match(fGauge.line, /으으음|아아/);
  assert.match(climaxPkt.text, /으으음|아아/);

  // 13e: Debug log regression — pulling a bystander's arm + kissing while hips move into another female
  // must NEVER assign a contraception verdict to the foreplay/kiss bystander (천소연).
  const scopeSoyeon = 'soyeon-kiss-fix-13e';
  f.host.plugin.debugSetActiveScope(scopeSoyeon, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: { mode: 'normal', writing_mode: 'rp', writingMode: 'rp' },
    parsed: {
      intimacy_readings: [
        { name: '푸딩', phase: 'intercourse', position: '정상위', acts: ['삽입', '허리 움직임', '키스'], evidence: 'latest_user' },
        { name: '천하연', phase: 'climax', position: '정상위(아래)', acts: ['질내 삽입 수용', '절정'], evidence: 'recent' },
        { name: '천소연', phase: 'foreplay', position: '', acts: ['딥키스'], evidence: 'latest_user' }
      ],
      intimacy_body_responses: [
        { name: '천하연', zone: 'vaginal_canal', act: '삽입 수용', sensation: '충만감과 경련', intensity: 90, evidence: 'recent' },
        { name: '천소연', zone: 'lips_mouth', act: '키스', sensation: '혀 얽힘', intensity: 60, evidence: 'latest_user' }
      ]
    }
  });
  const soyeonPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: scopeSoyeon,
    profileGenders: { 천하연: 'female', 천소연: 'female', 푸딩: 'male' },
    settings: { mode: 'normal', writing_mode: 'rp', writingMode: 'rp', enableCharacterAide: true },
    recent: {
      visibleMessages: [
        { role: 'assistant', content: '푸딩은 천하연의 허벅지 사이에서 콘돔을 낀 채 삽입하고 있었다. 고무가 밑동 쪽으로 조금 밀려 말려 있었다.' },
        { role: 'user', content: '잠시 천하연의 안에서 멈춘 채 옆에 있던 천소연의 턱을 들어 시선을 맞췄다.' }
      ],
      latestUser: '“소연아.” 푸딩은 허리를 흔들다가 잠시 소연의 팔을 끌어 자신에게 가까이 오게 했다. 그후 그녀의 뒤통수에 손을 얹고 자신의 얼굴 쪽으로 끌어당겨 키스를 나누었다. 소연이 물러나려고 해도 푸딩의 손은 그것을 허락하지 않았다. 소연의 입 속으로 혀가 들어왔다.'
    }
  });
  assert.deepEqual(Array.from(soyeonPkt.contraception, c => c.name), ['천하연'], 'only penetrated 천하연 gets contraception verdict, not foreplay bystander 천소연');
});

test('14) blockSameSexRomance defaults ON, blocks same-sex romance across forced_bond/relsim/world_dynamics, and allows it when OFF', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const waitFor = async (fn, label, ms = 1500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const val = fn();
      if (val) return val;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const finalVal = fn();
    assert.ok(finalVal, `timed out waiting for: ${label}`);
    return finalVal;
  };
  const scopeKey = 'same-sex-guard-14';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  await f.host.plugin.debugSetUnifiedGender(scopeKey, '푸딩', 'male');
  await f.host.plugin.debugSetUnifiedGender(scopeKey, '정현석', 'male');
  await f.host.plugin.debugSetUnifiedGender(scopeKey, '민태오', 'male');
  await f.host.plugin.debugSetUnifiedGender(scopeKey, '천하연', 'female');

  // 14a: Default setting is ON and GUI switch syncs across 관계 시뮬레이터 and 억결 AIDE panels
  const initialRuntime = await f.host.plugin.getRuntimeSettings();
  assert.notEqual(String(initialRuntime.block_same_sex_romance || 'true'), 'false', 'block_same_sex_romance defaults ON');
  await f.host.plugin.openSettingsGui();
  const switches = [...f.document.querySelectorAll('[data-romance-guard-field="blockSameSexRomance"]')];
  assert.equal(switches.length >= 2, true, 'GUI exposes blockSameSexRomance switch in both panels');
  assert.equal(switches.every(el => el.checked === true), true, 'switches start checked by default');

  switches[0].checked = false;
  switches[0].dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  assert.equal(switches.every(el => el.checked === false), true, 'sibling panel switch mirrors OFF state');
  const saveOff = await waitFor(() => {
    const node = f.document.querySelector('#savebar [data-save]');
    return node && !node.disabled ? node : null;
  }, 'save button enabled for OFF');
  saveOff.click();
  await waitFor(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved OFF state');
  const afterOff = await f.host.plugin.getRuntimeSettings();
  assert.equal(String(afterOff.block_same_sex_romance), 'false', 'toggling OFF persists block_same_sex_romance=false');

  switches[1].checked = true;
  switches[1].dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  assert.equal(switches.every(el => el.checked === true), true, 'sibling panel switch mirrors ON state');
  const saveOn = await waitFor(() => {
    const node = f.document.querySelector('#savebar [data-save]');
    return node && !node.disabled ? node : null;
  }, 'save button enabled for ON');
  saveOn.click();
  await waitFor(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved ON state');
  const afterOn = await f.host.plugin.getRuntimeSettings();
  assert.equal(String(afterOn.block_same_sex_romance), 'true', 'toggling ON persists block_same_sex_romance=true');

  // 14b: Forced Bond blocks romantic tones/stage_push on 정현석↔민태오 when ON, allows when OFF
  // Restore test scope after openSettingsGui/save refreshed activeScopeKey to the live host chat.
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const bondSettingsBase = {
    mode: 'normal',
    writing_mode: 'rp',
    writingMode: 'rp',
    enablePlotAide: true,
    enableForcedBondAide: true,
    forcedBondAuto: true,
    forcedBondOffSceneChance: 100,
    forcedBondCards: {
      [scopeKey]: [
        { id: 'bond-same', from: '정현석', to: '민태오', direction: 'mutual', tones: ['affection', 'jealousy', 'curiosity'], origin: 'user' }
      ]
    }
  };
  const recentSameSex = {
    offSceneCast: ['정현석', '민태오'],
    visibleMessages: [{ role: 'assistant', content: '푸딩은 천하연과 거실에 있었다.' }]
  };
  const bondBlocked = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    recent: recentSameSex,
    settings: { ...bondSettingsBase, blockSameSexRomance: true }
  });
  assert.match(bondBlocked, /SAME-SEX ROMANCE PROHIBITION/);
  assert.doesNotMatch(bondBlocked, /tones:\s*[^\n]*(affection|jealousy)/);
  assert.doesNotMatch(bondBlocked, /정현석 → 민태오[^\n]*stage_push/);

  // Empty cards auto-pick should skip pure romantic tones on same-sex and never elevate same-sex bonds romantically
  const recentAutoSameSex = {
    latestUser: '정현석에게 말을 건넨다.',
    visibleMessages: [{
      role: 'assistant',
      content: '정현석이 거실 테이블 앞에서 서류를 정리하고 있었다.\n◈CG\nTIME|2027.04.26(월)|12:10\nLOC|거실|bg_room|맑음\n@|정현석\n◈'
    }]
  };
  const bondAutoBlocked = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    recent: recentAutoSameSex,
    settings: { ...bondSettingsBase, forcedBondCards: { [scopeKey]: [] }, blockSameSexRomance: true }
  });
  assert.match(bondAutoBlocked, /SAME-SEX ROMANCE PROHIBITION/);
  const autoBondLines = bondAutoBlocked
    .split('\n')
    .filter(line => /^\s*-\s*(auto-\d+|Main Bond Roll|Off-Scene Bond Roll|Ripple Bond Roll)/.test(line))
    .join('\n');
  assert.doesNotMatch(autoBondLines, /affection|jealousy|longing|obsession|설렘|갈망|질투|연애/);

  // recordForcedBondProfiles drops pure romantic same-sex lore profiles and strips romantic tones from mixed ones
  f.host.plugin.debugForcedBondRecord({
    stageName: 'aide_plot',
    settings: { mode: 'normal', writingMode: 'rp', enablePlotAide: true, enableForcedBondAide: true, forcedBondAuto: true, blockSameSexRomance: true },
    parsed: {
      bondReadings: [],
      bondProfiles: [
        { from: '정현석', to: '민태오', direction: 'mutual', tones: ['affection', 'longing'], basis: 'pure romantic' },
        { from: '정현석', to: '민태오', direction: 'mutual', tones: ['affection', 'wariness'], basis: 'mixed' }
      ]
    }
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const loreAfterBond = await f.host.plugin.debugLoreLoadCards();
  const savedBondCards = Array.from(loreAfterBond?.forcedBond?.[scopeKey] || loreAfterBond?.cards?.forcedBond?.[scopeKey] || []);
  assert.equal(savedBondCards.length, 1, 'pure romantic same-sex profile skipped, mixed kept without romantic tones');
  assert.deepEqual(Array.from(savedBondCards[0].tones), ['wariness']);

  const bondAllowed = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    recent: recentSameSex,
    settings: { ...bondSettingsBase, blockSameSexRomance: false }
  });
  assert.doesNotMatch(bondAllowed, /SAME-SEX ROMANCE PROHIBITION/);

  // 14c: Relationship Simulator blocks same-sex confession/intimate/date occasions & pair creation when ON, allows when OFF
  await f.host.plugin.debugRelationshipSimSetPair('정현석::민태오', { status: 'lovers', romanceAllowed: true });
  await f.host.plugin.debugRelationshipSimSetProfiles([
    { name: '정현석', status: 'lovers', gender: 'male' },
    { name: '민태오', status: 'lovers', gender: 'male' }
  ]);
  const relRecent = {
    visibleMessages: [{ role: 'assistant', content: '정현석과 민태오가 카페 테이블에 마주 앉아 웃었다.' }],
    latestUser: '두 사람의 대화를 지켜본다.'
  };
  const relBlocked = await f.host.plugin.debugRelationshipSimPrepare({
    recent: relRecent,
    settings: {
      mode: 'normal',
      writingMode: 'rp',
      enablePlotAide: true,
      enableRelationshipSimAide: true,
      blockSameSexRomance: true,
      forcedBondCards: {
        [scopeKey]: [{ id: 'rel-same', from: '정현석', to: '민태오', direction: 'mutual', tones: ['affection'], origin: 'user' }]
      }
    }
  });
  const romanticOccasionsBlocked = (relBlocked.occasions || []).filter(o => ['confession', 'reunion', 'proposal', 'intimate', 'date'].includes(o.act));
  assert.equal(romanticOccasionsBlocked.length, 0, 'no romantic relsim occasions roll for same-sex pair while blocked');

  const relAllowed = await f.host.plugin.debugRelationshipSimPrepare({
    recent: relRecent,
    settings: {
      mode: 'normal',
      writingMode: 'rp',
      enablePlotAide: true,
      enableRelationshipSimAide: true,
      blockSameSexRomance: false,
      forcedBondCards: {
        [scopeKey]: [{ id: 'rel-same', from: '정현석', to: '민태오', direction: 'mutual', tones: ['affection'], origin: 'user' }]
      }
    }
  });
  assert.ok(relAllowed, 'relationship sim runs normally when blockSameSexRomance is OFF');

  // 14d: World Dynamics blocks same-sex off-scene intimacy recording and companion pairing when ON, allows when OFF
  const wdPromptBlocked = f.host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world',
    recent: recentSameSex,
    settings: { mode: 'normal', writingMode: 'rp', enableWorldAide: true, enableWorldDynamicsAide: true, worldDynamicsOffsceneIntimacy: true, blockSameSexRomance: true }
  });
  assert.match(wdPromptBlocked, /SAME-SEX ROMANCE PROHIBITION/);

  const wdParsedSameSex = {
    worldReadings: [{
      movement: '정현석·민태오 밀회',
      status: 'surfaced',
      summary: '같은 성별 밀회',
      actors: ['정현석', '민태오'],
      kind: 'offscene_intimacy',
      intimate_outcome: { occurred: true, zones: ['lips_mouth'] }
    }]
  };
  const wdRecBlocked = f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_world',
    settings: { mode: 'normal', writingMode: 'rp', enableWorldAide: true, enableWorldDynamicsAide: true, worldDynamicsOffsceneIntimacy: true, blockSameSexRomance: true },
    parsed: wdParsedSameSex
  });
  assert.equal((wdRecBlocked.logs || []).some(ev => ev.kind === 'offscene_intimacy' && Array.isArray(ev.actors) && ev.actors.includes('정현석') && ev.actors.includes('민태오')), false, 'same-sex offscene intimacy is NOT recorded when blocked');

  const wdRecAllowed = f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_world',
    settings: { mode: 'normal', writingMode: 'rp', enableWorldAide: true, enableWorldDynamicsAide: true, worldDynamicsOffsceneIntimacy: true, blockSameSexRomance: false },
    parsed: wdParsedSameSex
  });
  assert.equal((wdRecAllowed.logs || []).some(ev => ev.kind === 'offscene_intimacy' && Array.isArray(ev.actors) && ev.actors.includes('정현석') && ev.actors.includes('민태오')), true, 'same-sex offscene intimacy IS recorded when option is OFF');
});

test('15) Excitement gauge (-100..+100), turn-on/turn-off triggers, dominant/submissive initiative, probabilistic halt, post-halt resistance escalation, and halved-but-rising climax', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const seedProfile = async (scopeKey, profile) => {
    f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
    await f.host.plugin.debugIntimacyLoadCards();
    const seededRec = f.host.plugin.debugIntimacyRecord({
      stageName: 'aide_character',
      settings: { mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: true, nsfwMode: 'explicit', enableCharacterAide: true, enableIntimacyAide: true },
      parsed: {
        intimacyReadings: [],
        intimacyBodyResponses: [],
        intimacyProfiles: [{
          gender: 'female',
          liked_positions: '정상위',
          disliked_positions: '',
          sensitive_zones: '질내, 음핵',
          dull_zones: '',
          foreplay_stance: 'likes',
          foreplay_style: '차분함',
          intercourse_stance: 'likes',
          intercourse_style: '차분함',
          afterplay_stance: 'likes',
          afterplay_style: '조용함',
          basis: '테스트 프로필',
          ...profile
        }]
      }
    });
    assert.ok(seededRec.cards.some(c => c.name === profile.name), `seeded card for ${profile.name}`);
  };

  // 15a: Consent preferences — requires_consent cools on unannounced start vs likes_unannounced warms
  const scopeConsentReq = 'ex-consent-req-15a';
  await seedProfile(scopeConsentReq, { name: '윤서연', consent_style: 'requires_consent' });
  const reqCooled = f.host.plugin.debugIntimacyPacket({
    characterName: '윤서연',
    personaName: '푸딩',
    scopeKey: scopeConsentReq,
    settings: { debugHaltRoll: 99 },
    recent: {
      visibleMessages: [{ role: 'char', content: '윤서연이 침대 끝에 앉아 있었다.' }],
      latestUser: '푸딩이 묻지도 않고 다짜고짜 윤서연의 가슴을 움켜쥐며 밀어붙였다.'
    }
  });
  const gReq = reqCooled.gauges.find(g => g.name === '윤서연');
  assert.ok(gReq.excitementGauge < 0, `requires_consent drops below 0 on unannounced touch (got ${gReq.excitementGauge})`);
  assert.ok(gReq.excitementStimMult < 1, 'negative excitement lowers stimulation multiplier');
  assert.match(gReq.line, /흥분도\(excitement\): -\d+/);

  const scopeConsentSurprise = 'ex-consent-unann-15a';
  await seedProfile(scopeConsentSurprise, { name: '강유리', consent_style: 'likes_unannounced' });
  const unannWarmed = f.host.plugin.debugIntimacyPacket({
    characterName: '강유리',
    personaName: '푸딩',
    scopeKey: scopeConsentSurprise,
    recent: {
      visibleMessages: [{ role: 'char', content: '강유리가 침대에 앉아 있었다.' }],
      latestUser: '푸딩이 묻지도 않고 다짜고짜 강유리의 입술에 키스하며 가슴을 주물렀다.'
    }
  });
  const gUnann = unannWarmed.gauges.find(g => g.name === '강유리');
  assert.ok(gUnann.excitementGauge > 0, `likes_unannounced warms on unannounced contact (got ${gUnann.excitementGauge})`);

  // 15b: Restraints/toys/blindfold — likes boosts excitement & stimMult; dislikes drops excitement & halves stimMult while climax STILL climbs to 100
  const scopeToyLike = 'ex-toy-like-15b';
  await seedProfile(scopeToyLike, { name: '차예진', restraint_toy_style: 'likes', sensitive_zones: '질내' });
  const pktToyLike = f.host.plugin.debugIntimacyPacket({
    characterName: '차예진',
    personaName: '푸딩',
    scopeKey: scopeToyLike,
    recent: {
      visibleMessages: [{ role: 'char', content: '차예진이 숨을 죽이고 있었다.' }],
      latestUser: '푸딩이 차예진의 눈을 눈가리개로 가리고 손목에 수갑을 채운 채 질내에 깊이 삽입했다.'
    }
  });
  const gToyLike = pktToyLike.gauges.find(g => g.name === '차예진');
  assert.ok(gToyLike.excitementGauge > 0, `toy-lover gains positive excitement (got ${gToyLike.excitementGauge})`);
  assert.ok(gToyLike.excitementStimMult > 1.0, `toy-lover has stimMult > 1.0 (got ${gToyLike.excitementStimMult})`);

  const scopeToyDislike = 'ex-toy-dislike-15b';
  await seedProfile(scopeToyDislike, { name: '서지우', restraint_toy_style: 'dislikes', turn_offs: '수갑, 눈가리개', sensitive_zones: '질내' });
  let toyDislikeMsgs = [{ role: 'char', content: '서지우가 고개를 저었다.' }];
  let firstDislikeGauge = null;
  let climaxReachedWhileFrozen = false;
  for (let turn = 1; turn <= 6; turn += 1) {
    const uText = `(${turn}회차) 푸딩이 눈가리개와 수갑으로 서지우를 결박한 채 질내 깊숙이 찔러댔다.`;
    const pkt = f.host.plugin.debugIntimacyPacket({
      characterName: '서지우',
      personaName: '푸딩',
      scopeKey: scopeToyDislike,
      settings: { debugHaltRoll: 99 },
      recent: { visibleMessages: [...toyDislikeMsgs], latestUser: uText }
    });
    const g = pkt.gauges.find(item => item.name === '서지우');
    if (turn === 1) firstDislikeGauge = g;
    if (g.climaxTriggeredThisTurn) {
      climaxReachedWhileFrozen = true;
      assert.ok(g.excitementGauge <= -50, 'disliked restraints keep excitement deeply negative');
      assert.ok(g.excitementStimMult >= 0.50 && g.excitementStimMult < 1.0, 'stimMult halves toward 0.50 floor');
      assert.match(g.line, /냉각·목석화|식음·소극 반응/);
      break;
    }
    toyDislikeMsgs.push({ role: 'user', content: uText });
    toyDislikeMsgs.push({ role: 'char', content: `(${turn}회차) 서지우가 입술을 깨문 채 목석처럼 굳어 버텼다.` });
  }
  assert.ok(firstDislikeGauge.excitementGauge <= -50, `dislikes + turn_offs plunges excitement (got ${firstDislikeGauge.excitementGauge})`);
  assert.ok(firstDislikeGauge.climaxGauge < gToyLike.climaxGauge, 'cooled NPC gains less climax per turn than excited toy-lover');
  assert.equal(climaxReachedWhileFrozen, true, 'even when frozen/halved, continued stimulation still builds climax to 100');

  // 15c: Initiative styles — dominant attempts self-lead without instruction; submissive cools & resists when asked to lead
  const scopeDom = 'ex-init-dom-15c';
  await seedProfile(scopeDom, { name: '백하린', initiative_style: 'dominant' });
  const domPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '백하린',
    personaName: '푸딩',
    scopeKey: scopeDom,
    recent: {
      visibleMessages: [{ role: 'char', content: '백하린이 푸딩의 어깨에 손을 올렸다.' }],
      latestUser: '푸딩이 백하린의 목덜미와 가슴을 천천히 애무하며 키스했다.'
    }
  });
  const gDom = domPkt.gauges.find(g => g.name === '백하린');
  assert.match(gDom.initiativeDirective, /\[주도권 확보 시도\]/);
  assert.match(gDom.line, /\[주도권 확보 시도\]/);

  const scopeSub = 'ex-init-sub-15c';
  await seedProfile(scopeSub, { name: '오채은', initiative_style: 'submissive' });
  const subPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '오채은',
    personaName: '푸딩',
    scopeKey: scopeSub,
    settings: { debugHaltRoll: 99 },
    recent: {
      visibleMessages: [{ role: 'char', content: '오채은이 얌전히 품에 안겨 있었다.' }],
      latestUser: '푸딩이 오채은의 가슴을 애무하며 직접 위로 올라와 기승위로 주도해서 움직여 보라고 말했다.'
    }
  });
  const gSub = subPkt.gauges.find(g => g.name === '오채은');
  assert.ok(gSub.excitementGauge < 0, 'submissive NPC cools when forced to lead');
  assert.match(gSub.initiativeDirective, /\[주도 요구 부담·저항\]/);

  // 15d: Probabilistic halt triggers immediate refusal; resuming next turn escalates to pleas/threats/condemnation/resistance while climax still climbs
  const scopeHalt = 'ex-halt-resume-15d';
  await seedProfile(scopeHalt, {
    name: '한소희',
    consent_style: 'requires_consent',
    initiative_style: 'submissive',
    basis: '기가 세고 자존심이 강하며 합의를 중시함'
  });
  const turn1User = '푸딩이 동의도 없이 다짜고짜 한소희에게 위로 올라와 주도하라고 다그치며 가슴을 움켜쥐었다.';
  const haltTurn1 = f.host.plugin.debugIntimacyPacket({
    characterName: '한소희',
    personaName: '푸딩',
    scopeKey: scopeHalt,
    settings: { debugHaltRoll: 5 },
    recent: {
      visibleMessages: [{ role: 'char', content: '한소희가 침대 모서리에 앉아 있었다.' }],
      latestUser: turn1User
    }
  });
  const gHalt1 = haltTurn1.gauges.find(g => g.name === '한소희');
  assert.equal(gHalt1.haltedThisTurn, true, 'low haltRoll < haltChance triggers immediate halt');
  assert.equal(gHalt1.haltedByNpc, true);
  assert.match(gHalt1.haltDirective, /행위 즉시 중단 판정/);

  const haltTurn2 = f.host.plugin.debugIntimacyPacket({
    characterName: '한소희',
    personaName: '푸딩',
    scopeKey: scopeHalt,
    recent: {
      visibleMessages: [
        { role: 'char', content: '한소희가 침대 모서리에 앉아 있었다.' },
        { role: 'user', content: turn1User },
        { role: 'char', content: '한소희가 몸을 빼며 멈추라고 거부했다. "그만해. 지금 당장 손 떼."' }
      ],
      latestUser: '푸딩은 멈추지 않고 한소희를 눌러 눕힌 채 그대로 질내 깊숙이 삽입해 허리를 움직였다.'
    }
  });
  const gHalt2 = haltTurn2.gauges.find(g => g.name === '한소희');
  assert.equal(gHalt2.resumedAfterHalt, true, 'resuming after NPC refusal/halt activates resumedAfterHalt');
  assert.ok(gHalt2.excitementGauge < gHalt1.excitementGauge, 'excitement drops even further when halt is ignored');
  assert.ok(gHalt2.climaxGauge > gHalt1.climaxGauge, 'climax still climbs from incoming penetrative stimulation despite halted/negative excitement');
  assert.match(gHalt2.haltDirective, /중단 후 재개 — 적극적 중단 요구·저항/);
  assert.match(gHalt2.haltDirective, /비난·규탄|협박|저항/);

  // 15e: GUI renders excitement preference fields + excitement gauge meter
  f.host.plugin.debugSetActiveScope(scopeHalt, '푸딩');
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('chat');
  const consentSelect = f.document.querySelector('[data-intimacy-card-field="consentStyle"]');
  const initSelect = f.document.querySelector('[data-intimacy-card-field="initiativeStyle"]');
  const toySelect = f.document.querySelector('[data-intimacy-card-field="restraintToyStyle"]');
  const turnOnsInput = f.document.querySelector('[data-intimacy-card-field="turnOns"]');
  const turnOffsInput = f.document.querySelector('[data-intimacy-card-field="turnOffs"]');
  assert.ok(consentSelect && initSelect && toySelect && turnOnsInput && turnOffsInput, 'all 5 excitement preference fields render in intimacy card editor');
  assert.equal(consentSelect.value, 'requires_consent');
  assert.equal(initSelect.value, 'submissive');
  const readingsHtml = f.document.querySelector('[data-intimacy-readings]')?.textContent || '';
  assert.match(readingsHtml, /흥분 게이지/);
  assert.match(readingsHtml, /중단·저항/);
});

test('16) Lore-based auto-estimation automatically fills & persists turnOns, turnOffs, sensitiveZones, and dullZones without clobbering user clears or zoneStats', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeAuto = 'auto-lore-intimacy-16';
  f.host.plugin.debugSetActiveScope(scopeAuto, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();

  // Case A: Card matching screenshot scenario — liked/disliked positions + lore basis, empty turnOns/turnOffs/sensitiveZones/dullZones,
  // PLUS non-zero pre-existing zoneStats that must NOT be overwritten
  const seeded = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: { mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: true, nsfwMode: 'explicit', enableCharacterAide: true, enableIntimacyAide: true },
    parsed: {
      intimacyReadings: [],
      intimacyBodyResponses: [],
      intimacyProfiles: [{
        name: '천소연',
        gender: 'female',
        liked_positions: '매팅프레스, 스푸닝, 풀넬슨',
        disliked_positions: '기승위',
        sensitive_zones: '',
        dull_zones: '',
        zone_defaults: [{ zone: 'breasts_nipples', sensitivity: 42, development: 14 }],
        foreplay_stance: 'likes',
        foreplay_style: '부드러운 전희와 귓가 속삭임, 다정한 포옹을 좋아하고 거친 말투를 싫어함',
        intercourse_stance: 'likes',
        intercourse_style: '이끌리는 편이며 밀착된 압박을 즐김',
        afterplay_stance: 'likes',
        afterplay_style: '끝난 뒤 꼭 안아주는 후희를 원함',
        basis: '천소연 로어: 수줍고 다정하며 사전 동의를 중시하고 귀와 목덜미가 민감함'
      }]
    }
  });
  const recordedCard = seeded.cards.find(c => c.name === '천소연');
  assert.ok(recordedCard, '천소연 card created');
  assert.ok(recordedCard.turnOns && recordedCard.turnOns.length > 0, `turnOns auto-populated from lore (got "${recordedCard.turnOns}")`);
  assert.ok(recordedCard.turnOffs && recordedCard.turnOffs.length > 0, `turnOffs auto-populated from lore (got "${recordedCard.turnOffs}")`);
  assert.ok(recordedCard.sensitiveZones && recordedCard.sensitiveZones.includes('유두'), `sensitiveZones auto-populated and includes zoneStats peak (got "${recordedCard.sensitiveZones}")`);
  assert.ok(recordedCard.dullZones && recordedCard.dullZones.length > 0, `dullZones auto-populated from lore (got "${recordedCard.dullZones}")`);
  assert.equal(recordedCard.initiativeStyle, 'submissive', 'initiativeStyle inferred as submissive from positions/lore');
  assert.equal(recordedCard.zoneStats.breasts_nipples.sensitivity, 42, 'existing non-zero zoneStats preserved');
  assert.equal(recordedCard.zoneStats.breasts_nipples.development, 14, 'existing non-zero development preserved');

  // Case B: Already-stored legacy card with empty fields gets auto-populated & persisted when GUI opens or intimacy packet computes
  const scopeGuiLegacy = 'auto-lore-gui-16b';
  f.host.plugin.debugSetActiveScope(scopeGuiLegacy, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: { mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: true, nsfwMode: 'explicit', enableCharacterAide: true, enableIntimacyAide: true },
    parsed: {
      intimacyReadings: [],
      intimacyBodyResponses: [],
      intimacyProfiles: [{
        name: '강서희',
        gender: 'female',
        liked_positions: '후배위',
        disliked_positions: '',
        foreplay_stance: 'likes',
        foreplay_style: '눈가리개와 키스로 달아오르는 편',
        intercourse_stance: 'likes',
        intercourse_style: '깊은 삽입을 선호함',
        afterplay_stance: 'neutral',
        afterplay_style: '조용한 휴식',
        basis: '강서희 로어: 도도하지만 직설적이고 도구·구속을 선호하지는 않으며 목덜미가 약함'
      }]
    }
  });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('chat');
  const turnOnsEl = f.document.querySelector('[data-intimacy-card-field="turnOns"]');
  const turnOffsEl = f.document.querySelector('[data-intimacy-card-field="turnOffs"]');
  const sensEl = f.document.querySelector('[data-intimacy-card-field="sensitiveZones"]');
  const dullEl = f.document.querySelector('[data-intimacy-card-field="dullZones"]');
  assert.ok(turnOnsEl?.value.trim(), 'GUI turnOns populated automatically');
  assert.ok(turnOffsEl?.value.trim(), 'GUI turnOffs populated automatically');
  assert.ok(sensEl?.value.trim(), 'GUI sensitiveZones populated automatically');
  assert.ok(dullEl?.value.trim(), 'GUI dullZones populated automatically');

  // Verify explicit user clearing is respected and NOT overwritten on re-render
  dullEl.value = '';
  dullEl.dispatchEvent(new f.document.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 40));
  await f.host.plugin.debugNavigateGui('chat');
  const dullAfterClear = f.document.querySelector('[data-intimacy-card-field="dullZones"]')?.value || '';
  assert.equal(dullAfterClear, '', 'explicitly cleared field stays empty instead of re-filling');
});

test('17) Male ejaculation pace (-100~+100 지루↔조루), forced hold-back delay, lore estimation, and GUI controls', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });

  // 17a: Lore estimation across all 5 pace regions + persistence across debugGaugeContinuityLoad
  const estVeryFast = f.host.plugin.debugEstimateMaleEjacPaceFromLore({
    name: '민수',
    loreText: '극조루 체질로 삽입 직후에도 자극을 못 참고 금방 싸버리는 편이다.'
  });
  assert.equal(estVeryFast.tier, 'very_fast');
  assert.ok(estVeryFast.pace >= 60, `expected very_fast pace >= 60, got ${estVeryFast.pace}`);

  const estFast = f.host.plugin.debugEstimateMaleEjacPaceFromLore({
    name: '민수',
    loreText: '살짝 조루 기질이 있어 참을성이 부족하고 사정이 빠른 편이다.'
  });
  assert.equal(estFast.tier, 'fast');
  assert.ok(estFast.pace >= 25 && estFast.pace < 60, `expected fast pace in [25, 60), got ${estFast.pace}`);

  const estSlow = f.host.plugin.debugEstimateMaleEjacPaceFromLore({
    name: '민수',
    loreText: '사정이 느린 지루 체질이라 오래 버티며 참을성이 좋다.'
  });
  assert.equal(estSlow.tier, 'slow');
  assert.ok(estSlow.pace <= -25 && estSlow.pace > -60, `expected slow pace in (-60, -25], got ${estSlow.pace}`);

  const estVerySlow = f.host.plugin.debugEstimateMaleEjacPaceFromLore({
    name: '민수',
    loreText: '극지루 수준으로 웬만한 자극에는 끄떡없이 한참을 지속한다.'
  });
  assert.equal(estVerySlow.tier, 'very_slow');
  assert.ok(estVerySlow.pace <= -60, `expected very_slow pace <= -60, got ${estVerySlow.pace}`);

  const estNeutral = f.host.plugin.debugEstimateMaleEjacPaceFromLore({
    name: '민수',
    loreText: '평범한 체격의 직장인 남성이다.'
  });
  assert.equal(estNeutral.tier, 'average');
  assert.equal(estNeutral.pace, 0);

  const persistScope = 'male-pace-persist-17a';
  await f.host.plugin.debugSetIntimacyMalePace({
    scopeKey: persistScope,
    name: '민수',
    pace: 75,
    basis: '직접 설정 테스트'
  });
  const loaded = await f.host.plugin.debugGaugeContinuityLoad();
  assert.equal(loaded.malePaces?.[persistScope]?.['민수']?.pace, 75, 'male pace persisted and reloaded');
  assert.equal(loaded.malePaces?.[persistScope]?.['민수']?.tier, 'very_fast');

  // 17b: Monotonic ejaculationGauge buildup across very_fast (+75) > average (0) > very_slow (-75)
  const paceGauges = {};
  for (const paceScore of [75, 0, -75]) {
    const sk = `male-pace-scale-${paceScore}`;
    await f.host.plugin.debugSetIntimacyMalePace({ scopeKey: sk, name: '푸딩', pace: paceScore, basis: '테스트' });
    const pkt = f.host.plugin.debugIntimacyPacket({
      characterName: '천하연',
      personaName: '푸딩',
      scopeKey: sk,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      recent: {
        visibleMessages: [{ role: 'char', content: '천하연이 숨을 몰아쉬며 푸딩을 받아들였다.' }],
        latestUser: '푸딩이 천하연의 질내에 삽입해 허리를 움직였다.'
      }
    });
    const mGauge = pkt.gauges.find(g => g.name === '푸딩');
    assert.ok(mGauge, `male gauge present for pace ${paceScore}`);
    assert.equal(mGauge.ejaculationPace, paceScore);
    assert.ok(mGauge.ejaculationPaceMeta && mGauge.ejaculationPaceMeta.tier, 'ejaculationPaceMeta populated');
    paceGauges[paceScore] = mGauge.ejaculationGauge;
  }
  assert.ok(paceGauges[75] > paceGauges[0], `expected very_fast (${paceGauges[75]}) > average (${paceGauges[0]})`);
  assert.ok(paceGauges[0] > paceGauges[-75], `expected average (${paceGauges[0]}) > very_slow (${paceGauges[-75]})`);

  // 17c: Forced holding back dampens single-turn gain, caps premature burst at 94 (< 92 pre), and breaks through next turn
  const skNoHold = 'male-pace-no-hold-17c';
  const skHoldCmp = 'male-pace-hold-cmp-17c';
  await f.host.plugin.debugSetIntimacyMalePace({ scopeKey: skNoHold, name: '푸딩', pace: 75 });
  await f.host.plugin.debugSetIntimacyMalePace({ scopeKey: skHoldCmp, name: '푸딩', pace: 75 });
  const cmpNoHold = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: skNoHold,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    recent: {
      visibleMessages: [{ role: 'char', content: '하연의 허리가 들렸다.' }],
      latestUser: '푸딩이 하연의 질내에 깊이 삽입해 허리를 움직였다.'
    }
  }).gauges.find(g => g.name === '푸딩');
  const cmpHold = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: skHoldCmp,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    recent: {
      visibleMessages: [{ role: 'char', content: '하연의 허리가 들렸다.' }],
      latestUser: '푸딩이 하연의 질내에 깊이 삽입해 허리를 움직였지만 이를 악물고 억지로 참으며 속도를 늦췄다.'
    }
  }).gauges.find(g => g.name === '푸딩');
  assert.equal(cmpHold.forcedHoldThisTurn, true, 'forcedHoldThisTurn detected');
  assert.ok(cmpHold.ejaculationGauge < cmpNoHold.ejaculationGauge, `forced hold dampens single-turn gain (${cmpHold.ejaculationGauge} < ${cmpNoHold.ejaculationGauge})`);

  const skBrink = 'male-pace-brink-17c';
  f.host.plugin.debugSetActiveScope(skBrink, '푸딩');
  await f.host.plugin.debugSetIntimacyMalePace({ scopeKey: skBrink, name: '푸딩', pace: 75 });
  const brinkSettings = { enableIntimacyAide: true, enableCharacterAide: true, mode: 'normal', writingMode: 'rp', nsfwGuidanceEnabled: true, nsfwMode: 'explicit' };
  const buildupVisible = [];
  let gBuildup = null;
  for (let b = 0; b < 3; b += 1) {
    const uMsg = b === 0
      ? '푸딩이 하연의 질내에 삽입해 허리를 움직였다.'
      : '푸딩이 하연의 질내에 삽입한 채 계속 허리를 움직였다.';
    buildupVisible.push({ role: 'user', content: uMsg });
    const pktB = f.host.plugin.debugIntimacyPacket({
      characterName: '천하연',
      personaName: '푸딩',
      scopeKey: skBrink,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      settings: brinkSettings,
      recent: { visibleMessages: [...buildupVisible], latestUser: uMsg }
    });
    f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings: brinkSettings, parsed: { intimacyReadings: [] } });
    gBuildup = pktB.gauges.find(g => g.name === '푸딩');
    buildupVisible.push({ role: 'assistant', content: '하연이 숨을 삼키며 허리를 맡겼다.' });
    if (gBuildup.ejaculationGauge >= 68 && gBuildup.ejaculationGauge < 92) break;
  }
  assert.ok(gBuildup && gBuildup.ejaculationGauge >= 68 && gBuildup.ejaculationGauge < 92, `buildup must reach [68, 92), got ${gBuildup?.ejaculationGauge}`);

  const t2User = '사정 직전까지 몰아치는 하연의 질내 조임과 귀두·음경 자극에 곧 터질 듯했지만 푸딩은 이를 악물고 억지로 참으며 사정을 늦췄다.';
  const pktB2 = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: skBrink,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings: brinkSettings,
    recent: {
      visibleMessages: [...buildupVisible, { role: 'user', content: t2User }],
      latestUser: t2User
    }
  });
  f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings: brinkSettings, parsed: { intimacyReadings: [] } });
  const gB2 = pktB2.gauges.find(g => g.name === '푸딩');
  assert.equal(gB2.ejaculationGauge, 94, `expected forced hold to cap premature burst at 94, got ${gB2.ejaculationGauge}`);
  assert.equal(gB2.ejacDelayedByHold, true, 'ejacDelayedByHold must be true when held back at 94');
  assert.equal(gB2.ejaculationTriggeredThisTurn, false, 'ejaculation must be delayed, not triggered');
  assert.match(gB2.line, /HELD BACK ON THE BRINK/);

  const t3User = '이미 한계 직전인데도 하연이 허리를 내려찍으며 귀두와 음경을 세게 훑어 올려 끝내 버티지 못했다.';
  const pktB3 = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: skBrink,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings: brinkSettings,
    recent: {
      visibleMessages: [
        ...buildupVisible,
        { role: 'user', content: t2User },
        { role: 'assistant', content: '푸딩이 이를 악문 채 아슬아슬하게 버텨냈다.' },
        { role: 'user', content: t3User }
      ],
      latestUser: t3User
    }
  });
  const gB3 = pktB3.gauges.find(g => g.name === '푸딩');
  assert.equal(gB3.ejaculationGauge, 100, `sustained stimulation from 94 (>=92) must break through to 100, got ${gB3.ejaculationGauge}`);
  assert.equal(gB3.ejaculationTriggeredThisTurn, true, 'ejaculation triggers on sustained stimulation past hold cap');

  // 17d: GUI intimacyCardEditor & Tile 6 [data-char-male-pace-select] rendering and persistence
  await f.host.plugin.openSettingsGui();
  // Let background refreshActiveScopeKeyForGui() finish before setting test scopeKey
  await new Promise(r => setTimeout(r, 60));
  const scopeGui = 'male-pace-gui-17d';
  f.host.plugin.debugSetActiveScope(scopeGui, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();
  const novelSettings = {
    ...(await f.host.plugin.getRuntimeSettings()),
    mode: 'normal',
    writingMode: 'novel',
    nsfwMode: 'direct',
    nsfwGuidanceEnabled: true,
    enableCharacterAide: true,
    enableIntimacyAide: true
  };
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: novelSettings,
    parsed: {
      intimacyReadings: [{ participant: '강현', phase: 'intercourse', position: '정상위', summary: '강현이 천천히 움직였다.' }],
      intimacyProfiles: [{
        name: '강현',
        gender: 'male',
        ejaculation_pace: -45,
        ejaculation_pace_basis: '침착하고 지구력이 뛰어난 편',
        liked_positions: '정상위',
        disliked_positions: '',
        sensitive_zones: '귀두',
        dull_zones: '',
        foreplay_stance: 'likes',
        foreplay_style: '차분함',
        intercourse_stance: 'likes',
        intercourse_style: '안정적임',
        afterplay_stance: 'likes',
        afterplay_style: '다정함',
        basis: '강현 로어'
      }]
    }
  });

  await f.host.plugin.debugNavigateGui('chat');

  const tierEl = f.document.querySelector('[data-intimacy-card-field="ejaculationPaceTier"]');
  const paceNumEl = f.document.querySelector('[data-intimacy-card-field="ejaculationPace"]');
  const paceBasisEl = f.document.querySelector('[data-intimacy-card-field="ejaculationPaceBasis"]');
  const tilePaceSel = f.document.querySelector('[data-char-male-pace-select="강현"]');
  assert.ok(tierEl, 'intimacyCardEditor renders ejaculationPaceTier select');
  assert.ok(paceNumEl, 'intimacyCardEditor renders numeric ejaculationPace input');
  assert.ok(paceBasisEl, 'intimacyCardEditor renders ejaculationPaceBasis input');
  assert.ok(tilePaceSel, 'Tile 6 renders [data-char-male-pace-select="강현"]');

  const optionTexts = [...tilePaceSel.querySelectorAll('option')].map(o => o.textContent || '');
  assert.ok(optionTexts.every(txt => !/undefined/.test(txt)), `Tile 6 options must not contain undefined: ${JSON.stringify(optionTexts)}`);

  // Update via card editor numeric input & basis sequentially, then verify persistence
  paceNumEl.value = '45';
  paceNumEl.dispatchEvent(new f.document.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  const liveBasisEl = f.document.querySelector('[data-intimacy-card-field="ejaculationPaceBasis"]');
  assert.ok(liveBasisEl, 'live ejaculationPaceBasis input present after numeric update');
  liveBasisEl.value = '사용자 수치 조정';
  liveBasisEl.dispatchEvent(new f.document.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));

  // Update via Tile 6 select (re-query live DOM after card editor re-render) and verify persistence in debugIntimacyMalePaces
  const liveTilePaceSel = f.document.querySelector('[data-char-male-pace-select="강현"]');
  assert.ok(liveTilePaceSel, 'Tile 6 select present after card editor update');
  assert.equal(liveTilePaceSel.value, 'fast', 'Tile 6 select synced to fast after numeric +45 edit');
  liveTilePaceSel.value = 'very_slow';
  liveTilePaceSel.dispatchEvent(new f.document.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));

  const pacesAfterTile = f.host.plugin.debugIntimacyMalePaces({ scopeKey: scopeGui });
  const ganghyeonPace = Object.values(pacesAfterTile).find(item => item?.name === '강현');
  assert.ok(ganghyeonPace && ganghyeonPace.tier === 'very_slow' && ganghyeonPace.pace <= -60, `Tile 6 change persisted to malePaces: ${JSON.stringify(ganghyeonPace)}`);
});

test('18) Quoted/phone-message mentions (구민지) never count as on-scene physical presence across intimacy, forced-bond, or relsim', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'motel-absent-mention-18a';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();

  const settings = {
    ...(await f.host.plugin.getRuntimeSettings()),
    mode: 'normal',
    writingMode: 'rp',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'explicit',
    enableCharacterAide: true,
    enablePlotAide: true,
    enableIntimacyAide: true,
    enableForcedBondAide: true,
    enableRelationshipSimAide: true,
    forcedBondAuto: true,
    forcedBondCards: {
      [scopeKey]: [
        { id: 'bond-minji', from: '@persona', to: '구민지', direction: 'mutual', tones: ['wariness', 'camaraderie'], stage: 'tension', pressure: 'explicit' },
        { id: 'bond-soyeon', from: '@persona', to: '천소연', direction: 'mutual', tones: ['affection'], stage: 'tension', pressure: 'explicit' }
      ]
    }
  };
  await f.host.plugin.debugRelationshipSimSetPair('bond-minji', { status: 'friend' });
  await f.host.plugin.debugRelationshipSimSetPair('bond-soyeon', { status: 'lovers' });

  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: 'lore' },
        { name: '천소연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: 'lore' },
        { name: '구민지', gender: 'female', consent_style: 'requires_consent', sensitive_zones: '음핵', dull_zones: '', basis: '구민지 로어' }
      ]
    }
  });

  // 18a: Pre-contaminate 구민지 in settled gauges, then run the actual motel scene with HUD @|천소연 @|천하연 + phone message/spoken mention
  const seedMinjiUser = '구민지가 손으로 자신의 가슴을 어루만졌다.';
  f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female', 구민지: 'female' },
    settings,
    recent: {
      visibleMessages: [{ role: 'user', content: seedMinjiUser }],
      latestUser: seedMinjiUser
    }
  });
  f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings, parsed: { intimacyReadings: [] } });

  const phoneMsgAssistant = [
    '옆 탁자 위에서 진동이 났다. 화면이 켜졌다.',
    '"민지야."',
    '"오늘 안에 정산 끝내라고."',
    '◈CG\nTIME|2027.04.26(월)|15:20|출근일\nLOC|광안리 근처 모텔 2층 방|none|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈'
  ].join('\n');
  const climaxAssistant = [
    '그가 소연의 질내로 삽입해 움직이기 시작했다. 소연의 다리가 그의 옆구리를 감았다. 안쪽이 오래 조였다.',
    '하연이 침대 옆에 걸터앉았다. "정산, 오 시 전에 하자고 했어." "민지가 뭐라고 할지 알지."',
    '◈CG\nTIME|2027.04.26(월)|15:40|출근일\nLOC|광안리 근처 모텔 2층 방|none|맑음\n@|천소연|soyeon\n@|천하연|hayeon\n◈'
  ].join('\n');
  const followUser = '푸딩이 소연의 가슴과 음핵을 부드럽게 애무하며 입을 맞췄다.';

  const hudPkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female', 구민지: 'female' },
    settings,
    recent: {
      visibleMessages: [
        { role: 'assistant', content: phoneMsgAssistant },
        { role: 'assistant', content: climaxAssistant }
      ],
      latestUser: followUser
    }
  });
  assert.equal(hudPkt.gauges.some(g => g.name === '구민지'), false, 'HUD @|천소연 @|천하연 must exclude mentioned-only 구민지 from gauges');
  assert.ok(hudPkt.gauges.some(g => g.name === '천소연') && hudPkt.gauges.some(g => g.name === '천하연'));
  const reloadedGauges = await f.host.plugin.debugGaugeContinuityLoad();
  const settledKeys = Object.keys(reloadedGauges?.intimacyGauges?.[scopeKey]?.settled || {});
  assert.equal(settledKeys.some(k => /구민지/.test(k)), false, 'stale settled gauge for absent 구민지 is pruned when HUD names are authoritative');

  // 18c: With HUD @|천소연 @|천하연, forced_bond must not roll 구민지 on-scene and relsim must emit no verdict for 구민지
  const bondBlock = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    settings,
    recent: {
      runLineage: { runId: 'bond-hud-18c', currentInputHash: 'hc1', priorAssistantHash: 'ha1' },
      visibleMessages: [
        { role: 'assistant', content: phoneMsgAssistant },
        { role: 'assistant', content: climaxAssistant }
      ],
      latestUser: followUser
    }
  });
  const onSceneBondLines = bondBlock.split('\n').filter(line => /Main Bond Roll:|Ripple Bond Roll:/.test(line)).join('\n');
  assert.doesNotMatch(onSceneBondLines, /구민지/, `HUD-absent 구민지 must not roll as on-scene bond: ${onSceneBondLines}`);

  const relPrepHud = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      runLineage: { runId: 'rel-hud-18c', currentInputHash: 'rc1', priorAssistantHash: 'ra1' },
      visibleMessages: [
        { role: 'assistant', content: phoneMsgAssistant },
        { role: 'assistant', content: climaxAssistant }
      ],
      latestUser: '좋아한다고 고백한다. 오늘 밤 데이트하러 가자고 말한다.'
    }
  });
  assert.equal((relPrepHud.verdicts || []).some(v => /구민지/.test(`${v.from} ${v.to}`)), false, 'HUD-absent 구민지 must not produce relsim verdicts');

  // 18b: Even WITHOUT HUD, spoken dialogue ("민지가 뭐라고 할지 알지.") and phone message ("민지에게서 문자가 왔다.") must exclude 구민지
  const noHudScope = 'nohud-absent-mention-18b';
  f.host.plugin.debugSetActiveScope(noHudScope, '푸딩');
  const noHudSettings = {
    ...settings,
    forcedBondCards: {
      [noHudScope]: [
        { id: 'bond-minji-2', from: '@persona', to: '구민지', direction: 'mutual', tones: ['wariness', 'camaraderie'], stage: 'tension', pressure: 'explicit' }
      ]
    }
  };
  await f.host.plugin.debugRelationshipSimSetPair('bond-minji-2', { status: 'friend' });
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: noHudSettings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천소연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: 'lore' },
        { name: '구민지', gender: 'female', consent_style: 'requires_consent', sensitive_zones: '음핵', dull_zones: '', basis: '구민지 로어' }
      ]
    }
  });
  const noHudMessages = [
    { role: 'assistant', content: '탁자 위 스마트폰에 진동이 났다. 민지에게서 문자가 왔다.\n"민지야."' },
    { role: 'assistant', content: '소연이 그의 어깨에 기대어 숨을 골랐다. "민지가 뭐라고 할지 알지."\n그녀의 허벅지 안쪽이 다시 떨렸다.' }
  ];
  const noHudPkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey: noHudScope,
    profileGenders: { 푸딩: 'male', 천소연: 'female', 구민지: 'female' },
    settings: noHudSettings,
    recent: {
      visibleMessages: noHudMessages,
      latestUser: '푸딩은 소연의 허리를 감싸 안고 귓가에 속삭였다.'
    }
  });
  assert.equal(noHudPkt.gauges.some(g => g.name === '구민지'), false, 'Non-HUD phone/quote mention of 구민지 must not enter intimacy gauges');
  assert.ok(noHudPkt.gauges.some(g => g.name === '천소연'));

  const noHudBondBlock = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    settings: noHudSettings,
    recent: {
      runLineage: { runId: 'bond-nohud-18b', currentInputHash: 'hc2', priorAssistantHash: 'ha2' },
      visibleMessages: noHudMessages,
      latestUser: '푸딩은 소연의 손을 잡고 숨을 골랐다.'
    }
  });
  const noHudOnSceneLines = noHudBondBlock.split('\n').filter(line => /Main Bond Roll:|Ripple Bond Roll:/.test(line)).join('\n');
  assert.doesNotMatch(noHudOnSceneLines, /구민지/, `Non-HUD phone/quote mention must not trigger on-scene forced bond: ${noHudOnSceneLines}`);

  const noHudRelPrep = await f.host.plugin.debugRelationshipSimPrepare({
    settings: noHudSettings,
    recent: {
      runLineage: { runId: 'rel-nohud-18b', currentInputHash: 'rc2', priorAssistantHash: 'ra2' },
      visibleMessages: noHudMessages,
      latestUser: '소연에게 좋아한다고 고백한다.'
    }
  });
  assert.equal((noHudRelPrep.verdicts || []).some(v => /구민지/.test(`${v.from} ${v.to}`)), false, 'Non-HUD phone/quote mention must not trigger relsim verdicts');

  // 18d: Explicit physical arrival in latestUser DOES recognize 구민지 on-scene even when prior HUD omitted her
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const arrivalUser = '구민지가 문을 열고 방 안으로 들어왔다. 구민지가 하연의 손목을 잡고 가슴을 어루만졌다.';
  const arrivalPkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female', 구민지: 'female' },
    settings,
    recent: {
      visibleMessages: [{ role: 'assistant', content: climaxAssistant }],
      latestUser: arrivalUser
    }
  });
  assert.equal(arrivalPkt.gauges.some(g => g.name === '구민지'), true, 'explicit physical arrival in latestUser includes 구민지 on-scene');
});

test('19) Spatial sub-room split, Tier-1 adjacent observer handoff, facility acoustics, and exposureIntent (conceal/oblivious/provoke)', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'spatial-subroom-19a';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();
  const baseSettings = {
    ...(await f.host.plugin.getRuntimeSettings()),
    mode: 'normal',
    writingMode: 'rp',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'explicit',
    enableCharacterAide: true,
    enableWorldAide: true,
    enablePlotAide: true,
    enableIntimacyAide: true,
    enableWorldDynamicsAide: true
  };
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: baseSettings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: '차분하고 현실적인 성격' },
        { name: '천소연', gender: 'female', sensitive_zones: '유두, 음핵', dull_zones: '', basis: '수줍음이 많고 비밀을 엄수하려 소리를 죽이는 성격' }
      ]
    }
  });

  // 19a: Motel room -> bathroom split with 천소연 while 천하연 remains outside in the motel bedroom
  const motelRoomAssistant = '하연이 물병을 집어 들었다. "너 씻고 와. 소연이도."\n◈CG\nTIME|2027.04.26(월)|15:55|출근일\nLOC|광안리 근처 모텔 2층 방|none|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈';
  const splitUser = '소연과 함께 씻으러 들어왔다. 컨디션이 안 좋은 소연은 몸을 만족스럽게 움직이지 못했고 대신 씻겨주게 되었다. 하지만 씻겨주는 중에 소연을 뒤에서 안고 양손으로 그녀의 유두와 음핵을 살살 만지기 시작했다.';
  const splitRecent = {
    runLineage: { runId: 'sub-19a', currentInputHash: 'h19a', priorAssistantHash: 'a19a' },
    visibleMessages: [{ role: 'assistant', content: motelRoomAssistant }],
    latestUser: splitUser
  };

  const topoA = f.host.plugin.debugSpatialTopology({ recent: splitRecent, settings: baseSettings });
  assert.equal(topoA.active, true, 'sub-room split detected');
  assert.equal(topoA.subRoomId, 'bathroom');
  assert.ok(topoA.inSubScene.some(n => /소연/.test(n)), `inSubScene includes 천소연: ${JSON.stringify(topoA.inSubScene)}`);
  assert.ok(topoA.adjacentObservers.some(n => /하연/.test(n)), `adjacentObservers includes 천하연: ${JSON.stringify(topoA.adjacentObservers)}`);

  const pktA = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
    settings: baseSettings,
    recent: splitRecent
  });
  assert.equal(pktA.gauges.some(g => g.name === '천하연'), false, 'Tier-1 천하연 outside bathroom must be excluded from intimacy gauges');
  assert.ok(pktA.gauges.some(g => g.name === '천소연'), 'Tier-0 천소연 inside bathroom stays in gauges');
  assert.ok(pktA.externalReaction, 'externalReaction computed during intimate split');
  assert.equal(pktA.externalReaction.nearbyActor, '천하연', 'Tier-1 천하연 promoted to 1st-priority external observer');
  assert.equal(pktA.externalReaction.observerProximity, 'adjacent_sub_room');
  assert.equal(pktA.externalReaction.spaceType, 'private');
  assert.equal(pktA.externalReaction.acoustics?.ambientMasking, 'shower_running');

  const wdPacketA = f.host.plugin.debugWorldDynamicsPacket({ recent: splitRecent, settings: baseSettings });
  assert.match(wdPacketA, /\[SPATIAL TOPOLOGY & ADJACENT OBSERVERS/);
  assert.match(wdPacketA, /천하연/);

  // 19b: Shower stops + dead silence + climax brink sharply escalates external notice risk for 천하연
  const bathroomAssist1 = '샤워기 물소리 아래 소연이 입술을 깨물고 숨을 삼켰다.\n◈CG\nTIME|2027.04.26(월)|16:00|출근일\nLOC|광안리 근처 모텔 2층 방|none|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈';
  const silenceRecent = {
    runLineage: { runId: 'sub-19b', currentInputHash: 'h19b', priorAssistantHash: 'a19b' },
    visibleMessages: [
      { role: 'assistant', content: motelRoomAssistant },
      { role: 'user', content: splitUser },
      { role: 'assistant', content: bathroomAssist1 }
    ],
    latestUser: '샤워기 물을 껐다. 욕실 안에 정적이 흘렀다. 소연이 곧 절정에 달할 듯 다리를 떨며 신음을 터뜨릴 듯했다.'
  };
  const pktB = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem',
    personaName: '푸딩',
    scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
    settings: baseSettings,
    recent: silenceRecent
  });
  assert.equal(pktB.externalReaction.acoustics?.ambientMasking, 'dead_silence');
  assert.equal(pktB.externalReaction.nearbyActor, '천하연');
  assert.ok(pktB.externalReaction.score > pktA.externalReaction.score, `stopping shower + silence must raise risk (${pktB.externalReaction.score} > ${pktA.externalReaction.score})`);

  // 19c: Exposure intent (conceal vs provoke) in thin motel vs blockedByAcoustics in luxury soundproof suite
  const thinMotelScope = 'acoustics-thin-19c';
  f.host.plugin.debugSetActiveScope(thinMotelScope, '푸딩');
  const thinAssist = '노후 모텔의 얇은 문 너머 거실에 하연이 앉아 있었다.\n◈CG\nLOC|노후 모텔 방|none|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈';
  const scoreForIntent = async intent => {
    const sk = `${thinMotelScope}-${intent}`;
    f.host.plugin.debugSetActiveScope(sk, '푸딩');
    f.host.plugin.debugIntimacyRecord({
      stageName: 'aide_character',
      settings: baseSettings,
      parsed: {
        intimacyReadings: [],
        intimacyProfiles: [
          { name: '천하연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: '로어' },
          { name: '천소연', gender: 'female', exposure_intent: intent, sensitive_zones: '음핵', dull_zones: '', basis: '로어' }
        ]
      }
    });
    const r = {
      runLineage: { runId: `intent-${intent}`, currentInputHash: `hi-${intent}`, priorAssistantHash: `ha-${intent}` },
      visibleMessages: [{ role: 'assistant', content: thinAssist }],
      latestUser: '소연과 함께 욕실로 씻으러 들어가 그녀의 음핵을 어루만지며 삽입했다.'
    };
    return f.host.plugin.debugIntimacyPacket({
      characterName: 'ClauGem', personaName: '푸딩', scopeKey: sk,
      profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
      settings: baseSettings, recent: r
    });
  };
  const pktConceal = await scoreForIntent('conceal');
  const pktProvoke = await scoreForIntent('provoke');
  assert.equal(pktConceal.externalReaction.exposureIntent?.dominantIntent, 'conceal');
  assert.equal(pktProvoke.externalReaction.exposureIntent?.dominantIntent, 'provoke');
  assert.ok(pktProvoke.externalReaction.score > pktConceal.externalReaction.score, `provoke (${pktProvoke.externalReaction.score}) > conceal (${pktConceal.externalReaction.score})`);

  const luxScope = 'acoustics-luxury-19c';
  f.host.plugin.debugSetActiveScope(luxScope, '푸딩');
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: baseSettings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '천하연', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: '로어' },
        { name: '천소연', gender: 'female', exposure_intent: 'provoke', sensitive_zones: '음핵', dull_zones: '', basis: '들키는 스릴을 즐겨 일부러 신음을 키우는 성격' }
      ]
    }
  });
  const luxAssist = '5성급 고급 호텔 프라이빗 스위트룸, 완벽한 방음 시공과 두꺼운 방음문으로 외부와 차단되어 있다.\n◈CG\nLOC|5성급 고급 호텔 프라이빗 스위트룸|none|맑음\n@|천하연|hayeon\n@|천소연|soyeon\n◈';
  const luxRecent = {
    runLineage: { runId: 'lux-19c', currentInputHash: 'hlux', priorAssistantHash: 'alux' },
    visibleMessages: [{ role: 'assistant', content: luxAssist }],
    latestUser: '소연과 함께 욕실로 들어가 샤워기 물소리가 쏟아지는 가운데 그녀가 들으라는 듯 일부러 크게 신음을 내며 벽을 짚고 삽입했다.'
  };
  const pktLux = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem', personaName: '푸딩', scopeKey: luxScope,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
    settings: baseSettings, recent: luxRecent
  });
  assert.equal(pktLux.externalReaction.acoustics?.soundproofing, 'very_high');
  assert.equal(pktLux.externalReaction.blockedByAcoustics, true, 'luxury soundproofing + shower blocks provoke intent');
  assert.ok(pktLux.externalReaction.score <= 55, `luxury acoustic cap keeps score <= 55, got ${pktLux.externalReaction.score}`);
  assert.match(pktLux.externalReaction.promptDirective, /설비 차폐로 발각 의도 무산/);

  // 19d: Exiting the sub-room clears active split and restores 천하연 back on-scene
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const exitRecent = {
    runLineage: { runId: 'sub-19d', currentInputHash: 'h19d', priorAssistantHash: 'a19d' },
    visibleMessages: [
      { role: 'assistant', content: motelRoomAssistant },
      { role: 'user', content: splitUser },
      { role: 'assistant', content: bathroomAssist1 },
      { role: 'user', content: silenceRecent.latestUser },
      { role: 'assistant', content: bathroomAssist1 }
    ],
    latestUser: '씻고 욕실에서 나와 방으로 돌아왔다. 하연이 침대 위 소연과 함께 키스하며 가슴을 애무했다.'
  };
  const topoExit = f.host.plugin.debugSpatialTopology({ recent: exitRecent, settings: baseSettings });
  assert.equal(topoExit.active, false, 'sub-room exit clears active split');
  const pktExit = f.host.plugin.debugIntimacyPacket({
    characterName: 'ClauGem', personaName: '푸딩', scopeKey,
    profileGenders: { 푸딩: 'male', 천하연: 'female', 천소연: 'female' },
    settings: baseSettings, recent: exitRecent
  });
  assert.equal(pktExit.gauges.some(g => g.name === '천하연'), true, '천하연 restored on-scene after exiting bathroom');
  assert.equal(pktExit.gauges.some(g => g.name === '천소연'), true, '천소연 remains on-scene after exiting bathroom');

  // 19e: Lore auto-estimation for exposureIntent + GUI [data-intimacy-card-field="exposureIntent"] persistence
  await f.host.plugin.openSettingsGui();
  await new Promise(r => setTimeout(r, 60));
  const guiScope = 'exposure-gui-19e';
  f.host.plugin.debugSetActiveScope(guiScope, '푸딩');
  await f.host.plugin.debugIntimacyLoadCards();
  const autoRec = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings: baseSettings,
    parsed: {
      intimacyReadings: [],
      intimacyProfiles: [
        { name: '한서윤', gender: 'female', sensitive_zones: '귀', dull_zones: '', basis: '비밀을 엄수하고 들킬까 두려워 소리를 죽이는 조심스러운 성격' },
        { name: '차유나', gender: 'female', sensitive_zones: '음핵', dull_zones: '', basis: '들키는 스릴을 즐기며 과시 욕구가 강해 일부러 신음을 키우는 성격' }
      ]
    }
  });
  assert.equal(autoRec.cards.find(c => c.name === '한서윤')?.exposureIntent, 'conceal');
  assert.equal(autoRec.cards.find(c => c.name === '차유나')?.exposureIntent, 'provoke');

  await f.host.plugin.debugNavigateGui('chat');
  const expSelects = [...f.document.querySelectorAll('[data-intimacy-card-field="exposureIntent"]')];
  assert.ok(expSelects.length >= 2, 'GUI renders exposureIntent selects for cards');
  expSelects[0].value = 'provoke';
  expSelects[0].dispatchEvent(new f.document.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const reloadedCards = (await f.host.plugin.debugIntimacyLoadCards())[guiScope] || [];
  assert.equal(reloadedCards[0]?.exposureIntent, 'provoke', 'GUI exposureIntent edit persisted');
});
