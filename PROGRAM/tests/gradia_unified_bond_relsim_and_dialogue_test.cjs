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
  const scanNote = resWithFlags.notes.find(n => /^화술 스캐너 감지/.test(n.title));
  assert.ok(scanNote, '화술 스캐너 감지 note rendered');
  assert.match(scanNote.body, /첫머리 말줄임표 과다:/);
  assert.match(scanNote.body, /단답형 핑퐁 연속:/);
  assert.match(scanNote.body, /따옴표 누락 대사 의심/);
  assert.doesNotMatch(scanNote.body, /Leading ellipsis overuse|Short ping-pong run|Possible unquoted dialogue|Echo-loop pair|Ending convergence/);

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

test('5) dialogue AIDE enforces physical speech causality (deep kiss / slurring vs lip separation) and situational dialogue register', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'dial-causality-1';
  f.host.plugin.debugSetActiveScope(scopeKey, '소연');
  const settings = {
    enableDialogueAide: true,
    enableCharacterAide: true,
    aideStageOrder: ['aide_character'],
    mode: 'normal',
    writingMode: 'rp'
  };

  const kissInput = '"소연아." 푸딩은 허리를 흔들다가 잠시 소연의 팔을 끌어 자신에게 가까이 오게 했다. 그후 그녀의 뒤통수에 손을 얹고 자신의 얼굴 쪽으로 끌어당겨 키스를 나누었다. 소연이 물러나려고 해도 푸딩의 손은 그것을 허락하지 않았다. 소연의 입 속으로 혀가 들어왔다.';
  const crispMidKissDraft = [
    '소연은 그 침묵을 기다리지 않았다. 기대고 나서 곧바로 떼었다.',
    '“대답은 나중에.”',
    '“또 나중이야?”',
    '“…지금은 네가 먼저 끝내.”'
  ].join('\n');

  const block = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: kissInput, visibleMessages: [] },
    ledger: { currentStageDraft: crispMidKissDraft },
    phase: 'analysis'
  });
  assert.match(block, /\[물리 발화 제약\]:.*딥키스·고개 고정 중/, 'stage block detects locked deep kiss constraint');
  assert.match(block, /\[장면 상황·대화 톤\]:.*정사·밀착 스킨십/, 'stage block detects intimacy situation');
  assert.match(block, /speech_causality/, 'dialogue issues expose speech_causality');
  assert.match(block, /situational_fit/, 'dialogue issues expose situational_fit');

  const recCrisp = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: kissInput, visibleMessages: [] },
    draftBefore: crispMidKissDraft,
    draftAfter: crispMidKissDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.ok(recCrisp.reading.draftStats.causalityViolations >= 3, 'crisp mid-kiss fluent dialogue lines flagged as causality violations');
  const scanNote = recCrisp.notes.find(n => /^화술 스캐너 감지/.test(n.title));
  assert.ok(scanNote && /발화 인과 위반 \(딥키스 중\)/.test(scanNote.body), 'Korean UI note renders deep-kiss causality warning');
  assert.doesNotMatch(scanNote.body, /Speech causality violation/, 'raw English flag never leaks into UI notes');

  const separatedDraft = [
    '소연이 겨우 고개를 빼고 입술을 떼어내며 숨을 몰아쉬었다.',
    '“대답은 나중에.”'
  ].join('\n');
  const recSeparated = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: kissInput, visibleMessages: [] },
    draftBefore: separatedDraft,
    draftAfter: separatedDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.equal(recSeparated.reading.draftStats.causalityViolations, 0, 'explicit lip separation beat before dialogue resolves kiss causality');

  const slurredDraft = '“으읍…… 대, 답은… 나중에……”';
  const recSlurred = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: kissInput, visibleMessages: [] },
    draftBefore: slurredDraft,
    draftAfter: slurredDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.equal(recSlurred.reading.draftStats.causalityViolations, 0, 'slurred muffled mid-kiss speech resolves kiss causality');

  const workBlock = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: '손님이 카운터에서 아메리카노를 주문했다. 카페 알바 중인 하연이 응대한다.', visibleMessages: [] },
    phase: 'writing'
  });
  assert.match(workBlock, /업무·근무·손님 응대/, 'detects workplace customer-service situation');

  const dateBlock = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: '저녁 노을이 지는 카페거리에서 두 사람이 손을 잡고 데이트하며 산책했다.', visibleMessages: [] },
    phase: 'writing'
  });
  assert.match(dateBlock, /데이트·로맨틱/, 'detects romantic date situation');

  const stealthBlock = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { latestUser: '옆방 문 너머 복도에서 발소리가 들리는데 숨죽이며 속삭였다.', visibleMessages: [] },
    phase: 'writing'
  });
  assert.match(stealthBlock, /공공장소·제3자 청취 위험/, 'detects public/overhearing risk situation');

  const applied = f.host.plugin.debugDialogueApplyRepairs({
    draftText: crispMidKissDraft,
    repairs: [{
      draft_quote: '"대답은 나중에."',
      replacement: '소연이 겨우 입술을 떼어내며 숨을 몰아쉬었다.\n“대답은 나중에.”'
    }]
  });
  assert.equal(applied.changed, true);
  assert.match(applied.draftText, /입술을 떼어내며 숨을 몰아쉬었다\.\n“대답은 나중에\.”/);
});

