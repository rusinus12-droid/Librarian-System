'use strict';

// 세계 동역학 AIDE (aide_world_dynamics): an optional extension AIDE that lets off-scene
// movement with an established cause reach the scene. This file covers its registration
// (default off, execution order, writing-mode gates, storing nothing) and the packet that
// computes elapsed days and due verdicts from LIBRA's story clock, dated notes, and the scene,
// and the verification chain (world_check notes from the other stages, world_readings here).
// Design record: docs/gradia/FORCED-BOND-AIDE-DESIGN-20261114.md §14 (extension AIDE frame).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const STAGE = 'aide_world_dynamics';
// User decision 2026-11-17: 세계 동역학 is a sub-AIDE of 세계관 AIDE and settles its readings in
// that stage's call. HOST is the stage that carries it in these fixtures.
const HOST = 'aide_world';
const BLOCK = '[WORLD DYNAMICS';
const systemOf = body => body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const textOf = body => body.messages.map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

// stageExtras adds stage-specific top-level fields (world_check, world_readings).
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

test('when on, 세계관 AIDE settles it in its own call and every draft stage carries the block with its duty', async t => {
  const f = await start(t);
  await runTurn(f, '문을 연다.');
  assert.ok(!f.prompts.some(body => stageOf(body) === STAGE), 'no call of its own');
  const host = f.prompts.filter(body => stageOf(body) === HOST);
  assert.ok(host.length > 0, 'the host stage is called');
  assert.match(systemOf(host[0]), /STAGE DUTY: 세계 동역학 AIDE runs inside this stage as a sub-step. World Dynamics AIDE:/);
  const plot = f.prompts.find(body => stageOf(body) === 'aide_plot');
  assert.match(systemOf(plot), /STAGE DUTY: Plot AIDE: check that an off-scene movement does not end the turn/);
  const character = f.prompts.find(body => stageOf(body) === 'aide_character');
  assert.match(systemOf(character), /STAGE DUTY: Character AIDE: check that characters react only to off-scene movement they could have learned of/);
  assert.ok(f.prompts.some(body => !stageOf(body).startsWith('aide_') && textOf(body).includes('STAGE DUTY: SHADOW: when the packet offers a candidate that would plausibly reach this scene by now')), 'SHADOW gets its duty');
});

test('with all three sub-AIDEs on, only the core AIDEs are called, in the fixed order', async t => {
  const f = await start(t, { aide_stage_order: JSON.stringify(['aide_plot', 'aide_character', 'aide_world']) }, { body: true, bond: true });
  await runTurn(f, '문을 연다.');
  const aides = f.prompts.map(stageOf).filter(stage => stage.startsWith('aide_'));
  assert.deepEqual(aides, ['aide_character', 'aide_world', 'aide_plot']);
  assert.match(systemOf(f.prompts.find(body => stageOf(body) === HOST)), /세계 동역학 AIDE runs inside this stage as a sub-step/);
});

