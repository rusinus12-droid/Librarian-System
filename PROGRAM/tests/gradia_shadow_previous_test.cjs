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

  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('results');
  const card = f.document.querySelector('[data-scene-run-card]');
  assert.ok(card, 'scene run card exists in results tab');
  assert.match(card.textContent, /PREVIOUS \(과거 종합\)/);
  assert.match(card.textContent, /서연은 잃어버렸던 도서관 열쇠를 이미 찾아 책상 위에 두었다\./);
});

test('debugShadowPrevious strips presentation/inlay/wrapper tags and emits memory guardrails', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const prev = f.host.plugin.debugShadowPrevious({
    libEvidence: '[GRADIA EXTERNAL EVIDENCE]\n- 민아는 <thoughts>비밀</thoughts>열쇠를 건넸다.',
    recent: {
      latestUser: '문을 열어보자.',
      visibleMessages: [
        { role: 'user', content: '열쇠는 어디 있지?' },
        {
          role: 'assistant',
          content: '## 볼륨 5: 이름 붙이기\n### 챕터 18: 셋이라는 수\n#### Chatindex: 100\n<img cmd="Soyeon_casual_shocked">\n<lb-xnai id="s1">{{inlay::abc}}</lb-xnai>\n소연이 고개를 끄덕이며 열쇠를 내밀었다.'
        },
        { role: 'user', content: '문을 열어보자.' }
      ]
    }
  });
  assert.equal(prev.hasContent, true);
  assert.doesNotMatch(prev.text, /<img|<lb-xnai|inlay::|Chatindex|볼륨 5|챕터 18|<thoughts>/);
  assert.match(prev.text, /소연이 고개를 끄덕이며 열쇠를 내밀었다\./);
  assert.match(prev.text, /진행 중 상태·미해결 조건 \(진행 가드\):/);
  assert.match(prev.text, /기억 가드레일 \(오기억·혼동 금지\):/);

  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    source_ignored_tags: ['status']
  });
  await f.host.plugin.listProviderPresets();
  const prevCustom = f.host.plugin.debugShadowPrevious({
    recent: {
      latestUser: '대화를 이어간다.',
      visibleMessages: [
        { role: 'assistant', content: '<status>HP:100</status>\n소연이 미소 지었다.' },
        { role: 'user', content: '대화를 이어간다.' }
      ]
    }
  });
  assert.doesNotMatch(prevCustom.text, /HP:100|<status>/);
  assert.match(prevCustom.text, /소연이 미소 지었다\./);
});

test('beforeRequest strips presentation/wrapper/custom tags from recent chat and terminal scene in SHADOW prompt', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = () => {
    f.controls.output = '소연은 미소 지으며 대답했다.';
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
    lore_activation_mode: 'off',
    source_ignored_tags: ['status']
  });
  f.chat.message.push(
    { role: 'user', chatId: 'u1', data: '소연아, 괜찮아?' },
    {
      role: 'char',
      chatId: 'a1',
      data: '## 볼륨 5: 이름 붙이기\n### 챕터 18: 셋이라는 수\n#### Chatindex: 100\n<img cmd="Soyeon_smile">\n<lb-xnai id="s1">{{inlay::xyz}}</lb-xnai>\n<status>HP:100</status>\n소연이 고개를 끄덕이며 창밖을 바라보았다.'
    },
    { role: 'user', chatId: 'u2', data: '같이 나가자.' }
  );
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(
    f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    'model'
  );
  const shadowPrompt = f.prompts.find(body => !stageOf(body).startsWith('aide_'));
  assert.ok(shadowPrompt, 'shadow_act prompt recorded');
  const usr = userOf(shadowPrompt);
  assert.doesNotMatch(usr, /Soyeon_smile|inlay::xyz|Chatindex: 100|볼륨 5|챕터 18|HP:100|<status>/);
  assert.match(usr, /소연이 고개를 끄덕이며 창밖을 바라보았다\./);
});

test('shared SDK source rules strip literal ◆CG…◆ delimiters and mount full shared controls in 자료 · Skill', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = () => {
    f.controls.output = '소연이 창밖을 바라보았다.';
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

  // Open GUI on 자료 · Skill tab and verify shared SDK editor + peer sync panel mount
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('sources');
  await new Promise(r => setTimeout(r, 40));

  const controls = f.document.querySelector('[data-source-input-controls="gradia"]');
  assert.ok(controls, 'shared SDK source controls mounted in 자료 · Skill');
  assert.ok(controls.querySelector('[data-source-tag-finder]'), 'tag finder mounted');
  assert.ok(controls.querySelector('[data-source-input-preview]'), 'preview mounted');
  for (const peer of ['libra', 'hayaku', 'flashback']) {
    assert.ok(controls.querySelector(`[data-source-rule-sync-peer="${peer}"]`), `peer sync row for ${peer} exists`);
  }

  // Add ◆CG…◆ literal delimiter rule via the shared SDK UI and click 적용
  const rows = [...controls.querySelectorAll('[data-source-input-row]')];
  const blankRow = rows.at(-1);
  const customCb = blankRow.querySelector('[data-rule-custom]');
  const WinEvent = f.document.defaultView.Event;
  customCb.checked = true;
  customCb.dispatchEvent(new WinEvent('change', { bubbles: true }));
  const openInput = blankRow.querySelector('[data-rule-open]');
  const closeInput = blankRow.querySelector('[data-rule-close]');
  openInput.value = '◆CG';
  closeInput.value = '◆';
  openInput.dispatchEvent(new WinEvent('input', { bubbles: true }));
  closeInput.dispatchEvent(new WinEvent('input', { bubbles: true }));
  const together = controls.querySelector('[data-source-rule-sync-together]');
  if (together) together.checked = false;
  await controls.querySelector('[data-source-input-apply]').onclick();
  await new Promise(r => setTimeout(r, 40));

  // Verify ◆CG…◆ is stripped in both debugShadowPrevious and beforeRequest SHADOW prompt
  const prev = f.host.plugin.debugShadowPrevious({
    recent: {
      latestUser: '대화를 이어간다.',
      visibleMessages: [
        { role: 'assistant', content: '◆CG scene_beach_01◆\n소연이 모래사장을 걸었다.' },
        { role: 'user', content: '대화를 이어간다.' }
      ]
    }
  });
  assert.doesNotMatch(prev.text, /◆CG|scene_beach_01/);
  assert.match(prev.text, /소연이 모래사장을 걸었다\./);

  f.chat.message.push(
    { role: 'user', chatId: 'u1', data: '해변으로 가자.' },
    { role: 'char', chatId: 'a1', data: '◆CG scene_beach_01◆\n소연이 모래사장을 걸었다.' },
    { role: 'user', chatId: 'u2', data: '파도가 잔잔하네.' }
  );
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(
    f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })),
    'model'
  );
  const shadowPrompt = f.prompts.find(body => !stageOf(body).startsWith('aide_'));
  assert.ok(shadowPrompt, 'shadow_act prompt recorded');
  assert.doesNotMatch(userOf(shadowPrompt), /◆CG|scene_beach_01/);
  assert.match(userOf(shadowPrompt), /소연이 모래사장을 걸었다\./);
});
