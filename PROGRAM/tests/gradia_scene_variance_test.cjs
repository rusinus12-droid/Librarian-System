'use strict';

// Living scene: one random variable per run shared by every stage, calculated question load and
// repeated motifs, and seed rules that prefer acts over questions and keep the story moving.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wire = (f, draft = '민아는 창가에 섰다.', stageExtras = {}) => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...(stageExtras[stage] || {}) };
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
  const variable = 'THIS TURN’S VARIABLE (inner): a non-persona character reacts to the last line with a feeling they did not expect in themselves, and it shows.';
  assert.ok(shadowText(f).includes(variable));
  assert.match(shadowText(f), /Write it into the first draft, early or mid-scene/);
  assert.match(shadowText(f), /It belongs to an NPC or the world, never to the persona\./);
  const character = f.prompts.filter(body => stageOf(body) === 'aide_character').map(systemOf).join('\n');
  const plot = f.prompts.filter(body => stageOf(body) === 'aide_plot').map(systemOf).join('\n');
  assert.ok(character.includes(variable) && plot.includes(variable), 'every stage sees the same variable');
  assert.match(plot, /Keep it when it stays inside the scene and serves or tests the purpose/);
  assert.match(plot, /If it drifted off the scene, tie it back to the scene or remove it; never add an unrelated substitute\./);
  assert.match(shadowText(f), /It bends how the scene reaches its purpose \(a detour, a friction, a sharper edge\); it never opens a topic, memory, or event unrelated to the scene\./);
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
  assert.match(shadowText(staging), /THIS TURN’S VARIABLE \(world\): a familiar background sound of this place stops/);
  assert.match(shadowText(staging), /The variable comes from inside this scene: a person present, the line just spoken, the matter at hand, or an object or feature of this place/);
  assert.match(shadowText(staging), /It is a change in the world only/);

  const novel = await fixture(t, { writingMode: 'novel', unified: false });
  wire(novel);
  novel.host.plugin.debugSetSceneVarianceRandom([0.1, 0.99, 0.0]);
  await run(novel, { scene_variance: 'high', writing_mode: 'novel' });
  assert.match(shadowText(novel), /THIS TURN’S VARIABLE \(protagonist\): the protagonist acts on an impulse about the matter at hand/);
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
  assert.match(shadow, /vary within this scene instead of leaving it\./);
});

// User decision 2026-11-17: a scene has a purpose, and the development and every reaction of the
// characters and the world are arranged by it. One purpose is shared by every stage of a run.
test('SHADOW settles the scene purpose; the first AIDE names it and later stages keep it', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f, '민아는 창가에 섰다.', { aide_character: { scene_purpose: '민아가 떠나려는 이유를 처음으로 털어놓게 한다' } });
  await run(f, { scene_variance: 'off' });
  const shadow = shadowText(f);
  assert.match(shadow, /\[LIVING SCENE — PURPOSE, VARIANCE AND REPETITION\]/);
  assert.match(shadow, /Settle this scene’s purpose first: the one thing this response must move forward/);
  assert.match(shadow, /In RP the purpose is how the world and the other characters answer the persona, never a decision for the persona\./);
  assert.match(shadow, /Arrange the development and every reaction by that purpose/);
  assert.match(shadow, /A beat the purpose cannot explain does not belong here: tie it to the purpose or cut it\. Nothing unrelated to this scene enters the response\./);
  const character = f.prompts.find(body => stageOf(body) === 'aide_character');
  assert.ok(JSON.stringify(character).includes('"scene_purpose"'), 'the first AIDE is asked for the purpose');
  const plot = systemOf(f.prompts.find(body => stageOf(body) === 'aide_plot'));
  assert.match(plot, /THIS SCENE’S PURPOSE \(set earlier in this run\): 민아가 떠나려는 이유를 처음으로 털어놓게 한다\. Keep it/);
});

test('a purpose belongs to its own run and never carries into the next turn', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f, '민아는 창가에 섰다.', { aide_character: { scene_purpose: '첫 턴의 목적' } });
  await run(f, { scene_variance: 'off' });
  wire(f, '민아는 창가에 섰다.');
  await run(f, { scene_variance: 'off' }, '문을 닫는다.');
  const character = systemOf(f.prompts.find(body => stageOf(body) === 'aide_character'));
  assert.doesNotMatch(character, /첫 턴의 목적/);
  assert.match(character, /Settle this scene’s purpose first/);
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

// User decision 2026-11-17: the retired arc director is replaced by an arc read every turn. LIBRA's
// 서사 연감 hands its active arc over as [STORY ARC] lines; without them the arc is read from the
// scene. The scene purpose is the arc's next step, and the first AIDE's reading holds for the run.
test('the arc from 서사 연감 frames the purpose; without a record the arc is read from the scene', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const libText = [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '[STORY ARC] 진행 중 흐름: 마리가 아버지의 죽음의 진실에 다가간다 (단계: 고조) — 레버넌트의 정체가 드러나기 시작했다 · 중심 압력: 진실을 알수록 머핀과의 약속이 흔들린다',
    '[STORY ARC] 현재 압력: 언덕 위 묘지에서 처음 보는 방문객을 만났다',
    '이야기 16일째 마리는 비석 앞에서 군번줄을 쥐었다'
  ].join('\n');
  const block = f.host.plugin.debugSceneBlock({ stageName: 'shadow_act', libText, settings: { sceneVariance: 'off' } });
  assert.match(block, /STORY ARC \(LIBRA 서사 연감\): 진행 중 흐름: 마리가 아버지의 죽음의 진실에 다가간다 \(단계: 고조\)[^\n]* \/ 현재 압력: 언덕 위 묘지에서 처음 보는 방문객을 만났다\./);
  assert.match(block, /The scene purpose is the next step of that arc that the current input opens/);
  assert.match(block, /Do not resolve the arc in one turn and do not start an unrelated one\./);

  const none = f.host.plugin.debugSceneBlock({ stageName: 'shadow_act', libText: '이야기 16일째 마리는 비석 앞에 앉았다', settings: { sceneVariance: 'off' } });
  assert.match(none, /STORY ARC: none recorded yet\. Read the arc the story is already on from the recent scene/);
  assert.match(none, /Do not invent an arc the scene does not show\./);
});

