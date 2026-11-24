'use strict';
// Living World Engine, persistent intimacy/lubrication/sleep gauges, interrupted brink climax,
// zero-bilocation off-scene continuity & card sync, unified single-pass mode, and GUI redesign tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../fixtures/gradia_input_writer_unified_fixture.cjs');
const { gradia, sleep } = require('../fixtures/companion_gui_fixture.cjs');

test('1) intimacy & lubrication gauges persist across reload and stay reroll-safe', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const scopeKey = 'persist-gauge-scope';
  f.host.plugin.debugSetActiveScope(scopeKey, '하준');
  const settings = {
    enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'],
    mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'rp'
  };
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [{ participant: '세라', phase: 'foreplay', position: '', summary: '애무에 달아오름' }],
      intimacyProfiles: [{
        name: '세라', gender: 'female', liked_positions: '정상위', disliked_positions: '',
        sensitive_zones: '유두, 음핵', dull_zones: '',
        foreplay_stance: 'likes', foreplay_style: '가슴 애무에 민감하다.',
        intercourse_stance: 'likes', intercourse_style: '밀착 선호.',
        afterplay_stance: 'likes', afterplay_style: '포옹 선호.',
        basis: '로어북 기준.'
      }]
    }
  });

  const turn1 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: { latestUser: '세라의 유두를 만지며 음핵을 부드럽게 자극한다.', visibleMessages: [] }
  });
  const g1 = turn1.gauges.find(g => g.name === '세라');
  assert.ok(g1 && g1.climaxGauge > 0, 'climax gauge accrues on turn 1');
  assert.ok(g1.lubricationGauge > 0, 'lubrication gauge accrues progressively on turn 1');
  assert.match(turn1.text, /애액·윤활\(lubrication\): \d+\/100/);

  await sleep(20);
  // Simulate restart: wipe in-memory gauges/sleep maps and reload from persistent storage.
  const reloaded = await f.host.plugin.debugGaugeContinuityLoad();
  assert.ok(reloaded.intimacyGauges?.[scopeKey]?.settled?.['세라']?.climax === g1.climaxGauge);
  assert.ok(reloaded.intimacyGauges?.[scopeKey]?.settled?.['세라']?.lubrication === g1.lubricationGauge);

  const turn2Recent = {
    latestUser: '세라의 허리를 감싸고 유두를 다시 핥는다.',
    visibleMessages: [
      { role: 'assistant', content: '세라가 숨을 몰아쉬며 떨었다.' }
    ]
  };
  const turn2 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: turn2Recent
  });
  const g2 = turn2.gauges.find(g => g.name === '세라');
  assert.equal(g2.carriedFromSettled, true, 'turn 2 continues from persisted baseline after reload');
  assert.ok(g2.climaxGauge > g1.climaxGauge, `expected climax > ${g1.climaxGauge}, got ${g2.climaxGauge}`);

  // Reroll with identical inputs: baseline must NOT double-count.
  const turn2Reroll = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: turn2Recent
  });
  const g2Reroll = turn2Reroll.gauges.find(g => g.name === '세라');
  assert.equal(g2Reroll.climaxGauge, g2.climaxGauge, 'reroll must keep identical climax gauge');
  assert.equal(g2Reroll.lubricationGauge, g2.lubricationGauge, 'reroll must keep identical lubrication gauge');
});

test('2) gender-specific reactions, interrupted brink climax via external notice, and full climax', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  // Male behavioral escalation at high ejaculation gauge (80..99 brink)
  const maleScope = 'male-reaction-scope';
  f.host.plugin.debugSetActiveScope(maleScope, '수빈');
  const malePkt = f.host.plugin.debugIntimacyPacket({
    characterName: '진우', personaName: '수빈', scopeKey: maleScope, profileGenders: { 진우: 'male' },
    recent: {
      latestUser: '진우의 귀두를 혀로 훑는다.',
      visibleMessages: [
        { role: 'assistant', content: '진우의 남성기를 쥐고 천천히 문질렀다.' },
        { role: 'assistant', content: '다시 진우의 귀두를 핥으며 속도를 올렸다.' }
      ]
    }
  });
  const gMale = malePkt.gauges.find(g => g.name === '진우');
  assert.equal(gMale.showEjac, true);
  assert.equal(gMale.showClimax, false);
  assert.ok(gMale.ejaculationGauge >= 80 && gMale.ejaculationGauge < 100, `male ejac gauge expected 80..99, got ${gMale.ejaculationGauge}`);
  assert.match(gMale.line, /안절부절못함·참으려/);

  // Female interrupted brink in semi-public library when external notice fires
  let interruptedFound = null;
  for (let i = 0; i < 20; i += 1) {
    const scopeKey = `interrupted-scope-${i}`;
    f.host.plugin.debugSetActiveScope(scopeKey, '하준');
    const res = f.host.plugin.debugIntimacyPacket({
      characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
      recent: {
        latestUser: `세라(${i})와 도서관 열린 문 서가 뒤에서 미약을 마신 채 음핵을 문지르며 질내 삽입해 격렬히 움직인다. 바깥 복도에 사람들이 지나다닌다.`,
        visibleMessages: [
          { role: 'assistant', content: '도서관 한복판, 사람들이 붐비는 열람실 문이 열린 채 세라의 음핵과 질 안을 자극했다.' },
          { role: 'assistant', content: '세라가 비명을 삼키며 보지 안을 조였다.' }
        ]
      }
    });
    const gF = res.gauges.find(g => g.name === '세라');
    if (res.externalReaction?.noticed && gF?.interruptedBrink) {
      interruptedFound = { scopeKey, res, gF };
      break;
    }
  }
  assert.ok(interruptedFound, 'public noticed encounter near climax triggers interruptedBrink');
  assert.equal(interruptedFound.gF.climaxTriggeredThisTurn, false);
  assert.ok(interruptedFound.gF.climaxGauge <= 92);
  assert.match(interruptedFound.gF.line, /외부 간접 개입으로 절정 불발/);

  const engineBlock = f.host.plugin.debugLivingWorldBlock({
    stageName: 'shadow_act',
    recent: {},
    settings: { enablePlotAide: true, enableIntimacyAide: true, mode: 'lite', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'rp' },
    phase: 'writing',
    primePackets: false
  });
  assert.match(engineBlock, /\[LIVING WORLD ENGINE/);
  assert.match(engineBlock, /외부 간접 개입으로 절정 불발/);
});

test('3) sleep wakefulness gauge persists across reload and couples with autonomic arousal during sleep', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'sleep-arousal-scope';
  const settings = { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, enableIntimacyAide: true, nsfwGuidanceEnabled: true, nsfwMode: 'direct', mode: 'normal' };
  const recentSleep = {
    latestUser: '조용히 곁에 앉는다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 침대에 누워 깊이 잠들었다.' }]
  };
  const b1 = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey, recent: recentSleep, settings
  });
  assert.match(b1, /sleep state: asleep/);

  await sleep(20);
  const reloaded = await f.host.plugin.debugGaugeContinuityLoad();
  const storedSleep = reloaded.sleep?.[scopeKey]?.people?.['세라'];
  assert.ok(storedSleep && storedSleep.depth > 0, 'sleep state persists across reload');
  const baseDepth = storedSleep.depth;
  const baseWake = storedSleep.wakefulnessGauge;
  assert.ok(baseWake > 0 && baseWake < 100);

  // Stimulate sleeping character -> both arousal gauge AND wakefulness gauge respond while asleep, and sleep depth decreases synchronously
  const intPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: {
      latestUser: '잠든 세라의 어깨와 가슴, 유두를 부드럽게 쓰다듬는다.',
      visibleMessages: recentSleep.visibleMessages
    }
  });
  const gSleep = intPkt.gauges.find(g => g.name === '세라');
  assert.equal(gSleep.sleeping, true, 'intimacy gauge sees active sleeping state');
  assert.ok(gSleep.climaxGauge > 0, 'bodily arousal accrues even during sleep');
  assert.ok(gSleep.wakefulnessGauge > baseWake, 'wakefulness gauge reflects tactile arousal during sleep');
  assert.match(gSleep.line, /수면 중 자율 신체반응/);

  await sleep(20);
  const afterIntReloaded = await f.host.plugin.debugGaugeContinuityLoad();
  const storedAfter = afterIntReloaded.sleep?.[scopeKey]?.people?.['세라'];
  assert.ok(storedAfter && storedAfter.depth < baseDepth, 'sleep depth decreases proportionally with autonomic arousal');
  assert.equal(storedAfter.wakefulnessGauge, gSleep.wakefulnessGauge);

  // Subsequent quiet turn must NOT snap wakefulnessGauge back down
  const quietFollowup = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey,
    recent: {
      latestUser: '잠시 숨을 고르며 창밖을 본다.',
      visibleMessages: [{ role: 'assistant', content: '세라는 이불 아래에서 작게 숨을 내쉬었다.' }]
    },
    settings
  });
  assert.match(quietFollowup, new RegExp(`wakefulness ${gSleep.wakefulnessGauge}%.*depth ${storedAfter.depth}/200`), 'quiet followup preserves lowered depth and higher wakefulness without snap-back');
});

