'use strict';

// 정사 AIDE (aide_intimacy): an optional sub-AIDE of 인물 AIDE that keeps a sexual encounter
// already under way on the page, phase by phase, with correct anatomy and continuous positions,
// and follows each character's preference card. Cards are estimated once from lore by the host
// stage and stored per chat in a key of their own; they are never overwritten automatically.
// This file covers registration (default off, NSFW gate, host), the phase/position packet, the
// reference notes per phase, the writing-mode rules, and the preference cards.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const STAGE = 'aide_intimacy';
const HOST = 'aide_character';
const BLOCK = '[INTIMACY (정사)';
const CARDS_KEY = 'serial_gradation_agents_for_rp:intimacy_cards:v1';
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

const configure = async (f, settings = {}, enabled = true) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp', nsfw_mode: 'direct',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false,
    enable_plot_aide: true, enable_intimacy_aide: enabled, failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, aide_intimacy: { ...(slots.aide_intimacy || {}), enabled } });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};

const start = async (t, settings = {}, enabled = true, extras = {}) => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '민아는 숨을 몰아쉬었다.', extras);
  await configure(f, settings, enabled);
  return f;
};

const SEX_INPUT = '민아를 엎드리게 하고 후배위로 천천히 삽입한다.';
const storedCards = f => {
  const raw = f.values.get(CARDS_KEY) ?? f.local.get(CARDS_KEY);
  if (!raw) return {};
  return (typeof raw === 'string' ? JSON.parse(raw) : raw).cards || {};
};

test('정사 AIDE is off by default and adds no block', async t => {
  const f = await start(t, {}, false);
  await runTurn(f, SEX_INPUT);
  assert.ok(f.prompts.length > 0);
  assert.ok(f.prompts.every(body => !textOf(body).includes(BLOCK)));
});

test('it needs NSFW guidance: with NSFW off it does not run', async t => {
  const f = await start(t, { nsfw_mode: 'off' });
  await runTurn(f, SEX_INPUT);
  assert.ok(f.prompts.every(body => !textOf(body).includes(BLOCK)));
});

test('outside an encounter it adds one line and never starts one', async t => {
  const f = await start(t);
  await runTurn(f, '문을 연다.');
  const host = f.prompts.find(body => stageOf(body) === HOST);
  assert.ok(host, 'the host stage is called');
  const system = systemOf(host);
  assert.match(system, /No sexual encounter is under way in the current input or the recent scene\. This block does not apply, and it never starts one\./);
  assert.doesNotMatch(system, /REFERENCE NOTES:/);
});

test('inside an encounter 인물 AIDE settles it in its own call with phase, position, and that phase’s notes', async t => {
  const f = await start(t);
  await runTurn(f, SEX_INPUT);
  assert.ok(!f.prompts.some(body => stageOf(body) === STAGE), 'no call of its own');
  const system = systemOf(f.prompts.find(body => stageOf(body) === HOST));
  assert.match(system, /STAGE DUTY: 정사 AIDE runs inside this stage as a sub-step\. Intimacy AIDE:/);
  assert.match(system, /Phase now: intercourse \(성교\), read from the current input\./);
  assert.match(system, /Position on record: 후배위 \(from behind\)/);
  assert.match(system, /\[intercourse\] Positions and what each gives/);
  assert.doesNotMatch(system, /\[afterplay\]/, 'only the notes this phase needs');
  assert.match(system, /vocabulary register is the NSFW GUIDANCE mode \(DIRECT\)/);
  assert.match(system, /RP mode: the persona’s acts, sensations, arousal, and climax are only what the input states/);
  assert.ok(f.prompts.some(body => !stageOf(body).startsWith('aide_') && textOf(body).includes('STAGE DUTY: SHADOW: write the current phase on the page')), 'SHADOW gets its duty');
  const plot = f.prompts.find(body => stageOf(body) === 'aide_plot');
  assert.match(systemOf(plot), /STAGE DUTY: Plot AIDE: check the pacing across phases/);
});

test('prose mode skips it; Novel mode lets every participant be written', async t => {
  const prose = await start(t, { rp_impersonation_scope: 'all' });
  await runTurn(prose, SEX_INPUT);
  assert.ok(prose.prompts.every(body => !textOf(body).includes(BLOCK)));
  const novel = await start(t, { writing_mode: 'novel' });
  await runTurn(novel, SEX_INPUT);
  assert.match(systemOf(novel.prompts.find(body => stageOf(body) === HOST)), /Novel mode: every participant’s acts and sensations may be written/);
});

