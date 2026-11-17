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

const configure = async (f, settings = {}, enabled = { body: true, bond: false }, coreOff = []) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'off',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false,
    enable_plot_aide: true, enable_body_state_aide: enabled.body, enable_forced_bond_aide: enabled.bond,
    failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_body_state: { ...(slots.aide_body_state || {}), enabled: enabled.body }, aide_forced_bond: { ...(slots.aide_forced_bond || {}), enabled: enabled.bond }, ...Object.fromEntries(coreOff.map(id => [id, { ...(slots[id] || {}), enabled: false }])) });
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

// User decision 2026-11-17: 상태 is a sub-AIDE of 인물 AIDE and 억결 of 플롯 AIDE. Each rides in
// its parent's call instead of spending one of its own.
test('상태 rides in 인물 AIDE’s call and 억결 in 플롯 AIDE’s call, with no call of their own', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, { aide_stage_order: JSON.stringify(['aide_plot', 'aide_character', 'aide_world']) }, { body: true, bond: true });
  await runTurn(f, '문을 연다.');
  const aides = f.prompts.map(stageOf).filter(stage => stage.startsWith('aide_'));
  assert.deepEqual(aides, ['aide_plot', 'aide_character', 'aide_world']);
  const character = systemOf(f.prompts.find(body => stageOf(body) === 'aide_character'));
  assert.match(character, /상태 AIDE runs inside this stage as a sub-step\. Body State AIDE: read the verification notes/);
  assert.match(JSON.stringify(f.prompts.find(body => stageOf(body) === 'aide_character')), /"state_readings"/);
  assert.match(systemOf(f.prompts.find(body => stageOf(body) === 'aide_plot')), /억결 AIDE runs inside this stage as a sub-step/);
});

test('a skill chosen for 상태 AIDE reaches 인물 AIDE, the stage that runs it', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, { skill_stage_selections: JSON.stringify({ aide_body_state: ['quiet-interior-beat'] }), skill_router_enabled: 'false' });
  await runTurn(f, '문을 연다.');
  const host = JSON.stringify(f.prompts.find(body => stageOf(body) === 'aide_character'));
  assert.equal(host.split('[COMPILED SKILL — quiet-interior-beat]').length - 1, 1, 'applied once in the host call');
  assert.ok(!JSON.stringify(f.prompts.find(body => stageOf(body) === 'aide_plot')).includes('[COMPILED SKILL — quiet-interior-beat]'), 'not in other stages');
});

test('without its parent a sub-AIDE rides in the last core AIDE that runs, and runs alone only with none', async t => {
  const hosted = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(hosted, '민아는 문 앞에 섰다.');
  await configure(hosted, {}, undefined, ['aide_character', 'aide_world']);
  await runTurn(hosted, '문을 연다.');
  assert.deepEqual(hosted.prompts.map(stageOf).filter(stage => stage.startsWith('aide_')), ['aide_plot']);
  assert.match(systemOf(hosted.prompts.find(body => stageOf(body) === 'aide_plot')), /상태 AIDE runs inside this stage as a sub-step/);

  const alone = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(alone, '민아는 문 앞에 섰다.');
  await configure(alone, {}, undefined, ['aide_character', 'aide_world', 'aide_plot']);
  await runTurn(alone, '문을 연다.');
  assert.deepEqual(alone.prompts.map(stageOf).filter(stage => stage.startsWith('aide_')), ['aide_body_state']);
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
  assert.match(systemOf(staging.prompts.find(body => stageOf(body) === 'aide_character')), /Scene-staging RP mode: add no new condition and no new verdict/);

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
  assert.match(noCycle, /whether this person can conceive is unknown \(no card setting, no profile gender\) — do not decide a pregnancy/);
});

test('checkers return state_check and the host reads it; readings stay in memory', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 다리를 절며 문 앞에 섰다.', {
    aide_plot: { state_check: [{ character: '민아', verdict: 'adjust', claim: '민아 runs to the door', reason: 'her sprained ankle cannot take running' }] },
    aide_character: { state_readings: [{ character: '민아', summary: '발목 염좌 3일째, 절뚝임' }] }
  });
  // Plot runs before the host (인물 AIDE), so Plot leaves a note for it.
  await configure(f, { aide_stage_order: JSON.stringify(['aide_plot', 'aide_character', 'aide_world']) });
  const keysBefore = new Set(f.values.keys());
  await runTurn(f, '민아에게 다가간다.');
  const plot = f.prompts.find(body => stageOf(body) === 'aide_plot');
  assert.ok(JSON.stringify(plot).includes('"state_check"'), 'the patch schema asks for state_check');
  const host = f.prompts.find(item => stageOf(item) === 'aide_character');
  assert.ok(!JSON.stringify(host).includes('"state_check"'), 'the host settles readings instead of checking');
  assert.match(systemOf(host), /\[aide_plot\] 민아: adjust — 민아 runs to the door \(because her sprained ankle cannot take running\)/);
  const newKeys = [...f.values.keys()].filter(key => !keysBefore.has(key));
  assert.deepEqual(newKeys.filter(key => /body|state_read|reading/i.test(key)), [], 'no body state is persisted');
});

