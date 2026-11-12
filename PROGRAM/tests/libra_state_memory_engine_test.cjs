'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex');
const create = require('../tools/libra_state_memory_engine.cjs');
const modes = require('../tools/libra_memory_engine_mode.cjs');
const engine = create({ fingerprint });

test('narrative metadata never becomes a fact or a nested prompt fragment', () => {
  const evidence = { memoryId:'m', revision:1, assertionIds:['a'], turn:4 };
  const rows = engine.stateRows({ throughTurn:5, narrative: {
    evidenceSpans:[{ref:'t1-a',quote:'structural quote'}],
    threads:[{id:'thread',title:'연락',summary:'예주에게 연락할지 고민한다.',firstTurn:1,lastTurn:4,
      evidenceSpans:[{ref:'t1-a',quote:'structural quote'}],evidence,
      notes:{text:'아직 결정하지 않았다.',firstTurn:1,evidenceRefs:['ref']} }]
  } });
  assert.ok(rows.some(row => row.promptText.includes('예주에게 연락')));
  assert.ok(rows.every(row => !/firstTurn|lastTurn|evidenceSpans|evidenceRefs|structural quote/.test(row.text + row.promptText)));
  assert.equal(rows.find(row => row.factText.includes('예주')).evidence, evidence);
});

test('unrelated State authority cannot outrank a directly matching Micro', () => {
  const result = engine.select({ rows:[
    {id:'old',family:'state',axis:'narrative',text:'낡은 시계는 멈췄다.'},
    {id:'match',family:'micro',axis:'narrative',text:'예주 연락처를 골랐다.'}
  ],query:'예주 연락처',maxItems:1,minimumPerAxis:0,plan:engine.allocationPlan('예주 연락처') });
  assert.equal(result.items[0].id,'match');
});

test('lens question matches precede bounded scene notes without deleting distinct people', () => {
  const note=(id,group,floorPassed,text)=>({id,family:'lens',axis:'characters',text,
    lensItem:{lensId:'health',groupKey:group,floorPassed}});
  const rows=[note('weak1','a',false,'민아의 상태'),note('weak2','a',false,'민아의 지난 상태'),
    note('other','b',false,'준호의 상태'),note('match','a',true,'연락처는 예주에게 있다.')];
  const result=engine.select({rows,query:'예주 연락처',maxItems:8,plan:engine.allocationPlan('예주 연락처')});
  assert.equal(result.items[0].id,'match');
  assert.equal(result.items.filter(row=>row.lensItem.groupKey==='a' && !row.lensItem.floorPassed).length,1);
  assert.ok(result.items.some(row=>row.id==='other'));
});

test('mixed questions suppress exact facts only with shared evidence; history keeps source wording', () => {
  const rows=[{id:'state',family:'state',axis:'narrative',text:'연락 — 요약: 예주에게 연락한다.',factText:'예주에게 연락한다.',evidenceKeys:['fact']},
    {id:'copy',family:'canonical',axis:'narrative',text:'예주에게 연락한다.',evidenceKeys:['fact']},
    {id:'distinct',family:'micro',axis:'narrative',text:'예주에게 연락한다.',evidenceKeys:['other']}];
  const result=engine.select({rows,query:'예주 연락',plan:engine.allocationPlan('예주 연락')});
  assert.equal(result.items.filter(row=>row.id==='state'||row.id==='copy').length,1);
  assert.ok(result.items.some(row=>row.id==='distinct'));
  const history=engine.select({rows:rows.slice(0,2),query:'예전 연락 경위',plan:engine.allocationPlan('예전 연락 경위')});
  assert.equal(history.items.length,2);
});