test('a profile from the host becomes a stored card that later turns follow and nothing overwrites', async t => {
  const profile = (name, liked) => ({
    name, liked_positions: liked, disliked_positions: '후배위',
    foreplay_stance: 'likes', foreplay_style: '길고 느린 키스로 시작하길 원한다.',
    intercourse_stance: 'neutral', intercourse_style: '상대에게 맡기는 편.',
    afterplay_stance: 'likes', afterplay_style: '오래 안겨 있기를 좋아한다.', basis: '수줍고 다정한 성격(캐릭터 카드).'
  });
  const f = await start(t, {}, true, {
    [HOST]: { intimacy_readings: [{ participant: '민아', phase: 'intercourse', position: '후배위', summary: '흥분이 오르는 중' }], intimacy_profiles: [profile('민아', '정상위')] }
  });
  await runTurn(f, SEX_INPUT);
  const cards = Object.values(storedCards(f)).flat();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, '민아');
  assert.equal(cards[0].likedPositions, '정상위');
  assert.equal(cards[0].foreplayStance, 'likes');
  assert.equal(cards[0].origin, 'lore');

  // The scene is a complete turn once the response lands.
  f.chat.message.push({ role: 'char', chatId: 'a1', data: '민아는 시트를 움켜쥐고 숨을 몰아쉬었다.' });
  // The next turn's host returns a different profile for the same name: the card stays.
  wireModel(f, '민아는 숨을 몰아쉬었다.', { [HOST]: { intimacy_readings: [], intimacy_profiles: [profile('민아', '기승위')] } });
  await runTurn(f, '허리를 천천히 움직인다.');
  const system = systemOf(f.prompts.find(body => stageOf(body) === HOST));
  assert.match(system, /PREFERENCE CARDS \(saved for this chat; treat as established character facts\):\n- 민아: positions liked: 정상위; disliked: 후배위\. foreplay: likes — 길고 느린 키스로 시작하길 원한다\./);
  const after = Object.values(storedCards(f)).flat();
  assert.equal(after.length, 1);
  assert.equal(after[0].likedPositions, '정상위');
});

test('the enabled flag survives a settings round trip', async t => {
  const f = await start(t);
  const slots = await f.host.plugin.getAgentSlots();
  assert.equal(slots.aide_intimacy?.enabled, true);
});

// ---- Packet: phase and position from the input and the recent scene, never stored ----

const sceneOf = async (t, latestUser, lines = []) => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  return f.host.plugin.debugIntimacyPacket({ recent: { latestUser, visibleMessages: lines.map(content => ({ role: 'assistant', content })) } }).scene;
};

test('a kiss or undressing alone is not an encounter', async t => {
  assert.equal((await sceneOf(t, '그녀에게 키스하고 셔츠 단추를 푼다.')).engaged, false);
});

test('the current input leads, and a second round after a climax reads as intercourse', async t => {
  const scene = await sceneOf(t, '다시 천천히 삽입한다.', ['그는 그녀 안에서 사정했고, 민아도 절정에 몸을 떨었다.']);
  assert.equal(scene.phase, 'intercourse');
  assert.equal(scene.previousPhase, 'climax');
});

test('without act words in the input, the latest response sets the phase; afterplay needs the act beside it', async t => {
  assert.equal((await sceneOf(t, '그녀를 바라본다.', ['절정이 지나간 뒤 둘은 여운에 잠겨 팔베개를 했다.'])).phase, 'afterplay');
  assert.equal((await sceneOf(t, '그녀를 바라본다.', ['둘은 여운에 잠겨 창밖을 보았다.'])).engaged, false);
});

test('the last position named wins', async t => {
  const scene = await sceneOf(t, '정상위로 하다가 그녀가 올라타 기승위로 바꾼다.');
  assert.equal(scene.position, '기승위 (woman on top)');
});

test('an encounter that ended several messages ago is over', async t => {
  const scene = await sceneOf(t, '아침을 먹는다.', ['후배위로 삽입했다.', '둘은 잠들었다.', '해가 떴다.', '민아가 부엌으로 갔다.']);
  assert.equal(scene.engaged, false);
});