test('a hosted 상태 AIDE shows its host call’s status and its own readings, tabbed under 인물', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 다리를 절며 문 앞에 섰다.', { aide_character: { state_readings: [{ character: '민아', summary: '발목 염좌 3일째, 절뚝임' }] } });
  await configure(f);
  await runTurn(f, '민아에게 다가간다.');
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  // No run of its own: the ladder shows the 인물 AIDE call's outcome, without that call's time.
  assert.equal(f.document.querySelector('#lb-body_state').textContent, '성공');
  assert.match(f.document.querySelector('#lb-char').textContent, /^성공/);
  await f.host.plugin.debugNavigateGui('results');
  const panel = f.document.querySelector('[data-subpanel="b"]');
  assert.match(panel.textContent, /성공/);
  assert.match(panel.textContent, /이번 턴 판독[\s\S]*민아[\s\S]*발목 염좌 3일째/);
  assert.match(panel.textContent, /초안과 분석 전체는 인물 AIDE 탭에서 볼 수 있습니다/);
  assert.doesNotMatch(panel.textContent, /실행 기록 없음/);
  const tabs = [...f.document.querySelectorAll('[data-subtabs="rs"] [data-subtab]')].map(tab => tab.dataset.subtab);
  assert.equal(tabs[tabs.indexOf('c') + 1], 'b', tabs.join(' '));
  assert.equal(tabs[tabs.indexOf('p') + 1], 'f', tabs.join(' '));
  assert.ok(f.document.querySelector('[data-subtab="b"]').classList.contains('tab--sub'));
});

test('the 상태 panel turns the stage on, edits per-chat cards, saves the reproduction toggle and shows readings', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 다리를 절며 문 앞에 섰다.', { aide_character: { state_readings: [{ character: '민아', summary: '발목 염좌 3일째, 절뚝임' }] } });
  await configure(f);
  await runTurn(f, '민아에게 다가간다.');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  await configure(f, {}, { body: false, bond: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const panel = f.document.querySelector('.stage-detail[data-detail="body_state"]');
  assert.ok(panel, 'the pipeline page renders the 상태 panel');
  assert.match(panel.querySelector('[data-body-state-readings]').textContent, /민아.*발목 염좌 3일째/, 'last run readings show');
  const change = node => node.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  const toggle = panel.querySelector('#on-s6');
  assert.equal(toggle.checked, false);
  toggle.checked = true; change(toggle);
  const reproduction = panel.querySelector('[data-body-state-field="reproduction"]');
  reproduction.checked = true; change(reproduction);
  panel.querySelector('[data-body-state-action="add"]').click();
  const name = await f.wait(() => panel.querySelector('[data-body-state-card-field="name"]'), 'card editor');
  name.value = '민아'; change(name);
  const cycle = await f.wait(() => panel.querySelector('[data-body-state-card-field="cycleLength"]'), 'cycle field');
  cycle.value = '30'; change(cycle);
  const contraception = await f.wait(() => panel.querySelector('[data-body-state-card-field="contraception"]'), 'contraception field');
  contraception.value = 'pill'; change(contraception);
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  const runtime = await f.host.plugin.getRuntimeSettings();
  assert.equal(String(runtime.body_state_reproduction), 'true');
  const cards = JSON.parse(runtime.body_state_cards)[scopeKey];
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, '민아');
  assert.equal(cards[0].cycleLength, 30);
  assert.equal(cards[0].contraception, 'pill');
  assert.equal((await f.host.plugin.getAgentSlots()).aide_body_state.enabled, true);
});

test('the 상태 panel opens its own prompt preview and sits under 인물 AIDE in the ladder', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const rows = [...f.document.querySelectorAll('#ladder [data-select-row]')].map(node => node.dataset.selectRow);
  assert.equal(rows[rows.indexOf('char') + 1], 'body_state', rows.join(' > '));
  assert.equal(rows[rows.indexOf('plot') + 1], 'forced_bond', rows.join(' > '));
  assert.ok(f.document.querySelector('#ladder [data-select-row="body_state"]').classList.contains('node--sub'));
  assert.match(f.document.querySelector('#ladder [data-select-row="body_state"]').textContent, /인물 AIDE 하위/);
  f.document.querySelector('.stage-detail[data-detail="body_state"] [data-action="prompt-preview"]').click();
  const title = () => f.document.querySelector('.dialog h2, .dialog [class*="title"]')?.textContent || '';
  await f.wait(() => title().includes('프롬프트 미리보기'), 'prompt preview dialog');
  assert.match(title(), /상태 AIDE/);
});

