'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const asRequestMessages = rows => rows.map(row => ({
  role: row.role,
  content: row.data,
  chatId: row.chatId,
  messageId: row.chatId
}));

const configureMultiTurnPipeline = async (f, { onStage } = {}) => {
  f.controls.onModel = (_idx, body) => {
    const sys = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const stage = (sys.match(/"stage":\s*"([^"]+)"/) || [])[1] || '';
    const extra = (onStage && onStage(stage, body, sys)) || {};
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_analysis_v4',
        stage,
        ok: true,
        analysis: { summary: `checked:${stage}`, constraints: [], risks: [] },
        domain: {},
        rewrite_directives: [],
        do_not_reveal: [],
        pov_limits: [],
        beats: [],
        ...extra
      });
    } else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage,
        ok: true,
        analysis: { summary: `checked:${stage}`, constraints: [], risks: [] },
        domain: {},
        rewrite_directives: [],
        do_not_reveal: [],
        pov_limits: [],
        beats: [],
        edits: [],
        ...extra
      });
    } else {
      f.controls.output = extra._draft || '민아의 숨결이 미세하게 흔들렸다.';
    }
  };

  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    writing_mode: 'rp',
    nsfw_mode: 'direct',
    nsfwGuidanceEnabled: true,
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    enable_intimacy_aide: true,
    enable_body_state_aide: true,
    enable_world_dynamics_aide: true,
    enable_forced_bond_aide: true,
    enable_relationship_sim_aide: true,
    forced_bond_auto: false,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({
    ...slots,
    aide_intimacy: { ...(slots.aide_intimacy || {}), enabled: true },
    aide_body_state: { ...(slots.aide_body_state || {}), enabled: true },
    aide_world_dynamics: { ...(slots.aide_world_dynamics || {}), enabled: true },
    aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: true },
    aide_relationship_sim: { ...(slots.aide_relationship_sim || {}), enabled: true }
  });
};

