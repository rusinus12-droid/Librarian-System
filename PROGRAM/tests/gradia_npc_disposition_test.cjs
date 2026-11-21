'use strict';

// NPC 반응 경향성 (NPC disposition): the user fixes how NPCs are disposed toward the persona,
// per chat, as a default for every NPC plus per-NPC overrides. Lore decides how a stance shows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const allOf = body => body.messages.map(m => m.content).join('\n');
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

const BASE = {
  mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
  multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true,
  enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'
};

const configure = async (f, settings = {}) => {
  await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings(), ...BASE, ...settings });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  return await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

const DISPOSITION = {
  default: 'dislike',
  npcs: [{ id: 'npc-junho', name: '준호', level: 'hostile', note: '페르소나를 가문의 원수로 여긴다' }]
};

// The fixture chat names 준호 in the last scene; 민아 is the character card.
const withDisposition = async (f, settings = {}, entry = DISPOSITION) => {
  await configure(f, settings);
  await runTurn(f, '문 앞을 둘러본다.');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  assert.ok(scopeKey, 'a run records the current character+chat key');
  await configure(f, { ...settings, npc_disposition: JSON.stringify({ [scopeKey]: entry }) });
  return scopeKey;
};

test('no disposition: no block anywhere and the same calls', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await configure(f);
  await runTurn(f, '준호에게 꽃을 건넨다.');
  assert.equal(f.prompts.length, 4, 'shadow + three AIDEs');
  assert.ok(f.prompts.every(body => !allOf(body).includes('[NPC DISPOSITION')), 'no disposition block');
});

test('a disposition reaches every draft stage with its levels, rows, duties and rules, and spends no call', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await withDisposition(f);
  await runTurn(f, '준호에게 꽃을 건넨다.');
  assert.equal(f.prompts.length, 4, 'no extra model call');
  for (const stage of ['shadow_act', 'aide_character', 'aide_world', 'aide_plot']) {
    const body = f.prompts.find(item => (stage === 'shadow_act' ? !stageOf(item) || stageOf(item) === 'shadow_act' : stageOf(item) === stage));
    assert.ok(body, stage + ' was called');
    const all = allOf(body);
    assert.match(all, /\[NPC DISPOSITION \(반응 경향성\) — USER-FIXED STANCE TOWARD THE PERSONA\]/, stage);
    assert.match(all, /- 준호: hostile \(적대\) · in the scene now · user note: 페르소나를 가문의 원수로 여긴다/, stage + ' row');
    assert.match(all, /- Every other NPC: dislike \(비호감\) by default · in the scene now: 민아/, stage + ' default covers 민아');
    assert.match(all, /- hostile \(적대\): strong pole — wants the persona diminished, gone, or defeated/, stage + ' hostile level');
    assert.match(all, /- dislike \(비호감\): restrained negative — wants distance and minimal contact/, stage + ' dislike level');
    assert.doesNotMatch(all, /- affection \(애정\):/, stage + ' only levels in use');
    assert.doesNotMatch(all, /flower|grinds it underfoot|drops it in the trash|a reserved character shows hostility|hot-tempered one as an outburst|schemer as a calculated/i, stage + ' no flower example or fixed personality formula');
    assert.match(all, /never softens a hostile or disliking NPC/, stage + ' no drift');
    assert.match(all, /HOW TO BUILD EACH NPC’S RESPONSE FROM LORE:[\s\S]*\(1\) find in the lore[\s\S]*\(2\) judge what the persona’s just-made move means[\s\S]*\(3\) craft a concrete response/, stage + ' step-by-step lore draft procedure');
    assert.match(all, /NO STOCK REACTIONS:[\s\S]*Two NPCs with the same disposition must not react in the same way/, stage + ' forbids stock reactions and identical NPC responses');
    assert.match(all, /the disposition wins for the attitude/, stage + ' lore conflict');
    assert.match(all, /RP mode: only the NPC side gets new acts/, stage + ' RP rule');
  }
  const duty = stage => allOf(f.prompts.find(item => stageOf(item) === stage)).match(/STAGE DUTY: ([^\n]+)/g).join('\n');
  assert.match(duty('aide_character'), /Character AIDE: check every NPC with a disposition/);
  assert.match(duty('aide_character'), /generic or stock — something that could fit any character with the same disposition/);
  assert.match(duty('aide_world'), /World AIDE: check that the form each stance takes/);
  assert.match(duty('aide_plot'), /Plot AIDE: check that no disposition softened/);
});

