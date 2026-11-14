'use strict';

// Plot realism: a routine continues only while its reasons hold, and a character's expectation is
// a belief, not a fact (after a breakup that morning, the usual evening call does not come).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';
const textOf = body => body.messages.map(m => m.content).join('\n');

for (const mode of ['lightweight', 'heavyweight']) {
  test(`causal realism reaches SHADOW and Plot, and belief-vs-fact reaches Character AIDE (${mode})`, async t => {
    const f = await fixture(t, { writingMode: 'rp', unified: false });
    f.controls.onModel = (_idx, body) => {
      const sys = systemOf(body);
      const stage = stageOf(body);
      const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
      if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
      else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
      else f.controls.output = '혜연은 휴대폰을 내려다보았다.';
    };
    await f.host.plugin.saveRuntimeSettings({
      ...await f.host.plugin.getRuntimeSettings(),
      mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', multi_pipeline_mode: mode,
      enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'
    });
    f.chat.message.push({ role: 'user', chatId: 'u9', data: '저녁이 되었다.' });
    await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
    const shadow = f.prompts.filter(body => !stageOf(body) || stageOf(body) === 'shadow_act').map(textOf).join('\n');
    const plot = f.prompts.filter(body => stageOf(body) === 'aide_plot').map(systemOf).join('\n');
    const character = f.prompts.filter(body => stageOf(body) === 'aide_character').map(systemOf).join('\n');
    for (const [name, prompt] of [['SHADOW', shadow], ['Plot', plot]]) {
      assert.match(prompt, /CAUSAL REALISM: a habit, routine, or standing arrangement .* continues only while the reasons behind it still hold/, name);
      assert.match(prompt, /BELIEF IS NOT FACT/, name);
      assert.match(prompt, /after a breakup that morning, the ex does not make the usual evening call/, name);
    }
    assert.match(plot, mode === 'heavyweight' ? /if its reason is gone, plan its absence/ : /Repair any routine, appointment, or habit the draft continues although the story has removed its reason/);
    assert.match(character, /BELIEF IS NOT FACT/);
    assert.doesNotMatch(character, /CAUSAL REALISM: a habit/, 'Character AIDE gets the belief rule only');
  });
}