test('1) 1-turn reroll (same & edited input) does not double-decrement sleep, double-credit gauges/zones, or duplicate world/bond entries', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  let turnCall = 0;
  await configureMultiTurnPipeline(f, {
    onStage: (stage) => {
      if (stage === 'aide_character') {
        return {
          intimacy_profiles: [{ name: '민아', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' }],
          intimacy_readings: [{ participant: '민아', phase: 'foreplay', position: '', summary: `run-${turnCall}` }],
          intimacy_body_responses: [{ name: '민아', zone: 'breasts_nipples', physical: '가슴이 떨림', reaction: '신음을 삼킴' }],
          state_readings: [{ character: '민아', summary: `state-${turnCall}` }],
          relationship_events: [{ pair_id: 'bond-mina', act: 'date', actor: '@persona', outcome_shown: true, summary: `date-${turnCall}` }]
        };
      }
      if (stage === 'aide_world') {
        return {
          world_readings: [{
            movement: '준호의 복귀',
            status: 'surfaced',
            summary: turnCall === 1 ? '준호가 복도 끝까지 왔다.' : '준호가 계단을 올라오고 있다.',
            actors: ['준호'],
            place: '복도',
            cause: '귀가',
            kind: 'travel'
          }]
        };
      }
      if (stage === 'aide_plot') {
        return {
          bond_readings: [{
            card: 'bond-mina',
            tones: ['affection'],
            stage: turnCall === 1 ? 'tension' : 'expressed',
            summary: `bond-run-${turnCall}`
          }]
        };
      }
      return {};
    }
  });

  // Seed chat with Turn 1 completed (민아 asleep, bond card in aware stage)
  const hud = '\n◈CG\nLOC|침실|bg_bedroom|clear\n@|민아\n◈';
  f.chat.message = [
    { role: 'user', chatId: 'u1', data: '방 불을 끄고 나간다.' },
    { role: 'char', chatId: 'a1', data: '민아는 침대에 누워 깊이 잠들었다.' + hud }
  ];

  // Turn 1 run so baseline and scope are established
  f.chat.message.push({ role: 'user', chatId: 'u2', data: '문틈으로 조용히 숨을 고른다.' });
  turnCall = 1;
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const scopeKey = f.host.plugin.debugActiveScopeKey();

  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    forced_bond_cards: {
      [scopeKey]: [{ id: 'bond-mina', from: '@persona', to: '민아', direction: 'mutual', tones: ['affection'], stage: 'aware', pressure: 'explicit' }]
    }
  });

  f.chat.message.push({ role: 'char', chatId: 'a2', data: '민아는 여전히 고른 숨을 내쉬며 잠들어 있었다.' + hud });

  // Turn 2: touch breasts while asleep + date signal
  f.chat.message.push({ role: 'user', chatId: 'u3', data: '잠든 민아의 가슴을 조심스레 감싸 쥐고 데이트 약속을 속삭인다.' });
  turnCall = 1;
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');

  const afterFirst = f.host.plugin.debugTurnTimelineState(scopeKey);
  const firstSleepDepth = afterFirst.state.bodyStateSleep?.people?.['민아']?.depth;
  const firstClimax = afterFirst.state.intimacyGauges?.settled?.['민아']?.climax;
  const firstDev = afterFirst.state.intimacyCards?.find(c => c.name === '민아')?.zoneStats?.breasts_nipples?.development || 0;
  assert.ok(firstSleepDepth > 0, 'sleep depth tracked before reroll');
  assert.ok(firstClimax > 0, 'climax gauge accrued on Turn 2');
  assert.ok(firstDev > 0, 'zoneStats accrued on Turn 2');
  const worldCountBeforeReroll = afterFirst.state.worldSimLogs.length;
  assert.ok(worldCountBeforeReroll >= 1, 'worldSimLogs recorded before reroll');

  // Reroll Turn 2 with the exact same input (and a slightly different AI world summary)
  await f.host.hooks.afterRequest('민아의 숨결이 미세하게 흔들렸다.', 'model');
  await f.host.plugin.clearDraftCheckpoints();
  turnCall = 2;
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const afterReroll = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.equal(afterReroll.state.bodyStateSleep?.people?.['민아']?.depth, firstSleepDepth, 'sleep depth does not double-decrement on reroll');
  assert.equal(afterReroll.state.intimacyGauges?.settled?.['민아']?.climax, firstClimax, 'climax gauge does not double-accumulate on reroll');
  assert.equal(afterReroll.state.intimacyCards?.find(c => c.name === '민아')?.zoneStats?.breasts_nipples?.development, firstDev, 'zoneStats do not double-accumulate on reroll');
  assert.equal(afterReroll.state.worldSimLogs.length, worldCountBeforeReroll, 'worldSimLogs does not duplicate on reroll even when summary changes');
  assert.equal(afterReroll.state.worldSimLogs[worldCountBeforeReroll - 1].summary, '준호가 계단을 올라오고 있다.', 'worldSimLogs reflects the rerolled run only');

  // Edit Turn 2 user input before assistant replies (same prefix [u1,a1,u2,a2], edited u3')
  f.chat.message[f.chat.message.length - 1] = { role: 'user', chatId: 'u3', data: '잠든 민아의 손등만 가볍게 쓰다듬는다.' };
  turnCall = 3;
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const afterEditRetry = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.equal(afterEditRetry.state.intimacyGauges?.settled?.['민아']?.climax ?? 0, 0, 'edited input retry without stimulation starts from pre-Turn-2 baseline (0), not cancelled Turn 2 climax');
  assert.equal(afterEditRetry.state.intimacyCards?.find(c => c.name === '민아')?.zoneStats?.breasts_nipples?.development || 0, 0, 'cancelled Turn 2 zoneStats reverted before edited Turn 2 run');
  assert.equal(afterEditRetry.readings.intimacyReadings?.readings?.[0]?.summary, 'run-3');
});

