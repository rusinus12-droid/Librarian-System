'use strict';
// 수면 상태 지속·유저 행동 우선·증거 범위 회귀.
// 실측 결함 3건: ① 창을 벗어나면 잠 상태가 사라짐 ② 유저가 이미 깨웠는데 "자고 있다"로 확정
// ③ 다른 인물의 술이 이 인물의 수면 깊이를 올림.
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture } = require('../fixtures/gradia_input_writer_unified_fixture.cjs');

const settings = { writingMode: 'rp', rpImpersonationScope: 'persona', enableBodyStateAide: true, mode: 'normal' };
const sleepLine = packet => String(packet).split('\n').filter(l => /sleep state:/.test(l)).join(' | ');

const packetFor = (f, scopeKey, recent) => f.host.plugin.debugBodyStatePacket({
  personaName: '하준', characterName: '세라', scopeKey, recent, settings
});

test('a sleeping NPC stays asleep after the onset line leaves the recent window', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const first = packetFor(f, 'sleep-cont', {
    latestUser: '조용히 방을 나선다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 침대에 누워 고른 숨소리를 내며 잠들었다.' }]
  });
  assert.match(sleepLine(first), /sleep state: asleep/);

  const later = packetFor(f, 'sleep-cont', {
    latestUser: '창문을 연다.',
    visibleMessages: [
      { role: 'assistant', content: '세라는 뒤척이지 않았다.' },
      { role: 'user', content: '물잔을 내려놓는다.' },
      { role: 'assistant', content: '방은 조용했다.' },
      { role: 'user', content: '의자에 앉는다.' },
      { role: 'assistant', content: '밤이 깊어졌다.' },
      { role: 'user', content: '시계를 본다.' }
    ]
  });
  assert.match(sleepLine(later), /carried from the earlier turn/, 'the sleep state is remembered, not dropped');
  assert.match(sleepLine(later), /stays asleep/);
});

test('a waking the player already wrote ends the sleep state with no roll', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  packetFor(f, 'sleep-wake', {
    latestUser: '조용히 방을 나선다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 깊이 잠들어 있었다.' }]
  });
  const woke = packetFor(f, 'sleep-wake', {
    latestUser: '세라를 흔들어 깨운다. 세라는 눈을 뜬다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 깊이 잠들어 있었다.' }]
  });
  assert.equal(sleepLine(woke), '', 'no fixed sleep verdict is issued against a completed waking');
});

test('a mere attempt to wake keeps the verdict but does not end the sleep state', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  packetFor(f, 'sleep-try', {
    latestUser: '조용히 방을 나선다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 잠들었다.' }]
  });
  const attempt = packetFor(f, 'sleep-try', {
    latestUser: '세라를 깨우려고 어깨를 흔든다.',
    visibleMessages: [{ role: 'assistant', content: '세라는 잠들었다.' }]
  });
  assert.match(sleepLine(attempt), /sleep state: asleep/);
  assert.match(sleepLine(attempt), /wake chance/);
});

test("another person's drink does not deepen this sleeper", async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const packet = packetFor(f, 'sleep-aid', {
    latestUser: '세라의 볼을 살짝 만진다.',
    visibleMessages: [
      { role: 'assistant', content: '세라는 침대에 누워 잠들었다.' },
      { role: 'assistant', content: '거실에서는 민수가 소주를 마시고 있다.' }
    ]
  });
  const line = sleepLine(packet);
  assert.match(line, /asleep/);
  assert.doesNotMatch(line, /알코올/, "someone else's alcohol is not this character's sleep aid");
});