test('4) zero bilocation excludes on-scene NPCs, syncs off-scene events to chat cards, and renders dossiers', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'bilocation-sync-scope';
  f.host.plugin.debugSetActiveScope(scopeKey, '하준');
  await f.host.plugin.debugLoreLoadCards();
  const settings = {
    writingMode: 'rp', mode: 'lite', enablePlotAide: true, enableWorldDynamicsAide: true, enableForcedBondAide: true,
    worldSimulatorCast: ['세라', '유진', '민호']
  };
  const recentOnScene = {
    latestUser: '세라와 손을 잡고 거실 소파에 앉는다.',
    visibleMessages: [{ role: 'assistant', content: '세라가 하준 옆에서 고개를 끄덕이며 차를 내밀었다.' }]
  };

  const wPkt = f.host.plugin.debugWorldDynamicsPacket({ recent: recentOnScene, settings });
  const telemetry = f.host.plugin.getRuntime().worldDynamicsTelemetry?.[scopeKey];
  assert.ok(telemetry?.offSceneCast?.includes('유진') && telemetry?.offSceneCast?.includes('민호'), 'off-scene cast includes 유진 and 민호');
  assert.equal(telemetry?.offSceneCast?.includes('세라'), false, 'on-scene 세라 must NEVER appear in offSceneCast');
  assert.match(wPkt, /Off-scene cast pool:.*유진/);
  assert.doesNotMatch(wPkt, /Off-scene cast pool:[^\n]*세라/);

  // Even if model output hallucinates an off-scene event with 세라, recordWorldDynamicsOutput strips 세라;
  // meanwhile 유진 + 민호 off-scene event syncs onto bodyState and forcedBond cards.
  const rec = f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_plot',
    settings,
    parsed: {
      worldReadings: [
        { movement: '복제 환각', status: 'surfaced', actors: ['세라', '유진'], place: '카페', summary: '복제 환각 테스트' },
        { movement: '옥상 대화', status: 'surfaced', actors: ['유진', '민호'], place: '학교 옥상', summary: '둘이 옥상에서 진지한 대화를 나누며 가까워졌다.', kind: 'npc_pair_activity' }
      ]
    }
  });
  assert.ok(rec.logs.every(ev => !ev.actors.some(a => a.includes('세라'))), 'on-scene 세라 stripped from persisted off-scene log');
  assert.ok(rec.logs.some(ev => ev.actors.includes('유진') && ev.actors.includes('민호')), 'off-scene 유진-민호 interaction persisted');

  const lore = await f.host.plugin.debugLoreLoadCards();
  const yujinState = (lore.bodyState?.[scopeKey] || []).find(c => c.name === '유진');
  assert.ok(yujinState, '유진 bodyState card created/updated from off-scene sync');
  assert.equal(yujinState.offstagePlace, '학교 옥상');
  assert.match(yujinState.offstageActivity, /옥상/);

  const autoBond = (lore.forcedBond?.[scopeKey] || []).find(c =>
    (c.from === '유진' && c.to === '민호') || (c.from === '민호' && c.to === '유진')
  );
  assert.ok(autoBond, 'off-scene pair forcedBond card auto-synced');
  assert.equal(autoBond.origin, 'auto');
  assert.match(autoBond.lastOffstageSummary, /옥상/);

  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('chat');
  const dossiers = [...f.document.querySelectorAll('[data-chat-person-dossiers] .dossier-card')];
  assert.ok(dossiers.some(card => card.textContent.includes('유진') && card.textContent.includes('학교 옥상')), 'dossier hub shows 유진 off-scene status');
});

test('5) unified single-pass mode (통합 1회) migration, living world engine prompt, and redesigned GUI hub', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    const d = f.doc;
    const modeChoices = [...d.querySelectorAll('#q-runmode .choice')].map(el => el.textContent);
    assert.ok(modeChoices.some(t => t.includes('통합 1회')), '#q-runmode shows 통합 1회');
    assert.ok(modeChoices.some(t => t.includes('정밀 3단계')), '#q-runmode shows 정밀 3단계');

    await f.plugin.debugNavigateGui('pipeline');
    const toggleBtn = d.querySelector('[data-ladder-sub-toggle]');
    assert.ok(toggleBtn, 'collapsible sub-AIDE toggle button exists');
    const ladder = d.querySelector('#ladder');
    assert.equal(ladder.classList.contains('is-subs-collapsed'), true, 'sub-AIDEs collapse cleanly by default');
    toggleBtn.click();
    assert.equal(ladder.classList.contains('is-subs-collapsed'), false, 'clicking toggle expands sub-AIDEs');

    await f.plugin.debugNavigateGui('chat');
    d.querySelector('[data-subtab="readings"]')?.click();
    const filterButtons = [...d.querySelectorAll('[data-readings-filter-bar] [data-readings-filter]')];
    assert.ok(filterButtons.length >= 6, 'readings filter bar renders domain pills');
    const domainCards = [...d.querySelectorAll('.reading-domain-card[data-reading-domain]')];
    assert.equal(domainCards.length, 6, 'all 6 domain reading cards render');

    const intimacyFilter = d.querySelector('[data-readings-filter="intimacy"]');
    intimacyFilter.click();
    assert.equal(d.querySelector('[data-reading-domain="intimacy"]').hidden, false);
    assert.equal(d.querySelector('[data-reading-domain="world"]').hidden, true, 'filtering to intimacy hides unrelated domains');
  } finally {
    await f.close();
  }
});

test('6) Korean josa, unified gender & 6-card hub, male intercourse gauge, kinship relsim guard, and desktop CSS', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const gradiaSrc = fs.readFileSync(path.join(__dirname, '../../plugins/GRADIA.js'), 'utf8');
  const gradiaLine = gradiaSrc.split('\n').find(line => line.includes('const GRADIA_MOCKUP_STYLE = '));
  assert.ok(gradiaLine, 'GRADIA_MOCKUP_STYLE line found');
  const styleCss = JSON.parse(gradiaLine.slice(gradiaLine.indexOf('"'), gradiaLine.lastIndexOf(';')));
  const mobileBlockIdx = styleCss.indexOf('@container app (max-width:900px){\n  .stage-matrix');
  const sixGridIdx = styleCss.indexOf('.char-six-grid{');
  const kpiGridIdx = styleCss.indexOf('.readings-kpi-grid{');
  assert.ok(mobileBlockIdx > 0 && sixGridIdx > mobileBlockIdx && kpiGridIdx > mobileBlockIdx, 'desktop grid classes exist after stage-matrix mobile block');
  assert.ok(styleCss.slice(mobileBlockIdx, sixGridIdx).includes('}\n'), '@container app (max-width:900px) closes before .char-six-grid');
  assert.equal(/--(?:surface-1|surface-2|bg-elev|ink-1|ink-2)\b/.test(styleCss), false, 'no undefined CSS custom variables');

  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  await f.host.plugin.debugLoreLoadCards();
  const scopeKey = 'soyeon-hayeon-scope';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');

  // 1. Korean josa accuracy
  assert.equal(f.host.plugin.debugKoJosa('천하연', '이/가'), '천하연이');
  assert.equal(f.host.plugin.debugKoJosa('푸딩', '을/를'), '푸딩을');
  assert.equal(f.host.plugin.debugKoJosa('푸딩', '이/가'), '푸딩이');
  assert.equal(f.host.plugin.debugKoJosa('천소연', '이/가'), '천소연이');
  assert.equal(f.host.plugin.debugKoJosa('천소연', '과/와'), '천소연과');
  assert.match(f.host.plugin.debugForcedBondBeatIntentKo('relational_action', '천하연', '푸딩'), /^천하연이 푸딩에게/);

  // 2. Lore Age/Gender parsing & state-card + unified gender override + 6-card hub
  const soyeonTraits = f.host.plugin.debugLoreProfileTraits({
    name: '천소연',
    keys: ['천소연'],
    content: 'Name: 천소연\nAge/Gender: 27 F.\n쌍둥이 언니 천하연의 동생. (70A)'
  });
  assert.equal(soyeonTraits.profileLike, true);
  assert.equal(soyeonTraits.gender, 'female');

  const settings = {
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true, enableRelationshipSimAide: true, enableForcedBondAide: true,
    bodyStateCards: {
      [scopeKey]: [
        { id: 'bs-hayeon', name: '천하연', constitution: '프로필상 여성. 생리 중', origin: 'user' },
        { id: 'bs-puding', name: '푸딩', constitution: '프로필상 남성', origin: 'user' }
      ]
    },
    forcedBondCards: {
      [scopeKey]: [
        { id: 'bond-puding-hayeon', from: '푸딩', to: '천하연', stage: 'expressed', tones: ['affection'] },
        { id: 'bond-soyeon-hayeon', from: '천소연', to: '천하연', stage: 'settled', tones: ['protectiveness'], basis: '쌍둥이 자매' }
      ]
    }
  };
  const baseRuntime = await f.host.plugin.getRuntimeSettings();
  await f.host.plugin.saveRuntimeSettings({
    ...baseRuntime,
    mode: 'normal', writing_mode: 'rp', nsfw_mode: 'explicit', nsfw_guidance_enabled: true,
    enable_body_state_aide: true, enable_intimacy_aide: true, enable_relationship_sim_aide: true, enable_forced_bond_aide: true,
    body_state_cards: settings.bodyStateCards,
    forced_bond_cards: settings.forcedBondCards
  });
  await f.host.plugin.listProviderPresets();
  assert.equal(f.host.plugin.debugIntimacyResolveGender({ name: '천하연', card: null, recent: {} }), 'female');
  assert.equal(f.host.plugin.debugIntimacyResolveGender({ name: '푸딩', card: null, recent: {} }), 'male');

  // 3. Male active penetrative intercourse (paced) must still raise ejaculationGauge > 0
  const ejacPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연', personaName: '푸딩', scopeKey,
    profileGenders: { 천하연: 'female', 천소연: 'female', 푸딩: 'male' },
    recent: {
      latestUser: '삽입 후 짧게 뺐다 깊게 넣는 박자를 스스로 조절하며 열이 오른 상대를 부수지 않으려 속도를 늦춤.',
      visibleMessages: [{ role: 'assistant', content: '푸딩이 천하연의 몸 위에 엎드려 정상위로 삽입을 이어갔다.' }]
    }
  });
  const gPuding = ejacPkt.gauges.find(g => g.name === '푸딩');
  assert.ok(gPuding && gPuding.showEjac && gPuding.ejaculationGauge > 0, `expected male intercourse gauge > 0, got ${gPuding?.ejaculationGauge}`);

  // 4. Sibling pair must NOT roll intimate, and active intercourse stops false intimate failure rolls
  await f.host.plugin.debugRelationshipSimSetPair('bond-puding-hayeon', { status: 'lovers', mood: -20 });
  await f.host.plugin.debugRelationshipSimSetPair('bond-soyeon-hayeon', { status: 'friend', mood: 20 });
  const simPrep = await f.host.plugin.debugRelationshipSimPrepare({
    settings,
    recent: {
      latestUser: '삽입 후 천하연의 허리를 감싸 안으며 천소연 앞에서 조용히 숨을 삼킨다.',
      visibleMessages: [{ role: 'assistant', content: '천소연은 걱정스레 지켜보고, 천하연은 푸딩과 몸을 맞대고 있었다.' }]
    }
  });
  assert.equal(simPrep.verdicts.some(v => v.pairId === 'bond-soyeon-hayeon' && v.act === 'intimate'), false, 'kinship pair must not roll intimate');
  assert.equal(simPrep.verdicts.some(v => v.pairId === 'bond-puding-hayeon' && v.act === 'intimate' && v.expected), false, 'active intercourse must not re-roll initiation failure');

  // 5. GUI: sensitiveZones syncs zoneStats, unified gender override works, and 6-card + KPI dashboard render
  f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyProfiles: [{ name: '천하연', liked_positions: '정상위', sensitive_zones: '귀', basis: '로어' }]
    }
  });
  await f.host.plugin.debugSetUnifiedGender(scopeKey, '천하연', 'female');
  const cardsAfterGender = f.host.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings, parsed: {} }).cards;
  assert.equal(cardsAfterGender.find(c => c.name === '천하연')?.anatomyView, 'female');

  const g = await gradia();
  try {
    g.plugin.debugSetActiveScope(scopeKey, '푸딩');
    await g.plugin.debugIntimacyLoadCards();
    g.plugin.debugIntimacyRecord({
      stageName: 'aide_character',
      settings,
      parsed: {
        intimacyProfiles: [{ name: '천하연', liked_positions: '정상위', sensitive_zones: '귀', basis: '로어' }]
      }
    });
    await g.plugin.debugSetUnifiedGender(scopeKey, '천하연', 'female');
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('chat');
    const hayeonDossier = [...g.doc.querySelectorAll('[data-chat-person-dossiers] .char-section-card')]
      .find(el => el.dataset.personDossier === '천하연');
    assert.ok(hayeonDossier, '천하연 character section card renders');
    assert.equal(hayeonDossier.querySelectorAll('.char-six-grid .char-tile').length, 6, 'all 6 data tiles render in per-character grid');
    assert.ok(hayeonDossier.textContent.includes('여성'), '천하연 gender shows 여성, never 미확인');

    // Editing sensitiveZones in GUI syncs zoneStats immediately
    const sensInput = g.doc.querySelector('[data-intimacy-card-field="sensitiveZones"]');
    assert.ok(sensInput, 'sensitiveZones input exists');
    sensInput.value = '유두, 음핵';
    sensInput.dispatchEvent(new g.doc.defaultView.Event('change', { bubbles: true }));
    await sleep(40);
    const updatedCard = g.plugin.debugIntimacyRecord({ stageName: 'aide_character', settings, parsed: {} }).cards.find(c => c.name === '천하연');
    assert.ok((updatedCard?.zoneStats?.breasts_nipples?.sensitivity || 0) > 0, 'sensitiveZones edit syncs zoneStats');

    g.doc.querySelector('[data-subtab="readings"]')?.click();
    assert.ok(g.doc.querySelectorAll('[data-readings-kpi-grid] .readings-kpi').length >= 7, 'readings KPI dashboard cards render');
  } finally {
    await g.close();
  }
});