test('2) multi-turn rollback (Turn 1 -> 2 -> 3 -> back to Turn 1) restores all stores and clears stale future readings', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  let runTag = 't1';
  let emitReadings = true;
  await configureMultiTurnPipeline(f, {
    onStage: (stage) => {
      if (!emitReadings) return {};
      if (stage === 'aide_character') {
        return {
          intimacy_profiles: [{ name: '민아', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' }],
          intimacy_readings: [{ participant: '민아', phase: 'foreplay', position: '', summary: `intimacy-${runTag}` }],
          intimacy_body_responses: [{ name: '민아', zone: 'breasts_nipples', physical: runTag, reaction: runTag }],
          state_readings: [{ character: '민아', summary: `body-${runTag}` }],
          relationship_events: [{ pair_id: 'bond-mina', act: 'date', actor: '@persona', outcome_shown: true, summary: `rel-${runTag}` }]
        };
      }
      if (stage === 'aide_world') {
        return {
          world_readings: [{
            movement: `event-${runTag}`,
            status: 'surfaced',
            summary: `offstage-${runTag}`,
            actors: ['준호'],
            place: runTag === 't1' ? '현관' : runTag === 't2' ? '서재' : '옥상',
            cause: runTag,
            kind: 'travel'
          }]
        };
      }
      return {};
    }
  });

  const hud = '\n◈CG\nLOC|침실|bg_bedroom|clear\n@|민아\n◈';
  f.chat.message = [
    { role: 'user', chatId: 'u1', data: '민아의 목덜미에 입을 맞추며 유두를 부드럽게 만진다.' }
  ];
  runTag = 't1';
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  const snapT1 = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.equal(snapT1.state.worldSimLogs.length, 1);
  assert.equal(snapT1.state.worldSimLogs[0].place, '현관');
  const t1Climax = snapT1.state.intimacyGauges.settled['민아'].climax;
  const t1Dev = snapT1.state.intimacyCards.find(c => c.name === '민아').zoneStats.breasts_nipples.development;

  // Turn 2
  f.chat.message.push({ role: 'char', chatId: 'a1', data: '민아가 입술을 살짝 열었다.' + hud });
  f.chat.message.push({ role: 'user', chatId: 'u2', data: '민아의 허벅지 안쪽을 부드럽게 쓸어올린다.' });
  runTag = 't2';
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const snapT2 = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.ok(snapT2.state.intimacyGauges.settled['민아'].climax > t1Climax);
  assert.equal(snapT2.state.worldSimLogs.length, 2);

  // Turn 3
  f.chat.message.push({ role: 'char', chatId: 'a2', data: '민아가 숨을 몰아쉬었다.' + hud });
  f.chat.message.push({ role: 'user', chatId: 'u3', data: '민아의 음핵을 강하게 문지른다.' });
  runTag = 't3';
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const snapT3 = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.ok(snapT3.state.intimacyGauges.settled['민아'].climax > snapT2.state.intimacyGauges.settled['민아'].climax);
  assert.equal(snapT3.state.worldSimLogs.length, 3);
  assert.ok(snapT3.state.intimacyCards.find(c => c.name === '민아').zoneStats.clitoris_vulva.development > 0);

  // Now roll back to Turn 1 [u1, a1] and send a brand new Turn 2' with intimacy/world/body readings turned OFF
  f.chat.message = [
    { role: 'user', chatId: 'u1', data: '민아의 목덜미에 입을 맞추며 유두를 부드럽게 만진다.' },
    { role: 'char', chatId: 'a1', data: '민아가 입술을 살짝 열었다.' + hud },
    { role: 'user', chatId: 'u2-new', data: '창문을 열고 바깥 공기를 쐰다.' }
  ];
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    enable_intimacy_aide: false,
    enable_body_state_aide: false,
    enable_world_dynamics_aide: false,
    enable_forced_bond_aide: false,
    enable_relationship_sim_aide: false
  });
  const curSlots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({
    ...curSlots,
    aide_intimacy: { ...(curSlots.aide_intimacy || {}), enabled: false },
    aide_body_state: { ...(curSlots.aide_body_state || {}), enabled: false },
    aide_world_dynamics: { ...(curSlots.aide_world_dynamics || {}), enabled: false },
    aide_forced_bond: { ...(curSlots.aide_forced_bond || {}), enabled: false },
    aide_relationship_sim: { ...(curSlots.aide_relationship_sim || {}), enabled: false }
  });
  emitReadings = false;
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');

  const afterRollback = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.equal(afterRollback.state.worldSimLogs.length, 1, 'cancelled Turn 2 & 3 worldSimLogs removed');
  assert.equal(afterRollback.state.worldSimLogs[0].place, '현관', 'Turn 1 worldSimLog preserved');
  assert.equal(afterRollback.state.intimacyGauges.settled['민아'].climax, t1Climax, 'intimacy gauge reverted to Turn 1');
  assert.equal(afterRollback.state.intimacyCards.find(c => c.name === '민아').zoneStats.breasts_nipples.development, t1Dev, 'Turn 1 breasts_nipples zoneStats kept');
  assert.equal(afterRollback.state.intimacyCards.find(c => c.name === '민아').zoneStats.clitoris_vulva.development, 0, 'cancelled Turn 3 clitoris_vulva zoneStats reverted to 0');
  assert.equal(afterRollback.readings.intimacyReadings, null, 'stale Turn 3 intimacyReadings cleared when intimacy AIDE did not run');
  assert.equal(afterRollback.readings.worldDynamicsReadings, null, 'stale Turn 3 worldDynamicsReadings cleared');
  assert.equal(afterRollback.readings.bodyStateReadings, null, 'stale Turn 3 bodyStateReadings cleared');
});

