'use strict';

// 관계 시뮬레이터 (aide_relationship_sim): an optional sub-AIDE of 인물 AIDE that supports romance
// narrative and depiction (user decisions 2026-11-19). It turns each pair's stored status,
// disclosure, lead, love styles and preference cards into depiction lines; rolls confession,
// reunion, proposal, date and event outcomes in code before SHADOW drafts and fixes them; surfaces
// anniversaries from the story date; and keeps its own relationship state, committed only once a
// later turn shows the response was kept. Design: docs/gradia/RELATIONSHIP-SIMULATOR-DESIGN-20261119.md

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const STAGE = 'aide_relationship_sim';
const HOST = 'aide_character';
const BLOCK = '[RELATIONSHIP SIMULATOR (관계 시뮬레이터)]';
const LORE_KEY = 'serial_gradation_agents_for_rp:lore_cards:v1';
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
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', writing_mode: 'rp',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false,
    enable_plot_aide: true, enable_relationship_sim_aide: enabled, failure_mode: 'hard', lore_activation_mode: 'off', ...settings
  });
  const slots = await f.host.plugin.getAgentSlots();
  await f.host.plugin.saveAgentSlots({ ...slots, [STAGE]: { ...(slots[STAGE] || {}), enabled } });
};

const runTurn = async (f, userText) => {
  const id = 'u' + (f.chat.message.length + 1);
  f.chat.message.push({ role: 'user', chatId: id, data: userText });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};
// The same input again on the same prior response: a reroll of that turn. It arrives with a new
// message id, so it is a new request (an identical request inside the reuse window is served from
// the cache without running the stages).
let rerollCount = 0;
const rerun = async f => {
  const last = f.chat.message.pop();
  rerollCount += 1;
  f.chat.message.push({ ...last, chatId: `${last.chatId}-r${rerollCount}` });
  f.prompts.length = 0;
  await f.host.hooks.beforeRequest(f.chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId })), 'model');
};
const reply = (f, body) => f.chat.message.push({ role: 'char', chatId: 'a' + (f.chat.message.length + 1), data: body });

const CARD = { id: 'bond-junho', from: '@persona', to: '준호', tones: ['affection'], direction: 'mutual' };
// One warm-up run records the chat key; then the card and the pair state are seeded.
const start = async (t, { settings = {}, enabled = true, extras = {}, pair = null, cards = [CARD], profiles = null } = {}) => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  wireModel(f, '준호는 잠시 말이 없었다.', extras);
  await configure(f, settings, enabled);
  await runTurn(f, '주위를 둘러본다.');
  f.chat.message.pop();
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  assert.ok(scopeKey, 'a run records the current character+chat key');
  await configure(f, { ...settings, forced_bond_cards: JSON.stringify({ [scopeKey]: cards }) }, enabled);
  if (pair) await f.host.plugin.debugRelationshipSimSetPair(cards[0].id, pair);
  if (profiles) await f.host.plugin.debugRelationshipSimSetProfiles(profiles);
  return { f, scopeKey };
};
const hostSystem = f => systemOf(f.prompts.find(body => stageOf(body) === HOST));

test('관계 시뮬레이터 is off by default and adds no block', async t => {
  const { f } = await start(t, { enabled: false, pair: { status: 'more_than_friend' } });
  await runTurn(f, '준호에게 좋아한다고 고백한다.');
  assert.ok(f.prompts.length > 0);
  assert.ok(f.prompts.every(body => !textOf(body).includes(BLOCK)));
});