test('writing modes: prose skips the stage, staging surfaces nothing new, RP leaves the persona to the user', async t => {
  const prose = await start(t, { rp_impersonation_scope: 'all' });
  await runTurn(prose, '문을 연다.');
  assert.ok(!prose.prompts.some(body => stageOf(body) === STAGE), 'prose mode: no call');
  assert.ok(prose.prompts.every(body => !textOf(body).includes(BLOCK)), 'prose mode: no block');

  const staging = await start(t, { rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging, '문을 연다.');
  const stagingSystem = systemOf(staging.prompts.find(body => stageOf(body) === HOST));
  assert.match(stagingSystem, /Scene-staging RP mode: surface no new off-scene development and bring nobody in/);
  assert.doesNotMatch(stagingSystem, /- RP mode: the world and NPCs move/);

  const rp = await start(t, { rp_impersonation_scope: 'persona' });
  await runTurn(rp, '문을 연다.');
  assert.match(systemOf(rp.prompts.find(body => stageOf(body) === HOST)), /RP mode: the world and NPCs move on their own terms\. Never decide the persona’s reaction, knowledge, or next act/);

  const novel = await start(t, { writing_mode: 'novel' });
  await runTurn(novel, '문을 연다.');
  assert.match(systemOf(novel.prompts.find(body => stageOf(body) === HOST)), /Novel mode: off-scene actors may move and reach the scene within the author’s direction/);
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
  const system = systemOf(f.prompts.find(body => stageOf(body) === HOST));
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

// ---- World packet: computed each turn from the record, never stored ----

const packetOf = async (t, libText, lines = []) => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const args = { libText, recent: { visibleMessages: lines.map(content => ({ role: 'assistant', content })) } };
  const packet = f.host.plugin.debugWorldDynamicsPacket(args);
  assert.equal(f.host.plugin.debugWorldDynamicsPacket(args), packet, 'the same record gives the same packet');
  return packet;
};

test('story clock and dated notes give confirmed elapsed days, and a passed span comes first', async t => {
  const packet = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁 · 2026-04-17',
    '이야기 16일째 세라가 시장에 소문을 퍼뜨렸다',
    '이야기 12일째 · 아침 · 2026-04-12 기사단이 사흘 뒤 도착하도록 추격대를 보냈다',
    '이야기 17일째 세라는 빵을 먹었다'
  ].join('\n'));
  assert.match(packet, /Story clock \(LIBRA\): day 17/);
  assert.match(packet, /1\. \[pursuit\] in motion for 5 days \(confirmed \(story clock\)\); stated span 3 days → 2 days past it\n\s+evidence \(LIB\): 이야기 12일째/);
  assert.match(packet, /2\. \[rumor\] in motion for 1 day \(confirmed \(story clock\)\); no stated span/);
  assert.match(packet, /Candidate this turn: #1\./);
  assert.doesNotMatch(packet, /빵을 먹었다/, 'an ordinary line is not a movement');
});

test('a span that has not run out is listed but is not the candidate', async t => {
  const packet = await packetOf(t, '[STORY CLOCK] 현재: 이야기 13일째 · 밤\n이야기 12일째 전령이 닷새 뒤 도착할 예정으로 왕도를 떠났다');
  assert.match(packet, /in motion for 1 day \(confirmed \(story clock\)\); stated span 5 days → 4 days left/);
  assert.match(packet, /No listed movement has come due\. Surface nothing unless the current input itself reaches one of them\./);
  assert.doesNotMatch(packet, /Candidate this turn/);
});

test('an estimated clock keeps its day counts marked as approximate', async t => {
  const packet = await packetOf(t, '[STORY CLOCK] 현재: 이야기 5일째(추정) · 밤\n이야기 2일째 전령이 왕도로 떠났다');
  assert.match(packet, /Story clock \(LIBRA\): day 5 \(estimated\)/);
  assert.match(packet, /\[travel or approach\] in motion for about 3 days \(estimated \(story clock\)\)/);
});

test('a date followed by 까지 is a deadline: counted against today, never read as the start or as today', async t => {
  const ahead = await packetOf(t, '[STORY CLOCK] 현재: 이야기 17일째 · 저녁 · 2026-04-17\n이야기 15일째 길드는 하준에게 4월 20일까지 빚을 갚기로 약속받았다');
  assert.match(ahead, /\[deadline or promise\] in motion for 2 days \(confirmed \(story clock\)\); deadline in 3 days/);
  assert.doesNotMatch(ahead, /Candidate this turn/);

  const passed = await packetOf(t, '[STORY CLOCK] 현재: 이야기 17일째 · 저녁 · 2026-04-17\n이야기 10일째 길드는 하준에게 4월 15일까지 빚을 갚기로 약속받았다');
  assert.match(passed, /deadline passed 2 days ago/);
  assert.match(passed, /Candidate this turn: #1\./);

  const scene = await packetOf(t, '', ['4월 10일 아침이다.', '하준은 4월 12일까지 돌아오기로 했다.']);
  assert.match(scene, /started at an unknown time; deadline in 2 days/, 'the deadline date is not taken for today');
});

test('without a clock: relative phrases estimate, and unknown timing gives no day count', async t => {
  const packet = await packetOf(t, '', ['어제 영주는 병사들을 파견했다.', '상인은 물건을 가져오기로 약속했다.', '민아는 창밖을 보았다.']);
  assert.match(packet, /Story clock: none\./);
  assert.match(packet, /Evidence source: recent scene signals only \(no LIB evidence\)\./);
  assert.match(packet, /\[order or dispatch\] in motion for about 1 day \(estimated\); no stated span/);
  assert.match(packet, /\[deadline or promise\] started at an unknown time; timing unknown: do not say how far it has progressed/);
  assert.doesNotMatch(packet, /창밖/);
});

test('a later recorded ending of the same kind takes the movement out of the running', async t => {
  const packet = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 10일째 조사관이 수사를 시작했다',
    '이야기 14일째 조사관의 수사가 끝났다'
  ].join('\n'));
  assert.match(packet, /\[inquiry or procedure\] a later ending of this matter is on record: treat it as ended/);
  assert.match(packet, /Recorded endings[^\n]*\n- \(LIB\) 이야기 14일째 조사관의 수사가 끝났다/);
  assert.doesNotMatch(packet, /Candidate this turn/);

  const reopened = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 14일째 조사관의 수사가 끝났다',
    '이야기 16일째 다른 조사관이 수사를 시작했다'
  ].join('\n'));
  assert.match(reopened, /1\. \[inquiry or procedure\] in motion for 1 day/, 'a movement recorded after the ending is still under way');
  assert.match(reopened, /Candidate this turn: #1\./);
});

