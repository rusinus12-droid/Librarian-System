'use strict';

// A group or world card ("클로젬 여행동아리") names a cast, not a character. 2026-11-18: with
// such a card, NPC disposition listed the card as the one person in the scene; the same rule fed
// 억결's automatic bonds (the persona bound to the card itself) and 상태's cast (a body report for
// the card). People now come from the scene, and the card counts only when it names a person.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const allOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const wireModel = f => {
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '천소연이 창밖을 보았다.';
  };
};

const groupFixture = async t => {
  const chat = { id: 'h', message: [
    { role: 'user', chatId: 'u1', data: '동아리방 문을 연다.' },
    { role: 'assistant', chatId: 'a1', data: '천소연이 창가에 기대 선 채 고개만 돌렸다.' }
  ] };
  const character = { chaId: 'c', name: '클로젬 여행동아리', chats: [chat], chatPage: 0, lorebook: [
    { key: '천소연', comment: '천소연', content: '천소연: 여행동아리 부원. 말수가 적고 경계심이 강하다.', mode: 'normal', insertorder: 100, alwaysActive: true }
  ] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f);
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true,
    enable_plot_aide: true, enable_forced_bond_aide: true, enable_body_state_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots,
    aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: true },
    aide_body_state: { ...(slots.aide_body_state || {}), enabled: true } });
  return f;
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

test('억결 binds the persona to the person in the scene, not to a group card', async t => {
  const f = await groupFixture(t);
  await runTurn(f, '천소연에게 말을 건다.');
  const plot = allOf(f.prompts.find(body => stageOf(body) === 'aide_plot'));
  assert.match(plot, /- auto-1: the user persona → 천소연/);
  assert.doesNotMatch(plot, /→ 클로젬 여행동아리/);
});

test('상태 reports on the person in the scene, not on a group card', async t => {
  const f = await groupFixture(t);
  await runTurn(f, '천소연에게 말을 건다.');
  const character = allOf(f.prompts.find(body => stageOf(body) === 'aide_character'));
  assert.match(character, /BODY STATE PACKET:[\s\S]*- 천소연:/);
  assert.doesNotMatch(character, /- 클로젬 여행동아리:/);
});
