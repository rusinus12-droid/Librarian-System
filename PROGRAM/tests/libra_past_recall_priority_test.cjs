'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createEngine = require('../tools/libra_state_memory_engine.cjs');
const createRuntime = require('../tools/libra_state_memory_runtime.cjs');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const fingerprint = val => crypto.createHash('sha256').update(String(val)).digest('hex').slice(0, 16);

test('allocationPlan defaults to 30% lens / 70% evidence, lowers State caps by intent/HAYAKU, and spills leftover budget to past memories first', () => {
  const engine = createEngine({ fingerprint });
  const mixed = engine.allocationPlan('은빛 열쇠 약속');
  assert.equal(mixed.lensSharePercent, 30);
  assert.equal(mixed.evidenceSharePercent, 70);
  assert.equal(mixed.peerStateActive, false);
  assert.equal(mixed.stateShareOfEvidence, 0.28);

  const mixedWithHayaku = engine.allocationPlan('은빛 열쇠 약속', 30, { peerStateActive: true });
  assert.equal(mixedWithHayaku.peerStateActive, true);
  assert.equal(mixedWithHayaku.stateShareOfEvidence, 0.18);

  const hist = engine.allocationPlan('은빛 열쇠의 과거 경위');
  assert.equal(hist.intent, 'history');
  assert.equal(hist.stateShareOfEvidence, 0.18);

  const histWithHayaku = engine.allocationPlan('은빛 열쇠의 과거 경위', 30, { peerStateActive: true });
  assert.equal(histWithHayaku.stateShareOfEvidence, 0.12);

  // Unused lens share should go to relevant canonical/micro memories before extra lens/state rows.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`, family: 'state', axis: 'characters',
      text: `민아 — 메모${i}: 은빛 열쇠 약속 관련 기록 ${i}`,
      promptText: `민아 — 메모${i}: 은빛 열쇠 약속 관련 기록 ${i}`,
      entityGroupKey: `characters:인물${i}`, turn: 5
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`, family: 'canonical', axis: 'narrative',
      text: `과거 사건 ${i}: 민아가 은빛 열쇠 약속을 남겼다.`,
      evidenceKeys: [`canonical:m1:1:f${i}`], turn: i + 1
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`, family: 'micro', axis: 'world',
      text: `당시 대사 ${i}: "은빛 열쇠 약속은 반드시 지킨다."`,
      evidenceKeys: [`micro:rev1:c${i}`], turn: i + 1
    })),
    {
      id: 'l0', family: 'lens', axis: 'narrative',
      text: '해석 0: 민아는 은빛 열쇠 약속을 중시했다.',
      lensItem: { lensId: 'l1', groupKey: 'g0', floorPassed: true }, turn: 3
    }
  ];
  const result = engine.select({ rows, query: '은빛 열쇠 약속', maxItems: 20, maxCharacters: 8000, minimumPerAxis: 0, plan: mixed });
  const counts = result.items.reduce((acc, r) => { acc[r.family] = (acc[r.family] || 0) + 1; return acc; }, {});
  assert.ok((counts.canonical || 0) + (counts.micro || 0) >= 12, `past records should lead selection: ${JSON.stringify(counts)}`);
  assert.ok((counts.state || 0) <= 5, `state lead should stay bounded on mixed queries: ${JSON.stringify(counts)}`);
});

test('rankCatalog surfaces old non-anchored canonical matches ahead of unmatched State anchors while keeping 0-match fallback order', () => {
  const engine = createEngine({ fingerprint });
  const state = [{ evidence: { memoryId: 'mem_recent_state' } }];
  const refs = [
    { key: 'k_anchor', memoryId: 'mem_recent_state', turnRange: { start: 40, end: 42 }, title: '최근 식사', summary: '점심 메뉴를 정했다.', searchText: '점심 메뉴 정함' },
    { key: 'k_old', memoryId: 'mem_old_secret', turnRange: { start: 3, end: 5 }, title: '봉인된 서약', summary: '검은 탑의 암호를 해독했다.', searchText: '검은 탑 암호 해독 서약' }
  ];
  const ranked = engine.rankCatalog(refs, '검은 탑의 암호', state, 1);
  assert.equal(ranked[0].key, 'k_old', 'matching old non-State canonical memory must outrank unmatched State anchor');

  // When query has 0 lexical/entity/semantic overlap, State anchor retains its fallback tie-breaker.
  const unmatched = engine.rankCatalog(refs, '전혀없는외래어키워드xyz', state, 1);
  assert.equal(unmatched[0].key, 'k_anchor');
});

test('rankMicroTurns frees candidate slots for past index_match search instead of giving half to state_evidence', () => {
  const engine = createEngine({ fingerprint });
  const turns = Array.from({ length: 20 }, (_, i) => i + 1);
  const index = new Map(turns.map(turn => [turn,
    [2, 3, 4, 5, 6, 7].includes(turn)
      ? `오래전 지하실 비밀 암호 해독 기록 ${turn}`
      : `일상적인 복도 대화 ${turn}`]));
  const evidenceTurns = [14, 15, 16, 17, 18];

  const mixed = engine.rankMicroTurns({ turns, index, query: '지하실 비밀 암호', evidenceTurns, limit: 8, intent: 'mixed' });
  const mixedIndexMatches = Object.values(mixed.reasons).filter(r => r === 'index_match').length;
  assert.ok(mixedIndexMatches >= 5, `expected >= 5 index_match turns on mixed, got ${mixedIndexMatches}: ${JSON.stringify(mixed.reasons)}`);

  const history = engine.rankMicroTurns({ turns, index, query: '지하실 비밀 암호', evidenceTurns, limit: 8, intent: 'history' });
  const histIndexMatches = Object.values(history.reasons).filter(r => r === 'index_match').length;
  assert.ok(histIndexMatches >= 6, `expected >= 6 index_match turns on history, got ${histIndexMatches}: ${JSON.stringify(history.reasons)}`);
});