test('aphrodisiac or lotion/oil application activates heightened sensitivity cues in both intimacy and body-state packets', async t => {
  const f = await fixture(t, { writingMode: 'novel', unified: false });
  const intimacy = f.host.plugin.debugIntimacyPacket({
    recent: {
      latestUser: '민아의 허벅지에 로션을 바르고 애무한다.',
      visibleMessages: [{ role: 'assistant', content: '미약을 마신 민아는 숨을 몰아쉬었다.' }]
    }
  });
  assert.equal(intimacy.scene.engaged, true);
  assert.equal(intimacy.scene.sensitivityBoosters.length, 2);
  assert.match(intimacy.text, /Sensitivity boosters active: aphrodisiac \(미약·최음제\)/);
  assert.match(intimacy.text, /lotion \/ lubricant \(로션·오일·윤활제 도포\)/);

  const bodyPacket = f.host.plugin.debugBodyStatePacket({
    characterName: '민아',
    scopeKey: 's',
    recent: { visibleMessages: [{ role: 'assistant', content: '민아는 미약이 든 차를 마시고 허벅지에 로션을 발랐다.' }] },
    settings: { writingMode: 'novel', enableBodyStateAide: true, mode: 'normal' }
  });
  assert.match(bodyPacket, /aphrodisiac \/ heightened sensitivity/);
  assert.match(bodyPacket, /lotion \/ slick skin sensitivity/);
});

test('lore-estimated erogenous sensitivity scales body-part climax/ejaculation gauges, decays when unstimulated, and triggers at 100', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  await f.host.plugin.debugIntimacyLoadCards();
  const scopeKey = 's';
  f.host.plugin.debugSetActiveScope(scopeKey, '하준');
  const settings = {
    enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'],
    mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'rp'
  };
  const rec = f.host.plugin.debugIntimacyRecord({
    stageName: 'aide_character',
    settings,
    parsed: {
      intimacyReadings: [{ participant: '세라', phase: 'foreplay', position: '', summary: '가슴이 예민해 숨이 가빠짐' }],
      intimacyProfiles: [{
        name: '세라', liked_positions: '정상위', disliked_positions: '후배위',
        sensitive_zones: '유두, 귀, 음핵', dull_zones: '허벅지',
        foreplay_stance: 'likes', foreplay_style: '귀와 가슴 애무에 약하다.',
        intercourse_stance: 'likes', intercourse_style: '깊은 밀착을 선호한다.',
        afterplay_stance: 'likes', afterplay_style: '안겨 있기를 좋아한다.',
        basis: '로어북에 귀와 가슴이 특히 민감하다고 명시됨.'
      }]
    }
  });
  assert.equal(rec.cards.length, 1);
  assert.equal(rec.cards[0].sensitiveZones, '유두, 귀, 음핵');
  assert.equal(rec.cards[0].dullZones, '허벅지');

  const p1 = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: { latestUser: '세라의 유두를 부드럽게 만지고 핥는다.', visibleMessages: [] }
  });
  const g1 = p1.gauges.find(g => g.name === '세라');
  assert.equal(g1.climaxGauge, 27);
  assert.match(p1.text, /가슴·유두 \(민감×1\.5\)/);

  const pDecay = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: {
      latestUser: '잠시 멈추고 세라의 눈을 바라보며 숨을 고른다.',
      visibleMessages: [{ role: 'assistant', content: '세라의 유두를 만지고 핥자 세라가 신음을 흘렸다.' }]
    }
  });
  const gDecay = pDecay.gauges.find(g => g.name === '세라');
  assert.equal(gDecay.climaxGauge, 11);
  assert.match(pDecay.text, /-16 \[자극 부재 감쇠\]/);

  const pClimax = f.host.plugin.debugIntimacyPacket({
    characterName: '세라', personaName: '하준', scopeKey, profileGenders: { 세라: 'female' },
    recent: {
      latestUser: '세라의 음핵을 문지르며 질 안 깊숙이 삽입해 거칠게 피스톤질한다.',
      visibleMessages: [
        { role: 'assistant', content: '세라의 유두를 빨고 음핵을 애무했다.' },
        { role: 'assistant', content: '미약을 마신 세라의 보지 안으로 삽입해 허리를 흔들었다.' }
      ]
    }
  });
  const gClimax = pClimax.gauges.find(g => g.name === '세라');
  assert.equal(gClimax.climaxGauge, 100);
  assert.equal(gClimax.climaxTriggeredThisTurn, true);
  assert.match(pClimax.text, /CLIMAX REACHED \(100\/100/);
});

