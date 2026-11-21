'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

test('LIBRA runtime omits visible SCENE DETAILS and fully-visible RECORDED HISTORY while keeping State, RECENT CHANGES, partial spans, and PERSPECTIVE NOTES', async () => {
  const engine = require('../tools/libra_state_memory_engine.cjs')({ fingerprint: value => value });
  const microRows = {
    1: [{ id: 'm1', family: 'micro', axis: 'world', turn: 1, sourceKey: 'micro1', text: '1턴 창고에서 은빛 열쇠를 처음 발견했다.' }],
    2: [{ id: 'm2', family: 'micro', axis: 'world', turn: 2, sourceKey: 'micro2', text: '2턴 도서관에서 지호가 은빛 열쇠를 빌려 갔다.' }],
    3: [{ id: 'm3', family: 'micro', axis: 'world', turn: 3, sourceKey: 'micro3', text: '3턴 서재에서 민아가 은빛 열쇠를 돌려받아 서랍에 넣었다.' }]
  };
  const canonicalRows = {
    'c1-2': [{ id: 'c12', family: 'canonical', axis: 'narrative', turn: 2, turnStart: 1, sourceKey: 'c1-2', text: '1~2턴 구간 요약: 열쇠를 발견해 지호가 보관했다.' }],
    'c2-2': [{ id: 'c22', family: 'canonical', axis: 'narrative', turn: 2, turnStart: 2, sourceKey: 'c2-2', text: '2턴 단독 구간 요약: 지호가 열쇠를 잠시 챙겼다.' }]
  };
  const readMicroTurns = [];
  const readCanonicalKeys = [];
  const frame = {
    head: { throughTurn: 2, world: [{ id: 'key', name: '은빛 열쇠', holderRef: '지호', resolvedTurn: 2 }] },
    refs: [
      { key: 'c1-2', memoryId: 'c1-2', revision: 1, turnRange: { start: 1, end: 2 }, searchText: '은빛 열쇠 발견 지호' },
      { key: 'c2-2', memoryId: 'c2-2', revision: 1, turnRange: { start: 2, end: 2 }, searchText: '은빛 열쇠 지호 챙겼다' }
    ],
    turns: [1, 2, 3],
    settings: {},
    identity: 'snapshot',
    owner: 'libra',
    scope: { scopeKey: 'scope' },
    worldlineId: 'main',
    stateKey: 'state',
    stateAuthority: { current: true, pending: false },
    check() {},
    async canonical(ref) { readCanonicalKeys.push(ref.key); return { key: ref.key, proofs: [], rows: canonicalRows[ref.key] || [] }; },
    async micro(turn) { readMicroTurns.push(turn); return microRows[turn] ? { key: 'micro' + turn, proofs: [], rows: microRows[turn] } : null; },
    async lens() {
      return {
        key: 'lens1', proofs: [],
        rows: [{ id: 'l2', family: 'lens', axis: 'narrative', turn: 2, sourceKey: 'lens1', text: '[약속 추적] 지호가 열쇠를 오늘 돌려주기로 약속했다.', lensItem: { itemId: 'li1', floorPassed: true } }],
        delivery: { injectedItems: [] }
      };
    },
    register() { return 'token'; },
    async assertCurrent() {},
    release() {}
  };
  const runtime = require('../tools/libra_state_memory_runtime.cjs')({ engine, capture: async () => frame, fingerprint: value => value, authorityStore: new Map() });
  // Turns 2 and 3 are visible in the current request; turn 1 is scrolled out.
  // State is only through turn 2, so turn 3 is a RECENT CHANGE and MUST stay even though turn 3 is visible.
  const result = await runtime.query({ queryText: '은빛 열쇠', visibleTurns: [2, 3] });
  const rendered = result.packet.renderedText;

  assert.match(rendered, /\[CURRENT STATE — how things stand now\]\n- 은빛 열쇠 — 소지자: 지호/, 'CURRENT STATE stays');
  assert.match(rendered, /\[RECENT CHANGES · newer than CURRENT STATE[^\]]*\]\n- 3턴 서재에서 민아가 은빛 열쇠를 돌려받아 서랍에 넣었다\./, 'RECENT CHANGES stays even when turn 3 is visible');
  assert.match(rendered, /1~2턴 구간 요약/, 'partially visible canonical span (T1..T2) stays so T1 is not lost');
  assert.doesNotMatch(rendered, /2턴 단독 구간 요약/, 'fully visible canonical span (T2..T2) is omitted');
  assert.match(rendered, /\[PERSPECTIVE NOTES[^\]]*\]\n- \[약속 추적\]/, 'PERSPECTIVE NOTES stays');
  assert.match(rendered, /1턴 창고에서 은빛 열쇠를 처음 발견했다\./, 'non-visible older micro turn (T1) stays');
  assert.doesNotMatch(rendered, /2턴 도서관에서 지호가 은빛 열쇠를 빌려 갔다\./, 'visible micro turn (T2) already in State is omitted');
  assert.ok(!readMicroTurns.includes(2), 'visible micro turn 2 is not even fetched');
  assert.ok(!readCanonicalKeys.includes('c2-2'), 'fully visible canonical c2-2 is not even fetched');
  assert.deepEqual(result.diagnostics.recentChatExcluded.visibleTurns, [2, 3]);
  assert.equal(result.diagnostics.recentChatExcluded.excludedCanonicalRefs, 1);
  assert.equal(result.diagnostics.recentChatExcluded.excludedMicroTurns, 1);
  assert.equal(result.diagnostics.recentChatExcluded.excludedCount, 2);
  assert.equal(result.diagnostics.recentChatExcluded.items.length, 2);
  assert.equal(result.diagnostics.recentChatExcluded.items[0].family, 'canonical');
  assert.equal(result.diagnostics.recentChatExcluded.items[1].family, 'micro');
  runtime.release(result);

  // When State catches up to turn 3, turn 3 is no longer a RECENT CHANGE and is now omitted too.
  frame.head.throughTurn = 3;
  const caughtUp = await runtime.query({ queryText: '은빛 열쇠', visibleTurns: [2, 3] });
  assert.doesNotMatch(caughtUp.packet.renderedText, /RECENT CHANGES/);
  assert.doesNotMatch(caughtUp.packet.renderedText, /3턴 서재에서 민아가/);
  assert.equal(caughtUp.diagnostics.recentChatExcluded.excludedMicroTurns, 2);
  assert.equal(caughtUp.diagnostics.recentChatExcluded.excludedCount, 3);
  runtime.release(caughtUp);
});

