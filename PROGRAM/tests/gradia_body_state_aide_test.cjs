'use strict';

// 상태 AIDE (aide_body_state): computes body state each turn from LIB records and the recent
// scene, stores nothing, never judges the persona's body in RP.
// Design record: docs/gradia/STATE-AIDE-DESIGN-20261114.md

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wireModel = (f, draftText, stageExtras = {}) => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...(stageExtras[stage] || {}) };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = draftText;
  };
};

const configure = async (f, settings = {}, enabled = { body: true, bond: false }) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false,
    enable_plot_aide: true, enable_body_state_aide: enabled.body, enable_forced_bond_aide: enabled.bond,
    failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_body_state: { ...(slots.aide_body_state || {}), enabled: enabled.body }, aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: enabled.bond } });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

test('상태 AIDE is off by default and adds no call or block', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, {}, { body: false, bond: false });
  await runTurn(f, '문을 연다.');
  assert.ok(!f.prompts.some(body => stageOf(body) === 'aide_body_state'));
  assert.ok(f.prompts.every(body => !textOf(body).includes('[BODY STATE')));
});

test('상태 runs before 억결, and both run right before Plot AIDE', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, { aide_stage_order: JSON.stringify(['aide_plot', 'aide_character', 'aide_world']) }, { body: true, bond: true });
  await runTurn(f, '문을 연다.');
  const aides = f.prompts.map(stageOf).filter(stage => stage.startsWith('aide_'));
  assert.deepEqual(aides, ['aide_body_state', 'aide_forced_bond', 'aide_plot', 'aide_character', 'aide_world']);
});

test('writing modes: prose skips, staging adds no verdict, RP never judges the persona', async t => {
  const prose = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(prose, '민아는 문 앞에 섰다.');
  await configure(prose, { rp_impersonation_scope: 'all' });
  await runTurn(prose, '문을 연다.');
  assert.ok(!prose.prompts.some(body => stageOf(body) === 'aide_body_state'), 'prose mode: no 상태 call');

  const staging = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(staging, '민아는 문 앞에 섰다.');
  await configure(staging, { rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging, '문을 연다.');
  assert.match(systemOf(staging.prompts.find(body => stageOf(body) === 'aide_body_state')), /Scene-staging RP mode: add no new condition and no new verdict/);

  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const packet = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라',
    recent: { visibleMessages: [{ role: 'assistant', content: '하준은 어제 독감에 걸렸다. 세라는 사흘 전부터 감기에 걸렸다.' }] },
    settings: { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, mode: 'normal' }
  });
  assert.match(packet, /- 하준 \(persona\): RP — use only what the user input states/);
  assert.doesNotMatch(packet.split('- 하준 (persona)')[1].split('\n- ')[0], /day \d/, 'no calculation for the persona');
  assert.match(packet, /- 세라:\n *감기: day 4 \(estimated; usual 7–10 days\) → ongoing/);
});

test('elapsed days are confirmed from two dates, estimated from recent phrases, unknown otherwise', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const base = { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal' };
  const confirmed = f.host.plugin.debugBodyStatePacket({
    characterName: '세라',
    libText: '세라는 4월 2일에 계단에서 넘어져 발목을 심한 부상을 입었다.',
    recent: { visibleMessages: [{ role: 'assistant', content: '4월 12일 아침, 세라는 창가에 앉아 있었다.' }] },
    settings: base
  });
  assert.match(confirmed, /Current story date: 4-12/);
  assert.match(confirmed, /injury \(severe\): day 11 \(confirmed; usual 30–90 days\) → ongoing/);

  const unknown = f.host.plugin.debugBodyStatePacket({
    characterName: '세라',
    libText: '세라는 독감에 걸렸다.',
    recent: { visibleMessages: [] },
    settings: base
  });
  assert.match(unknown, /독감: onset recorded, day unknown — do not state how long it has lasted/);
  assert.match(unknown, /Evidence source: LIB memory and recent scene/);

  const recovered = f.host.plugin.debugBodyStatePacket({
    characterName: '세라',
    libText: '세라는 감기에 걸렸다. 세라는 감기가 다 나았다.',
    settings: base
  });
  assert.match(recovered, /감기: recovery recorded after onset/);
});

