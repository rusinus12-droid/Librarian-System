'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');

const wireSmartModelMock = (f, draftText) => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_analysis_v4',
        stage: 'aide_forced_romance',
        ok: true,
        analysis: { summary: '지정 인물 연애 연결 및 등장 브리지 분석', constraints: ['RP 주도권 유지'], risks: [] },
        domain: {
          target_character: '세라',
          forced_appearance_bridge: '복도 모퉁이에서 마주침',
          romantic_hook: '시선 교차와 우연한 밀착',
          four_channel_cues: { thought: '의식됨', heart: '심박 상승', words: '조심스레 말을 건넨다', body: '가까이 다가선다' },
          agency_and_boundary_check: '그라디아 전역 규칙 준수'
        },
        rewrite_directives: ['세라를 현재 장면에 등장시키고 연애적 긴장을 형성한다'],
        do_not_reveal: [],
        pov_limits: ['유저 대사·행동 창작 금지'],
        beats: ['세라가 시선을 맞추며 말을 건넨다']
      });
    } else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      const stageMatch = sys.match(/"stage":\s*"([^"]+)"/);
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage: stageMatch ? stageMatch[1] : 'aide_plot',
        ok: true,
        analysis: { summary: '단계 점검 완료', constraints: [], risks: [] },
        domain: {},
        rewrite_directives: [],
        do_not_reveal: [],
        pov_limits: [],
        beats: [],
        edits: []
      });
    } else {
      f.controls.output = draftText;
    }
  };
};

test('aide_forced_romance is disabled by default and adds zero extra calls', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireSmartModelMock(f, '민아는 문 앞에서 조용히 고개를 끄덕였다.');
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    default_preset: 'writer',
    input_assist_mode: 'off',
    writing_mode: 'rp',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });
  const messages = [
    ...f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    { role: 'user', content: '복도를 걸어간다.', chatId: 'u9', messageId: 'u9' }
  ];
  f.chat.message.push({ role: 'user', chatId: 'u9', data: '복도를 걸어간다.' });
  await f.host.hooks.beforeRequest(messages, 'model');
  assert.equal(f.prompts.length, 4, 'default 4-stage lightweight pipeline runs 4 calls without forced romance');
});

test('aide_forced_romance runs right after aide_plot, respects GRADIA RP/NSFW contracts, and supports heavyweight 2-call override', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireSmartModelMock(f, '빈 강의실 문이 조용히 열렸다.');
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    default_preset: 'writer',
    input_assist_mode: 'off',
    writing_mode: 'rp',
    nsfw_mode: 'off',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    enable_forced_romance_aide: true,
    forced_romance_aide_mode: 'heavyweight',
    forced_romance_target_character: '세라',
    forced_romance_force_appearance: true,
    forced_romance_intensity: 'explicit',
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });
  const slotsHeavy = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({
    ...slotsHeavy,
    aide_forced_romance: { ...(slotsHeavy.aide_forced_romance || {}), enabled: true }
  });
  const messages = [
    ...f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    { role: 'user', content: '빈 강의실로 들어간다.', chatId: 'u9', messageId: 'u9' }
  ];
  f.chat.message.push({ role: 'user', chatId: 'u9', data: '빈 강의실로 들어간다.' });
  await f.host.hooks.beforeRequest(messages, 'model');

  // 4 lightweight stages (shadow_act, aide_character, aide_world, aide_plot = 4 calls)
  // + 1 heavyweight aide_forced_romance (analysis + rewrite = 2 calls) => 6 calls total.
  assert.equal(f.prompts.length, 6, 'forced romance heavyweight override executes 2 calls after 4 lightweight calls');

  const plotSystem = systemOf(f.prompts[3]);
  assert.match(plotSystem, /Plot AIDE/);

  const analysisSystem = systemOf(f.prompts[4]);
  const rewriteSystem = systemOf(f.prompts[5]);
  for (const sys of [analysisSystem, rewriteSystem]) {
    assert.match(sys, /Forced Romance AIDE|억결 AIDE/);
    assert.match(sys, /세라/);
    assert.match(sys, /ON —/);
    assert.match(sys, /explicit/);
    assert.match(sys, /4-CHANNEL CUES/);
    assert.match(sys, /PLAYER-CONTROLLED RP/);
  }
});

test('aide_forced_romance lightweight mode runs 1 call after aide_plot in novel mode', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  wireSmartModelMock(f, '카페 창가에 앉아 커피를 기다렸다.');
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'lite',
    default_preset: 'writer',
    input_assist_mode: 'off',
    writing_mode: 'novel',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: false,
    enable_world_aide: false,
    enable_plot_aide: true,
    enable_forced_romance_aide: true,
    forced_romance_aide_mode: 'lightweight',
    forced_romance_target_character: '에밀리',
    forced_romance_force_appearance: true,
    forced_romance_intensity: 'subtle',
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });
  const slotsLite = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({
    ...slotsLite,
    aide_forced_romance: { ...(slotsLite.aide_forced_romance || {}), enabled: true }
  });
  const messages = [
    ...f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    { role: 'user', content: '카페 창가에 앉는다.', chatId: 'u9', messageId: 'u9' }
  ];
  f.chat.message.push({ role: 'user', chatId: 'u9', data: '카페 창가에 앉는다.' });
  await f.host.hooks.beforeRequest(messages, 'model');

  // lite mode: shadow_act (1) + aide_plot (1) + aide_forced_romance lightweight (1) = 3 calls
  assert.equal(f.prompts.length, 3, 'lite mode + forced romance lightweight executes 3 calls');
  const frSystem = systemOf(f.prompts[2]);
  assert.match(frSystem, /에밀리/);
  assert.match(frSystem, /subtle/);
  assert.match(frSystem, /4-CHANNEL CUES/);
});
