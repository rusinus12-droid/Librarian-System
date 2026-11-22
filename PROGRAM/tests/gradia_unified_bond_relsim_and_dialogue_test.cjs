'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

test('1) relationship_sim recognizes intimate encounters and hospital/care events instead of "감지된 관계 이벤트 없음"', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const scopeKey = 'relsim-events-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const settings = {
    enableRelationshipSimAide: true,
    enableCharacterAide: true,
    enableIntimacyAide: true,
    aideStageOrder: ['aide_character'],
    mode: 'normal',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'direct',
    writingMode: 'novel',
    forcedBondCards: {
      [scopeKey]: [
        { id: 'pair-1', from: '@persona', to: '천하연', direction: 'mutual', tones: ['affection'], stage: 'expressed', pressure: 'situational' }
      ]
    }
  };
  await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings(), ...settings });
  await f.host.plugin.debugRelationshipSimSetPair('pair-1', { status: 'lovers' });

  // Intimate encounter -> intimate verdict, not "일반 대화 턴"
  const intimatePrep = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      latestUser: '푸딩은 허리춤을 풀고 바지를 내렸다. 하연은 그의 남성기를 감싸고 비비기 시작했다.',
      visibleMessages: [{ role: 'assistant', content: '하연과 단둘이 모텔 방에 있었다.' }]
    }
  });
  assert.ok(intimatePrep.verdicts.some(v => v.act === 'intimate' && v.expected), 'intimate act detected & rolled');

  // Hospital visit -> care_hospital verdict
  const hospitalPrep = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      latestUser: '열이 내리지 않는 하연을 부축해 함께 병원 진료실로 들어갔다.',
      visibleMessages: [{ role: 'assistant', content: '소연이 체온계를 확인했다.' }]
    }
  });
  assert.ok(hospitalPrep.verdicts.some(v => v.act === 'care_hospital' && v.expected), 'care_hospital act detected & rolled');
  assert.equal(hospitalPrep.scene.activeSession?.kind, 'care_hospital');
});

test('2) date session continuity carries across turns into a motel/intimate scene', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const scopeKey = 'relsim-date-cont-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const settings = {
    enableRelationshipSimAide: true,
    enableCharacterAide: true,
    enableIntimacyAide: true,
    aideStageOrder: ['aide_character'],
    mode: 'normal',
    nsfwGuidanceEnabled: true,
    nsfwMode: 'direct',
    writingMode: 'novel',
    forcedBondCards: {
      [scopeKey]: [
        { id: 'pair-date', from: '@persona', to: '천하연', direction: 'mutual', tones: ['affection'], stage: 'expressed', pressure: 'situational' }
      ]
    }
  };

  // Turn 1: date
  const turn1 = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      runLineage: { runId: 'r1', currentInputHash: 'h1', priorAssistantHash: 'a0' },
      latestUser: '하연과 저녁 같이 먹으며 카페 데이트를 했다.',
      visibleMessages: []
    }
  });
  assert.equal(turn1.scene.activeSession?.kind, 'date');

  // Turn 2: continues into motel intimate scene without repeating "데이트"
  const turn2 = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      runLineage: { runId: 'r2', currentInputHash: 'h2', priorAssistantHash: 'a1' },
      previousTurnUser: '하연과 저녁 같이 먹으며 카페 데이트를 했다.',
      latestUser: '방에 들어와 그녀를 침대에 눕히고 입을 맞추며 애무했다.',
      visibleMessages: [{ role: 'assistant', content: '둘은 카페를 나와 근처 모텔로 향했다.' }]
    }
  });
  assert.equal(turn2.scene.activeSession?.kind, 'date', 'date session carried forward');
  assert.equal(turn2.scene.activeSession?.continuedTo, 'intimate', 'continuedTo intimate recorded');
});