test('an older semantic match gets a bounded catalog slot even when State anchors fill the sparse shortlist', () => {
  const refs=Array.from({length:10},(_,n)=>({key:'doc-'+n,memoryId:'memory-'+n,summary:'기억 '+n,turnRange:{end:n+1}}));
  const state=refs.slice(2).map(ref=>({evidence:{memoryId:ref.memoryId}}));
  const sparse=engine.rankCatalog(refs,'auxiliary entrance',state,4);
  assert.equal(sparse.some(ref=>ref.key==='doc-0'),false);
  const hybrid=engine.rankCatalog(refs,'auxiliary entrance',state,4,{semanticScores:new Map([['doc-0',1]])});
  assert.equal(hybrid.length,4);
  assert.ok(hybrid.some(ref=>ref.key==='doc-0'));
  assert.ok(hybrid.some(ref=>ref.memoryId!=='memory-0'));
});

test('lens reserves 40% while the remaining 60% follows the question instead of fixed source shares', () => {
  const rows = ['lens','canonical','micro','state'].flatMap(family => Array.from({ length: 30 }, (_, n) => ({
    id: family + n, family, axis: 'world', text: family + ' 은빛 열쇠 ' + n
  })));
  // Relevant State always leads the evidence share; a history or detail question keeps two thirds for its records.
  for (const [query, intent, family, stateLead] of [['열쇠 지금 보유자', 'current', 'state', 12], ['열쇠 과거 경위', 'history', 'canonical', 4], ['열쇠 정확한 발언', 'detail', 'micro', 4]]) {
    const plan = engine.allocationPlan(query);
    const result = engine.select({ rows, query, maxItems: 20, maxCharacters: 10000, plan });
    assert.equal(plan.intent, intent);
    assert.equal(result.items.filter(row => row.family === 'lens').length, 8);
    const evidence = result.items.filter(row => row.family !== 'lens');
    assert.deepEqual(evidence.slice(0, stateLead).map(row => row.family), Array(stateLead).fill('state'), intent + ': State leads');
    assert.equal(result.items.filter(row => row.family === 'state').length, stateLead);
    assert.equal(result.items.filter(row => row.family === family).length, family === 'state' ? 12 : 12 - stateLead);
    assert.equal(result.budget.familyAllocation.lens.targetCharacters, 4000);
    assert.equal(result.budget.familyAllocation.evidence.weight, 60);
    assert.equal(result.budget.familyAllocation.canonical, undefined);
  }
});

test('unused family shares are reused and Lore cannot enter even the shared pool', () => {
  const rows = Array.from({ length: 20 }, (_, n) => ({ id: 'c' + n, family: 'canonical', axis: 'world', text: '은빛 열쇠 ' + n }));
  rows.push({ id: 'lore', family: 'lore', axis: 'world', text: '은빛 열쇠 로어' });
  const result = engine.select({ rows, query: '열쇠', maxItems: 10, maxCharacters: 4000, plan: engine.allocationPlan('열쇠') });
  assert.equal(result.items.length, 10);
  assert.ok(result.items.every(row => row.family === 'canonical'));
  assert.equal(result.budget.familyAllocation.evidence.reservedItems, 6);
});

test('current questions deduplicate identical source assertions while history retains event wording', () => {
  const rows = [
    { id: 'state', family: 'state', axis: 'world', text: '열쇠 보유자: 준호', evidenceKeys: ['micro:a:claim'] },
    { id: 'event', family: 'micro', axis: 'world', text: '민아가 열쇠를 준호에게 건넸다.', evidenceKeys: ['micro:a:claim'] },
    { id: 'promise', family: 'micro', axis: 'narrative', text: '준호는 열쇠를 해 지기 전에 돌려주겠다고 했다.', evidenceKeys: ['micro:a:promise'] }
  ];
  const current = engine.select({ rows, query: '지금 열쇠 보유자', plan: engine.allocationPlan('지금 열쇠 보유자') });
  assert.ok(current.items.some(row => row.id === 'state'));
  assert.equal(current.items.some(row => row.id === 'event'), false);
  assert.ok(current.items.some(row => row.id === 'promise'), 'different source assertions are never merged by similar wording');
  assert.equal(current.budget.suppressedEvidenceDuplicates, 1);
  const history = engine.select({ rows, query: '열쇠의 과거 경위', plan: engine.allocationPlan('열쇠의 과거 경위') });
  assert.ok(history.items.some(row => row.id === 'event'));
});

