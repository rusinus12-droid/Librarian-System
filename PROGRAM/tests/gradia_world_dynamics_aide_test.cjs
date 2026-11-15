'use strict';

// 세계 동역학 AIDE (aide_world_dynamics): an optional extension AIDE that lets off-scene
// movement with an established cause reach the scene. This file covers its registration:
// default off, execution order, writing-mode gates, and that it stores nothing.
// Design record: docs/gradia/FORCED-BOND-AIDE-DESIGN-20261114.md §14 (extension AIDE frame).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const STAGE = 'aide_world_dynamics';
const BLOCK = '[WORLD DYNAMICS';
const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wireModel = (f, draftText) => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = draftText;
  };
};

const configure = async (f, settings = {}, enabled = {}) => {
  const on = { world: true, body: false, bond: false, ...enabled };
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false,
    enable_plot_aide: true, enable_world_dynamics_aide: on.world, enable_body_state_aide: on.body, enable_forced_bond_aide: on.bond,
    failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({
    ...slots,
    aide_world_dynamics: { ...(slots.aide_world_dynamics || {}), enabled: on.world },
    aide_body_state: { ...(slots.aide_body_state || {}), enabled: on.body },
    aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: on.bond }
  });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

const start = async (t, settings = {}, enabled = {}) => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, settings, enabled);
  return f;
};

test('세계 동역학 AIDE is off by default and adds no call or block', async t => {
  const f = await start(t, {}, { world: false });
  await runTurn(f, '문을 연다.');
  assert.ok(f.prompts.length > 0);
  assert.ok(!f.prompts.some(body => stageOf(body) === STAGE));
  assert.ok(f.prompts.every(body => !textOf(body).includes(BLOCK)));
});

test('when on, the stage runs and every draft stage carries the block with its own duty', async t => {
  const f = await start(t);
  await runTurn(f, '문을 연다.');
  const own = f.prompts.filter(body => stageOf(body) === STAGE);
  assert.ok(own.length > 0, 'the stage is called');
  assert.match(systemOf(own[0]), /STAGE DUTY: World Dynamics AIDE:/);
  assert.match(systemOf(own[0]), /ROLE: World Dynamics AIDE/);
  const plot = f.prompts.find(body => stageOf(body) === 'aide_plot');
  assert.match(systemOf(plot), /STAGE DUTY: Plot AIDE: check that an off-scene movement does not end the turn/);
  const character = f.prompts.find(body => stageOf(body) === 'aide_character');
  assert.match(systemOf(character), /STAGE DUTY: Character AIDE: check that characters react only to off-scene movement they could have learned of/);
  assert.ok(f.prompts.some(body => !stageOf(body).startsWith('aide_') && textOf(body).includes('STAGE DUTY: SHADOW: when the evidence shows something already in motion off-scene')), 'SHADOW gets its duty');
});

test('세계 동역학 runs before 상태 and 억결, and all three run right before Plot AIDE', async t => {
  const f = await start(t, { aide_stage_order: JSON.stringify(['aide_plot', 'aide_character', 'aide_world']) }, { body: true, bond: true });
  await runTurn(f, '문을 연다.');
  const aides = f.prompts.map(stageOf).filter(stage => stage.startsWith('aide_'));
  assert.deepEqual(aides, [STAGE, 'aide_body_state', 'aide_forced_bond', 'aide_plot', 'aide_character', 'aide_world']);
});

test('writing modes: prose skips the stage, staging surfaces nothing new, RP leaves the persona to the user', async t => {
  const prose = await start(t, { rp_impersonation_scope: 'all' });
  await runTurn(prose, '문을 연다.');
  assert.ok(!prose.prompts.some(body => stageOf(body) === STAGE), 'prose mode: no call');
  assert.ok(prose.prompts.every(body => !textOf(body).includes(BLOCK)), 'prose mode: no block');

  const staging = await start(t, { rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging, '문을 연다.');
  const stagingSystem = systemOf(staging.prompts.find(body => stageOf(body) === STAGE));
  assert.match(stagingSystem, /Scene-staging RP mode: surface no new off-scene development and bring nobody in/);
  assert.doesNotMatch(stagingSystem, /- RP mode: the world and NPCs move/);

  const rp = await start(t, { rp_impersonation_scope: 'persona' });
  await runTurn(rp, '문을 연다.');
  assert.match(systemOf(rp.prompts.find(body => stageOf(body) === STAGE)), /RP mode: the world and NPCs move on their own terms\. Never decide the persona’s reaction, knowledge, or next act/);

  const novel = await start(t, { writing_mode: 'novel' });
  await runTurn(novel, '문을 연다.');
  assert.match(systemOf(novel.prompts.find(body => stageOf(body) === STAGE)), /Novel mode: off-scene actors may move and reach the scene within the author’s direction/);
});

test('pipeline mode off: no call and no block', async t => {
  const f = await start(t, { mode: 'off' });
  await runTurn(f, '문을 연다.');
  assert.ok(!f.prompts.some(body => stageOf(body) === STAGE));
  assert.ok(f.prompts.every(body => !textOf(body).includes(BLOCK)));
});

test('the block forbids invented movement and the stage stores nothing', async t => {
  const f = await start(t);
  const keysOf = () => new Set([...f.values.keys(), ...f.local.keys()].map(String));
  const before = keysOf();
  await runTurn(f, '문을 연다.');
  const system = systemOf(f.prompts.find(body => stageOf(body) === STAGE));
  assert.match(system, /Never invent a faction, pursuer, deadline, or crisis/);
  assert.match(system, /Surfacing nothing is the correct result whenever nothing is due/);
  assert.match(system, /An off-scene movement never ends the turn and is never resolved in one turn/);
  // The turn may write run diagnostics, but nothing of this stage's own: settings were saved before.
  const added = [...keysOf()].filter(key => !before.has(key));
  assert.ok(added.every(key => !/world.?dynamics/i.test(key)), `no world-dynamics storage key: ${added.join(', ')}`);
});

test('the enabled flag survives a settings round trip', async t => {
  const f = await start(t);
  const slots = await f.host.plugin.getAgentSlots();
  assert.equal(slots.aide_world_dynamics?.enabled, true);
  await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings() });
  assert.equal((await f.host.plugin.getAgentSlots()).aide_world_dynamics?.enabled, true);
});
