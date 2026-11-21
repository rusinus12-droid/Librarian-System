'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const userOf = body => body.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
const stageOf = body => {
  const sys = systemOf(body);
  const all = body.messages.map(m => m.content).join('\n');
  return (sys.match(/"stage":\s*"([^"]+)"/) || sys.match(/^STAGE:\s*([^\s·\n]+)/m) || all.match(/VISIBLE DRAFT OUTPUT CONTRACT — ([^\s:\n]+)/) || [])[1] || '';
};

test('debugShadowPrevious combines LIB memory and recent completed chat into a chronological baseline', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const prev = f.host.plugin.debugShadowPrevious({
    libEvidence: [
      '[GRADIA EXTERNAL EVIDENCE]',
      '- 서연은 어제 도서관 열쇠를 잃어버렸다고 말한 적이 있다.',
      '- 하준은 서연에게 금요일까지 보고서를 넘기겠다고 약속했다.'
    ].join('\n'),
    recent: {
      latestUser: '이제 열쇠로 서고를 열어보자.',
      visibleMessages: [
        { role: 'user', content: '열쇠는 찾았어?' },
        { role: 'assistant', content: '서연이 가방에서 찾은 도서관 열쇠를 책상 위에 올려놓았다.' },
        { role: 'user', content: '이제 열쇠로 서고를 열어보자.' }
      ]
    }
  });
  assert.equal(prev.hasContent, true);
  assert.equal(prev.libFacts.length, 2);
  assert.equal(prev.recentEvents.length, 2);
  assert.match(prev.text, /^\[PREVIOUS — LIB \+ 최근 챗 종합 사건 기록 \(과거 사실 기준선\)\]/);
  assert.match(prev.text, /LIB 기억 핵심:/);
  assert.match(prev.text, /하준은 서연에게 금요일까지 보고서를 넘기겠다고 약속했다\./);
  assert.match(prev.text, /최근 챗 경과 \(시간순\):/);
  assert.match(prev.text, /서연이 가방에서 찾은 도서관 열쇠를 책상 위에 올려놓았다\./);
});

test('previous synthesizes recent chat before Shadow Act in lightweight mode with zero extra calls', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage,
        ok: true,
        domain: {},
        analysis: { summary: 'ok', constraints: [], risks: [] },
        edits: []
      });
    } else {
      f.controls.output = '서연은 책상 위 열쇠를 바라보며 고개를 끄덕였다.';
    }
  };

  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    default_preset: 'writer',
    input_assist_mode: 'off',
    writing_mode: 'rp',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: false,
    enable_world_aide: false,
    enable_plot_aide: false,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  f.chat.message.push(
    { role: 'user', chatId: 'u1', data: '열쇠는 찾았어?' },
    { role: 'char', chatId: 'a1', data: '서연이 가방에서 찾은 도서관 열쇠를 책상 위에 올려놓았다.' },
    { role: 'user', chatId: 'u2', data: '이제 열쇠로 서고를 열어보자.' }
  );

  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(
    f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    'model'
  );

  const shadowCalls = f.prompts.filter(body => !stageOf(body).startsWith('aide_'));
  assert.equal(shadowCalls.length, 1, 'lightweight shadow_act makes exactly 1 call (zero extra calls for previous)');
  assert.ok(!f.prompts.some(body => stageOf(body) === 'previous'), 'no separate previous stage call');
  const usr = userOf(shadowCalls[0]);
  assert.match(usr, /PASS 0 — PREVIOUS \(BEFORE PLANNING\)/);
  assert.match(usr, /^\[PREVIOUS — LIB \+ 최근 챗 종합 사건 기록 \(과거 사실 기준선\)\]/);
  assert.match(usr, /최근 챗 경과 \(시간순\):/);
  assert.match(usr, /서연이 가방에서 찾은 도서관 열쇠를 책상 위에 올려놓았다\./);
});