test('clicking 상태 or 억결 in the ladder switches the active detail panel away from SHADOW ACT', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const shadowDetail = f.document.querySelector('.stage-detail[data-detail="shadow"]');
  const bodyDetail = f.document.querySelector('.stage-detail[data-detail="body_state"]');
  const bondDetail = f.document.querySelector('.stage-detail[data-detail="forced_bond"]');
  assert.equal(shadowDetail.classList.contains('is-on'), true);

  f.document.querySelector('#ladder .node[data-select-row="body_state"]').click();
  assert.equal(bodyDetail.classList.contains('is-on'), true);
  assert.equal(shadowDetail.classList.contains('is-on'), false);
  assert.equal(bondDetail.classList.contains('is-on'), false);

  f.document.querySelector('#ladder .node[data-select-row="forced_bond"]').click();
  assert.equal(bondDetail.classList.contains('is-on'), true);
  assert.equal(bodyDetail.classList.contains('is-on'), false);
  assert.equal(shadowDetail.classList.contains('is-on'), false);
});

test('a scene condition is tracked and the time of day is optional color, never a required insert', async t => {
  const chat = { id: 'h', message: [{ role: 'user', chatId: 'u1', data: '밤늦게 공원에 간다.' }, { role: 'assistant', chatId: 'a1', data: '밤 11시, 민아는 숨을 몰아쉬며 달려왔다.' }] };
  const character = { chaId: 'c', name: 'Minah Kim', nickname: '민아', chats: [chat], chatPage: 0, lorebook: [] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f, '민아는 벤치에 주저앉았다.');
  await configure(f);
  await runTurn(f, '민아 옆에 앉는다.');
  const body = systemOf(f.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(body, /- Minah Kim:/);
  assert.match(body, /scene condition this turn: exertion → breathing hard, sweat, sore muscles/);
  assert.match(body, /Scene time \(context only\): night \(recent scene\)/);
  assert.doesNotMatch(body, /sleepy, slower, guard lowered/);
  assert.match(body, /For each present character with a tracked condition that the draft never shows, insert one bodily sign/);
  assert.match(body, /Time of day is scene context only\. It does not establish fatigue/);
  assert.match(body, /remove unsupported health claims or explanations already in the draft/);
  assert.doesNotMatch(body, /edits must not be empty/);
  assert.match(f.prompts.find(item => !stageOf(item)).messages.map(m => m.content).join('\n'), /A present character with a tracked condition in the packet shows it through one bodily sign; an ordinary body needs no added sign/, 'SHADOW plans signs only for tracked conditions');
});

test('LIBRA story clock days drive elapsed time when present', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const packet = f.host.plugin.debugBodyStatePacket({
    characterName: '세라',
    libText: '[STORY CLOCK] 현재: 이야기 12일째 · 저녁 · 2026-04-12\n이야기 9일째 · 아침 · 2026-04-09 세라는 감기에 걸렸다',
    recent: { visibleMessages: [] },
    settings: { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal' }
  });
  assert.match(packet, /Story clock \(LIBRA\): day 12 · 저녁 · 2026-04-12\./);
  assert.match(packet, /Current story date: 2026-4-12 \(LIBRA story clock\)/);
  assert.match(packet, /감기: day 4 \(confirmed \(story clock\); usual 7–10 days\) → ongoing/);
  const estimated = f.host.plugin.debugBodyStatePacket({
    characterName: '세라',
    libText: '[STORY CLOCK] 현재: 이야기 5일째(추정) · 밤\n이야기 2일째 세라는 발목을 다쳤다',
    settings: { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal' }
  });
  assert.match(estimated, /injury \(moderate\): day 4 \(estimated \(story clock\); usual 10–21 days\)/);
});

test('automatic cycle and conception: card first, then profile gender; same contact keeps one verdict', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const base = { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, mode: 'normal', bodyStateReproduction: true };
  const run = (libText, recent, extra = {}) => f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey: 's', libText, recent, settings: { ...base, ...extra },
    profileGenders: { 세라: 'female', 준호: 'male' }
  });
  const contactNow = run('[STORY CLOCK] 현재: 이야기 10일째 · 밤', { visibleMessages: [{ role: 'assistant', content: '세라는 하준과 관계를 가졌다.' }] });
  assert.match(contactNow, /cycle: day \d+ of (2[6-9]|3[0-2]) \(auto \(fixed seed, story clock\)\)/, 'an automatic cycle for a female profile');
  const verdictNow = contactNow.match(/sexual contact 0 days ago \(estimated \(recent scene\)\), cycle day (\d+) then, contraception unknown, treated as none → chance ([\d.]+)% → (PREGNANT \(fixed verdict\)|not pregnant \(fixed verdict\))[^\n]*\[can conceive: profile: female\]/);
  assert.ok(verdictNow, contactNow);
  assert.equal(run('[STORY CLOCK] 현재: 이야기 10일째 · 밤', { visibleMessages: [{ role: 'assistant', content: '세라는 하준과 관계를 가졌다.' }] }), contactNow, 'the automatic cycle is stable');

  // Twenty days later the same contact reaches GRADIA only as a LIBRA lens note stamped with its day.
  const later = run('[STORY CLOCK] 현재: 이야기 30일째 · 아침\n이야기 10일째 · 밤 세라는 하준과 관계를 가졌다', { visibleMessages: [] });
  const verdictLater = later.match(/sexual contact 20 days ago \(confirmed \(story clock\)\), cycle day (\d+) then, contraception unknown, treated as none → chance ([\d.]+)% → (PREGNANT \(fixed verdict\)|not pregnant \(fixed verdict\))/);
  assert.ok(verdictLater, later);
  assert.deepEqual(verdictLater.slice(1, 4), verdictNow.slice(1, 4), 'same contact day → same cycle day, chance and verdict');

  const male = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '준호', scopeKey: 's', settings: base, profileGenders: { 준호: 'male' },
    libText: '[STORY CLOCK] 현재: 이야기 10일째 · 밤', recent: { visibleMessages: [{ role: 'assistant', content: '준호는 하준과 관계를 가졌다.' }] }
  });
  assert.doesNotMatch(male, /cycle:|sexual contact|PREGNANT/, 'a male profile gets no cycle and no pregnancy judgment');

  const cardNo = f.host.plugin.debugBodyStatePacket({
    personaName: '하준', characterName: '세라', scopeKey: 's', settings: { ...base, bodyStateCards: { s: [{ name: '세라', canConceive: 'no' }] } },
    profileGenders: { 세라: 'female' }, libText: '[STORY CLOCK] 현재: 이야기 10일째 · 밤',
    recent: { visibleMessages: [{ role: 'assistant', content: '세라는 하준과 관계를 가졌다.' }] }
  });
  assert.doesNotMatch(cardNo, /cycle:|sexual contact|PREGNANT/, 'the card overrides the profile');
});

