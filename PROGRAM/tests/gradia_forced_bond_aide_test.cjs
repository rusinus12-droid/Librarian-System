'use strict';

// 억결 AIDE (aide_forced_bond): relationship tension inside GRADIA's design.
// Design record: docs/gradia/FORCED-BOND-AIDE-DESIGN-20261114.md

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';
const callStages = f => f.prompts.map(stageOf);

// Answers every call: drafts as plain text, analysis/patch as JSON for the stage that asked.
// stageExtras adds stage-specific top-level fields (bond_check, bond_readings, ...).
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

const BASE = {
  mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
  multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true,
  enable_plot_aide: true, enable_forced_bond_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'
};

const configure = async (f, settings = {}, bondEnabled = true) => {
  await f.host.plugin.saveRuntimeSettings({ ...await f.host.plugin.getRuntimeSettings(), ...BASE, ...settings });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: bondEnabled } });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

// The fixture chat names 준호 in the last scene; the card makes the persona's bond with him love-hate.
const withCards = async (f, settings = {}, cards = [{ id: 'bond-junho', from: '@persona', to: '준호', tones: ['hatred', 'affection'], stage: 'tension', direction: 'mutual' }]) => {
  await configure(f, settings);
  await runTurn(f, '문 앞을 둘러본다.');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  assert.ok(scopeKey, 'a run records the current character+chat key');
  await configure(f, { ...settings, forced_bond_cards: JSON.stringify({ [scopeKey]: cards }) });
  return scopeKey;
};

test('억결 is off by default and adds no call', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에서 조용히 고개를 끄덕였다.');
  await configure(f, {}, false);
  await runTurn(f, '문을 연다.');
  assert.deepEqual(callStages(f).filter(Boolean).filter(stage => stage === 'aide_forced_bond'), []);
  assert.equal(f.prompts.length, 4, 'shadow + three AIDEs');
});

// User decision 2026-11-17: 억결 is a sub-AIDE of 플롯 AIDE and settles its readings in Plot's call.
test('억결 rides in Plot AIDE’s call in every AIDE order and spends no call of its own', async t => {
  for (const order of [
    ['aide_character', 'aide_world', 'aide_plot'],
    ['aide_plot', 'aide_character', 'aide_world'],
    ['aide_world', 'aide_plot', 'aide_character']
  ]) {
    const f = await fixture(t, { writingMode: 'rp', unified: false });
    wireModel(f, '복도 끝에서 발소리가 멎었다.');
    await configure(f, { aide_stage_order: JSON.stringify(order) });
    await runTurn(f, '복도로 나간다.');
    const aideStages = callStages(f).filter(stage => stage.startsWith('aide_'));
    assert.deepEqual(aideStages, order, JSON.stringify(order));
    const plot = f.prompts.find(body => stageOf(body) === 'aide_plot');
    assert.match(systemOf(plot), /억결 AIDE runs inside this stage as a sub-step. Forced Bond AIDE: read the verification notes/);
    assert.ok(JSON.stringify(plot).includes('"bond_readings"'), 'Plot settles the bond readings');
  }
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '복도 끝에서 발소리가 멎었다.');
  await configure(f, { multi_pipeline_mode: 'heavyweight' });
  await runTurn(f, '복도로 나간다.');
  assert.equal(callStages(f).filter(stage => stage === 'aide_forced_bond').length, 0, 'heavyweight: still no call of its own');
  assert.equal(callStages(f).filter(stage => stage === 'aide_plot').length, 2, 'heavyweight: Plot keeps its analysis + patch');
});