test('it runs inside 인물 AIDE with depiction lines and a fixed outcome for the persona’s act', async t => {
  const { f } = await start(t, {
    pair: { status: 'more_than_friend', disclosure: 'secret', lead: '준호', leadReasons: ['pride'] },
    profiles: [{ name: '준호', loveStyles: ['ludus'], places: { liked: ['cafe'] }, sulk: '말수가 줄고 연락을 늦게 받는다', basis: '장난스럽고 가벼운 성격(캐릭터 카드)' }]
  });
  await runTurn(f, '카페에서 준호에게 좋아한다고 고백한다.');
  assert.ok(!f.prompts.some(body => stageOf(body) === STAGE), 'no call of its own');
  const system = hostSystem(f);
  assert.match(system, /STAGE DUTY: 관계 시뮬레이터 runs inside this stage as a sub-step\. Relationship Simulator:/);
  assert.match(system, /This block supports romance narrative and depiction/);
  assert.match(system, /DEPICTION \(let the reader feel it through gestures and timing; never narrate these labels\):/);
  assert.match(system, /charged ambiguity: lingering looks/);
  assert.match(system, /keep it secret: careful distance in front of others/);
  assert.match(system, /준호 holds the lead \(자존심\)/);
  assert.match(system, /준호 loves the 유희적 사랑 way: light flirting and jokes/);
  assert.match(system, /- \[bond-junho\] If .+ makes a confession \(고백\) toward 준호 this turn, 준호 (accepts — agrees to be lovers|turns it down — the answer is no for now)\. The current input shows this act\./);
  // RP: the NPC's own confession to the persona is not rolled (the persona's answer is the user's).
  assert.doesNotMatch(system, /If 준호 makes a confession/);
  assert.match(system, /RP mode: never make the persona confess, propose/);
  assert.doesNotMatch(system, /\d+%/, 'no percentages in the prompt');
  assert.ok(f.prompts.some(body => !stageOf(body).startsWith('aide_') && textOf(body).includes('STAGE DUTY: SHADOW: let the DEPICTION lines shape')), 'SHADOW gets the same block before drafting');
});

test('a reroll of the same turn keeps the same outcome; a different turn rolls again', async t => {
  const { f } = await start(t, { pair: { status: 'friend' } });
  await runTurn(f, '준호에게 사귀자고 고백한다.');
  // The seed is the turn (its input and the response before it), not the run.
  const recent = (runId, input = '준호에게 사귀자고 고백한다.', prior = '준호는 웃었다.') => ({
    latestUser: input, latestAssistant: prior, visibleMessages: [{ role: 'assistant', content: prior }],
    runLineage: { runId, currentInputHash: '', priorAssistantHash: '' }
  });
  const rolls = async value => (await f.host.plugin.debugRelationshipSimPrepare({ recent: value })).verdicts.map(item => `${item.act}:${item.roll}`);
  const first = await rolls(recent('run-1'));
  assert.ok(first.length > 0);
  assert.deepEqual(await rolls(recent('run-2')), first, 'a reroll rolls the same numbers');
  const others = await Promise.all(['다른 말을 건넨다.', '손을 잡는다.', '고개를 끄덕인다.'].map((input, i) => rolls(recent(`run-${i + 3}`, input))));
  assert.ok(others.some(value => value.join() !== first.join()), 'another turn rolls again');
});

test('a shown outcome waits for the next turn, a reroll replaces it, and a hostile NPC stays near zero', async t => {
  const event = { pair_id: 'bond-junho', act: 'confession', actor: 'persona', outcome_shown: true, summary: '준호가 답한다' };
  const { f } = await start(t, {
    settings: { npc_disposition: '' },
    pair: { status: 'friend' },
    extras: { [HOST]: { relationship_events: [event] } }
  });
  const scopeKey = f.host.plugin.debugActiveScopeKey();
  await configure(f, { forced_bond_cards: JSON.stringify({ [scopeKey]: [CARD] }), npc_disposition: JSON.stringify({ [scopeKey]: { default: '', npcs: [{ id: 'n1', name: '준호', level: 'hostile' }] } }) });
  await runTurn(f, '준호에게 좋아한다고 고백한다.');
  let state = await f.host.plugin.debugRelationshipSimState();
  assert.equal(state.pending.length, 1, 'the change waits');
  assert.equal(state.pairs['bond-junho'].rolls.length, 0);
  await rerun(f);
  state = await f.host.plugin.debugRelationshipSimState();
  assert.equal(state.pending.length, 1, 'a reroll replaces, never doubles');
  reply(f, '준호는 차갑게 고개를 돌렸다.');
  wireModel(f, '준호는 대답하지 않았다.');
  await runTurn(f, '준호를 바라본다.');
  state = await f.host.plugin.debugRelationshipSimState();
  assert.equal(state.pending.length, 0);
  const rolls = state.pairs['bond-junho'].rolls;
  assert.equal(rolls.length, 1, 'kept once');
  assert.ok(rolls[0].percent <= 5, `hostile bounds the answer: ${rolls[0].percent}%`);
  assert.ok(rolls[0].factors.some(item => item.startsWith('경향성 적대')));
  assert.equal(state.pairs['bond-junho'].status, rolls[0].success ? 'lovers' : 'friend');
});

