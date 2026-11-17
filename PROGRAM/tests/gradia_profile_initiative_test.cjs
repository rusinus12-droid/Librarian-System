'use strict';

// Profile-driven initiative: a character's profile is found by what it says about a named
// character (description, lorebook entry, character sheet, cast-table row), not by a section
// title, because one-character bots and multi-character bots keep profiles in different places.
// Initiative applies to Novel and to RP where only the persona is locked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wire = f => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '민아는 창가에 섰다.';
  };
};
const run = async (f, settings) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: false, failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  f.chat.message.push({ role: 'user', chatId: 'u' + (f.chat.message.length + 1), data: '창밖을 본다.' });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};
const shadowText = f => f.prompts.filter(body => !stageOf(body)).map(textOf).join('\n');
const characterText = f => f.prompts.filter(body => stageOf(body) === 'aide_character').map(textOf).join('\n');

const DEFINITION = 'CHARACTER PROFILE means whatever supplied text describes a named character, wherever it sits: the character description, a lorebook entry or character sheet under that name, a row of a cast table, the persona text, or memory about them. Find it by the character’s name, not by a section title.';
const RP_INITIATIVE = 'PROFILE-DRIVEN INITIATIVE: NPCs are not passive responders';
const NOVEL_INITIATIVE = 'PROFILE-DRIVEN INITIATIVE: let what each active character’s profile establishes';
const SHADOW_LINE = 'A character with no profile acts from what the scene and memory show of them.';
const CHARACTER_LINE = 'Leave a character whose profile is missing alone; never invent a drive to justify a change.';

const assertNoRetiredWording = text => {
  assert.doesNotMatch(text, /LORE-DRIVEN INITIATIVE/);
  assert.doesNotMatch(text, /defense mechanisms/);
  assert.doesNotMatch(text, /1–2 concrete/);
};

test('RP with only the persona locked: profile definition, NPC initiative, SHADOW and Character AIDE lines', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f);
  await run(f, { writing_mode: 'rp', rp_impersonation_scope: 'persona' });
  const shadow = shadowText(f);
  const character = characterText(f);
  assert.ok(shadow.includes(DEFINITION), 'SHADOW defines the profile by content');
  assert.ok(shadow.includes(RP_INITIATIVE));
  assert.match(shadow, /in a scene with several NPCs, not every one needs a beat/);
  assert.match(shadow, /when a character has neither, start from what the scene shows of them and invent no motive/);
  assert.ok(shadow.includes(SHADOW_LINE));
  assert.ok(character.includes(DEFINITION), 'Character AIDE reads the same definition');
  assert.ok(character.includes(CHARACTER_LINE));
  assertNoRetiredWording(shadow + character);
});

test('RP scene staging keeps the definition but adds no initiative', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wire(f);
  await run(f, { writing_mode: 'rp', rp_impersonation_scope: 'persona_cast' });
  const all = shadowText(f) + characterText(f);
  assert.ok(all.includes(DEFINITION));
  assert.ok(!all.includes('PROFILE-DRIVEN INITIATIVE'));
  assert.ok(!all.includes(SHADOW_LINE));
  assert.ok(!all.includes(CHARACTER_LINE));
});

test('Novel gives the whole cast profile-driven initiative', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  wire(f);
  await run(f, { writing_mode: 'novel' });
  const shadow = shadowText(f);
  assert.ok(shadow.includes(DEFINITION));
  assert.ok(shadow.includes(NOVEL_INITIATIVE));
  assert.match(shadow, /invent no motive a character lacks/);
  assert.ok(shadow.includes(SHADOW_LINE));
  assert.ok(characterText(f).includes(CHARACTER_LINE));
  assertNoRetiredWording(shadow + characterText(f));
});