test('3) forced_bond probabilistic simulator rolls on-scene & off-scene NPC<->NPC bonds, persists history, and respects male restriction', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const scopeKey = 'bond-sim-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  f.host.plugin.debugIntimacyPacket({ scopeKey, profileGenders: { 민태오: 'male', 천하연: 'female', 천소연: 'female' }, recent: { latestUser: '', visibleMessages: [] } });
  const settings = {
    enableForcedBondAide: true,
    enablePlotAide: true,
    aideStageOrder: ['aide_plot'],
    mode: 'normal',
    writingMode: 'novel',
    forcedBondAuto: true,
    worldSimulatorMaleRestriction: 'none',
    forcedBondCards: {
      [scopeKey]: [
        { id: 'b-on', from: '@persona', to: '천하연', direction: 'mutual', tones: ['affection', 'jealousy'], stage: 'tension', pressure: 'explicit' },
        { id: 'b-off', from: '민태오', to: '천소연', direction: 'mutual', tones: ['affection', 'curiosity'], stage: 'aware', pressure: 'explicit' }
      ]
    }
  };

  const block = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    settings,
    recent: {
      runLineage: { runId: 'rb1', currentInputHash: 'hb1', priorAssistantHash: 'ab1' },
      latestUser: '하연의 시선이 흔들렸다.',
      visibleMessages: [{ role: 'assistant', content: '하연이 숨을 삼켰다.' }]
    }
  });
  assert.match(block, /\[BOND SIMULATOR \(억결 확률 판정\)\]/);

  // When male restriction is no_interaction, off-scene male card b-off must NOT roll
  const restrictedBlock = f.host.plugin.debugForcedBondStageBlock({
    stageName: 'aide_plot',
    settings: { ...settings, worldSimulatorMaleRestriction: 'no_interaction' },
    recent: {
      runLineage: { runId: 'rb2', currentInputHash: 'hb2', priorAssistantHash: 'ab2' },
      latestUser: '하연의 시선이 흔들렸다.',
      visibleMessages: [{ role: 'assistant', content: '하연이 숨을 삼켰다.' }]
    }
  });
  assert.doesNotMatch(restrictedBlock, /Off-Scene NPC↔NPC Bond Roll:.*민태오/);
});

test('4) dialogue scanner catches leading ellipsis, suspected unquoted lines, and short ping-pong; dialogueReadingNotes always shows review summary', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const scopeKey = 'dial-scan-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');
  const settings = {
    enableDialogueAide: true,
    enableCharacterAide: true,
    aideStageOrder: ['aide_character'],
    mode: 'normal',
    writingMode: 'novel'
  };

  const draft = [
    '"…야."',
    '"…아."',
    '"…조용히."',
    '그럼, 소리 안 나게 하면 되잖아.',
    '"…봐."',
    '"…어."',
    '지금, 안 추운 거 알면서.',
    '"…소연아."'
  ].join('\n');

  const resWithFlags = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { visibleMessages: [] },
    draftBefore: draft,
    draftAfter: draft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.ok(resWithFlags.reading.scannedFlags.some(flag => /Leading ellipsis overuse/.test(flag)), 'ellipsis overuse flagged');
  assert.ok(resWithFlags.reading.scannedFlags.some(flag => /Possible unquoted dialogue/.test(flag)), 'unquoted dialogue flagged');
  assert.ok(resWithFlags.reading.scannedFlags.some(flag => /Short ping-pong run/.test(flag)), 'short ping-pong flagged');
  assert.match(resWithFlags.notes[0].title, /화술 검토 완료 · 교정 0건 · 스캐너 감지/);

  // Clean draft with 0 repairs and 0 flags STILL renders summary note (never empty!)
  const cleanDraft = '"오늘 저녁엔 같이 밥이라도 먹자."\n"좋아, 내가 먼저 식당 잡아둘게."';
  const resClean = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { visibleMessages: [] },
    draftBefore: cleanDraft,
    draftAfter: cleanDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.equal(resClean.notes.length, 1);
  assert.equal(resClean.notes[0].title, '화술 검토 완료 · 특이사항 없음');
  assert.match(resClean.notes[0].body, /총 대사 2줄 검토/);
});