test('7) contraception status verdict & multi-factor lore-seeded reaction engine across relationship/cycle/childPlan contexts', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  await f.host.plugin.debugLoreLoadCards();
  const scopeKey = 'contraception-multi-scope';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');

  // Case 1: One-night / acquaintance unprotected insertion + bystander in room (천소연 must be excluded!)
  const oneNightSettings = {
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true, enableForcedBondAide: true,
    bodyStateCards: {
      [scopeKey]: [
        { id: 'bs-yuri', name: '김유리', gender: 'female', constitution: '원칙적이고 도도한 성격', basis: '로어: 경계가 강하고 계획적', origin: 'user' },
        { id: 'bs-soyeon', name: '천소연', gender: 'female', origin: 'user' },
        { id: 'bs-puding', name: '푸딩', gender: 'male', origin: 'user' }
      ]
    },
    npcDisposition: {
      [scopeKey]: { default: '', npcs: [{ id: 'n-yuri', name: '김유리', level: 'acquaintance', note: '원나잇 직전 처음 만난 사이' }] }
    }
  };
  const case1Pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '김유리', personaName: '푸딩', scopeKey,
    profileGenders: { 김유리: 'female', 천소연: 'female', 푸딩: 'male' },
    settings: oneNightSettings,
    recent: {
      latestUser: '김유리의 다리 사이로 천천히 삽입한다.',
      visibleMessages: [{ role: 'assistant', content: '김유리는 원나잇 술김에 호텔 방에 들었지만 아직 긴장이 풀리지 않았고, 옆방 복도 소리에 잠깐 귀를 기울였던 천소연은 방 구석에서 물컵만 챙기고 있었다.' }],
      risuActiveLore: [{ content: '김유리는 원칙적이고 자존심이 강한 커리어우먼이다.' }]
    }
  });
  assert.equal(case1Pkt.contraception.length, 1, 'only active participant receives contraception verdict, bystander excluded');
  const vOneNight = case1Pkt.contraception[0];
  assert.equal(vOneNight.name, '김유리');
  assert.equal(vOneNight.protected, false);
  assert.equal(vOneNight.method, 'none_implicit');
  assert.equal(vOneNight.stanceCode, 'demand_stop_anger');
  assert.match(vOneNight.promptDirective, /당장 빼|콘돔/);
  assert.match(case1Pkt.text, /CONTRACEPTION & LORE-BASED REACTION VERDICT/);

  // Case 2: 천하연 생리 5일째 + lovers/more_than_friend + unprotected implicit insertion -> safe_day_allow
  const periodScope = 'contraception-period-scope';
  f.host.plugin.debugSetActiveScope(periodScope, '푸딩');
  const periodSettings = {
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true, enableForcedBondAide: true, enableRelationshipSimAide: true,
    bodyStateCards: {
      [periodScope]: [
        { id: 'bs-hayeon', name: '천하연', gender: 'female', constitution: '생리 5일째, 미열과 하복부 통증', basis: '로어: 조심스럽고 헌신적', origin: 'user' },
        { id: 'bs-soyeon', name: '천소연', gender: 'female', origin: 'user' },
        { id: 'bs-puding', name: '푸딩', gender: 'male', origin: 'user' }
      ]
    },
    forcedBondCards: {
      [periodScope]: [{ id: 'bond-hayeon', from: '푸딩', to: '천하연', stage: 'expressed', tones: ['affection'] }]
    },
    npcDisposition: {
      [periodScope]: { default: '', npcs: [{ id: 'n-hayeon', name: '천하연', level: 'like' }] }
    }
  };
  await f.host.plugin.debugRelationshipSimSetPair('bond-hayeon', { status: 'lovers', mood: 25 });
  const case2Pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연', personaName: '푸딩', scopeKey: periodScope,
    profileGenders: { 천하연: 'female', 천소연: 'female', 푸딩: 'male' },
    settings: periodSettings,
    recent: {
      latestUser: '삽입 후 짧게 뺐다 깊게 넣는 박자를 스스로 조절하며 열이 오른 천하연을 조심히 안는다.',
      visibleMessages: [{ role: 'assistant', content: '천하연은 열과 생리 5일째 복통 속에서도 소리를 죽이고 푸딩의 어깨에 매달렸다. 천소연은 침대 곁에 무릎을 꿇은 채 언니 이마에 손등을 얹고 있었다.' }],
      risuActiveLore: [{ content: '천하연은 책임감이 강하고 사랑하는 사람에게 헌신적인 장녀이다.' }]
    }
  });
  const vPeriod = case2Pkt.contraception.find(c => c.name === '천하연');
  assert.ok(vPeriod, '천하연 contraception verdict computed');
  assert.equal(case2Pkt.contraception.some(c => c.name === '천소연'), false, 'bystander sister 천소연 excluded');
  assert.equal(vPeriod.protected, false);
  assert.equal(vPeriod.cycleWindow, 'menstrual_safe');
  assert.equal(vPeriod.stanceCode, 'safe_day_allow');
  assert.match(vPeriod.promptDirective, /생리|안전일/);

  // Living World Engine prompt binds the contraception verdict into MANDATORY SIMULATOR -> ACTION BINDING
  const liveBlock = f.host.plugin.debugLivingWorldBlock({
    stageName: 'shadow_act',
    recent: {
      latestUser: '삽입 후 짧게 뺐다 깊게 넣는 박자를 조절한다.',
      visibleMessages: [{ role: 'assistant', content: '천하연은 생리 5일째 복통 속에서도 숨을 삼키며 정상위로 몸을 맡겼다.' }]
    },
    settings: periodSettings,
    primePackets: true
  });
  assert.match(liveBlock, /\[피임 판정 · 천하연\]/);
  assert.match(liveBlock, /생리·안전일 감안 수용/);

  // Case 3: Married / engaged couple — childPlan wants/auto vs childPlan none
  const marriedScope = 'contraception-married-scope';
  f.host.plugin.debugSetActiveScope(marriedScope, '푸딩');
  const makeMarriedSettings = childPlan => ({
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true, enableForcedBondAide: true,
    bodyStateCards: {
      [marriedScope]: [
        { id: 'bs-minji', name: '구민지', gender: 'female', childPlan, origin: 'user' },
        { id: 'bs-puding', name: '푸딩', gender: 'male', origin: 'user' }
      ]
    },
    forcedBondCards: {
      [marriedScope]: [{ id: 'bond-minji', from: '푸딩', to: '구민지', stage: 'settled', tones: ['affection'] }]
    },
    npcDisposition: {
      [marriedScope]: { default: '', npcs: [{ id: 'n-minji', name: '구민지', level: 'affection' }] }
    }
  });
  await f.host.plugin.debugRelationshipSimSetPair('bond-minji', { status: 'married', mood: 60 });
  const case3AcceptPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '구민지', personaName: '푸딩', scopeKey: marriedScope,
    profileGenders: { 구민지: 'female', 푸딩: 'male' },
    settings: makeMarriedSettings('wants'),
    recent: {
      latestUser: '구민지를 끌어안고 깊숙이 삽입한다.',
      visibleMessages: [{ role: 'assistant', content: '구민지는 남편 푸딩의 목을 끌어안고 따스하게 눈을 감았다.' }]
    }
  });
  assert.equal(case3AcceptPkt.contraception[0].stanceCode, 'committed_subjective_accept');

  const case3NoChildPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '구민지', personaName: '푸딩', scopeKey: marriedScope,
    profileGenders: { 구민지: 'female', 푸딩: 'male' },
    settings: makeMarriedSettings('none'),
    recent: {
      latestUser: '구민지를 끌어안고 깊숙이 삽입한다.',
      visibleMessages: [{ role: 'assistant', content: '구민지는 남편 푸딩의 목을 끌어안고 따스하게 눈을 감았다.' }]
    }
  });
  assert.equal(case3NoChildPkt.contraception[0].stanceCode, 'committed_no_child_caution');

  // Case 4: Condom explicitly worn -> protected_confirmed
  const case4CondomPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '김유리', personaName: '푸딩', scopeKey,
    profileGenders: { 김유리: 'female', 푸딩: 'male' },
    settings: oneNightSettings,
    recent: {
      latestUser: '콘돔을 끼우고 김유리의 안으로 천천히 삽입한다.',
      visibleMessages: [{ role: 'assistant', content: '김유리는 원나잇 상대인 푸딩을 긴장한 눈으로 바라보았다.' }]
    }
  });
  assert.equal(case4CondomPkt.contraception[0].protected, true);
  assert.equal(case4CondomPkt.contraception[0].method, 'condom');
  assert.equal(case4CondomPkt.contraception[0].stanceCode, 'protected_confirmed');

  // Verify josa particle correctness and fresh-scope prompt ordering (ext evaluated before Living World block)
  assert.match(vPeriod.promptDirective, /천하연은 본인이/);
  assert.doesNotMatch(vPeriod.promptDirective, /은\(는\)/);
  const freshScope = 'contraception-fresh-prompt-scope';
  f.host.plugin.debugSetActiveScope(freshScope, '푸딩');
  const freshPatchPrompt = f.host.plugin.debugBuildAidePatchPrompt(
    'aide_character',
    '푸딩이 김유리의 안으로 조용히 삽입했다.',
    {
      latestUser: '김유리의 다리 사이로 천천히 삽입한다.',
      visibleMessages: [{ role: 'assistant', content: '김유리는 원나잇 술김에 호텔 방에 들었지만 아직 경계를 풀지 않았다.' }]
    },
    {
      ...oneNightSettings,
      bodyStateCards: {
        [freshScope]: [
          { id: 'bs-yuri-fresh', name: '김유리', gender: 'female', constitution: '원칙적이고 도도한 성격', origin: 'user' },
          { id: 'bs-puding-fresh', name: '푸딩', gender: 'male', origin: 'user' }
        ]
      },
      npcDisposition: {
        [freshScope]: { default: '', npcs: [{ id: 'n-yuri-fresh', name: '김유리', level: 'acquaintance' }] }
      }
    }
  );
  assert.match(freshPatchPrompt.system, /\[피임 판정 · 김유리\][^\n]*즉시 제지·분노/);

  // Case 5: GUI renders 피임 판정 card in 이번 턴 판독 and edits childPlan on 상태 카드
  const g = await gradia();
  try {
    g.plugin.debugSetActiveScope(periodScope, '푸딩');
    const gRuntime = await g.plugin.getRuntimeSettings();
    await g.plugin.saveRuntimeSettings({
      ...gRuntime,
      mode: 'normal', writing_mode: 'rp', nsfw_mode: 'explicit', nsfw_guidance_enabled: true,
      enable_body_state_aide: true, enable_intimacy_aide: true, enable_forced_bond_aide: true,
      body_state_cards: periodSettings.bodyStateCards,
      forced_bond_cards: periodSettings.forcedBondCards,
      npc_disposition: periodSettings.npcDisposition
    });
    await g.plugin.debugIntimacyLoadCards();
    g.plugin.debugIntimacyPacket({
      characterName: '천하연', personaName: '푸딩', scopeKey: periodScope,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      settings: periodSettings,
      recent: {
        latestUser: '천하연의 다리 사이로 삽입해 허리를 천천히 움직인다.',
        visibleMessages: [{ role: 'assistant', content: '천하연은 생리 5일째 열기 속에서도 입술을 깨물었다.' }]
      }
    });
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('chat');

    // Verify childPlan select exists and updates state card
    const childPlanSelect = g.doc.querySelector('[data-body-state-card-field="childPlan"][data-card-id="bs-hayeon"]');
    assert.ok(childPlanSelect, '상태 카드 childPlan select renders');
    childPlanSelect.value = 'none';
    childPlanSelect.dispatchEvent(new g.doc.defaultView.Event('change', { bubbles: true }));
    await sleep(30);
    const hayeonDossier = [...g.doc.querySelectorAll('[data-chat-person-dossiers] .char-section-card')]
      .find(el => el.dataset.personDossier === '천하연');
    assert.ok(hayeonDossier && hayeonDossier.textContent.includes('자녀 계획: 자녀 계획 없음'), 'per-character dossier reflects updated childPlan');

    // Verify 이번 턴 판독 renders 피임 판정 card
    g.doc.querySelector('[data-subtab="readings"]')?.click();
    const readingsHtml = g.doc.querySelector('[data-intimacy-readings]')?.textContent || '';
    assert.match(readingsHtml, /피임 판정 · 천하연/);
    assert.match(readingsHtml, /생리·안전일 감안 수용/);
  } finally {
    await g.close();
  }
});