test('Dialogue AIDE detects hand-over-mouth muffling, enforces climax vocalization per mouth state, and bridges contraception tone', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.host.plugin.debugSetActiveScope('dialogue-climax-test', '하연');
  const settings = {
    ...(await f.host.plugin.getRuntimeSettings()),
    mode: 'normal',
    writingMode: 'rp',
    enableDialogueAide: true,
    enableCharacterAide: true
  };

  // 1. Hand over mouth + climax narration with zero vocalization quote -> violation flagged
  const handClimaxRecent = {
    visibleMessages: [
      { role: 'char', content: '하연의 손이 입으로 갔다. 손등으로 위를 막고 손바닥으로 아래를 막았다.' }
    ],
    latestUser: '푸딩이 움직임을 이어가자 하연의 허리가 들렸다.'
  };
  const silentClimaxDraft = '하연의 몸이 아래에서부터 들렸다. 배가 위로 꺾였고, 꺾인 자리에서 경련이 시작됐다. 입을 막은 손 아래에서 알아들을 수 없는 소리가 새어 나왔다.';
  const recMissingHand = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: handClimaxRecent,
    draftBefore: silentClimaxDraft,
    draftAfter: silentClimaxDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.ok(recMissingHand.reading.draftStats.causalityViolations >= 1, 'hand-muffled climax without vocal quote triggers violation');

  const stageBlockHand = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: handClimaxRecent,
    ledger: { currentStageDraft: silentClimaxDraft },
    phase: 'analysis'
  });
  assert.match(stageBlockHand, /손으로 입 막힘·소리 억누름 중/);
  assert.match(stageBlockHand, /절정 도달·비자발 발화 필수/);
  assert.match(stageBlockHand, /Missing climax vocalization \(hand_muffled\)/);

  // 2. Climax WITH muffled vocal quote -> zero violation
  const vocalizedHandDraft = '하연의 손이 입으로 갔다. 손등으로 위를 막고 손바닥으로 아래를 막았다. 배가 위로 꺾이며 경련이 시작됐다.\n"으으음…! 흐읍……!"';
  const recOkHand = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: handClimaxRecent,
    draftBefore: vocalizedHandDraft,
    draftAfter: vocalizedHandDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.equal(recOkHand.reading.draftStats.causalityViolations, 0, 'muffled climax vocalization satisfies causality');

  // 3. Unobstructed climax narration without quote -> unrestrained violation flagged
  const openClimaxDraft = '하연의 몸이 아래에서부터 들렸다. 배가 위로 꺾였고, 전신이 경련하며 다리가 떨렸다.';
  const recMissingOpen = f.host.plugin.debugDialogueRecord({
    stageName: 'aide_character',
    settings,
    recent: { visibleMessages: [], latestUser: '하연이 절정에 달한다.' },
    draftBefore: openClimaxDraft,
    draftAfter: openClimaxDraft,
    parsed: { dialogueCheck: [], dialogueRepairs: [] }
  });
  assert.ok(recMissingOpen.reading.draftStats.causalityViolations >= 1, 'unobstructed climax without vocal quote triggers violation');

  const stageBlockOpen = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { visibleMessages: [], latestUser: '하연이 절정에 달한다.' },
    ledger: { currentStageDraft: openClimaxDraft },
    phase: 'analysis'
  });
  assert.match(stageBlockOpen, /Missing climax vocalization \(unrestrained\)/);

  // 4. Intimacy telemetry contraception stance bridges into Dialogue AIDE packet
  f.host.plugin.debugIntimacyPacket({
    characterName: '천하연',
    personaName: '푸딩',
    scopeKey: 'dialogue-climax-test',
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    recent: {
      visibleMessages: [{ role: 'char', content: '고무가 밑동 쪽으로 몰려 접혀 있었다. 푸딩이 "아까 그때. 다시 끼웠어."라고 말했다.' }],
      latestUser: '푸딩이 천하연의 안으로 삽입했다.'
    }
  });
  const bridgedBlock = f.host.plugin.debugDialogueStageBlock({
    stageName: 'aide_character',
    settings,
    recent: { visibleMessages: [], latestUser: '천하연이 숨을 내뱉었다.' },
    phase: 'writing'
  });
  assert.match(bridgedBlock, /피임·안전 반응 톤/);
  assert.match(bridgedBlock, /노콘|생으로/);
});