test('HAYAKU beforeRequest omits visible-turn events and verbatim excerpts (by memo and text fallback) while keeping state, scene head, and protected lanes', async () => {
  const h = await createHayakuRuntime({
    autoRepair: false,
    arguments: { memory_suite_server_mode: 'plugin_only', hayaku_packet_recovery: 'false' }
  });
  try {
    // Turn 1 (scrolled out of request window): old event + old rule.
    const p1 = createValidPacket({ turn: 1, scene: 'scene-vault', subject: '민아', summary: '1턴 지하 금고에서 낡은 지도를 발견했다.' });
    p1.world.active_events = [{ id: 'ev-old', summary: '1턴 지하 금고에서 낡은 지도를 발견했다.' }];
    p1.narrative.scene_deltas = [{ id: 'sd-old', summary: '1턴 지하 금고에서 낡은 지도를 발견했다.' }];
    p1.world.world_rules = [{ id: 'rule-old', summary: '금고 문은 자정에 자동으로 잠긴다.' }];
    p1.world.historical_events = [{ id: 'ev-shared-1', summary: '공통 사건: 은빛 열쇠가 자정에 울렸다.' }];

    // Turn 2 (visible in request window): event + state + protected constraints/knowledge/prohibited.
    const p2 = createValidPacket({ turn: 2, scene: 'scene-vault', subject: '민아', summary: '2턴 복도 장면 진행 중.' });
    p2.world.active_events = [{ id: 'ev-recent', summary: '2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다.' }];
    p2.narrative.scene_deltas = [{ id: 'sd-recent', summary: '2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다.' }];
    p2.world.historical_events = [{ id: 'ev-shared-2', summary: '공통 사건: 은빛 열쇠가 자정에 울렸다.' }];
    p2.entity.characters = [{ id: 'char-mina', name: '민아', current_state: '서재에서 은빛 열쇠를 쥐고 있다.' }];
    p2.meta.speaker_boundaries = [{ id: 'sb-1', speaker: '지호', summary: '지호는 열쇠가 복제품이라는 비밀을 숨기고 있다.' }];
    p2.planner.continuity_locks = [{ id: 'lock-1', summary: '은빛 열쇠의 출처는 아직 밝히지 않는다.' }];
    p2.meta.overpromotion_risks = [{ id: 'risk-1', summary: '민아가 비밀을 이미 안다고 단정하지 말 것.' }];

    const longTurn2Text = '2턴 복도 바닥에 떨어진 은빛 열쇠를 민아가 조심스레 주워 들었다. 차가운 금속 표면에 낯선 문양이 새겨져 있었고, 복도 끝에서는 희미한 발소리가 들려왔다.';
    const msg1User = { role: 'user', data: '지하 금고를 조사해보자.', chatId: 'cid-u1' };
    const msg1Asst = { role: 'char', data: hiddenPacketMessage('1턴 지하 금고 바닥에서 낡은 지도를 찾아 가방에 넣었다.', p1), chatId: 'cid-a1' };
    const msg2User = { role: 'user', data: '복도로 나가서 열쇠를 확인하자.', chatId: 'cid-u2' };
    const msg2Asst = { role: 'char', data: hiddenPacketMessage(longTurn2Text, p2), chatId: 'cid-a2' };
    h.setMessages([msg1User, msg1Asst, msg2User, msg2Asst]);

    // Case A: Request shows only Turn 2 with RisuAI memo === chatId ('cid-a2').
    const reqWithMemo = [
      { role: 'user', content: msg2User.data, memo: 'cid-u2' },
      { role: 'assistant', content: longTurn2Text, memo: 'cid-a2' },
      { role: 'user', content: '은빛 열쇠와 지도, 지호의 비밀을 다시 살펴보자.' }
    ];
    const outMemo = await h.callBeforeRequest(reqWithMemo, 'model');
    const injectedMemo = outMemo.filter(m => !reqWithMemo.includes(m)).map(m => String(m.content || '')).join('\n');
    const evidenceStartMemo = injectedMemo.indexOf('[SOURCE MEMORY RECORDS');
    assert.ok(evidenceStartMemo > 0, 'HAYAKU injects recalled evidence');
    const sceneHeadMemo = injectedMemo.slice(0, evidenceStartMemo);
    const evidenceBodyMemo = injectedMemo.slice(evidenceStartMemo);

    assert.match(sceneHeadMemo, /\[HAYAKU 활성 장면 헤드\]/, 'ACTIVE SCENE HEAD stays');
    assert.doesNotMatch(evidenceBodyMemo, /2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다/, 'visible turn 2 event is omitted from recalled evidence');
    assert.match(evidenceBodyMemo, /1턴 지하 금고에서 낡은 지도를 발견했다/, 'older non-visible turn 1 event stays');
    assert.match(evidenceBodyMemo, /공통 사건: 은빛 열쇠가 자정에 울렸다/, 'merged entry with a non-visible origin (T1) stays');
    assert.match(evidenceBodyMemo, /서재에서 은빛 열쇠를 쥐고 있다/, 'LATEST VALID STATE from turn 2 stays');
    assert.match(evidenceBodyMemo, /은빛 열쇠의 출처는 아직 밝히지 않는다/, 'UNRESOLVED CONSTRAINTS from turn 2 stays');
    assert.match(evidenceBodyMemo, /지호는 열쇠가 복제품이라는 비밀을 숨기고 있다/, 'KNOWLEDGE BOUNDARIES from turn 2 stays');
    assert.match(evidenceBodyMemo, /민아가 비밀을 이미 안다고 단정하지 말 것/, 'PROHIBITED INFERENCES from turn 2 stays');
    const dbgMemo = h.hayaku.lastDebug();
    assert.deepEqual(Array.from(dbgMemo.recentChatDedup.visibleTurns), [2]);
    assert.ok(dbgMemo.recentChatDedup.droppedUnits >= 1);
    assert.ok(Array.from(dbgMemo.recentChatDedup.items).some(item => /2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다/.test(item.preview)), 'excluded item preview is recorded for viewer');
    assert.ok(h.hayaku.lastRecall().recentChatDedup.items.length >= 1, 'viewer recall exposes excluded items');

    // Case B: Request shows Turn 2 WITHOUT memo (fallback to raw assistant text comparison).
    const reqNoMemo = [
      { role: 'user', content: msg2User.data },
      { role: 'assistant', content: longTurn2Text },
      { role: 'user', content: '은빛 열쇠와 지도, 지호의 비밀을 다시 살펴보자.' }
    ];
    const outNoMemo = await h.callBeforeRequest(reqNoMemo, 'model');
    const injectedNoMemo = outNoMemo.filter(m => !reqNoMemo.includes(m)).map(m => String(m.content || '')).join('\n');
    const evidenceBodyNoMemo = injectedNoMemo.slice(injectedNoMemo.indexOf('[SOURCE MEMORY RECORDS'));

    assert.doesNotMatch(evidenceBodyNoMemo, /2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다/, 'visible turn 2 event is omitted via raw-text fallback');
    assert.match(evidenceBodyNoMemo, /1턴 지하 금고에서 낡은 지도를 발견했다/, 'older non-visible turn 1 event stays on fallback');
    assert.deepEqual(Array.from(h.hayaku.lastDebug().recentChatDedup.visibleTurns), [2]);

    // Case C: Safeguard — memo matches 'cid-a2', but body is heavily truncated (<50% of stored length).
    // Fail-safe: turn 2 is NOT excluded so recall is preserved.
    const reqTruncated = [
      { role: 'user', content: msg2User.data, memo: 'cid-u2' },
      { role: 'assistant', content: '[생략됨]', memo: 'cid-a2' },
      { role: 'user', content: '은빛 열쇠와 지도, 지호의 비밀을 다시 살펴보자.' }
    ];
    const outTrunc = await h.callBeforeRequest(reqTruncated, 'model');
    const injectedTrunc = outTrunc.filter(m => !reqTruncated.includes(m)).map(m => String(m.content || '')).join('\n');
    const evidenceBodyTrunc = injectedTrunc.slice(injectedTrunc.indexOf('[SOURCE MEMORY RECORDS'));
    assert.match(evidenceBodyTrunc, /2턴 복도에서 은빛 열쇠를 떨어뜨려 주웠다/, 'safeguard keeps turn 2 event when memo-matched body is heavily truncated');
    assert.deepEqual(Array.from(h.hayaku.lastDebug().recentChatDedup.visibleTurns), []);
  } finally {
    await h.dispose();
  }
});