test('8) external reaction gauge tiers drive graduated lore-grounded reactions & GUI meter', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const extScope = 'ext-gauge-tier-scope';
  f.host.plugin.debugSetActiveScope(extScope, '푸딩');

  const settings = {
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true,
    bodyStateCards: {
      [extScope]: [
        { id: 'bs-hayeon', name: '천하연', gender: 'female', constitution: '자존심이 강하고 부끄러움을 타는 성격', basis: '로어', origin: 'user' },
        { id: 'bs-puding', name: '푸딩', gender: 'male', origin: 'user' }
      ]
    }
  };

  // Case 1: Moderate locked motel room (~105/200) — must emit concrete corridor/wall tension + locked-room boundary even if noticed=false
  const motelRecent = {
    latestUser: '광안리 근처 모텔 2층 방 문을 잠그고 입을 막아 조용히 숨을 삼키며 천하연의 허리를 안아 삽입한다.',
    visibleMessages: [
      { role: 'assistant', content: '복도에 누군가 지나가는 기척이 스치고, 침대가 삐걱거리며 큰 소리로 삐걱댔다. 천하연은 입술을 깨물며 절정에 다다른 거친 신음을 흘렸다.' }
    ]
  };
  const motelPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연', personaName: '푸딩', scopeKey: extScope,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings,
    recent: motelRecent
  });
  const mExt = motelPkt.externalReaction;
  assert.ok(mExt, 'externalReaction computed');
  assert.ok(mExt.score >= 80 && mExt.score < 120, `expected moderate score 80..119, got ${mExt.score}`);
  assert.equal(mExt.riskBand, 'moderate');
  assert.equal(mExt.riskLabelKo, '보통');
  assert.equal(mExt.tierId, 'moderate');
  assert.match(mExt.promptDirective, /잠긴 밀실/);
  assert.match(motelPkt.text, /Gauge-driven reaction directive:/);

  const shadowLiving = f.host.plugin.debugLivingWorldBlock({ stageName: 'shadow_act', recent: motelRecent, settings, primePackets: true });
  assert.match(shadowLiving, /\[외부반응 게이지 \d+\/200 · (?:중간 경계|간접 인지)/);
  const patchLiving = f.host.plugin.debugLivingWorldBlock({ stageName: 'aide_intimacy', recent: motelRecent, settings, phase: 'patch', primePackets: true });
  assert.match(patchLiving, /external reaction gauge tier/);

  // Case 2: Critical semi-public exposure (200/200)
  const libRecent = {
    latestUser: '도서관 서고 열린 문 앞에서 큰 소리로 신음을 터뜨리며 절정에 달한다.',
    visibleMessages: [{ role: 'assistant', content: '주변에 사람들이 오가고 사서가 복도 끝에 있었다.' }]
  };
  const libPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연', personaName: '푸딩', scopeKey: extScope,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings,
    recent: libRecent
  });
  assert.equal(libPkt.externalReaction.score, 200);
  assert.equal(libPkt.externalReaction.tierId, 'critical');
  assert.equal(libPkt.externalReaction.riskLabelKo, '매우 높음');
  const libLiving = f.host.plugin.debugLivingWorldBlock({ stageName: 'shadow_act', recent: libRecent, settings, primePackets: true });
  assert.match(libLiving, /\[외부반응 게이지 200\/200 · 극한 노출/);

  // Case 3: Quiet locked private room (< 60) -> no false external interruption in Living World Block when noticed=false
  const quietRecent = {
    latestUser: '내 방 문을 잠그고 조용히 입을 막으며 한적한 밤에 천하연을 끌어안고 삽입한다.',
    visibleMessages: []
  };
  const quietPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '천하연', personaName: '푸딩', scopeKey: extScope,
    profileGenders: { 천하연: 'female', 푸딩: 'male' },
    settings,
    recent: quietRecent
  });
  assert.ok(quietPkt.externalReaction.score < 60, `expected quiet score < 60, got ${quietPkt.externalReaction.score}`);
  assert.equal(quietPkt.externalReaction.tierId, 'quiet');
  if (!quietPkt.externalReaction.noticed) {
    const quietLiving = f.host.plugin.debugLivingWorldBlock({ stageName: 'shadow_act', recent: quietRecent, settings, primePackets: true });
    assert.doesNotMatch(quietLiving, /\[외부반응 게이지/);
  }

  // Case 4: GUI renders 외부반응 게이지 meter, Korean risk band (위험도 보통), and 발현 반응
  const g = await gradia();
  try {
    g.plugin.debugSetActiveScope(extScope, '푸딩');
    const gRuntime = await g.plugin.getRuntimeSettings();
    await g.plugin.saveRuntimeSettings({
      ...gRuntime,
      mode: 'normal', writing_mode: 'rp', nsfw_mode: 'explicit', nsfw_guidance_enabled: true,
      enable_body_state_aide: true, enable_intimacy_aide: true,
      body_state_cards: settings.bodyStateCards
    });
    await g.plugin.debugIntimacyLoadCards();
    g.plugin.debugIntimacyPacket({
      characterName: '천하연', personaName: '푸딩', scopeKey: extScope,
      profileGenders: { 천하연: 'female', 푸딩: 'male' },
      settings,
      recent: motelRecent
    });
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('chat');
    g.doc.querySelector('[data-subtab="readings"]')?.click();
    const readingsHtml = g.doc.querySelector('[data-intimacy-readings]')?.textContent || '';
    assert.match(readingsHtml, /외부반응 게이지/);
    assert.match(readingsHtml, /위험도 보통/);
    assert.doesNotMatch(readingsHtml, /위험도 MODERATE/);
    assert.match(readingsHtml, /발현 반응:/);
  } finally {
    await g.close();
  }
});

