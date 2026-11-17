'use strict';

// A present character's profile keeps its core sections (user request 2026-11-17). Live run: the
// sheet of the only character in the scene sent just PERSONAL, the passage sharing words with the
// input, and dropped ANCHOR and DIRECTION although the lore budget had room.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const sheet = ['## [Character Sheet: Cheon Hayeon]', '', '### PROFILE', 'Name: Cheon Hayeon (천하연)', 'Age/Gender: 28 F.', 'Occupation: recreation designer who turns onboarding into games and founded the travel club. Older sister of 천소연.', '',
 '### ANCHOR', 'Cheon Hayeon is a languid, foxy dopamine chaser who treats life like a gacha pull: the thrill lives in the second before the result. '.repeat(5), '',
 '### THE LET\'S GO BUTTON', '- Always votes for the wildest option: the island ferry that might be canceled, paragliding, the night drive with no lodging. '.repeat(8), '',
 '### 0.6%', '- Gacha: plays three gacha games and plans her month around banner rotations; claw machines at every rest stop. '.repeat(8), '',
 '### PERSONAL', '- Dating & Intimacy: wants charge, secrecy, risk; turns closeness into a dare (「소리 내면 지는 거다?」); quiet tenderness afterward makes her panic and joke. '.repeat(6), '',
 '### WHY NO MARRIAGE', '- 「평범한 연애? 3개월이면 지루해.」 She and 소연 rarely go home. '.repeat(6), '',
 '### DIRECTION', '- Speech: drawling, teasing 반말 that stretches sentence endings. Play her playful, never cruel. The real danger for her is comfort. '.repeat(4)].join('\n');
test('the sheet of a character in the scene keeps ANCHOR and DIRECTION in every stage', async t => {
  const chat = { id: 'h', message: [{ role: 'user', chatId: 'u1', data: '하연과 방에 남았다.' }, { role: 'assistant', chatId: 'a1', data: '하연은 문 쪽을 힐끗 보고 이불을 끌어올렸다. "소리 내면 지는 거다?"' }] };
  const character = { chaId: 'c', name: 'ClauGem', chats: [chat], chatPage: 0, desc: 'Travel club simulation.', lorebook: [{ key: '하연, 천하연, Hayeon', comment: '천하연', content: sheet, mode: 'normal', insertorder: 100, alwaysActive: false, secondkey: '', selective: false }] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  f.controls.onModel = () => { f.controls.output = '하연은 웃었다.'; };
  await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings(), mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: false, enable_world_aide: false, enable_plot_aide: false, failure_mode: 'hard', lore_activation_mode: 'unified', writing_mode: 'rp' });
  chat.message.push({ role: 'user', chatId: 'u2', data: '문을 잠그고 하연에게 다가가 물었다. "해도 돼? 소리 내면 지는 거야?"' });
  await f.host.hooks.beforeRequest(chat.message.map(r => ({ role: r.role, content: r.data, chatId: r.chatId, messageId: r.chatId })), 'model');
  const shadow = f.prompts.map(b => b.messages.map(m => m.content).join('\n')).join('\n');
  assert.ok(sheet.length > 2800, 'long enough to be split into passages');
  assert.match(shadow, /소리 내면 지는 거다/, 'the passage matching the input is still there');
  assert.match(shadow, /foxy dopamine chaser/, 'ANCHOR travels with the present character');
  assert.match(shadow, /Play her playful, never cruel/, 'and so does DIRECTION');
  assert.ok(shadow.indexOf('foxy dopamine chaser') < shadow.indexOf('never cruel'), 'sections read in the sheet order');
});

test('profile fill adds core sections first, in sheet order, within the cap', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const lore = { comment: '천하연', key: '하연', content: sheet };
  const query = '소리 내면 지는 거야?';
  const plain = f.host.plugin.debugLorePassageEvidence(lore, query, 'shadow_act', 4200, { protected: true });
  const filled = f.host.plugin.debugLorePassageEvidence(lore, query, 'shadow_act', 4200, { protected: true, profileFill: true });
  assert.doesNotMatch(plain.text, /never cruel/, 'without the fill only matching passages come');
  assert.match(filled.text, /never cruel/);
  assert.match(filled.text, /foxy dopamine chaser/);
  assert.match(filled.text, /소리 내면 지는 거다/);
  assert.ok(filled.text.length <= 4200, 'the cap holds');
  const starts = filled.passages.map(p => Number(p.start));
  assert.equal(starts.join(','), [...starts].sort((a, b) => a - b).join(','), 'sheet order');
  const headings = filled.passages.map(p => p.heading).join(' | ');
  assert.match(headings, /ANCHOR/); assert.match(headings, /DIRECTION/); assert.match(headings, /PROFILE/);
});