test('cycle day and phase come from the per-chat card and the story date', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const packet = f.host.plugin.debugBodyStatePacket({
    characterName: '세라', scopeKey: 'chat-a',
    recent: { visibleMessages: [{ role: 'assistant', content: '5월 27일, 세라는 하루 종일 예민했다.' }] },
    settings: { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal', bodyStateCards: { 'chat-a': [{ name: '세라', cycleLength: 30, lastPeriodStart: '5월 1일' }] } }
  });
  assert.match(packet, /cycle: day 27 of 30 \(confirmed \(card\)\) → late luteal/);
});

test('pregnancy is a fixed verdict behind its own toggle, only for NPCs in RP', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const base = { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, mode: 'normal', bodyStateCards: { s: [{ name: '세라', cycleLength: 28, lastPeriodStart: '3월 1일' }] } };
  const recent = { visibleMessages: [{ role: 'assistant', content: '3월 14일 밤, 세라는 하준과 콘돔 없이 관계를 가졌다.' }, { role: 'assistant', content: '4월 20일, 세라는 아침마다 속이 메스꺼웠다.' }] };
  const off = f.host.plugin.debugBodyStatePacket({ personaName: '하준', characterName: '세라', scopeKey: 's', recent, settings: base });
  assert.doesNotMatch(off, /sexual contact|PREGNANT|not pregnant/, 'toggle off: no reproduction lines');

  const on = { ...base, bodyStateReproduction: true };
  const first = f.host.plugin.debugBodyStatePacket({ personaName: '하준', characterName: '세라', scopeKey: 's', recent, settings: on });
  const second = f.host.plugin.debugBodyStatePacket({ personaName: '하준', characterName: '세라', scopeKey: 's', recent, settings: on });
  const verdict = first.match(/sexual contact 37 days ago \(confirmed\), cycle day 14 then, 피임 안 함 → chance 33\.0% → (PREGNANT \(fixed verdict\); symptoms may show \(nausea, fatigue\)|not pregnant \(fixed verdict\))/);
  assert.ok(verdict, first);
  assert.equal(first, second, 'the same evidence gives the same verdict');
  assert.doesNotMatch(first.split('- 하준 (persona)')[1] || '', /sexual contact/, 'no verdict for the persona in RP');

  const condom = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey: 's', settings: on,
    recent: { visibleMessages: [{ role: 'assistant', content: '3월 14일 밤, 세라는 하준과 콘돔을 쓰고 관계를 가졌다.' }, { role: 'assistant', content: '4월 20일 아침.' }] }
  });
  assert.match(condom, /콘돔 → chance 5\.0%/);

  const noCycle = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey: 'other', settings: on,
    recent: { visibleMessages: [{ role: 'assistant', content: '세라는 하준과 관계를 가졌다.' }] }
  });
  assert.match(noCycle, /conception cannot be judged: cycle day or date unknown — do not decide a pregnancy/);
});

test('checkers return state_check and later stages read it; readings stay in memory', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 다리를 절며 문 앞에 섰다.', {
    aide_character: { state_check: [{ character: '민아', verdict: 'adjust', claim: '민아 runs to the door', reason: 'her sprained ankle cannot take running' }] },
    aide_body_state: { state_readings: [{ character: '민아', summary: '발목 염좌 3일째, 절뚝임' }] }
  });
  await configure(f);
  const keysBefore = new Set(f.values.keys());
  await runTurn(f, '민아에게 다가간다.');
  const character = f.prompts.find(body => stageOf(body) === 'aide_character');
  assert.ok(JSON.stringify(character).includes('"state_check"'), 'the patch schema asks for state_check');
  const body = systemOf(f.prompts.find(item => stageOf(item) === 'aide_body_state'));
  assert.match(body, /\[aide_character\] 민아: adjust — 민아 runs to the door \(because her sprained ankle cannot take running\)/);
  assert.match(systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot')), /\[aide_character\] 민아: adjust/);
  const newKeys = [...f.values.keys()].filter(key => !keysBefore.has(key));
  assert.deepEqual(newKeys.filter(key => /body|state_read|reading/i.test(key)), [], 'no body state is persisted');
});