test('RP prose mode skips 억결; scene-staging mode runs it without arrivals or invented acts', async t => {
  const prose = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(prose, '민아는 문 앞에 섰다.');
  await withCards(prose, { rp_impersonation_scope: 'all' });
  await runTurn(prose, '문을 연다.');
  assert.ok(!callStages(prose).includes('aide_forced_bond'), 'prose mode: no 억결 call');
  assert.ok(prose.prompts.every(body => !systemOf(body).includes('[FORCED BOND')), 'prose mode: no bond block anywhere');

  const staging = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(staging, '민아는 문 앞에 섰다.');
  await withCards(staging, { rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging, '문을 연다.');
  const bondPrompt = staging.prompts.find(body => stageOf(body) === 'aide_plot');
  assert.ok(bondPrompt && systemOf(bondPrompt).includes('억결 AIDE runs inside this stage'), 'staging mode still runs 억결');
  const sys = systemOf(bondPrompt);
  assert.match(sys, /Scene-staging RP mode/);
  assert.match(sys, /Do not bring an absent character into the scene for a bond/);
  assert.doesNotMatch(sys, /bring them in early or mid-scene/);
});

test('cards are per chat and reach every stage with mode rules, accuracy rules and recent-scene evidence', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await withCards(f);
  await runTurn(f, '준호를 지나쳐 간다.');
  for (const stage of ['shadow_act', 'aide_character', 'aide_world', 'aide_plot']) {
    const body = f.prompts.find(item => (stage === 'shadow_act' ? !stageOf(item) || stageOf(item) === 'shadow_act' : stageOf(item) === stage));
    assert.ok(body, stage + ' was called');
    // SHADOW carries stage guidance in its user message; the AIDEs in the system prompt.
    const sys = body.messages.map(m => m.content).join('\n');
    assert.match(sys, /\[FORCED BOND/, stage + ' gets the bond block');
    assert.match(sys, /bond-junho: the user persona → 준호 \(mutual\) · tones: hatred, affection/, stage);
    assert.match(sys, /recent signals only|recent scene signals only/, stage + ' says LIB evidence is absent');
    assert.match(sys, /recent scene: .*준호/, stage + ' carries the recent line naming 준호');
    assert.match(sys, /only the non-persona side of a bond/, stage + ' RP rule');
    assert.match(sys, /Never invent a shared past/, stage + ' accuracy rule');
  }
  assert.match(systemOf(f.prompts.find(item => stageOf(item) === 'aide_world')), /STAGE DUTY: World AIDE: check who is present, who could witness/);

  const novel = await fixture(t, { writingMode: 'novel', unified: false });
  wireModel(novel, '준호가 문 앞에서 기다렸다.');
  await withCards(novel, { writing_mode: 'novel' });
  await runTurn(novel, '준호를 지나쳐 간다.');
  assert.match(systemOf(novel.prompts.find(item => stageOf(item) === 'aide_plot')), /Novel mode: both sides of a bond/);

  const other = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(other, '민아는 문 앞에 섰다.');
  await configure(other, { forced_bond_cards: JSON.stringify({ 'some-other-chat': [{ to: '준호', tones: ['hatred'] }] }) });
  await runTurn(other, '문을 연다.');
  // Another chat's cards do not apply here; with no card of its own the chat gets auto bonds.
  const otherBond = systemOf(other.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.doesNotMatch(otherBond, /tones: hatred/);
  assert.match(otherBond, /- auto-1: the user persona → 민아 \(mutual\) · tones: read from canon, lore and the scene \(auto bond, no user card\)/);
});

test('with no card, 억결 binds scene people and asks for a beat only when the scene gives it an opening', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await configure(f);
  await runTurn(f, '준호를 지나쳐 간다.');
  const bond = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(bond, /- auto-1: the user persona → 민아/, 'the character card person is bound first');
  assert.match(bond, /When there is a natural opening this turn, show one visible beat that forms or moves the main bond/);
  assert.match(bond, /If the user closes or explicitly excludes a relationship thread, keep it out of the scene/);
  assert.match(bond, /Auto bonds: no user card exists, so read each bond’s tone/);
  assert.match(bond, /If the scene gives the main bond a natural opening and its beat is missing, add one/);
  assert.match(bond, /if the scene gives the main bond a natural opening and its beat is missing|do not add a beat or recruit a substitute bond/i);
  assert.match(bond, /return empty bond_readings and bond_profiles/);
  assert.match(systemOf(f.prompts.find(item => stageOf(item) === 'aide_character')), /\[FORCED BOND/, 'checkers get the bond block for auto bonds');
  assert.match(systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot')), /Keep earned bond beats that respect the user’s focus, player agency and causality/);
  assert.match(f.prompts.find(item => !stageOf(item)).messages.map(m => m.content).join('\n'), /Write one visible beat early or mid-scene/, 'SHADOW plans the beat');

  const off = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(off, '민아는 문 앞에 섰다.');
  await configure(off, { forced_bond_auto: false });
  await runTurn(off, '문을 연다.');
  assert.match(systemOf(off.prompts.find(item => stageOf(item) === 'aide_plot')), /BONDS: no user card and no other person in the scene this turn/);
  assert.ok(!systemOf(off.prompts.find(item => stageOf(item) === 'aide_character')).includes('[FORCED BOND'), 'auto off: no bond block for checkers');
});

test('bond evidence matches any alias of a person through the continuity index', async t => {
  const chat = { id: 'h', message: [{ role: 'user', chatId: 'u1', data: '문을 두드린다.' }, { role: 'assistant', chatId: 'a1', data: '민아는 얼굴을 붉히며 시선을 피했다.' }] };
  const character = { chaId: 'c', name: 'Minah Kim', nickname: '민아', chats: [chat], chatPage: 0, lorebook: [] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f, '민아는 다시 고개를 들었다.');
  await configure(f);
  await runTurn(f, '민아를 바라본다.');
  const bond = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(bond, /- auto-1: the user persona → Minah Kim/);
  assert.match(bond, /recent scene: 민아는 얼굴을 붉히며 시선을 피했다\./, 'a line naming the Korean alias counts for Minah Kim');
});

test('lightweight AIDEs return bond_check through the schema and 억결 reads the earlier checks', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.', {
    aide_character: { bond_check: [{ card: 'bond-junho', verdict: 'adjust', claim: '준호 is jealous of the persona and 세라', reason: '준호 never saw them together', evidence: 'recent' }] }
  });
  await withCards(f);
  await runTurn(f, '준호를 지나쳐 간다.');
  const character = f.prompts.find(item => stageOf(item) === 'aide_character');
  assert.ok(JSON.stringify(character).includes('"bond_check"'), 'the patch schema asks for bond_check when 억결 is active');
  const bond = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(bond, /VERIFICATION NOTES FROM EARLIER STAGES/);
  assert.match(bond, /\[aide_character\] bond-junho: adjust — 준호 is jealous of the persona and 세라 \(because 준호 never saw them together; evidence: recent\)/);
  assert.ok(!JSON.stringify(f.prompts.find(item => stageOf(item) === 'aide_plot')).includes('"bond_check"'), 'the host settles readings instead of checking');
});