test('an ending closes only the matter it names, not every movement of its kind', async t => {
  const packet = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 북부 기사단이 추격대를 보냈다',
    '이야기 13일째 남부 경비대가 추격대를 보냈다',
    '이야기 15일째 남부 경비대의 추격이 취소됐다'
  ].join('\n'));
  assert.match(packet, /1\. \[pursuit\] in motion for 5 days[^\n]*\n\s+evidence \(LIB\): 이야기 12일째 북부 기사단이 추격대를 보냈다/, 'the northern pursuit is still under way');
  assert.match(packet, /\[pursuit\] a later ending of this matter is on record[^\n]*\n\s+evidence \(LIB\): 이야기 13일째 남부 경비대가 추격대를 보냈다/, 'only the southern pursuit ended');
  assert.match(packet, /Candidate this turn: #1\./);
  assert.match(packet, /Recorded endings \(each ends only the matter it names\):/);
});

test('an ending that names nobody closes a movement only when it is the only one of its kind', async t => {
  const single = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 북부 기사단이 추격대를 보냈다',
    '이야기 15일째 추격이 취소됐다'
  ].join('\n'));
  assert.match(single, /\[pursuit\] a later ending of this matter is on record/);
  assert.doesNotMatch(single, /Candidate this turn/);

  const several = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 북부 기사단이 추격대를 보냈다',
    '이야기 13일째 남부 경비대가 추격대를 보냈다',
    '이야기 15일째 추격이 취소됐다'
  ].join('\n'));
  assert.doesNotMatch(several, /a later ending of this matter is on record/, 'it cannot tell which pursuit ended, so neither is closed');
  assert.match(several, /Candidate this turn: #1\./);
  assert.match(several, /Recorded endings[^\n]*\n- \(LIB\) 이야기 15일째 추격이 취소됐다/, 'the ending is still shown for the model to weigh');
});

test('an ending that names only its outcome closes the movement about the same party', async t => {
  const packet = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 경비대가 도적을 추격하기 시작했다',
    '이야기 15일째 도적이 붙잡혔다'
  ].join('\n'));
  assert.match(packet, /\[pursuit\] a later ending of this matter is on record/);
  assert.doesNotMatch(packet, /Candidate this turn/);

  const other = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 경비대가 도적을 추격하기 시작했다',
    '이야기 15일째 소매치기가 붙잡혔다'
  ].join('\n'));
  assert.doesNotMatch(other, /a later ending of this matter is on record/, 'an outcome about someone else ends nothing');
});

test('on the same story day the record order decides whether an ending came later', async t => {
  const packet = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 12일째 북부 기사단의 추격이 취소됐다',
    '이야기 12일째 북부 기사단이 다시 추격대를 보냈다'
  ].join('\n'));
  assert.doesNotMatch(packet, /a later ending of this matter is on record/, 'the pursuit restarted after the ending');
  assert.match(packet, /\[pursuit\] in motion for 5 days/);
});