test('9) forced bond compound tones, RP NPC-side action, close posture, Living World binding, and rich GUI verdicts', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const bondScope = 'forced-bond-rich-scope';
  f.host.plugin.debugSetActiveScope(bondScope, '푸딩');

  const cards = [
    { id: 'b-soyeon-puding', from: '@persona', to: '천소연', direction: 'mutual', tones: ['wariness', 'dependence'], stage: 'tension', pressure: 'explicit' },
    { id: 'b-hayeon-puding', from: '@persona', to: '천하연', direction: 'mutual', tones: ['wariness', 'jealousy', 'protectiveness'], stage: 'tension', pressure: 'explicit' },
    { id: 'b-soyeon-hayeon', from: '천소연', to: '천하연', direction: 'mutual', tones: ['protectiveness', 'wariness'], stage: 'aware', pressure: 'situational' }
  ];
  const settings = {
    mode: 'normal',
    writingMode: 'rp',
    enableForcedBondAide: true,
    enablePlotAide: true,
    forcedBondAuto: true,
    forcedBondCards: { [bondScope]: cards },
    bodyStateCards: {
      [bondScope]: [
        { id: 'bs-soyeon', name: '천소연', gender: 'female', constitution: '언니를 지키려 애쓰지만 내심 불안이 많은 성격', basis: '로어', origin: 'user' },
        { id: 'bs-hayeon', name: '천하연', gender: 'female', constitution: '자존심이 세지만 곁을 빼앗기기 싫어하는 성격', basis: '로어', origin: 'user' }
      ]
    }
  };
  const recent = {
    runLineage: { runId: 'fb-rich-1', currentInputHash: 'hfb1', priorAssistantHash: 'afb1' },
    latestUser: '침대 곁에 다가앉아 열에 들뜬 천하연과 곁을 지키는 천소연의 손을 번갈아 살핀다.',
    visibleMessages: [
      { role: 'assistant', content: '천소연은 경계 어린 시선으로 푸딩을 훑으면서도 이마를 짚어 주는 손길에 작게 떨었다. 천하연은 시선을 피하다가 질투 어린 눈으로 옷자락을 쥐었다.' }
    ]
  };

  // 1) forcedBondStageBlock builds telemetry with NPC-side RP actor, compound tones, and close-posture KO action
  const stageBlock = f.host.plugin.debugForcedBondStageBlock({ stageName: 'aide_plot', recent, settings, phase: 'analysis' });
  assert.match(stageBlock, /\[BOND SIMULATOR \(억결 확률 판정\)\]/);
  assert.match(stageBlock, /and summary \(one concise Korean sentence/);

  // 2) Record bondReadings and verify Living World Engine binds concrete behavioral beat (never old fallback placeholder)
  const recorded = f.host.plugin.debugForcedBondRecord({
    stageName: 'aide_plot',
    settings,
    parsed: {
      bondReadings: [
        {
          card: 'b-soyeon-puding',
          tones: ['wariness', 'dependence'],
          stage: 'tension',
          evidence: 'recent',
          summary: '천소연이 이마를 짚어 주는 푸딩의 손목을 경계 어린 눈초리로 살피면서도 끝내 뿌리치지 않고 소매 끝을 살짝 붙잡는다.'
        },
        {
          card: 'b-hayeon-puding',
          tones: ['wariness', 'jealousy', 'protectiveness'],
          stage: 'tension',
          evidence: 'recent',
          summary: '천하연이 천소연 쪽을 살피는 푸딩의 턱선을 끌어당겨 시선을 고정시킨 뒤 열기 속에서도 동생 앞을 감싸려 몸을 기울인다.'
        },
        {
          card: 'b-soyeon-hayeon',
          tones: ['protectiveness', 'wariness'],
          stage: 'aware',
          evidence: 'recent',
          summary: '천소연이 천하연의 젖은 이마를 닦아 주며 푸딩 쪽의 숨은 의도를 경계하는 눈빛을 교환한다.'
        }
      ]
    }
  });
  const rolls = recorded.telemetry?.rolls || [];
  assert.ok(rolls.length >= 2, 'rolls populated');
  const soyeonRoll = rolls.find(r => r.cardId === 'b-soyeon-puding');
  const hayeonRoll = rolls.find(r => r.cardId === 'b-hayeon-puding');
  assert.ok(soyeonRoll && hayeonRoll, 'soyeon and hayeon rolls exist');
  assert.equal(soyeonRoll.actor, '천소연', 'RP mode resolves NPC as autonomous actor');
  assert.equal(hayeonRoll.actor, '천하연', 'RP mode resolves NPC as autonomous actor');
  assert.match(soyeonRoll.beatIntentKo, /동시에.*의지하는 기색을 비친다/);
  assert.match(hayeonRoll.beatIntentKo, /경계 어린 눈초리로 살피며/);
  assert.match(hayeonRoll.beatIntentKo, /동시에.*신경을 곤두세우고 되돌린다/);
  assert.ok(soyeonRoll.contextualDirectiveKo && soyeonRoll.contextualDirectiveKo.includes('[로어 성격:'), 'lore reaction brief woven into directive');

  const livingShadow = f.host.plugin.debugLivingWorldBlock({ stageName: 'shadow_act', recent, settings });
  assert.match(livingShadow, /\[억결 (?:행동 비트|기조 행동 유지)/);
  assert.doesNotMatch(livingShadow, /시선·거리·대사·선택의 구체적 행동 변화로 실현하라\./);
  const livingPatch = f.host.plugin.debugLivingWorldBlock({ stageName: 'aide_plot', recent, settings, phase: 'patch' });
  assert.match(livingPatch, /forced-bond behavioral beat/);

  // 3) Debug note builder and GUI render rich verdicts (never bare tag pairs alone and no raw card IDs under dialogue)
  const bondNotes = f.host.plugin.debugForcedBondReadingNotes(bondScope);
  assert.equal(bondNotes.length, 3);
  assert.ok(bondNotes[0].title.includes('→'), `resolved pair title: ${bondNotes[0].title}`);
  assert.match(bondNotes[0].body, /본문 발현:.*손목을 경계 어린 눈초리로/);
  assert.match(bondNotes[0].body, /요구 행동:/);

  const g = await gradia();
  try {
    g.plugin.debugSetActiveScope(bondScope, '푸딩');
    const gRuntime = await g.plugin.getRuntimeSettings();
    await g.plugin.saveRuntimeSettings({
      ...gRuntime,
      mode: 'normal', writing_mode: 'rp',
      enable_forced_bond_aide: true, enable_plot_aide: true,
      forced_bond_cards: settings.forcedBondCards,
      body_state_cards: settings.bodyStateCards
    });
    g.plugin.debugForcedBondStageBlock({ stageName: 'aide_plot', recent, settings });
    g.plugin.debugForcedBondRecord({
      stageName: 'aide_plot',
      settings,
      parsed: {
        bondReadings: [
          {
            card: 'b-soyeon-puding',
            tones: ['wariness', 'dependence'],
            stage: 'tension',
            evidence: 'recent',
            summary: '천소연이 푸딩의 손목을 경계하며 살피면서도 끝내 놓지 못하고 소매 끝을 붙잡는다.'
          }
        ]
      }
    });
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('chat');
    g.doc.querySelector('[data-subtab="readings"]')?.click();
    const relsimText = g.doc.querySelector('[data-relsim-readings]')?.textContent || '';
    const dialText = g.doc.querySelector('[data-dialogue-readings]')?.textContent || '';
    assert.match(relsimText, /천소연 → 푸딩/);
    assert.match(relsimText, /본문 발현:.*소매 끝을 붙잡는다/);
    assert.match(relsimText, /요구 행동:/);
    assert.doesNotMatch(dialText, /b-soyeon-puding/, 'raw card ID must not leak into dialogue readings');
  } finally {
    await g.close();
  }
});

test('10) stage latency fixes: ollama_cloud budget & low patch effort, empty-output length-stop drops effort, prefix cache reuse, non-host intimacy compaction, and recall/retry telemetry', async t => {
  const capturedBodies = [];
  const host = await require('./host.cjs').load({
    transformSource: source => source.replace(
      "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
      "    __testCallLLM: callLLMWithPreset,\n    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {"
    ),
    api: {
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          // Simulate ollama_cloud hitting max_tokens inside hidden <think>: empty content + omitted reasoning_tokens
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              model: body.model,
              choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
              usage: { prompt_tokens: 1200, completion_tokens: 12869, total_tokens: 14069 }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            model: body.model,
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage: 'aide_plot', ok: true, edits: [] })
              },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 1200, completion_tokens: 240, total_tokens: 1440 }
          })
        };
      }
    }
  });

  const ollamaCloudPreset = {
    provider: 'ollama_cloud',
    url: 'https://ollama.com/v1/chat/completions',
    key: 'synthetic-key',
    model: 'deepseek-v4.1-flash:1017-cloud',
    reasoning_preset: 'ollama',
    reasoning_effort: 'none',
    max_tokens: 16384,
    stream: false
  };

  // 10a: ollama_cloud + deepseek-v4.1-flash:1017-cloud budget & patch effort = low + aide_plot headroom
  const budget = host.plugin.debugDraftBudgetForStage({ draftBudgetPreset: 'balanced' }, 'shadow_act', ollamaCloudPreset);
  assert.ok(budget && budget.label === '밸런스드', 'ollama_cloud deepseek-v4.1-flash recognized by draftBudgetForStage');

  for (const profile of ['custom', 'quality', 'balanced']) {
    const policy = host.plugin.debugStageReasoningPolicy({ quickProfile: profile }, 'aide_plot', 'patch', ollamaCloudPreset);
    assert.equal(policy.effort, 'low', `${profile} patch defaults to low effort instead of medium`);
  }

  const baseBudget = host.plugin.debugAidePatchOutputTokenBudget({ quickProfile: 'balanced' }, '본문 '.repeat(400), 16384, { ...ollamaCloudPreset, reasoning_effort: 'low' });
  const plotBudget = host.plugin.debugAidePatchOutputTokenBudget({ quickProfile: 'balanced', enableForcedBondAide: true }, '본문 '.repeat(400), 16384, { ...ollamaCloudPreset, reasoning_effort: 'low' }, 'aide_plot');
  assert.ok(plotBudget > baseBudget, `aide_plot with hosted sub-AIDEs gets higher headroom (${plotBudget} > ${baseBudget})`);

  // 10b: empty-output finish_reason='length' on ollama_cloud (no reasoning_tokens reported) drops effort to low & injects nudge
  const callSettings = {
    quickProfile: 'custom',
    defaultPresetName: 'cloud',
    presets: { cloud: { ...ollamaCloudPreset, reasoning_effort: 'medium' } },
    stagePresetNames: { aide_plot: 'cloud' },
    failureMode: 'hard'
  };
  const retryRes = await host.plugin.__testCallLLM(callSettings, 'aide_plot', 'Patch system prompt', 'Patch user prompt', {
    promptPhase: 'patch',
    maxTokens: 12869,
    jsonMode: true
  });
  assert.equal(retryRes.ok, true, 'length retry succeeded after empty output');
  assert.equal(capturedBodies.length, 2, 'exactly 2 HTTP attempts made');
  assert.equal(capturedBodies[0].reasoning_effort, 'medium');
  assert.equal(capturedBodies[1].reasoning_effort, 'low', 'retry dropped reasoning_effort to low even without usage.reasoning_tokens');
  assert.ok(capturedBodies[1].max_tokens > capturedBodies[0].max_tokens, 'retry expanded max_tokens');
  assert.match(JSON.stringify(capturedBodies[1].messages), /CRITICAL RETRY: The previous response exhausted output tokens on hidden reasoning/);

  // 10c: cross-stage referencePacketHash reuse when all lore fits + authorNote master switch active, and compact non-host intimacy block
  const loreEntry = {
    id: 'lore-hayeon', key: '천하연', label: '천하연', source: 'character_lorebook', sourceType: 'character',
    content: '천하연은 단정하고 책임감이 강한 장녀이다.', activationRoute: 'keyword', enabled: true
  };
  const sharedContext = {
    snapshot: {
      character: { chaId: 'c1', name: '천하연', description: '성실한 언니', chats: [] },
      chatInfo: { chat: { id: 'chat1', note: '작가 노트: 비 오는 밤 모텔' } },
      authorNote: { content: '작가 노트: 비 오는 밤 모텔', enabled: true, position: 'author_note' },
      cbsContext: {},
      actualChatContext: { characterName: '천하연', personaName: '푸딩', messages: [] }
    },
    meta: {
      references: { authorNote: true, persona: true, characterDescription: true, characterLorebook: true, moduleLorebook: true },
      loreActivationMode: 'hybrid_gradia_v1'
    },
    authorNote: { content: '작가 노트: 비 오는 밤 모텔', enabled: true },
    loreRerankPool: [loreEntry],
    retrievedActiveLore: [loreEntry],
    selectedCandidates: [loreEntry],
    loreRerank: { enabled: true, stage: 'shadow_act', selected: [loreEntry], omittedCount: 0 },
    referenceCapacity: { effectiveBudgetChars: 48000 },
    referencePacketBlock: 'CANONICAL_PACKET_UNIFIED',
    referencePacketHash: 'hash-unified-v1',
    referencePacket: { viewHash: 'hash-unified-v1', selectionHash: 'sel-1', packedHash: 'pack-1' },
    block: 'CANONICAL_PACKET_UNIFIED'
  };
  const hashes = [];
  for (const stage of ['shadow_act', 'aide_character', 'aide_world', 'aide_plot']) {
    const refs = stage === 'shadow_act'
      ? { authorNote: true, persona: true, characterDescription: true, characterLorebook: true, moduleLorebook: true }
      : { authorNote: false, persona: true, characterDescription: true, characterLorebook: true, moduleLorebook: true };
    const view = host.plugin.debugMaterializeSharedRisuContext(sharedContext, { latestUser: '계속한다' }, { activeStageName: stage, mode: 'normal' }, refs);
    hashes.push(view.referencePacketHash);
    assert.equal(view.meta.stageReferenceRematerialized, false, `${stage} reuses shared prefix without rematerializing`);
    assert.equal(view.meta.references.authorNote, true, `${stage} reflects SHADOW authorNote master switch`);
  }
  assert.deepEqual(hashes, ['hash-unified-v1', 'hash-unified-v1', 'hash-unified-v1', 'hash-unified-v1'], 'all 4 stages share exact prefix hash for KV cache');

  const sexRecent = {
    latestUser: '침대 위에서 정상위로 천천히 삽입한다.',
    visibleMessages: [{ role: 'assistant', content: '천하연은 시트를 움켜쥐었다.' }]
  };
  const hostIntimacyBlock = host.plugin.debugIntimacyStageBlock({
    stageName: 'aide_character',
    phase: 'patch',
    recent: sexRecent,
    settings: { enableIntimacyAide: true, enableCharacterAide: true, mode: 'normal', writingMode: 'rp', nsfwMode: 'direct', nsfwGuidanceEnabled: true }
  });
  const plotIntimacyBlock = host.plugin.debugIntimacyStageBlock({
    stageName: 'aide_plot',
    phase: 'patch',
    recent: sexRecent,
    settings: { enableIntimacyAide: true, enablePlotAide: true, enableCharacterAide: true, mode: 'normal', writingMode: 'rp', nsfwMode: 'direct', nsfwGuidanceEnabled: true }
  });
  assert.match(hostIntimacyBlock, /REFERENCE NOTES:/, 'host aide_character keeps reference notes');
  assert.doesNotMatch(plotIntimacyBlock, /REFERENCE NOTES:/, 'non-host aide_plot omits anatomy reference textbook');
  assert.match(plotIntimacyBlock, /STAGE DUTY: Plot AIDE: check the pacing across phases/, 'non-host aide_plot keeps its stage duty');

  // 10d: GUI displays LIB recall elapsedMs and stage retry count in results panel
  const g = await gradia({
    transformSource: source => source.replace(
      "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
      "    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {"
    )
  });
  try {
    const gr = g.plugin.__testRuntime;
    gr.stageTrace = [
      { stage: 'shadow_act', ok: true, elapsedMs: 12000, model: 'deepseek-v4.1-flash:1017-cloud', parsed: { draft: { rp_text: '초안 본문' } } },
      { stage: 'aide_plot', ok: true, elapsedMs: 88349, model: 'deepseek-v4.1-flash:1017-cloud', parsed: { edits: [], analysis: { summary: '문제 없음' } } }
    ];
    gr.callTelemetry = {
      attempts: [
        { stage: 'aide_plot', attemptRole: 'primary', elapsedMs: 43278 },
        { stage: 'aide_plot', attemptRole: 'length_expansion', elapsedMs: 43527 }
      ]
    };
    gr.lastMemoryRecall = {
      elapsedMs: 28953,
      owners: [
        { owner: 'libra', status: 'ok', chars: 9606, elapsedMs: 12400, content: 'LIBRA 회상' },
        { owner: 'hayaku', status: 'ok', chars: 3578, elapsedMs: 8100, content: 'HAYAKU 회상' },
        { owner: 'flashback', status: 'ok', chars: 3945, elapsedMs: 8450, content: 'Flashback 회상' }
      ]
    };
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('results', 's');
    await sleep(30);
    const shadowPanelText = g.doc.querySelector('[data-subpanel="s"]')?.textContent || '';
    const plotStatusText = g.doc.querySelector('[data-subpanel="p"] .gx-status')?.textContent || '';
    assert.match(shadowPanelText, /회상 29s/);
    assert.match(shadowPanelText, /12s/);
    assert.match(plotStatusText, /재시도 1회/);
  } finally {
    await g.close();
  }
});