test('readings stay in memory for the GUI, no AI proposals schema or storage exists', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.', {
    aide_plot: {
      bond_readings: [{ card: 'bond-junho', tones: ['hatred', 'longing'], stage: 'expressed', evidence: 'recent' }]
    }
  });
  await withCards(f);
  const keysBefore = new Set(f.values.keys());
  await runTurn(f, '준호를 지나쳐 간다.');
  const plotPrompt = f.prompts.find(item => stageOf(item) === 'aide_plot');
  assert.ok(!JSON.stringify(plotPrompt).includes('"bond_proposals"'), 'bond_proposals is removed from the schema and prompt');
  const state = f.host.plugin.debugForcedBondState();
  assert.deepEqual(JSON.parse(JSON.stringify(state.readings.readings)), [{ card: 'bond-junho', tones: ['hatred', 'longing'], stage: 'expressed', evidence: 'recent' }]);
  assert.equal(state.proposals, undefined, 'no AI proposals list in state');
  const newKeys = [...f.values.keys()].filter(key => !keysBefore.has(key));
  assert.deepEqual(newKeys.filter(key => /bond|reading|proposal/i.test(key)), [], 'no bond state is persisted');
});

test('the 이 채팅 page edits 억결 cards without an AI proposals section', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  const scopeKey = await withCards(f, {}, []);
  await runTurn(f, '준호를 지나쳐 간다.');
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  assert.ok(f.document.querySelector('.stage-detail[data-detail="forced_bond"] [data-go="chat"][data-go-sub="bond"]'), 'the 억결 panel points to the 이 채팅 page');
  await f.host.plugin.debugNavigateGui('chat');
  const panel = f.document.querySelector('section[data-page="chat"] [data-chat-section="bond"]');
  assert.equal(panel.querySelector('[data-forced-bond-proposals]'), null, 'AI-proposed relationship section is removed');
  assert.ok(panel.querySelector('[data-forced-bond-cards] .empty'), 'empty state before any card');
  panel.querySelector('[data-forced-bond-action="add"]').click();
  const to = panel.querySelector('[data-forced-bond-card-field="to"]');
  to.value = '세라';
  to.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  await f.wait(() => panel.querySelector('[data-forced-bond-card-field="to"]')?.value === '세라', 'card name kept');
  const hatred = panel.querySelector('[data-forced-bond-card-field="tone"][data-tone="hatred"]');
  hatred.checked = true;
  hatred.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  const stored = JSON.parse((await f.host.plugin.getRuntimeSettings()).forced_bond_cards);
  const cards = stored[scopeKey];
  assert.equal(cards.length, 1);
  assert.equal(cards[0].to, '세라');
  assert.deepEqual(cards[0].tones, ['hatred'], 'a new card has no default tone');
  assert.deepEqual(Object.keys(stored), [scopeKey], 'cards are stored only for this chat');
});