test('external reaction (외부반응) scales 100..200 by venue/crowding/loudness/stealth and applies even in private rooms', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const settings = {
    enableIntimacyAide: true, enableCharacterAide: true, aideStageOrder: ['aide_character'],
    mode: 'normal', nsfwGuidanceEnabled: true, nsfwMode: 'direct', writingMode: 'rp'
  };

  // Library with open door, people nearby, and loud climax -> capped at 200
  const libLoud = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-lib-1',
    recent: {
      latestUser: '도서관 서고 열린 문 앞에서 큰 소리로 신음을 터뜨리며 절정에 달한다.',
      visibleMessages: [{ role: 'assistant', content: '주변에 사람들이 오가고 사서가 복도 끝에 있었다.' }]
    }
  });
  assert.equal(libLoud.externalReaction.baseScore, 100);
  assert.equal(libLoud.externalReaction.score, 200);
  assert.equal(libLoud.externalReaction.maxScore, 200);
  assert.equal(libLoud.externalReaction.spaceType, 'semi_public');
  assert.equal(libLoud.externalReaction.riskBand, 'critical');
  assert.match(libLoud.text, /EXTERNAL REACTION \(외부반응/);

  // Park / restroom also detected properly
  const park = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-park-1',
    recent: { latestUser: '공원 벤치 뒤에서 손가락을 넣어 애무한다.', visibleMessages: [] }
  });
  assert.equal(park.externalReaction.place, '공원·정원');
  assert.ok(park.externalReaction.score > 100);

  const restroom = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-rest-1',
    recent: { latestUser: '화장실 칸막이 안에서 입을 막고 조용히 삽입한다.', visibleMessages: [] }
  });
  assert.equal(restroom.externalReaction.place, '화장실·세면실');
  assert.equal(restroom.externalReaction.spaceType, 'semi_public');

  // Private room still computes external reaction (never null/skipped) and responds to thin walls / roommates
  const privateQuiet = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-room-1',
    recent: { latestUser: '내 방 문을 잠그고 조용히 입을 막으며 삽입한다.', visibleMessages: [] }
  });
  assert.ok(privateQuiet.externalReaction);
  assert.equal(privateQuiet.externalReaction.spaceType, 'private');
  assert.ok(privateQuiet.externalReaction.score < 100);

  const privateRisky = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-room-2',
    recent: { latestUser: '자취방에서 룸메이트가 문 밖에 있는데도 침대가 삐걱거리게 거칠게 삽입한다.', visibleMessages: [] }
  });
  assert.equal(privateRisky.externalReaction.spaceType, 'private');
  assert.ok(privateRisky.externalReaction.score > 100);

  // Deterministic roll: identical inputs yield identical roll & noticed
  const repeat = f.host.plugin.debugIntimacyPacket({
    scopeKey: 'ext-lib-1',
    recent: {
      latestUser: '도서관 서고 열린 문 앞에서 큰 소리로 신음을 터뜨리며 절정에 달한다.',
      visibleMessages: [{ role: 'assistant', content: '주변에 사람들이 오가고 사서가 복도 끝에 있었다.' }]
    }
  });
  assert.equal(repeat.externalReaction.roll, libLoud.externalReaction.roll);
  assert.equal(repeat.externalReaction.noticed, libLoud.externalReaction.noticed);

  // Stage block includes character-dependent reaction options (direct, indirect, ignore) when noticed
  // Find a seed where noticed is true (score 200 -> noticeChance 98%)
  const block = f.host.plugin.debugIntimacyStageBlock({
    stageName: 'aide_character',
    settings,
    recent: {
      latestUser: '도서관 서고 열린 문 앞에서 큰 소리로 신음을 터뜨리며 절정에 달한다.',
      visibleMessages: [{ role: 'assistant', content: '주변에 사람들이 오가고 사서가 복도 끝에 있었다.' }]
    }
  });
  assert.match(block, /EXTERNAL REACTION \(외부반응\):/);
  if (libLoud.externalReaction.noticed) {
    assert.match(block, /Direct interference \(직접 훼방/);
    assert.match(block, /Indirect interference \(간접 훼방/);
    assert.match(block, /Ignore \/ unbothered \(무시·신경 안 씀/);
  }
});