test('11) scene variance context-awareness, meta-tag cleanup, common-verb fixation filter, and GUI panel', async (t) => {
  // 11a + 11b: Intimate posture adaptation, awake lore targeting, sleep guard, category filter
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  t.after(() => f.host.plugin.debugSetSceneVarianceRandom(null));

  const loreData = [
    { name: '천하연', key: '천하연', content: '[천하연]\n성별: 여성\n성격: 자존심이 세고 감정을 잘 숨기지만 밀착 시 호흡이 가빠지며 시트를 움켜쥐는 버릇이 있다.' }
  ];
  const recentIntimate = {
    personaName: '푸딩',
    characterName: '천하연',
    chatKey: 'chat-var-11a',
    loreEntries: loreData,
    latestUser: '침대 위에서 정상위로 천천히 삽입한다.',
    latestAssistantRaw: '천하연이 숨을 삼키며 시트를 쥔 채 고개를 떨군다.',
    recentHistory: [
      { role: 'user', content: '침대 위에서 정상위로 천천히 삽입한다.' },
      { role: 'assistant', content: '천하연이 열과 통증 속에서도 소리를 죽이며 시트를 물고 버틴다.' }
    ],
    runLineage: { runId: 'var-11a', currentInputHash: 'h-11a' }
  };

  f.host.plugin.debugSetSceneVarianceRandom([0.1, 0.0, 0.30]);
  const intimateBlock = f.host.plugin.debugSceneBlock({
    stageName: 'shadow_act',
    recent: recentIntimate,
    settings: { sceneVariance: 'medium', writingMode: 'rp', enableIntimacyAide: true }
  });
  const intimateRun = f.host.plugin.debugSceneVarianceRun();
  assert.equal(intimateRun?.variable?.category, 'inner');
  assert.equal(intimateRun?.variable?.postureAdapted, true);
  assert.equal(intimateRun?.variable?.targetActor, '천하연');
  assert.doesNotMatch(intimateBlock, /stand up/);
  assert.match(intimateBlock, /- Concrete grounding for this scene:/);
  assert.match(intimateBlock, /천하연/);

  const plotVarBlock = f.host.plugin.debugSceneBlock({
    stageName: 'aide_plot',
    recent: recentIntimate,
    settings: { sceneVariance: 'medium', writingMode: 'rp', enableIntimacyAide: true }
  });
  assert.match(plotVarBlock, /- AIDE realization check:/);

  // 11b: All present NPCs asleep -> RP scene variance restricts to 'world'
  const sleepScope = 'chat-var-11b';
  f.host.plugin.debugBodyStatePacket({
    personaName: '푸딩',
    characterName: '천하연',
    scopeKey: sleepScope,
    recent: {
      latestUser: '천하연의 이마에 손을 얹어본다.',
      visibleMessages: [{ role: 'assistant', content: '천하연이 침대에 누워 깊이 잠들었다.' }]
    },
    settings: { writingMode: 'rp', enableBodyStateAide: true }
  });
  const recentAllAsleep = {
    personaName: '푸딩',
    characterName: '천하연',
    chatKey: sleepScope,
    scopeKey: sleepScope,
    loreEntries: loreData,
    latestUser: '천하연의 이마에 손을 얹어본다.',
    latestAssistantRaw: '천하연이 깊이 잠들어 규칙적으로 숨을 쉰다.',
    recentHistory: [{ role: 'user', content: '천하연의 이마에 손을 얹어본다.' }],
    runLineage: { runId: 'var-11b-sleep', currentInputHash: 'h-11b-sleep' }
  };
  f.host.plugin.debugSetSceneVarianceRandom([0.0, 0.0, 0.0]);
  const sleepBlock = f.host.plugin.debugSceneBlock({
    stageName: 'shadow_act',
    recent: recentAllAsleep,
    settings: { sceneVariance: 'medium', writingMode: 'rp' }
  });
  const sleepRun = f.host.plugin.debugSceneVarianceRun();
  assert.equal(sleepRun?.variable?.category, 'world');
  assert.match(sleepBlock, /THIS TURN’S VARIABLE/);

  // Category filter restriction to 'initiative'
  f.host.plugin.debugSetSceneVarianceRandom([0.0, 0.0, 0.25]);
  f.host.plugin.debugSceneBlock({
    stageName: 'shadow_act',
    recent: {
      personaName: '푸딩',
      characterName: '천하연',
      chatKey: 'chat-var-11b-cat',
      scopeKey: 'chat-var-11b-cat',
      loreEntries: loreData,
      latestUser: '창가 쪽에서 대화를 나눈다.',
      latestAssistantRaw: '천하연이 고개를 끄덕인다.',
      recentHistory: [{ role: 'user', content: '창가 쪽에서 대화를 나눈다.' }],
      runLineage: { runId: 'var-11b-cat', currentInputHash: 'h-11b-cat' }
    },
    settings: {
      sceneVariance: 'medium',
      sceneVarianceCategories: ['initiative'],
      writingMode: 'rp'
    }
  });
  assert.equal(f.host.plugin.debugSceneVarianceRun()?.variable?.category, 'initiative');

  // 11c: cleanSceneMetaText unwraps ["..."] in purpose/arc + common narrative verbs filtered in fixation detection
  const cleanedPurpose = f.host.plugin.debugRememberScenePurpose(
    { latestUser: '테스트', runLineage: { runId: 'var-11c', currentInputHash: 'h-11c' } },
    '["하연이 몸으로 버티며 자리를 확인한다."]',
    'aide_character',
    '["서로의 거리를 시험하는 중반부."]'
  );
  assert.equal(cleanedPurpose?.text, '하연이 몸으로 버티며 자리를 확인한다.');
  assert.equal(cleanedPurpose?.arc, '서로의 거리를 시험하는 중반부.');
  assert.doesNotMatch(cleanedPurpose?.text || '', /^\[|\]$/);

  const assistantMsgs = [
    '"이리 와." 그녀가 말했다. 잠시 숨을 멈췄다가 눈을 감았다. "왜?" 다시 물었다.',
    '"그만해." 그가 말했다. 발걸음을 멈췄고 눈을 감았다. "정말?" 또 물었다.',
    '"세지 마." 그녀가 말했다. 말을 멈췄다. 눈을 감았다. "아니?" 물었다.',
    '"조금만 더 세면 괜찮을 거야." 말했다. 멈췄다가 감았다. 물었다.',
    '"네가 자꾸 숫자를 셀게 뻔해. 하나씩 세어 봐." 말했다. 멈췄다. 감았다. 물었다.',
    '"결국 또 몇 번인지 센다." 말했다. 멈췄다. 감았다. 물었다.'
  ].map(content => ({ role: 'assistant', content }));
  const fixation = f.host.plugin.debugSceneFixationDetect({ visibleMessages: assistantMsgs });
  const flaggedStems = new Set((Array.isArray(fixation) ? fixation : []).map(item => item.stem));
  assert.equal(flaggedStems.has('세'), true, 'real fixation stem 세 still caught');
  for (const commonStem of ['말했', '물', '물었', '멈췄', '감', '감았']) {
    assert.equal(flaggedStems.has(commonStem), false, `common narrative verb stem ${commonStem} must not be flagged`);
  }

  // 11d: GUI panel controls, enable button, readings banner, and import roundtrip
  const importedSlice = f.host.plugin.debugImportedRuntimeToGuiSlice({
    sceneVariance: 'high',
    sceneVarianceCategories: ['inner', 'world']
  }, {});
  assert.equal(importedSlice.sceneVariance, 'high');
  assert.deepEqual([...(importedSlice.sceneVarianceCategories || [])], ['inner', 'world']);

  const g = await gradia();
  try {
    g.plugin.debugSetSceneVarianceRandom([0.1, 0.0, 0.30]);
    g.plugin.debugSceneBlock({
      stageName: 'shadow_act',
      recent: recentIntimate,
      settings: { sceneVariance: 'medium', writingMode: 'rp', enableIntimacyAide: true }
    });
    await g.plugin.saveRuntimeSettings({
      scene_variance: 'off',
      scene_variance_categories: JSON.stringify(['inner', 'initiative'])
    });
    await g.plugin.openSettingsGui();
    await g.plugin.debugNavigateGui('writing');
    const varianceSelect = g.doc.querySelector('[data-writing-section="variance"] [data-scene-variance]');
    assert.ok(varianceSelect);
    assert.equal(varianceSelect.value, 'off');
    const cats = [...g.doc.querySelectorAll('[data-writing-section="variance"] [data-scene-var-cat]')];
    assert.equal(cats.length, 4);
    assert.equal(cats.find(el => el.dataset.sceneVarCat === 'inner')?.checked, true);
    assert.equal(cats.find(el => el.dataset.sceneVarCat === 'world')?.checked, false);

    const enableBtn = g.doc.querySelector('[data-scene-var-enable-recommended]');
    assert.ok(enableBtn, '1-click enable button shown when sceneVariance is off');
    enableBtn.click();
    await sleep(40);
    assert.equal(g.doc.querySelector('[data-scene-variance]')?.value, 'medium');
    assert.match(g.doc.querySelector('[data-scene-var-status]')?.textContent || '', /60%/);

    await g.plugin.debugNavigateGui('chat');
    g.doc.querySelector('[data-subtab="readings"]')?.click();
    await sleep(30);
    const domainCards = g.doc.querySelectorAll('.reading-domain-card[data-reading-domain]');
    assert.equal(domainCards.length, 6);
    const readingsBanner = g.doc.querySelector('[data-chat-scene-variance-banner]');
    assert.ok(readingsBanner, '이번 턴 판독 shows scene variance summary banner');
    assert.match(readingsBanner.textContent || '', /장면 변수/);
  } finally {
    g.plugin.debugSetSceneVarianceRandom(null);
    await g.close();
  }
});