test('everyday phrases are not movements, and a negated ending is not an ending', async t => {
  const everyday = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 15일째 둘은 조용한 밤을 보냈다',
    '이야기 16일째 소문은 성문까지 퍼졌다'
  ].join('\n'));
  assert.doesNotMatch(everyday, /\[order or dispatch\]/, '"밤을 보냈다" sends nobody');
  assert.doesNotMatch(everyday, /\[deadline or promise\]/, '"성문까지" is a place, not a deadline');

  const open = await packetOf(t, [
    '[STORY CLOCK] 현재: 이야기 17일째 · 저녁',
    '이야기 10일째 조사관이 수사를 시작했다',
    '이야기 14일째 수사는 아직 해결되지 않았다'
  ].join('\n'));
  assert.doesNotMatch(open, /a later ending of this matter is on record/);
  assert.match(open, /\[inquiry or procedure\] in motion for 7 days/);
});

test('nothing on record: the packet says to surface nothing', async t => {
  const packet = await packetOf(t, '', ['민아는 문을 열었다.']);
  assert.match(packet, /No off-scene movement on record\. Surface nothing\./);
  assert.doesNotMatch(packet, /Candidate this turn|No listed movement/);
});

test('every draft stage receives the packet built from the recent scene', async t => {
  const f = await start(t);
  f.chat.message.push({ role: 'char', chatId: 'a-world', data: '어제 영주는 성문으로 병사들을 파견했다.' });
  await runTurn(f, '문을 연다.');
  const withBlock = f.prompts.filter(body => textOf(body).includes(BLOCK));
  assert.ok(withBlock.length >= 3, 'SHADOW and the AIDEs carry the block');
  for (const body of withBlock) assert.match(textOf(body), /WORLD DYNAMICS PACKET:\n/);
  const own = textOf(f.prompts.find(body => stageOf(body) === HOST));
  assert.match(own, /\[order or dispatch\] in motion for about 1 day \(estimated\); no stated span\n\s+evidence \(recent\): 어제 영주는 성문으로 병사들을 파견했다\./);
  assert.match(own, /Day counts and due verdicts come only from the packet/);
});

// ---- Verification chain: other stages leave world_check notes, this stage settles readings ----

// The plugin runs in its own realm, so its objects are compared by value.
const plain = value => JSON.parse(JSON.stringify(value ?? null));

const chainRun = async (t, stageExtras, settings = {}) => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 문 앞에 섰다.', stageExtras);
  await configure(f, settings);
  f.chat.message.push({ role: 'char', chatId: 'a-world', data: '어제 영주는 성문으로 병사들을 파견했다.' });
  return f;
};

test('checkers return world_check and later stages read the notes; readings stay in memory', async t => {
  const f = await chainRun(t, {
    aide_character: { world_check: [{ movement: '영주의 병사 파견', verdict: 'adjust', claim: '민아 already knows the soldiers are coming', reason: 'nobody told her and she saw nothing' }] },
    aide_world: { world_readings: [{ movement: '영주의 병사 파견', status: 'held', summary: '하루째 이동 중, 민아는 아직 모름' }] }
  });
  const keysBefore = new Set([...f.values.keys(), ...f.local.keys()].map(String));
  await runTurn(f, '문을 연다.');

  const character = f.prompts.find(body => stageOf(body) === 'aide_character');
  assert.ok(JSON.stringify(character).includes('"world_check"'), 'a checking stage is asked for world_check');
  assert.ok(!JSON.stringify(character).includes('"world_readings"'), 'a checking stage is not asked for readings');
  assert.doesNotMatch(systemOf(character), /VERIFICATION NOTES FROM EARLIER STAGES/, 'the first checker has no earlier note');

  const own = f.prompts.find(body => stageOf(body) === HOST);
  assert.ok(JSON.stringify(own).includes('"world_readings"'), 'the host is asked for world_readings');
  assert.ok(!JSON.stringify(own).includes('"world_check"'), 'the stage settles readings instead of leaving a note');
  assert.match(systemOf(own), /VERIFICATION NOTES FROM EARLIER STAGES \(this run\):\n- \[aide_character\] 영주의 병사 파견: adjust — 민아 already knows the soldiers are coming \(because nobody told her and she saw nothing\)/);
  assert.match(systemOf(own), /An "adjust" note lowers the movement to a fainter trace or holds it back/);
  assert.match(systemOf(f.prompts.find(body => stageOf(body) === 'aide_plot')), /\[aide_character\] 영주의 병사 파견: adjust/, 'Plot AIDE, running last, also sees the note');

  const state = f.host.plugin.debugWorldDynamicsState();
  assert.deepEqual(plain(state.readings?.readings), [{ movement: '영주의 병사 파견', status: 'held', summary: '하루째 이동 중, 민아는 아직 모름' }]);
  const added = [...new Set([...f.values.keys(), ...f.local.keys()].map(String))].filter(key => !keysBefore.has(key));
  assert.deepEqual(added.filter(key => /world.?dynamics|world_read|world_check/i.test(key)), [], 'no reading or note is persisted');
  for (const [key, value] of [...f.values, ...f.local]) {
    if (keysBefore.has(String(key))) continue;
    assert.ok(!String(typeof value === 'string' ? value : JSON.stringify(value)).includes('하루째 이동 중, 민아는 아직 모름'), `reading text is not written under ${key}`);
  }
});

