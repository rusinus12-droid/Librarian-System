'use strict';
// Memory recall searches with two queries: the current input (primary) and the recent scene
// (weighted). A short continuation ("그래서?") then finds the memory its scene is about, the
// current input still leads, a topic shift turns the scene lane off, and the dense lane reads
// the stored vectors once for both queries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createEngine = require('../tools/libra_state_memory_engine.cjs');
const createRuntime = require('../tools/libra_state_memory_runtime.cjs');

const engine = createEngine({ fingerprint: value => value });
const ref = (memoryId, turn, searchText) => ({ key: `m:${memoryId}`, memoryId, title: '', searchText, summary: searchText,
  searchTerms: [], recallTerms: [], turnRange: { start: turn, end: turn } });
const refs = [
  ref('key', 1, '민아가 은빛 열쇠를 지호에게 돌려주기로 약속했다'),
  ref('rain', 2, '지호가 비 오는 정원에서 우산을 찾았다'),
  ref('bread', 3, '도서관 사서가 빵을 나눠 주었다'),
  ref('lamp', 4, '등불이 꺼진 복도에서 발소리가 들렸다')
];
const SCENE = 'USER: 은빛 열쇠는 어떻게 됐어?\n\nASSISTANT: 민아는 은빛 열쇠를 꼭 쥐고 지호를 떠올렸다.';

test('a short continuation finds the memory its scene is about; the current input still leads', () => {
  const plain = engine.rankCatalog(refs, '그래서?', [], 2).map(row => row.memoryId);
  assert.equal(plain.includes('key'), false, 'without the scene the short input only gets recent memories');
  const withScene = engine.rankCatalog(refs, '그래서?', [], 2, { scene: { query: SCENE, weight: 0.55 } }).map(row => row.memoryId);
  assert.equal(withScene[0], 'key', 'the scene match outranks unrelated recent memories');
  const shifted = engine.rankCatalog(refs, '그래서?', [], 2, { scene: { query: SCENE, weight: 0 } }).map(row => row.memoryId);
  assert.deepEqual(shifted, plain, 'a zero-weight scene is the single-query ranking');
  const both = engine.rankCatalog(refs, '정원의 우산', [], 2, { scene: { query: SCENE, weight: 0.55 } }).map(row => row.memoryId);
  assert.deepEqual(both, ['rain', 'key'], 'the current input match leads, the scene match follows');
});

test('Micro screening fuses the scene matches before recency fills the rest', () => {
  const index = new Map([[1, '등불'], [2, '은빛 열쇠를 지호에게'], [3, '빵'], [4, '우산'], [5, '정원'], [6, '복도']]);
  const turns = [1, 2, 3, 4, 5, 6];
  const plain = engine.rankMicroTurns({ turns, index, query: '그래서?', limit: 3 });
  assert.deepEqual(plain.turns, [6, 5, 4]);
  const withScene = engine.rankMicroTurns({ turns, index, query: '그래서?', limit: 3, scene: { query: SCENE, weight: 0.55 } });
  assert.ok(withScene.turns.includes(2), 'the scene-matched turn is read');
  assert.equal(withScene.reasons[2], 'scene_match');
  assert.equal(withScene.matches, 0, 'completeness stays defined by the primary query');
  assert.equal(withScene.matchesRead, 0);
});

test('the runtime sends both queries to one dense scan and reports the scene lane', async () => {
  const calls = [];
  const frame = { head: null, refs, turns: [], settings: { stateCanonicalCandidates: 2 }, identity: 'id', owner: 'libra',
    scope: { scopeKey: 's' }, worldlineId: 'main', stateKey: 'state', check() {},
    async semantic(query) {
      calls.push(query);
      return { scores: new Map(), sceneScores: new Map([['m:key', 0.9]]), diagnostics: { status: 'ready', sceneQuery: 'ready' } };
    },
    async canonical(row) { return { key: row.key, proofs: [], rows: [{ id: row.memoryId, family: 'canonical', axis: 'world',
      text: row.searchText, turn: row.turnRange.end, sourceKey: row.key }] }; },
    register() { return 'token'; }, async assertCurrent() {}, release() {} };
  const runtime = createRuntime({ engine, capture: async () => frame, fingerprint: value => value, authorityStore: new Map() });
  const result = await runtime.query({ queryInput: { queryText: '그래서?', sceneText: SCENE, sceneWeight: 0.55 } });
  assert.equal(calls.length, 1, 'one semantic call carries both queries');
  assert.deepEqual(calls[0], { text: '그래서?', sceneText: SCENE, sceneWeight: 0.55 });
  assert.deepEqual(result.diagnostics.sceneQuery, { used: true, weight: 0.55, characters: SCENE.length, semantic: 'ready', microMatches: 0 });
  assert.ok(result.bundle.items.some(item => item.id === 'key'), 'the scene-matched memory is delivered');
  runtime.release(result);

  calls.length = 0;
  const shifted = await runtime.query({ queryInput: { queryText: '그래서?', sceneText: SCENE, sceneWeight: 0 } });
  assert.deepEqual(calls, ['그래서?'], 'a topic shift keeps the single-query call');
  assert.deepEqual(shifted.diagnostics.sceneQuery, { used: false });
  runtime.release(shifted);
});

test('the request hook passes the recent scene for a short input and drops it on a topic shift', async t => {
  const { fixture } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
  const x = await fixture({ mode: 'plugin_only', pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  await x.f.control.hooks.beforeRequest([{ role: 'user', content: '그래서?' }], 'model');
  const short = x.f.r.core.getLastRecall()?.unifiedExecution?.diagnostics?.sceneQuery;
  assert.equal(short?.used, true, 'a short continuation searches with its scene');
  assert.ok(short.weight >= 0.45);
  await x.f.control.hooks.beforeRequest([{ role: 'user', content: '한편 완전히 다른 이야기를 해 보자.' }], 'model');
  assert.equal(x.f.r.core.getLastRecall()?.unifiedExecution?.diagnostics?.sceneQuery?.used, false, 'a topic shift searches without the scene');
});