test('the final pass carries a short guard so polishing does not drift back to the lore default', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 꽃을 낚아채 바닥에 짓밟았다.');
  await withDisposition(f);
  const out = await runTurn(f, '준호에게 꽃을 건넨다.');
  const injected = JSON.stringify(out);
  assert.match(injected, /\[NPC DISPOSITION GUARD\]/);
  assert.match(injected, /- 준호: hostile \(적대\)/);
  assert.match(injected, /- Every other NPC: dislike \(비호감\)/);

  const plain = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(plain, '준호가 꽃을 받았다.');
  await configure(plain);
  const plainOut = await runTurn(plain, '준호에게 꽃을 건넨다.');
  assert.doesNotMatch(JSON.stringify(plainOut), /NPC DISPOSITION GUARD/);
});

test('writing modes: novel keeps the persona free, staging only colors stated acts, prose skips', async t => {
  const novel = await fixture(t, { writingMode: 'novel', unified: false });
  wireModel(novel, '준호가 문 앞에서 기다렸다.');
  await withDisposition(novel, { writing_mode: 'novel' });
  await runTurn(novel, '준호에게 꽃을 건넨다.');
  assert.match(systemOf(novel.prompts.find(item => stageOf(item) === 'aide_plot')), /Novel mode: the disposition governs the NPCs’ side only/);

  const staging = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(staging, '준호가 문 앞에서 기다렸다.');
  await withDisposition(staging, { rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging, '준호에게 꽃을 건넨다. 준호는 꽃을 받는다.');
  const stagingSys = systemOf(staging.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(stagingSys, /Scene-staging RP mode: every character’s acts and lines belong to the user/);
  assert.doesNotMatch(stagingSys, /RP mode: only the NPC side gets new acts/);

  const prose = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(prose, '준호가 문 앞에서 기다렸다.');
  await withDisposition(prose, { rp_impersonation_scope: 'all' });
  await runTurn(prose, '준호에게 꽃을 건넨다.');
  assert.ok(prose.prompts.every(body => !allOf(body).includes('NPC DISPOSITION')), 'prose mode: no disposition anywhere');
});

test('dispositions are per chat, a default alone applies, and Korean level labels are accepted', async t => {
  const other = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(other, '민아는 문 앞에 섰다.');
  await configure(other, { npc_disposition: JSON.stringify({ 'some-other-chat': DISPOSITION }) });
  await runTurn(other, '문을 연다.');
  assert.ok(other.prompts.every(body => !allOf(body).includes('[NPC DISPOSITION')), 'another chat’s setting does not apply');

  const only = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(only, '민아는 문 앞에 섰다.');
  await withDisposition(only, {}, { default: '애정', npcs: [{ name: '준호', level: '' }, { name: '', level: 'hostile' }] });
  await runTurn(only, '민아에게 꽃을 건넨다.');
  const all = allOf(only.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(all, /- Every other NPC: affection \(애정\) by default/);
  assert.match(all, /- affection \(애정\): strong pole — deeply attached/);
  assert.doesNotMatch(all, /- 준호: /, 'a row without a level is not used');
  assert.doesNotMatch(all, /hostile \(적대\)/, 'a row without a name is not used');
});

test('with Forced Bond active the disposition keeps the direction and the bond only adds tension', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await withDisposition(f, { enable_forced_bond_aide: true });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: true } });
  await runTurn(f, '준호에게 꽃을 건넨다.');
  const plot = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(plot, /\[FORCED BOND/);
  assert.match(plot, /With Forced Bond \(억결\) active: the disposition sets the direction/);
});