test('malformed notes and readings are dropped or normalized, never passed along raw', async t => {
  const f = await chainRun(t, {
    aide_character: { world_check: [
      { movement: '', verdict: 'confirm', claim: 'no movement named', reason: '' },
      { movement: '소문', verdict: 'certainly', claim: 'the rumor reached the gate', reason: '' }
    ] },
    aide_world: { world_readings: [{ movement: '소문', status: 'exploded', summary: '성문까지 퍼짐' }, { movement: '이름만', status: 'held', summary: '' }] }
  });
  await runTurn(f, '문을 연다.');
  const own = systemOf(f.prompts.find(body => stageOf(body) === HOST));
  assert.match(own, /- \[aide_character\] 소문: uncertain — the rumor reached the gate/, 'an unknown verdict becomes uncertain');
  assert.doesNotMatch(own, /no movement named/, 'a note without a movement is dropped');
  assert.deepEqual(plain(f.host.plugin.debugWorldDynamicsState().readings?.readings), [{ movement: '소문', status: 'held', summary: '성문까지 퍼짐' }]);
});

test('with the stage off no other stage is asked for world_check', async t => {
  const f = await start(t, {}, { world: false });
  await runTurn(f, '문을 연다.');
  assert.ok(f.prompts.every(body => !JSON.stringify(body).includes('world_check') && !JSON.stringify(body).includes('world_readings')));
});

// ---- Settings GUI: turn the stage on, see this turn's readings, find it in the ladder ----