test('3) immediate GUI inspect rollback (without sending a new turn) restores Turn 1 readings & state, and respects isStreaming', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  let runTag = 'turn1';
  await configureMultiTurnPipeline(f, {
    onStage: (stage) => {
      if (stage === 'aide_character') {
        return {
          intimacy_profiles: [{ name: '민아', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' }],
          intimacy_readings: [{ participant: '민아', phase: 'foreplay', position: '', summary: `reading-${runTag}` }],
          state_readings: [{ character: '민아', summary: `state-${runTag}` }]
        };
      }
      if (stage === 'aide_world') {
        return {
          world_readings: [{ movement: `mov-${runTag}`, status: 'surfaced', summary: `world-${runTag}`, actors: ['준호'], place: runTag, cause: runTag, kind: 'travel' }]
        };
      }
      return {};
    }
  });

  const hud = '\n◈CG\nLOC|거실|bg_living|clear\n@|민아\n◈';
  f.chat.message = [{ role: 'user', chatId: 'u1', data: '민아의 손을 잡는다.' }];
  runTag = 'turn1';
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const scopeKey = f.host.plugin.debugActiveScopeKey();

  f.chat.message.push({ role: 'char', chatId: 'a1', data: '민아가 고개를 끄덕였다.' + hud });
  f.chat.message.push({ role: 'user', chatId: 'u2', data: '민아의 가슴을 만진다.' });
  runTag = 'turn2';
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  f.chat.message.push({ role: 'char', chatId: 'a2', data: '민아가 숨을 삼켰다.' + hud });

  assert.equal(f.host.plugin.debugTurnTimelineState(scopeKey).readings.intimacyReadings.readings[0].summary, 'reading-turn2');

  // Simulate user deleting Turn 2 (leaving [u1, a1]) and opening Settings GUI without sending a new prompt
  f.chat.message = f.chat.message.slice(0, 2);
  await f.host.plugin.openSettingsGui();
  await f.wait(
    () => f.host.plugin.debugTurnTimelineState(scopeKey).readings.intimacyReadings?.readings?.[0]?.summary === 'reading-turn1',
    'gui inspect rewind to Turn 1'
  );

  const inspected = f.host.plugin.debugTurnTimelineState(scopeKey);
  assert.equal(inspected.readings.intimacyReadings.readings[0].summary, 'reading-turn1', 'GUI inspect immediately restores Turn 1 intimacy reading');
  assert.equal(inspected.readings.bodyStateReadings.readings[0].summary, 'state-turn1', 'GUI inspect immediately restores Turn 1 bodyState reading');
  assert.equal(inspected.readings.worldDynamicsReadings.readings[0].summary, 'world-turn1', 'GUI inspect immediately restores Turn 1 worldDynamics reading');
  assert.equal(inspected.state.worldSimLogs.length, 1);

  // Deleted assistant reply [u1] while isStreaming=true must NOT rewind; when isStreaming=false it rewinds to baseline
  const streamingGuard = await f.host.plugin.debugTurnTimelineReconcile({
    scopeKey,
    messages: [{ role: 'user', data: '민아의 손을 잡는다.' }],
    mode: 'inspect',
    isStreaming: true
  });
  assert.equal(streamingGuard.action, 'busy');

  const deletedAssistant = await f.host.plugin.debugTurnTimelineReconcile({
    scopeKey,
    messages: [{ role: 'user', data: '민아의 손을 잡는다.' }],
    mode: 'inspect',
    isStreaming: false
  });
  assert.equal(deletedAssistant.changed, true);
  assert.equal(deletedAssistant.rewoundTo, 0, 'deleting A1 rewinds back to pre-Turn-1 baseline');
});

test('4) cross-reload persistence & user-authored card preservation across rollback', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  await configureMultiTurnPipeline(f, {
    onStage: (stage) => {
      if (stage === 'aide_character') {
        return {
          intimacy_profiles: [{ name: '민아', gender: 'female', sensitive_zones: '', dull_zones: '', basis: 'lore' }],
          intimacy_readings: [{ participant: '민아', phase: 'foreplay', position: '', summary: '포옹' }]
        };
      }
      return {};
    }
  });

  const hud = '\n◈CG\nLOC|침실|bg_bedroom|clear\n@|민아\n@|준호\n◈';
  f.chat.message = [{ role: 'user', chatId: 'u1', data: '민아의 가슴을 만지며 입술을 맞춘다.' }];
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  const scopeKey = f.host.plugin.debugActiveScopeKey();

  // User sets custom intimacy card preference & maleSize after Turn 1
  await f.host.plugin.debugIntimacySetCard({ name: '민아', patch: { origin: 'user', likedPositions: '정상위', foreplayStyle: '유저 지정 스타일' } });
  await f.host.plugin.debugSetIntimacyMaleSize({ scopeKey, name: '준호', size: 'large', cm: 16.5, basis: '유저 지정', origin: 'user' });
  const t1State = f.host.plugin.debugTurnTimelineState(scopeKey);
  const t1BreastsDev = t1State.state.intimacyCards.find(c => c.name === '민아').zoneStats.breasts_nipples.development;
  assert.ok(t1BreastsDev > 0);

  // Turn 2 adds clitoris_vulva development
  f.chat.message.push({ role: 'char', chatId: 'a1', data: '민아가 웃었다.' + hud });
  f.chat.message.push({ role: 'user', chatId: 'u2', data: '민아의 음핵을 애무한다.' });
  await f.host.hooks.beforeRequest(asRequestMessages(f.chat.message), 'model');
  assert.ok(f.host.plugin.debugTurnTimelineState(scopeKey).state.intimacyCards.find(c => c.name === '민아').zoneStats.clitoris_vulva.development > 0);

  // Simulate full reload: wipe timeline memory & reload from storage, then inspect-rollback to Turn 1
  await f.host.plugin.debugTurnTimelineLoad();
  const res = await f.host.plugin.debugTurnTimelineReconcile({
    scopeKey,
    messages: [
      { role: 'user', data: '민아의 가슴을 만지며 입술을 맞춘다.' },
      { role: 'char', data: '민아가 웃었다.' + hud }
    ],
    mode: 'inspect'
  });
  assert.equal(res.changed, true);

  const afterReloadRollback = f.host.plugin.debugTurnTimelineState(scopeKey);
  const minaCard = afterReloadRollback.state.intimacyCards.find(c => c.name === '민아');
  assert.equal(minaCard.origin, 'user');
  assert.equal(minaCard.likedPositions, '정상위', 'user-authored profile survives rollback');
  assert.equal(minaCard.foreplayStyle, '유저 지정 스타일');
  assert.equal(minaCard.zoneStats.breasts_nipples.development, t1BreastsDev, 'Turn 1 zoneStats kept');
  assert.equal(minaCard.zoneStats.clitoris_vulva.development, 0, 'cancelled Turn 2 zoneStats reverted');
  assert.equal(f.host.plugin.debugIntimacyMaleSizes({ scopeKey })['준호']?.size, 'large', 'user-authored maleSize survives rollback');
  assert.ok(afterReloadRollback.readings.intimacyTelemetry?.gauges?.some(g => g.name === '민아' && g.climaxGauge > 0), 'intimacyTelemetry re-hydrated from Turn 1 gauges after reload');
});