test('projected fields retain their own evidence turn and pending authority', () => {
  const rows = engine.stateRows({ throughTurn: 7, responseAuthority: { current: false, pending: true },
    world: [{ id: 'key', name: '열쇠', state: { holderRef: '준호' }, fieldEvidence: { holderRef: {
      schema: 'libra.micro_state_field_evidence.v1', turn: 6, analysisRevisionId: 'a', claimDigest: 'claim'
    } } }] });
  assert.equal(rows[0].turn, 6);
  assert.equal(rows[0].stateStatus, 'last_known');
  assert.deepEqual(rows[0].evidenceKeys, ['micro:a:claim']);
});

test('the extracted fingerprint retains native SHA256 compatibility for Korean and supplementary characters', () => {
  const actual = require('../tools/libra_memory_fingerprint.cjs')();
  for (const value of ['', '민아와 은빛 열쇠', '🙂한글\nquoted "value"']) assert.equal(actual(value), fingerprint(value));
});

test('all four axes receive their floor before a highly relevant axis takes the shared budget', () => {
  const rows = engine.axes.flatMap(axis => Array.from({ length: 6 }, (_, n) => ({ id: axis + n, family: 'state', axis,
    text: axis === 'world' ? '은빛 열쇠 '.repeat(10) + n : axis + ' fact ' + n })));
  const result = engine.select({ rows, query: '은빛 열쇠', maxItems: 8, maxCharacters: 3000 });
  for (const axis of engine.axes) assert.equal(result.coverage[axis].selected, 2);
  assert.equal(result.graphBuilds, 0);
});

test('missing axes and budget-limited axes are disclosed without invented or truncated facts', () => {
  const rows = [{ id: 'a', family: 'state', axis: 'characters', text: 'a'.repeat(200) }];
  const result = engine.select({ rows, maxCharacters: 50 });
  assert.equal(result.items.length, 0);
  assert.equal(result.coverage.characters.reason, 'budget_limited');
  assert.equal(result.coverage.world.reason, 'no_verified_data');
});

test('State references resolve to names and narrative status survives field projection', () => {
  const rows = engine.stateRows({ throughTurn: 5, characters: [{ id: 'p1', name: '민아', state: { mood: '기대' } }],
    world: [{ id: 'w1', name: '열쇠', state: { holderRef: 'p1' } }], narrative: { threads: [{ id: 't1', title: '약속', status: 'open' }] } });
  assert.ok(rows.some(row => row.text.includes('holderRef: 민아')));
  assert.ok(rows.some(row => row.axis === 'narrative' && row.text.includes('status: open')));
  assert.ok(rows.some(row => row.promptText.includes('소지자: 민아')));
  assert.ok(rows.some(row => row.promptText.includes('약속 — 진행 상태: 미해결')));
  assert.ok(rows.every(row => row.turn === 5));
});

test('State prompt rows omit structural IDs and empty lists while retaining meaningful false/zero and nested rule conditions',()=>{
 const rows=engine.stateRows({throughTurn:9,world:[{id:'ce_key',name:'열쇠',state:{holderRef:'ce_unknown',ownerRef:'민아',count:0,locked:false,
  rule:{text:'조용히',exceptions:[{condition:'허가된 공연 중',effect:'예외'}]}}}],narrative:{threads:[{id:'ce_thread',lifecycleId:'ce_lifecycle',title:'반환 약속',status:'resolved',participants:[],resolvedTurn:8}]}});
 const prompt=rows.map(row=>row.promptText).join('\n');
 assert.doesNotMatch(prompt,/lifecycleId|ce_|participants|\[\]/);
 assert.match(prompt,/소유자: 민아/);assert.match(prompt,/수량: 0/);assert.match(prompt,/잠금 여부: 아니오/);
 assert.match(prompt,/허가된 공연 중/);assert.match(prompt,/반환 약속 — 진행 상태: 해결됨/);assert.match(prompt,/종결 기록 턴: T8/);
});

