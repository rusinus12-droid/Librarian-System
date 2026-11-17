'use strict';

// Object, body and posture continuity (user requests 2026-11-17/18): a blanket pushed fully down
// came back over a character with nothing shown, and one gathered at the chest jumped to the chin.
// Every stage carries the contract, and the World AIDE follows each object through the draft.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

for (const writingMode of ['rp', 'novel']) test(`${writingMode}: every stage carries object continuity and the World AIDE checks the last state`, async t => {
  const f = await fixture(t, { writingMode, unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '하연은 이불을 가슴께에 끌어안았다.';
  };
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight', writing_mode: writingMode, rp_impersonation_scope: 'persona',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'
  });
  f.chat.message.push({ role: 'user', chatId: 'u1', data: '하연 곁에 앉는다.' });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');

  const shadow = f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');
  const stages = ['aide_character', 'aide_world', 'aide_plot'].map(stage => [stage, f.prompts.filter(body => stageOf(body) === stage).map(textOf).join('\n')]);
  for (const [stage, text] of [['shadow_act', shadow], ...stages]) {
    // One merged contract with the wardrobe rules, so the prompt stays inside small contexts.
    assert.equal(text.split('WARDROBE AND APPEARANCE CONTINUITY — HARD CONDITION:').length - 1, 1, stage);
    assert.match(text, /and so too objects \(blankets, towels, cups, phones, doors, curtains, lights\), where each character stands, sits or lies, and where their arms, hands, legs and head are/, stage);
    assert.match(text, /partial states included \(a coat half off, a blanket at the chest, a door half open, a hand on a shoulder\)/, stage);
    assert.match(text, /a blanket pulled from the chest up to the chin\. One pushed fully off never lies over anyone again by itself, no person, limb or object jumps to a new place/, stage);
    assert.match(text, /a hand that holds or is held is not free/, stage);
  }
  const world = stages.find(([stage]) => stage === 'aide_world')[1];
  assert.match(world, /Last-state check: privately note where the terminal scene left each object, person and limb in play \(how far a blanket covers, which door is open, who sits or lies where, where each hand and leg is\)/);
  assert.match(world, /A change with no action causing it, at the point it happens and through the steps between, is a defect to patch\./);
});