test('an anniversary is surfaced before its date and a missed one leaves a grievance', async t => {
  const { f } = await start(t, { pair: { status: 'lovers', datingSince: '2027-01-01' } });
  reply(f, '[2027-04-10 · 저녁] 준호가 문자를 보냈다.');
  await runTurn(f, '준호에게 답장한다.');
  assert.match(hostSystem(f), /- \[bond-junho:d100\] 100일 \(2027-04-11\) — in 1 day\(s\)\./);
  reply(f, '[2027-04-10 · 밤] 준호는 웃었다.');
  await runTurn(f, '잠든다.');
  reply(f, '[2027-04-13 · 오전] 준호는 말없이 커피만 마셨다.');
  await runTurn(f, '출근 준비를 한다.');
  assert.match(hostSystem(f), /- \[bond-junho:d100\] 100일 \(2027-04-11\) — already passed without being marked\./);
  reply(f, '[2027-04-13 · 오전] 준호는 대답이 짧았다.');
  await runTurn(f, '현관을 나선다.');
  const state = await f.host.plugin.debugRelationshipSimState();
  const pair = state.pairs['bond-junho'];
  assert.equal(pair.occasions.find(item => item.id === 'd100')?.state, 'missed');
  assert.equal(pair.grievance, 1);
  assert.match(pair.grievanceCause, /100일/);
  assert.match(hostSystem(f), /Unresolved hurt \(1\/3: 100일을 챙기지 않음\)/);
});

test('without a story date it never invents anniversaries', async t => {
  const { f } = await start(t, { pair: { status: 'lovers', datingSince: '2027-01-01' } });
  await runTurn(f, '준호에게 답장한다.');
  const system = hostSystem(f);
  assert.match(system, /STORY DATE: unknown — do not invent dates or anniversaries/);
  assert.doesNotMatch(system, /OCCASIONS:/);
});

test('host estimates become a lore preference card and a pair status; the persona gets no card in RP', async t => {
  const { f } = await start(t, {
    extras: { [HOST]: {
      relationship_pairs: [{ from: 'persona', to: '준호', mutual: true, status: 'more_than_friend', dating_since: '', disclosure: 'secret', known_by: '', lead: '준호', lead_reasons: 'pride', basis: '서로 의식하는 사이(로어)' }],
      relationship_profiles: [
        { name: '준호', places_liked: '카페, 서점', places_disliked: '놀이공원', times_liked: '늦저녁', times_disliked: '', dates_liked: '칵테일바', dates_disliked: '', events_liked: '', events_disliked: '관객 앞 프러포즈', love_styles: '유희적 사랑', birthday: '5월 14일', sulk: '말수가 줄어든다', basis: '도시적이고 장난스러운 성격(캐릭터 카드)' },
        { name: 'persona', places_liked: '카페', places_disliked: '', times_liked: '', times_disliked: '', dates_liked: '', dates_disliked: '', events_liked: '', events_disliked: '', love_styles: '', birthday: '', sulk: '', basis: 'x' },
        { name: '민아', places_liked: '', places_disliked: '', times_liked: '', times_disliked: '', dates_liked: '', dates_disliked: '', events_liked: '', events_disliked: '', love_styles: '', birthday: '', sulk: '', basis: '' }
      ]
    } }
  });
  await runTurn(f, '준호를 본다.');
  const state = await f.host.plugin.debugRelationshipSimState();
  assert.equal(state.pairs['bond-junho'].status, 'more_than_friend');
  assert.equal(state.pairs['bond-junho'].disclosure, 'secret');
  const raw = f.values.get(LORE_KEY) ?? f.local.get(LORE_KEY);
  const cards = Object.values((typeof raw === 'string' ? JSON.parse(raw) : raw).cards.romancePrefs || {}).flat();
  assert.equal(cards.length, 1, 'persona and an empty estimate make no card');
  assert.deepEqual(cards[0].places, { liked: ['cafe', 'bookstore'], disliked: ['amusement_park'] });
  assert.deepEqual(cards[0].times.liked, ['late_evening']);
  assert.deepEqual(cards[0].events.disliked, ['public_proposal']);
  assert.deepEqual(cards[0].loveStyles, ['ludus']);
  assert.equal(cards[0].birthday, '05-14');
  assert.equal(cards[0].origin, 'lore');
});