test('State evidence locators outrank recency when choosing bounded existing records', () => {
  const refs = [{ key: 'old', memoryId: 'old', turnRange: { end: 5 } }, { key: 'new', memoryId: 'new', turnRange: { end: 100 } }];
  assert.equal(engine.rankCatalog(refs, '', [{ evidence: { memoryId: 'old' } }], 1)[0].key, 'old');
});

test('previous engine settings migrate to State-first; unknown selections remain refused', () => {
  for (const value of ['', 'state_first', 'legacy', 'shadow', 'unified']) assert.equal(modes.normalizeMemoryEngineMode(value), 'state_first');
  assert.throws(() => modes.normalizeMemoryEngineMode('unknown'), /MODE_INVALID/);
});

test('BM25, char n-gram and exact match recognize Korean inflections and rank relevant records higher', () => {
  const query = '은빛 열쇠';
  const text1 = '민아는 은빛열쇠를 소중히 간직했다.';
  const text2 = '열쇠는 서랍 안에 보관되어 있다.';
  const text3 = '전혀 관련 없는 밤하늘의 별빛 이야기.';

  const s1 = engine.score(text1, query);
  const s2 = engine.score(text2, query);
  const s3 = engine.score(text3, query);

  assert.ok(s1 > s2, `s1 (${s1}) should outrank s2 (${s2})`);
  assert.equal(s3, 0, `unrelated text score should be 0`);

  const ngrams = engine.charNgrams('은빛 열쇠');
  assert.ok(ngrams.includes('은빛'));
  assert.ok(ngrams.includes('열쇠'));
});

test('sparse RRF fusion blends multi-signal ranks into monotonic blended scores with breakdowns', () => {
  const rows = [
    { id: 'r1', signals: { bm25: 0.9, charNgram: 0.8, exact: 1.0, anchor: 0 }, score: 10 },
    { id: 'r2', signals: { bm25: 0.1, charNgram: 0.2, exact: 0.0, anchor: 1.0 }, score: 5 },
    { id: 'r3', signals: { bm25: 0.0, charNgram: 0.0, exact: 0.0, anchor: 0 }, score: 1 }
  ];
  const fused = engine.sparseRrfFusion(rows, ['bm25', 'charNgram', 'exact', 'anchor'], 60, 0.25);
  assert.equal(fused.length, 3);
  assert.ok(fused[0].scoreBreakdown.rrfScore > fused[2].scoreBreakdown.rrfScore);
  assert.ok(fused[0].score > fused[1].score);
  assert.ok(fused[1].score > fused[2].score);
  assert.equal(fused[2].scoreBreakdown.rrfScore, 0);
});

