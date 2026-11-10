'use strict';
// A printed story clock survives from source text to the Classic block through the real hook,
// and text without a printed date and time produces no clock at all.
//
// Run: node tests/libra_story_clock_runtime_test.cjs
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const STAMP = '⏱️[2026-05-14 (목) 09:12 PM]';

(async () => {
  const f = await fixture();
  try {
    const clockOf = f.r.api.debugStoryClockFromText;
    assert.equal(clockOf(`${STAMP} *에어컨의 낮은 기계음*`), '2026-05-14 (목) 09:12 PM');
    assert.equal(clockOf('[2026-05-14 (Thu) 13:48 PM] 장면'), '2026-05-14 (Thu) 13:48 PM');
    assert.equal(clockOf('[2026-05-14 (목) 오후 7:15] 장면'), '2026-05-14 (목) 오후 7:15');
    assert.equal(clockOf('★[🔒 | 2026.06.12 (금) 09:58 | 📍부조정실 5F'), '2026.06.12 (금) 09:58');
    assert.equal(clockOf('본문\n[📖][⭐|다빈의 집 거실|8/3|day|pm 04:45|sunny]'), '8/3 day pm 04:45');
    assert.equal(clockOf('5월 14일 오후 9시 30분, 비가 왔다.'), '5월 14일 오후 9시 30분');
    // A bare time or a mentioned date does not establish when the turn happened.
    for (const text of ['민아는 2026년 5월 14일 오후 9시에 만나기로 했던 약속을 떠올렸다.', '2026년 5월 14일 오후 9시에 만나기로 했다.', '약속은 2026-05-14 21:12였다.', '"2026-05-14 21:12에 보자."', '그는 "2026-05-14 21:12"라고 적었다.']) {
      assert.equal(clockOf(text), '', text);
    }
    assert.equal(clockOf('민아는 2026년 5월 14일 오후 9시의 약속을 떠올렸다.\n⏱️[2026-06-01 (월) 10:00 AM]'), '2026-06-01 (월) 10:00 AM', 'a header later in the text still counts');
    assert.equal(clockOf('현재 시각: 2026-05-14 21:12'), '2026-05-14 21:12');
    assert.equal(clockOf('| 장소 | 서재 | 2026-05-14 21:12 |'), '2026-05-14 21:12');
    for (const text of ['10:30에 만나자고 했다.', '| 날짜 | 8월 3일 저녁 |', '3일 전 일이다.', '2026-05-14에 태어났다.', '', null]) {
      assert.equal(clockOf(text), '', String(text));
    }

    const assistant = f.chat.message.find(row => row.role === 'char' || row.role === 'assistant');
    assistant.data = `${STAMP} ${assistant.data}`;
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    await f.run();
    const memory = f.getMemory();
    assert.equal(memory.status, 'committed');
    assert.deepEqual(Object.values(memory.turnClocks), ['2026-05-14 (목) 09:12 PM'], 'only the stamped turn holds a clock');

    const stampedTurn = Number(Object.keys(memory.turnClocks)[0]);
    const stampedFact = memory.canonicalArtifact.facts.find(fact => fact.temporalRole === 'current_sequence'
      && fact.evidenceSpans.every(span => span.ref.startsWith(`t${stampedTurn}-`)));
    assert.ok(stampedFact, 'the fixture has a current fact evidenced only by the stamped turn');

    const out = await f.control.hooks.beforeRequest([{ role: 'system', content: '장면을 이어가세요.' },
      { role: 'user', content: stampedFact.text }], 'model');
    const block = out.find(row => row.content?.includes('[LIBRA CLASSIC RECALL'));
    assert.ok(block, 'Classic block delivered');
    assert.match(block.content, /the clock is the time printed/);
    assert.match(block.content, /\[@T\d+ \| 2026-05-14 \(목\) 09:12 PM\]\n- /);
    console.log('libra_story_clock_runtime_test: PASS');
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