test('runtime trims irrelevant axisFloorFiller State and lens notes before relevant past memories under character cap', async () => {
  const engine = createEngine({ fingerprint });
  const frame = {
    head: {
      throughTurn: 10,
      characters: [{ id: 'c1', name: '준호', state: { mood: '평온' } }],
      relationships: [{ id: 'r1', name: '관계', subjectId: 'c1', state: { dynamic: '거리감 있음' } }],
      world: [{ id: 'w1', name: '별관', state: { condition: '낡은 목조 건물로 창문이 닫혀 있다' } }],
      narrative: { summary: '전체 서사 요약으로 현재 상황은 고요하게 유지되고 있다.' }
    },
    refs: [{ key: 'ref:1', memoryId: 'm1', turnRange: { start: 1, end: 2 }, title: '암호 약속', summary: '은빛 열쇠 암호를 맞췄다.' }],
    turns: [1],
    settings: { stateMinimumPerAxis: 1, recallMaxChars: 8000, stateMaxItems: 24 },
    identity: 'snap1', owner: 'libra', scope: { scopeKey: 's1' }, worldlineId: 'main', stateKey: 'state',
    check() {},
    async canonical(ref) {
      return {
        key: ref.key, proofs: [],
        rows: [{ id: 'can:1', family: 'canonical', axis: 'narrative', turn: 2, sourceKey: ref.key,
          evidenceKeys: ['canonical:m1:1:f1'],
          text: '민아는 과거에 은빛 열쇠의 비밀 암호를 서재 뒤편에 기록해 두었다.' }]
      };
    },
    async micro() {
      return {
        key: 'micro:1', proofs: [],
        rows: [{ id: 'mic:1', family: 'micro', axis: 'narrative', turn: 1, sourceKey: 'micro:1',
          evidenceKeys: ['micro:rev1:c1'],
          text: '준호는 "그 비밀 암호는 비 오는 날에만 열린다"라고 말했다.' }]
      };
    },
    async lens() {
      return {
        key: 'lens:1', proofs: [], delivery: {},
        rows: [{ id: 'len:1', family: 'lens', axis: 'world', turn: 5, sourceKey: 'lens:1',
          text: '해석 노트: 별관 주변에는 은빛 열쇠와 얽힌 불길한 기운이 오랫동안 감돌고 있다.',
          lensItem: { lensId: 'l1', groupKey: 'g1', floorPassed: true } }]
      };
    },
    register() { return 'tok'; }, async assertCurrent() {}, release() {}
  };
  const runtime = createRuntime({ engine, capture: async () => frame, fingerprint, authorityStore: new Map() });
  // Tight budget that cannot hold every axis filler + lens + both relevant past memories at once.
  const result = await runtime.query({ queryText: '은빛 열쇠 비밀 암호', consumerPolicy: { maxCharacters: 420, maxUnits: 12 } });
  assert.ok(result.packet.renderedText.includes('비밀 암호를 서재 뒤편에 기록해 두었다'), 'relevant canonical memory survives trimming');
  assert.ok(result.packet.renderedText.includes('비 오는 날에만 열린다'), 'relevant micro memory survives trimming');
  assert.ok(result.packet.characterLength <= 420);
  runtime.release(result);
});

test('LIBRA defaults to 30% lens share and auto-tightens State caps when HAYAKU peer block is active in messages', async t => {
  const f = await fixture();
  t.after(() => f.r.cleanup());
  await f.run();
  const settings = await f.r.api.getLibraMemorySettings();
  assert.equal(settings.recallLensSharePercent, 30);

  const hayakuPeer = {
    role: 'system',
    content: '[HAYAKU ACTIVE SCENE HEAD]\n- Scene identity: 서재\n앞서 확립된 정황:\n- summary: 현재 민아가 서재에서 대기 중이다.\n[HAYAKU RUNTIME PACKET SHAPE]\nEmit one packet.\n[/HAYAKU RUNTIME PACKET SHAPE]'
  };
  const out = await f.control.hooks.beforeRequest([hayakuPeer, { role: 'user', content: '은빛 열쇠의 과거 경위는 어떻게 됐어?' }], 'model');
  assert.ok(out.some(row => row.role === 'system' && String(row.content).includes('<LIBRA_CLASSIC_RECALL>')));
  const plan = f.r.api.getLastMemoryRecallViewer()?.recallDiagnostics?.allocationPlan;
  assert.equal(plan?.lensSharePercent, 30);
  assert.equal(plan?.peerStateActive, true);
  assert.equal(plan?.stateShareOfEvidence, 0.12);
  assert.equal(f.r.api.getRuntime().lastMemoryInjectionMeta.finalVerification.status, 'verified');
});