test('extractCanonicalSearchMetadata and upgradeCanonicalManifestSearchMetadata backfill compact search terms without rewriting full history', async () => {
  const mockMemory = {
    title: '은빛 열쇠의 기원',
    summary: '민아가 숲속 고성에서 은빛 열쇠를 발견하고 준호에게 알렸다.',
    canonicalArtifact: {
      schema: 'libra.canonical_artifact.v1',
      title: '은빛 열쇠의 기원',
      summary: '민아가 숲속 고성에서 은빛 열쇠를 발견하고 준호에게 알렸다.',
      chronology: [
        { text: '민아가 고성의 지하실 문을 은빛 열쇠로 열었다.' }
      ]
    }
  };
  const meta = engine.extractCanonicalSearchMetadata(mockMemory);
  assert.equal(meta.title, '은빛 열쇠의 기원');
  assert.ok(meta.searchText.includes('은빛 열쇠'));
  assert.ok(meta.searchTerms.some(t => t.includes('열쇠') || t.includes('민아')));

  const manifest = {
    memories: {
      '5': { key: 'mem:5', memoryId: 'mem-5', summary: '옛 기록 요약문' },
      '10': { key: 'mem:10', memoryId: 'mem-10', summary: '이미 있는 검색어', searchTerms: ['기존'], searchText: '기존 검색 텍스트' }
    }
  };
  const report = await engine.upgradeCanonicalManifestSearchMetadata(manifest, async ref => {
    if (ref.key === 'mem:5') return mockMemory;
    return null;
  });
  assert.equal(report.upgraded, 1);
  assert.equal(report.total, 2);
  assert.ok(manifest.memories['5'].searchTerms.length > 0);
  assert.equal(manifest.memories['10'].searchText, '기존 검색 텍스트');
});

// ── Candidate discovery and ranking added with the Micro head search summaries ──
const tokenizer = require('../tools/libra_recall_tokenizer.cjs')();
const indexed = create({ fingerprint, tokenizer });

test('an old Micro turn is chosen because its stored search text matches, with a floor kept for the newest turns', () => {
  const turns = Array.from({ length: 200 }, (_, n) => n + 1);
  const index = new Map(turns.map(turn => [turn, turn === 7 ? '민아가 은빛 열쇠를 우물에 숨겼다.' : `평범한 대화 ${turn}`]));
  const ranked = indexed.rankMicroTurns({ turns, index, query: '은빛 열쇠는 어디에 숨겼어?', limit: 6 });
  assert.equal(ranked.reasons[7], 'index_match');
  assert.deepEqual(ranked.turns.filter(turn => ranked.reasons[turn] === 'recent').slice(0, 2), [200, 199]);
  assert.equal(ranked.turns.length, 6);
  assert.equal(ranked.matches, ranked.matchesRead, 'every matching turn fits the candidate limit here');
  const withoutIndex = indexed.rankMicroTurns({ turns, query: '은빛 열쇠', limit: 6 });
  assert.deepEqual(withoutIndex.turns, [200, 199, 198, 197, 196, 195], 'without search text the choice is recency only');
  const evidence = indexed.rankMicroTurns({ turns, index, query: '은빛 열쇠', evidenceTurns: [42, 999], limit: 6 });
  assert.equal(evidence.turns[0], 42); assert.equal(evidence.turns.includes(999), false, 'a turn outside the view is never read');
});

test('Korean particles do not hide a match and a repeated term counts more than a single mention', () => {
  const { tf } = indexed.termFrequency('열쇠를 찾았다. 열쇠는 은빛이었다.');
  assert.equal(tf.get('w:열쇠'), 2);
  const docs = ['열쇠 열쇠 열쇠가 문제였다', '열쇠가 문제였다 그리고 다른 이야기', '전혀 다른 이야기와 문제'].map(text => ({ text: indexed.termFrequency(text) }));
  const corpus = indexed.buildCorpus(docs), terms = indexed.queryTerms('열쇠');
  const [repeated, once, none] = docs.map(doc => indexed.bm25fScore(terms, doc, corpus));
  assert.ok(repeated > once && once > none && none === 0, JSON.stringify([repeated, once, none]));
});

test('catalog ranking weighs a rare title term above a term every record shares', () => {
  const refs = [
    { key: 'a', memoryId: 'a', title: '등대의 약속', summary: '민아와 준호가 다시 만났다.', turnRange: { end: 5 } },
    { key: 'b', memoryId: 'b', title: '시장 나들이', summary: '민아와 준호가 시장에 갔다.', turnRange: { end: 10 } },
    { key: 'c', memoryId: 'c', title: '비 오는 날', summary: '민아와 준호가 비를 피했다.', turnRange: { end: 15 } }
  ];
  assert.equal(indexed.rankCatalog(refs, '민아와 준호의 등대 약속', [], 1)[0].key, 'a');
});