test('5) standalone intimacySettleGauges does not falsely promote cancelled turn on 1-3 turn rollback with overlapping tail hashes', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const scopeKey = 'short-rollback-unit';
  f.host.plugin.debugSetActiveScope(scopeKey, '하준');
  const settings = { enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'], mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'rp' };

  const a1 = '세라가 숨을 죽였다.';
  const a2 = '세라가 입술을 깨물었다.';
  const a3 = '세라가 떨리는 숨을 내쉬었다.';

  // Turn 1
  const p1 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' }, settings,
    recent: { latestUser: '세라의 유두를 만진다.', visibleMessages: [{ role: 'assistant', content: a1 }] }
  });
  const g1 = p1.gauges.find(g => g.name === '세라').climaxGauge;

  // Turn 2
  const p2 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' }, settings,
    recent: { latestUser: '세라의 유두를 핥는다.', previousTurnUser: '세라의 유두를 만진다.', latestAssistant: a2, visibleMessages: [{ role: 'assistant', content: a1 }, { role: 'assistant', content: a2 }] }
  });
  const g2 = p2.gauges.find(g => g.name === '세라').climaxGauge;
  assert.ok(g2 > g1);

  // Turn 3
  const p3 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' }, settings,
    recent: { latestUser: '세라의 음핵을 강하게 자극한다.', previousTurnUser: '세라의 유두를 핥는다.', latestAssistant: a3, visibleMessages: [{ role: 'assistant', content: a1 }, { role: 'assistant', content: a2 }, { role: 'assistant', content: a3 }] }
  });
  const g3 = p3.gauges.find(g => g.name === '세라').climaxGauge;
  assert.ok(g3 > g2);

  // Roll back to Turn 2 position (only a1 in visibleMessages, overlapping tailHashes!) with a different non-stimulating input
  const pRollback = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' }, settings,
    recent: { latestUser: '창밖을 바라본다.', previousTurnUser: '다른 대화', latestAssistant: a1, visibleMessages: [{ role: 'assistant', content: a1 }] }
  });
  const gAfter = pRollback.gauges.find(g => g.name === '세라')?.climaxGauge || 0;
  assert.equal(gAfter, 0, 'short rollback must NOT promote Turn 3 settled climax into baseline');
});