test('a real run reads conception eligibility from the character card profile', async t => {
  const chat = { id: 'h', message: [{ role: 'user', chatId: 'u1', data: '민아와 밤을 보낸다.' }, { role: 'assistant', chatId: 'a1', data: '4월 3일 밤, 민아는 하준과 관계를 가졌다.' }] };
  const character = { chaId: 'c', name: 'Minah Kim', nickname: '민아', desc: 'Name: Minah Kim\nGender: Female\nAge: 24', description: 'Name: Minah Kim\nGender: Female\nAge: 24', chats: [chat], chatPage: 0, lorebook: [] };
  const f = await fixture(t, { writingMode: 'rp', unified: false, chat, character });
  wireModel(f, '민아는 창밖을 보았다.');
  await configure(f, { body_state_reproduction: true });
  await runTurn(f, '민아 곁에 눕는다.');
  const body = systemOf(f.prompts.find(item => stageOf(item) === 'aide_character'));
  assert.match(body, /- Minah Kim:\n *cycle: day \d+ of \d+ \(auto \(fixed seed, story date\)\)/);
  assert.match(body, /sexual contact \d+ days ago [^\n]*\[can conceive: profile: female\]/);
});

// User decision 2026-11-17 (after comparing a Dusk cycle editor): a pregnancy runs on a timeline,
// a birth starts a postpartum state, both replace the cycle, and a pregnancy can be kept on the
// card so it no longer depends on the contact line being recalled.
const pregnancyBase = { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal', bodyStateReproduction: true };
test('a pregnancy on the card runs on its timeline and replaces the cycle', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const packetFor = card => f.host.plugin.debugBodyStatePacket({ characterName: '세라', scopeKey: 'p', libText: '[STORY CLOCK] 현재: 이야기 40일째 · 저녁',
    settings: { ...pregnancyBase, bodyStateCards: { p: [{ name: '세라', cycleLength: 28, lastPeriodStart: '3월 1일', ...card }] } }, profileGenders: { 세라: 'female' } });
  const auto = packetFor({ conceptionDate: '이야기 5일째', partner: '하준' });
  assert.match(auto, /pregnancy: week 5 \(day 36 since conception, card\) → morning sickness: nausea, smell sensitivity, fatigue; due in about 231 days; awareness: she likely knows by now unless the story says otherwise; other party: 하준/);
  assert.doesNotMatch(auto, /cycle:/, 'no cycle while pregnant');
  assert.match(packetFor({ conceptionDate: '이야기 5일째', knows: 'no' }), /awareness: she does not know yet \(card\): show only the body changes, never her knowing/);
  assert.match(packetFor({ conceptionDate: '이야기 39일째' }), /pregnancy: week 0 \(day 2 since conception, card\) → no bodily change yet/);
});