test('arc lines stay out of per-sentence evidence parsing', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const packet = f.host.plugin.debugWorldDynamicsPacket({ libText: '[STORY ARC] 진행 중 흐름: 기사단이 추격대를 보냈다는 소문이 퍼진다 (단계: 전개)' });
  assert.match(packet, /No off-scene movement on record/, 'an arc summary is not read as an off-scene movement');
});

test('the first AIDE’s arc reading holds for the rest of the run', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f, '민아는 창가에 섰다.', { aide_character: { scene_purpose: '민아가 떠나려는 이유를 털어놓게 한다', story_arc: '이별을 앞둔 두 사람의 관계 정리 · 고조 · 이유를 처음 말하는 걸음' } });
  await run(f, { scene_variance: 'off' });
  const character = JSON.stringify(f.prompts.find(body => stageOf(body) === 'aide_character'));
  assert.ok(character.includes('"story_arc"'), 'the first AIDE is asked for its arc reading');
  const plot = systemOf(f.prompts.find(body => stageOf(body) === 'aide_plot'));
  assert.match(plot, /THIS RUN’S ARC READING \(set earlier in this run\): 이별을 앞둔 두 사람의 관계 정리 · 고조 · 이유를 처음 말하는 걸음\./);
  assert.match(plot, /THIS SCENE’S PURPOSE \(set earlier in this run\): 민아가 떠나려는 이유를 털어놓게 한다\./);
});

// The latest run's arc and purpose are visible: a card on 단계별 실행 결과 and the debug export.
test('the run results card and the debug export show the arc source, arc reading, purpose and variable', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f, '민아는 창가에 섰다.', { aide_character: { scene_purpose: '민아가 떠나려는 이유를 털어놓게 한다', story_arc: '이별을 앞둔 관계 정리 · 고조 · 이유를 처음 말하는 걸음' } });
  f.host.plugin.debugSetSceneVarianceRandom([0.1, 0.99, 0.0]);
  t.after(() => f.host.plugin.debugSetSceneVarianceRandom(null));
  await run(f, { scene_variance: 'medium' });
  const exported = f.host.plugin.debugSceneRun();
  assert.equal(exported.schema, 'gradia.scene_run.v1');
  assert.equal(exported.arcSource.kind, 'read_from_scene', 'no 서사 연감 lines in this fixture');
  assert.equal(exported.arcReading, '이별을 앞둔 관계 정리 · 고조 · 이유를 처음 말하는 걸음');
  assert.equal(exported.purpose, '민아가 떠나려는 이유를 털어놓게 한다');
  assert.equal(exported.setBy, 'aide_character');
  assert.equal(exported.variance.variable.category, 'world');

  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('results');
  const card = f.document.querySelector('[data-scene-run-card]');
  assert.ok(card, 'the results page shows the card');
  const text = card.textContent;
  assert.match(text, /장면 목적 · 아크/);
  assert.match(text, /아크 출처서사 연감 기록 없음 · 최근 장면에서 판독/);
  assert.match(text, /이번 턴 아크 판독이별을 앞둔 관계 정리 · 고조 · 이유를 처음 말하는 걸음 · 인물 AIDE에서 정함/);
  assert.match(text, /장면 목적민아가 떠나려는 이유를 털어놓게 한다 · 인물 AIDE에서 정함/);
  assert.match(text, /무작위 변수세계 · a familiar background sound of this place stops/);
  const tabs = f.document.querySelector('[data-page="results"] [data-subtabs="rs"]');
  assert.equal(card.nextElementSibling, tabs, 'the card sits above the stage tabs');
});

test('dialogue-to-scene anchor and silent address canon lock prevent unprompted NPC tangents', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f);
  await run(f, { scene_variance: 'off' });
  const shadow = shadowText(f);
  const character = systemOf(f.prompts.find(body => stageOf(body) === 'aide_character'));
  const plot = systemOf(f.prompts.find(body => stageOf(body) === 'aide_plot'));
  for (const text of [shadow, character, plot]) {
    assert.match(text, /DIALOGUE-TO-SCENE ANCHOR: every NPC line must answer or push on something concretely present/);
    assert.match(text, /NARRATION–DIALOGUE SEAM: keep each spoken line glued to the surrounding action/);
  }
  assert.match(character, /reacts to a word or form of address never spoken in this scene/);
  assert.match(plot, /reacts to a word or form of address never spoken in this scene/);

  const lock = f.host.plugin.debugBuildRelationshipCanonLock(
    [{ label: '호칭 규칙', content: '소연과 준호는 동갑내기 소꿉친구라 이름 뒤에 씨를 붙이지 않고 편하게 부른다.' }],
    '소연 옆에 앉는다.',
    '',
    { character: { name: '소연', desc: '소연' }, persona: { name: '준호', desc: '준호' } }
  );
  assert.match(lock.block, /Apply these silently when rendering names, titles, and speech registers; never have a character bring up, complain about, or comment on a form of address unless someone in the current exchange actually used or changed it\./);
  assert.match(character, /cut any unprompted character complaints about an address form that nobody actually used here\./);
});