test('the 억결 panel opens its own prompt preview instead of SHADOW', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const detail = f.document.querySelector('.stage-detail[data-detail="forced_bond"]');
  assert.ok(detail, 'the pipeline page renders the 억결 panel');
  detail.querySelector('[data-action="prompt-preview"]').click();
  const title = () => f.document.querySelector('.dialog h2, .dialog [class*="title"]')?.textContent || '';
  await f.wait(() => title().includes('프롬프트 미리보기'), 'prompt preview dialog');
  assert.match(title(), /억결 AIDE/);
});

test('per-chat key follows the current character+chat', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f);
  await runTurn(f, '문을 연다.');
  const first = f.host.plugin.debugActiveScopeKey();
  assert.match(first, /\S/);
  await runTurn(f, '다시 문을 연다.');
  assert.equal(f.host.plugin.debugActiveScopeKey(), first, 'same chat, same key');
});

test('the evidence packet puts canon, LIB and recent lines under each bond, and marks missing LIB evidence', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const recent = {
    visibleMessages: [
      { role: 'assistant', content: '세라는 리안을 노려보았다. 준호는 창밖만 보았다.' },
      { role: 'user', content: '세라에게 말을 건다.' }
    ],
    relationshipCanonLock: { facts: [{ text: '세라와 리안은 쌍둥이 자매다.' }, { text: '준호는 마을 대장장이다.' }] }
  };
  const cards = [
    { id: 'persona-sera', to: '세라', tones: ['longing'] },
    { id: 'sera-lian', from: '세라', to: '리안', tones: ['rivalry', 'jealousy'], direction: 'mutual' }
  ];
  const withLib = f.host.plugin.debugForcedBondEvidencePacket({ recent, cards, libText: '세라는 페르소나와 헤어진 날을 아직 기억한다.\n리안은 세라의 약혼을 질투했다. 세라도 알고 있었다.' });
  assert.match(withLib, /^User direction this turn \(current input\): \(none\)\nEvidence source: LIB memory and recent scene\./);
  assert.match(withLib, /- persona-sera: the user persona → 세라 \(one-way\) · tones: longing/);
  assert.match(withLib, /LIB: 세라는 페르소나와 헤어진 날을 아직 기억한다\./);
  assert.match(withLib, /canon: 세라와 리안은 쌍둥이 자매다\./, 'NPC bond carries the canon fact naming both');
  assert.match(withLib, /LIB: 리안은 세라의 약혼을 질투했다\./);
  assert.doesNotMatch(withLib.split('- sera-lian')[1], /준호/, 'lines naming only one NPC of an NPC bond are not evidence for it');
  assert.match(withLib, /recent input: 세라에게 말을 건다\./);

  const noLib = f.host.plugin.debugForcedBondEvidencePacket({ recent: { visibleMessages: [] }, cards: [{ id: 'x', to: '미하', tones: ['guilt'] }] });
  assert.match(noLib, /recent scene signals only \(no LIB evidence/);
  assert.match(noLib, /no evidence found for this bond; only the card applies/);
});