test('a queried name reaches rows that use another written name of the same entity', () => {
  const head = { characters: [{ id: 'p1', name: '민아', aliases: ['미나', '은빛의 수호자'] }, { id: 'p2', name: '준호' }], world: [{ id: 'w1', name: '등대' }] };
  const entities = indexed.entityTable(head);
  const rows = [
    { id: 'alias', family: 'micro', axis: 'characters', text: '은빛의 수호자는 약속을 지켰다.' },
    { id: 'other', family: 'micro', axis: 'characters', text: '준호는 약속을 잊었다.' }
  ];
  const result = indexed.select({ rows, query: '민아의 약속', entities, minimumPerAxis: 0, maxItems: 1 });
  assert.equal(result.items[0].id, 'alias');
  assert.equal(result.items[0].scoreBreakdown.identity, 1);
});

test('a lens note is filed under what it is about instead of always under narrative', () => {
  const entities = indexed.entityTable({ characters: [{ id: 'p1', name: '민아' }, { id: 'p2', name: '준호' }], world: [{ id: 'w1', name: '등대' }] });
  assert.equal(indexed.classifyAxis('민아는 불안해 보였다.', { entities }), 'characters');
  assert.equal(indexed.classifyAxis('민아는 준호를 믿기 시작했다.', { entities }), 'relationships');
  assert.equal(indexed.classifyAxis('등대의 불빛은 자정에 꺼진다.', { entities }), 'world');
  assert.equal(indexed.classifyAxis('약속의 기한이 다가온다.', { entities }), 'narrative');
  assert.equal(indexed.classifyAxis('둘 사이가 가까워졌다.', { people: ['민아', '준호'], entities }), 'relationships');
});

test('history questions bring the source statement behind a matching State field', () => {
  const rows = [
    { id: 'state', family: 'state', axis: 'world', text: '세계 · 열쇠 · holderRef: 준호', evidenceKeys: ['micro:a:1'] },
    { id: 'source', family: 'micro', axis: 'narrative', text: '해 질 무렵 물건이 건네졌다.', evidenceKeys: ['micro:a:1'] },
    { id: 'noise', family: 'micro', axis: 'narrative', text: '해 질 무렵 바람이 불었다.', evidenceKeys: ['micro:b:1'] }
  ];
  const result = indexed.select({ rows, query: '열쇠가 준호에게 넘어간 경위', plan: indexed.allocationPlan('열쇠가 준호에게 넘어간 경위'), minimumPerAxis: 0 });
  const source = result.items.find(row => row.id === 'source'), noise = result.items.find(row => row.id === 'noise');
  assert.equal(source.scoreBreakdown.linked, 1);
  assert.ok(!noise || source.score > noise.score);
});

test('candidate reads scale with the delivery budget and keep the configured caps at the standard budget', () => {
  const at = (query, maxItems, caps = {}) => { const plan = engine.allocationPlan(query, 40, { maxItems, ...caps }); return [plan.canonicalCandidates, plan.microCandidates]; };
  assert.deepEqual(at('열쇠의 과거 경위', 24), [16, 6]);
  assert.deepEqual(at('열쇠 이야기', 24), [8, 8]);
  assert.deepEqual(at('정확한 발언', 24), [4, 12]);
  assert.deepEqual(at('열쇠 이야기', 16), [8, 8], 'a compact budget never reads fewer than the standard share');
  assert.deepEqual(at('열쇠 이야기', 40), [14, 14]);
  assert.deepEqual(at('열쇠 이야기', 64), [22, 22]);
  assert.deepEqual(at('열쇠의 과거 경위', 64, { canonicalCap: 64 }), [64, 16], 'hard ceilings stay at 64 canonical and 32 Micro');
  assert.deepEqual(at('정확한 발언', 64, { microCap: 32 }), [11, 32]);
});