test('the 세계 동역학 panel shows the last readings, turns the stage on and saves it', async t => {
  const f = await chainRun(t, { aide_world: { world_readings: [{ movement: '영주의 병사 파견', status: 'held', summary: '하루째 이동 중, 아직 성문에 닿지 않음' }] } });
  await runTurn(f, '문을 연다.');
  await configure(f, {}, { world: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const panel = f.document.querySelector('.stage-detail[data-detail="world_dynamics"]');
  assert.ok(panel, 'the pipeline page renders the 세계 동역학 panel');
  // 2026-11-18: readings belong to the chat and show on the 이 채팅 page; the panel points there.
  assert.ok(panel.querySelector('[data-go="chat"][data-go-sub="readings"]'), 'the panel points to the 이 채팅 page');
  assert.match(f.document.querySelector('section[data-page="chat"] [data-world-dynamics-readings]').textContent, /영주의 병사 파견 · 보류.*하루째 이동 중/, 'last run readings show with their status');
  const toggle = panel.querySelector('#on-s7');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  // The save button is enabled once the change is counted.
  const save = await f.wait(() => { const node = f.document.querySelector('#savebar [data-save]'); return node && !node.disabled ? node : null; }, 'save enabled');
  save.click();
  await f.wait(() => !f.host.plugin.debugGuiStateInfo().dirty, 'saved');
  assert.equal((await f.host.plugin.getAgentSlots()).aide_world_dynamics.enabled, true);
  const runtime = await f.host.plugin.getRuntimeSettings();
  assert.ok(Object.keys(runtime).every(key => !/world_?dynamics_read/i.test(key)), 'readings are not written to settings');
});

test('with no run yet the panel says so, and the stage sits under 세계관 AIDE in the ladder', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.openSettingsGui();
  await f.host.plugin.debugNavigateGui('pipeline');
  const panel = f.document.querySelector('.stage-detail[data-detail="world_dynamics"]');
  assert.match(f.document.querySelector('section[data-page="chat"] [data-world-dynamics-readings]').textContent, /아직 판독이 없습니다/);
  assert.equal(panel.querySelector('#on-s7').checked, false, 'off by default');
  const rows = [...f.document.querySelectorAll('#ladder [data-select-row]')].map(node => node.dataset.selectRow);
  assert.equal(rows[rows.indexOf('world') + 1], 'world_dynamics', rows.join(' > '));
  assert.match(f.document.querySelector('#ladder [data-select-row="world_dynamics"]').textContent, /세계관 AIDE 하위/);
  assert.ok(f.document.querySelector('[data-subtab="d"]'), 'the results page has a 세계 동역학 tab');
  assert.ok(f.document.querySelector('[data-subpanel="d"]'), 'and its panel');
  assert.ok(f.document.querySelector('#mini-s4w'), 'the home overview keeps a chip for a stand-alone run');
});

// ---- Probabilistic World Simulator (2026-11-22) ----

test('world simulator builds off-scene cast excluding @-present cast and persona, and rolls deterministically', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const recent = {
    latestUser: '카페 창가에 앉아 커피를 마신다.',
    offSceneCast: ['천하연', '민태오', '이지원', '구민지'],
    visibleMessages: [
      { role: 'assistant', content: '천하연이 맞은편에 앉았다.\n◈CG\nTIME|2027.04.26(월)|12:10\nLOC|카페|bg_cafe|맑음\n@|천하연\n◈' }
    ]
  };
  const triggeredSim = f.host.plugin.debugWorldDynamicsSimulator({
    recent,
    settings: { worldSimulatorChance: 100 }
  });
  assert.deepEqual([...triggeredSim.offSceneCast], ['민태오', '이지원', '구민지'], 'present cast 천하연 is excluded');
  assert.equal(triggeredSim.triggered, true);
  assert.ok(['민태오', '이지원', '구민지'].includes(triggeredSim.actor));
  assert.ok(triggeredSim.actionType && triggeredSim.actionType.id);

  const quietSim = f.host.plugin.debugWorldDynamicsSimulator({
    recent,
    settings: { worldSimulatorChance: 0 }
  });
  assert.equal(quietSim.triggered, false);

  const pktTriggered = f.host.plugin.debugWorldDynamicsPacket({
    recent,
    settings: { worldSimulatorChance: 100 }
  });
  assert.match(pktTriggered, /\[OFF-SCENE WORLD SIMULATOR\]/);
  assert.match(pktTriggered, /TRIGGERED · Actor:/);

  const pktQuiet = f.host.plugin.debugWorldDynamicsPacket({
    recent,
    settings: { worldSimulatorChance: 0 }
  });
  assert.match(pktQuiet, /QUIET TURN/);
});

test('world simulator respects private-room remote-only channels and defers when due movement or intimate scene is active', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const privateRecent = {
    latestUser: '내 방 침대에 누워 천장을 본다.',
    offSceneCast: ['민태오', '이지원'],
    visibleMessages: [{ role: 'assistant', content: '방 안은 조용했다.' }]
  };
  const privSim = f.host.plugin.debugWorldDynamicsSimulator({
    recent: privateRecent,
    settings: { worldSimulatorChance: 100 }
  });
  assert.equal(privSim.spaceType, 'private');
  assert.equal(privSim.actionType.channel, 'remote', 'private room never picks local nearby_passing');

  const dueSim = f.host.plugin.debugWorldDynamicsSimulator({
    recent: privateRecent,
    settings: { worldSimulatorChance: 100 },
    hasDueMovement: true
  });
  assert.equal(dueSim.triggered, false);
  assert.equal(dueSim.suppressed, 'due_movement_active');

  const intimateRecent = {
    latestUser: '도서관 서고 열린 문 앞에서 큰 소리로 신음을 터뜨리며 그녀의 유두를 만진다.',
    offSceneCast: ['민태오', '이지원'],
    visibleMessages: [{ role: 'assistant', content: '주변에 사람들이 오가고 있었다.' }]
  };
  const intSim = f.host.plugin.debugWorldDynamicsSimulator({
    recent: intimateRecent,
    settings: { worldSimulatorChance: 100 }
  });
  assert.equal(intSim.triggered, false);
  assert.equal(intSim.suppressed, 'intimate_scene_delegated');

  const extPkt = f.host.plugin.debugIntimacyPacket({ recent: intimateRecent });
  assert.ok(['민태오', '이지원'].includes(extPkt.externalReaction?.nearbyActor), 'intimacy external reaction draws nearbyActor from off-scene cast pool');
});