test('the 이 채팅 page edits the default and per-NPC dispositions for this chat only', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await configure(f);
  await runTurn(f, '문 앞을 둘러본다.');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  // 2026-11-18: the disposition applies to the whole chat, so it lives on the 이 채팅 page; the
  // Character AIDE panel keeps only a pointer to it.
  const pointer = f.document.querySelector('.stage-detail[data-detail="char"] [data-go="chat"][data-go-sub="disposition"]');
  assert.ok(pointer, 'the Character AIDE panel points to the 이 채팅 page');
  assert.equal(f.document.querySelector('.stage-detail[data-detail="char"] [data-npc-disposition-panel]'), null, 'no disposition editor inside the stage panel');
  await f.host.plugin.debugNavigateGui('chat');
  const panel = f.document.querySelector('section[data-page="chat"] [data-npc-disposition-panel]');
  assert.ok(panel, 'the 이 채팅 page has the disposition panel');
  assert.ok(panel.querySelector('[data-npc-disposition-list] .empty'), 'empty state before any row');
  const levels = [...panel.querySelectorAll('[data-npc-disposition-field="default"] option')].map(node => node.textContent);
  assert.deepEqual(levels, ['로어 그대로 (미지정)', '적대', '비호감', '아는 사이', '호감', '애정']);
  const fire = node => node.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  const def = panel.querySelector('[data-npc-disposition-field="default"]');
  def.value = 'acquaintance';
  fire(def);
  await f.wait(() => panel.querySelector('[data-npc-disposition-field="default"]')?.value === 'acquaintance', 'default kept');
  panel.querySelector('[data-npc-disposition-action="add"]').click();
  const name = await f.wait(() => panel.querySelector('[data-npc-disposition-field="name"]'), 'row added');
  name.value = '준호';
  fire(name);
  await f.wait(() => panel.querySelector('[data-npc-disposition-field="name"]')?.value === '준호', 'name kept');
  const level = panel.querySelector('[data-npc-disposition-field="level"]');
  level.value = 'hostile';
  fire(level);
  await f.wait(() => panel.querySelector('[data-npc-disposition-field="level"]')?.value === 'hostile', 'level kept');
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  const stored = JSON.parse((await f.host.plugin.getRuntimeSettings()).npc_disposition);
  assert.deepEqual(Object.keys(stored), [scopeKey], 'stored only for this chat');
  assert.equal(stored[scopeKey].default, 'acquaintance');
  assert.equal(stored[scopeKey].npcs.length, 1);
  assert.equal(stored[scopeKey].npcs[0].name, '준호');
  assert.equal(stored[scopeKey].npcs[0].level, 'hostile');

  panel.querySelector('[data-npc-disposition-action="remove"]').click();
  await f.wait(() => panel.querySelector('[data-npc-disposition-list] .empty'), 'row removed');
});

// Regression (2026-11-18 log): with no extension AIDE on, the run built no alias index, so a
// default-only disposition listed the group card's name as the one person in the scene and the
// member actually present got no stance. The index now follows the disposition itself.
test('a default-only disposition names the people in the scene, not a group card, with no extension AIDE on', async t => {
  const chat = { id: 'h', message: [
    { role: 'user', chatId: 'u1', data: '동아리방 문을 연다.' },
    { role: 'assistant', chatId: 'a1', data: '천소연이 창가에 기대 선 채 고개만 돌렸다.' }
  ] };
  const character = { chaId: 'c', name: '클로젬 여행동아리', chats: [chat], chatPage: 0, lorebook: [
    { key: '천소연', comment: '천소연', content: '천소연: 여행동아리 부원. 말수가 적고 경계심이 강하다.', mode: 'normal', insertorder: 100, alwaysActive: true }
  ] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f, '천소연이 창밖을 보았다.');
  await withDisposition(f, {}, { default: 'hostile', npcs: [] });
  await runTurn(f, '천소연에게 말을 건다.');
  const body = f.prompts.find(item => stageOf(item) === 'aide_character');
  assert.ok(body, 'character AIDE was called');
  const all = allOf(body);
  assert.match(all, /- Every other NPC: hostile \(적대\) by default · in the scene now: 천소연\./);
  assert.doesNotMatch(all, /in the scene now:[^\n]*클로젬 여행동아리/);
  assert.match(all, /WHAT IT IS, AND WHAT IT IS NOT: the disposition is a bias in how the NPC reads and receives the persona/);
});

