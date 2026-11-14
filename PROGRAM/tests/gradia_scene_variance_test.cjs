'use strict';

// Living scene: one random variable per run shared by every stage, calculated question load and
// repeated motifs, and seed rules that prefer acts over questions and keep the story moving.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wire = (f, draft = '민아는 창가에 섰다.') => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = draft;
  };
};
const run = async (f, settings, input = '창밖을 본다.') => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  f.chat.message.push({ role: 'user', chatId: 'u' + (f.chat.message.length + 1), data: input });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};
const shadowText = f => f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');

test('one random variable is drawn per run, written by SHADOW and kept by the AIDEs and Plot', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f);
  f.host.plugin.debugSetSceneVarianceRandom([0.1, 0.0, 0.0]);
  await run(f, { scene_variance: 'medium' });
  t.after(() => f.host.plugin.debugSetSceneVarianceRandom(null));
  const variable = 'THIS TURN’S VARIABLE (inner): an unrelated memory surfaces in a non-persona character and colors their next line.';
  assert.ok(shadowText(f).includes(variable));
  assert.match(shadowText(f), /Write it into the first draft, early or mid-scene/);
  assert.match(shadowText(f), /It belongs to an NPC or the world, never to the persona\./);
  const character = f.prompts.filter(body => stageOf(body) === 'aide_character').map(systemOf).join('\n');
  const plot = f.prompts.filter(body => stageOf(body) === 'aide_plot').map(systemOf).join('\n');
  assert.ok(character.includes(variable) && plot.includes(variable), 'every stage sees the same variable');
  assert.match(plot, /It is not arbitrary escalation or a random interruption: keep it/);
  assert.equal(f.host.plugin.debugSceneVarianceRun().variable.category, 'inner');
});

test('the roll can skip a turn, off adds nothing, staging uses the world only, Novel may use the protagonist', async t => {
  t.after(() => {});
  const skipped = await fixture(t, { writingMode: 'rp', unified: false });
  wire(skipped);
  skipped.host.plugin.debugSetSceneVarianceRandom([0.95]);
  await run(skipped, { scene_variance: 'medium' });
  assert.doesNotMatch(shadowText(skipped), /THIS TURN’S VARIABLE/, 'medium skips when the roll is above 0.6');

  const off = await fixture(t, { writingMode: 'rp', unified: false });
  wire(off);
  off.host.plugin.debugSetSceneVarianceRandom([0.0, 0.0, 0.0]);
  await run(off, { scene_variance: 'off' });
  assert.doesNotMatch(shadowText(off), /THIS TURN’S VARIABLE/);

  const staging = await fixture(t, { writingMode: 'rp', unified: false });
  wire(staging);
  staging.host.plugin.debugSetSceneVarianceRandom([0.1, 0.99, 0.0]);
  await run(staging, { scene_variance: 'medium', rp_impersonation_scope: 'persona_cast' });
  assert.match(shadowText(staging), /THIS TURN’S VARIABLE \(world\): a phone buzzes/);
  assert.match(shadowText(staging), /It is a change in the world only/);

  const novel = await fixture(t, { writingMode: 'novel', unified: false });
  wire(novel);
  novel.host.plugin.debugSetSceneVarianceRandom([0.1, 0.99, 0.0]);
  await run(novel, { scene_variance: 'high', writing_mode: 'novel' });
  assert.match(shadowText(novel), /THIS TURN’S VARIABLE \(protagonist\): the protagonist acts on an impulse/);
  assert.match(shadowText(novel), /It may belong to any character, the protagonist included/);

  const prose = await fixture(t, { writingMode: 'rp', unified: false });
  wire(prose);
  prose.host.plugin.debugSetSceneVarianceRandom([0.0, 0.0, 0.0]);
  await run(prose, { scene_variance: 'high', rp_impersonation_scope: 'all' });
  assert.doesNotMatch(shadowText(prose), /LIVING SCENE/, 'prose mode gets no variance');
  prose.host.plugin.debugSetSceneVarianceRandom(null);
});

test('question load and repeated motifs from the recent responses are passed on', async t => {
  const chat = { id: 'h', message: [
    { role: 'user', chatId: 'u1', data: '방에 들어간다.' },
    { role: 'assistant', chatId: 'a1', data: '민아는 우산을 찾았다. 우산이 없었다. 창밖의 우산들이 지나갔다.' },
    { role: 'user', chatId: 'u2', data: '옆에 앉는다.' },
    { role: 'assistant', chatId: 'a2', data: '"우산 어디 뒀어?" 민아가 물었다. "비 오잖아?" "택시 탈래?" "아니면 기다릴까?" 우산 생각뿐이었다.' }
  ] };
  const character = { chaId: 'c', name: '민아', chats: [chat], chatPage: 0, lorebook: [] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wire(f);
  f.host.plugin.debugSetSceneVarianceRandom([0.99]);
  await run(f, { scene_variance: 'medium' }, '고개를 젓는다.');
  f.host.plugin.debugSetSceneVarianceRandom(null);
  const shadow = shadowText(f);
  assert.match(shadow, /QUESTION LOAD: the last response asked the persona 4 questions\. This turn ask the persona at most one question, or none/);
  assert.match(shadow, /ALREADY-USED MOTIFS \(recent responses\): 우산[,.]/);
});

test('seed and causal rules prefer acts over questions and keep the story moving', async t => {
  const rp = await fixture(t, { writingMode: 'rp', unified: false });
  wire(rp);
  await run(rp, { scene_variance: 'off' });
  assert.match(shadowText(rp), /Prefer an act or a change over a question: ask the persona at most one question, and only when nothing else fits\./);
  assert.doesNotMatch(shadowText(rp), /a line that expects an answer/);
  assert.match(shadowText(rp), /PLAUSIBLE IS NOT PREDICTABLE/);

  const novel = await fixture(t, { writingMode: 'novel', unified: false });
  wire(novel);
  await run(novel, { scene_variance: 'off', writing_mode: 'novel' });
  assert.match(shadowText(novel), /Before stopping, move the scene at least one real step \(a decision, a reveal, a change of position or plan\)/);
  assert.doesNotMatch(shadowText(novel), /a question left unanswered/);
});

test('the SHADOW panel saves the scene variance level', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const select = f.document.querySelector('[data-scene-variance]');
  assert.ok(select, 'the SHADOW panel has the scene variance select');
  assert.equal(select.value, 'medium');
  select.value = 'high';
  select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  assert.equal((await f.host.plugin.getRuntimeSettings()).scene_variance, 'high');
});