test('12) contraception barrier detection: intervening object, 이불 밖으로 non-truncation, 16-msg/carryover persistence, {{raw::...}} isolation, negations, and PREVIOUS fallback', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  const makeSettings = scopeKey => ({
    mode: 'normal', writingMode: 'rp', nsfwMode: 'explicit', nsfwGuidanceEnabled: true,
    enableBodyStateAide: true, enableIntimacyAide: true,
    bodyStateCards: {
      [scopeKey]: [
        { id: `bs-jiwon-${scopeKey}`, name: '이지원', gender: 'female', constitution: '신중하고 경계가 분명한 편', origin: 'user' },
        { id: `bs-puding-${scopeKey}`, name: '푸딩', gender: 'male', origin: 'user' }
      ]
    },
    npcDisposition: {
      [scopeKey]: { default: '', npcs: [{ id: `n-jiwon-${scopeKey}`, name: '이지원', level: 'acquaintance' }] }
    }
  });

  // 1. Direct repro: intervening object between 콘돔 and verb ("콘돔을 자지에 씌우고 ... 삽입")
  const directScope = 'contraception-intervening-obj-scope';
  f.host.plugin.debugSetActiveScope(directScope, '푸딩');
  const directPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: directScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(directScope),
    recent: {
      latestUser: '콘돔을 자지에 씌우고 그녀의 다리 한 쪽을 잡고 든 다음 질내에 천천히 삽입해 들어갔다.',
      visibleMessages: [{ role: 'assistant', content: '이지원이 숨을 고르며 침대 시트를 쥐었다.' }]
    }
  });
  assert.equal(directPkt.contraception.length, 1);
  assert.equal(directPkt.contraception[0].method, 'condom');
  assert.equal(directPkt.contraception[0].protected, true);
  assert.equal(directPkt.contraception[0].stanceCode, 'protected_confirmed');

  // 2. "이불 밖으로 나왔다" does NOT truncate encounter window, and "포장을 찢어" does NOT falsely trigger condom_failed
  const blanketScope = 'contraception-blanket-scope';
  f.host.plugin.debugSetActiveScope(blanketScope, '푸딩');
  const blanketPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: blanketScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(blanketScope),
    recent: {
      latestUser: '그녀의 다리 한 쪽을 들고 천천히 삽입했다.',
      visibleMessages: [
        { role: 'user', content: '콘돔 포장을 찢어 자지에 씌웠다.' },
        { role: 'assistant', content: '그리고 이지원의 손이 이불 밖으로 나왔다.' }
      ]
    }
  });
  assert.equal(blanketPkt.contraception.length, 1);
  assert.equal(blanketPkt.contraception[0].method, 'condom');
  assert.equal(blanketPkt.contraception[0].protected, true);

  // 3a. Long-scene carryover beyond 16-message window + persistent storage reload
  const longScope = 'contraception-long-carryover-scope';
  f.host.plugin.debugSetActiveScope(longScope, '푸딩');
  const longSettings = makeSettings(longScope);
  const longMsgs = [];
  const t1Input = '콘돔을 자지에 씌우고 이지원의 안으로 천천히 삽입했다.';
  const t1Pkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: longScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: longSettings,
    recent: { latestUser: t1Input, visibleMessages: [] }
  });
  assert.equal(t1Pkt.contraception[0].method, 'condom');
  longMsgs.push({ role: 'user', content: t1Input });
  longMsgs.push({ role: 'assistant', content: '이지원이 낮은 신음을 삼키며 몸을 맡겼다.' });

  for (let i = 1; i <= 9; i += 1) {
    const stepInput = `그대로 자세를 유지하며 ${i}번째 움직임으로 허리를 움직여 삽입감을 이어간다.`;
    const stepPkt = f.host.plugin.debugIntimacyPacket({
      characterName: '이지원', personaName: '푸딩', scopeKey: longScope,
      profileGenders: { 이지원: 'female', 푸딩: 'male' },
      settings: longSettings,
      recent: { latestUser: stepInput, visibleMessages: longMsgs.slice() }
    });
    assert.equal(stepPkt.contraception[0].method, 'condom', `turn ${i + 1} keeps condom`);
    assert.equal(stepPkt.contraception[0].protected, true);
    longMsgs.push({ role: 'user', content: stepInput });
    longMsgs.push({ role: 'assistant', content: `이지원이 가쁜 숨을 내쉬며 (${i}) 어깨를 붙잡았다.` });
  }
  assert.equal(longMsgs.length, 20, 'Turn 1 pushed completely past -16 message window');

  await sleep(20);
  const reloadedContinuity = await f.host.plugin.debugGaugeContinuityLoad();
  assert.equal(reloadedContinuity.intimacyGauges?.[longScope]?.barrierSettled?.state, 'condom');

  const postReloadPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: longScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: longSettings,
    recent: {
      latestUser: '다시 리듬을 맞추며 허리를 천천히 움직여 삽입을 이어간다.',
      visibleMessages: longMsgs.slice()
    }
  });
  assert.equal(postReloadPkt.contraception[0].method, 'condom', 'condom survives past 16 msgs + reload via carryover');
  assert.equal(postReloadPkt.contraception[0].protected, true);

  // 3b. Explicit exit resets barrier state so a subsequent new encounter defaults back to unprotected
  f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: longScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: longSettings,
    recent: {
      latestUser: '행위를 끝낸 뒤 옷을 다 챙겨 입고 방을 나왔다.',
      visibleMessages: [...longMsgs, { role: 'assistant', content: '둘은 각자 옷을 정돈하고 방 밖으로 나갔다.' }]
    }
  });
  const afterExitPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: longScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: longSettings,
    recent: {
      latestUser: '다음 날 밤, 침대 위에서 그녀의 다리 사이로 바로 삽입했다.',
      visibleMessages: [{ role: 'assistant', content: '옷을 다 챙겨 입고 방을 나왔던 전날 밤과 달리 이지원은 긴장한 채 누워 있었다.' }]
    }
  });
  assert.equal(afterExitPkt.contraception[0].method, 'none_implicit', 'explicit exit clears carried condom state');
  assert.equal(afterExitPkt.contraception[0].protected, false);

  // 3c. Reroll/edit of Turn 1 must NOT leak discarded Turn 1 condom into edited Turn 1
  const rerollScope = 'contraception-reroll-scope';
  f.host.plugin.debugSetActiveScope(rerollScope, '푸딩');
  const rerollSettings = makeSettings(rerollScope);
  const firstDraftPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: rerollScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: rerollSettings,
    recent: { latestUser: '콘돔을 자지에 씌우고 이지원의 다리 사이로 삽입한다.', visibleMessages: [] }
  });
  assert.equal(firstDraftPkt.contraception[0].method, 'condom');
  const rerollPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: rerollScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: rerollSettings,
    recent: { latestUser: '그냥 바로 이지원의 다리 사이로 삽입한다.', visibleMessages: [] }
  });
  assert.equal(rerollPkt.contraception[0].method, 'none_implicit', 'rerolled Turn 1 does not leak discarded condom');
  assert.equal(rerollPkt.contraception[0].protected, false);

  // 4. RisuAI {{raw::...}} and <img> tags do NOT trigger bare raw none_explicit or false contraception talk
  const rawTagScope = 'contraception-raw-macro-scope';
  f.host.plugin.debugSetActiveScope(rawTagScope, '푸딩');
  const rawProtectedPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: rawTagScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(rawTagScope),
    recent: {
      latestUser: '이지원의 허리를 잡고 천천히 삽입해 움직인다. {{raw::insert_scene.png}}',
      visibleMessages: [
        { role: 'assistant', content: '<img src="{{raw::condom_wear.png}}"> 푸딩은 콘돔을 자지에 씌웠다. {{raw::heroine_blush.png}}' }
      ]
    }
  });
  assert.equal(rawProtectedPkt.contraception.length, 1);
  assert.equal(rawProtectedPkt.contraception[0].method, 'condom', '{{raw::...}} macro must not trigger raw none_explicit');
  assert.equal(rawProtectedPkt.contraception[0].protected, true);

  const foreplayRawPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: `${rawTagScope}-foreplay`,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(`${rawTagScope}-foreplay`),
    recent: {
      latestUser: '이지원의 입술에 가볍게 키스한다. {{raw::kiss_bg.png}}',
      visibleMessages: [{ role: 'assistant', content: '조용한 방 안에서 손끝이 스쳤다. {{raw::room_night.png}}' }]
    }
  });
  assert.equal(foreplayRawPkt.contraception.length, 0, 'foreplay with {{raw::...}} must not trigger contraception verdict');

  // 5. Negated / failed / inside-with-condom cases
  const variantCases = [
    ['neg-an', '콘돔을 자지에 안 씌우고 삽입했다.', 'none_explicit', false],
    ['neg-ji-anh', '콘돔을 씌우지 않고 삽입했다.', 'none_explicit', false],
    ['neg-eop', '콘돔은 없었다. 그냥 삽입했다.', 'none_explicit', false],
    ['fail-torn', '콘돔을 씌웠는데 삽입 도중 찢어졌다.', 'condom_failed', false],
    ['condom-cum-inside', '콘돔을 낀 채 안에 사정했다.', 'condom', true]
  ];
  for (const [tag, utterance, expectedMethod, expectedProtected] of variantCases) {
    const sKey = `contraception-variant-${tag}`;
    f.host.plugin.debugSetActiveScope(sKey, '푸딩');
    const pkt = f.host.plugin.debugIntimacyPacket({
      characterName: '이지원', personaName: '푸딩', scopeKey: sKey,
      profileGenders: { 이지원: 'female', 푸딩: 'male' },
      settings: makeSettings(sKey),
      recent: {
        latestUser: utterance,
        visibleMessages: [{ role: 'assistant', content: '이지원은 침대 위에서 숨을 고르며 서로의 호흡에 집중했다.' }]
      }
    });
    assert.equal(pkt.contraception.length, 1, `${tag} verdict emitted`);
    assert.equal(pkt.contraception[0].method, expectedMethod, `${tag} expected ${expectedMethod}`);
    assert.equal(pkt.contraception[0].protected, expectedProtected, `${tag} protected=${expectedProtected}`);
  }

  // 6. PREVIOUS record fallback: uses ongoing_consequences / what_happened, NEVER do_not_misremember
  const prevOnlyWarnScope = 'contraception-prev-warn-only-scope';
  f.host.plugin.debugSetActiveScope(prevOnlyWarnScope, '푸딩');
  f.host.plugin.debugSetShadowPrevious({
    scopeKey: prevOnlyWarnScope,
    record: {
      what_happened: ['지원이 침대 위에 누워 있다.'],
      ongoing_consequences: [],
      do_not_misremember: ['과거 콘돔 심부름 장면을 현재의 콘돔 착용 상태와 혼동하면 안 된다.']
    }
  });
  const warnOnlyPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: prevOnlyWarnScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(prevOnlyWarnScope),
    recent: {
      latestUser: '다리 한 쪽을 잡고 천천히 삽입했다.',
      visibleMessages: [{ role: 'assistant', content: '지원이 숨을 죽이고 시트를 쥐었다.' }]
    }
  });
  assert.equal(warnOnlyPkt.contraception[0].method, 'none_implicit', 'do_not_misremember alone must NOT count as condom');
  assert.equal(warnOnlyPkt.contraception[0].protected, false);

  const prevConfirmedScope = 'contraception-prev-confirmed-scope';
  f.host.plugin.debugSetActiveScope(prevConfirmedScope, '푸딩');
  f.host.plugin.debugSetShadowPrevious({
    scopeKey: prevConfirmedScope,
    record: {
      what_happened: ['현재 푸딩은 콘돔을 착용하고 지원의 한쪽 다리를 잡아 든 뒤 질내에 천천히 삽입하기 시작했다.'],
      ongoing_consequences: ['푸딩은 지원의 침대 위에서 콘돔을 착용한 채 삽입을 시작한 단계다.'],
      do_not_misremember: ['편의점 콘돔 심부름 장면과 현재 장면을 혼동하면 안 된다.']
    }
  });
  const prevConfirmedPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '이지원', personaName: '푸딩', scopeKey: prevConfirmedScope,
    profileGenders: { 이지원: 'female', 푸딩: 'male' },
    settings: makeSettings(prevConfirmedScope),
    recent: {
      latestUser: '다리 한 쪽을 잡고 천천히 삽입을 이어간다.',
      visibleMessages: [{ role: 'assistant', content: '지원이 숨을 죽이고 시트를 쥐었다.' }]
    }
  });
  assert.equal(prevConfirmedPkt.contraception[0].method, 'condom', 'PREVIOUS ongoing_consequences/what_happened recovers condom state');
  assert.equal(prevConfirmedPkt.contraception[0].protected, true);
});