test('previous schema and pass run in shadow_act heavyweight analysis and feed rewrite + downstream AIDEs with zero extra calls', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) {
      const domain = stage === 'shadow_act'
        ? {
            previous: {
              what_happened: ['서연은 잃어버렸던 도서관 열쇠를 이미 찾아 책상 위에 두었다.'],
              ongoing_consequences: ['열쇠는 현재 책상 위에 있으며 서고 문을 열 수 있다.'],
              do_not_misremember: ['열쇠를 아직 찾지 못했다고 말하지 말 것.']
            },
            story_author_plan: {
              scene_purpose: '서고 문을 열고 들어간다',
              beats: Array.from({ length: 12 }, (_, i) => `Beat ${i + 1}`)
            },
            director_brief: {
              required_outcomes: ['열쇠로 문을 여는 반응 묘사']
            }
          }
        : {};
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_analysis_v4',
        stage,
        ok: true,
        analysis: { summary: 'checked', constraints: [], risks: [] },
        domain,
        rewrite_directives: [],
        do_not_reveal: [],
        pov_limits: [],
        beats: []
      });
    } else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage,
        ok: true,
        domain: {},
        analysis: { summary: 'ok', constraints: [], risks: [] },
        edits: []
      });
    } else {
      f.controls.output = '서연은 책상 위의 열쇠를 집어 들었다.';
    }
  };

  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    default_preset: 'writer',
    input_assist_mode: 'off',
    writing_mode: 'rp',
    multi_pipeline_mode: 'heavyweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: false,
    enable_plot_aide: false,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  f.chat.message.push(
    { role: 'user', chatId: 'u1', data: '열쇠는 찾았어?' },
    { role: 'char', chatId: 'a1', data: '서연이 가방에서 찾은 도서관 열쇠를 책상 위에 올려놓았다.' },
    { role: 'user', chatId: 'u2', data: '이제 열쇠로 서고를 열어보자.' }
  );

  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(
    f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    'model'
  );

  const shadowCalls = f.prompts.filter(body => !stageOf(body).startsWith('aide_'));
  assert.equal(shadowCalls.length, 2, 'heavyweight shadow_act makes exactly 2 calls (analysis + draft, zero extra calls)');

  const shadowAnalysisPrompt = shadowCalls[0];
  assert.match(systemOf(shadowAnalysisPrompt), /INTERNAL PASS 0 — PREVIOUS \(BEFORE PASS 1\)/);
  assert.match(systemOf(shadowAnalysisPrompt), /"previous":\s*\{/);
  assert.match(userOf(shadowAnalysisPrompt), /\[PREVIOUS — LIB \+ 최근 챗 종합 사건 기록 \(과거 사실 기준선\)\]/);

  const shadowDraftPrompt = shadowCalls[1];
  const shadowDraftUser = userOf(shadowDraftPrompt);
  const prevIdx = shadowDraftUser.indexOf('[PREVIOUS — CONFIRMED PAST RECORD (LIB + RECENT CHAT)]');
  const storyIdx = shadowDraftUser.indexOf('[STORY AUTHOR PLAN]');
  assert.ok(prevIdx >= 0 && storyIdx > prevIdx, 'PREVIOUS appears before STORY AUTHOR PLAN in shadow draft prompt');
  assert.match(shadowDraftUser, /열쇠를 아직 찾지 못했다고 말하지 말 것\./);

  const charAnalysisPrompt = f.prompts.find(body => stageOf(body) === 'aide_character' && systemOf(body).includes('serial_gradation_agents_for_rp_analysis_'));
  assert.ok(charAnalysisPrompt, 'aide_character analysis ran');
  assert.match(userOf(charAnalysisPrompt), /\[PREVIOUS — CONFIRMED PAST RECORD \(LIB \+ RECENT CHAT, READ ONLY\)\]/);
  assert.match(userOf(charAnalysisPrompt), /서연은 잃어버렸던 도서관 열쇠를 이미 찾아 책상 위에 두었다\./);
});
