'use strict';

// Fixations (user request 2026-11-17): a live chat kept circling "세다" (세지 마 / 세면 / 셀게 /
// 센다) and the motif list, which drops verb forms, never saw it. GRADIA now groups word forms
// by stem across the last six responses, the Plot AIDE names a fixation in its own call, and
// every stage is told to break it for the next few turns unless the input itself raises it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const COUNTING = [
  '하연은 이불을 끌어안았다. "세지 마. 지금 세면 내가 진 거 같잖아."',
  '"잘 세는 애들이 손해 보는 거야." 하연은 창밖을 보며 말했다.',
  '하연은 웃었다. "그러니까 세지 마. 안 셀게, 나도."',
  '"이거 하고 나서도, 나 안 세는 거지?" 하연이 셔츠 자락을 당겼다.',
  '"세면 지는 거야. 알지?" 하연이 낮게 속삭였다.'
];
const wire = (f, plotFixation = []) => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...(stage === 'aide_plot' ? { fixation: plotFixation } : {}) };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '하연은 창가로 걸어갔다.';
  };
};
const run = async (f, input) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', multi_pipeline_mode: 'lightweight', rp_impersonation_scope: 'persona',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off', scene_variance: 'off'
  });
  f.chat.message.push({ role: 'user', chatId: 'u' + (f.chat.message.length + 1), data: input });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};
const seed = (f, replies) => {
  for (const [index, reply] of replies.entries()) {
    f.chat.message.push({ role: 'user', chatId: `su${index}`, data: '하연을 바라본다.' });
    f.chat.message.push({ role: 'assistant', chatId: `sa${index}`, data: reply });
  }
};
const stageText = (f, stage) => f.prompts.filter(body => stageOf(body) === stage).map(textOf).join('\n');
const shadowText = f => f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');

test('a verb repeated in many forms across recent responses is a fixation every stage must break', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f);
  seed(f, COUNTING);
  await run(f, '문을 잠그고 돌아선다.');
  for (const text of [shadowText(f), stageText(f, 'aide_character'), stageText(f, 'aide_plot')]) {
    // A one-syllable stem is shown by its forms; a name seen only with particles is not a fixation.
    assert.match(text, /FIXATION TO BREAK: the recent responses keep returning to 세지 \/ 세면[^.;]*셀게\. /);
    assert.match(text, /Memory or evidence that mentions it records the past; it is not a cue to repeat it\./);
  }
  assert.match(stageText(f, 'aide_plot'), /If the draft still echoes it, keep the beat and change the words or the move/);
  assert.match(stageText(f, 'aide_plot'), /OUTPUT: add a top-level "fixation"/);
  assert.doesNotMatch(shadowText(f), /OUTPUT: add a top-level "fixation"/, 'only the Plot AIDE names fixations');
  const snapshot = f.host.plugin.debugSceneRun();
  assert.equal(snapshot.fixations.detected[0].stem, '세');
  assert.ok(snapshot.fixations.detected[0].responses >= 4);
});

test('the current input may raise it, and two mentions are not a fixation', async t => {
  const raised = await fixture(t, { writingMode: 'rp', unified: false });
  wire(raised);
  seed(raised, COUNTING);
  await run(raised, '"그래, 안 세. 근데 왜 자꾸 세지 말라는 거야?"');
  assert.doesNotMatch(shadowText(raised), /FIXATION TO BREAK/);
  assert.match(shadowText(raised), /The current input itself raises [^:]*: answer it this turn, then let it go instead of turning it into a refrain\./);

  const few = await fixture(t, { writingMode: 'rp', unified: false });
  wire(few);
  seed(few, ['하연은 웃었다. "세지 마."', '하연은 창밖을 봤다.', '하연은 컵을 내려놓았다.', '"지금 세면 진 거야." 하연이 말했다.']);
  await run(few, '문을 잠근다.');
  assert.doesNotMatch(shadowText(few), /FIXATION TO BREAK/);
});

test('a fixation the Plot AIDE names carries into the next turns and then expires', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f, ['감정을 점수로 세는 것']);
  seed(f, ['하연은 창밖을 봤다.', '하연은 컵을 내려놓았다.', '하연은 웃었다.']);
  await run(f, '문을 잠근다.');
  assert.doesNotMatch(shadowText(f), /감정을 점수로 세는 것/, 'named in this run, it applies from the next one');
  assert.equal(f.host.plugin.debugSceneRun().fixations.named[0].fromThisRun, true);
  wire(f, []);
  for (let turn = 1; turn <= 4; turn += 1) {
    f.chat.message.push({ role: 'assistant', chatId: `a-next-${turn}`, data: '하연은 창가로 걸어갔다.' });
    await run(f, `창밖을 본다 ${turn}.`);
    assert.match(shadowText(f), /FIXATION TO BREAK: the recent responses keep returning to “감정을 점수로 세는 것”/, `turn ${turn}`);
  }
  f.chat.message.push({ role: 'assistant', chatId: 'a-next-5', data: '하연은 창가로 걸어갔다.' });
  await run(f, '창밖을 본다 5.');
  assert.doesNotMatch(shadowText(f), /감정을 점수로 세는 것/, 'it expires after four turns');
});