test('scene-staging RP rolls nothing; prose mode skips the stage; Novel rolls both directions', async t => {
  const { f: staging } = await start(t, { settings: { rp_impersonation_scope: 'persona_cast' }, pair: { status: 'friend' } });
  await runTurn(staging, '준호에게 고백한다.');
  const stagingSystem = hostSystem(staging);
  assert.match(stagingSystem, /Scene-staging RP mode: every act and answer is the user’s\. Nothing is rolled/);
  assert.doesNotMatch(stagingSystem, /FIXED OUTCOMES/);
  const { f: prose } = await start(t, { settings: { rp_impersonation_scope: 'all' }, pair: { status: 'friend' } });
  await runTurn(prose, '준호에게 고백한다.');
  assert.ok(prose.prompts.every(body => !textOf(body).includes(BLOCK)));
  const { f: novel } = await start(t, { settings: { writing_mode: 'novel' }, pair: { status: 'friend' } });
  await runTurn(novel, '준호에게 고백한다.');
  assert.match(hostSystem(novel), /If 준호 makes a confession \(고백\) toward/);
});

test('the enabled flag survives a settings round trip', async t => {
  const { f } = await start(t);
  const slots = await f.host.plugin.getAgentSlots();
  assert.equal(slots[STAGE]?.enabled, true);
  assert.equal((await f.host.plugin.getRuntimeSettings()).enable_relationship_sim_aide, true);
});

test('the roll is a stable function of its seed', async t => {
  const { f } = await start(t, { enabled: false });
  const a = f.host.plugin.debugRelationshipSimRoll('scope|bond|confession|persona|1|2');
  assert.equal(f.host.plugin.debugRelationshipSimRoll('scope|bond|confession|persona|1|2'), a);
  assert.ok(a >= 0 && a < 100);
});

test('places, dates, and events stay world-neutral, support rich categories, and preserve aliases', async t => {
  const { f } = await start(t, {
    pair: { status: 'lovers' },
    extras: { [HOST]: {
      relationship_profiles: [{
        name: '준호',
        places_liked: '수영장, 전망대, 아쿠아리움, 보드게임 카페, 방탈출 카페, 특정 인물의 집, 캡슐호텔, 찜찔방, 목욕탕',
        places_disliked: '화장실, 한강',
        times_liked: '밤'.replace('밤', '늦저녁'),
        times_disliked: '',
        dates_liked: '등산, 서핑·수상 레저, 연극, 공연·콘서트, 뮤지컬, 게임, 보드게임, 스포츠(익스트림), 스포츠(레저), 조깅·러닝, 산책, 홈데이트',
        dates_disliked: '한옥거리',
        events_liked: '직접 만든 기념품, 직접 차린 식사, 깜짝 마중, 야경·별빛 서프라이즈',
        events_disliked: '축하 전화 릴레이',
        love_styles: '낭만적 사랑',
        birthday: '', sulk: '',
        basis: '활동적인 취향(캐릭터 로어).'
      }]
    } }
  });
  await runTurn(f, '준호의 집에서 아쿠아리움으로 놀러 가자고 말한다.');
  const sys = hostSystem(f);
  assert.match(sys, /WORLD ADAPTATION: adapt every place, date, and event concept to this story’s actual world/);
  assert.doesNotMatch(sys, /한강|한옥거리|명동|홍대|강남역|경복궁|창덕궁/);
  const prep = await f.host.plugin.debugRelationshipSimPrepare({
    recent: {
      latestUser: '준호의 집에 갔다.',
      visibleMessages: [{ role: 'assistant', content: '비가 내렸다.' }],
      runLineage: { runId: 'run-home', currentInputHash: '', priorAssistantHash: '' }
    }
  });
  assert.equal(prep.scene.place, 'someones_home', 'someone’s home beats generic home on overlap');
  const raw = f.values.get(LORE_KEY) ?? f.local.get(LORE_KEY);
  const card = Object.values((typeof raw === 'string' ? JSON.parse(raw) : raw).cards.romancePrefs || {}).flat()[0];
  assert.ok(card, 'expanded profile card is saved');
  assert.deepEqual(card.places.liked, ['pool', 'observatory', 'aquarium', 'boardgame_cafe', 'escape_room', 'someones_home', 'capsule_hotel', 'jjimjilbang', 'bathhouse']);
  assert.deepEqual(card.places.disliked, ['restroom', 'riverside']);
  assert.deepEqual(card.dates.liked, ['hiking', 'surfing', 'play', 'performance', 'musical', 'gaming', 'board_game', 'extreme_sports', 'leisure_sports', 'jogging', 'walk', 'home_date']);
  assert.deepEqual(card.dates.disliked, ['old_quarter']);
  assert.deepEqual(card.events.liked, ['handmade_keepsake', 'home_cooked_meal', 'surprise_waiting', 'night_sky_outing']);
  assert.deepEqual(card.events.disliked, ['call_relay']);
});