test('6) deep rollback fallback, failed-run rollback, and LIB evidence non-persistence', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();

  const scopeKey = 'fallback-and-failure-scope';
  f.host.plugin.debugSetActiveScope(scopeKey, '푸딩');

  // Reconcile at messageCount=4 (mid-chat initialization), seed worldSimLogs & bondHistory stamped at count 4
  const msgs4 = [
    { role: 'user', data: 'u1' },
    { role: 'char', data: 'a1' },
    { role: 'user', data: 'u2' },
    { role: 'char', data: 'a2' }
  ];
  await f.host.plugin.debugTurnTimelineReconcile({ scopeKey, messages: msgs4, mode: 'before_turn', currentInputText: 'u3' });
  const settings = { enableWorldDynamicsAide: true, enableForcedBondAide: true, enablePlotAide: true, aideStageOrder: ['aide_plot'], mode: 'normal', writingMode: 'rp' };
  f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_world_dynamics',
    settings,
    parsed: { worldReadings: [{ movement: 'm4', status: 'surfaced', summary: 'at-count-4', actors: ['준호'], place: '역' }] }
  });
  await f.host.plugin.debugTurnTimelineCommit({ scopeKey });

  // Roll back past the oldest saved checkpoint (to count 2) -> fallback prunes turnMessageCount >= 2
  const fallbackRes = await f.host.plugin.debugTurnTimelineReconcile({
    scopeKey,
    messages: [{ role: 'user', data: 'u1' }, { role: 'char', data: 'a1' }],
    mode: 'before_turn',
    currentInputText: 'u2-new'
  });
  assert.equal(fallbackRes.action, 'rollback_fallback');
  assert.equal(f.host.plugin.debugTurnTimelineState(scopeKey).state.worldSimLogs.length, 0, 'fallback prunes worldSimLogs stamped >= currentCount');

  // Simulate mid-pipeline failure after worldSimLogs was mutated -> rollbackGradiaFailedRun restores pre-turn state
  f.host.plugin.debugWorldDynamicsRecord({
    stageName: 'aide_world_dynamics',
    settings,
    parsed: { worldReadings: [{ movement: 'm-fail', status: 'surfaced', summary: 'partial-mutation', actors: ['준호'], place: '공항' }] }
  });
  assert.equal(f.host.plugin.debugTurnTimelineState(scopeKey).state.worldSimLogs.length, 1);
  const rolledBack = await f.host.plugin.debugTurnTimelineRollbackFailed({ scopeKey });
  assert.equal(rolledBack, true);
  assert.equal(f.host.plugin.debugTurnTimelineState(scopeKey).state.worldSimLogs.length, 0, 'failed run rollback reverts partial mutation');

  // Verify raw persisted turn_timeline never contains readings or externalEvidence
  const rawStored = f.values.get('serial_gradation_agents_for_rp:turn_timeline:v1') || '';
  assert.ok(rawStored.length > 0, 'turn timeline persisted');
  assert.doesNotMatch(rawStored, /externalEvidence|intimacyReadings|bodyStateReadings|worldDynamicsReadings|shadowPrevious/);
});
