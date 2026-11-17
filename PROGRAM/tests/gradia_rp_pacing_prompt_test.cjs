'use strict';

// RP pacing (follow-up to 4468f5b3, user request 2026-11-17): one stopping rule (carry the beats the
// moment earns, stop at the user-agency frontier, never pad toward it), NPC touch only as close as the
// relationship allows, and an unresolved matter that a time jump sets aside is not erased. Novel
// shares the touch and unresolved-matter rules (see the last tests).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

test('SHADOW in persona-only RP gets one stopping rule and the touch and time-jump limits', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '민아는 창가에 섰다.';
  };
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight', writing_mode: 'rp', rp_impersonation_scope: 'persona',
    enable_shadow_act: true, enable_character_aide: false, enable_world_aide: false, enable_plot_aide: false, failure_mode: 'hard', lore_activation_mode: 'off'
  });
  f.chat.message.push({ role: 'user', chatId: 'u1', data: '한참 뒤, 잠에서 깬다.' });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
  const shadow = f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');
  assert.ok(shadow.length > 0, 'SHADOW ran');

  assert.match(shadow, /SHADOW duty: [^\n]*Carry the model-owned beats the moment earns and stop at the user-agency frontier; never reach that frontier by padding with NPC self-talk, self-answering lines, or contrived errands, and never stretch past it\./);
  assert.match(shadow, /only as close as their relationship with the persona and what the story has established between them allow/);
  assert.match(shadow, /An unresolved matter is not erased: a character may raise it again later, when they naturally would\./);
  assert.match(shadow, /an unresolved matter may return later, when a character would naturally raise it\), and stop where a new player contribution is needed, without padding the way there\./);
  assert.match(shadow, /once an NPC’s reaction or initiative hands the persona a choice, that is the boundary\. Do not stretch the turn toward it or past it/);
  assert.doesNotMatch(shadow, /first natural point|stop cleanly once/, 'no rule asks to stop earlier than the frontier');
  assert.match(shadow, /USER-AGENCY FRONTIER/, 'the frontier rule the duty points to is present');
});

// Novel gets the touch limit and the unresolved-matter rule too (user request 2026-11-18); the
// stopping rule stays RP-only, since Novel has no persona turn to stop for.
for (const shadowDraftMode of ['classic', 'input_inclusive']) test(`Novel ${shadowDraftMode}: SHADOW and AIDEs keep unresolved matters and bound touch`, async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '민아는 창가에 섰다.';
  };
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight', writing_mode: 'novel', shadow_draft_mode: shadowDraftMode,
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: false, failure_mode: 'hard', lore_activation_mode: 'off'
  });
  f.chat.message.push({ role: 'user', chatId: 'u1', data: '한참 뒤, 민아가 잠에서 깬다.' });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
  const shadow = f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');
  const character = f.prompts.filter(body => stageOf(body) === 'aide_character').map(textOf).join('\n');
  assert.match(shadow, /An unresolved matter is not erased; a character may raise it again later\. A touch between characters goes only as close as their relationship allows\./);
  assert.match(character, /An unresolved matter is not erased by the jump: a character may raise it again later, when they naturally would\./);
  assert.match(character, /Physical contact between characters goes only as close as their relationship and what the story has established between them allow; a closer touch needs the scene to earn it\./);
  assert.doesNotMatch(shadow, /SHADOW duty: [^\n]*user-agency frontier/, 'the RP stopping rule stays out of Novel');
});