test('a recent birth on the card gives a postpartum state until a period is recorded', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const packetFor = (card, libText = '[STORY CLOCK] 현재: 이야기 40일째 · 저녁') => f.host.plugin.debugBodyStatePacket({ characterName: '세라', scopeKey: 'b', libText,
    settings: { ...pregnancyBase, bodyStateCards: { b: [{ name: '세라', cycleLength: 28, ...card }] } }, profileGenders: { 세라: 'female' } });
  const early = packetFor({ lastBirth: '이야기 30일째' });
  assert.match(early, /postpartum: day 11 after giving birth \(card\) → recovering: bleeding, soreness, exhaustion, broken sleep/);
  assert.doesNotMatch(early, /cycle:/);
  assert.match(packetFor({ lastBirth: '이야기 1일째' }, '[STORY CLOCK] 현재: 이야기 90일째 · 저녁'), /postpartum: day 90 after giving birth \(card\) → recovered, but the cycle may not have returned yet/);
  const back = packetFor({ lastBirth: '이야기 1일째' }, '[STORY CLOCK] 현재: 이야기 90일째 · 저녁\n이야기 85일째 · 아침 세라는 생리를 시작했다');
  assert.doesNotMatch(back, /postpartum/, 'a period recorded after the birth means the cycle is back');
  assert.match(back, /cycle: day 6 of 28/);
});

test('a positive verdict runs on the timeline, and the 상태 panel can pin it to the card', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.');
  await configure(f, { body_state_reproduction: true });
  await runTurn(f, '문을 연다.');
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  // Find a contact day whose fixed verdict is positive (deterministic for this scope).
  let packet = '';
  for (let day = 1; day <= 28 && !/PREGNANT/.test(packet); day += 1) {
    packet = f.host.plugin.debugBodyStatePacket({ personaName: '하준', characterName: '세라', scopeKey, profileGenders: { 세라: 'female' },
      libText: `[STORY CLOCK] 현재: 이야기 60일째 · 저녁\n이야기 ${day + 30}일째 · 밤 세라는 하준과 관계를 가졌다`,
      settings: { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, mode: 'normal', bodyStateReproduction: true,
        bodyStateCards: { [scopeKey]: [{ name: '세라', cycleLength: 28, lastPeriodStart: '' }] } } });
  }
  assert.match(packet, /PREGNANT \(fixed verdict\)/, 'some contact day in a cycle yields a positive verdict');
  assert.match(packet, /pregnancy: week \d+ \(day \d+ since conception, fixed verdict\)/);
  assert.doesNotMatch(packet, /cycle:/, 'no cycle once the verdict is positive');
  const verdict = f.host.plugin.getRuntime().bodyStateVerdicts[scopeKey].items.find(item => item.name === '세라');
  assert.match(verdict.conception, /^이야기 \d+일째$/);

  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const panel = f.document.querySelector('.stage-detail[data-detail="body_state"]');
  const pin = await f.wait(() => panel.querySelector('[data-body-state-action="pin"]'), 'pin button');
  assert.ok(panel.querySelector('[data-body-state-verdicts]').textContent.includes(`세라 · 임신 판정 (수정 ${verdict.conception})`));
  pin.click();
  await f.wait(() => panel.querySelector('[data-body-state-card-field="conceptionDate"]')?.value === verdict.conception, 'pinned to the card');
  assert.equal(panel.querySelector('[data-body-state-action="pin"]'), null, 'a pinned verdict is no longer offered');
  f.document.querySelector('#savebar [data-save]').click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  const cards = JSON.parse((await f.host.plugin.getRuntimeSettings()).body_state_cards)[scopeKey];
  assert.equal(cards.find(card => card.name === '세라').conceptionDate, verdict.conception);
});