test('a disposition profile from 인물 AIDE becomes a stored lore card that activates disposition guidance on later turns and nothing overwrites', async t => {
  const LORE_CARDS_KEY = 'serial_gradation_agents_for_rp:lore_cards:v1';
  const storedDispCards = f => {
    const raw = f.values.get(LORE_CARDS_KEY) ?? f.local.get(LORE_CARDS_KEY);
    if (!raw) return {};
    return (typeof raw === 'string' ? JSON.parse(raw) : raw).cards?.npcDisposition || {};
  };
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const extra = stage === 'aide_character'
      ? { disposition_profiles: [{ name: '준호', level: 'dislike', note: '낯선 이에게 거리를 두고 경계한다', basis: '가문을 지키는 보수적 성격(캐릭터 로어).' }] }
      : {};
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...extra };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '준호가 문 앞에서 차갑게 시선을 두었다.';
  };
  await configure(f);
  await runTurn(f, '준호에게 인사를 건넨다.');
  const turn1Char = f.prompts.find(item => stageOf(item) === 'aide_character');
  assert.ok(!allOf(turn1Char).includes('[NPC DISPOSITION'), 'turn 1 before 인물 AIDE settles the profile has no NPC DISPOSITION block');
  assert.match(allOf(turn1Char), /\[LORE ATTITUDE ESTIMATION\]/);
  const rows = Object.values(storedDispCards(f)).flat();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '준호');
  assert.equal(rows[0].level, 'dislike');
  assert.equal(rows[0].origin, 'lore');

  f.chat.message.push({ role: 'assistant', chatId: 'a2', data: '준호가 문 앞에서 차갑게 시선을 두었다.' });
  // Turn 2 returns a conflicting profile for 준호: the saved lore card must not be overwritten.
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const extra = stage === 'aide_character'
      ? { disposition_profiles: [{ name: '준호', level: 'affection', note: '덮어쓰기 시도', basis: '무시되어야 함' }] }
      : {};
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...extra };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '준호가 반발짝 물러섰다.';
  };
  const out = await runTurn(f, '준호에게 다시 말을 건다.');
  const charPrompt = allOf(f.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(charPrompt, /\[NPC DISPOSITION \(반응 경향성\) — USER-FIXED STANCE TOWARD THE PERSONA\]/);
  assert.match(charPrompt, /- 준호: dislike \(비호감\) · in the scene now · user note: 낯선 이에게 거리를 두고 경계한다/);
  assert.match(JSON.stringify(out), /\[NPC DISPOSITION GUARD\][\s\S]*- 준호: dislike \(비호감\)/);
  const after = Object.values(storedDispCards(f)).flat();
  assert.equal(after.length, 1);
  assert.equal(after[0].level, 'dislike');
});

test('missing present NPCs stay listed under MISSING DISPOSITION CARDS after another NPC has a card, and auto toggle works in GUI', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await configure(f);
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    const extra = stage === 'aide_character'
      ? { disposition_profiles: [{ name: '준호', level: 'dislike', note: '거리 둠', basis: '로어' }] }
      : {};
    const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {}, rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [], ...extra };
    if (sys.includes('serial_gradation_agents_for_rp_analysis_')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
    else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) f.controls.output = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base, edits: [] });
    else f.controls.output = '준호가 고개를 돌렸다.';
  };
  await runTurn(f, '민아와 준호를 함께 본다.');
  // Turn 2: 준호 is covered, while 민아 (character card person) is still missing and listed outside detail-collapse bounds.
  await runTurn(f, '민아에게 인사를 건넨다.');
  const charPrompt = allOf(f.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(charPrompt, /MISSING DISPOSITION CARDS: 민아\./);

  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('chat');
  const toggle = f.document.querySelector('[data-npc-disposition-panel] [data-npc-disposition-field="auto"]');
  assert.ok(toggle && toggle.checked, 'auto disposition card toggle exists and defaults to checked');
  toggle.checked = false;
  toggle.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  assert.equal(String((await f.host.plugin.getRuntimeSettings()).npc_disposition_auto), 'false');
});

test('aide_character patch JSON contract explicitly includes disposition_profiles and accepts nested domain.disposition_profiles', async t => {
  const LORE_CARDS_KEY = 'serial_gradation_agents_for_rp:lore_cards:v1';
  const storedDispCards = f => {
    const raw = f.values.get(LORE_CARDS_KEY) ?? f.local.get(LORE_CARDS_KEY);
    if (!raw) return {};
    return (typeof raw === 'string' ? JSON.parse(raw) : raw).cards?.npcDisposition || {};
  };
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.controls.onModel = (_idx, body) => {
    const sys = systemOf(body);
    const stage = stageOf(body);
    if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      const domain = stage === 'aide_character'
        ? { disposition_profiles: [{ name: '준호', level: 'like', note: '우호적으로 대한다', basis: '로어상 오랜 지인' }] }
        : {};
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage,
        ok: true,
        analysis: { summary: 'checked', constraints: [], risks: [] },
        domain,
        rewrite_directives: [],
        do_not_reveal: [],
        pov_limits: [],
        beats: [],
        edits: []
      });
    } else {
      f.controls.output = '준호가 고개를 끄덕였다.';
    }
  };
  await configure(f);
  await runTurn(f, '준호에게 인사를 건넨다.');

  const charPrompt = systemOf(f.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(charPrompt, /"disposition_profiles":\s*\[\{"name":/);

  const rows = Object.values(storedDispCards(f)).flat();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '준호');
  assert.equal(rows[0].level, 'like');
  assert.equal(rows[0].origin, 'lore');
});