test('억결 forms and moves relationships from recent emotional signals instead of steering to romance', async t => {
  const chat = { id: 'h', message: [
    { role: 'user', chatId: 'u1', data: '민아에게 길을 묻는다.' },
    { role: 'assistant', chatId: 'a1', data: '민아는 시선을 피하며 짧게 대답했다. 잠시 후 민아는 작게 미소를 지었다.' }
  ] };
  const character = { chaId: 'c', name: '민아', chats: [chat], chatPage: 0, lorebook: [] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f, '민아는 지도를 건넸다.');
  await configure(f);
  await runTurn(f, '고맙다고 말한다.');
  const bond = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(bond, /keep forming and moving the relationships below/);
  assert.match(bond, /do not steer a bond toward romance unless the user or what has developed already points there/);
  assert.match(bond, /recent emotional signals \(oldest → newest\): avoidance \("민아는 시선을 피하며 짧게 대답했다\."\) → warmth \("잠시 후 민아는 작게 미소를 지었다\."\)/);
  assert.match(bond, /the main bond’s beat grows out of its latest emotional signal/);
  assert.match(bond, /trust → relying on the other with something that matters/, 'relational tones are offered for auto bonds');
  assert.doesNotMatch(bond, /tones: affection/, 'nothing defaults to affection');
});

test('a bond follows the user’s direction and the story, never gender, and lore is background', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.');
  await withCards(f);
  await runTurn(f, '준호에게 오늘은 친구로서 이야기하자고 말한다.');
  const bond = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(bond, /Gender never decides a bond\. Different genders do not imply romance, and the same gender does not rule it out\./);
  assert.match(bond, /WHAT DECIDES A BOND’S DIRECTION, in order: \(1\) the user’s direction/);
  assert.match(bond, /Lore describing a character’s feelings or preferences is background, not a script/);
  assert.match(bond, /NARRATIVE: move each bond along its own arc in this story/);
  assert.match(bond, /User direction this turn \(current input\): 준호에게 오늘은 친구로서 이야기하자고 말한다\./);
});

test('a bond profile from the host becomes a stored lore card that replaces auto-1 on later turns and nothing overwrites', async t => {
  const LORE_CARDS_KEY = 'serial_gradation_agents_for_rp:lore_cards:v1';
  const storedBondCards = f => {
    const raw = f.values.get(LORE_CARDS_KEY) ?? f.local.get(LORE_CARDS_KEY);
    if (!raw) return {};
    return (typeof raw === 'string' ? JSON.parse(raw) : raw).cards?.forcedBond || {};
  };
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호가 문 앞에서 기다렸다.', {
    aide_plot: {
      bond_readings: [],
      bond_profiles: [
        { from: '@persona', to: '준호', direction: 'mutual', tones: ['wariness', 'curiosity'], stage: 'tension', visibility: 'hidden', pressure: 'situational', limits: [], basis: '경쟁 가문 출신이자 서로 의식하는 사이(캐릭터 로어).' }
      ]
    }
  });
  await configure(f);
  await runTurn(f, '준호에게 말을 건다.');
  const cards = Object.values(storedBondCards(f)).flat();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].from, '@persona');
  assert.equal(cards[0].to, '준호');
  assert.deepEqual(cards[0].tones, ['wariness', 'curiosity']);
  assert.equal(cards[0].stage, 'tension');
  assert.equal(cards[0].origin, 'lore');

  f.chat.message.push({ role: 'assistant', chatId: 'a2', data: '준호가 문 앞에서 기다렸다.' });
  wireModel(f, '준호가 고개를 돌렸다.', {
    aide_plot: {
      bond_readings: [],
      bond_profiles: [
        { from: '@persona', to: '준호', direction: 'mutual', tones: ['affection'], stage: 'settled', visibility: 'known', pressure: 'explicit', limits: [], basis: '덮어쓰기 시도' }
      ]
    }
  });
  await runTurn(f, '준호를 바라본다.');
  const plotSys = systemOf(f.prompts.find(item => stageOf(item) === 'aide_plot'));
  assert.match(plotSys, /the user persona → 준호 \(mutual\) · tones: wariness, curiosity · card stage: tension/);
  assert.doesNotMatch(plotSys, /- auto-1:/, 'the saved lore card replaces temporary auto-1');
  const after = Object.values(storedBondCards(f)).flat();
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].tones, ['wariness', 'curiosity']);
});