test('non-confession turns do not inject confession verdicts; date and event are distinguished accurately', async t => {
  const { f } = await start(t, { pair: { status: 'more_than_friend' } });

  // Casual conversation ("커피 좋아해?") must NOT trigger confession
  await runTurn(f, '커피 좋아해? 오늘 날씨 정말 좋다.');
  const casualSys = hostSystem(f);
  assert.doesNotMatch(casualSys, /FIXED OUTCOMES/);
  assert.doesNotMatch(casualSys, /makes a confession \(고백\)/);
  assert.match(casualSys, /ACTIVE RELATIONSHIP EVENTS THIS TURN: none detected/);

  // A date turn for a friend/more_than_friend pair detects date, not confession
  await runTurn(f, '이번 주말에 같이 영화 보러 데이트 갈래?');
  const dateSys = hostSystem(f);
  assert.match(dateSys, /FIXED OUTCOMES \(this turn — matched to detected act\(s\) only\):/);
  assert.match(dateSys, /makes a date \(데이트\) toward 준호/);
  assert.doesNotMatch(dateSys, /makes a confession \(고백\)/);

  // An event turn detects event, not confession
  await runTurn(f, '준호에게 몰래 준비한 깜짝 선물을 건넨다.');
  const eventSys = hostSystem(f);
  assert.match(eventSys, /makes a event \(이벤트\) toward 준호/);
  assert.doesNotMatch(eventSys, /makes a confession \(고백\)/);
});

test('memory relationship and emotion signals adjust event success probability', async t => {
  const { f } = await start(t, { pair: { status: 'friend' } });
  const baseInput = '준호에게 좋아한다고 고백한다.';
  const basePrep = await f.host.plugin.debugRelationshipSimPrepare({
    recent: {
      latestUser: baseInput,
      visibleMessages: [{ role: 'assistant', content: '준호가 고개를 들었다.' }],
      runLineage: { runId: 'mem-base', currentInputHash: '', priorAssistantHash: '' }
    }
  });
  const baseConfess = basePrep.verdicts.find(v => v.act === 'confession');

  const posPrep = await f.host.plugin.debugRelationshipSimPrepare({
    libEvidence: '[GRADIA EXTERNAL EVIDENCE]\n- 준호는 페르소나를 깊이 신뢰하고 비밀을 공유했다.\n- 준호는 페르소나를 볼 때마다 설레며 따뜻하게 웃었다.',
    recent: {
      latestUser: baseInput,
      visibleMessages: [{ role: 'assistant', content: '준호가 다정하게 미소 지었다.' }],
      runLineage: { runId: 'mem-pos', currentInputHash: '', priorAssistantHash: '' }
    }
  });
  const posConfess = posPrep.verdicts.find(v => v.act === 'confession');
  assert.ok(posConfess.percent > baseConfess.percent, `positive memory signals raise chance (${posConfess.percent} > ${baseConfess.percent})`);
  assert.ok(posConfess.factors.some(item => item.includes('기억 관계신호')));
  assert.ok(posConfess.factors.some(item => item.includes('기억 감정신호')));

  const negPrep = await f.host.plugin.debugRelationshipSimPrepare({
    libEvidence: '[GRADIA EXTERNAL EVIDENCE]\n- 준호는 페르소나의 거짓말에 배신감을 느끼고 크게 다퉜다.\n- 준호는 페르소나를 차갑고 냉담하게 경계했다.',
    recent: {
      latestUser: baseInput,
      visibleMessages: [{ role: 'assistant', content: '준호가 화가 나서 거리를 두었다.' }],
      runLineage: { runId: 'mem-neg', currentInputHash: '', priorAssistantHash: '' }
    }
  });
  const negConfess = negPrep.verdicts.find(v => v.act === 'confession');
  assert.ok(negConfess.percent < baseConfess.percent, `negative memory signals lower chance (${negConfess.percent} < ${baseConfess.percent})`);
  assert.ok(negConfess.factors.some(item => item.includes('기억 관계신호')));
  assert.ok(negConfess.factors.some(item => item.includes('기억 감정신호')));
});
